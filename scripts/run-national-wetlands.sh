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
#   3. partition: N process shards over the same state lists (per state, checkpointed). Each shard *requires* the
#      global identity: it never rebuilds one, because six shards rebuilding a shared database would race.
#   4. finalize: compaction with per-cell reuse, then the manifest over all 49 states
#   5. verify: the national verifier with --require-all, then the source-grounded runtime consumer check
#   6. measure: the complete plane, which is the only number worth quoting
#
# Every stage is checkpointed and idempotent, so re-running this script always resumes. Extraction and the
# per-state ZIP are cleaned per state after its validated output exists; checkpoints, normalized outputs,
# fragments, cells and the manifest are kept.
#
# The stages fail closed, and the chain says which word applies. A stage that exits non-zero stops the chain,
# because a verification or a measurement taken after a failed build is not evidence about the plane: it is
# evidence about a partial plane. Anything the chain does after a failure is labelled a diagnostic, and the chain
# ends with PIPELINE FAILED rather than anything mistakable for success. Stage logs live on the build volume, not
# in /tmp, because a temporary directory cleanup once cost an unattended run its only record of why it failed.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
VOLUME="${ROADNATURALIST_BUILD_VOLUME:-/Volumes/Lexar/roadnaturalist}"
WORK="$VOLUME/work/nwi"
LOGS="$WORK/logs"
SLICES="${SLICES:-6}"
LOCK="data/national/nwi-state-lock.json"
UV="uv run --python 3.12 --with duckdb --with pyproj --with shapely --with pyarrow"
log() { echo "[$(date +%H:%M:%S)] $*"; }
space() { df -h "$VOLUME" | tail -1 | awk '{print "  volume: " $3 " used, " $4 " free (" $5 ")"}'; }
FAILED=""
SHARD_DIR=""
cleanup() { [ -n "$SHARD_DIR" ] && rm -rf "$SHARD_DIR"; }
trap cleanup EXIT

if [ ! -d "$VOLUME" ]; then
  echo "build volume $VOLUME is not present; refusing to fall back to the internal disk" >&2
  exit 1
fi
if ! touch "$VOLUME/.rn-write-probe" 2>/dev/null; then
  echo "build volume $VOLUME is not writable; refusing to fall back to the internal disk" >&2
  exit 1
fi
rm -f "$VOLUME/.rn-write-probe"
mkdir -p "$LOGS"
log "volume=$VOLUME work=$WORK slices=$SLICES logs=$LOGS"
space

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
log "states=$(echo "$ALL_STATES" | tr ',' '\n' | wc -l | tr -d ' ') pinned"

# Run a named stage, log its exit and the last line of its log, and refuse to continue if it failed.
stage() {
  local name="$1"; shift
  log "stage $name"
  "$@" > "$LOGS/$name.log" 2>&1
  local status=$?
  log "$name exit=$status $(tail -1 "$LOGS/$name.log" 2>/dev/null | cut -c1-240)"
  if [ "$status" -ne 0 ]; then FAILED="$name"; fi
  space
  return "$status"
}

# The same stage over every shard, as concurrent processes, with a per-shard log.
shards() {
  local name="$1" mode="$2"
  local pids=()
  for shard in "$SHARD_DIR"/shard-*; do
    local index="${shard##*-}" states
    states=$(cat "$shard")
    if [ "$mode" = normalize ]; then
      $UV python3 scripts/build-national-wetlands.py --states "$states" --workers 1 --cleanup-source \
        --work "$WORK" > "$LOGS/$name-$index.log" 2>&1 &
    else
      $UV python3 scripts/partition-national-wetlands.py --states "$states" --partition-only \
        --work "$WORK" > "$LOGS/$name-$index.log" 2>&1 &
    fi
    pids+=($!)
  done
  local status=0
  for pid in "${pids[@]}"; do wait "$pid" || status=1; done
  return "$status"
}

stage "1-normalization" shards 1-normalization normalize
complete_states() { node -e "
const fs=require('fs');const dir='$WORK/jobs';
let done=0;for(const s of fs.readdirSync(dir)){if(s.startsWith('.'))continue;
  const p=dir+'/'+s+'/state.json';if(fs.existsSync(p)&&JSON.parse(fs.readFileSync(p)).state==='complete')done++;}
console.log(done);"; }
if [ -z "$FAILED" ]; then
  log "normalized states=$([ -d "$WORK/normalized" ] && ls "$WORK/normalized" | wc -l | tr -d ' ') complete checkpoints=$(complete_states)"
fi

[ -z "$FAILED" ] && stage "2-identity" $UV python3 scripts/partition-national-wetlands.py \
  --states "$ALL_STATES" --identity-only --work "$WORK"
[ -z "$FAILED" ] && stage "3-partition" shards 3-partition partition
[ -z "$FAILED" ] && stage "4-finalize" $UV python3 scripts/partition-national-wetlands.py \
  --states "$ALL_STATES" --finalize --work "$WORK"
[ -z "$FAILED" ] && stage "5-verify" $UV python3 scripts/verify-national-wetlands.py --work "$WORK" --require-all
[ -z "$FAILED" ] && stage "5b-consumers" $UV python3 scripts/check-wetland-consumers.py --work "$WORK"
[ -z "$FAILED" ] && stage "6-measure" $UV python3 scripts/measure-national-wetlands.py --work "$WORK"

if [ -n "$FAILED" ]; then
  log "DIAGNOSTIC ONLY (not evidence about the plane): $(complete_states)/49 state checkpoints complete, "
  log "  $(ls "$WORK/normalized" 2>/dev/null | wc -l | tr -d ' ') states with normalized output, "
  log "  failing stage tail:"
  tail -6 "$LOGS/$FAILED.log" 2>/dev/null | sed 's/^/[diagnostic] /'
  log "PIPELINE FAILED at $FAILED - the plane is not ready and no measurement was taken"
  exit 1
fi
log "PIPELINE COMPLETE - normalized, identity, partition, finalize, verify, consumers and measurement all succeeded"
