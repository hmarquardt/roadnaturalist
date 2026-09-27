import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSearchAreas, radiusBounds } from '../src/discovery/search-area.js';
import { selectDerivedCells, validateDerivedManifest } from '../src/discovery/derived-catalog.js';
import { boundsCoverage, validateRegionalCatalog } from '../src/discovery/regional-catalog.js';
import { COVERAGE } from '../src/domain/corridor.js';
import {
  MAX_RADIUS_MILES, MAX_SEARCH_HISTORY, MIN_RADIUS_MILES, addSearchHistory,
  areaCoverage, coordinateNumber, createInteractiveSearchArea, definitionFromSearchArea,
  initialSearchSelection, parseSearchQuery, radiusNumber, radiusPresets, radiusTemplate, readSearchDefinition,
  searchDefinitionOf, searchIsRunnable, searchRefusal, searchRegionCoverage, serializeSearchQuery,
  storedDefinition, storedHistory, withSearchQuery, CUSTOM_SEARCH_AREA_ID,
} from '../src/discovery/search-definition.js';
import { runDiscovery } from '../src/discovery/run.js';
import { DISCOVERY_SEARCH_KEY, DISCOVERY_SEARCH_HISTORY_KEY, readDiscoverySearch, readDiscoverySearchHistory,
  writeDiscoverySearch, writeDiscoverySearchHistory } from '../src/discovery/persistence.js';

// The interactive search definition: a centre a person chose and a radius they chose, expressed so that the
// map, the coordinate fields, a preset, a URL and a stored search all hand the *same* input to the same
// derived discovery machinery. These tests cover the model and its boundaries - what may become a search,
// what may not, and what the interface can say before a run - and leave the GIS internals to their own tests.
const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url)));
const declaration = validateSearchAreas(JSON.parse(readFileSync(new URL('../data/discovery/search-areas.json', import.meta.url))), manifest);
const catalog = validateRegionalCatalog(JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url))));
const derivedManifest = validateDerivedManifest(JSON.parse(readFileSync(new URL(`../data/${catalog.derived.localPath}`, import.meta.url))));
const REGION = declaration.publishedRegion;
const REGION_BOUNDS = REGION.bounds;
const PRESETS = radiusPresets(declaration);
// The committed benchmark centre, read from the declaration rather than typed here.
const BENCHMARK = definitionFromSearchArea(PRESETS[0]);
const MI = 1609.344;
const LON_PER_M = 1 / (111320 * Math.cos(BENCHMARK.center[1] * Math.PI / 180));

test('a centre is read from ordinary decimal input, and anything else is refused rather than coerced', () => {
  assert.equal(coordinateNumber(45.595), 45.595);
  assert.equal(coordinateNumber('45.595'), 45.595);
  assert.equal(coordinateNumber(' -122.920 '), -122.92);
  assert.equal(coordinateNumber('+45.'), 45);
  // A URL parameter and a text field are the same untrusted input: nothing here may execute a string or
  // invent a number out of one.
  for (const value of ['', '  ', 'abc', '45,595', '1e5', '0x2d', 'NaN', 'Infinity', '-Infinity', '45.5.5',
    '45 595', 'null', 'undefined', {}, [], true, null, undefined, Number.NaN, Infinity]) {
    assert.equal(coordinateNumber(value), null, `${String(value)} is not a coordinate`);
  }
  assert.equal(coordinateNumber('47°'), null, 'a unit suffix is not part of the number');
});

test('a radius is a whole number of statute miles inside the declared range', () => {
  assert.equal(radiusNumber(25), 25);
  assert.equal(radiusNumber('25'), 25);
  assert.equal(radiusNumber(MIN_RADIUS_MILES), MIN_RADIUS_MILES);
  assert.equal(radiusNumber(MAX_RADIUS_MILES), MAX_RADIUS_MILES);
  for (const value of ['', 'twenty', '25.5', '2e1', '1/2', '5 miles', {}, [], null, undefined, 25.5, Number.NaN, Infinity]) {
    assert.equal(radiusNumber(value), null, `${String(value)} is not a whole number of miles`);
  }
});

test('a definition needs a coordinate pair and a radius, and reports every problem it finds', () => {
  const empty = readSearchDefinition({}, { region: REGION });
  assert.equal(empty.ok, false);
  assert.equal(empty.definition, null);
  assert.deepEqual(empty.problems.map(entry => entry.code), ['latitude.invalid', 'longitude.invalid', 'radius.invalid']);
  const outOfRange = readSearchDefinition({ lat: 91, lon: -181, radiusMiles: 51 }, { region: REGION });
  assert.deepEqual(outOfRange.problems.map(entry => entry.code), ['latitude.range', 'longitude.range', 'radius.tooLarge']);
  const tooSmall = readSearchDefinition({ lat: 45, lon: -122, radiusMiles: 0 }, { region: REGION });
  assert.deepEqual(tooSmall.problems.map(entry => entry.code), ['radius.tooSmall']);
  const south = readSearchDefinition({ lat: -91, lon: 181, radiusMiles: -1 }, { region: REGION });
  assert.deepEqual(south.problems.map(entry => entry.code), ['latitude.range', 'longitude.range', 'radius.tooSmall']);
  // Latitude 90 and longitude 180 are on the edge of the coordinate system, not outside it.
  assert.equal(readSearchDefinition({ lat: 90, lon: 180, radiusMiles: 1 }, { region: REGION }).ok, true);
  // A definition is canonical: five decimal places, so a URL reloads exactly the search it described.
  const valid = readSearchDefinition({ lat: '45.595123456', lon: '-122.920987654', radiusMiles: '25' }, { region: REGION });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.definition.center, [-122.92099, 45.59512]);
  assert.equal(valid.definition.radiusMiles, 25);
  assert.equal(Object.isFrozen(valid.definition), true);
});

test('coverage is classified FULL, PARTIAL or NONE from the published region, before any data is read', () => {
  const state = (lat, lon, radiusMiles) => {
    const result = readSearchDefinition({ lat, lon, radiusMiles }, { region: REGION });
    assert.equal(result.ok, true, `${lat}, ${lon} at ${radiusMiles} mi must be a valid definition`);
    return result.coverage;
  };
  const inside = state(45.595, -122.92, 10);
  assert.equal(inside.coverage, COVERAGE.FULL);
  assert.match(inside.reason, /inside the published Greater Portland/);
  assert.equal(inside.bounds.length, 4);
  // Comfortably inside, near each edge: a small enough search inside the region is FULL wherever it sits.
  assert.equal(state(44.85, -123.90, 5).coverage, COVERAGE.FULL, 'near the south-west corner');
  assert.equal(state(46.35, -121.85, 2).coverage, COVERAGE.FULL, 'near the north-east corner');
  // A search box that crosses the published edge is PARTIAL, never "nothing is there".
  const north = state(46.30, -122.9, 25);
  assert.equal(north.coverage, COVERAGE.PARTIAL);
  assert.match(north.reason, /crosses the edge of the published/);
  assert.match(north.reason, /not read as empty or as having no roads/);
  assert.equal(state(44.85, -122.9, 25).coverage, COVERAGE.PARTIAL, 'near the south edge');
  assert.equal(state(45.6, -121.95, 25).coverage, COVERAGE.PARTIAL, 'near the east edge');
  assert.equal(state(45.6, -123.90, 25).coverage, COVERAGE.PARTIAL, 'near the west edge');
  // A centre outside the region whose circle still reaches it is PARTIAL: the search is allowed.
  const overlapping = state(46.55, -122.9, 25);
  assert.equal(overlapping.coverage, COVERAGE.PARTIAL);
  assert.equal(searchIsRunnable({ ok: true, coverage: overlapping }), true);
  // No overlap at all is NONE, and the run is refused with the reason rather than answered emptily.
  for (const probe of [state(43.0, -120.0, 10), state(48.0, -124.0, 10), state(45.6, -119.0, 10)]) {
    assert.equal(probe.coverage, COVERAGE.NONE);
    assert.match(probe.reason, /does not overlap the published/);
    assert.equal(searchIsRunnable({ ok: true, coverage: probe }), false);
    assert.equal(searchRefusal({ ok: true, coverage: probe }), probe.reason);
  }
  assert.equal(searchIsRunnable({ ok: false, coverage: inside }), false);
  assert.match(searchRefusal({ ok: false, problems: [{ message: 'Latitude must be a decimal number of degrees, for example 45.595.' }] }),
    /Latitude must be a decimal number/);
  // Without a declared region the state is UNKNOWN and the search is allowed to try: a missing declaration is
  // a configuration problem, not proof that nothing is there.
  const unknown = searchRegionCoverage(BENCHMARK, null);
  assert.equal(unknown.coverage, COVERAGE.UNKNOWN);
  assert.equal(searchIsRunnable({ ok: true, coverage: unknown }), true);
  assert.equal(boundsCoverage(inside.bounds, REGION_BOUNDS), COVERAGE.FULL);
  assert.equal(boundsCoverage([1, 1, 2, 2], REGION_BOUNDS), COVERAGE.NONE);
});

test('the preview classification is the classification the derived runtime will make', () => {
  const probes = [[45.595, -122.92, 10], [46.30, -122.9, 25], [44.85, -122.9, 25], [45.6, -121.95, 25],
    [45.6, -123.90, 25], [46.55, -122.9, 25], [43.0, -120.0, 10], [46.35, -121.85, 2]];
  for (const [lat, lon, radiusMiles] of probes) {
    const definition = searchDefinitionOf([lon, lat], radiusMiles);
    const predicted = searchRegionCoverage(definition, REGION);
    const selected = selectDerivedCells(derivedManifest, definition.bounds);
    assert.equal(selected.coverage, predicted.coverage,
      `${lat}, ${lon} at ${radiusMiles} mi: the interface and the derived reader must agree`);
    if (selected.coverage !== COVERAGE.NONE) {
      assert.ok(selected.cells.every(cell => cell.bounds.every(Number.isFinite)));
      assert.equal(selected.counts.present, selected.present.length);
      assert.ok(selected.bytes >= 0);
    }
  }
});

test('an interactive search area is the declared radius template with its centre and radius replaced', () => {
  const template = radiusTemplate(declaration);
  const definition = searchDefinitionOf(BENCHMARK.center, 25);
  const area = createInteractiveSearchArea(definition, { template });
  assert.equal(area.kind, 'radius');
  assert.equal(area.id, CUSTOM_SEARCH_AREA_ID);
  assert.equal(area.catalogUrl, template.catalogUrl);
  assert.deepEqual(area.requires, template.requires);
  assert.deepEqual(area.center, definition.center);
  assert.equal(area.radiusMiles, definition.radiusMiles);
  assert.deepEqual([...area.bbox], [...definition.bounds]);
  assert.match(area.name, /25 mi at 45\.5950, -122\.9200/);
  // A declared radius scenario is a preset, so its own definition builds the same area through the same path.
  for (const preset of PRESETS) {
    const presetArea = createInteractiveSearchArea(definitionFromSearchArea(preset), { template });
    assert.equal(presetArea.radiusMiles, preset.radiusMiles);
    assert.equal(presetArea.catalogUrl, preset.catalogUrl);
    assert.deepEqual(selectDerivedCells(derivedManifest, presetArea.bbox).cells.map(cell => cell.id),
      selectDerivedCells(derivedManifest, preset.bbox).cells.map(cell => cell.id),
      `${preset.id}: a preset must select exactly the cells the declared scenario selects`);
    assert.equal(areaCoverage(preset, REGION).coverage, searchRegionCoverage(definitionFromSearchArea(preset), REGION).coverage,
      `${preset.id}: a preset is an ordinary search definition, so its coverage cannot differ`);
  }
  assert.throws(() => createInteractiveSearchArea(definition, { template: null }), /declared radius search area/);
  assert.throws(() => createInteractiveSearchArea(null, { template }), /search definition/);
  assert.throws(() => searchDefinitionOf([NaN, 45], 10), /finite centre/);
  assert.throws(() => searchDefinitionOf([-122, 45.595], 51), /largest search radius/);
});

test('a definition carries the exact bounds its radius implies, and the committed scenarios agree with it', () => {
  const definition = searchDefinitionOf(BENCHMARK.center, BENCHMARK.radiusMiles);
  assert.deepEqual([...definition.bounds], radiusBounds(definition.center, definition.radiusMiles));
  assert.equal(definition.radiusM, definition.radiusMiles * MI);
  for (const preset of PRESETS) {
    const presetDefinition = definitionFromSearchArea(preset);
    // The committed bounds are published rounded; the derivation is the authority they must still match.
    assert.deepEqual([...presetDefinition.bounds].map((value, index) => Math.abs(value - preset.bbox[index]) < 1e-6),
      [true, true, true, true],
      `${preset.id}: the committed bounds must still be the ones this radius derivation produces`);
  }
  assert.equal(definitionFromSearchArea({ id: 'box', bbox: [-123, 45, -122, 46] }), null,
    'a declared box is not a radius definition');
});

test('the published region declaration is the region the catalog and the derived plane publish', () => {
  assert.equal(REGION.id, catalog.region.id);
  assert.deepEqual(REGION_BOUNDS, catalog.region.bounds,
    'the declared region must be the bounds of the published regional catalog');
  assert.deepEqual(REGION_BOUNDS, derivedManifest.region.bounds,
    'the declared region must be the region the derived corridor-metrics plane covers');
  assert.deepEqual(REGION_BOUNDS, derivedManifest.region.publishedBounds);
  const wrong = { ...declaration, publishedRegion: { ...REGION, bounds: [0, 0, 1, 1] } };
  assert.equal(validateSearchAreas(wrong, manifest).publishedRegion.bounds[0], 0, 'a declaration is data, not a check');
  const broken = { ...declaration, publishedRegion: { id: 'x', name: 'y', bounds: [1, 1, 0, 0] } };
  assert.throws(() => validateSearchAreas(broken, manifest), /ordered finite bounds/);
  assert.throws(() => validateSearchAreas({ ...declaration, publishedRegion: { id: 'x', bounds: [0, 0, 1, 1] } }, manifest),
    /needs an id and a name/);
});

test('the search is reproducible through the URL, and a malformed link fails safely', () => {
  const definition = searchDefinitionOf([-122.92, 45.595], 25);
  const query = serializeSearchQuery(definition);
  assert.equal(query, 'lat=45.595&lon=-122.92&r=25');
  const parsed = parseSearchQuery(`?${query}`, { region: REGION });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.definition.center, definition.center);
  assert.equal(parsed.definition.radiusMiles, 25);
  assert.deepEqual([...parsed.definition.bounds], [...definition.bounds]);
  assert.equal(parseSearchQuery('', { region: REGION }), null, 'a link without search parameters declares no search');
  assert.equal(parseSearchQuery('?foo=bar', { region: REGION }), null);
  // Every malformed link produces problems and no definition: nothing reaches the pipeline from a URL, and
  // nothing in a URL is executed.
  const cases = [
    ['?lat=45.595&lon=-122.92', ['radius.invalid'], 'missing radius'],
    ['?lat=abc&lon=-122.92&r=25', ['latitude.invalid'], 'malformed latitude'],
    ['?lat=145&lon=-122.92&r=25', ['latitude.range'], 'latitude out of range'],
    ['?lat=45.595&lon=-999&r=25', ['longitude.range'], 'longitude out of range'],
    ['?lat=45.595&lon=-122.92&r=0', ['radius.tooSmall'], 'radius below the minimum'],
    ['?lat=45.595&lon=-122.92&r=500', ['radius.tooLarge'], 'radius above the maximum'],
    ['?lat=45.595&lon=-122.92&r=25mi', ['radius.invalid'], 'a radius with a unit'],
    ['?lat=45.595&lon=-122.92&r=1e2', ['radius.invalid'], 'an exponential radius'],
  ];
  for (const [search, codes, label] of cases) {
    const result = parseSearchQuery(search, { region: REGION });
    assert.equal(result.ok, false, label);
    assert.equal(result.definition, null, label);
    assert.deepEqual(result.problems.map(entry => entry.code), codes, label);
  }
  // A repeated parameter is read, not trusted: the first declared value is used and nothing else is evaluated.
  assert.equal(parseSearchQuery('?lat=45.595&lon=-122.92&r=25&lat=1', { region: REGION }).definition.center[1], 45.595);
  // An array-shaped parameter is not a coordinate.
  const repeated = parseSearchQuery('?lat[]=45.595&lon=-122.92&r=25', { region: REGION });
  assert.equal(repeated.ok, false);
  assert.deepEqual(repeated.problems.map(entry => entry.code), ['latitude.invalid']);
  // A URL definition whose circle cannot reach the published region parses, and is refused as a search.
  const outside = parseSearchQuery('?lat=43&lon=-120&r=25', { region: REGION });
  assert.equal(outside.ok, true);
  assert.equal(outside.coverage.coverage, COVERAGE.NONE);
  assert.equal(searchIsRunnable(outside), false);
  // Serialization keeps parameters this application does not own.
  assert.equal(withSearchQuery('?utm=x&lat=1&lon=2', definition), 'utm=x&lat=45.595&lon=-122.92&r=25');
  assert.equal(withSearchQuery('?utm=x&lat=1&lon=2&r=3', null), 'utm=x');
  assert.equal(serializeSearchQuery(null), '');
});

test('a stored search and the recent list are normalized with the same rules as typed input', () => {
  assert.deepEqual(storedDefinition({ center: [-122.92, 45.595], radiusMiles: 25 }).center, [-122.92, 45.595]);
  assert.equal(storedDefinition({ center: [-122.92, 45.595], radiusMiles: 51 }), null, 'an out-of-range radius is dropped');
  assert.equal(storedDefinition({ center: [-122.92, 'north'], radiusMiles: 25 }), null);
  assert.equal(storedDefinition({ center: [-122.92], radiusMiles: 25 }), null);
  assert.equal(storedDefinition({ center: ['<script>', 45], radiusMiles: 25 }), null);
  assert.equal(storedDefinition(null), null);
  assert.equal(storedDefinition('45.595,-122.92'), null);
  const one = searchDefinitionOf([-122.92, 45.595], 10);
  const two = searchDefinitionOf([-123.12, 45.51], 25);
  let history = addSearchHistory([], one, { at: '2026-01-01T00:00:00.000Z' });
  history = addSearchHistory(history, two);
  assert.deepEqual(history.map(entry => entry.radiusMiles), [25, 10], 'newest first');
  assert.equal(history[1].at, '2026-01-01T00:00:00.000Z');
  // Re-running a search moves it to the front instead of appearing twice.
  history = addSearchHistory(history, one);
  assert.deepEqual(history.map(entry => entry.radiusMiles), [10, 25]);
  assert.equal(history.length, 2);
  let bounded = [];
  for (let miles = MIN_RADIUS_MILES; miles < MIN_RADIUS_MILES + 20; miles++) bounded = addSearchHistory(bounded, searchDefinitionOf([-122.92, 45.595], miles));
  assert.equal(bounded.length, MAX_SEARCH_HISTORY);
  assert.equal(bounded[0].radiusMiles, MIN_RADIUS_MILES + 19);
  assert.equal(storedHistory([{ center: [-122.92, 45.595], radiusMiles: 10 }, { center: [-122.92, 45.595], radiusMiles: 10 },
    { center: [0, 0], radiusMiles: 900 }, 'nonsense']).length, 1, 'junk and duplicates are dropped, not counted');
  assert.deepEqual(storedHistory(null), []);
});

test('the last search and the recent list persist in two small versioned entries and never trust broken storage', () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key) };
  const definition = searchDefinitionOf([-122.92, 45.595], 25);
  assert.deepEqual(writeDiscoverySearch(definition, storage).radiusMiles, 25);
  assert.ok(entries.has(DISCOVERY_SEARCH_KEY));
  assert.deepEqual(readDiscoverySearch(storage).center, definition.center);
  assert.deepEqual(writeDiscoverySearch(definition, storage).radiusMiles, 25, 'writing twice is idempotent');
  // A stored value that is not a search definition is discarded rather than restored.
  entries.set(DISCOVERY_SEARCH_KEY, JSON.stringify({ kind: 'roadnaturalist-discovery-search', version: 1,
    definition: { center: [0, 0], radiusMiles: 900 } }));
  assert.equal(readDiscoverySearch(storage), null);
  entries.set(DISCOVERY_SEARCH_KEY, '{not json');
  assert.equal(readDiscoverySearch(storage), null);
  entries.set(DISCOVERY_SEARCH_KEY, JSON.stringify({ kind: 'something-else', definition: { center: [-122.92, 45.595], radiusMiles: 10 } }));
  assert.equal(readDiscoverySearch(storage), null);
  const history = writeDiscoverySearchHistory(addSearchHistory([], definition), storage);
  assert.equal(history.length, 1);
  assert.ok(entries.has(DISCOVERY_SEARCH_HISTORY_KEY));
  assert.equal(readDiscoverySearchHistory(storage)[0].radiusMiles, 25);
  // Nothing to remember removes the entries rather than storing an empty record.
  writeDiscoverySearchHistory([], storage);
  assert.equal(entries.has(DISCOVERY_SEARCH_HISTORY_KEY), false);
  writeDiscoverySearch(null, storage);
  assert.equal(entries.has(DISCOVERY_SEARCH_KEY), false);
  // No storage at all is a missing convenience, not a failure, and a full store never breaks a search.
  assert.equal(readDiscoverySearch(null), null);
  assert.deepEqual(readDiscoverySearchHistory(null), []);
  assert.deepEqual(writeDiscoverySearch(definition, null).radiusMiles, 25);
  const full = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  assert.doesNotThrow(() => writeDiscoverySearch(definition, full));
  assert.doesNotThrow(() => writeDiscoverySearchHistory([definition], full));
});

test('the first selection of a session prefers the URL, then the remembered search, then a preset', () => {
  const declaredAreaId = declaration.searchAreas[0].id;
  const url = '?lat=45.51&lon=-123.12&r=25';
  const stored = { center: [-122.92, 45.595], radiusMiles: 5 };
  const history = [{ center: [-122.9, 45.6], radiusMiles: 50 }];
  const fromUrl = initialSearchSelection({ search: url, stored, history, presets: PRESETS, declaredAreaId, region: REGION });
  assert.equal(fromUrl.source, 'url');
  assert.equal(fromUrl.selection.areaId, CUSTOM_SEARCH_AREA_ID);
  assert.deepEqual(fromUrl.selection.definition.center, [-123.12, 45.51]);
  assert.equal(fromUrl.selection.definition.radiusMiles, 25);
  assert.equal(fromUrl.history.length, 1);
  const fromStore = initialSearchSelection({ search: '', stored, history, presets: PRESETS, declaredAreaId, region: REGION });
  assert.equal(fromStore.source, 'stored');
  assert.equal(fromStore.selection.areaId, CUSTOM_SEARCH_AREA_ID);
  assert.equal(fromStore.selection.definition.radiusMiles, 5);
  assert.deepEqual(fromStore.problems, []);
  // A remembered search does not hide a broken link: the parameters were ignored, and the interface says so.
  const storedAndBroken = initialSearchSelection({ search: '?lat=north&lon=-123.12&r=25', stored, presets: PRESETS,
    declaredAreaId, region: REGION });
  assert.equal(storedAndBroken.source, 'stored');
  assert.deepEqual(storedAndBroken.problems.map(entry => entry.code), ['latitude.invalid']);
  assert.equal(storedAndBroken.selection.definition.radiusMiles, 5);
  // With nothing remembered, a committed preset fills the controls while the declared window stays the search.
  const fresh = initialSearchSelection({ presets: PRESETS, declaredAreaId, region: REGION });
  assert.equal(fresh.source, 'preset');
  assert.equal(fresh.selection.areaId, declaredAreaId);
  assert.deepEqual(fresh.selection.definition.center, PRESETS[0].center);
  assert.equal(fresh.selection.definition.radiusMiles, PRESETS[0].radiusMiles);
  assert.equal(fresh.selection.picking, false);
  // A broken link is reported and never becomes the search: the preset draft is used instead.
  const broken = initialSearchSelection({ search: '?lat=north&lon=-122.92&r=25', stored: null, presets: PRESETS,
    declaredAreaId, region: REGION });
  assert.equal(broken.source, 'preset');
  assert.equal(broken.selection.areaId, declaredAreaId);
  assert.deepEqual(broken.problems.map(entry => entry.code), ['latitude.invalid']);
  // A deployment with no declared area at all still gets a valid definition to start from.
  const bare = initialSearchSelection({ presets: PRESETS, declaredAreaId: null, region: REGION });
  assert.equal(bare.selection.areaId, CUSTOM_SEARCH_AREA_ID);
  assert.equal(initialSearchSelection({}).selection.definition, null);
});

// ---------------------------------------------------------------- the interactive search is the same run

// A minimal derived row: the columns the derived reader maps into a discovery result, with a geometry of this
// test's choosing. It is deliberately not the full production row - the derived-plane tests own that shape -
// and it exists here to prove that an interactive search area is filtered by the same exact-radius rule.
function derivedRow(id, coordinates) {
  const lons = coordinates.map(point => point[0]);
  const lats = coordinates.map(point => point[1]);
  return { corridor_id: id, road_component_id: id.replace(/-s\d+$/, ''), road_unit_id: id.replace(/-s\d+$/, ''),
    name: 'NW Example Rd', normalized_name: 'nw example rd', length_m: 2000, road_classes: ['S1400'],
    county_names: ['Multnomah County, Oregon'], counties: ['41051'], road_ids: ['tiger-example'],
    source_feature_ids: ['1', '2'], segment_index: 1, segment_count: 1, geometry_repaired: false,
    geometry_repair_method: 'none', analysis_fingerprint: 'f'.repeat(64),
    primary_l3_code: '3', primary_l3_name: 'Willamette Valley', primary_l3_percent: 100,
    primary_l4_code: '3a', primary_l4_name: 'Portland/Vancouver Basin', primary_l4_percent: 100,
    l3_count: 1, l4_count: 1, transition_count: 0, ecology_coverage: COVERAGE.FULL, wetland_intersects: true,
    wetland_nearest_m: 12.5, wetland_area_250_m2: 10, wetland_area_500_m2: 20, wetland_area_1000_m2: 30,
    wetland_count_250: 1, wetland_count_500: 2, wetland_count_1000: 3, wetland_type_summary: 'Freshwater Emergent Wetland 30',
    hydro_crossing_count: 2, hydro_nearest_flowing_m: 0, hydro_nearest_standing_m: null,
    hydro_flowline_length_1000_m: 400, hydro_waterbody_area_1000_m2: 0, hydro_summary: 'Creek A | Creek B',
    coverage: COVERAGE.FULL, coverage_wetlands_250: COVERAGE.FULL, coverage_wetlands_500: COVERAGE.FULL,
    coverage_wetlands_1000: COVERAGE.FULL, coverage_hydro_250: COVERAGE.FULL, coverage_hydro_500: COVERAGE.FULL,
    coverage_hydro_1000: COVERAGE.FULL, min_lon: Math.min(...lons), min_lat: Math.min(...lats),
    max_lon: Math.max(...lons), max_lat: Math.max(...lats), geometry: { type: 'LineString', coordinates } };
}

function scopeFor(rows, bounds) {
  const asked = [];
  return { asked, scope: { derived: true, fingerprint: 'f'.repeat(64),
    selection: Object.freeze({ coverage: COVERAGE.FULL, reason: null, bounds, cells: [], present: [], bytes: 12,
      counts: { cells: 1, present: 1, empty: 0 } }),
    manifest: { cells: 1, present: 1, empty: 0, counts: {} },
    timing: Object.freeze({ manifestMs: 1, selectionMs: 1, totalPreparationMs: 2, fetchMs: 1, verifyMs: 1, registerMs: 0,
      downloadedBytes: 12, cacheHits: 0, registeredCells: 1 }),
    provenance: Object.freeze({ source: 'Precomputed from verified regional GIS', analysisFingerprint: 'f'.repeat(64) }),
    async queryDerivedCorridors() { asked.push('queryDerivedCorridors'); return { rows, rowCount: rows.length, queryMs: 3 }; } } };
}

test('an interactive search keeps the exact radius: the box selects cells, the disk selects corridors', async () => {
  const definition = searchDefinitionOf([-122.92, 45.595], 10);
  const area = createInteractiveSearchArea(definition, { template: radiusTemplate(declaration) });
  const radiusM = definition.radiusM;
  const east = distanceM => [-122.92 + distanceM * LON_PER_M, 45.595];
  // The margin is deliberately generous: the radius arithmetic is a metre-class approximation, so this test
  // asserts the rule (inside the disk is kept, outside is dropped) rather than a metre of that arithmetic.
  const inside = derivedRow('drv1-inside-rd-s1', [east(radiusM - 500), east(radiusM - 300)]);
  const outside = derivedRow('drv1-outside-rd-s1', [east(radiusM + 500), east(radiusM + 700)]);
  // The square-corner case: inside the bounding box the cells are chosen with, outside the 10-mile disk.
  const corner = derivedRow('drv1-corner-rd-s1', [[definition.bounds[2] - 0.002, definition.bounds[3] - 0.002],
    [definition.bounds[2] - 0.001, definition.bounds[3] - 0.001]]);
  const { scope, asked } = scopeFor([inside, outside, corner], definition.bounds);
  const run = await runDiscovery({ gis: {
    async prepareDerivedSearch(searchArea) {
      assert.deepEqual([...searchArea.bbox], [...definition.bounds], 'the definition is the box the runtime selects with');
      return scope;
    } }, searchArea: area });
  assert.equal(run.status, 'ready');
  assert.equal(run.derived, true);
  assert.deepEqual(asked, ['queryDerivedCorridors']);
  assert.deepEqual(run.results.map(result => result.id), ['drv1-inside-rd-s1']);
  assert.equal(run.diagnostics.searchShape.kind, 'radius');
  assert.deepEqual(run.diagnostics.searchShape.center, definition.center, 'the run reports the centre that was chosen');
  assert.equal(run.diagnostics.searchShape.radiusMiles, 10);
  assert.equal(run.diagnostics.searchShape.radiusM, radiusM);
  assert.equal(run.searchArea.id, CUSTOM_SEARCH_AREA_ID);
  assert.equal(run.searchArea.catalogUrl, radiusTemplate(declaration).catalogUrl);
  assert.equal(run.coverage.coverage, COVERAGE.FULL);
});

test('a search whose circle cannot reach the published region is refused before any metric cell is read', async () => {
  const template = radiusTemplate(declaration);
  const outside = searchDefinitionOf([-120.0, 43.0], 25);
  const outsideArea = createInteractiveSearchArea(outside, { template });
  // The interface knows first: this definition is valid input whose search cannot be answered, so the search
  // button is disabled with the reason instead of offering a survey that would come back empty.
  assert.equal(searchIsRunnable({ ok: true, coverage: searchRegionCoverage(outside, REGION) }), false);
  assert.match(searchRegionCoverage(outside, REGION).reason, /does not overlap the published/);
  const offered = [];
  // The reader refuses the same box with the real published manifest, and fetches no cell to say so.
  const refusing = { async prepareDerivedSearch(searchArea) {
    offered.push([...searchArea.bbox]);
    const selection = selectDerivedCells(derivedManifest, searchArea.bbox);
    if (selection.coverage === COVERAGE.NONE) {
      const error = new Error(selection.reason);
      error.coverage = COVERAGE.NONE;
      throw error;
    }
    return scopeFor([], searchArea.bbox).scope;
  } };
  await assert.rejects(() => runDiscovery({ gis: refusing, searchArea: outsideArea }), /outside the published derived coverage/);
  assert.equal(offered.length, 1, 'the box is offered once and refused without reading a cell');
  // The same path with a centre that does reach the region runs normally, and its coverage is the search
  // coverage the reader reported.
  const definition = searchDefinitionOf([-122.92, 45.595], 10);
  const row = derivedRow('drv1-inside-rd-s1', [[-122.92 + 100 * LON_PER_M, 45.595], [-122.92 + 200 * LON_PER_M, 45.595]]);
  const run = await runDiscovery({ searchArea: createInteractiveSearchArea(definition, { template }), gis: {
    async prepareDerivedSearch(searchArea) {
      assert.equal(selectDerivedCells(derivedManifest, searchArea.bbox).coverage, COVERAGE.FULL);
      return scopeFor([row], searchArea.bbox).scope;
    } } });
  assert.equal(run.status, 'ready');
  assert.equal(run.derived, true);
  assert.equal(run.coverage.searchCoverage.coverage, COVERAGE.FULL);
  assert.deepEqual(run.results.map(result => result.id), ['drv1-inside-rd-s1']);
});
