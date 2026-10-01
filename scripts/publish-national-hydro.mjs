#!/usr/bin/env node
// Publish representative national hydrography cells and audit exactly what was published.
//
// The manifest is the enumeration: this tool derives the object list from `data/national/hydro-manifest.json`,
// publishes any object whose remote byte length does not already match, and then re-reads every object it
// declared with a public GET to prove bytes, SHA-256, content type, immutable caching, CORS and Range support.
// Publisher and auditor share that one list by construction, which is the invariant the regional
// component-index omission taught: a declared object that only one of the two enumerates can go missing while
// both report success.
//
// Publication is deliberately representative, not complete: national raw planes are published when the
// promotion and raw-verification path needs them, which is the same gate roads and wetlands went through.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const WRANGLER = 'wrangler@4.135.0';
const BUCKET = 'roadnaturalist-data';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const CONTENT_TYPE = 'application/vnd.apache.parquet';
const MANIFEST = 'data/national/hydro-manifest.json';
const ORIGIN = 'https://roadnaturalist.pages.dev';
// One representative unit per region the task names, so the samples cover the shapes that matter: the regional
// footprint, a dense Gulf/Florida unit, a dense northeastern unit and an arid unit.
const REGIONAL_UNITS = { pnw: '17090010', gulf: '03090205', northeast: '01080203', southwest: '15070103' };

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index === -1 ? null : args[index + 1]; };
const checkOnly = args.includes('--check-only');
const publish = args.includes('--publish');
const volume = option('--work') ?? process.env.ROADNATURALIST_BUILD_VOLUME ?? '/Volumes/Lexar/roadnaturalist';
const workload = volume.startsWith('/') ? `${volume}/work/nhd` : 'data/national-hydro-work';

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (manifest.kind !== 'national-hydrography') throw new Error('the manifest is not a national hydrography plane');
const byId = new Map(manifest.cells.map(cell => [cell.id, cell]));

// The chosen object set: for each representative unit, the largest present cell its checkpoint recorded.
const selected = [];
for (const [region, unit] of Object.entries(REGIONAL_UNITS)) {
  const checkpoint = JSON.parse(readFileSync(`${workload}/partition-jobs/${unit}.json`, 'utf8'));
  const present = checkpoint.cells.map(id => byId.get(id)).filter(cell => cell && cell.state === 'present');
  if (!present.length) continue;
  const cell = present.sort((left, right) => right.bytes - left.bytes)[0];
  selected.push({ region, unit, id: cell.id, url: cell.url, bytes: cell.bytes, sha256: cell.sha256,
    contentType: CONTENT_TYPE, local: `${workload}/artifacts/hydro/${cell.id}.parquet` });
}
if (!selected.length) throw new Error('no representative hydro cell is available to publish');
for (const object of selected) {
  const bytes = readFileSync(object.local);
  if (bytes.length !== object.bytes || createHash('sha256').update(bytes).digest('hex') !== object.sha256) {
    throw new Error(`${object.id}: local artifact does not match the manifest`);
  }
}

const base = manifest.assetBaseUrl ?? 'https://data.roadnaturalist.com/';
for (const object of selected) {
  const head = await fetch(new URL(object.url, base), { method: 'HEAD',
    headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(20000) }).catch(() => null);
  const remote = head?.ok ? Number(head.headers.get('content-length')) : null;
  if (remote === object.bytes) { object.status = 'present'; continue; }
  if (checkOnly || !publish) { object.status = remote == null ? 'missing' : 'size-mismatch'; continue; }
  execFileSync('npx', ['--yes', WRANGLER, 'r2', 'object', 'put', `${BUCKET}/${object.url}`, '--file', object.local,
    '--content-type', object.contentType, '--cache-control', CACHE_CONTROL, '--remote'],
    { stdio: 'inherit', timeout: 600000 });
  object.status = 'uploaded';
}

// The audit is the proof: every declared object is re-read and compared with what was declared.
const audit = [];
for (const object of selected) {
  const range = await fetch(new URL(object.url, base), { headers: { Origin: ORIGIN, Range: 'bytes=0-15' },
    signal: AbortSignal.timeout(30000) });
  const rangeBody = Buffer.from(await range.arrayBuffer());
  const full = await fetch(new URL(object.url, base), { headers: { Origin: ORIGIN },
    signal: AbortSignal.timeout(60000) });
  const bytes = Buffer.from(await full.arrayBuffer());
  const record = { region: object.region, unit: object.unit, id: object.id, url: object.url, status: object.status,
    bytes: bytes.length, expectedBytes: object.bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'), expectedSha256: object.sha256,
    contentType: full.headers.get('content-type'), cacheControl: full.headers.get('cache-control'),
    cors: full.headers.get('access-control-allow-origin'), rangeStatus: range.status, rangeBytes: rangeBody.length };
  if (record.bytes !== record.expectedBytes || record.sha256 !== record.expectedSha256
      || record.contentType !== CONTENT_TYPE || !record.cacheControl?.includes('immutable')
      || record.cors !== ORIGIN || record.rangeStatus !== 206 || record.rangeBytes !== 16) {
    throw new Error(`${object.id}: audit failed ${JSON.stringify(record)}`);
  }
  audit.push(record);
  writeFileSync(`data/national/hydro-r2-audit-${object.region}.json`,
    `${JSON.stringify({ kind: 'national-hydro-r2-sample-audit', bucket: BUCKET, manifestVersion: manifest.version,
      cells: [record] }, null, 1)}\n`);
}
const totalBytes = audit.reduce((sum, record) => sum + record.bytes, 0);
console.log(`national hydro: ${selected.length} representative object(s) ${publish ? 'published' : 'checked'}`
  + `, ${totalBytes.toLocaleString()} bytes, every digest, content type, immutable cache, CORS and Range valid`);
