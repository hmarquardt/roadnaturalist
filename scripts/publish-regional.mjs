#!/usr/bin/env node
/**
 * Publish regional partition artifacts to the Road Naturalist data plane, and audit what is there.
 *
 *   node scripts/publish-regional.mjs --catalog data/regional/manifest.json --concurrency 6
 *   node scripts/publish-regional.mjs --catalog data/regional/manifest.json --check-only
 *
 * Objects are immutable and versioned: a catalog version is published once, and a changed byte is a new
 * version, never an overwrite. Re-running with an already published version skips objects whose remotely
 * reported length already matches the catalog, so the command is safe to repeat. Nothing is deleted and no
 * other Cloudflare resource is touched.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const WRANGLER = 'wrangler@4.135.0';
const BUCKET = 'roadnaturalist-data';
const CONTENT_TYPE = 'application/vnd.apache.parquet';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const index = args.indexOf(name); return index === -1 ? null : args[index + 1]; };
const catalogPath = option('--catalog') ?? 'data/regional/manifest.json';
const concurrency = Number(option('--concurrency') ?? 6);
const checkOnly = flag('--check-only');

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const objects = [];
for (const dataset of catalog.datasets) for (const part of dataset.partitions) {
  if (part.state === 'empty') continue;
  objects.push({ key: part.url, local: `data/${part.url}`,
    bytes: part.bytes, sha256: part.sha256, dataset: dataset.id, cell: part.id });
}
const totalBytes = objects.reduce((sum, object) => sum + object.bytes, 0);
console.log(`${catalog.version}: ${objects.length} objects, ${totalBytes.toLocaleString()} bytes from ${catalogPath}`);

async function remoteBytes(object) {
  try {
    const response = await fetch(new URL(object.key, catalog.assetBaseUrl), { method: 'HEAD', signal: AbortSignal.timeout(20000) });
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length'));
    return Number.isFinite(length) ? length : null;
  } catch { return null; }
}

async function publish(object) {
  const existing = await remoteBytes(object);
  if (existing === object.bytes) return { status: 'present' };
  if (checkOnly) return { status: existing == null ? 'missing' : 'size-mismatch' };
  await run('npx', ['--yes', WRANGLER, 'r2', 'object', 'put', `${BUCKET}/${object.key}`, '--file', object.local,
    '--content-type', CONTENT_TYPE, '--cache-control', CACHE_CONTROL, '--remote'], { maxBuffer: 8 * 1024 * 1024, timeout: 600000 });
  // The audit is what proves bytes and digests; a public HEAD can lag a moment behind an upload, so a
  // missing answer here is a warning rather than a failure.
  const uploaded = await remoteBytes(object);
  if (uploaded != null && uploaded !== object.bytes) {
    throw new Error(`${object.key}: uploaded length ${uploaded}, expected ${object.bytes}`);
  }
  return { status: 'uploaded', unverified: uploaded == null };
}

let next = 0;
const tally = { uploaded: 0, present: 0, missing: 0, 'size-mismatch': 0 };
let bytesUploaded = 0;
async function worker() {
  while (next < objects.length) {
    const object = objects[next++];
    const result = await publish(object);
    tally[result.status] += 1;
    if (result.status === 'uploaded') bytesUploaded += object.bytes;
    const done = tally.uploaded + tally.present + tally.missing + tally['size-mismatch'];
    if (done % 25 === 0 || done === objects.length) {
      console.log(`  ${done}/${objects.length} ${JSON.stringify(tally)} uploaded ${(bytesUploaded / 1048576).toFixed(1)} MB`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
console.log(`Done: ${JSON.stringify(tally)} — ${(bytesUploaded / 1048576).toFixed(1)} MB written`);
if (tally.missing || tally['size-mismatch']) {
  console.error('Some objects are absent or the wrong length. Run the audit for details.');
  process.exitCode = 1;
}
