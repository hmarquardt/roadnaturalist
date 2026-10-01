#!/bin/bash
# Drive the national hydrography plane from wherever it is to a complete, verified plane, unattended.
#
# Every stage is checkpointed and idempotent, so re-running this script is always safe and always resumes:
#
#   1. normalize every pinned unit, one process per unit slice
#   2. resolve cross-unit identity once (the one stage that must be sequential)
#   3. partition in process shards (units are independent here)
#   4. finalize: compact cells with per-cell reuse, then write the manifest
#   5. verify the complete plane, check the runtime consumer predicate, then measure
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
log() { echo "[$(date +%H:%M:%S)] $*"; }

if [ ! -d "$VOLUME" ]; then
  echo "build volume $VOLUME is not present; refusing to fall back to the internal disk" >&2
  exit 1
fi
log "volume=$VOLUME work=$WORK scratch=$SCRATCH slices=$SLICES"

UNITS_ALL=$(node -e "console.log(Object.keys(require('./data/national/nhd-hr-hu8-lock.json').units).sort().join(','))")
IFS=',' read -ra ALL_UNITS <<< "$UNITS_ALL"
per=$(( (${#ALL_UNITS[@]} + SLICES - 1) / SLICES ))

log "stage 1: normalization in $SLICES process shards"
pids=()
for ((i=0; i<SLICES; i++)); do
  start=$((i*per))
  [ "$start" -ge "${#ALL_UNITS[@]}" ] && break
  slice=$(IFS=','; echo "${ALL_UNITS[*]:start:per}")
  # Per-slice scratch: two processes that happen to work on the same unit must never share an extraction
  # directory, because whoever finishes first deletes it (that race produced a real ST_Read failure).
  mkdir -p "$SCRATCH/slice-$i"
  $UV python3 scripts/build-national-hydro.py --units "$slice" --workers 1 --cleanup-source \
    --scratch "$SCRATCH/slice-$i" --work "$WORK" > "/tmp/national-hydro-normalize-$i.log" 2>&1 &
  pids+=($!)
done
status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
log "normalization exit=$status normalized=$(ls "$WORK"/normalized/*.parquet 2>/dev/null | wc -l | tr -d ' ')"

log "stage 2: identity"
$UV python3 scripts/build-national-hydro.py --all --identity-only --work "$WORK" > /tmp/national-hydro-identity.log 2>&1
log "identity exit=$? $(tail -1 /tmp/national-hydro-identity.log | cut -c1-240)"

log "stage 3: partition in $SLICES shards"
pids=()
for ((i=0; i<SLICES; i++)); do
  start=$((i*per))
  [ "$start" -ge "${#ALL_UNITS[@]}" ] && break
  slice=$(IFS=','; echo "${ALL_UNITS[*]:start:per}")
  $UV python3 scripts/build-national-hydro.py --units "$slice" --partition-only --workers 1 \
    --work "$WORK" > "/tmp/national-hydro-partition-$i.log" 2>&1 &
  pids+=($!)
done
status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
log "partition exit=$status fragments=$(ls "$WORK"/fragments/*.parquet 2>/dev/null | wc -l | tr -d ' ')"

log "stage 4: finalize"
$UV python3 scripts/build-national-hydro.py --all --finalize --workers 1 --work "$WORK" \
  > /tmp/national-hydro-finalize.log 2>&1
log "finalize exit=$?"

log "stage 5: verify + runtime consumers + measure"
$UV python3 scripts/verify-national-hydro.py --work "$WORK" --require-all --regional-equivalence \
  > /tmp/national-hydro-verify.log 2>&1
log "verify exit=$? $(tail -1 /tmp/national-hydro-verify.log | cut -c1-320)"
$UV python3 scripts/check-hydro-consumers.py --work "$WORK" > /tmp/national-hydro-consumers.log 2>&1
log "consumers exit=$?"
$UV python3 scripts/measure-national-hydro.py --work "$WORK" > /tmp/national-hydro-measure.log 2>&1
log "measure exit=$?"
log "PIPELINE COMPLETE"
