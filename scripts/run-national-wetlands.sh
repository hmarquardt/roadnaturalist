#!/bin/bash
# Drive the national NWI wetlands plane from wherever it is to a complete, verified plane, unattended.
#
# The 49 pinned state packages total 60.5 GB compressed and about 128 GB unpacked, and one state's work is
# independent of every other state's until identity is resolved. So the stages are:
#
#   1. normalize: N process shards over size-balanced state lists (largest-first greedy from the committed lock,
#      so the critical path is ~10 GB per shard instead of one 4 GB state followed by everything else)
#   2. identity: one process over all 49 states (identity is global: it resolves duplicate copies across every
#      package at once, and it must exist before any partition shard starts)
#   3. partition: N process shards over the same state lists (per state, checkpointed)
#   4. finalize: compaction with per-cell reuse, then the manifest over all 49 states
#   5. verify: the national verifier with --require-all
#
# Every stage is checkpointed and idempotent, so re-running this script always resumes. Extraction and the
# per-state ZIP are cleaned per state after its validated output exists; checkpoints, normalized outputs,
# fragments, cells and the manifest are kept.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
VOLUME="${ROADNATURALIST_BUILD_VOLUME:-/Volumes/Lexar/roadnaturalist}"
WORK="$VOLUME/work/nwi"
SLICES="${SLICES:-6}"
LOCK="data/national/nwi-state-lock.json"
UV="uv run --python 3.12 --with duckdb --with pyproj --with shapely --with pyarrow"
log() { echo "[$(date +%H:%M:%S)] $*"; }

if [ ! -d "$VOLUME" ]; then
  echo "build volume $VOLUME is not present; refusing to fall back to the internal disk" >&2
  exit 1
fi

# Size-balanced shards, computed from the lock rather than assumed.
SHARD_DIR=$(mktemp -d)
node -e "
const lock = require('./$LOCK');
const slices = Number('$SLICES');
const entries = Object.entries(lock.packages).map(([state, entry]) => ({ state, bytes: entry.bytes }))
  .sort((a, b) => b.bytes - a.bytes);
const shards = Array.from({ length: slices }, () => ({ bytes: 0, states: [] }));
for (const entry of entries) {
  shards.sort((a, b) => a.bytes - b.bytes);
  shards[0].bytes += entry.bytes;
  shards[0].states.push(entry.state);
}
shards.forEach((shard, index) => {
  require('fs').writeFileSync('$SHARD_DIR/shard-' + index, shard.states.join(','));
  console.error('shard ' + index + ': ' + shard.states.length + ' states, ' + (shard.bytes / 1e9).toFixed(2) + ' GB');
});
console.error('critical path: ' + (Math.max(...shards.map(shard => shard.bytes)) / 1e9).toFixed(2) + ' GB');
"
ALL_STATES=$(node -e "console.log(Object.keys(require('./$LOCK').packages).join(','))")
log "volume=$VOLUME work=$WORK slices=$SLICES states=$(echo "$ALL_STATES" | tr ',' '\n' | wc -l | tr -d ' ')"

run_shards() {
  local label="$1"; shift
  local pids=()
  for shard in "$SHARD_DIR"/shard-*; do
    local index="${shard##*-}"
    local states
    states=$(cat "$shard")
    "$@" "$states" "$index" > "/tmp/national-wetlands-$label-$index.log" 2>&1 &
    pids+=($!)
  done
  local status=0
  for pid in "${pids[@]}"; do wait "$pid" || status=1; done
  log "$label exit=$status"
  return $status
}

normalize_shard() {
  $UV python3 scripts/build-national-wetlands.py --states "$1" --workers 1 --cleanup-source --work "$WORK"
}
partition_shard() {
  $UV python3 scripts/partition-national-wetlands.py --states "$1" --partition-only --work "$WORK"
}

log "stage 1: normalize in shards"
run_shards normalize normalize_shard
log "normalized states: $(ls "$WORK"/normalized 2>/dev/null | wc -l | tr -d ' ')"

log "stage 2: identity over all 49 states (single process)"
$UV python3 scripts/partition-national-wetlands.py --states "$ALL_STATES" --identity-only --work "$WORK" \
  > /tmp/national-wetlands-identity.log 2>&1
log "identity exit=$? $(tail -1 /tmp/national-wetlands-identity.log | cut -c1-240)"

log "stage 3: partition in shards"
run_shards partition partition_shard

log "stage 4: finalize (compaction with per-cell reuse, then the manifest)"
$UV python3 scripts/partition-national-wetlands.py --states "$ALL_STATES" --finalize --work "$WORK" \
  > /tmp/national-wetlands-finalize.log 2>&1
log "finalize exit=$? $(tail -1 /tmp/national-wetlands-finalize.log | cut -c1-240)"

log "stage 5: verify the complete plane (--require-all)"
$UV python3 scripts/verify-national-wetlands.py --work "$WORK" --require-all \
  > /tmp/national-wetlands-verify.log 2>&1
log "verify exit=$? $(tail -1 /tmp/national-wetlands-verify.log | cut -c1-320)"

rm -rf "$SHARD_DIR"
log "PIPELINE COMPLETE"
