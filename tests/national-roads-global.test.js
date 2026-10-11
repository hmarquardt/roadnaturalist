import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createGisService } from '../src/gis/service.js';
import { validateRoadComponents } from '../src/discovery/components.js';
import { cellsForBounds, closureTileKeys, globalPlaneReady, rawAvailability, rawAvailabilityMessage,
  closureTileKey, validateRawRegionsIndex } from '../src/discovery/raw-catalog.js';
import { roadsPublicationSet, tileDocument, tileKey, tileKeyForBounds } from '../scripts/national-roads-publication.mjs';

// GLOBAL ROADS.
//
// The national road plane is published in full (5.82 GB, about 2% of the raw lake), so a promotion reads roads
// from the plane's own immutable namespace and can no longer be refused because a bounded region did not close
// over a road component. Wetlands and hydrography stay bounded. These tests hold the three properties that makes
// true: the declaration is version- and digest-aware, the reader takes roads from the global plane and not from
// the region, and a corridor whose component spans many cells is closed over in full.
const STEP = 0.2;
const ORIGIN = [-180, -90];
const BOUNDS = [-122.4, 45.0, -122.0, 45.4];
const ROAD_BYTES = Buffer.from('PAR1-global-road-cell');
const HABITAT_BYTES = Buffer.from('PAR1-bounded-habitat-cell');
const sha = buffer => createHash('sha256').update(buffer).digest('hex');

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

// A global roads publication for the fixture: one row of cells, plus a component that reaches one cell past the
// corridor's box. That is the case the bounded model used to refuse.
function roadsFixture({ componentCells = ['x288_y675', 'x287_y675', 'x286_y675'], tile = '57_135' } = {}) {
  // Every cell the reader's one-cell-margin selection can ask for, so the fixture publication is as complete as a
  // real one: the corridor box grown by one cell on each side.
  const box = [-122.79, 44.65, -121.89, 45.55];
  const x0 = Math.floor((box[0] + 180) / STEP);
  const x1 = Math.ceil((box[2] + 180) / STEP) - 1;
  const y0 = Math.floor((box[1] + 90) / STEP);
  const y1 = Math.ceil((box[3] + 90) / STEP) - 1;
  const cells = [];
  for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) {
    cells.push({ id: `x${x}_y${y}`, bounds: null, bytes: ROAD_BYTES.length, sha256: sha(ROAD_BYTES), featureCount: 7 });
  }
  const component = { id: 'drv1-test-rd-c1', nameKey: 'test rd', cells: componentCells, bounds: BOUNDS };
  const document = tileDocument(tile, [component]);
  const tileBytes = Buffer.from(JSON.stringify(document) + '\n');
  const publication = { kind: 'national-roads-publication', schemaVersion: 1, version: 'roads-test-v1',
    cellStepDeg: STEP, assetBaseUrl: 'https://data.test/', pathPrefix: 'national/roads/roads-test-v1/roads/',
    counts: { present: cells.length, empty: 0, cells: cells.length }, cells, emptyCells: [],
    closure: { cellSpan: 5, prefix: 'national/roads/roads-test-v1/components/',
      tiles: [{ key: tile, bytes: tileBytes.length, sha256: sha(tileBytes) }] } };
  const publicationBytes = Buffer.from(JSON.stringify(publication) + '\n');
  return { publication, publicationBytes, tileBytes, tile, component };
}

function globalEntry({ publication, publicationBytes, tile, tileBytes }) {
  return { version: publication.version, state: 'READY', cellStepDeg: STEP, pathPrefix: publication.pathPrefix,
    assetBaseUrl: publication.assetBaseUrl, presentCells: publication.counts.present, emptyCells: 0, gridCells: 3,
    objects: 3, bytes: 1024, publicationUrl: 'national/roads/roads-test-v1/publication.json',
    publicationBytes: publicationBytes.length, publicationSha256: sha(publicationBytes),
    closure: { cellSpan: 5, prefix: publication.closure.prefix, tiles: 1 }, auditedAt: '2026-01-01T00:00:00Z',
    audit: { cells: 3, remoteObjects: 3, missing: 0, sizeMismatch: 0, unexpected: 0, sampled: 1, seconds: 1 },
    note: 'test' };
}

function indexWith({ globalRoads = null, published = null } = {}) {
  const cells = gridCells(BOUNDS);
  const online = published ?? cells.map(cell => cell.id);
  const planes = [{ id: 'roads', version: 'roads-test-v1', cellStepDeg: STEP, pathPrefix: 'national/roads/roads-test-v1/roads/' },
    { id: 'wetlands', version: 'wetlands-bounded-v1', cellStepDeg: STEP, pathPrefix: 'national/wetlands/bounded-wetlands/' },
    { id: 'hydrography', version: 'hydrography-bounded-v1', cellStepDeg: STEP, pathPrefix: 'national/hydrography/bounded-hydrography/' }];
  return { kind: 'road-discovery-raw-regions', schemaVersion: 1, note: 'test',
    planes, globalPlanes: globalRoads ? { roads: globalRoads } : undefined,
    regions: [{ id: 'bounded-test', version: 'bounded-v1', bounds: BOUNDS, publishedAt: '2026-01-01T00:00:00Z',
      cellStepDeg: STEP, assetBaseUrl: 'https://data.test/', catalogUrl: 'raw/bounded-test/bounded-v1/manifest.json',
      catalogBytes: 4096, catalogSha256: 'a'.repeat(64), componentsUrl: 'raw/bounded-test/bounded-v1/road-components.json',
      componentsBytes: 512, componentsSha256: 'b'.repeat(64), objects: online.length, bytes: 1024,
      cells: Object.fromEntries(planes.map(plane => [plane.id, { published: online.length, empty: 0,
        unpublished: cells.length - online.length }])),
      publishedCellIds: Object.fromEntries(planes.map(plane => [plane.id, [...online]])) }] };
}

// A bounded region catalog: wetlands and hydrography present, and its own roads deliberately *not* published, so a
// successful promotion can only mean the roads came from the global plane.
const REGION_COMPONENTS = Buffer.from(JSON.stringify({ kind: 'road-components', schemaVersion: 1,
  version: 'bounded-v1', components: [] }));

function regionCatalog({ roadsPublished = false } = {}) {
  const cells = gridCells(BOUNDS);
  const components = REGION_COMPONENTS;
  const plane = (id, present) => ({ id, version: id === 'roads' ? 'roads-test-v1' : `${id}-bounded-v1`,
    format: 'GeoParquet', crs: 'EPSG:4326', columns: [{ name: 'a', type: 'VARCHAR' }],
    sourceDatasetId: `test-${id}`, source: { agency: 'test' },
    partitions: cells.map(cell => present
      ? { id: cell.id, bounds: cell.bounds, state: 'present', featureCount: 2,
        url: `${id === 'roads' ? 'national/roads/roads-test-v1/roads/' : `national/${id}/bounded-${id}/`}${cell.id}.parquet`,
        bytes: (id === 'roads' ? ROAD_BYTES : HABITAT_BYTES).length, sha256: sha(id === 'roads' ? ROAD_BYTES : HABITAT_BYTES) }
      : { id: cell.id, bounds: cell.bounds, state: 'unpublished', featureCount: 0 }) });
  return { schemaVersion: 2, project: 'roadnaturalist', version: 'bounded-v1', kind: 'road-raw-region',
    region: { id: 'bounded-test', name: 'bounded test', bounds: BOUNDS },
    grid: { kind: 'lonlat-grid', stepLon: STEP, stepLat: STEP, origin: ORIGIN },
    maxAnalysisDistanceM: 1000, assetBaseUrl: 'https://data.test/',
    publication: { kind: 'raw-regions', regionId: 'bounded-test', publishedAt: '2026-01-01T00:00:00Z',
      pathPrefixes: ['national/roads/roads-test-v1/roads/', 'national/wetlands/bounded-wetlands/',
        'national/hydrography/bounded-hydrography/', 'raw/bounded-test/bounded-v1/'],
      ecoregions: null },
    datasets: [plane('roads', roadsPublished), plane('wetlands', true), plane('hydrography', true)],
    roadComponentsUrl: 'raw/bounded-test/bounded-v1/road-components.json',
    roadComponentsBytes: components.length, roadComponentsSha256: sha(components) };
}

function installFetch(routes) {
  const previous = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : String(input.url ?? input);
    seen.push(url);
    const route = routes.find(entry => entry.match ? entry.match.test(url) : url.endsWith(entry.path));
    if (route) return route.json === undefined ? new Response(route.bytes) : Response.json(route.json);
    if (url.startsWith('file:')) return new Response(readFileSync(new URL(url)));
    return new Response('not found', { status: 404 });
  };
  return { seen, restore() { globalThis.fetch = previous; } };
}

function fakeEngine() {
  const registered = [];
  return { registered, engine: { db: { async registerFileBuffer(name, bytes) { registered.push({ name, bytes: bytes.length }); } },
    conn: { async query() { return { toArray: () => [] }; } } } };
}

function promotionArea(bounds, extra = {}) {
  return { id: 'raw-promotion', kind: 'radius', bbox: bounds, radiusMiles: 1,
    catalogUrl: 'raw/bounded-test/bounded-v1/manifest.json', catalogType: 'raw', ...extra };
}

// The corridor's box: one cell, x287_y675.
const CORRIDOR = [-122.39, 45.05, -122.29, 45.15];

// ---------------------------------------------------------------- the declaration

test('a global plane is declared completely, or is not an availability claim', () => {
  const fixture = roadsFixture();
  const entry = globalEntry(fixture);
  const index = indexWith({ globalRoads: entry });
  assert.equal(validateRawRegionsIndex(index).globalPlanes.roads.state, 'READY');
  assert.equal(globalPlaneReady(index, 'roads').version, 'roads-test-v1');
  // A different version is not this plane: the caller is told nothing rather than handed a substitute.
  assert.equal(globalPlaneReady(index, 'roads', 'tiger2025-county-v1'), null);
  assert.equal(globalPlaneReady(index, 'roads', 'roads-test-v1').state, 'READY');
  const clone = () => JSON.parse(JSON.stringify(index));
  for (const [mutate, pattern] of [
    [entry2 => { entry2.globalPlanes.roads.state = 'MAYBE'; }, /Invalid global plane state/],
    [entry2 => { delete entry2.globalPlanes.roads.publicationSha256; }, /global roads plane is not declared completely/],
    [entry2 => { entry2.globalPlanes.roads.publicationUrl = 'not-json'; }, /global roads plane is not declared completely/],
    [entry2 => { delete entry2.globalPlanes.roads.closure; }, /global roads plane is not declared completely/],
    [entry2 => { entry2.globalPlanes.wetlands = entry2.globalPlanes.roads; }, /Unknown global plane/],
  ]) {
    const broken = clone();
    mutate(broken);
    assert.throws(() => validateRawRegionsIndex(broken), pattern);
  }
  // A plane that is not READY is a statement about coverage, not an availability claim.
  const partial = clone();
  partial.globalPlanes.roads = { state: 'PARTIAL', note: 'still uploading' };
  assert.equal(validateRawRegionsIndex(partial).globalPlanes.roads.state, 'PARTIAL');
  assert.equal(globalPlaneReady(partial, 'roads'), null);
});



// ---------------------------------------------------------------- availability

test('with roads nationally online, only the bounded planes can refuse a promotion', () => {
  const fixture = roadsFixture();
  // The bounded planes have to cover the corridor *and* its 1 km analysis halo, which reaches the cell beside it.
  const covered = [...gridCells(BOUNDS).map(cell => cell.id), 'x287_y675'];
  const index = indexWith({ globalRoads: globalEntry(fixture), published: covered });
  const available = rawAvailability(index, { bounds: CORRIDOR });
  assert.equal(available.available, true);
  assert.equal(available.globalRoads.version, 'roads-test-v1');
  assert.deepEqual(Object.keys(available.required).sort(), ['hydrography', 'wetlands'],
    'a globally published road plane leaves the availability question entirely');
  // A corridor with no bounded region at all: the refusal names the bounded cells it needs, and never roads.
  const nowhere = { ...index, regions: [] };
  const missing = rawAvailability(nowhere, { bounds: CORRIDOR });
  assert.equal(missing.available, false);
  assert.deepEqual(Object.keys(missing.missing).sort(), ['hydrography', 'wetlands']);
  const message = rawAvailabilityMessage(missing);
  assert.match(message, /have not been published/);
  assert.ok(!/roads/.test(message), `roads must not appear as missing: ${message}`);
  // One bounded plane short: the same, with the count.
  const trimmed = covered.filter(id => id !== 'x288_y675');
  const short = rawAvailability(indexWith({ globalRoads: globalEntry(fixture), published: trimmed }), { bounds: CORRIDOR });
  assert.equal(short.available, false);
  assert.deepEqual(short.missing.wetlands, ['x288_y675']);
  assert.deepEqual(short.missing.hydrography, ['x288_y675']);
  assert.ok(!('roads' in short.missing));
  // Without the declaration the old rule stands: roads are bounded, and a road cell is a reason to refuse.
  const bounded = rawAvailability(indexWith({ published: trimmed }), { bounds: CORRIDOR });
  assert.equal(bounded.available, false);
  assert.equal(bounded.globalRoads, null);
  assert.deepEqual(bounded.missing.roads, ['x288_y675']);
  assert.match(rawAvailabilityMessage(bounded), /roads: 1/);
});


// ---------------------------------------------------------------- the reader

test('a promotion reads roads from the global plane, including the whole component', async () => {
  const fixture = roadsFixture();
  const entry = globalEntry(fixture);
  const stub = installFetch([
    { path: 'raw/bounded-test/bounded-v1/manifest.json', json: regionCatalog() },
    { path: 'raw/bounded-test/bounded-v1/road-components.json', bytes: REGION_COMPONENTS },
    { path: `national/roads/${entry.version}/publication.json`, bytes: fixture.publicationBytes },
    { path: `${entry.closure.prefix}${fixture.tile}.json`, bytes: fixture.tileBytes },
    { match: /\/roads\/x-?\d+_y-?\d+[.]parquet$/, bytes: ROAD_BYTES },
    { match: /national\/wetlands\/bounded-wetlands\/x-?\d+_y-?\d+[.]parquet$/, bytes: HABITAT_BYTES },
    { match: /national\/hydrography\/bounded-hydrography\/x-?\d+_y-?\d+[.]parquet$/, bytes: HABITAT_BYTES },
  ]);
  const { engine, registered } = fakeEngine();
  try {
    const gis = createGisService({ engineFactory: async () => engine });
    // The region's own roads cells are unpublished in this fixture, so a promotion that succeeded at all could
    // only have taken its roads from the global plane.
    const scope = await gis.prepareRegionalSearch(promotionArea(CORRIDOR, { globalRoads: entry,
      roadComponentIds: ['drv1-test-rd-c1'] }), {});
    const selection = scope.selection;
    assert.equal(selection.globalRoads, true);
    assert.deepEqual(selection.partitions.roads.map(part => part.id), ['x286_y675', 'x287_y675', 'x288_y675'],
      'the closure adds the cell the component continues into, outside the corridor box');
    assert.equal(selection.globalRoadsComponents, 1);
    assert.equal(selection.sourceReady, true);
    // The component reached one cell past the box, and that cell was read: the case the bounded model refused.
    assert.ok(stub.seen.some(url => url.endsWith('/roads/x286_y675.parquet')));
    assert.ok(stub.seen.some(url => url.endsWith('national/wetlands/bounded-wetlands/x288_y675.parquet')));
    assert.ok(stub.seen.some(url => url.endsWith('national/hydrography/bounded-hydrography/x288_y675.parquet')));
    assert.ok(registered.length >= 5, 'every selected object was registered');
  } finally { stub.restore(); }
});


test('the closure follows every component touching the corridor, not only the one the row names', async () => {
  // A discovery unit is composed from features and can span several components; the corridor id was composed over
  // the whole national road network. Closing over just the named component reproduces a shorter road - which is
  // exactly how source evidence failed in production.
  const fixture = roadsFixture();
  const other = { id: 'drv1-other-rd-c9', nameKey: 'other rd', cells: ['x288_y675', 'x289_y675'],
    bounds: [-122.2, 45.0, -121.8, 45.2] };
  const document = tileDocument(fixture.tile, [fixture.component, other]);
  const tileBytes = Buffer.from(JSON.stringify(document) + '\n');
  const publication = { ...fixture.publication,
    closure: { ...fixture.publication.closure, tiles: [{ key: fixture.tile, bytes: tileBytes.length,
      sha256: sha(tileBytes) }] } };
  const publicationBytes = Buffer.from(JSON.stringify(publication) + '\n');
  const entry = globalEntry({ publication, publicationBytes, tile: fixture.tile, tileBytes });
  const stub = installFetch([
    { path: 'raw/bounded-test/bounded-v1/manifest.json', json: regionCatalog() },
    { path: 'raw/bounded-test/bounded-v1/road-components.json', bytes: REGION_COMPONENTS },
    { path: `national/roads/${entry.version}/publication.json`, bytes: publicationBytes },
    { path: `${entry.closure.prefix}${fixture.tile}.json`, bytes: tileBytes },
    { match: /\/roads\/x-?\d+_y-?\d+[.]parquet$/, bytes: ROAD_BYTES },
    { match: /national\/wetlands\/bounded-wetlands\/x-?\d+_y-?\d+[.]parquet$/, bytes: HABITAT_BYTES },
    { match: /national\/hydrography\/bounded-hydrography\/x-?\d+_y-?\d+[.]parquet$/, bytes: HABITAT_BYTES },
  ]);
  const { engine } = fakeEngine();
  try {
    const gis = createGisService({ engineFactory: async () => engine });
    const scope = await gis.prepareRegionalSearch(promotionArea(CORRIDOR, { globalRoads: entry,
      roadComponentIds: ['drv1-test-rd-c1'] }), {});
    const ids = scope.selection.partitions.roads.map(part => part.id);
    assert.ok(ids.includes('x289_y675'), `the neighbouring component's cells are closed over too: ${ids}`);
    assert.equal(scope.selection.globalRoadsComponents, 2);
  } finally { stub.restore(); }
});

test('a global roads plane at another version is refused, not substituted', async () => {
  const fixture = roadsFixture();
  const entry = { ...globalEntry(fixture), version: 'tiger2024-county-v9' };
  const stub = installFetch([{ path: 'raw/bounded-test/bounded-v1/manifest.json', json: regionCatalog() }]);
  const { engine } = fakeEngine();
  try {
    const gis = createGisService({ engineFactory: async () => engine });
    await assert.rejects(() => gis.prepareRegionalSearch(promotionArea(CORRIDOR, { globalRoads: entry }), {}),
      /published as roads-test-v1, but the national roads plane online is tiger2024-county-v9/);
  } finally { stub.restore(); }
});

test('without the global plane the bounded region still has to hold the roads', async () => {
  const stub = installFetch([
    { path: 'raw/bounded-test/bounded-v1/manifest.json', json: regionCatalog({ roadsPublished: true }) },
    { path: 'raw/bounded-test/bounded-v1/road-components.json', bytes: REGION_COMPONENTS },
    { match: /\/roads\/x-?\d+_y-?\d+[.]parquet$/, bytes: ROAD_BYTES },
    { match: /national\/wetlands\/bounded-wetlands\/x-?\d+_y-?\d+[.]parquet$/, bytes: HABITAT_BYTES },
    { match: /national\/hydrography\/bounded-hydrography\/x-?\d+_y-?\d+[.]parquet$/, bytes: HABITAT_BYTES },
  ]);
  const { engine } = fakeEngine();
  try {
    const gis = createGisService({ engineFactory: async () => engine });
    const scope = await gis.prepareRegionalSearch(promotionArea(CORRIDOR), {});
    assert.equal(scope.selection.globalRoads, false);
    assert.deepEqual(scope.selection.partitions.roads.map(part => part.id), ['x288_y675']);
    assert.ok(stub.seen.some(url => url.endsWith('/roads/x288_y675.parquet')));
  } finally { stub.restore(); }
});

test('the reader and the publisher tile the closure the same way', () => {
  const fixture = roadsFixture();
  assert.equal(tileKey('x287_y675'), '57_135');
  assert.equal(closureTileKey('x287_y675', 5), '57_135');
  assert.equal(tileKeyForBounds(CORRIDOR), '57_135');
  assert.deepEqual(closureTileKeys(['x287_y675', 'x299_y675'], 5), ['57_135', '59_135']);
  // The tile document the publisher writes is what the reader validates, unchanged.
  const validated = validateRoadComponents(tileDocument('57_135', [fixture.component]));
  assert.equal(validated.components[0].id, 'drv1-test-rd-c1');
  assert.deepEqual(validated.components[0].cells, ['x288_y675', 'x287_y675', 'x286_y675']);
});

test('the publication set is enumerated from the manifest, not from the directory', () => {
  const set = roadsPublicationSet({ readFile: path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8') });
  assert.equal(set.cells.length, set.manifest.counts.present);
  assert.equal(set.empty.length, set.manifest.counts.empty);
  assert.equal(set.bytes, set.cells.reduce((sum, cell) => sum + cell.bytes, 0));
  assert.equal(set.cells.length + set.empty.length, set.manifest.counts.cells);
  for (const cell of set.cells) {
    assert.ok(/^[a-f0-9]{64}$/.test(cell.sha256), `${cell.id} must carry a digest`);
    assert.ok(Number.isSafeInteger(cell.bytes) && cell.bytes > 0, `${cell.id} must carry a byte count`);
    assert.ok(cell.url.startsWith('national/roads/tiger2025-county-v1/roads/'), `${cell.id} must be in the canonical namespace`);
  }
  for (const cell of set.empty) assert.equal(cell.url, undefined, 'a typed-empty cell has no object');
});
