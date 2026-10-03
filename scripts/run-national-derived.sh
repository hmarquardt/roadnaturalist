#!/usr/bin/env bash
# Fail-closed national derived build chain.
#
#   ROADNATURALIST_BUILD_VOLUME=/Volumes/Lexar/roadnaturalist bash scripts/run-national-derived.sh
#
# Every stage is checkpointed and idempotent, so re-running the whole script is always safe: completed
# buckets, shards and cells are validated (bytes + SHA-256 + pipeline digest) and reused. A stage that
# exits non-zero stops the chain; verification and measurement run only after a finalize that succeeded;
# and the last line is never mistakable for success (the lesson of the hydro chain).
#
# All progress logs live on the build volume under $OUT/logs/, never in /tmp.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
BUILD="${ROADNATURALIST_BUILD_VOLUME:-/Volumes/Lexar/roadnaturalist}"
OUT="${NATIONAL_DERIVED_OUT:-$BUILD/work/derived-national}"
FINAL="${NATIONAL_DERIVED_FINAL:-$BUILD/cells/derived/corridor-metrics}"
# Every corridor worker can publish the shared index when all buckets exist. Serialize this checkpointed
# stage until its index writer uses a unique temporary path; metric throughput is the long pole.
CORRIDOR_WORKERS="${NATIONAL_DERIVED_CORRIDOR_WORKERS:-1}"
METRIC_WORKERS="${NATIONAL_DERIVED_METRIC_WORKERS:-1}"
export NATIONAL_DERIVED_MEMORY="${NATIONAL_DERIVED_MEMORY:-8GB}"
export NATIONAL_DERIVED_THREADS="${NATIONAL_DERIVED_THREADS:-2}"
BUCKETS=64
mkdir -p "$OUT/logs"

UV_RUN=(uv run --python 3.12 --with duckdb --with shapely --with pyarrow --with pyproj --with pyshp
  python3 scripts/build-national-derived.py --out "$OUT" --final "$FINAL")

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$OUT/logs/chain.log"; }
stage_failed() {
  log "PIPELINE FAILED at $1. The national derived plane is NOT ready; no verification or measurement was "
  log "taken. Completed checkpoints remain valid and a re-run resumes from them."
  exit 1
}

log "national derived chain: OUT=$OUT FINAL=$FINAL corridor_workers=$CORRIDOR_WORKERS metric_workers=$METRIC_WORKERS duckdb_memory=$NATIONAL_DERIVED_MEMORY duckdb_threads=$NATIONAL_DERIVED_THREADS"

log "stage 0/6 derived-build readiness (four source planes)"
if ! node scripts/check-derived-readiness.mjs > "$OUT/logs/readiness.json" 2> "$OUT/logs/readiness.err"; then
  stage_failed "derived-build readiness"
fi
log "  readiness: $(tr -d '\n' < "$OUT/logs/readiness.json" | head -c 200)"

log "stage 1/6 provenance lookup"
"${UV_RUN[@]}" --stage lookup > "$OUT/logs/lookup.log" 2>&1 || stage_failed "lookup"

log "stage 2/6 corridor composition ($CORRIDOR_WORKERS workers)"
pids=()
for worker in $(seq 0 $((CORRIDOR_WORKERS - 1))); do
  start=$((worker * BUCKETS / CORRIDOR_WORKERS))
  end=$(( (worker + 1) * BUCKETS / CORRIDOR_WORKERS ))
  "${UV_RUN[@]}" --stage corridors --buckets "$start:$end" > "$OUT/logs/corridors-$worker.log" 2>&1 &
  pids+=("$!")
done
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
[ "$failed" -eq 0 ] || stage_failed "corridor composition"
"${UV_RUN[@]}" --stage index > "$OUT/logs/corridor-index.log" 2>&1 || stage_failed "corridor index"

log "stage 3/6 national corridor metrics and cell replication ($METRIC_WORKERS workers)"
TOTAL_SHARDS="$(python3 - <<'PY'
import json, math
bounds = json.load(open('data/national/grid-conus-2025.json'))['bounds']
print((math.floor(bounds[2]) - math.floor(bounds[0]) + 1) * (math.floor(bounds[3]) - math.floor(bounds[1]) + 1))
PY
)"
log "  $TOTAL_SHARDS deterministic shards"
pids=()
for worker in $(seq 0 $((METRIC_WORKERS - 1))); do
  start=$((worker * TOTAL_SHARDS / METRIC_WORKERS))
  end=$(( (worker + 1) * TOTAL_SHARDS / METRIC_WORKERS ))
  "${UV_RUN[@]}" --stage metrics --shard-range "$start:$end" > "$OUT/logs/metrics-$worker.log" 2>&1 &
  pids+=("$!")
done
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
[ "$failed" -eq 0 ] || stage_failed "corridor metrics"

log "stage 4/6 finalize (per-cell GeoParquet + manifest)"
"${UV_RUN[@]}" --stage finalize > "$OUT/logs/finalize.log" 2>&1 || stage_failed "finalize"

log "stage 5/6 derived verification"
uv run --python 3.12 --with duckdb --with shapely --with pyarrow python3 scripts/verify-national-derived.py \
  --out "$OUT" --final "$FINAL" > "$OUT/logs/verify.log" 2>&1 || stage_failed "derived verification"

log "stage 6/6 measurement"
uv run --python 3.12 --with pyarrow python3 scripts/measure-national-derived.py \
  --out "$OUT" --final "$FINAL" > "$OUT/logs/measure.log" 2>&1 || stage_failed "measurement"
cat "$OUT/logs/measure.log" | tee -a "$OUT/logs/chain.log"

log "PIPELINE COMPLETE: the national derived corridor-metrics plane finalized, verified and was measured."
