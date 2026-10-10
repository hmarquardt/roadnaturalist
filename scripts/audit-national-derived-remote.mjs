#!/usr/bin/env node
// Full remote audit of the national derived corridor-metrics plane, against the exact publication set.
//
//   node scripts/audit-national-derived-remote.mjs [--final <plane-or-root>] [--concurrency 12]
//   node scripts/audit-national-derived-remote.mjs --sample 512
//
// Upload success is not evidence: every object the finalized manifest declares present is fetched from the
// public R2 origin and compared with what the manifest says it is - exact byte count, exact SHA-256, the
// declared content type, immutable cache-control, the Road Naturalist Pages origin's CORS, and (for
// representative Parquet objects) a Range `206`. The manifest object must match the local authoritative manifest
// digest. The audit enumerates the same set as the publisher (`national-derived-objects.mjs`), so a declared
// object cannot be missed. Results are checkpointed to the build volume, so a long audit is resumable.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nationalDerivedObjectSet, resolvePlane } from './national-derived-objects.mjs';

const ORIGIN = 'https://roadnaturalist.pages.dev';
const BASE = 'https://data.roadnaturalist.com/';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };

const BUILD = process.env.ROADNATURALIST_BUILD_VOLUME ?? '/Volumes/Lexar/roadnaturalist';
const root = option('--final') ?? process.env.NATIONAL_DERIVED_FINAL ?? join(BUILD, 'cells/derived/corridor-metrics');
const plane = resolvePlane(root);
const set = nationalDerivedObjectSet(plane);
const concurrency = Number(option('--concurrency') ?? 12);
const sample = option('--sample') ? Number(option('--sample')) : null;

const work = option('--work') ?? join(BUILD, 'work/derived-national-publication');
mkdirSync(work, { recursive: true });
const checkpointPath = join(work, `audit-${set.fingerprint.slice(0, 12)}.jsonl`);
const reportPath = option('--report') ?? join(work, 'audit.json');

// A deterministic sample: every Nth object, always including the manifest and a spread of cell sizes.
function selection() {
  if (!sample || sample >= set.objects.length) return set.objects;
  const stride = Math.max(1, Math.floor(set.objects.length / sample));
  const chosen = [];
  for (let index = 0; index < set.objects.length; index += stride) chosen.push(set.objects[index]);
  const manifest = set.objects.find(object => object.cell === 'manifest');
  return chosen.includes(manifest) ? chosen : [manifest, ...chosen];
}

const objects = selection();
const results = new Map();
if (existsSync(checkpointPath)) {
  for (const line of readFileSync(checkpointPath, 'utf8').split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.key && entry.ok) results.set(entry.key, entry);
  }
}

let appendQueue = Promise.resolve();
function record(entry) {
  appendQueue = appendQueue.then(() => appendFileSync(checkpointPath, `${JSON.stringify(entry)}\n`));
  return appendQueue;
}

async function auditOne(object) {
  const response = await fetch(new URL(object.key, BASE), { headers: { Origin: ORIGIN }, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`${object.key}: HTTP ${response.status}`);
  const cors = response.headers.get('access-control-allow-origin') ?? '';
  if (cors !== ORIGIN) throw new Error(`${object.key}: CORS origin ${cors}`);
  const cache = response.headers.get('cache-control') ?? '';
  if (!cache.includes('immutable')) throw new Error(`${object.key}: cache-control ${cache}`);
  const type = response.headers.get('content-type') ?? '';
  if (type !== object.type) throw new Error(`${object.key}: content-type ${type}, expected ${object.type}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length !== object.bytes) throw new Error(`${object.key}: ${body.length} bytes, expected ${object.bytes}`);
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest !== object.sha256) throw new Error(`${object.key}: SHA-256 ${digest}, expected ${object.sha256}`);
  return { key: object.key, bytes: body.length, sha256: digest, ok: true, at: new Date().toISOString() };
}

let next = 0;
let audited = 0;
let bytes = 0;
const failures = [];
let logged = 0;
const started = Date.now();
console.log(`audit ${set.fingerprint}: ${objects.length} object(s), ${objects.reduce((sum, object) => sum + object.bytes, 0).toLocaleString()} bytes`);

async function worker() {
  for (;;) {
    const index = next++;
    if (index >= objects.length) return;
    const object = objects[index];
    if (results.has(object.key)) { audited += 1; bytes += object.bytes; continue; }
    try {
      const entry = await auditOne(object);
      results.set(object.key, entry);
      audited += 1;
      bytes += entry.bytes;
      await record(entry);
    } catch (error) {
      failures.push({ key: object.key, error: error.message });
      console.error(`FAILED ${error.message}`);
    }
    const processed = audited + failures.length;
    if (processed - logged >= 200 || processed === objects.length) {
      logged = processed;
      console.log(`  ${processed}/${objects.length} audited, ${(bytes / 1048576).toFixed(1)} MB verified, ${failures.length} failed`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

// Range support is what lets the browser stream a cell rather than buffer it whole, so it is proven rather than
// assumed - on the largest cell and on the manifest's first present cell.
const probeCells = [set.objects.find(object => object.cell === 'manifest'),
  ...set.objects.filter(object => object.cell !== 'manifest').sort((left, right) => right.bytes - left.bytes).slice(0, 1),
  ...set.objects.filter(object => object.cell !== 'manifest').slice(0, 1)];
const ranges = [];
for (const object of probeCells) {
  const response = await fetch(new URL(object.key, BASE), { headers: { Origin: ORIGIN, Range: 'bytes=0-31' }, signal: AbortSignal.timeout(30000) });
  const length = (await response.arrayBuffer()).byteLength;
  ranges.push({ key: object.key, status: response.status, bytes: length, acceptRanges: response.headers.get('accept-ranges') });
  if (response.status !== 206 || length !== 32) failures.push({ key: object.key, error: `Range GET status ${response.status}, ${length} bytes` });
}

const manifestEntry = set.objects.find(object => object.cell === 'manifest');
const localDigest = createHash('sha256').update(readFileSync(set.manifestPath)).digest('hex');
const manifestRemote = results.get(manifestEntry.key);
if (manifestRemote && manifestRemote.sha256 !== localDigest) failures.push({ key: manifestEntry.key, error: 'remote manifest digest != local manifest digest' });

// The complete remote inventory of the immutable directory, via the R2 API. The per-object audit proves every
// declared object is present and correct; this proves nothing *else* was published - an AppleDouble `._*`
// sibling, a scratch file, or an object from another plane accidentally written under this prefix.
const BUCKET = 'roadnaturalist-data';
const account = option('--account') ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? null;

function apiToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const candidates = [process.env.WRANGLER_CONFIG, join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
    join(homedir(), '.config/.wrangler/config/default.toml'), join(homedir(), '.wrangler/config/default.toml')];
  const path = candidates.find(candidate => candidate && existsSync(candidate));
  if (!path) return null;
  const match = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(path, 'utf8'));
  return match ? match[1] : null;
}

async function inventory(prefix) {
  const keys = new Map();
  let cursor = null;
  for (;;) {
    const params = new URLSearchParams({ prefix, per_page: '1000' });
    if (cursor) params.set('cursor', cursor);
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${BUCKET}/objects?${params}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`inventory: HTTP ${response.status} ${await response.text()}`);
    const body = await response.json();
    for (const item of body.result ?? []) keys.set(item.key, item.size);
    const info = body.result_info ?? {};
    cursor = info.is_truncated ? info.cursor : null;
    if (!cursor) break;
  }
  return keys;
}

const expected = new Set(set.objects.map(object => object.key));
let inventoryResult = { checked: false, reason: 'no R2 API credential for an inventory listing' };
const token = apiToken();
if (token && account) {
  const remote = await inventory(`${set.directory}/`);
  const extra = [...remote.keys()].filter(key => !expected.has(key));
  const missing = [...expected].filter(key => !remote.has(key));
  const sizeMismatch = [...expected].filter(key => remote.has(key) && remote.get(key) !== set.objects.find(object => object.key === key).bytes);
  inventoryResult = { checked: true, remoteObjects: remote.size, expectedObjects: expected.size, extra, missing, sizeMismatch };
  for (const key of extra) failures.push({ key, error: 'unexpected object published under the immutable prefix' });
  for (const key of missing) failures.push({ key, error: 'declared object is missing from the remote inventory' });
  for (const key of sizeMismatch) failures.push({ key, error: 'remote inventory length disagrees with the manifest' });
}

const report = { kind: 'national-derived-remote-audit', fingerprint: set.fingerprint, directory: set.directory,
  base: BASE, objectsAudited: audited, expectedObjects: objects.length, declaredObjects: set.objects.length,
  bytesVerified: bytes, manifestLocalSha256: localDigest, manifestRemoteSha256: manifestRemote?.sha256 ?? null,
  ranges, inventory: inventoryResult, failures, auditedAt: new Date().toISOString() };
writeFileSync(reportPath, `${JSON.stringify(report, null, 1)}\n`);
console.log(`${objects.length} object(s), ${bytes.toLocaleString()} bytes, ${failures.length} failure(s)`);
console.log(`manifest local=${localDigest} remote=${manifestRemote?.sha256 ?? 'MISSING'}`);
if (failures.length) { console.error('REMOTE AUDIT FAILED'); process.exit(1); }
console.log(`REMOTE AUDIT PASSED: every expected key exists with the declared bytes, SHA-256, content type, immutable cache-control and CORS; Range GET 206.`);

