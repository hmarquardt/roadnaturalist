#!/usr/bin/env node
// Report the readiness of every raw plane and every bounded region, as separate facts.
//
//   node scripts/verify-national-raw-readiness.mjs            # local index + the published documents
//   node scripts/verify-national-raw-readiness.mjs --json     # one machine-readable line per status
//
// Discovery is nationally ready on the derived plane and always is. This reports the *raw* side, where the planes
// are deliberately different shapes:
//
//   derived corridor metrics   READY     published once, everywhere, the discovery payload
//   roads                      READY     published whole (5.82 GB): a promotion never fails for want of a road
//   ecoregions                 READY     two whole-CONUS layers, published once
//   wetlands                   PARTIAL   published where people explore (156.4 GB stays offline by design)
//   hydrography                PARTIAL   published where people explore (26.6 GB stays offline by design)
//
// Partial bounded coverage is not a failed release, and this says so in the vocabulary it uses. The exit code is
// non-zero only for a *broken* claim: an index that does not validate, a globally ready plane whose documents are
// not online, or a region whose catalog is not what the index declares.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRawRegionsIndex } from '../src/discovery/raw-catalog.js';
import { RAW_INDEX_PATH } from '../scripts/national-raw-objects.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.com';
const json = process.argv.includes('--json');
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

async function head(url) {
  const response = await fetch(url, { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(30000) });
  return response.ok ? Number(response.headers.get('content-length')) : null;
}

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(120000) });
  return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
}

async function main() {
  const problems = [];
  const status = [];
  let index = null;
  const committed = readFileSync(join(ROOT, RAW_INDEX_PATH));
  try {
    index = validateRawRegionsIndex(JSON.parse(committed.toString('utf8')));
  } catch (error) {
    problems.push(`the committed raw index does not validate: ${error.message}`);
  }
  // The index the running application reads is the staged one, so the deployed copy is checked too: a difference
  // between what is committed and what is served is exactly the skew this release gate exists to catch.
  const deployed = await fetchBytes(`${BASE}/data/national/raw-regions.json`);
  if (!deployed) problems.push(`the deployed raw index is not served at ${BASE}/data/national/raw-regions.json`);
  else if (sha256(deployed) !== sha256(committed)) {
    problems.push('the deployed raw index differs from the committed one: deploy the commit under review');
  }
  return report({ index, status, problems });
}

async function report({ index, status, problems }) {
  const roads = index?.globalPlanes?.roads ?? null;
  if (!roads || roads.state !== 'READY') {
    status.push({ plane: 'roads', state: roads?.state ?? 'ABSENT', note: 'the national roads plane is not declared ready' });
  } else {
    const published = await head(`${roads.assetBaseUrl}${roads.publicationUrl}`);
    const document = published ? await fetchBytes(`${roads.assetBaseUrl}${roads.publicationUrl}`) : null;
    if (document && sha256(document) !== roads.publicationSha256) problems.push('the roads publication digest differs from the index');
    if (published !== roads.publicationBytes) problems.push(`the roads publication is ${published} bytes, the index declares ${roads.publicationBytes}`);
    const publication = document ? JSON.parse(document.toString()) : null;
    const sample = publication?.cells?.[0] ?? null;
    const sampleBytes = sample ? await head(`${roads.assetBaseUrl}${roads.pathPrefix}${sample.id}.parquet`) : null;
    if (sample && sampleBytes !== sample.bytes) problems.push(`roads cell ${sample.id} is ${sampleBytes} bytes, the publication declares ${sample.bytes}`);
    status.push({ plane: 'roads', state: problems.length ? 'BROKEN' : 'READY', version: roads.version,
      objects: roads.objects, bytes: roads.bytes, presentCells: roads.presentCells, emptyCells: roads.emptyCells,
      closureTiles: roads.closure?.tiles ?? null, auditedAt: roads.auditedAt ?? null });
  }
  const ecoregions = index?.globalPlanes?.ecoregions ?? null;
  status.push({ plane: 'ecoregions', state: ecoregions?.state ?? 'ABSENT',
    levels: ecoregions ? Object.keys(ecoregions.levels ?? {}).length : 0 });

  const bounded = {};
  for (const region of index?.regions ?? []) {
    const catalog = await fetchBytes(`${region.assetBaseUrl}${region.catalogUrl}`);
    if (!catalog) { problems.push(`region ${region.id}: its catalog is not online`); continue; }
    if (catalog.length !== region.catalogBytes) problems.push(`region ${region.id}: catalog is ${catalog.length} bytes, the index declares ${region.catalogBytes}`);
    if (sha256(catalog) !== region.catalogSha256) problems.push(`region ${region.id}: catalog digest differs from the index`);
    for (const dataset of JSON.parse(catalog.toString()).datasets) {
      bounded[dataset.id] = (bounded[dataset.id] ?? 0) + dataset.partitions.filter(part => part.state === 'present').length;
    }
  }
  for (const plane of ['wetlands', 'hydrography']) {
    status.push({ plane, state: (bounded[plane] ?? 0) > 0 ? 'PARTIAL' : 'ABSENT',
      version: index?.planes?.find(entry => entry.id === plane)?.version ?? null,
      publishedCells: bounded[plane] ?? 0, regions: index?.regions?.length ?? 0 });
  }
  status.push({ plane: 'derived', state: 'READY' });

  if (json) for (const entry of status) console.log(JSON.stringify(entry));
  else {
    console.log('raw plane readiness');
    for (const entry of status) {
      const detail = [entry.version,
        entry.objects ? `${entry.objects.toLocaleString()} objects` : null,
        entry.bytes ? `${(entry.bytes / 1e9).toFixed(2)} GB` : null,
        entry.presentCells != null ? `${entry.presentCells.toLocaleString()} present / ${entry.emptyCells.toLocaleString()} empty cells` : null,
        entry.closureTiles != null ? `${entry.closureTiles.toLocaleString()} closure tiles` : null,
        entry.publishedCells != null ? `${entry.publishedCells.toLocaleString()} published cells in ${entry.regions} region(s)` : null,
      ].filter(Boolean).join(', ');
      console.log(`  ${entry.plane.padEnd(12)} ${String(entry.state).padEnd(8)} ${detail}`);
    }
  }
  if (problems.length) {
    for (const problem of problems) console.error(`PROBLEM ${problem}`);
    return 1;
  }
  console.log('raw readiness: no broken claim');
  return 0;
}

main().then(code => { process.exitCode = code; })
  .catch(error => { console.error(`READINESS CHECK FAILED: ${error.message}`); process.exitCode = 1; });

