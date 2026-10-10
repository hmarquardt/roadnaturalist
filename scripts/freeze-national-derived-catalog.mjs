#!/usr/bin/env node
// Freeze the committed national derived discovery catalog from the finalized national derived plane.
//
//   node scripts/freeze-national-derived-catalog.mjs [--final <plane-or-root>] [--check]
//
// This is the production pointer: it names the immutable national derived manifest on the data origin, the
// CONUS region and partition scheme it covers, and the analysis fingerprint the running code must see. It is
// generated from the manifest itself - never hand-written - so the pointer and the plane cannot disagree, and
// `--check` is what a test or a release step runs to prove the committed pointer still describes the plane.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PREFIX, resolvePlane } from './national-derived-objects.mjs';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };

const BUILD = process.env.ROADNATURALIST_BUILD_VOLUME ?? '/Volumes/Lexar/roadnaturalist';
const root = option('--final') ?? process.env.NATIONAL_DERIVED_FINAL ?? join(BUILD, 'cells/derived/corridor-metrics');
const output = option('--out') ?? 'data/national/derived-catalog.json';
const plane = resolvePlane(root);
const manifestPath = join(plane, 'manifest.json');
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes);
const fingerprint = manifest.analysisFingerprint;
const counts = manifest.counts ?? {};
const present = (manifest.cells ?? []).filter(cell => cell.state === 'present').length;

const catalog = {
  kind: 'road-discovery-national-derived-catalog',
  schemaVersion: 1,
  project: 'roadnaturalist',
  version: 'conus-2025-v1',
  region: {
    id: manifest.region?.id ?? 'conus-2025',
    name: 'Conterminous United States',
    version: manifest.region?.version ?? null,
    bounds: manifest.region.bounds,
    publishedBounds: manifest.region.publishedBounds ?? manifest.region.bounds,
    bounded: false,
    note: 'The national derived corridor-metrics plane covers the conterminous states. Its cells are the only '
      + 'discovery payload: the raw national road, wetland and hydrography planes stay offline.',
  },
  grid: { kind: manifest.grid.kind, stepLon: manifest.grid.stepLon, stepLat: manifest.grid.stepLat,
    origin: manifest.grid.origin, crs: manifest.grid.crs },
  maxAnalysisDistanceM: 1000,
  assetBaseUrl: 'https://data.roadnaturalist.com/',
  derived: {
    manifestUrl: `${PREFIX}/${fingerprint}/manifest.json`,
    analysisFingerprint: fingerprint,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    manifestBytes: manifestBytes.length,
    derivedSchemaVersion: manifest.derivedSchemaVersion,
    profileVersion: manifest.profileVersion,
    cells: counts.cells,
    presentCells: present,
    emptyCells: counts.cells != null ? counts.cells - present : null,
    corridors: counts.corridors,
    storedRows: counts.storedRows,
    bytes: counts.bytes,
    note: 'The browser cannot recompute this fingerprint (it also covers the Python builder and its source '
      + 'digest), so the reviewed catalog pins it; the runtime still verifies the manifest digest, its profile '
      + 'and schema versions, its region and its columns, and fails closed otherwise.',
  },
  provenance: manifest.provenance ?? {},
  rollback: { catalogUrl: 'regional/manifest.json', version: 'or-sw-wa-portland-v3',
    note: 'The previous production discovery plane: a derived-first search that names no catalog, or a search '
      + 'area that still declares regional/manifest.json, resolves the regional derived plane again.' },
};

const text = `${JSON.stringify(catalog, null, 1)}\n`;
if (args.includes('--check')) {
  if (!existsSync(output)) { console.error(`The committed national catalog is missing: ${output}`); process.exit(1); }
  if (readFileSync(output, 'utf8') !== text) {
    console.error(`The committed national catalog is stale: regenerate it with node scripts/freeze-national-derived-catalog.mjs`);
    process.exit(1);
  }
  console.log(`National derived catalog is current: ${fingerprint}, ${present} present cells`);
} else {
  writeFileSync(output, text);
  console.log(`Wrote ${output}: fingerprint ${fingerprint}, ${present} present cells, ${counts.bytes?.toLocaleString()} bytes`);
}
