#!/usr/bin/env node
// Read-only production audit. The catalog is authoritative; every object must match its bytes
// and SHA-256, and browser CORS must allow the Road Naturalist Pages origin.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { regionalObjectSet } from './regional-objects.mjs';

const PARQUET = 'application/vnd.apache.parquet';
const JSON_TYPE = 'application/json';
const derivedOnly = process.argv.includes('--derived-only');
const catalog = JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url)));
if (catalog.assetBaseUrl !== 'https://data.roadnaturalist.com/') throw new Error('Unexpected regional data origin');

// One enumeration, shared with the publisher: every present raw partition, the road component index the
// catalog declares, and the immutable derived plane. A declared object that no tool checks is how the version-3
// component index went missing while this audit still reported success.
const objects = regionalObjectSet(catalog, { derivedOnly });

let bytes = 0;
const planes = {};
for (const object of objects) {
  const response = await fetch(new URL(object.key, catalog.assetBaseUrl), {
    headers: { Origin: 'https://roadnaturalist.pages.dev' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${object.key}: HTTP ${response.status}`);
  if (response.headers.get('access-control-allow-origin') !== 'https://roadnaturalist.pages.dev') {
    throw new Error(`${object.key}: CORS origin missing`);
  }
  if (!response.headers.get('cache-control')?.includes('immutable')) {
    throw new Error(`${object.key}: immutable cache-control missing`);
  }
  if (response.headers.get('content-type') !== object.type) {
    throw new Error(`${object.key}: content-type ${response.headers.get('content-type')}, expected ${object.type}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length !== object.bytes || createHash('sha256').update(body).digest('hex') !== object.sha256) {
    throw new Error(`${object.key}: remote byte/digest mismatch`);
  }
  bytes += body.length;
  planes[object.plane] = (planes[object.plane] ?? 0) + 1;
}
// Range support is what tells the browser it can stream a partition rather than buffer it whole, so it is
// proven on one Parquet object of each plane rather than assumed.
for (const plane of derivedOnly ? ['derived'] : ['regional', 'derived']) {
  const object = objects.find(candidate => candidate.plane === plane && candidate.type === PARQUET);
  if (!object) continue;
  const range = await fetch(new URL(object.key, catalog.assetBaseUrl), { headers: {
    Origin: 'https://roadnaturalist.pages.dev', Range: 'bytes=0-15',
  }, signal: AbortSignal.timeout(15000) });
  if (range.status !== 206 || (await range.arrayBuffer()).byteLength !== 16) {
    throw new Error(`R2 Range GET failed for ${object.key}`);
  }
}
console.log(`Regional remote audit: ${objects.length} objects (${JSON.stringify(planes)}), `
  + `${bytes.toLocaleString()} bytes, all SHA-256/CORS/content-type valid; Range GET 206`);
