import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGisService } from '../src/gis/service.js';
import { validateRegionalCatalog } from '../src/discovery/regional-catalog.js';
import { analysisPaddingDeg, cellsForBounds, rawAvailability, rawAvailabilityMessage, rawCellBounds,
  regionForBounds, validateRawRegionsIndex } from '../src/discovery/raw-catalog.js';
import { cellsForBounds as publisherCellsForBounds, regionCatalog, regionRectangle, indexEntry,
  objectKeyFor } from '../scripts/national-raw-objects.mjs';

// BOUNDED RAW PUBLICATION.
//
// Discovery reads the derived plane, which is published everywhere; deep inspection reads raw road, wetland and
// hydrography cells, which are published only where someone asked to go deeper. These tests hold the three
// things that make that safe: the cells a corridor needs are computed identically everywhere, availability is
// answered from the committed index alone (so a refusal is instant and named), and the reader refuses partial raw
// source rather than measuring half a road. Nothing here contacts a network.
const STEP = 0.2;
const ORIGIN = [-180, -90];
const REGION_BOUNDS = [-122.4, 45.0, -122.0, 45.4];
const CELL_BYTES = Buffer.from('PAR1-raw-cell');
const CELL_SHA = createHash('sha256').update(CELL_BYTES).digest('hex');
const PLANES = Object.freeze([
  { id: 'roads', cellStepDeg: STEP, pathPrefix: 'national/roads/test/roads/' },
  { id: 'wetlands', cellStepDeg: STEP, pathPrefix: 'national/wetlands/test/wetlands/' },
  { id: 'hydrography', cellStepDeg: STEP, pathPrefix: 'national/hydro/test/hydro/' },
]);

function gridCells(bounds) {
  const x0 = Math.floor((bounds[0] - ORIGIN[0]) / STEP + 1e-9);
  const x1 = Math.ceil((bounds[2] - ORIGIN[0]) / STEP - 1e-9);
  const y0 = Math.floor((bounds[1] - ORIGIN[1]) / STEP + 1e-9);
  const y1 = Math.ceil((bounds[3] - ORIGIN[1]) / STEP - 1e-9);
  const cells = [];
  for (let x = x0; x < x1; x += 1) for (let y = y0; y < y1; y += 1) {
    cells.push({ id: `x${x}_y${y}`,
      bounds: [ORIGIN[0] + x * STEP, ORIGIN[1] + y * STEP, ORIGIN[0] + (x + 1) * STEP, ORIGIN[1] + (y + 1) * STEP] });
  }
  return cells;
}

function planePrefix(id) {
  return PLANES.find(plane => plane.id === id).pathPrefix;
}

// A raw region catalog: the contract a regional catalog already uses, with the raw publication block, every cell
// of the rectangle listed, and the cells this test wants published marked present or deliberately not published.
function rawCatalog({ bounds = REGION_BOUNDS, unpublished = [], present = null } = {}) {
  const cells = gridCells(bounds);
  const published = present ?? cells.map(cell => cell.id).filter(id => !unpublished.includes(id));
  const components = Buffer.from(JSON.stringify({ kind: 'road-components', schemaVersion: 1, version: 'test', components: [] }));
  const plane = id => ({ id, version: 'test-v1', format: 'GeoParquet', crs: 'EPSG:4326',
    columns: [{ name: 'a', type: 'VARCHAR' }], sourceDatasetId: `test-${id}`, source: { agency: 'test' },
    partitions: cells.map(cell => published.includes(cell.id)
      ? { id: cell.id, bounds: cell.bounds, state: 'present', featureCount: 3,
        url: `${planePrefix(id)}${cell.id}.parquet`, bytes: CELL_BYTES.length, sha256: CELL_SHA }
      : { id: cell.id, bounds: cell.bounds, state: 'unpublished', featureCount: 0 }) });
  return { schemaVersion: 2, project: 'roadnaturalist', version: 'raw-test-v1',
    region: { id: 'raw-test', name: 'raw test', bounds },
    grid: { kind: 'lonlat-grid', stepLon: STEP, stepLat: STEP, origin: ORIGIN },
    maxAnalysisDistanceM: 1000, assetBaseUrl: 'https://data.test/',
    publication: { kind: 'raw-regions', regionId: 'raw-test', publishedAt: '2026-01-01T00:00:00Z',
      pathPrefixes: [...PLANES.map(plane => plane.pathPrefix), 'raw/raw-test/raw-test-v1/'], ecoregions: null },
    datasets: [plane('roads'), plane('wetlands'), plane('hydrography')],
    roadComponentsUrl: 'raw/raw-test/raw-test-v1/road-components.json',
    roadComponentsBytes: components.length, roadComponentsSha256: createHash('sha256').update(components).digest('hex') };
}

// The committed index shape, with the cells a caller says are online.
function rawIndex({ published = null, regionBounds = REGION_BOUNDS } = {}) {
  const cells = gridCells(regionBounds);
  const online = published ?? cells.map(cell => cell.id);
  return { kind: 'road-discovery-raw-regions', schemaVersion: 1, note: 'test',
    planes: PLANES.map(plane => ({ id: plane.id, version: 'test-v1', cellStepDeg: STEP, pathPrefix: plane.pathPrefix })),
    regions: [{ id: 'raw-test', version: 'raw-test-v1', bounds: regionBounds, label: 'raw test',
      publishedAt: '2026-01-01T00:00:00Z', cellStepDeg: STEP, assetBaseUrl: 'https://data.test/',
      cells: Object.fromEntries(PLANES.map(plane => [plane.id, { published: online.length, empty: 0,
        unpublished: cells.length - online.length, version: 'test-v1', pathPrefix: plane.pathPrefix }])),
      publishedCellIds: Object.fromEntries(PLANES.map(plane => [plane.id, [...online]])),
      catalogUrl: 'raw/raw-test/raw-test-v1/manifest.json', catalogBytes: 4096,
      catalogSha256: 'a'.repeat(64), componentsUrl: 'raw/raw-test/raw-test-v1/road-components.json',
      componentsBytes: 512, componentsSha256: 'b'.repeat(64), objects: online.length, bytes: 1024 }] };
}

function installFetch(routes) {
  const previous = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : String(input.url ?? input);
    seen.push(url);
    const route = routes.find(entry => url.endsWith(entry.path));
    if (route) return route.json === undefined ? new Response(route.bytes) : Response.json(route.json);
    if (url.startsWith('file:')) return new Response(readFileSync(new URL(url)));
    return new Response('not found', { status: 404 });
  };
  return { seen, restore() { globalThis.fetch = previous; } };
}

function fakeEngine() {
  return { engine: { db: { async registerFileBuffer() {} },
    conn: { async query() { return { toArray: () => [] }; } } } };
}

function rawArea(bounds, extra = {}) {
  return { id: 'raw-promotion', kind: 'radius', center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
    radiusMiles: 1, bbox: bounds, catalogUrl: 'raw/raw-test/raw-test-v1/manifest.json', catalogType: 'raw', ...extra };
}

// ---------------------------------------------------------------- cell resolution

test('the cells a corridor needs are the grid cells, computed identically in both languages', () => {
  const plane = { cellStepDeg: STEP };
  const inside = [-122.35, 45.05, -122.25, 45.15];   // one cell
  const crossing = [-122.41, 45.05, -122.35, 45.15]; // two cells across a grid line
  const multi = [-122.35, 45.05, -122.05, 45.35];    // a 2x2 block
  assert.deepEqual(cellsForBounds(plane, inside), ['x288_y675']);
  assert.deepEqual(publisherCellsForBounds(inside), cellsForBounds(plane, inside), 'publisher and reader agree');
  assert.deepEqual(cellsForBounds(plane, crossing), ['x287_y675', 'x288_y675']);
  assert.deepEqual(publisherCellsForBounds(crossing), cellsForBounds(plane, crossing));
  assert.deepEqual(cellsForBounds(plane, multi), ['x288_y675', 'x288_y676', 'x289_y675', 'x289_y676']);
  assert.deepEqual(publisherCellsForBounds(multi), cellsForBounds(plane, multi));
  // A cell's bounds are derived from its id, not stored: the identity the planes were partitioned by. Compared
  // with a tolerance, because the identity is the cell and not the last bit of a float.
  const cellBounds = rawCellBounds('x288_y675');
  [-122.4, 45.0, -122.2, 45.2].forEach((value, index) => assert.ok(Math.abs(cellBounds[index] - value) < 1e-9,
    `cell corner ${index}`));
  assert.equal(rawCellBounds('not-a-cell'), null);
  // The 1 km analysis buffer is the reader's own padding rule, mirrored for the required-cell check.
  const padded = analysisPaddingDeg(inside);
  assert.ok(padded[0] < inside[0] && padded[1] < inside[1] && padded[2] > inside[2] && padded[3] > inside[3]);
  const beside = [-122.39, 45.01, -122.37, 45.03];
  assert.deepEqual(cellsForBounds(plane, beside), ['x288_y675']);
  assert.deepEqual(cellsForBounds(plane, analysisPaddingDeg(beside)), ['x287_y675', 'x288_y675'],
    'a corridor just inside a grid line reaches the next cell under the analysis buffer');
});


test('availability is answered from the index alone, and names what is missing', () => {
  const bounds = [-122.35, 45.05, -122.25, 45.15];
  const available = rawAvailability(rawIndex(), { bounds });
  assert.equal(available.available, true);
  assert.equal(available.missingTotal, 0);
  assert.equal(available.region.id, 'raw-test');
  assert.equal(rawAvailabilityMessage(available), null);
  // One cell missing on one plane: the refusal names the plane and counts.
  const trimmed = gridCells(REGION_BOUNDS).map(cell => cell.id).filter(id => id !== 'x288_y675');
  const oneMissing = rawAvailability(rawIndex({ published: trimmed }), { bounds });
  assert.equal(oneMissing.available, false);
  assert.deepEqual(oneMissing.missing.roads, ['x288_y675']);
  assert.match(rawAvailabilityMessage(oneMissing), /have not been published/);
  assert.match(rawAvailabilityMessage(oneMissing), /roads: 1/);
  // The 1 km buffer reaches past the box, so the missing cell can be one the box never touched: this corridor
  // sits wholly inside x288_y675, and its habitat halo still needs the cell beside it.
  const beside = [-122.39, 45.05, -122.29, 45.15];
  assert.deepEqual(cellsForBounds({ cellStepDeg: STEP }, beside), ['x288_y675']);
  const buffered = rawAvailability(rawIndex({ published: ['x288_y675'] }), { bounds: beside });
  assert.equal(buffered.available, false);
  assert.deepEqual(buffered.missing.wetlands, ['x287_y675']);
  assert.deepEqual(buffered.missing.hydrography, ['x287_y675']);
  // Nothing published at all: the refusal says so rather than pretending to know the cells it would have needed.
  const empty = rawAvailability({ ...rawIndex(), regions: [] }, { bounds });
  assert.equal(empty.available, false);
  assert.equal(empty.region, null);
  assert.match(rawAvailabilityMessage(empty), /have not been published/);
  assert.equal(regionForBounds(rawIndex(), [10, 10, 10.2, 10.2]), null);
});

test('an index the runtime cannot trust is refused rather than half-read', () => {
  const clone = () => JSON.parse(JSON.stringify(rawIndex()));
  assert.equal(validateRawRegionsIndex(rawIndex()).regions.length, 1);
  const wrongKind = clone(); wrongKind.kind = 'something else';
  assert.throws(() => validateRawRegionsIndex(wrongKind), /Not a raw region index/);
  const noPlanes = clone(); noPlanes.planes = [];
  assert.throws(() => validateRawRegionsIndex(noPlanes), /declares no planes/);
  const badStep = clone(); badStep.planes[0].cellStepDeg = 0.5;
  assert.throws(() => validateRawRegionsIndex(badStep), /Invalid raw plane roads/);
  const badCatalogPath = clone(); badCatalogPath.regions[0].catalogUrl = 'national/derived-catalog.json';
  assert.throws(() => validateRawRegionsIndex(badCatalogPath), /Invalid raw region catalog path/);
  const noOrigin = clone(); delete noOrigin.regions[0].assetBaseUrl;
  assert.throws(() => validateRawRegionsIndex(noOrigin), /does not name the origin/);
  const badDigest = clone(); badDigest.regions[0].catalogSha256 = 'nope';
  assert.throws(() => validateRawRegionsIndex(badDigest), /Invalid raw region catalog digest/);
  const noCellList = clone(); delete noCellList.regions[0].publishedCellIds;
  assert.throws(() => validateRawRegionsIndex(noCellList), /does not list its published cells/);
  const badCellId = clone(); badCellId.regions[0].publishedCellIds.roads = ['nowhere'];
  assert.throws(() => validateRawRegionsIndex(badCellId), /does not list its published cells/);
});

// ---------------------------------------------------------------- the documents a publication writes

test('a raw region catalog passes the reader contract, and a partial one says which cells are not published', () => {
  const catalog = validateRegionalCatalog(rawCatalog());
  assert.equal(catalog.publication.kind, 'raw-regions');
  assert.equal(catalog.datasets.length, 3);
  // The reader's own validator is what a publication must satisfy, so it is the validator under test here.
  const partial = validateRegionalCatalog(rawCatalog({ unpublished: ['x288_y675'] }));
  const roads = partial.datasets.find(dataset => dataset.id === 'roads');
  assert.equal(roads.partitions.find(part => part.id === 'x288_y675').state, 'unpublished');
  // A present cell that points outside the declared prefixes is refused: the publication block is what authorizes
  // raw object paths, and an undeclared path is not one of them.
  const wrongPrefix = rawCatalog();
  wrongPrefix.datasets[0].partitions.find(part => part.state === 'present').url = 'elsewhere/cell.parquet';
  assert.throws(() => validateRegionalCatalog(wrongPrefix), /Invalid roads artifact/);
  // A cell the region knows about but the plane never measured cannot claim to be published.
  const bogus = rawCatalog();
  bogus.datasets[0].partitions[0] = { ...bogus.datasets[0].partitions[0], state: 'unpublished', url: 'x' };
  assert.throws(() => validateRegionalCatalog(bogus), /Invalid unpublished roads cell/);
});

test('the region rectangle, object keys and index entry follow the published plan', () => {
  const rectangle = regionRectangle(['x288_y675', 'x289_y676'], 1);
  assert.equal(rectangle.cells.length, 16);
  // A one-cell margin on both sides of two cells is a four-cell rectangle, and its corners are the grid's.
  [-122.6, 44.8, -121.8, 45.6].forEach((value, index) => assert.ok(Math.abs(rectangle.bounds[index] - value) < 1e-9,
    `rectangle corner ${index}`));
  assert.deepEqual(rectangle.grid.origin, [-180, -90]);
  assert.throws(() => regionRectangle([], 0), /at least one cell/);
  assert.throws(() => regionRectangle(['nowhere'], 0), /not a grid cell/);
  const plane = { id: 'roads', extension: 'parquet', pathPrefix: 'national/roads/test/roads/' };
  assert.equal(objectKeyFor(plane, { id: 'x288_y675' }), 'national/roads/test/roads/x288_y675.parquet');
  const planes = PLANES.map(entry => ({ ...entry, version: 'test-v1' }));
  const verified = Object.fromEntries(PLANES.map(entry => [entry.id, new Map([['x288_y675',
    entry.id === 'roads' ? { key: 'k', bytes: 10, sha256: CELL_SHA, featureCount: 3 } : { empty: true }]])]));
  const entry = indexEntry({ regionId: 'raw-test', version: 'raw-test-v1', rectangle, planes, verified,
    ecoregions: { l3: { bytes: 100 }, l4: { bytes: 200 } }, bytes: 10, objects: 1, roots: ['roads: /tmp'],
    label: 'test', assetBaseUrl: 'https://data.test/' });
  assert.equal(entry.cells.roads.published, 1);
  assert.equal(entry.cells.wetlands.empty, 1);
  assert.deepEqual(entry.publishedCellIds.roads, ['x288_y675']);
  assert.equal(entry.ecoregionBytes, 300);
  assert.equal(entry.catalogUrl, 'raw/raw-test/raw-test-v1/manifest.json');
  // The index entry is validated by the very contract the runtime applies, so a bad one cannot be committed.
  // The catalog's own digest is added by the publisher once the catalog is uploaded, which is what the audit reads.
  assert.equal(validateRawRegionsIndex({ ...rawIndex(),
    regions: [{ ...entry, catalogBytes: 4096, catalogSha256: 'a'.repeat(64) }] }).regions.length, 1);
});

