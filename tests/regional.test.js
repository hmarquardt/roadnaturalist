import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { COVERAGE } from '../src/domain/corridor.js';
import { selectRegionalPartitions, validateRegionalCatalog } from '../src/discovery/regional-catalog.js';
import { createGisService } from '../src/gis/service.js';
import { buildDiscoveryUnits } from '../src/discovery/units.js';
import { segmentUnit } from '../src/discovery/segment.js';
import { regionalCorridorMetrics } from '../src/discovery/run.js';
import { validateManifest } from '../src/services/manifest.js';

// The published regional catalogs. manifest.json is the current (wider) region; the previous region stays
// published under its own name so the older measurements remain reproducible and its objects audit clean.
const manifest = validateManifest(JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url))));
const real = JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url)));
const previous = JSON.parse(readFileSync(new URL('../data/regional/manifest-or-portland-west-v1.json', import.meta.url)));
const empty = (id, bounds) => ({ id, bounds, state: 'empty', featureCount: 0 });
// A synthetic catalog that declares empty cells with the column schema a typed empty relation needs.
const SYNTHETIC_COLUMNS = [{ name: 'road_id', type: 'VARCHAR' }, { name: 'geometry', type: 'BLOB' }];
const synthetic = () => ({ schemaVersion: 2, project: 'roadnaturalist', version: 'fixture-v1',
  region: { bounds: [0, 0, 4, 2] }, grid: { kind: 'lonlat-grid', origin: [0, 0], stepLon: 2, stepLat: 2 }, maxAnalysisDistanceM: 1000,
  roadNameCells: { crossing: ['x0_y0', 'x1_y0'] }, roadNameBounds: { crossing: [0, 0, 4, 2] }, datasets: ['roads', 'wetlands', 'hydrography'].map(id => ({
    id, crs: 'EPSG:4326', format: 'GeoParquet', sourceDatasetId: id, source: { agency: 'fixture' }, columns: SYNTHETIC_COLUMNS,
    partitions: [empty('x0_y0', [0, 0, 2, 2]), empty('x1_y0', [2, 0, 4, 2])] })) });

test('every published catalog declares validated versioned cells and stable source provenance', () => {
  // Cell counts follow from each region's own bounds on the fixed 0.2 degree grid, so the assertion is
  // about the published window, not about a number someone typed once.
  const cellsFor = bounds => {
    const [x0, x1] = [Math.floor((bounds[0] + 180) / 0.2), Math.ceil((bounds[2] + 180) / 0.2)];
    const [y0, y1] = [Math.floor((bounds[1] + 90) / 0.2), Math.ceil((bounds[3] + 90) / 0.2)];
    return (x1 - x0) * (y1 - y0);
  };
  for (const catalog of [real, previous]) {
    assert.equal(validateRegionalCatalog(catalog), catalog);
    assert.deepEqual(catalog.datasets.map(dataset => dataset.id), ['roads', 'wetlands', 'hydrography']);
    const expected = cellsFor(catalog.region.bounds);
    assert.equal(catalog.datasets.every(dataset => dataset.partitions.length === expected), true,
      `${catalog.version} declares ${expected} cells per dataset`);
    assert.equal(catalog.datasets.every(dataset => dataset.sourceDatasetId), true);
    assert.equal(catalog.build.replication, 'whole features intersecting cell');
    const missing = structuredClone(catalog);
    missing.datasets[1].partitions.pop();
    assert.throws(() => validateRegionalCatalog(missing), /omits a required regional cell/);
  }
  // The wider window contains the previous one, and every committed benchmark radius plus its 1 km halo
  // fits inside it with room for cross-cell road continuity.
  const benchmarks = JSON.parse(readFileSync(new URL('../data/regional/benchmarks.json', import.meta.url)));
  assert.equal(benchmarks.region, real.version);
  for (const scenario of benchmarks.scenarios) assert.equal(scenario.fullyInsidePublishedRegion, true, scenario.id);
  const [minLon, minLat, maxLon, maxLat] = real.region.bounds;
  const [pMinLon, pMinLat, pMaxLon, pMaxLat] = previous.region.bounds;
  assert.ok(pMinLon >= minLon && pMinLat >= minLat && pMaxLon <= maxLon && pMaxLat <= maxLat,
    'the previous published window stays inside the wider one, so old measurements remain comparable');
});

test('the wider catalog covers two states and declares its own source windows', () => {
  const roads = real.datasets.find(dataset => dataset.id === 'roads');
  const wetlands = real.datasets.find(dataset => dataset.id === 'wetlands');
  const hydrography = real.datasets.find(dataset => dataset.id === 'hydrography');
  assert.ok(Object.keys(roads.source.sha256).length >= 20, 'every regional county archive is pinned');
  assert.ok(Object.keys(roads.source.sha256).some(fips => fips.startsWith('53')), 'Washington roads are pinned too');
  assert.ok(Object.keys(roads.source.sha256).some(fips => fips.startsWith('41')), 'Oregon roads are still pinned');
  assert.deepEqual(wetlands.source.states.map(entry => entry.state).sort(), ['OR', 'WA']);
  for (const entry of wetlands.source.states) assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.ok(hydrography.source.hu8.length >= 20, 'the wider window names every basin it reads');
  // Cell schema is declared so an all-empty selection can still produce a typed empty relation.
  for (const dataset of real.datasets) {
    assert.ok(dataset.columns.length > 5);
    assert.ok(dataset.columns.every(column => typeof column.name === 'string' && typeof column.type === 'string'));
    assert.ok(dataset.columns.some(column => column.name === 'geometry'));
  }
});

test('one cell, boundary, halo, outside and partial coverage select deterministically', () => {
  const catalog = synthetic();
  const one = selectRegionalPartitions(catalog, [0.4, 0.4, 0.5, 0.5]);
  assert.equal(one.coverage, COVERAGE.FULL);
  assert.deepEqual(one.partitions.roads.map(part => part.id), ['x0_y0', 'x1_y0'], 'road-name closure completes a cross-cell road');
  assert.deepEqual(one.partitions.wetlands.map(part => part.id), ['x0_y0']);
  const boundary = selectRegionalPartitions(catalog, [2, 0.5, 2.1, 0.6]);
  assert.deepEqual(boundary.partitions.wetlands.map(part => part.id), ['x0_y0', 'x1_y0']);
  const halo = selectRegionalPartitions(catalog, [1.995, 0.5, 1.996, 0.6]);
  assert.deepEqual(halo.partitions.hydrography.map(part => part.id), ['x0_y0', 'x1_y0']);
  assert.equal(selectRegionalPartitions(catalog, [5, 0.2, 6, 0.4]).coverage, COVERAGE.NONE);
  assert.equal(selectRegionalPartitions(catalog, [0.001, 0.2, 0.2, 0.4]).coverage, COVERAGE.PARTIAL);
});

test('missing and corrupt required partitions reject a regional search before any result', async () => {
  const catalog = synthetic();
  for (const dataset of catalog.datasets) dataset.partitions[0] = { id: 'x0_y0', bounds: [0, 0, 2, 2], state: 'present',
    featureCount: 1, url: 'regional/partitions/fixture-v1/roads/x0_y0.parquet', bytes: 3, sha256: '0'.repeat(64) };
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(createGisService({ regionalCatalog: catalog }).prepareRegionalSearch({ bbox: [0.2, 0.2, 0.3, 0.3] }), /HTTP 404/);
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    await assert.rejects(createGisService({ regionalCatalog: catalog }).prepareRegionalSearch({ bbox: [0.2, 0.2, 0.3, 0.3] }), /SHA-256 mismatch/);
  } finally { globalThis.fetch = oldFetch; }
});

test('a search that only partly overlaps the published region runs and reports PARTIAL', async () => {
  const service = () => createGisService({ manifest, regionalCatalog: synthetic() });
  // NONE still refuses: a search outside the published data has nothing to measure.
  await assert.rejects(service().prepareRegionalSearch({ bbox: [5, 0.2, 6, 0.4] }), error => error.coverage === COVERAGE.NONE);
  // PARTIAL now runs. Refusing it would hide every corridor the data does describe; pretending the
  // uncovered part is complete is what the coverage states exist to prevent.
  const scope = await service().prepareRegionalSearch({ bbox: [0.001, 0.2, 0.2, 0.4] });
  assert.equal(scope.selection.coverage, COVERAGE.PARTIAL);
  assert.match(scope.selection.reason, /leaves published regional coverage/);
});

test('an intentionally empty cell is a typed empty relation, never a failure or an UNKNOWN', async () => {
  // A cell the catalog declares valid-and-empty means the published source genuinely has nothing there.
  // That is a measured zero with the cell covered, not a missing artifact: no file is fetched at all.
  const catalog = synthetic();
  const scope = await createGisService({ manifest, regionalCatalog: catalog }).prepareRegionalSearch({ bbox: [0.2, 0.2, 0.3, 0.3] });
  assert.equal(scope.selection.counts.roads, 0);
  assert.equal(scope.selection.emptyCounts.roads, 2);
  assert.equal(scope.selection.bytes, 0);
  for (const dataset of catalog.datasets) {
    assert.ok(dataset.columns.length > 0, 'the catalog declares the column schema a typed empty relation needs');
  }
  // A catalog that declares no schema cannot invent one: an all-empty selection stays a failure, because
  // an untyped empty relation would silently answer "no roads" to every query.
  const noSchema = synthetic();
  for (const entry of noSchema.datasets) delete entry.columns;
  await assert.rejects(createGisService({ manifest, regionalCatalog: noSchema }).prepareRegionalSearch({ bbox: [0.2, 0.2, 0.3, 0.3] }),
    /declares no column schema/);
  // A cell declared present but missing from the data plane is a different state again: it fails.
  const missing = synthetic();
  for (const dataset of missing.datasets) dataset.partitions[0] = { ...dataset.partitions[0], state: 'present',
    featureCount: 1, url: `regional/partitions/fixture-v1/${dataset.id}/x0_y0.parquet`, bytes: 8, sha256: '0'.repeat(64) };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    await assert.rejects(createGisService({ manifest, regionalCatalog: missing }).prepareRegionalSearch({ bbox: [0.2, 0.2, 0.3, 0.3] }), /HTTP 404/);
  } finally { globalThis.fetch = oldFetch; }
});

test('a search that reaches the published source window reports road coverage PARTIAL', async () => {
  // The published window is a boundary, not a fact about the world: a named road that continues across it is
  // not published beyond it, so a corridor near the edge is not known to be the whole road. The rule flags
  // proximity to the edge, so a search well inside the same catalog stays FULL.
  const roadRow = { road_id: 'tiger-2025-or-41067-crossing-rd', name: 'Crossing', road_class: 'S1400', route_type: 'M',
    county_fips: '41067', county_name: 'Washington County, Oregon', source_feature_id: 'a', part: 1, length_m: 120,
    source_agency: 'U.S. Census Bureau', source_dataset: 'TIGER/Line 2025 ROADS', source_vintage: 'TIGER2025',
    source_publication_date: '2025-09-22', source_url: 'https://example.test', source_archive_sha256: 'a'.repeat(64),
    source_crs: 'EPSG:4269', crs: 'EPSG:4326', pipeline_version: 'road-network-extract-v1', normalization: 'test',
    geometry_json: JSON.stringify({ type: 'LineString', coordinates: [[0.1, 0.1], [0.2, 0.1]] }) };
  const engineFactory = async () => ({ db: { registerFileBuffer: async () => {} },
    conn: { query: async sql => ({ toArray: () => (sql.includes('ST_AsGeoJSON') ? [roadRow] : []) }) } });
  const service = catalog => createGisService({ manifest, regionalCatalog: catalog, engineFactory });
  const nearEdge = await service(synthetic()).prepareRegionalSearch({ bbox: [0.05, 0.05, 0.15, 0.15] });
  const edgeQuery = await nearEdge.queryRoadNetwork({});
  assert.equal(edgeQuery.coverage, COVERAGE.PARTIAL);
  assert.match(edgeQuery.reason, /reaches the edge of the published regional source window/);
  assert.equal(edgeQuery.sourceEdge, true);
  assert.ok(edgeQuery.sourceEdgeMarginDeg < 0.2);
  assert.equal(edgeQuery.features.length, 1, 'the road itself is still measured');
  const inside = await service(synthetic()).prepareRegionalSearch({ bbox: [1, 0.5, 1.6, 1.2] });
  const insideQuery = await inside.queryRoadNetwork({});
  assert.equal(insideQuery.coverage, COVERAGE.FULL);
  assert.ok(insideQuery.sourceEdgeMarginDeg > 0.2);
});

test('a verified-byte but malformed Parquet query remains UNKNOWN rather than zero roads', async () => {
  const catalog = synthetic();
  const payload = new Uint8Array([1, 2, 3]);
  const digest = createHash('sha256').update(payload).digest('hex');
  for (const dataset of catalog.datasets) dataset.partitions[0] = { id: 'x0_y0', bounds: [0, 0, 2, 2], state: 'present',
    featureCount: 1, url: `regional/partitions/fixture-v1/${dataset.id}/x0_y0.parquet`, bytes: 3, sha256: digest };
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => payload.buffer.slice(0) });
    const gis = createGisService({ regionalCatalog: catalog, manifest: { datasets: [] }, engineFactory: async () => ({
      db: { registerFileBuffer: async () => {} }, conn: { query: async () => { throw new Error('Invalid Parquet magic bytes'); } },
    }) });
    const scoped = await gis.prepareRegionalSearch({ bbox: [0.2, 0.2, 0.3, 0.3] });
    const result = await scoped.queryRoadNetwork();
    assert.equal(result.coverage, COVERAGE.UNKNOWN);
    assert.equal(result.features.length, 0);
    assert.match(result.reason, /Invalid Parquet/);
  } finally { globalThis.fetch = oldFetch; }
});

test('verified partitions are fetched and registered once per GIS session', async () => {
  const catalog = synthetic();
  const payload = new Uint8Array([1, 2, 3]);
  const digest = createHash('sha256').update(payload).digest('hex');
  for (const dataset of catalog.datasets) dataset.partitions[0] = { id: 'x0_y0', bounds: [0, 0, 2, 2], state: 'present',
    featureCount: 1, url: `regional/partitions/fixture-v1/${dataset.id}/x0_y0.parquet`, bytes: 3, sha256: digest };
  const oldFetch = globalThis.fetch;
  let fetches = 0;
  let registrations = 0;
  try {
    globalThis.fetch = async () => { fetches++; return { ok: true, arrayBuffer: async () => payload.buffer.slice(0) }; };
    const gis = createGisService({ regionalCatalog: catalog, manifest: { datasets: [] }, engineFactory: async () => ({
      db: { registerFileBuffer: async () => { registrations++; } }, conn: { query: async () => ({ toArray: () => [] }) },
    }) });
    const area = { bbox: [0.2, 0.2, 0.3, 0.3] };
    const first = await gis.prepareRegionalSearch(area);
    const second = await gis.prepareRegionalSearch(area);
    assert.equal(first.timing.downloadedBytes, 9);
    assert.equal(second.timing.downloadedBytes, 0);
    assert.equal(second.timing.cacheHits, 3);
    assert.equal(fetches, 3);
    assert.equal(registrations, 3);
  } finally { globalThis.fetch = oldFetch; }
});

test('a replicated boundary road composes once with stable canonical geometry and segment IDs', () => {
  const source = (id, coordinates) => ({ roadId: 'cross-boundary', name: 'Boundary Road', roadClass: 'S1400',
    sourceFeatureId: id, countyFips: '41067', countyName: 'Washington County, Oregon',
    geometry: { type: 'LineString', coordinates } });
  const west = source('a', [[-123.02, 45.55], [-123.00, 45.55]]);
  const east = source('b', [[-123.00, 45.55], [-122.98, 45.55]]);
  const expected = buildDiscoveryUnits([west, east]).units[0];
  const fromPartitions = buildDiscoveryUnits([west, west, east]).units[0];
  assert.equal(fromPartitions.id, expected.id);
  assert.deepEqual(fromPartitions.geometry, expected.geometry);
  assert.equal(fromPartitions.lengthM, expected.lengthM);
  assert.deepEqual(segmentUnit(fromPartitions).corridors.map(item => item.id), segmentUnit(expected).corridors.map(item => item.id));
});

test('a composed corridor extending past the search box carries PARTIAL habitat coverage', () => {
  const original = { wetlands: { coverage: COVERAGE.FULL, areaM2: 42 },
    hydrography: { coverage: COVERAGE.FULL, crossingCount: 2 } };
  const region = [-123.16, 45.46, -122.68, 45.73];
  assert.equal(regionalCorridorMetrics(original, [-123, 45.5, -122.9, 45.6], region), original);
  const edge = regionalCorridorMetrics(original, [-123.159, 45.5, -122.9, 45.6], region);
  assert.equal(edge.wetlands.coverage, COVERAGE.PARTIAL);
  assert.equal(edge.hydrography.coverage, COVERAGE.PARTIAL);
  assert.equal(edge.wetlands.areaM2, 42);
  assert.match(edge.wetlands.reason, /1 km habitat buffer/);
});

test('a regional road result reaching the feature limit is UNKNOWN rather than silently truncated', async () => {
  const gis = createGisService({ engineFactory: async () => ({ conn: { query: async () => ({ toArray: () => [{}, {}] }) } }) });
  const result = await gis.queryRoads({ datasetEntry: { id: 'fixture-roads', readExpression: 'fixture_roads',
    source: { agency: 'fixture' }, scope: { roads: [] } }, limit: 1 });
  assert.equal(result.coverage, COVERAGE.UNKNOWN);
  assert.deepEqual(result.features, []);
  assert.match(result.reason, /exceeds the 1 feature limit/);
});
