#!/usr/bin/env node
/**
 * Opt-in live verification for the occurrence adapters.
 *
 *   npm run verify:occurrence:live
 *
 * This script is the only place that talks to the public occurrence APIs outside the browser.
 * Routine `npm test` never runs it and never needs a credential.
 *
 * iNaturalist: public read, no credentials, bounded to the same canonical queries the app uses.
 * eBird:       requires EBIRD_API_KEY. Without it the script prints SKIP for eBird and still exits 0.
 *              The key is read from the environment, sent only in the X-eBirdApiToken header, and is
 *              never printed, logged, or written to any artifact.
 */
import { readFileSync } from 'node:fs';
import { corridorGeometry } from '../src/domain/geometry.js';
import { createOccurrenceService } from '../src/occurrence/service.js';
import { OCCURRENCE_RADII_M, OCCURRENCE_SOURCE } from '../src/occurrence/model.js';
import { EBIRD_QUERY, EBIRD_RECENT_LIMIT_DAYS } from '../src/occurrence/ebird.js';

const ROOT = new URL('..', import.meta.url);
const readJson = path => JSON.parse(readFileSync(new URL(path, ROOT)));

function pilotCorridors() {
  const snapshot = readJson('tests/fixtures/or-roads-pilot.snapshot.json');
  const declaration = readJson('data/roads/or-roads-pilot.json');
  const byRoad = new Map(snapshot.roads.map(road => [road.roadId, road]));
  return declaration.candidates.map(candidate => {
    const lines = [];
    const seen = new Set();
    for (const roadId of candidate.roadIds) {
      for (const feature of byRoad.get(roadId).features) {
        const coordinates = feature.coordinates.map(point => [...point]);
        const key = JSON.stringify(coordinates);
        const reverse = JSON.stringify([...coordinates].reverse());
        if (seen.has(key) || seen.has(reverse)) continue;
        seen.add(key); seen.add(reverse);
        lines.push(coordinates);
      }
    }
    return { id: candidate.id, name: candidate.name, geometry: { type: 'MultiLineString', coordinates: lines } };
  });
}

async function inaturalistTransport(url, { timeoutMs, headers }) {
  const response = await fetch(url, { headers: { ...headers, 'User-Agent': 'roadnaturalist live verification' }, signal: AbortSignal.timeout(timeoutMs) });
  return response;
}

function ebirdTransportFromEnv() {
  const key = process.env.EBIRD_API_KEY;
  if (!key) return null;
  return async (url, { timeoutMs }) => {
    // The key travels in the documented header only; it is never part of the URL.
    const response = await fetch(url, { headers: { [ 'X-eBirdApiToken' ]: key, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`eBird HTTP ${response.status}`);
    return response.json();
  };
}

function log(prefix, message) { console.log(`${prefix.padEnd(12)} ${message}`); }

const corridors = pilotCorridors();
const service = createOccurrenceService({ inaturalistTransport, ebirdTransport: ebirdTransportFromEnv() });
const ebirdConfigured = Boolean(process.env.EBIRD_API_KEY);
console.log(`Live occurrence verification — ${corridors.length} pilot corridors, radii ${OCCURRENCE_RADII_M.join('/')} m`);
console.log(`eBird credential: ${ebirdConfigured ? 'EBIRD_API_KEY detected (value never printed)' : 'not set -> eBird will report SKIP'}`);

for (const corridor of corridors) {
  const geometry = corridorGeometry(corridor.geometry);
  const started = Date.now();
  const result = await service.analyze(corridor.geometry, { radiiM: OCCURRENCE_RADII_M, sources: [OCCURRENCE_SOURCE.INATURALIST, OCCURRENCE_SOURCE.EBIRD] });
  console.log(`\n=== ${corridor.id} (${geometry.lengthM.toFixed(0)} m corridor, bounds ${geometry.bounds.map(value => value.toFixed(4)).join(', ')}) ===`);
  const inat = result.sources.inaturalist;
  log('iNaturalist', `coverage ${inat.coverage} in ${result.diagnostics.queryMs} ms (this corridor: ${Date.now() - started} ms)`);
  if (inat.reason) log('iNaturalist', `reason: ${inat.reason}`);
  for (const region of inat.searchRegions ?? []) {
    log('  region', `+${region.radiusM / 1000} km: reported ${region.sourceReportedTotal}${region.allGradesTotal != null ? ` (all grades ${region.allGradesTotal})` : ''}; retrieved ${region.retrieved}${region.truncated ? ' [truncated]' : ''}${region.recordDetail ? '' : ' (record detail not requested for this region)'}`);
  }
  for (const window of inat.temporalCounts ?? []) log('  window', `${window.label}: reported ${window.sourceReportedTotal} in the outer search region`);
  log('  retrieved', `${inat.observations} records, ${inat.uniqueTaxa} unique taxa, ${inat.locationPrecision?.precise ?? 0} precisely located, ${inat.regionalOnlyObservations} regional-only (obscured/approximate/unavailable)`);
  for (const [radius, bucket] of Object.entries(inat.buckets ?? {})) log('  bucket', `<= ${Number(radius) / 1000} km: ${bucket.observations} observations, ${bucket.uniqueTaxa} taxa, nearest ${bucket.nearestM ?? 'n/a'} m`);
  log('  recency', Object.values(inat.recency ?? {}).map(entry => `${entry.label} ${entry.observations}`).join(' | '));
  log('  groups', (inat.groups ?? []).slice(0, 6).map(entry => `${entry.label} ${entry.observations}`).join(' | ') || 'none');
  const topTaxa = (inat.taxa ?? []).slice(0, 5).map(taxon => `${taxon.commonName ?? taxon.scientificName} (${taxon.observations})`).join(' | ');
  if (topTaxa) log('  taxa', topTaxa);

  const ebird = result.sources.ebird;
  if (!ebirdConfigured) {
    log('eBird', `SKIP — ${ebird.reason}`);
  } else if (ebird.coverage === 'UNKNOWN') {
    log('eBird', `UNKNOWN — ${ebird.reason}`);
  } else {
    log('eBird', `coverage ${ebird.coverage}: ${ebird.observations} recent reports, ${ebird.uniqueTaxa} species (last ${EBIRD_QUERY.daysBack} of ${EBIRD_RECENT_LIMIT_DAYS} max days, disk ${ebird.searchDisk?.distKm} km)`);
  }
}
console.log('\nThis script verifies the source adapters, normalization, privacy rules, and coverage. Corridor distances are measured in the browser run with DuckDB Spatial (src/gis/occurrence-query.js).');
