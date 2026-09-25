import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { composeRoadLines, DEFAULT_TOLERANCE_M, endpointGapM } from '../src/roads/normalize.js';
import { ROAD_ACCESS_STATUS, ROAD_GEOMETRY_STATUS, createRoad, groupRoadFeatures, roadEvidenceSummary } from '../src/roads/road.js';
import { buildPilotCandidates, candidateSummary, pilotRoadIds, validatePilot } from '../src/roads/pilot.js';
import { COVERAGE, COVERAGE_DATASET, createCandidate } from '../src/domain/corridor.js';
import { ATTRIBUTE_STATE } from '../src/domain/attributes.js';
import { summarizeRoadQuery } from '../src/gis/road-result.js';
import { summarizeLevel } from '../src/gis/ecoregion-result.js';
import { createGisService } from '../src/gis/service.js';
import { validateManifest } from '../src/services/manifest.js';
import { corridorWkt } from '../src/domain/geometry.js';

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/or-roads-pilot.snapshot.json', import.meta.url)));
const manifest = validateManifest(JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url))));
const declaration = JSON.parse(readFileSync(new URL('../data/roads/or-roads-pilot.json', import.meta.url)));
const dataset = manifest.datasets.find(item => item.id === 'or-roads-pilot');
const CORNELIUS_WA = 'tiger-2025-or-41067-nw-cornelius-pass-rd';
const SPRINGVILLE_MT = 'tiger-2025-or-41051-nw-springville-rd';
const SUSBAUER_WA = 'tiger-2025-or-41067-nw-susbauer-rd';
const provenance = { agency: dataset.source.agency, dataset: dataset.source.dataset, datasetVersion: dataset.version,
  vintage: dataset.source.vintage, publicationDate: dataset.source.publicationDate, referenceUrl: dataset.source.url,
  documentationUrl: dataset.source.documentationUrl, license: dataset.source.license, datasetDigest: dataset.sha256,
  retrievedAt: '2026-09-25T00:00:00.000Z', sourceCrs: 'EPSG:4269', geometryCrs: 'EPSG:4326',
  pipelineVersion: dataset.normalization.pipelineVersion, method: dataset.normalization.method,
  sources: [{ fips: '41067', url: dataset.source.urls['41067'], sha256: dataset.source.sha256['41067'] }] };

function snapshotRoad(roadId) {
  const road = snapshot.roads.find(entry => entry.roadId === roadId);
  assert.ok(road, `snapshot is missing ${roadId}`);
  return road;
}
function gisFeatures(roadIds) {
  return roadIds.flatMap(roadId => snapshotRoad(roadId).features.map(feature => ({
    roadId, name: snapshotRoad(roadId).name, roadClass: snapshotRoad(roadId).roadClass, routeType: snapshotRoad(roadId).routeType,
    countyFips: snapshotRoad(roadId).countyFips, countyName: snapshotRoad(roadId).countyName, sourceFeatureId: feature.sourceFeatureId,
    part: feature.part, geometry: { type: 'LineString', coordinates: feature.coordinates },
  })));
}
function realRoad(roadId) {
  const [group] = groupRoadFeatures(gisFeatures([roadId]));
  return createRoad(group, { provenance });
}
function fakeEngine({ onQuery }) {
  return async () => ({ db: { registerFileBuffer: async () => {} }, conn: { query: async sql => ({ toArray: () => onQuery(sql) }) } });
}
async function withRoadFetch(run) {
  const bytes = readFileSync(new URL(`../data/${dataset.url}`, import.meta.url));
  const original = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('or-roads-pilot') ? new Response(bytes) : Promise.reject(new Error(`unexpected fetch ${url}`));
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('road dataset manifest declares pinned TIGER/Line provenance and a matching digest', () => {
  assert.equal(dataset.type, 'road-centerlines');
  assert.equal(dataset.source.agency, 'U.S. Census Bureau');
  assert.match(dataset.source.dataset, /TIGER\/Line 2025 ROADS/);
  assert.match(dataset.source.url, /^https:\/\/www2\.census\.gov\/geo\/tiger\/TIGER2025\/ROADS\/tl_2025_41067_roads\.zip$/);
  assert.deepEqual(Object.keys(dataset.source.urls).sort(), ['41051', '41067']);
  for (const digest of Object.values(dataset.source.sha256)) assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(dataset.normalization.sourceCrs, 'EPSG:4269');
  assert.equal(dataset.normalization.crs, 'EPSG:4326');
  assert.match(dataset.normalization.method, /EPSG:4269 to EPSG:4326/);
  const bytes = readFileSync(new URL(`../data/${dataset.url}`, import.meta.url));
  assert.equal(bytes.byteLength, dataset.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), dataset.sha256);
  assert.ok(dataset.bytes < 1024 * 1024, 'the pilot road artifact stays small');
  assert.throws(() => validateManifest({ schemaVersion: 1, datasets: [{ ...dataset, roadCount: 0 }] }));
});

test('pilot source snapshot matches the declared road dataset', () => {
  assert.equal(snapshot.roads.length, dataset.roadCount);
  assert.equal(snapshot.roads.reduce((total, road) => total + road.features.length, 0), dataset.featureCount);
  assert.equal(snapshot.geometryCrs, 'EPSG:4326');
  assert.equal(snapshot.sourceCrs, 'EPSG:4269');
  for (const road of snapshot.roads) {
    const declared = dataset.scope.roads.find(entry => entry.id === road.roadId);
    assert.ok(declared, `manifest is missing ${road.roadId}`);
    assert.equal(declared.name, road.name);
    assert.equal(declared.sourceFeatureCount, road.sourceFeatureCount);
    assert.equal(declared.sourceFeatureCount, road.sourceFeatureIds.length);
    assert.ok(Math.abs(declared.sourceLengthM - road.sourceLengthM) < 0.01);
    assert.equal(road.features.every(feature => feature.coordinates.length >= 2), true);
    for (const feature of road.features) assert.match(feature.sourceFeatureId, /^\d{9,14}$/);
  }
  assert.deepEqual(pilotRoadIds(declaration).sort(), snapshot.roads.map(road => road.roadId).sort());
});

test('a real duplicated reverse link collapses into one connected road line', () => {
  const road = snapshotRoad(CORNELIUS_WA);
  const composed = composeRoadLines(road.features.map(feature => ({ sourceFeatureId: feature.sourceFeatureId, coordinates: feature.coordinates })));
  // TIGER/Line digitizes the same ~61 m junction link twice (features 1102965024601 and 1102965024654).
  assert.equal(composed.composition.sourceFeatureCount, 4);
  assert.equal(composed.composition.duplicatesRemoved, 0);
  assert.equal(composed.composition.collapsedReversedLinks, 1);
  assert.equal(composed.geometry.type, 'LineString');
  assert.equal(composed.composition.lineCount, 1);
  assert.equal(composed.composition.partCount, 1);
  assert.equal(composed.composition.maxResolvedGapM, null);
  assert.equal(composed.composition.maxUnresolvedGapM, null);
  assert.equal(composed.composition.toleranceM, DEFAULT_TOLERANCE_M);
  // The longer digitization is kept; the shorter reversed duplicate is dropped.
  const points = composed.geometry.coordinates.map(point => point.join(','));
  assert.ok(points.includes('-122.899396,45.558979'));
  assert.ok(!points.includes('-122.899343,45.55886'));
  assert.ok(Math.abs(composed.lengthM - road.uniqueSourceLengthM) / road.uniqueSourceLengthM < 0.005);
  assert.ok(Math.abs(composed.lengthM / 1609.344 - 5.65) < 0.02, `unexpected length ${composed.lengthM}`);
  const [minLon, minLat, maxLon, maxLat] = composed.bounds;
  assert.ok(minLon < maxLon && minLat < maxLat);
  assert.ok(minLon > -123.10 && maxLon < -122.70 && minLat > 45.50 && maxLat < 45.70);
});

test('a road split by real source gaps keeps visible parts instead of inventing geometry', () => {
  const road = snapshotRoad(SPRINGVILLE_MT);
  const composed = composeRoadLines(road.features.map(feature => ({ sourceFeatureId: feature.sourceFeatureId, coordinates: feature.coordinates })));
  assert.equal(composed.composition.sourceFeatureCount, 3);
  assert.equal(composed.geometry.type, 'MultiLineString');
  assert.equal(composed.composition.lineCount, 3);
  assert.equal(composed.composition.partCount, 2);
  assert.equal(composed.composition.gapsM.length, 1);
  assert.ok(Math.abs(composed.composition.gapsM[0] - 121.7) < 1, 'the 122 m junction gap stays a reported join');
  assert.ok(Math.abs(composed.composition.maxUnresolvedGapM - 246.4) < 1, 'the 246 m gap stays unresolved');
  // The composed length is measured with the domain's spherical haversine, the offline artifact
  // with EPSG:5070 meters; a small difference is expected, a large one would be a defect.
  assert.ok(Math.abs(composed.lengthM - road.uniqueSourceLengthM) / road.uniqueSourceLengthM < 0.005);
  assert.ok(Math.abs(composed.lengthM / 1609.344 - 3.93) < 0.02, `unexpected length ${composed.lengthM}`);
  const source = new Set(road.features.flatMap(feature => feature.coordinates.map(point => point.join(','))));
  for (const line of composed.geometry.coordinates) for (const point of line) assert.ok(source.has(point.join(',')), `invented vertex ${point}`);
});

test('composition is independent of source order and drops repeated or invalid vertices', () => {
  const road = snapshotRoad(CORNELIUS_WA);
  const forwards = composeRoadLines(road.features.map(feature => ({ sourceFeatureId: feature.sourceFeatureId, coordinates: feature.coordinates })));
  const backwards = composeRoadLines([...road.features].reverse().map(feature => ({ sourceFeatureId: feature.sourceFeatureId, coordinates: feature.coordinates })));
  assert.deepEqual(backwards.geometry, forwards.geometry);
  assert.equal(backwards.lengthM, forwards.lengthM);
  const cleaned = composeRoadLines([{ sourceFeatureId: 'x', coordinates: [[0, 0], [0, 0], [0, 1], null, [0, 1], [200, 95], [1, 0]] }]);
  assert.deepEqual(cleaned.geometry, { type: 'LineString', coordinates: [[0, 0], [0, 1], [1, 0]] });
  assert.equal(cleaned.composition.droppedFeatures, 0);
  assert.throws(() => composeRoadLines([{ sourceFeatureId: 'x', coordinates: [[0, 0]] }]));
  assert.throws(() => composeRoadLines([]));
  assert.ok(endpointGapM([[0, 0], [0, 0.01]], [[0, 0.0101], [0.01, 0.02]]) < 20);
});

test('road provenance and attribute states survive normalization', () => {
  const road = realRoad(CORNELIUS_WA);
  assert.equal(road.name, 'NW Cornelius Pass Rd');
  assert.equal(road.roadClass.state, ATTRIBUTE_STATE.KNOWN);
  assert.deepEqual(road.roadClass.value, { code: 'S1400', label: 'Local road' });
  assert.deepEqual(road.routeType.value, { code: 'M', label: 'Common name' });
  assert.equal(road.surface.state, ATTRIBUTE_STATE.NOT_PROVIDED);
  assert.equal(road.surface.value, null);
  assert.match(road.surface.note, /publishes no surface information/);
  assert.equal(road.access.state, ATTRIBUTE_STATE.UNKNOWN);
  assert.equal(road.access.value, null);
  assert.equal(road.county.name, 'Washington County, Oregon');
  assert.deepEqual(road.provenance.sourceFeatureIds, snapshotRoad(CORNELIUS_WA).sourceFeatureIds);
  assert.equal(road.provenance.organization, 'U.S. Census Bureau');
  assert.equal(road.provenance.datasetVersion, 'tiger-2025-v1');
  assert.equal(road.provenance.datasetDigest, dataset.sha256);
  assert.equal(road.provenance.sourceCrs, 'EPSG:4269');
  assert.equal(road.provenance.crs, 'EPSG:4326');
  assert.equal(road.provenance.normalization.toleranceM, DEFAULT_TOLERANCE_M);
  assert.equal(road.provenance.sourceArchives[0].sha256, dataset.source.sha256['41067']);
  assert.equal(road.evidence.geometry.status, ROAD_GEOMETRY_STATUS.VERIFIED);
  assert.equal(road.evidence.access.status, ROAD_ACCESS_STATUS.UNVERIFIED);
  assert.match(road.evidence.access.note, /not evidence of legal public access/);
  assert.equal(realRoad(SPRINGVILLE_MT).evidence.geometry.status, ROAD_GEOMETRY_STATUS.PARTIAL);
  assert.equal(roadEvidenceSummary([road]).geometry.label, 'GEOMETRY VERIFIED');
  assert.equal(roadEvidenceSummary([realRoad(SPRINGVILLE_MT)]).geometry.label, 'GEOMETRY PARTIAL');
  assert.throws(() => roadEvidenceSummary([]));
  assert.throws(() => createRoad({ roadId: 'x', name: 'y', features: [] }));
});

test('real source features become a candidate corridor with road provenance intact', () => {
  const declarationEntry = declaration.candidates.find(candidate => candidate.id === 'or-roads-cornelius-pass-rd');
  const roads = [realRoad(CORNELIUS_WA), realRoad('tiger-2025-or-41051-nw-cornelius-pass-rd')];
  const candidate = createCandidate({ ...declarationEntry, status: 'discovered', roads });
  assert.equal(candidate.corridor.roadCount, 2);
  assert.deepEqual(candidate.corridor.roadIds, [CORNELIUS_WA, 'tiger-2025-or-41051-nw-cornelius-pass-rd']);
  assert.equal(candidate.corridor.sourceFeatureCount, 5);
  assert.deepEqual(candidate.corridor.sourceCounties, ['Washington County, Oregon', 'Multnomah County, Oregon']);
  assert.equal(candidate.corridor.maxUnresolvedGapM, null);
  assert.equal(candidate.geometry.type, 'MultiLineString');
  assert.ok(Math.abs(candidate.corridor.lengthM / 1609.344 - 10.55) < 0.05, `unexpected length ${candidate.corridor.lengthM}`);
  assert.equal(candidate.coverage[COVERAGE_DATASET.ROAD_GEOMETRY].coverage, COVERAGE.UNKNOWN);
  assert.equal(candidate.access.status, 'UNVERIFIED');
  assert.match(candidate.access.note, /has not established public, legal, or practical access/);
  assert.throws(() => createCandidate({ ...declarationEntry, status: 'discovered', roads: [], geometry: null }));
});

test('the pilot declaration resolves into candidates and reports missing roads honestly', () => {
  const built = buildPilotCandidates(declaration, { coverage: COVERAGE.FULL, features: gisFeatures(pilotRoadIds(declaration)), provenance });
  assert.deepEqual(built.candidates.map(candidate => candidate.id), declaration.candidates.map(candidate => candidate.id));
  assert.equal(built.unresolved.length, 0);
  assert.equal(built.candidates[0].name, 'NW Cornelius Pass Rd');
  assert.match(built.candidates[0].summary, /^10\.5 mi · 2 roads · Washington County \/ Multnomah County$/);
  assert.match(built.candidates[1].summary, /3 geometry parts$/);
  assert.equal(built.candidates[0].coverage[COVERAGE_DATASET.ROAD_GEOMETRY].coverage, COVERAGE.FULL);
  assert.equal(built.candidates[0].coverage[COVERAGE_DATASET.ACCESS_VERIFICATION].coverage, COVERAGE.NONE);
  assert.equal(built.roadsByCandidate[built.candidates[2].id].length, 1);
  assert.equal(candidateSummary([realRoad(SUSBAUER_WA)]), '3.0 mi · 1 road · Washington County');
  const partial = buildPilotCandidates(declaration, { coverage: COVERAGE.PARTIAL, features: gisFeatures([SUSBAUER_WA]), provenance, reason: 'Missing road ids' });
  assert.equal(partial.candidates.length, 1);
  assert.equal(partial.unresolved.length, 2);
  assert.deepEqual(partial.unresolved[0].missingRoadIds, declaration.candidates[0].roadIds);
  assert.throws(() => validatePilot({ kind: 'road-candidate-pilot', datasetId: 'x', candidates: [{ id: 'a' }] }));
  assert.throws(() => validatePilot({ kind: 'other' }));
});

test('road coverage distinguishes failure, empty, and partial results', () => {
  const failed = summarizeRoadQuery({ requestedRoadIds: ['a'], reason: 'DuckDB Spatial initialization failed' });
  assert.equal(failed.coverage, COVERAGE.UNKNOWN);
  assert.equal(failed.missingRoadIds.length, 1);
  assert.match(failed.note, /not evidence that no roads exist/);
  const empty = summarizeRoadQuery({ requestedRoadIds: ['a', 'b'], foundRoadIds: [], featureCount: 0 });
  assert.equal(empty.coverage, COVERAGE.NONE);
  assert.match(empty.note, /bounded pilot extract/);
  const partial = summarizeRoadQuery({ requestedRoadIds: ['a', 'b'], foundRoadIds: ['a'], featureCount: 3 });
  assert.equal(partial.coverage, COVERAGE.PARTIAL);
  assert.deepEqual(partial.missingRoadIds, ['b']);
  assert.equal(summarizeRoadQuery({ requestedRoadIds: ['a'], foundRoadIds: ['a', 'a'], featureCount: 4 }).coverage, COVERAGE.FULL);
  assert.equal(summarizeRoadQuery({ bounded: true, featureCount: 0 }).coverage, COVERAGE.NONE);
  assert.equal(summarizeRoadQuery({ bounded: true, featureCount: 2 }).coverage, COVERAGE.FULL);
});


// The browser runs real DuckDB-WASM + Spatial (see tests/app.spec.js). These Node tests use the
// real checked-in artifact bytes, real SQL construction, and the real domain/GIS boundary.
async function withDataFetch(run) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => new Response(readFileSync(new URL(String(url))));
  try { return await run(); } finally { globalThis.fetch = original; }
}

function roadRowsFor(roadIds) {
  return snapshot.roads.filter(road => roadIds.includes(road.roadId)).flatMap(road => road.features.map(feature => ({
    road_id: road.roadId, name: road.name, road_class: road.roadClass, route_type: road.routeType,
    county_fips: road.countyFips, county_name: road.countyName, source_feature_id: feature.sourceFeatureId,
    part: feature.part, length_m: road.sourceLengthM / road.features.length,
    source_agency: dataset.source.agency, source_dataset: dataset.source.dataset, source_vintage: dataset.source.vintage,
    source_publication_date: dataset.source.publicationDate, source_url: dataset.source.urls[road.countyFips],
    source_archive_sha256: dataset.source.sha256[road.countyFips], source_crs: 'EPSG:4269', crs: 'EPSG:4326',
    pipeline_version: dataset.normalization.pipelineVersion, normalization: dataset.normalization.method,
    geometry_json: JSON.stringify({ type: 'LineString', coordinates: feature.coordinates }),
  })));
}

test('GIS service retrieves real road features through DuckDB with dataset provenance', async () => {
  const queries = [];
  await withDataFetch(async () => {
    const gis = createGisService({ manifest, engineFactory: fakeEngine({ onQuery: sql => { queries.push(sql); return roadRowsFor(pilotRoadIds(declaration)); } }) });
    const result = await gis.queryRoads({ roadIds: pilotRoadIds(declaration) });
    assert.equal(result.coverage, COVERAGE.FULL);
    assert.equal(result.features.length, dataset.featureCount);
    assert.equal(result.missingRoadIds.length, 0);
    assert.equal(result.provenance.agency, 'U.S. Census Bureau');
    assert.equal(result.provenance.datasetVersion, 'tiger-2025-v1');
    assert.equal(result.provenance.datasetDigest, dataset.sha256);
    assert.equal(result.provenance.sourceCrs, 'EPSG:4269');
    assert.deepEqual(result.provenance.sources.map(source => source.fips), ['41051', '41067']);
    assert.match(result.provenance.retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(result.diagnostics.status, 'ready');
    assert.equal(result.diagnostics.datasetBytes, dataset.bytes);
    const sql = queries[0];
    assert.match(sql, /FROM read_parquet\('or-roads-pilot\.parquet'\)/);
    assert.match(sql, /WHERE road_id IN \('/);
    assert.match(sql, /ST_AsGeoJSON\(geometry\) AS geometry_json/);
    assert.match(sql, /ORDER BY road_id, source_feature_id, part/);
    const single = await gis.getRoad(SUSBAUER_WA);
    assert.equal(single.roadFeatures.length, 1);
    assert.equal(single.roadFeatures[0].roadId, SUSBAUER_WA);
    assert.equal((await gis.getCoverage('or-roads-pilot', { roadIds: [SUSBAUER_WA] })).status, COVERAGE.FULL);
    assert.equal((await gis.getCoverage('or-roads-pilot', { type: 'LineString', coordinates: [[0, 0], [1, 1]] })).status, COVERAGE.UNKNOWN);
    const diagnostics = gis.diagnostics();
    assert.ok(Number.isFinite(diagnostics.firstRoadQueryMs) && Number.isFinite(diagnostics.lastRoadQueryMs));
    assert.ok(diagnostics.lastRoadQueryMs >= 0);
  });
});

test('a road query failure is UNKNOWN, never "no roads exist"', async () => {
  await withDataFetch(async () => {
    const gis = createGisService({ manifest, engineFactory: fakeEngine({ onQuery: () => { throw new Error('Spatial extension unavailable'); } }) });
    const result = await gis.queryRoads({ roadIds: [CORNELIUS_WA] });
    assert.equal(result.coverage, COVERAGE.UNKNOWN);
    assert.notEqual(result.coverage, COVERAGE.NONE);
    assert.equal(result.features.length, 0);
    assert.match(result.note, /not evidence that no roads exist/);
    assert.match(result.diagnostics.reason, /Spatial extension unavailable/);
    assert.equal((await gis.getCoverage('or-roads-pilot', { roadIds: [CORNELIUS_WA] })).status, COVERAGE.UNKNOWN);
    assert.equal(gis.diagnostics().error, 'Spatial extension unavailable');
  });
});


test('real pilot geometry flows into the EPA ecoregion query unchanged', async () => {
  const queries = [];
  await withDataFetch(async () => {
    const highway = [realRoad(CORNELIUS_WA), realRoad('tiger-2025-or-41051-nw-cornelius-pass-rd')];
    const candidate = createCandidate({ ...declaration.candidates[0], status: 'discovered', roads: highway });
    const wkt = corridorWkt(candidate.geometry);
    // Measured in EPSG:5070 by the offline pipeline for exactly this corridor (docs/ROADS.md).
    const routeLengthM = 16976.6;
    const intersections = {
      l3: [{ code: '3', name: 'Willamette Valley', overlap_m: 11476.8 }, { code: '1', name: 'Coast Range', overlap_m: 5499.8 }],
      l4: [{ code: '3c', name: 'Prairie Terraces', overlap_m: 9103.1 }, { code: '1d', name: 'Volcanics', overlap_m: 5499.8 },
        { code: '3d', name: 'Valley Foothills', overlap_m: 1935.6 }, { code: '3a', name: 'Portland/Vancouver Basin', overlap_m: 438.1 }],
    };
    const gis = createGisService({ manifest, engineFactory: fakeEngine({ onQuery: sql => {
      queries.push(sql);
      if (/AS length_m/.test(sql)) return [{ length_m: routeLengthM }];
      return /-l3\.parquet/.test(sql) ? intersections.l3 : intersections.l4;
    } }) });
    const result = await gis.getEcoregions(candidate.geometry);
    assert.equal(result.coverage, COVERAGE.FULL);
    assert.equal(result.level3.coverage, COVERAGE.FULL);
    assert.equal(result.level4.coverage, COVERAGE.FULL);
    assert.equal(result.level3.primary.name, 'Willamette Valley');
    assert.equal(result.level3.primary.percent, 67.6);
    assert.equal(result.level4.primary.name, 'Prairie Terraces');
    assert.equal(result.spansMultiple, true);
    assert.equal(result.provenance.sources.length, 2);
    assert.equal(result.provenance.sources[0].agency, 'U.S. Environmental Protection Agency');
    // The geometry the GIS layer received is the composed real corridor, not a synthetic line.
    assert.match(queries[0], /ST_GeomFromText\('MULTILINESTRING\(\(/);
    assert.ok(queries[0].includes(wkt.slice(0, 80)), 'the corridor WKT reaches SQL unchanged');
    const l3Sql = queries.find(sql => /-l3\.parquet/.test(sql));
    assert.match(l3Sql, /WHERE min_lon <= -122\.8515/);
    assert.match(l3Sql, /AND ST_Intersects\(geometry, ST_GeomFromText/);
    assert.equal(summarizeLevel(intersections.l3.map(row => ({ code: row.code, name: row.name, overlapM: row.overlap_m })), routeLengthM).coverage, COVERAGE.FULL);
  });
});

