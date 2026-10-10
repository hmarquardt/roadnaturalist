#!/usr/bin/env bash
# Publish, verify and cut production discovery over to the national derived plane - fail closed at every gate.
#
#   CLOUDFLARE_ACCOUNT_ID=<id> bash scripts/run-national-derived-release.sh
#   bash scripts/run-national-derived-release.sh --skip-publication --skip-audit
#
# Stages, in order, each one stopping the chain on failure:
#
#   1. resume the R2 publication until it reports no failures (idempotent, checkpointed; --skip-publication
#      skips it when the plane is already published)
#   2. the local pre-publication audit and the full remote audit (--skip-audit skips both, for a release whose
#      publication has already been audited and must not be re-fetched)
#   3. the six-region Node + DuckDB verification against the published plane
#   4. the Pages deploy (the catalog/pointer change, which is all the cutover is)
#   5. a settle gate: the deployed origin must serve *this* build before any browser verdict is issued
#   6. the real-browser production check - the gate the previous chain got wrong. A non-zero exit prints
#      "CHAIN FAILED at production browser verification", records the browser gate as failed, and exits 1. It
#      never prints CHAIN COMPLETE and never records a passed browser verification.
#   7. the release status record, and the commit and push, on a fully green chain
#
# The settle gate exists because the two halves of a release are deployed together but not necessarily observed
# together: the last cutover's browser check ran against the previous release's `src/gis/service.js` while
# `data/national/derived-catalog.json` was already the national pointer, and an interactive national search was
# therefore validated as a regional catalog.
set -uo pipefail
cd "$(dirname "$0")/.."

BUILD="${ROADNATURALIST_BUILD_VOLUME:-/Volumes/Lexar/roadnaturalist}"
WORK="${NATIONAL_DERIVED_RELEASE_WORK:-$BUILD/work/derived-national-publication}"
mkdir -p "$WORK"
LOG="$WORK/chain.log"
ORIGIN="${NATIONAL_DERIVED_ORIGIN:-https://roadnaturalist.com}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-b1aa310aa0a1638d72b8b086a21e557c}"

SKIP_PUBLICATION=0
SKIP_AUDIT=0
for argument in "$@"; do
  case "$argument" in
    --skip-publication) SKIP_PUBLICATION=1 ;;
    --skip-audit) SKIP_AUDIT=1 ;;
    *) echo "unknown argument: $argument" >&2; exit 2 ;;
  esac
done

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
fail() { say "CHAIN FAILED at $*"; exit 1; }

# The deployed build must be the build under review. Pages serves the previous deployment for a short window
# after a release, and a browser verdict issued inside that window describes the previous release.
settle() {
  local local_path="$1" remote_path="$2" want got tries=0
  want=$(shasum -a 256 "$local_path" | awk '{print $1}')
  while [ "$tries" -lt 36 ]; do
    got=$(curl -fsS "$ORIGIN$remote_path" 2>/dev/null | shasum -a 256 | awk '{print $1}')
    if [ "$got" = "$want" ]; then say "  settled $remote_path"; return 0; fi
    tries=$((tries + 1)); sleep 5
  done
  say "  $remote_path did not settle: want $want, served ${got:-nothing}"
  return 1
}

[ -z "$(git status --porcelain)" ] || fail "the working tree is not clean"
say "national derived release: origin=$ORIGIN work=$WORK"

if [ "$SKIP_PUBLICATION" -eq 0 ]; then
  say "stage 1 publication (resumable, checkpointed)"
  node scripts/publish-national-derived.mjs --concurrency 6 --rate 4 > "$WORK/release-publication.log" 2>&1 \
    || fail "R2 publication"
  say "  publication reports no failures"
fi

if [ "$SKIP_AUDIT" -eq 0 ]; then
  say "stage 2 publication audit"
  node scripts/check-national-derived-publication.mjs > "$WORK/precheck-final.log" 2>&1 || fail "local pre-publication audit"
  node scripts/audit-national-derived-remote.mjs --concurrency 12 --report "$WORK/audit.json" > "$WORK/audit.log" 2>&1 \
    || fail "remote audit"
  cp "$WORK/audit.json" data/national/verification/derived-publication-remote-audit.json
  say "  publication verified by re-fetching every published object"
fi

say "stage 3 six-region production verification (Node + DuckDB, published plane)"
node scripts/verify-national-derived-production.mjs > "$WORK/production-verify.log" 2>&1 \
  || fail "six-region production verification"
cp "$WORK/production-verify.log" data/national/verification/derived-publication-production.txt
say "  $(tail -1 "$WORK/production-verify.log")"

say "stage 4 Pages deploy (the catalog/pointer change)"
npm run deploy:pages > "$WORK/deploy-pages.log" 2>&1 || fail "Pages deploy"
say "  deployed"

say "stage 5 deployment settle gate"
npm run stage:pages > "$WORK/stage.log" 2>&1 || fail "Pages staging"
settle dist/src/gis/service.js /src/gis/service.js || fail "deployment settle (frontend)"
settle dist/src/discovery/discovery-catalog.js /src/discovery/discovery-catalog.js || fail "deployment settle (catalog selection)"
settle dist/src/discovery/national-catalog.js /src/discovery/national-catalog.js || fail "deployment settle (national catalog)"
settle dist/data/national/derived-catalog.json /data/national/derived-catalog.json || fail "deployment settle (national pointer)"
settle dist/data/discovery/search-areas.json /data/discovery/search-areas.json || fail "deployment settle (declaration)"

say "stage 6 real-browser production check"
if PRODUCTION_BASE_URL="$ORIGIN" RUN_NATIONAL_PRODUCTION=1 \
   npx playwright test tests/national-derived-production.spec.js --reporter=line --retries=0 \
   > "$WORK/browser-production.txt" 2>&1; then
  cp "$WORK/browser-production.txt" data/national/verification/derived-publication-browser.txt
  node scripts/record-national-release-status.mjs --browser passed \
    --record data/national/verification/derived-publication-browser.txt
  git add -A
  git commit -q -m "Record the national derived release: R2 publication verified and browser cutover passed"
  git push origin main >> "$LOG" 2>&1 || fail "push"
  say "  production browser verification passed"
  say "CHAIN COMPLETE"
else
  cp "$WORK/browser-production.txt" data/national/verification/derived-publication-browser.txt
  node scripts/record-national-release-status.mjs --browser failed \
    --reason "the deployed browser check failed; see data/national/verification/derived-publication-browser.txt"
  git add -A
  git commit -q -m "Record the national derived release status: R2 publication verified, browser cutover failed" || true
  git push origin main >> "$LOG" 2>&1 || true
  fail "production browser verification"
fi

