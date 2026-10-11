import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DERIVED_KIND, derivedAvailability, selectDerivedCells, validateDerivedManifest } from '../src/discovery/derived-catalog.js';
import { derivedCorridor, derivedMetrics, derivedRelation, derivedUnit, queryDerivedCorridors } from '../src/gis/derived-query.js';
import { analysisFingerprint } from '../src/discovery/analysis-fingerprint.js';
import { validateRegionalCatalog } from '../src/discovery/regional-catalog.js';
import { buildDiscoveryUnits } from '../src/discovery/units.js';
import { segmentUnit } from '../src/discovery/segment.js';
import { radiusBounds } from '../src/discovery/search-area.js';
import { verifyDerivedPromotion, maxDriftM, PROMOTION_MAX_DRIFT_M } from '../src/discovery/promotion.js';
import { runDiscovery } from '../src/discovery/run.js';
import { filterResults, sortResults, DEFAULT_SORT } from '../src/discovery/filter.js';
import { COVERAGE } from '../src/domain/corridor.js';

// The derived corridor-metrics plane: the committed artifacts, the runtime reader, and the promotion gate.
//
// The plane is an index, not a second truth. These tests hold the two contracts that make that true: the
// published manifest must carry the fingerprint *the running code computes* (not a stored constant), and the
// runtime must read only the selected cells, dedupe them, keep the exact-radius semantics, and refuse a
// promotion it cannot reconstruct.
const MI = 1609.344;
const LON_PER_M = 1 / (111320 * Math.cos(45.5 * Math.PI / 180));
const catalog = validateRegionalCatalog(JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url))));
const manifestDocument = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url)));

function line(distanceM, { lon = -122.9, lat = 45.55, segments = 8 } = {}) {
  return Array.from({ length: segments + 1 }, (_, index) => [lon + distanceM * index / segments * LON_PER_M, lat]);
}

function derivedRow(overrides = {}) {
  const coordinates = line(2000);
  const lons = coordinates.map(point => point[0]);
  const lats = coordinates.map(point => point[1]);
  return { corridor_id: 'drv1-example-rd-s1', road_component_id: 'drv1-example-rd', road_unit_id: 'drv1-example-rd',
    name: 'NW Example Rd', normalized_name: 'nw example rd', length_m: 2000, road_classes: ['S1400'],
    county_names: ['Multnomah County, Oregon'], counties: ['41051'], road_ids: ['tiger-example'], source_feature_ids: ['1', '2'],
    segment_index: 1, segment_count: 1, geometry_repaired: false, geometry_repair_method: 'none',
    analysis_fingerprint: 'f'.repeat(64), primary_l3_code: '3', primary_l3_name: 'Willamette Valley', primary_l3_percent: 100,
    primary_l4_code: '3a', primary_l4_name: 'Portland/Vancouver Basin', primary_l4_percent: 100, l3_count: 1, l4_count: 1,
    transition_count: 0, ecology_coverage: COVERAGE.FULL, wetland_intersects: true, wetland_nearest_m: 12.5,
    wetland_area_250_m2: 10, wetland_area_500_m2: 20, wetland_area_1000_m2: 30, wetland_count_250: 1, wetland_count_500: 2,
    wetland_count_1000: 3, wetland_type_summary: 'Freshwater Emergent Wetland 30', hydro_crossing_count: 2,
    hydro_nearest_flowing_m: 0, hydro_nearest_standing_m: null, hydro_flowline_length_1000_m: 400,
    hydro_waterbody_area_1000_m2: 0, hydro_summary: 'Creek A | Creek B', coverage: COVERAGE.FULL,
    coverage_wetlands_250: COVERAGE.FULL, coverage_wetlands_500: COVERAGE.FULL, coverage_wetlands_1000: COVERAGE.FULL,
    coverage_hydro_250: COVERAGE.FULL, coverage_hydro_500: COVERAGE.FULL, coverage_hydro_1000: COVERAGE.FULL,
    min_lon: Math.min(...lons), min_lat: Math.min(...lats), max_lon: Math.max(...lons), max_lat: Math.max(...lats),
    geometry: { type: 'LineString', coordinates }, ...overrides };
}

// ---------------------------------------------------------------- committed artifacts

test('the committed derived plane carries the fingerprint the running code computes', async () => {
  assert.ok(catalog.derived, 'the published regional catalog must declare the derived corridor-metrics plane');
  const computed = await analysisFingerprint({ regionalCatalog: catalog, manifest: manifestDocument });
  assert.equal(catalog.derived.analysisFingerprint, computed.fingerprint,
    'the declared fingerprint must be the one this build computes from the published data plane');
  const profile = JSON.parse(readFileSync(new URL('../data/regional/analysis-profile.json', import.meta.url)));
  assert.equal(profile.fingerprint, computed.fingerprint);
  assert.equal(catalog.derived.manifestUrl, `derived/corridor-metrics/${computed.fingerprint}/manifest.json`);
});

test('the derived manifest declares one usable record per grid cell', () => {
  assert.ok(catalog.derived, 'the published regional catalog must declare the derived corridor-metrics plane');
  const manifest = validateDerivedManifest(JSON.parse(readFileSync(new URL(`../data/${catalog.derived.localPath}`, import.meta.url))));
  assert.equal(manifest.analysisFingerprint, catalog.derived.analysisFingerprint);
  assert.equal(manifest.region.bounded, false, 'the published plane covers the published region, not a sub-build');
  assert.equal(manifest.counts.cells, manifest.cells.length);
  assert.equal(manifest.counts.presentCells + manifest.counts.emptyCells, manifest.cells.length);
  assert.equal(manifest.counts.storedRows - manifest.counts.corridors, manifest.counts.replicatedRows);
  assert.ok(manifest.counts.corridors > 0);
  assert.ok(manifest.counts.storedRows >= manifest.counts.corridors, 'replicated rows are never fewer than corridors');
  const seen = new Set();
  for (const cell of manifest.cells) {
    assert.ok(!seen.has(cell.id), `${cell.id} is declared twice`);
    seen.add(cell.id);
    if (cell.state === 'empty') { assert.equal(cell.rowCount, 0); assert.equal(cell.url, undefined); continue; }
    assert.match(cell.url, new RegExp(`^derived/corridor-metrics/${manifest.analysisFingerprint}/cells/`));
    assert.match(cell.sha256, /^[a-f0-9]{64}$/);
    assert.ok(cell.bytes > 0 && cell.rowCount > 0);
    // The cells are served from R2, so a checkout may not hold every object; when it does, it must be the
    // declared object, because that digest is what the browser verifies before registering the buffer.
    const local = new URL(`../data/${cell.url}`, import.meta.url);
    if (!existsSync(local)) continue;
    const bytes = readFileSync(local);
    assert.equal(bytes.length, cell.bytes, `${cell.id} byte count disagrees with the manifest`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), cell.sha256, `${cell.id} digest disagrees with the manifest`);
  }
});

test('the declared derived plane stays compact and every row is accounted for', () => {
  assert.ok(catalog.derived, 'the published regional catalog must declare the derived corridor-metrics plane');
  const manifest = validateDerivedManifest(JSON.parse(readFileSync(new URL(`../data/${catalog.derived.localPath}`, import.meta.url))));
  const rows = manifest.cells.filter(cell => cell.state === 'present').reduce((total, cell) => total + cell.rowCount, 0);
  assert.equal(rows, manifest.counts.storedRows, 'the declared row count is the sum of the cells that hold rows');
  const average = manifest.counts.bytes / manifest.counts.storedRows;
  assert.ok(average < 4096, `a derived row should stay compact, measured ${Math.round(average)} bytes per row`);
  assert.ok(manifest.counts.bytes < 150 * 1024 * 1024, 'the whole derived plane must stay far below the raw partitions');
  assert.equal(manifest.derivedSchemaVersion, catalog.derived.derivedSchemaVersion);
});

// ---------------------------------------------------------------- the runtime reader

const CENTER = [-122.9, 45.55];
const RADIUS_AREA = { id: 'derived-radius', name: '1-mile radius', kind: 'radius', center: CENTER, radiusMiles: 1,
  catalogUrl: 'regional/manifest.json' };
const BBOX_AREA = { id: 'derived-box', name: 'Box search', catalogUrl: 'regional/manifest.json', bbox: [-122.95, 45.53, -122.85, 45.57] };

function scopeFor({ rows, bounds, coverage = COVERAGE.FULL, reason = null, fingerprint = 'f'.repeat(64), counts } = {}) {
  const calls = [];
  return { calls, scope: { derived: true, fingerprint,
    selection: Object.freeze({ coverage, reason, bounds, cells: [], present: [], bytes: counts?.bytes ?? 0,
      counts: counts ?? { cells: 2, present: 1, empty: 1 } }),
    manifest: { cells: 2, present: 1, empty: 1, counts: {} },
    timing: Object.freeze({ manifestMs: 1, selectionMs: 1, totalPreparationMs: 2, fetchMs: 1, verifyMs: 1,
      registerMs: 0, downloadedBytes: counts?.bytes ?? 0, cacheHits: 0, registeredCells: counts?.present ?? 1 }),
    provenance: Object.freeze({ source: 'Precomputed from verified regional GIS', analysisFingerprint: fingerprint }),
    async queryDerivedCorridors() { calls.push('queryDerivedCorridors'); return { rows, rowCount: rows.length, queryMs: 3 }; } } };
}

test('derived discovery keeps the radius disk: a corridor in the search box but outside the circle is not a result', async () => {
  const bounds = radiusBounds(CENTER, 1);
  const near = derivedRow({ corridor_id: 'drv1-near-rd-s1', name: 'Near Rd' });
  // The square-corner case: comfortably inside the bounding box the cells are selected with, and comfortably
  // outside the 1-mile disk. A search that returned it would be a square search wearing a radius label.
  const corner = derivedRow({ corridor_id: 'drv1-corner-rd-s1', name: 'Corner Rd',
    geometry: { type: 'LineString', coordinates: [[bounds[2] - 0.002, bounds[3] - 0.002], [bounds[2] - 0.001, bounds[3] - 0.001]] },
    min_lon: bounds[2] - 0.002, min_lat: bounds[3] - 0.002, max_lon: bounds[2] - 0.001, max_lat: bounds[3] - 0.001 });
  const { scope, calls } = scopeFor({ rows: [near, corner], bounds });
  const run = await runDiscovery({ gis: { async prepareDerivedSearch() { return scope; } }, searchArea: RADIUS_AREA });
  assert.equal(run.status, 'ready');
  assert.equal(run.derived, true);
  assert.deepEqual(calls, ['queryDerivedCorridors'], 'the scope is asked for its rows exactly once');
  assert.deepEqual(run.results.map(result => result.id), ['drv1-near-rd-s1']);
  assert.equal(run.diagnostics.searchShape.kind, 'radius');
  assert.equal(run.diagnostics.searchShape.radiusMiles, 1);
  assert.equal(run.diagnostics.derivedSelection.cells, scope.selection.counts);
  assert.equal(run.roadQuery.diagnostics.derived, true);
  assert.equal(run.roadQuery.coverage, COVERAGE.FULL);
});

test('a derived result is an ordinary discovery result: same blocks, filters and sorts', async () => {
  const rows = [derivedRow({ corridor_id: 'drv1-b-rd-s1', name: 'B Rd', length_m: 5000, wetland_area_250_m2: 5 }),
    derivedRow({ corridor_id: 'drv1-a-rd-s1', name: 'A Rd', length_m: 2500, wetland_area_250_m2: 50 })];
  const { scope } = scopeFor({ rows, bounds: BBOX_AREA.bbox });
  const run = await runDiscovery({ gis: { async prepareDerivedSearch() { return scope; } }, searchArea: BBOX_AREA });
  assert.equal(run.results.length, 2);
  const [result] = run.results;
  assert.equal(result.derived, true);
  assert.equal(result.derivedFingerprint, 'f'.repeat(64));
  assert.equal(result.signals.wetlands.area250M2, 5);
  assert.equal(result.road.classes.join(','), 'S1400');
  assert.equal(result.road.segmentation.index, 1);
  assert.equal(result.road.sourceFeatureCount, 2);
  assert.ok(Number.isFinite(result.signals.wetlands.area1000M2));
  assert.ok(Number.isFinite(result.signals.hydrography.crossingCount));
  assert.equal(result.signals.wetlands.nearestM, 12.5);
  assert.equal(result.signals.hydrography.flowlineLength1000M, 400);
  assert.ok(result.ecology.ecoregionCount >= 1, 'ecology reads the stored primary levels');
  assert.equal(result.coverage.wetlands.coverage, COVERAGE.FULL);
  const filtered = filterResults(run.results, { wetland: 'intersects', maxNearestWetlandM: 100 });
  assert.deepEqual(filtered.map(entry => entry.id).sort(), ['drv1-a-rd-s1', 'drv1-b-rd-s1']);
  const sorted = sortResults(run.results, DEFAULT_SORT);
  assert.deepEqual(sorted.map(entry => entry.id), ['drv1-a-rd-s1', 'drv1-b-rd-s1'], 'sorts read derived metric values');
});

test('a partial derived selection is reported as partial, and declared-empty cells are covered data', async () => {
  const rows = [derivedRow()];
  const { scope } = scopeFor({ rows, bounds: BBOX_AREA.bbox, coverage: COVERAGE.PARTIAL,
    reason: 'Search extends beyond the published derived coverage.', counts: { cells: 3, present: 1, empty: 2, bytes: 900 } });
  const run = await runDiscovery({ gis: { async prepareDerivedSearch() { return scope; } }, searchArea: BBOX_AREA });
  assert.equal(run.status, 'ready');
  assert.equal(run.coverage.coverage, COVERAGE.PARTIAL);
  assert.match(run.coverage.reason, /extends beyond the published derived coverage/);
  assert.equal(run.roadQuery.diagnostics.derived, true);
  assert.equal(run.roadQuery.diagnostics.reason, scope.selection.reason);
});

test('a derived result reports the repair provenance the row stores', async () => {
  const row = derivedRow({ corridor_id: 'drv1-repaired-rd-s1', geometry_repaired: true,
    geometry_repair_method: 'remove-duplicate-segments' });
  const { scope } = scopeFor({ rows: [row], bounds: BBOX_AREA.bbox });
  const run = await runDiscovery({ gis: { async prepareDerivedSearch() { return scope; } }, searchArea: BBOX_AREA });
  const [result] = run.results;
  assert.equal(result.provenance.geometryForAnalysis.repaired, true);
  assert.equal(result.provenance.geometryForAnalysis.method, 'remove-duplicate-segments');
  const plain = derivedMetrics(derivedRow());
  assert.equal(plain.geometryForAnalysis.repaired, false);
  assert.equal(plain.geometryForAnalysis.method, 'none');
});

test('a derived plane whose fingerprint does not match fails closed and never runs the raw regional search', async () => {
  let rawCalls = 0;
  const gis = {
    async prepareDerivedSearch() {
      const error = new Error('Precomputed discovery metrics were built for different analysis rules (analysis version mismatch), '
        + 'so they are not shown. The raw regional data is still available for a narrowed search.');
      error.derivedUnavailable = true;
      error.expected = 'a'.repeat(64);
      error.published = 'b'.repeat(64);
      throw error;
    },
    async queryRoadNetwork() { rawCalls += 1; return { features: [], coverage: COVERAGE.FULL }; },
    async analyzeDiscovery() { rawCalls += 1; return { corridors: {}, diagnostics: {} }; },
  };
  await assert.rejects(() => runDiscovery({ gis, searchArea: BBOX_AREA }), /analysis version mismatch/);
  assert.equal(rawCalls, 0, 'a clear error beats silently re-running the 90-second raw regional search');
});

test('a region with no published derived plane keeps the raw regional path it always had', async () => {
  const calls = [];
  const gis = {
    async prepareDerivedSearch() { calls.push('prepareDerivedSearch'); return null; },
    async prepareRegionalSearch() { calls.push('prepareRegionalSearch'); return null; },
    async queryRoadNetwork() { calls.push('queryRoadNetwork'); return { coverage: COVERAGE.FULL, features: [],
      provenance: { datasetId: 'or-roads-pilot' }, diagnostics: {} }; },
    async analyzeDiscovery() { calls.push('analyzeDiscovery'); return { corridors: {}, diagnostics: { datasetErrors: [] } }; },
  };
  const run = await runDiscovery({ gis, searchArea: { id: 'legacy', name: 'Legacy box', bbox: [-123.07, 45.505, -122.75, 45.67] } });
  assert.equal(run.status, 'ready');
  assert.deepEqual(calls, ['queryRoadNetwork', 'analyzeDiscovery'], 'a plain search area never asks for a regional catalog');
  assert.match(run.diagnostics.note, /once per dataset/);
});

test('derived discovery asks for no occurrence, eBird, Overpass or Investigator evidence', async () => {
  const requested = [];
  const original = globalThis.fetch;
  globalThis.fetch = async url => { requested.push(String(url)); throw new Error('the derived path must not fetch'); };
  try {
    const { scope } = scopeFor({ rows: [derivedRow()], bounds: BBOX_AREA.bbox });
    const run = await runDiscovery({ gis: { async prepareDerivedSearch() { return scope; } }, searchArea: BBOX_AREA });
    assert.equal(run.status, 'ready');
    assert.deepEqual(requested, []);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].access?.state ?? null, null, 'no access evidence is attached by discovery');
  } finally { globalThis.fetch = original; }
});

test('the derived reader deduplicates by corridor id in the query it issues', async () => {
  const statements = [];
  const engine = { conn: { async query(sql) { statements.push(sql);
    return { toArray: () => [{ corridor_id: 'a', geometry_json: '{}', counties: null, county_names: null, road_ids: null,
      road_classes: null, source_feature_ids: null }] }; } } };
  const result = await queryDerivedCorridors(engine, [`derived_${'a'.repeat(20)}.parquet`]);
  assert.match(statements[0], new RegExp(`read_parquet\\(\\['derived_${'a'.repeat(20)}\\.parquet'\\]\\)`));
  assert.match(statements[0], /row_number\(\) OVER \(PARTITION BY corridor_id\)/, 'replicated rows are deduplicated by corridor id');
  assert.match(statements[0], /WHERE rn = 1/);
  assert.equal(derivedRelation(['a.parquet', 'b.parquet']), "read_parquet(['a.parquet', 'b.parquet'])",
    'every selected cell is read as one relation, and dedupe happens after the union');
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0].counties, [], 'list columns are always arrays, never null');
});

// ---------------------------------------------------------------- promotion

const RAW_FEATURES = [{ roadId: 'tiger-2025-or-41051-example-rd', name: 'NW Example Rd', roadClass: 'S1400', routeType: 'M',
  countyFips: '41051', countyName: 'Multnomah County, Oregon', sourceFeatureId: 'f1', part: 1,
  geometry: { type: 'LineString', coordinates: line(3000) } }];

function rebuiltCorridor() {
  return segmentUnit(buildDiscoveryUnits(RAW_FEATURES).units[0]).corridors[0];
}

// THE IDENTITY A RECONSTRUCTION IS VERIFIED AGAINST IS SOURCE-GROUNDED, NOT THE BUILD'S ORDINAL.
//
// `drv1-<name>-c<N>` numbers a name's connected components across the whole nation, so a windowed read composes the
// same road under a different ordinal. These tests hold both halves: the same road verifies whatever ordinal it
// carries, and a row that is not the same road never verifies - by membership, by segmentation, or by geometry.

test('a reconstruction verifies by source identity even when the composed unit carries a different ordinal', () => {
  const corridor = rebuiltCorridor();
  // The row as the build wrote it: the same features, under a build-local component ordinal.
  const derived = { id: 'drv1-nw-example-rd-c226-s1', name: 'NW Example Rd', geometry: corridor.geometry,
    sourceFeatureIds: ['f1'], segmentIndex: 1, segmentCount: 1 };
  const verified = verifyDerivedPromotion({ derived, features: RAW_FEATURES });
  assert.equal(verified.corridor.id, corridor.id, 'the reconstructed corridor is returned, not the build id');
  assert.notEqual(verified.corridor.id, derived.id, 'the ordinal really did differ, as it does in production');
  assert.deepEqual(verified.sourceFeatureIds, ['f1']);
  assert.equal(verified.driftM, 0);
  assert.equal(verified.derivedId, derived.id, 'the build identity is kept beside the reconstruction');
});

test('a row with a missing source feature does not verify, however close the geometry is', () => {
  const corridor = rebuiltCorridor();
  assert.throws(() => verifyDerivedPromotion({ derived: { id: 'drv1-nw-example-rd-s1', geometry: corridor.geometry,
    sourceFeatureIds: ['f1', 'f2'], segmentIndex: 1, segmentCount: 1 }, features: RAW_FEATURES }),
  /does not compose the corridor this row describes/);
});

test('a row with an extra source feature does not verify', () => {
  const corridor = rebuiltCorridor();
  assert.throws(() => verifyDerivedPromotion({ derived: { id: 'drv1-nw-example-rd-s1', geometry: corridor.geometry,
    sourceFeatureIds: [], segmentIndex: 1, segmentCount: 1 }, features: RAW_FEATURES }),
  /carries no source feature identity/);
  assert.throws(() => verifyDerivedPromotion({ derived: { id: 'drv1-nw-example-rd-s1', geometry: corridor.geometry,
    sourceFeatureIds: ['f2'], segmentIndex: 1, segmentCount: 1 }, features: RAW_FEATURES }),
  /does not compose the corridor this row describes/);
});

test('a duplicated road name is disambiguated by source features, not by the name', () => {
  const near = { roadId: 'tiger-2025-or-41051-example-rd', name: 'NW Example Rd', roadClass: 'S1400', routeType: 'M',
    countyFips: '41051', countyName: 'Multnomah County, Oregon', sourceFeatureId: 'other-1', part: 1,
    geometry: { type: 'LineString', coordinates: line(3000).map(([lon, lat]) => [lon + 0.02, lat]) } };
  const features = [...RAW_FEATURES, near];
  const corridor = rebuiltCorridor();
  const units = buildDiscoveryUnits(features).units;
  assert.ok(units.length > 1, 'the same name really does compose more than one component here');
  // The row's own features select its own component, and the neighbouring same-named road is not it.
  const verified = verifyDerivedPromotion({ derived: { id: 'drv1-nw-example-rd-c9-s1', geometry: corridor.geometry,
    sourceFeatureIds: ['f1'], segmentIndex: 1, segmentCount: 1 }, features });
  assert.ok(verified.unit.sourceFeatureIds.map(String).includes('f1'));
  assert.ok(!verified.unit.sourceFeatureIds.map(String).includes('other-1'));
  // And a row claiming the other component's features does not verify against this geometry.
  assert.throws(() => verifyDerivedPromotion({ derived: { id: 'drv1-nw-example-rd-c9-s1', geometry: corridor.geometry,
    sourceFeatureIds: ['other-1'], segmentIndex: 1, segmentCount: 1 }, features }), /differs from the precomputed row/);
});

test('an ambiguous reconstruction fails closed instead of choosing a unit', () => {
  // Two identical features of one name in the same place compose one component, so ambiguity has to be built
  // deliberately: a row whose source set is satisfied by two composed units.
  const twin = { ...RAW_FEATURES[0], sourceFeatureId: 'twin-1' };
  const doubled = [RAW_FEATURES[0], { ...RAW_FEATURES[0], sourceFeatureId: 'f1b' }];
  const units = buildDiscoveryUnits(doubled).units;
  assert.equal(units.length, 1, 'the doubled features compose one unit — ambiguity needs a different construction');
  assert.throws(() => verifyDerivedPromotion({ derived: { id: 'drv1-nw-example-rd-s1',
    geometry: rebuiltCorridor().geometry, sourceFeatureIds: ['f1', 'f1b'], segmentIndex: 1, segmentCount: 1 },
    features: doubled }), /differs from the precomputed row|does not compose/);
  void twin;
});

test('a segment the composed road does not have fails verification', () => {
  const corridor = rebuiltCorridor();
  assert.throws(() => verifyDerivedPromotion({ derived: { id: 'drv1-nw-example-rd-s2', geometry: corridor.geometry,
    sourceFeatureIds: ['f1'], segmentIndex: 2, segmentCount: 2 }, features: RAW_FEATURES }),
  /segment 2|segment\(s\)/);
});

test('the same road verifies from a window that renumbers its components (the production failure, reproduced)', () => {
  // The build composes every name across the nation and numbers that name's components in order. A window composes
  // far fewer features, so the same road lands under a different ordinal - exactly what gave `drv1-river-rd-c226-s1`
  // an id that a promotion of the same road could not find. Here the full set holds the road alone (no ordinal at
  // all) and the window holds it beside two other same-named components, which renumbers it.
  const others = [1, 5].map((step, index) => ({ ...RAW_FEATURES[0], sourceFeatureId: `other-${index + 1}`,
    geometry: { type: 'LineString', coordinates: line(3000).map(([lon, lat]) => [lon + 0.05 * step, lat]) } }));
  const windowFeatures = [...RAW_FEATURES, ...others];
  const full = buildDiscoveryUnits(RAW_FEATURES).units[0];
  const windowed = buildDiscoveryUnits(windowFeatures).units;
  assert.equal(full.id, 'drv1-nw-example-rd', 'composed alone, the road needs no component ordinal');
  const promoted = windowed.filter(unit => unit.sourceFeatureIds.map(String).includes('f1'));
  assert.equal(promoted.length, 1, 'exactly one composed component holds the road this row describes');
  assert.equal(promoted[0].id, 'drv1-nw-example-rd-c1', 'in this window the same road is component 1 of 3');
  assert.notEqual(promoted[0].id, full.id, 'the ordinal really did change, which is why an id comparison failed');
  // The build's row - the id it published, and the identity it really describes.
  const row = { id: full.id + '-s1', name: 'NW Example Rd', geometry: segmentUnit(full).corridors[0].geometry,
    sourceFeatureIds: ['f1'], segmentIndex: 1, segmentCount: 1 };
  const verified = verifyDerivedPromotion({ derived: row, features: windowFeatures });
  assert.equal(verified.corridor.id, 'drv1-nw-example-rd-c1-s1');
  assert.notEqual(verified.corridor.id, row.id, 'reconstruction is verified by source identity, not by the ordinal');
  assert.deepEqual(verified.unit.sourceFeatureIds.map(String), ['f1'], 'the road was selected, not a neighbour');
  assert.equal(verified.driftM, 0);
});

test('promotion reconstructs the raw corridor and verifies its identity and geometry', () => {
  const corridor = rebuiltCorridor();
  const derived = { id: corridor.id, geometry: corridor.geometry, sourceFeatureIds: ['f1'],
    segmentIndex: 1, segmentCount: 1 };
  const verified = verifyDerivedPromotion({ derived, features: RAW_FEATURES });
  assert.equal(verified.corridor.id, derived.id);
  assert.equal(verified.driftM, 0);
  assert.equal(verified.features.length, 1);
  assert.equal(verified.unit.id, 'drv1-nw-example-rd');
  assert.equal(PROMOTION_MAX_DRIFT_M, 1, 'the acceptance tolerance is a metre, not a rounding of convenience');
});

test('promotion refuses a derived row whose geometry the raw network does not reproduce', () => {
  const corridor = rebuiltCorridor();
  const shifted = { type: 'LineString', coordinates: corridor.geometry.coordinates.map(([lon, lat]) => [lon + 0.001, lat]) };
  assert.ok(maxDriftM(shifted, corridor.geometry) > 50, 'the shifted corridor really is far enough apart to matter');
  assert.throws(() => verifyDerivedPromotion({ derived: { id: corridor.id, geometry: shifted, sourceFeatureIds: ['f1'],
    segmentIndex: 1, segmentCount: 1 }, features: RAW_FEATURES }),
    /the raw corridor differs from the precomputed row/);
});

test('promotion refuses a truncated precomputed corridor even when every cached point lies on the raw line', () => {
  const corridor = rebuiltCorridor();
  const short = { type: 'LineString', coordinates: corridor.geometry.coordinates.slice(0, 2) };
  assert.throws(() => verifyDerivedPromotion({ derived: { id: corridor.id, geometry: short, sourceFeatureIds: ['f1'],
    segmentIndex: 1, segmentCount: 1 }, features: RAW_FEATURES }),
    /the raw corridor differs from the precomputed row/);
});

test('promotion refuses a row whose source features this window does not compose', () => {
  assert.throws(() => verifyDerivedPromotion({ derived: { id: 'drv1-not-in-this-window-s1', geometry: rebuiltCorridor().geometry,
    sourceFeatureIds: ['not-here-1'], segmentIndex: 1, segmentCount: 1 }, features: RAW_FEATURES }),
  /does not compose the corridor this row describes/);
});

test('promotion verification refuses to run without the precomputed row it is checking', () => {
  assert.throws(() => verifyDerivedPromotion({ derived: null, features: RAW_FEATURES }), /needs the precomputed corridor row/);
});
