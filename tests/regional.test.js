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

const real = JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url)));
const empty = (id, bounds) => ({ id, bounds, state: 'empty', featureCount: 0 });
const synthetic = () => ({ schemaVersion: 2, project: 'roadnaturalist', version: 'fixture-v1',
  region: { bounds: [0, 0, 4, 2] }, grid: { kind: 'lonlat-grid', origin: [0, 0], stepLon: 2, stepLat: 2 }, maxAnalysisDistanceM: 1000,
  roadNameCells: { crossing: ['x0_y0', 'x1_y0'] }, roadNameBounds: { crossing: [0, 0, 4, 2] }, datasets: ['roads', 'wetlands', 'hydrography'].map(id => ({
    id, crs: 'EPSG:4326', format: 'GeoParquet', sourceDatasetId: id, source: { agency: 'fixture' },
    partitions: [empty('x0_y0', [0, 0, 2, 2]), empty('x1_y0', [2, 0, 4, 2])] })) });

test('real catalog declares validated versioned cells and stable source provenance', () => {
  assert.equal(validateRegionalCatalog(real), real);
  assert.deepEqual(real.datasets.map(dataset => dataset.id), ['roads', 'wetlands', 'hydrography']);
  assert.equal(real.datasets.every(dataset => dataset.partitions.length === 6), true);
  assert.equal(real.datasets.every(dataset => dataset.sourceDatasetId), true);
  assert.equal(real.build.replication, 'whole features intersecting cell');
  const missing = structuredClone(real);
  missing.datasets[1].partitions.pop();
  assert.throws(() => validateRegionalCatalog(missing), /omits a required regional cell/);
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

test('outside and edge searches retain NONE and PARTIAL instead of becoming fetch failures', async () => {
  const gis = createGisService({ regionalCatalog: synthetic() });
  await assert.rejects(gis.prepareRegionalSearch({ bbox: [5, 0.2, 6, 0.4] }), error => error.coverage === COVERAGE.NONE);
  await assert.rejects(gis.prepareRegionalSearch({ bbox: [0.001, 0.2, 0.2, 0.4] }), error => error.coverage === COVERAGE.PARTIAL);
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
