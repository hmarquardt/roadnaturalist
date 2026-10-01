#!/bin/bash
# Drive the national hydrography plane from wherever it is to a complete, verified plane, unattended.
#
# Every stage is checkpointed and idempotent, so re-running this script is always safe and always resumes:
#
#   1. normalize every pinned unit, one process per unit slice
#   2. resolve cross-unit identity once (the one stage that must be sequential)
#   3. partition in process shards (units are independent here)
#   4. finalize-only: compact cells with per-cell reuse, then write the manifest
#   5. verify the complete plane, check the runtime consumer predicate, then measure
#
# The stages fail closed, and the chain says which word applies. A stage that exits non-zero stops the chain,
# because a verification or a measurement taken after a failed build is not evidence about the plane: it is
# evidence about a partial plane, and the only thing it can be trusted to establish is that something went wrong.
# Anything the chain does after a failure is labelled a diagnostic, and the chain ends with PIPELINE FAILED.
#
# Stage 4 uses --finalize-only deliberately. `--finalize` alone is an add-on to the unit-walking path, so
# stage 4 used to re-validate all 2,166 source archives and normalized outputs before it reached the compaction:
# the stage's wall clock doubled, and a national finalize could fail on a unit-level problem that the finalize
# itself does not depend on. That validation is the verifier's job (stage 5), where it is authoritative.
#
# Measured on this machine: eight threads in one process give ~0.45 units/s (the per-unit row loop holds the GIL);
# eight processes give ~1.1 units/s when geodatabases are read from the ExFAT build volume, and ~1.3-1.6 units/s
# when extraction goes to local scratch (I/O wait there showed as load 36 with ~3 cores of CPU). Sixteen slices
# oversubscribed the machine (load 63) without helping. One DuckDB thread per process is the optimum.
#
#   ROADNATURALIST_BUILD_VOLUME=/Volumes/Lexar/roadnaturalist bash scripts/run-national-hydro.sh
#   SLICES=4 SCRATCH=/tmp/rnhydro bash scripts/run-national-hydro.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
VOLUME="${ROADNATURALIST_BUILD_VOLUME:-/Volumes/Lexar/roadnaturalist}"
WORK="$VOLUME/work/nhd"
SCRATCH="${SCRATCH:-${TMPDIR:-/tmp}/rnhydro-scratch}"
SLICES="${SLICES:-8}"
UV="uv run --python 3.12 --with duckdb --with pyproj --with shapely --with pyarrow"
# Stage logs live on the build volume, not in /tmp: an unattended overnight run lost its logs to a temporary
# directory cleanup once, and with them the only record of why a stage failed.
LOGS="$WORK/logs"
log() { echo "[$(date +%H:%M:%S)] $*"; }
FAILED=""

if [ ! -d "$VOLUME" ]; then
  echo "build volume $VOLUME is not present; refusing to fall back to the internal disk" >&2
  exit 1
fi
mkdir -p "$LOGS"
log "volume=$VOLUME work=$WORK scratch=$SCRATCH slices=$SLICES logs=$LOGS"

UNITS_ALL=$(node -e "console.log(Object.keys(require('./data/national/nhd-hr-hu8-lock.json').units).sort().join(','))")
IFS=',' read -ra ALL_UNITS <<< "$UNITS_ALL"
per=$(( (${#ALL_UNITS[@]} + SLICES - 1) / SLICES ))

# Run a named stage, log its exit and the last line of its log, and refuse to continue if it failed.
stage() {
  local name="$1"; shift
  log "stage $name"
  "$@" > "$LOGS/$name.log" 2>&1
  local status=$?
  log "$name exit=$status $(tail -1 "$LOGS/$name.log" 2>/dev/null | cut -c1-240)"
  if [ "$status" -ne 0 ]; then FAILED="$name"; fi
  return "$status"
}

shards() {
  local name="$1" mode="$2"
  local pids=()
  for ((i=0; i<SLICES; i++)); do
    local start=$((i*per))
    [ "$start" -ge "${#ALL_UNITS[@]}" ] && break
    local slice
    slice=$(IFS=','; echo "${ALL_UNITS[*]:start:per}")
    # Per-slice scratch: two processes that happen to work on the same unit must never share an extraction
    # directory, because whoever finishes first deletes it (that race produced a real ST_Read failure).
    if [ "$mode" = normalize ]; then
      mkdir -p "$SCRATCH/slice-$i"
      $UV python3 scripts/build-national-hydro.py --units "$slice" --workers 1 --cleanup-source \
        --scratch "$SCRATCH/slice-$i" --work "$WORK" > "$LOGS/$name-$i.log" 2>&1 &
    else
      $UV python3 scripts/build-national-hydro.py --units "$slice" --partition-only --workers 1 \
        --work "$WORK" > "$LOGS/$name-$i.log" 2>&1 &
    fi
    pids+=($!)
  done
  local status=0
  for pid in "${pids[@]}"; do wait "$pid" || status=1; done
  return "$status"
}

stage "1-normalization" shards 1-normalization normalize
if [ -z "$FAILED" ]; then log "normalized=$(ls "$WORK"/normalized/*.parquet 2>/dev/null | wc -l | tr -d ' ')"; fi

if [ -z "$FAILED" ]; then stage "2-identity" $UV python3 scripts/build-national-hydro.py --all --identity-only --work "$WORK"; fi
if [ -z "$FAILED" ]; then stage "3-partition" shards 3-partition partition; fi
if [ -z "$FAILED" ]; then
  log "fragments=$(ls "$WORK"/fragments/*.parquet 2>/dev/null | wc -l | tr -d ' ')"
  stage "4-finalize" $UV python3 scripts/build-national-hydro.py --all --finalize-only --workers 1 --work "$WORK"
fi

if [ -z "$FAILED" ]; then
  stage "5-verify" $UV python3 scripts/verify-national-hydro.py --work "$WORK" --require-all --regional-equivalence
fi
if [ -z "$FAILED" ]; then
  stage "5b-consumers" $UV python3 scripts/check-hydro-consumers.py --work "$WORK"
fi
if [ -z "$FAILED" ]; then
  # Measurement is only meaningful against a plane that finalized and verified; otherwise it is a diagnostic.
  stage "6-measure" $UV python3 scripts/measure-national-hydro.py --work "$WORK"
fi

if [ -n "$FAILED" ]; then
  log "DIAGNOSTIC ONLY (not evidence about the plane): reconciling identity against the unit outputs"
  $UV python3 scripts/reconcile-national-hydro-identity.py --work "$WORK" 2>&1 | head -40 | sed 's/^/[diagnostic] /'
  log "PIPELINE FAILED at $FAILED - the plane is not ready and no measurement was taken"
  exit 1
fi
log "PIPELINE COMPLETE - the plane finalized, verified, served the runtime predicate and was measured"
