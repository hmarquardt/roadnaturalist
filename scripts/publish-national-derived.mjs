#!/usr/bin/env node
// Publish the national derived corridor-metrics plane to the Road Naturalist R2 bucket, resumably.
//
//   node scripts/publish-national-derived.mjs [--final <plane-or-root>] [--concurrency 16] [--limit N]
//   node scripts/publish-national-derived.mjs --via wrangler --concurrency 6
//   node scripts/publish-national-derived.mjs --account <id> --check-only
//
// The set to publish is the finalized manifest itself (`national-derived-objects.mjs`): its manifest object and
// one object per present cell, under the immutable `derived/corridor-metrics/<analysis-fingerprint>/` directory
// the manifest already declares. A rebuilt plane is a new directory, so nothing published is ever overwritten;
// an object whose remote byte length already matches the manifest is reused rather than re-uploaded, and a
// mismatch is a failure rather than a silent overwrite.
//
// Publication is checkpointed and idempotent: every completed object is appended to a JSONL checkpoint under the
// build volume (never /tmp alone), a re-run skips what it already published, and a partial run leaves the
// checkpoint - and every immutable object - valid. The remote audit is a separate command on purpose, so one
// long upload is not one fragile all-or-nothing command.
//
// Upload primitive: the Cloudflare R2 REST API (the same API `wrangler r2 object put` uses), authenticated by
// `CLOUDFLARE_API_TOKEN` or by Wrangler's stored OAuth login, with `--via wrangler` to shell out to the CLI the
// regional publisher uses instead. `CLOUDFLARE_ACCOUNT_ID` (or `--account`) is required for the API path.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { IMMUTABLE_CACHE_CONTROL, nationalDerivedObjectSet, resolvePlane } from './national-derived-objects.mjs';

const run = promisify(execFile);
const WRANGLER = 'wrangler@4.135.0';
const BUCKET = 'roadnaturalist-data';
const BASE = 'https://data.roadnaturalist.com/';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };

const BUILD = process.env.ROADNATURALIST_BUILD_VOLUME ?? '/Volumes/Lexar/roadnaturalist';
const root = option('--final') ?? process.env.NATIONAL_DERIVED_FINAL ?? join(BUILD, 'cells/derived/corridor-metrics');
if (!existsSync(root)) throw new Error(`finalized plane root does not exist: ${root}`);
const plane = resolvePlane(root);
const set = nationalDerivedObjectSet(plane);

const work = option('--work') ?? join(BUILD, 'work/derived-national-publication');
mkdirSync(work, { recursive: true });
const checkpointPath = join(work, 'checkpoint.jsonl');
const reportPath = option('--report') ?? join(work, 'publication.json');

const concurrency = Number(option('--concurrency') ?? 16);

const limit = option('--limit') ? Number(option('--limit')) : Infinity;
// Two publication halves may run at once over disjoint slices: the Cloudflare API path is rate limited while the
// `wrangler` path is not, so a long publication can use both without either racing the other (immutable keys,
// disjoint object sets, and every object is checked against its manifest length before it is written).
const offset = option('--offset') ? Number(option('--offset')) : 0;
const checkOnly = flag('--check-only');
const via = option('--via') ?? 'api';
const account = option('--account') ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? null;
// The Cloudflare API tolerates only a few R2 object writes per second before it suspends the burst. A global
// pacer keeps every worker under that ceiling instead of discovering it by being throttled, which is what makes
// the publication's throughput predictable rather than bursty. `--rate` is requests per second.
const rate = Number(option('--rate') ?? 4);
let nextSlot = 0;
async function pace() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + 1000 / rate;
  const wait = slot - now;
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}

// ---------------------------------------------------------------- authentication (API path)
function wranglerConfig() {
  const candidates = [process.env.WRANGLER_CONFIG,
    join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
    join(homedir(), '.config/.wrangler/config/default.toml'), join(homedir(), '.wrangler/config/default.toml')];
  return candidates.find(path => path && existsSync(path)) ?? null;
}

function storedToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const path = wranglerConfig();
  if (!path) return null;
  const match = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(path, 'utf8'));
  return match ? match[1] : null;
}

// Wrangler refreshes the OAuth token on use; re-running a harmless command is how a long publication survives
// the token's one-hour lifetime without a dashboard copy-paste.
async function refreshToken() {
  try { await run('npx', ['--yes', WRANGLER, 'r2', 'bucket', 'list'], { timeout: 120000 }); } catch { /* fall through */ }
  return storedToken();
}

let token = via === 'api' ? storedToken() : null;
if (via === 'api' && !token) throw new Error('the API path needs CLOUDFLARE_API_TOKEN or a Wrangler login');
if (via === 'api' && !account) throw new Error('the API path needs CLOUDFLARE_ACCOUNT_ID or --account');

async function putViaApi(object) {
  const body = readFileSync(object.local);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await pace();
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${BUCKET}/objects/${object.key}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': object.type, 'Cache-Control': IMMUTABLE_CACHE_CONTROL },
        body, signal: AbortSignal.timeout(180000) });
    if (response.ok) return response.json();
    if (response.status === 401 || response.status === 403) { token = await refreshToken(); continue; }
    // The Cloudflare API throttles bulk object writes (HTTP 429, code 971) well below the point where a burst
    // finishes in time. It is a pace signal, not a failure: back off patiently (with jitter) and keep retrying,
    // because a resumed run must be able to finish the objects a fast run could not. Sustained throughput is a
    // few objects per second; the checkpoint makes that a slow-but-certain publication rather than a lost one.
    if (response.status === 429) {
      const backoff = Math.min(30000, 1000 * 2 ** attempt) * (0.5 + Math.random());
      await new Promise(resolve => setTimeout(resolve, backoff));
      continue;
    }
    throw new Error(`${object.key}: HTTP ${response.status} ${await response.text()}`);
  }
  throw new Error(`${object.key}: still throttled or unauthenticated after retries`);
}

async function putViaWrangler(object) {
  await run('npx', ['--yes', WRANGLER, 'r2', 'object', 'put', `${BUCKET}/${object.key}`, '--file', object.local,
    '--content-type', object.type, '--cache-control', IMMUTABLE_CACHE_CONTROL, '--remote'],
    { maxBuffer: 8 * 1024 * 1024, timeout: 600000 });
}

// A public HEAD tells us the object is already there with the right length. R2 is read-after-write consistent,
// so this is authoritative for "reuse rather than re-upload" and for the post-upload length check.
async function remoteBytes(object) {
  try {
    const response = await fetch(new URL(object.key, BASE), { method: 'HEAD',
      headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) return null;
    const value = response.headers.get('content-length');
    return value == null ? null : Number(value);
  } catch { return null; }
}

// ---------------------------------------------------------------- checkpoint
const done = new Map();
if (existsSync(checkpointPath)) {
  for (const line of readFileSync(checkpointPath, 'utf8').split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.key) done.set(entry.key, entry);
  }
}
let appendQueue = Promise.resolve();
function record(entry) {
  appendQueue = appendQueue.then(() => appendFileSync(checkpointPath, `${JSON.stringify(entry)}\n`));
  return appendQueue;
}

// ---------------------------------------------------------------- publish
const tally = { uploaded: 0, reused: 0, failed: 0 };
let uploadedBytes = 0;
let next = 0;
let logged = 0;
const started = Date.now();
const pending = set.objects.slice(offset, Number.isFinite(limit) ? offset + limit : set.objects.length);
console.log(`${set.fingerprint}: ${pending.length}/${set.objects.length} objects, `
  + `${pending.reduce((sum, object) => sum + object.bytes, 0).toLocaleString()} bytes, via ${via}, concurrency ${concurrency}`
  + `${via === 'api' ? `, ${rate} req/s` : ''}${checkOnly ? ' (check-only)' : ''}`);

async function publishOne(object) {
  const previous = done.get(object.key);
  if (previous && previous.bytes === object.bytes && previous.sha256 === object.sha256 && !checkOnly) {
    tally.reused += 1;
    return;
  }
  const existing = await remoteBytes(object);
  if (existing === object.bytes) {
    tally.reused += 1;
    await record({ key: object.key, bytes: object.bytes, sha256: object.sha256, status: 'present', at: new Date().toISOString() });
    return;
  }
  if (existing != null && existing !== object.bytes) {
    throw new Error(`${object.key}: remote ${existing} bytes != manifest ${object.bytes}; refusing to overwrite an immutable key`);
  }
  if (checkOnly) { tally.failed += 1; console.error(`  missing: ${object.key}`); return; }
  if (via === 'wrangler') await putViaWrangler(object); else await putViaApi(object);
  const uploaded = await remoteBytes(object);
  // A public HEAD can lag a moment behind an upload; the independent audit is what proves bytes and digests.
  if (uploaded != null && uploaded !== object.bytes) throw new Error(`${object.key}: uploaded ${uploaded} bytes, expected ${object.bytes}`);
  tally.uploaded += 1;
  uploadedBytes += object.bytes;
  await record({ key: object.key, bytes: object.bytes, sha256: object.sha256, status: 'uploaded',
    verifiedLength: uploaded, at: new Date().toISOString() });
}

async function worker() {
  for (;;) {
    const index = next++;
    if (index >= pending.length) return;
    const object = pending[index];
    try {
      await publishOne(object);
    } catch (error) {
      tally.failed += 1;
      console.error(`FAILED ${object.key}: ${error.message}`);
    }
    const processed = tally.uploaded + tally.reused + tally.failed;
    if (processed - logged >= 200 || processed === pending.length) {
      logged = processed;
      const elapsed = (Date.now() - started) / 1000;
      console.log(`  ${processed}/${pending.length} ${JSON.stringify(tally)} `
        + `${(uploadedBytes / 1048576).toFixed(1)} MB up, ${(uploadedBytes / 1048576 / elapsed).toFixed(2)} MB/s, ${elapsed.toFixed(0)}s`);
    }
  }
}

await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

const elapsed = (Date.now() - started) / 1000;
const summary = { kind: 'national-derived-publication', fingerprint: set.fingerprint, directory: set.directory,
  bucket: BUCKET, base: BASE, via, objects: pending.length, declaredObjects: set.objects.length,
  uploaded: tally.uploaded, reused: tally.reused, failed: tally.failed, uploadedBytes,
  elapsedSeconds: Number(elapsed.toFixed(1)), megabytesPerSecond: Number((uploadedBytes / 1048576 / elapsed).toFixed(2)),
  checkpoint: checkpointPath, finishedAt: new Date().toISOString() };
writeFileSync(reportPath, `${JSON.stringify(summary, null, 1)}\n`);
console.log(`Done: ${JSON.stringify(summary)}`);
if (tally.failed) { console.error(`${tally.failed} object(s) failed; re-run to retry, then audit.`); process.exitCode = 1; }

