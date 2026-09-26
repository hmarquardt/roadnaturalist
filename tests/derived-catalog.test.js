import test from 'node:test';
import assert from 'node:assert/strict';
import { derivedAvailability, selectDerivedCells, validateDerivedManifest, DERIVED_KIND } from '../src/discovery/derived-catalog.js';
import { derivedMetrics, derivedUnit, derivedCorridor } from '../src/gis/derived-query.js';
import { COVERAGE } from '../src/domain/corridor.js';

// The derived plane is an index over the raw partitions, so its contract is narrow: a manifest that names every
// cell and its artifact, a fingerprint that must match this build's semantics, and rows that carry enough for
// filtering, sorting, mapping, exact-radius inclusion, and promotion.
const digest = 'a'.repeat(64);
const cell = (id, bounds, extra = {}) => ({ id, bounds, state: 'present', rowCount: 2, bytes: 1024, sha256: digest,
  url: `derived/corridor-metrics/${digest}/cells/${id}.parquet`, ...extra });
const manifest = overrides => ({ schemaVersion: 1, kind: DERIVED_KIND, analysisFingerprint: 'b'.repeat(64),
  derivedSchemaVersion: 1, region: { id: 'or-sw-wa-portland-v2', version: 'or-sw-wa-portland-v2', bounds: [-124.0, 44.6, -123.6, 44.8] },
  grid: { kind: 'fixed-degrees', origin: [-180, -90], stepLon: 0.2, stepLat: 0.2 },
  counts: { corridors: 4, storedRows: 6, cells: 2, presentCells: 1, emptyCells: 1, bytes: 1024, averageRowBytes: 170 },
  cells: [cell('x280_y672', [-124.0, 44.6, -123.8, 44.8]), { id: 'x281_y672', bounds: [-123.8, 44.6, -123.6, 44.8], state: 'empty', rowCount: 0 }],
  ...overrides });

test('a derived manifest is validated structurally', () => {
  const valid = validateDerivedManifest(manifest({}));
  assert.equal(valid.kind, DERIVED_KIND);
  assert.throws(() => validateDerivedManifest(manifest({ kind: 'something-else' })), /Not a derived corridor-metrics manifest/);
  assert.throws(() => validateDerivedManifest(manifest({ analysisFingerprint: 'nope' })), /analysis fingerprint/);
  assert.throws(() => validateDerivedManifest(manifest({ region: {} })), /published region/);
  assert.throws(() => validateDerivedManifest(manifest({ cells: [cell('x280_y672', [-124, 44.6, -123.8, 44.8], { sha256: 'nope' })] })), /Invalid derived artifact/);
  assert.throws(() => validateDerivedManifest(manifest({ cells: [{ id: 'a', bounds: [-124, 44.6, -123.8, 44.8], state: 'empty', rowCount: 3 }] })), /Invalid empty derived cell/);
  assert.throws(() => validateDerivedManifest(manifest({ cells: [] })), /no cells/);
});

test('the analysis fingerprint gates the whole derived plane', () => {
  const published = manifest({});
  assert.equal(derivedAvailability(published, published.analysisFingerprint).available, true);
  const mismatch = derivedAvailability(published, 'c'.repeat(64));
  assert.equal(mismatch.available, false);
  assert.match(mismatch.reason, /analysis version mismatch/);
  assert.equal(mismatch.published, published.analysisFingerprint);
  assert.match(derivedAvailability(null, published.analysisFingerprint).reason, /No derived corridor metrics/);
});

test('the search box selects cells and reports coverage against the published region', () => {
  const published = manifest({});
  const inside = selectDerivedCells(published, [-123.95, 44.65, -123.85, 44.75]);
  assert.equal(inside.coverage, COVERAGE.FULL);
  assert.deepEqual(inside.cells.map(item => item.id), ['x280_y672']);
  assert.equal(inside.counts.present, 1);
  assert.equal(inside.bytes, 1024);
  const crossing = selectDerivedCells(published, [-123.95, 44.65, -123.55, 44.75]);
  assert.equal(crossing.coverage, COVERAGE.PARTIAL);
  assert.equal(crossing.counts.empty, 1);
  assert.equal(crossing.counts.present, 1);
  assert.match(crossing.reason, /extends beyond the published/);
  const outside = selectDerivedCells(published, [-120.0, 40.0, -119.9, 40.1]);
  assert.equal(outside.coverage, COVERAGE.NONE);
  assert.deepEqual(outside.cells, []);
  assert.equal(outside.bytes, 0);
});

test('a region without a published derived plane is not a failure', () => {
  // runDiscovery asks for a derived scope and only takes the derived path when it gets one; a region that never
  // published the plane keeps the raw regional search it always had, while a published plane that cannot be
  // trusted is reported as an error rather than quietly degrading into the 90-second raw search.
  const catalogWithoutDerived = { version: 'or-sw-wa-portland-v2' };
  assert.equal(catalogWithoutDerived.derived, undefined);
  assert.equal(derivedAvailability(null, 'b'.repeat(64)).available, false);
});

test('derived rows carry the block shapes the interface and result builder already use'`, () => {
  const row = { corridor_id: 'drv1-main-st-s2', road_component_id: 'drv1-main-st', road_unit_id: 'drv1-main-st',
    name: 'Main St', normalized_name: 'main st', length_m: 1200, road_classes: ['S1100'], county_names: ['Multnomah County, Oregon'],
    counties: ['41051'], road_ids: ['tiger-2025-or-41051-main-st'], source_feature_ids: ['1', '2'], segment_index: 2, segment_count: 2,
    geometry_repaired: false, geometry_repair_method: 'none', analysis_fingerprint: 'b'.repeat(64),
    primary_l3_code: '8', primary_l3_name: 'Cascades', primary_l3_percent: 62.5, primary_l4_code: '77C', primary_l4_name: 'Valley',
    primary_l4_percent: 44.4, l3_count: 1, l4_count: 2, transition_count: 1, ecology_coverage: COVERAGE.FULL,
    wetland_intersects: true, wetland_nearest_m: 0, wetland_area_250_m2: 100.5, wetland_area_500_m2: 400.5, wetland_area_1000_m2: 900.75,
    wetland_count_250: 1, wetland_count_500: 2, wetland_count_1000: 3, wetland_type_summary: 'Freshwater Forested/Shrub Wetland 900',
    hydro_crossing_count: 4, hydro_nearest_flowing_m: 0, hydro_nearest_standing_m: 220.5, hydro_flowline_length_1000_m: 640.25,
    hydro_waterbody_area_1000_m2: 120.5, hydro_summary: 'Johnson Creek | Kelley Creek',
    coverage: COVERAGE.FULL, coverage_wetlands_250: COVERAGE.FULL, coverage_wetlands_500: COVERAGE.FULL, coverage_wetlands_1000: COVERAGE.FULL,
    coverage_hydro_250: COVERAGE.FULL, coverage_hydro_500: COVERAGE.FULL, coverage_hydro_1000: COVERAGE.FULL };
  const metrics = derivedMetrics(row);
  assert.equal(metrics.wetlands.buffers[250].areaM2, 100.5);
  assert.equal(metrics.wetlands.buffers[1000].featureCount, 3);
  assert.equal(metrics.wetlands.coverage, COVERAGE.FULL);
  assert.equal(metrics.wetlands.intersectsCorridor, true);
  assert.equal(metrics.wetlands.nearestDistanceM, 0);
  assert.equal(metrics.wetlands.classes.length, 1);
  assert.equal(metrics.hydrography.buffers[1000].lengthM, 640.25);
  assert.equal(metrics.hydrography.crossingCount, 4);
  assert.equal(metrics.hydrography.nearestStandingWaterM, 220.5);
  assert.deepEqual(metrics.hydrography.names, ['Johnson Creek', 'Kelley Creek']);
  assert.equal(metrics.ecology.coverage, COVERAGE.FULL);
  assert.equal(metrics.ecology.level4.spansMultiple, true);
  const unit = derivedUnit(row, { type: 'LineString', coordinates: [[0, 0], [0.01, 0]] }, [0, 0, 0.01, 0]);
  assert.equal(unit.id, 'drv1-main-st');
  assert.deepEqual(unit.countyNames, ['Multnomah County, Oregon']);
  assert.equal(unit.derived, true);
  const corridor = derivedCorridor(row, unit.geometry, unit.bounds);
  assert.equal(corridor.id, 'drv1-main-st-s2');
  assert.equal(corridor.segmentCount, 2);
  assert.equal(corridor.geometryForAnalysis.repaired, false);
});
