#!/usr/bin/env node
// Publish selected immutable NWI cells and audit public delivery. A partial build never activates a catalog.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const selected = (option('--cells') ?? '').split(',').filter(Boolean);
const publish = args.includes('--publish');
if (!selected.length) throw new Error('Declare representative --cells xNNN_yNNN,...');
const work = resolve(ROOT, option('--work') ?? 'data/national-wetlands-work');
const manifestPath = resolve(ROOT, option('--manifest') ?? `${work}/artifacts/wetland-manifest.json`);
const manifest = JSON.parse(readFileSync(manifestPath));
if (manifest.kind !== 'national-wetlands' || !manifest.version?.startsWith('nwi-state-2026-05-')) {
  throw new Error('unexpected national NWI manifest');
}
const byId = new Map(manifest.cells.map(cell => [cell.id, cell]));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = 'https://data.roadnaturalist.com/';
const bucket = 'roadnaturalist-data';
const origin = 'https://roadnaturalist.pages.dev';
const results = [];
for (const id of selected) {
  const cell = byId.get(id);
  if (!cell || cell.state !== 'present') throw new Error(`${id} is not a present wetland cell`);
  const path = resolve(work, `artifacts/wetlands/${id}.parquet`);
  const local = readFileSync(path);
  if (local.length !== cell.bytes || hash(local) !== cell.sha256) throw new Error(`${id} local artifact differs from manifest`);
  const url = new URL(cell.url, base);
  let response = await fetch(url, { headers: { 'Accept-Encoding': 'identity', Origin: origin }, signal: AbortSignal.timeout(60000) });
  if (response.ok) {
    const remote = Buffer.from(await response.arrayBuffer());
    if (remote.length !== cell.bytes || hash(remote) !== cell.sha256) throw new Error(`${id} immutable remote key differs; refusing overwrite`);
  } else if (response.status === 404 && publish) {
    execFileSync('npx', ['--yes', 'wrangler@4.135.0', 'r2', 'object', 'put', `${bucket}/${cell.url}`,
      '--file', path, '--content-type', 'application/vnd.apache.parquet',
      '--cache-control', 'public, max-age=31536000, immutable', '--remote'], { cwd: ROOT, stdio: 'inherit', timeout: 600000 });
    response = await fetch(url, { headers: { 'Accept-Encoding': 'identity', Origin: origin }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`${id} upload not publicly readable: HTTP ${response.status}`);
    const remote = Buffer.from(await response.arrayBuffer());
    if (remote.length !== cell.bytes || hash(remote) !== cell.sha256) throw new Error(`${id} remote bytes/digest differ`);
  } else {
    throw new Error(`${id} remote ${response.status}; use --publish for a missing cell`);
  }
  const range = await fetch(url, { headers: { Range: 'bytes=0-63', Origin: origin }, signal: AbortSignal.timeout(30000) });
  const contentType = response.headers.get('content-type') ?? '';
  const cacheControl = response.headers.get('cache-control') ?? '';
  const cors = response.headers.get('access-control-allow-origin') ?? '';
  if (!contentType.includes('application/vnd.apache.parquet') || !cacheControl.includes('immutable')
      || !cors || range.status !== 206 || (await range.arrayBuffer()).byteLength !== 64) {
    throw new Error(`${id} public headers/Range audit failed: ${JSON.stringify({ contentType, cacheControl, cors, range: range.status })}`);
  }
  results.push({ id, url: cell.url, bytes: cell.bytes, sha256: cell.sha256,
    contentType, cacheControl, cors, rangeStatus: range.status });
}
const report = { kind: 'national-wetland-r2-sample-audit', bucket, manifestVersion: manifest.version,
  buildCoverage: manifest.buildCoverage, cells: results };
const reportPath = option('--report');
if (reportPath) writeFileSync(resolve(ROOT, reportPath), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
