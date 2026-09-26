#!/usr/bin/env node
// Read-only production audit. The catalog is authoritative; every object must match its bytes
// and SHA-256, and browser CORS must allow the Road Naturalist Pages origin.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const catalog = JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url)));
if (catalog.assetBaseUrl !== 'https://data.roadnaturalist.com/') throw new Error('Unexpected regional data origin');
let bytes = 0;
let files = 0;
for (const dataset of catalog.datasets) for (const part of dataset.partitions) {
  if (part.state === 'empty') continue;
  const url = new URL(part.url, catalog.assetBaseUrl);
  const response = await fetch(url, { headers: { Origin: 'https://roadnaturalist.pages.dev' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${part.url}: HTTP ${response.status}`);
  if (response.headers.get('access-control-allow-origin') !== 'https://roadnaturalist.pages.dev') {
    throw new Error(`${part.url}: CORS origin missing`);
  }
  if (!response.headers.get('cache-control')?.includes('immutable')
    || response.headers.get('content-type') !== 'application/vnd.apache.parquet') {
    throw new Error(`${part.url}: immutable Parquet metadata missing`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length !== part.bytes || createHash('sha256').update(body).digest('hex') !== part.sha256) {
    throw new Error(`${part.url}: remote byte/digest mismatch`);
  }
  bytes += body.length;
  files++;
}
const first = catalog.datasets[0].partitions.find(part => part.state === 'present');
const range = await fetch(new URL(first.url, catalog.assetBaseUrl), { headers: {
  Origin: 'https://roadnaturalist.pages.dev', Range: 'bytes=0-15',
}, signal: AbortSignal.timeout(15000) });
if (range.status !== 206 || (await range.arrayBuffer()).byteLength !== 16) throw new Error('R2 Range GET failed');
console.log(`Regional remote audit: ${files} objects, ${bytes.toLocaleString()} bytes, all SHA-256/CORS valid; Range GET 206`);
