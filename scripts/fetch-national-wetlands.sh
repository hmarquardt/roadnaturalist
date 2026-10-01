#!/bin/bash
# Fetch and verify every pinned NWI state archive into the build volume's source cache.
#
# The national builder pins 49 packages (60.5 GB compressed) and will fetch them itself as it normalizes each
# state. Fetching them first is a scheduling choice, not a correctness one: the download is the slowest part of a
# state's work, so having the cache warm means the normalization shards start computing immediately. Every
# archive is verified against the committed lock's byte length and SHA-256, an existing verified archive is
# skipped, and nothing is written outside the build volume's `work/nwi/sources` directory.
#
#   ROADNATURALIST_BUILD_VOLUME=/Volumes/Lexar/roadnaturalist bash scripts/fetch-national-wetlands.sh
#   WORKERS=6 bash scripts/fetch-national-wetlands.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
VOLUME="${ROADNATURALIST_BUILD_VOLUME:-/Volumes/Lexar/roadnaturalist}"
CACHE="$VOLUME/work/nwi/sources"
WORKERS="${WORKERS:-6}"
LOCK="data/national/nwi-state-lock.json"

if [ ! -d "$VOLUME" ]; then
  echo "build volume $VOLUME is not present; refusing to write sources to the internal disk" >&2
  exit 1
fi
mkdir -p "$CACHE"
echo "[$(date +%H:%M:%S)] fetching $(node -e "console.log(Object.keys(require('./$LOCK').packages).length)") pinned archives into $CACHE with $WORKERS workers"

fetch_by_state() {
  local state="$1"
  local fields
  fields=$(node -e "
    const entry = require('./$LOCK').packages['$state'];
    console.log([entry.url, entry.bytes, entry.sha256, entry.filename].join(' '));
  ")
  read -r url bytes sha name <<< "$fields"
  local path="$CACHE/$name"
  if [ -f "$path" ] && [ "$(stat -f %z "$path")" = "$bytes" ] && [ "$(shasum -a 256 "$path" | awk '{print $1}')" = "$sha" ]; then
    echo "$state: cached"
    return 0
  fi
  if ! curl -sSL --retry 3 --retry-delay 5 -o "$path.part" "$url"; then
    echo "$state: download failed" >&2
    rm -f "$path.part"
    return 1
  fi
  if [ "$(stat -f %z "$path.part")" != "$bytes" ] || [ "$(shasum -a 256 "$path.part" | awk '{print $1}')" != "$sha" ]; then
    rm -f "$path.part"
    echo "$state: digest/bytes differ from the committed lock" >&2
    return 1
  fi
  mv "$path.part" "$path"
  echo "$state: fetched $bytes bytes"
}
export -f fetch_by_state
export CACHE LOCK

node -e "console.log(Object.keys(require('./$LOCK').packages).join('\n'))" \
  | xargs -P "$WORKERS" -n 1 bash -c 'fetch_by_state "$1"' _

count=$(ls "$CACHE" 2>/dev/null | grep -c '\.zip$' || true)
echo "[$(date +%H:%M:%S)] archives cached: $count / 49"
du -sh "$CACHE"
