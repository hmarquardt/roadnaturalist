import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGisService } from '../src/gis/service.js';
import { DISCOVERY_CATALOG_TYPE, catalogTypeForPath, validateDiscoveryCatalog } from '../src/discovery/discovery-catalog.js';
import { areaCatalogType, validateSearchAreas } from '../src/discovery/search-area.js';
import { validateNationalDerivedCatalog } from '../src/discovery/national-catalog.js';
import { validateRegionalCatalog } from '../src/discovery/regional-catalog.js';
import { ANALYSIS_PROFILE_VERSION, DERIVED_SCHEMA_VERSION, analysisFingerprint } from '../src/discovery/analysis-fingerprint.js';
import { DERIVED_COLUMNS } from '../src/gis/derived-query.js';

// WHICH CATALOG A DISCOVERY SEARCH LOADS IS DECLARED, NOT INFERRED.
//
// The national cutover failed in a real browser as `TypeError: Invalid regional catalog`: the deployed frontend
// was one release behind the deployed data, so the previous release's `validateRegionalCatalog(await
// response.json())` was handed the national pointer. These tests hold the two halves of the fix: a search
// declares the catalog type it loads and is validated against that contract only, and each type's discovery path
// loads its own catalog - proven through the service itself, not only through the validators.
const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url)));
const declaration = JSON.parse(readFileSync(new URL('../data/discovery/search-areas.json', import.meta.url)));
const nationalCatalog = JSON.parse(readFileSync(new URL('../data/national/derived-catalog.json', import.meta.url)));
const regionalCatalog = JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url)));

const STEP = 0.2;
const ORIGIN = [-180, -90];
const REGION_BOUNDS = [-122.4, 45.0, -122.0, 45.4];
const CELL_BYTES = Buffer.from('PAR1-test-cell');

function gridCells(bounds) {
  const x0 = Math.floor((bounds[0] - ORIGIN[0]) / STEP + 1e-9);
  const x1 = Math.ceil((bounds[2] - ORIGIN[0]) / STEP - 1e-9);
  const y0 = Math.floor((bounds[1] - ORIGIN[1]) / STEP + 1e-9);
  const y1 = Math.ceil((bounds[3] - ORIGIN[1]) / STEP - 1e-9);
  const cells = [];
  for (let x = x0; x < x1; x += 1) {
    for (let y = y0; y < y1; y += 1) {
      cells.push({ id: `x${x}_y${y}`,
        bounds: [ORIGIN[0] + x * STEP, ORIGIN[1] + y * STEP, ORIGIN[0] + (x + 1) * STEP, ORIGIN[1] + (y + 1) * STEP] });
    }
  }
  return cells;
}

// A minimal but complete regional catalog: four empty cells in each of the three planes, so the validator's grid
// coverage rule is satisfied without pretending any raw artifact exists.
function testRegionalCatalog() {
  const cells = gridCells(REGION_BOUNDS);
  const plane = id => ({ id, format: 'GeoParquet', crs: 'EPSG:4326', sourceDatasetId: 'or-roads-pilot',
    source: { agency: 'test' }, partitions: cells.map(cell => ({ id: cell.id, bounds: cell.bounds, state: 'empty', featureCount: 0 })) });
  const components = Buffer.from('{"components":[]}');
  return { schemaVersion: 2, project: 'roadnaturalist', version: 'test-regional-v1',
    region: { id: 'test-region', bounds: REGION_BOUNDS },
    grid: { kind: 'lonlat-grid', stepLon: STEP, stepLat: STEP, origin: ORIGIN },
    maxAnalysisDistanceM: 1000, assetBaseUrl: 'https://data.test/',
    datasets: [plane('roads'), plane('wetlands'), plane('hydrography')],
    roadComponentsUrl: 'regional/test-components.json', roadComponentsBytes: components.length,
    roadComponentsSha256: createHash('sha256').update(components).digest('hex') };
}

// A derived manifest with exactly one present cell, whose bytes this test also serves.
function testDerivedManifest(fingerprint, bounds, directory) {
  const [cell] = gridCells(bounds);
  return { schemaVersion: 1, kind: 'road-derived-corridor-metrics', analysisFingerprint: fingerprint,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION, profileVersion: ANALYSIS_PROFILE_VERSION,
    region: { id: 'test-region', version: 'test', bounds },
    grid: { kind: 'lonlat-grid', origin: ORIGIN, stepLon: STEP, stepLat: STEP, crs: 'EPSG:4326' },
    schema: [...DERIVED_COLUMNS, 'road_length_m'],
    counts: { corridors: 3, storedRows: 3, replicatedRows: 0, cells: 1, presentCells: 1, emptyCells: 0,
      bytes: CELL_BYTES.length, averageRowBytes: CELL_BYTES.length / 3 },
    cells: [{ id: cell.id, bounds: cell.bounds, state: 'present', rowCount: 3,
      url: `${directory}/cells/${cell.id}.parquet`, bytes: CELL_BYTES.length,
      sha256: createHash('sha256').update(CELL_BYTES).digest('hex') }] };
}

// A fetch stub standing in for the data origin. Routed paths win (in Node a catalog URL resolves under the repo's
// own `data/` directory, exactly as a localhost browser resolves it), and any other `file:` URL is served from
// disk - so the real data manifest is the real manifest.
function installFetch(routes) {
  const previous = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : String(input.url ?? input);
    seen.push(url);
    const route = routes.find(entry => url.endsWith(entry.path));
    if (route) return route.json === undefined ? new Response(route.bytes) : Response.json(route.json);
    if (url.startsWith('file:')) return new Response(readFileSync(fileURLToPath(url)));
    return new Response('not found', { status: 404 });
  };
  return { seen, restore() { globalThis.fetch = previous; } };
}

function fakeEngine() {
  const registered = [];
  return { registered, engine: { db: { async registerFileBuffer(name, bytes) { registered.push({ name, bytes: bytes.length }); } },
    conn: { async query() { return { toArray: () => [] }; } } } };
}

// ---------------------------------------------------------------- the declared-type contract

test('a catalog is validated against the type its caller declares, and never coerced into another', () => {
  assert.equal(validateDiscoveryCatalog(regionalCatalog, 'regional').version, 'or-sw-wa-portland-v3');
  assert.equal(validateDiscoveryCatalog(nationalCatalog, 'national').version, 'conus-2025-v1');
  // The national pointer is not a regional catalog, and must never be read as one.
  assert.throws(() => validateDiscoveryCatalog(nationalCatalog, 'regional'), /Invalid regional catalog/);
  // And a regional catalog is not a national one.
  assert.throws(() => validateDiscoveryCatalog(regionalCatalog, 'national'), /Not a national derived discovery catalog/);
  // An unknown type is refused rather than defaulted to regional.
  assert.throws(() => validateDiscoveryCatalog(regionalCatalog, undefined), /Unknown discovery catalog type/);
  assert.throws(() => validateDiscoveryCatalog(regionalCatalog, 'county'), /Unknown discovery catalog type/);
});

test('a catalog path names its own type, and an absent type means the regional catalog', () => {
  assert.equal(catalogTypeForPath('regional/manifest.json'), 'regional');
  assert.equal(catalogTypeForPath('national/derived-catalog.json'), 'national');
  assert.equal(catalogTypeForPath('elsewhere/manifest.json'), null);
  assert.equal(catalogTypeForPath('regional'), null);
  assert.equal(areaCatalogType({ catalogUrl: 'regional/manifest.json' }), 'regional');
  assert.equal(areaCatalogType({ catalogUrl: 'national/derived-catalog.json', catalogType: 'national' }), 'national');
});

test('the committed declaration states the catalog type of every area it names', () => {
  const declared = validateSearchAreas(declaration, manifest);
  const typed = declared.searchAreas.filter(area => area.catalogUrl);
  assert.equal(typed.length, 5);
  for (const area of typed) {
    assert.equal(area.catalogType, catalogTypeForPath(area.catalogUrl), `${area.id} must declare the type its path names`);
  }
  // Production discovery is the interactive search, and its template loads the national derived catalog.
  const template = declared.searchAreas.find(area => area.id === declared.interactiveRadiusArea);
  assert.equal(template.id, 'national-10mi');
  assert.equal(template.catalogType, 'national');
  assert.equal(template.catalogUrl, 'national/derived-catalog.json');
  // The committed regional benchmarks keep the regional catalog, deliberately.
  for (const id of ['regional-10mi', 'regional-25mi', 'regional-50mi']) {
    const area = declared.searchAreas.find(entry => entry.id === id);
    assert.equal(areaCatalogType(area), 'regional');
    assert.equal(area.catalogUrl, 'regional/manifest.json');
  }
});

test('a declaration whose type and path disagree is refused, not guessed', () => {
  const copy = () => JSON.parse(JSON.stringify(declaration));
  const mismatched = copy();
  mismatched.searchAreas[5].catalogUrl = 'regional/manifest.json';
  assert.throws(() => validateSearchAreas(mismatched, manifest), /declares a national catalog but names regional\/manifest\.json/);
  const unknown = copy();
  unknown.searchAreas[5].catalogType = 'county';
  assert.throws(() => validateSearchAreas(unknown, manifest), /unknown catalog type/);
  const noCatalog = copy();
  delete noCatalog.searchAreas[5].catalogUrl;
  assert.throws(() => validateSearchAreas(noCatalog, manifest), /declares a catalog type but names no catalog/);
  const untypedTemplate = copy();
  untypedTemplate.interactiveRadiusArea = 'regional-10mi';
  delete untypedTemplate.searchAreas[2].catalogType;
  assert.throws(() => validateSearchAreas(untypedTemplate, manifest), /must declare the catalog type it loads/);
});


// --------------------------------------------- the service loads the catalog the search declares

const TEST_FINGERPRINT = 'b'.repeat(64);

function testNationalCatalog({ fingerprint = TEST_FINGERPRINT } = {}) {
  const derived = testDerivedManifest(fingerprint, REGION_BOUNDS, `derived/corridor-metrics/${fingerprint}`);
  const bytes = Buffer.from(JSON.stringify(derived));
  return { derived, catalog: { kind: 'road-discovery-national-derived-catalog', schemaVersion: 1, project: 'roadnaturalist',
    version: 'test-conus-v1',
    region: { id: 'test-conus', name: 'Test conterminous region', version: 'test-grid', bounds: REGION_BOUNDS,
      publishedBounds: REGION_BOUNDS, bounded: false },
    grid: { kind: 'lonlat-grid', stepLon: STEP, stepLat: STEP, origin: ORIGIN, crs: 'EPSG:4326' },
    maxAnalysisDistanceM: 1000, assetBaseUrl: 'https://data.test/',
    derived: { manifestUrl: `derived/corridor-metrics/${fingerprint}/manifest.json`, analysisFingerprint: fingerprint,
      manifestSha256: createHash('sha256').update(bytes).digest('hex'), manifestBytes: bytes.length,
      derivedSchemaVersion: DERIVED_SCHEMA_VERSION, profileVersion: ANALYSIS_PROFILE_VERSION, cells: 1 } } };
}

function radiusArea(overrides = {}) {
  return { id: 'test-area', kind: 'radius', name: 'Test area', center: [-122.2, 45.2], radiusMiles: 10,
    bbox: REGION_BOUNDS, ...overrides };
}

test('regional discovery still loads and validates the regional catalog', async () => {
  const catalog = testRegionalCatalog();
  const { fingerprint } = await analysisFingerprint({ regionalCatalog: catalog, manifest });
  const derived = testDerivedManifest(fingerprint, REGION_BOUNDS, 'derived/test/regional');
  catalog.derived = { manifestUrl: 'derived/test/regional/manifest.json', analysisFingerprint: fingerprint,
    manifestSha256: createHash('sha256').update(Buffer.from(JSON.stringify(derived))).digest('hex') };
  const stub = installFetch([{ path: '/regional/test-catalog.json', json: catalog },
    { path: '/derived/test/regional/manifest.json', json: derived }, { path: '.parquet', bytes: CELL_BYTES }]);
  const { registered, engine } = fakeEngine();
  try {
    const gis = createGisService({ engineFactory: async () => engine });
    const scope = await gis.prepareDerivedSearch(radiusArea({ catalogUrl: 'regional/test-catalog.json', catalogType: 'regional' }));
    assert.equal(scope.derived, true);
    assert.equal(scope.fingerprint, fingerprint, 'a regional plane is gated on the fingerprint the running code computes');
    assert.equal(scope.selection.counts.present, 1, 'the regional plane selected its published cell');
    assert.equal(registered.length, 1, 'the selected regional cell was fetched, verified and registered');
  } finally { stub.restore(); }
});

test('national interactive discovery loads and validates the national derived catalog', async () => {
  const { catalog, derived } = testNationalCatalog();
  const stub = installFetch([{ path: '/national/test-catalog.json', json: catalog },
    { path: `/derived/corridor-metrics/${TEST_FINGERPRINT}/manifest.json`, json: derived },
    { path: '.parquet', bytes: CELL_BYTES }]);
  const { registered, engine } = fakeEngine();
  try {
    const gis = createGisService({ engineFactory: async () => engine });
    const scope = await gis.prepareDerivedSearch(radiusArea({ catalogUrl: 'national/test-catalog.json',
      catalogType: 'national', derivedOnly: true }));
    assert.equal(scope.derived, true);
    assert.equal(scope.fingerprint, catalog.derived.analysisFingerprint,
      'a national plane is gated on the fingerprint the reviewed catalog pins');
    assert.equal(scope.manifest.present, 1);
    assert.equal(scope.selection.counts.present, 1);
    assert.equal(registered.length, 1, 'the selected national cell was fetched, verified and registered');
  } finally { stub.restore(); }
});

test('a search never validates the other catalog type, and never coerces one into the other', async () => {
  const { catalog, derived } = testNationalCatalog();
  const regional = testRegionalCatalog();
  const stub = installFetch([{ path: '/national/test-catalog.json', json: catalog },
    { path: '/national/regional-document.json', json: regional },
    { path: `/derived/corridor-metrics/${TEST_FINGERPRINT}/manifest.json`, json: derived },
    { path: '.parquet', bytes: CELL_BYTES }]);
  const { engine } = fakeEngine();
  try {
    const gis = createGisService({ engineFactory: async () => engine });
    await assert.rejects(() => gis.prepareDerivedSearch(radiusArea({ catalogUrl: 'national/test-catalog.json',
      catalogType: 'regional' })), /not a valid regional catalog/, 'a national pointer is not a regional catalog');
    await assert.rejects(() => gis.prepareDerivedSearch(radiusArea({ catalogUrl: 'national/regional-document.json',
      catalogType: 'national' })), /not a valid national catalog/, 'a regional catalog is not a national one');
  } finally { stub.restore(); }
});


// ------------------------------------------------- the committed pointer, and a drifted plane

test('the committed national pointer is exactly the expected national contract', () => {
  const validated = validateNationalDerivedCatalog(nationalCatalog);
  assert.equal(validated.version, 'conus-2025-v1');
  assert.equal(validated.region.id, 'conus-2025');
  assert.equal(validated.derived.analysisFingerprint, 'a13a883c16f6d6e897407eab0de325ea355f5edeb292ecfb36b092f9ea959ee9');
  assert.equal(validated.derived.manifestUrl,
    `derived/corridor-metrics/${validated.derived.analysisFingerprint}/manifest.json`);
  // The pointer and the running code must agree about the analysis contract, or the plane is not usable.
  assert.equal(validated.derived.profileVersion, ANALYSIS_PROFILE_VERSION);
  assert.equal(validated.derived.derivedSchemaVersion, DERIVED_SCHEMA_VERSION);
});

test('malformed national catalogs fail closed', () => {
  const noVersion = structuredClone(nationalCatalog);
  delete noVersion.version;
  assert.throws(() => validateNationalDerivedCatalog(noVersion), /Not a national derived discovery catalog/);
  const badFingerprint = structuredClone(nationalCatalog);
  badFingerprint.derived.analysisFingerprint = 'not-a-digest';
  assert.throws(() => validateNationalDerivedCatalog(badFingerprint), /no usable derived plane/);
  const wrongUrl = structuredClone(nationalCatalog);
  wrongUrl.derived.manifestUrl = `derived/corridor-metrics/${'c'.repeat(64)}/manifest.json`;
  assert.throws(() => validateNationalDerivedCatalog(wrongUrl), /does not match its analysis fingerprint/);
  const noRegion = structuredClone(nationalCatalog);
  noRegion.region.bounds = [0, 0, 0, 0];
  assert.throws(() => validateNationalDerivedCatalog(noRegion), /published region/);
  assert.throws(() => validateNationalDerivedCatalog(structuredClone(regionalCatalog)), /Not a national/);
});

test('a national search fails closed on a drifted plane instead of serving it', async () => {
  const cases = [
    ['fingerprint', derived => { derived.analysisFingerprint = 'd'.repeat(64); }, /different analysis rules/],
    ['region', derived => { derived.region.bounds = [0, 0, 1, 1]; }, /does not cover the region/],
    ['schema', derived => { derived.schema = derived.schema.filter(column => column !== 'corridor_id'); }, /missing columns/],
    ['profile', derived => { derived.profileVersion = 99; }, /analysis profile\/schema/],
  ];
  for (const [name, mutate, expected] of cases) {
    const derived = testDerivedManifest(TEST_FINGERPRINT, REGION_BOUNDS, `derived/corridor-metrics/${TEST_FINGERPRINT}`);
    mutate(derived);
    const bytes = Buffer.from(JSON.stringify(derived));
    const { catalog } = testNationalCatalog();
    catalog.derived = { ...catalog.derived,
      manifestSha256: createHash('sha256').update(bytes).digest('hex'), manifestBytes: bytes.length };
    const stub = installFetch([{ path: '/national/test-catalog.json', json: catalog },
      { path: `/derived/corridor-metrics/${TEST_FINGERPRINT}/manifest.json`, json: derived },
      { path: '.parquet', bytes: CELL_BYTES }]);
    const { registered, engine } = fakeEngine();
    try {
      const gis = createGisService({ engineFactory: async () => engine });
      await assert.rejects(() => gis.prepareDerivedSearch(radiusArea({ catalogUrl: 'national/test-catalog.json',
        catalogType: 'national' })), expected, `${name}: a drifted national plane must fail closed`);
      assert.equal(registered.length, 0, `${name}: no cell of a refused plane may be read`);
    } finally { stub.restore(); }
  }
});

test('a national search never falls back to raw regional partitions it does not have', async () => {
  const stub = installFetch([]);
  const { engine } = fakeEngine();
  try {
    const gis = createGisService({ engineFactory: async () => engine });
    await assert.rejects(() => gis.prepareRegionalSearch(radiusArea({ catalogUrl: 'national/derived-catalog.json',
      catalogType: 'national' })), /not published/);
  } finally { stub.restore(); }
});

