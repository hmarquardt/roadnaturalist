import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { COVERAGE } from '../src/domain/corridor.js';
import { selectDerivedCells, validateDerivedManifest } from '../src/discovery/derived-catalog.js';
import { validateRegionalCatalog } from '../src/discovery/regional-catalog.js';
import { validateSearchAreas } from '../src/discovery/search-area.js';
import { MAX_PLACE_RESULTS, MIN_PLACE_QUERY_LENGTH, PLACE_GAZETTEER_KIND, PLACE_GAZETTEER_SCHEMA_VERSION,
  normalizePlaceText, placeEditDistanceWithinOne, placeLabel, placeMetadata, placeSearchBounds, placeTypeLabel,
  regionDistanceM, searchPlaces, splitPlaceStateQualifier, storedPlaceMetadata, validatePlaceGazetteer } from '../src/discovery/place-gazetteer.js';
import { addSearchHistory, placeForSearch, readSearchDefinition, searchDefinitionOf, searchRegionCoverage,
  searchIsRunnable, storedHistory } from '../src/discovery/search-definition.js';
import { createInteractiveSearchArea, radiusTemplate } from '../src/discovery/search-definition.js';
import { runDiscovery } from '../src/discovery/run.js';

// The regional place gazetteer: a small committed artifact reduced offline from a pinned U.S. Census Bureau
// source (scripts/build-places.py), a deterministic local matcher, and the proof that choosing a place is the
// same search as typing its coordinates. These tests hold the artifact to what it declares, the matcher to
// what it promises, and the integration to the runtime's own semantics.
const MI = 1609.344;
const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url)));
const declaration = validateSearchAreas(JSON.parse(readFileSync(new URL('../data/discovery/search-areas.json', import.meta.url))), manifest);
const catalog = validateRegionalCatalog(JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url))));
const derivedManifest = validateDerivedManifest(JSON.parse(readFileSync(new URL(`../data/${catalog.derived.localPath}`, import.meta.url))));
const REGION = declaration.publishedRegion;
const gazetteerPath = new URL('../data/places/or-sw-wa-portland-places.json', import.meta.url);
const gazetteerBytes = readFileSync(gazetteerPath);
const gazetteer = validatePlaceGazetteer(JSON.parse(gazetteerBytes), { region: REGION });
const report = JSON.parse(readFileSync(new URL('../data/places/build-or-sw-wa-portland-places.json', import.meta.url)));
const PLACE_FIELDS = ['center', 'featureClass', 'id', 'name', 'state', 'stateName'];

function find(query, limit) {
  return searchPlaces(gazetteer, query, limit == null ? {} : { limit });
}

function example(name, state) {
  return gazetteer.places.find(place => place.name === name && place.state === state);
}

// ------------------------------------------------------------------ the committed artifact

test('the committed gazetteer is the artifact this build declares, with its source pinned', () => {
  assert.equal(gazetteer.kind, PLACE_GAZETTEER_KIND);
  assert.equal(gazetteer.schemaVersion, PLACE_GAZETTEER_SCHEMA_VERSION);
  assert.ok(gazetteer.version);
  for (const key of ['agency', 'dataset', 'url', 'license', 'archiveSha256', 'memberSha256', 'publicationDate']) {
    assert.ok(gazetteer.source[key], `the artifact must carry its source ${key}`);
  }
  assert.match(gazetteer.source.url, /^https:\/\/www2\.census\.gov\//);
  assert.match(gazetteer.source.archiveSha256, /^[a-f0-9]{64}$/);
  assert.match(gazetteer.source.memberSha256, /^[a-f0-9]{64}$/);
  assert.match(gazetteer.source.license, /Public domain/);
  // The build report is the artifact's digest record, and it must describe the same source.
  assert.equal(report.artifact.sha256, createHash('sha256').update(gazetteerBytes).digest('hex'));
  assert.equal(report.artifact.bytes, gazetteerBytes.length);
  assert.equal(report.artifact.places, gazetteer.places.length);
  assert.equal(report.source.archiveSha256, gazetteer.source.archiveSha256);
  assert.equal(report.source.memberSha256, gazetteer.source.memberSha256);
  assert.equal(report.extraction.places, gazetteer.places.length);
  assert.ok(gazetteerBytes.length < 200 * 1024, 'a place gazetteer this bounded belongs on Pages, not on R2');
});

test('the window is the published region plus a 50-mile margin, and every place is inside the reach', () => {
  const derived = placeSearchBounds(REGION.bounds, gazetteer.scope.marginMiles);
  assert.equal(gazetteer.scope.marginMiles, 50);
  for (const [index, value] of derived.bounds.entries()) {
    assert.ok(Math.abs(value - gazetteer.scope.bounds[index]) < 1e-9, `window edge ${index} must be the derived one`);
  }
  // The margin really is 50 miles on both axes: the rectangle is a sure outer bound on the reach.
  const latMiles = (gazetteer.scope.bounds[3] - REGION.bounds[3]) * 110540 / MI;
  assert.ok(latMiles >= 50 && latMiles < 51, `latitude margin is ${latMiles.toFixed(3)} mi`);
  const lonMetres = (gazetteer.scope.bounds[2] - REGION.bounds[2]) * 111320
    * Math.cos(gazetteer.scope.derivation.longitudeMarginReferenceLat * Math.PI / 180);
  assert.ok(lonMetres / MI >= 50 && lonMetres / MI < 51, `longitude margin is ${(lonMetres / MI).toFixed(3)} mi`);
  assert.ok(gazetteer.scope.bounds[0] < REGION.bounds[0] && gazetteer.scope.bounds[1] < REGION.bounds[1]
    && gazetteer.scope.bounds[2] > REGION.bounds[2] && gazetteer.scope.bounds[3] > REGION.bounds[3],
    'the window contains the published region, it does not clip it');
  // The rule inside the rectangle is the distance, so no place is a dead end: every place in the artifact is
  // within a 50-mile search of published coverage.
  let farthest = { miles: 0 };
  for (const place of gazetteer.places) {
    assert.ok(place.center[0] >= gazetteer.scope.bounds[0] && place.center[0] <= gazetteer.scope.bounds[2]
      && place.center[1] >= gazetteer.scope.bounds[1] && place.center[1] <= gazetteer.scope.bounds[3],
      `${place.name} lies outside the declared window`);
    const miles = regionDistanceM(place.center, REGION.bounds) / MI;
    assert.ok(miles <= gazetteer.scope.marginMiles + 1e-6, `${placeLabel(place)} is ${miles.toFixed(2)} mi from the region`);
    if (miles > farthest.miles) farthest = { miles, label: placeLabel(place) };
  }
  assert.ok(farthest.miles > 45, `the window holds places at its edge (farthest ${farthest.label} at ${farthest.miles.toFixed(2)} mi)`);
  assert.deepEqual(gazetteer.scope.publishedRegion.bounds, REGION.bounds);
  assert.deepEqual(report.scope.bounds, gazetteer.scope.bounds);
  assert.match(gazetteer.scope.inclusion, /within the margin/);
});

test('place identity is the source id, the declared states and the declared classes', () => {
  const ids = new Set(), prefixes = new Map(), classes = new Map();
  for (const place of gazetteer.places) {
    assert.match(place.id, /^[0-9]{7}$/);
    assert.ok(!ids.has(place.id), `duplicate place id ${place.id}`);
    ids.add(place.id);
    assert.deepEqual(Object.keys(place).sort(), PLACE_FIELDS, `${place.id} carries fields the artifact does not declare`);
    assert.ok(place.name.trim() && place.name === place.name.trim());
    assert.ok(!/ (city|town|CDP)$/.test(place.name), `${place.id} still carries its class suffix`);
    assert.equal(place.stateName, gazetteer.scope.includedStates[place.state]);
    assert.ok(Object.values(gazetteer.scope.includedFeatureClasses).includes(place.featureClass));
    classes.set(place.featureClass, (classes.get(place.featureClass) ?? 0) + 1);
    if (prefixes.has(place.state)) assert.equal(prefixes.get(place.state), place.id.slice(0, 2), 'a state keeps one FIPS prefix');
    else prefixes.set(place.state, place.id.slice(0, 2));
    assert.ok(Number.isFinite(place.center[0]) && Number.isFinite(place.center[1]));
    assert.ok(Math.abs(place.center[0]) < 180 && Math.abs(place.center[1]) < 90);
  }
  assert.equal(new Set(prefixes.values()).size, prefixes.size, 'two states cannot share a FIPS prefix');
  assert.equal(classes.size, Object.keys(gazetteer.scope.includedFeatureClasses).length, 'every declared class is present');
  assert.deepEqual([...classes.keys()].sort(), Object.values(gazetteer.scope.includedFeatureClasses).sort());
  assert.equal(gazetteer.scope.counts.places, gazetteer.places.length);
  assert.equal(gazetteer.scope.counts.byClass.city, classes.get('city'));
});

test('duplicate place names are kept and are distinguishable by state and class', () => {
  const groups = new Map();
  for (const place of gazetteer.places) {
    const key = normalizePlaceText(place.name);
    groups.set(key, [...(groups.get(key) ?? []), place]);
  }
  const duplicates = [...groups.entries()].filter(([, places]) => places.length > 1);
  assert.ok(duplicates.length >= 4, `expected real duplicate names in the region, found ${duplicates.length}`);
  const toledo = groups.get('toledo');
  assert.deepEqual(toledo.map(place => place.state).sort(), ['OR', 'WA']);
  const fairview = groups.get('fairview');
  assert.deepEqual(fairview.map(place => place.featureClass).sort(), ['cdp', 'city'], 'a same-state pair is told apart by class');
  assert.deepEqual(fairview.map(place => place.state), ['OR', 'OR']);
});

// ------------------------------------------------------------------ matching

test('normalization is deterministic, and it only rewrites what it documents', () => {
  assert.equal(normalizePlaceText('  Hillsboro  '), 'hillsboro');
  assert.equal(normalizePlaceText('HILLSBORO'), 'hillsboro');
  assert.equal(normalizePlaceText('Forest   Grove'), 'forest grove');
  assert.equal(normalizePlaceText('St. Helens'), 'saint helens');
  assert.equal(normalizePlaceText('Saint Helens'), 'saint helens');
  assert.equal(normalizePlaceText('West Haven-Sylvan'), 'west haven sylvan');
  assert.equal(normalizePlaceText('Mt. Angel'), 'mount angel');
  assert.equal(normalizePlaceText("O'Connell"), 'o connell');
  assert.equal(normalizePlaceText('San José'), 'san jose', 'Unicode NFKD folding, no accent left behind');
  assert.equal(normalizePlaceText('Ｈｉｌｌｓｂｏｒｏ'), 'hillsboro', 'fullwidth forms fold to plain letters');
  assert.equal(normalizePlaceText('Hillsboro, OR'), 'hillsboro or', 'punctuation becomes a separator');
  assert.equal(normalizePlaceText(''), '');
  assert.equal(normalizePlaceText(null), '');
  assert.equal(normalizePlaceText('  --  '), '');
  // Nothing else is rewritten: distinct names stay distinct, and no alias list is invented.
  assert.notEqual(normalizePlaceText('Fairview'), normalizePlaceText('Fairview Heights'));
  assert.equal(normalizePlaceText('Vancouver'), 'vancouver');
});

test('matching is exact, case-insensitive and whitespace-tolerant', () => {
  for (const query of ['hillsboro', 'Hillsboro', 'HILLSBORO', '  Hillsboro ', ' hillsboro']) {
    const found = find(query);
    assert.equal(found.status, 'ok', query);
    assert.equal(found.tier, 'exact', query);
    assert.equal(placeLabel(found.results[0]), 'Hillsboro, OR');
  }
  const forestGrove = find('  forest   grove  ');
  assert.equal(forestGrove.tier, 'exact');
  assert.equal(placeLabel(forestGrove.results[0]), 'Forest Grove, OR');
  assert.equal(placeTypeLabel(forestGrove.results[0]), 'City');
});

test('prefix and word-prefix searches stay explainable and deterministic', () => {
  const prefix = find('hills');
  assert.equal(prefix.tier, 'prefix');
  assert.equal(placeLabel(prefix.results[0]), 'Hillsboro, OR');
  const word = find('grove');
  assert.equal(word.tier, 'word-prefix');
  const labels = word.results.map(placeLabel);
  assert.ok(labels.includes('Forest Grove, OR'));
  assert.ok(labels.includes('Oak Grove, OR'));
  assert.deepEqual(labels, [...labels].sort((left, right) => left.length - right.length || left.localeCompare(right)),
    'shorter names first, then alphabetical: no hidden relevance model');
  assert.deepEqual(find('grove').results.map(place => place.id), word.results.map(place => place.id));
});

test('a state qualifier narrows a duplicate name, and the query is still the place name', () => {
  const both = find('toledo');
  assert.equal(both.tier, 'exact');
  assert.deepEqual(both.results.map(placeLabel), ['Toledo, OR', 'Toledo, WA']);
  assert.equal(both.state, null);
  for (const query of ['toledo wa', 'toledo, wa', 'toledo washington', 'Toledo, Washington']) {
    const found = find(query);
    assert.equal(found.status, 'ok', query);
    assert.deepEqual(found.results.map(placeLabel), ['Toledo, WA'], query);
    assert.equal(found.state, 'WA', query);
    assert.equal(found.text, 'toledo', query);
  }
  for (const query of ['toledo or', 'toledo oregon']) {
    assert.deepEqual(find(query).results.map(placeLabel), ['Toledo, OR'], query);
  }
  // A qualifier that matches nothing is not a place name either: no guess, no fallback.
  assert.equal(find('toledo id').status, 'none');
  // A same-state duplicate is separated by its class label rather than by a number.
  const fairview = find('fairview').results.map(place => `${placeLabel(place)} · ${placeTypeLabel(place)}`);
  assert.deepEqual(fairview, ['Fairview, OR · City', 'Fairview, OR · Census-designated place']);
});

test('a query that matches nothing says so, and an address is not parsed', () => {
  for (const query of ['zzzzzz', 'xqzwv', 'nowhere at all', '123 main st', '123 Main Street, Hillsboro, OR 97123']) {
    const found = find(query);
    assert.equal(found.status, 'none', query);
    assert.deepEqual(found.results, [], query);
    assert.equal(found.message, 'No matching place found.', query);
  }
});

test('a short query is refused rather than guessed at', () => {
  for (const query of ['', 'h', 'hi', ' o', '--']) {
    const found = find(query);
    assert.equal(found.status, 'too-short', JSON.stringify(query));
    assert.deepEqual(found.results, []);
    assert.match(found.message, new RegExp(`at least ${MIN_PLACE_QUERY_LENGTH} characters`));
  }
  // A state code on its own is a qualifier with no name, not a place.
  assert.equal(find('wa').status, 'too-short');
  // The minimum is measured against the real list: three characters keep the list short.
  assert.ok(find('hills').results.length <= MAX_PLACE_RESULTS);
});

test('a single typo is tolerated inside a real name, and nothing else is', () => {
  for (const [query, expected] of [['hilsboro', 'Hillsboro, OR'], ['hillsburo', 'Hillsboro, OR'],
    ['hillsborro', 'Hillsboro, OR'], ['hillsbro', 'Hillsboro, OR'], ['sheridann', 'Sheridan, OR'],
    ['vernoniaa', 'Vernonia, OR'], ['vancouvar', 'Vancouver, WA']]) {
    const found = find(query);
    assert.equal(found.status, 'ok', query);
    assert.equal(found.tier, 'typo', query);
    assert.equal(placeLabel(found.results[0]), expected, query);
  }
  // The guards: too short to forgive, the wrong first letter, two edits away, or nonsense.
  for (const query of ['hils', 'millboro', 'hilsborro', 'hilsborrow', 'zzzzz']) {
    assert.notEqual(find(query).tier, 'typo', query);
  }
  assert.equal(find('portland').tier, 'exact');
  assert.equal(placeEditDistanceWithinOne('hillsboro', 'hillsboro'), true);
  assert.equal(placeEditDistanceWithinOne('hillsboro', 'hillsbor'), true);
  assert.equal(placeEditDistanceWithinOne('hillsboro', 'hilsboro'), true);
  assert.equal(placeEditDistanceWithinOne('hillsboro', 'hillsburo'), true);
  assert.equal(placeEditDistanceWithinOne('hillsboro', 'hillsboro oregon'), false);
  assert.equal(placeEditDistanceWithinOne('hillsboro', 'millboro'), false);
  assert.equal(placeEditDistanceWithinOne('abc', 'abd'), true);
  assert.equal(placeEditDistanceWithinOne('abc', 'abcd'), true);
  assert.equal(placeEditDistanceWithinOne('abc', 'abcdef'), false);
});

test('the result list is capped, ordered, and every result is a full place', () => {
  const found = find('port');
  assert.equal(found.status, 'ok');
  assert.ok(found.results.length <= MAX_PLACE_RESULTS);
  assert.equal(find('sa').status, 'too-short', 'two characters are refused, however many places they prefix');
  assert.equal(find('s').status, 'too-short', 'one character is never a search');
  assert.ok(find('lake').results.length <= MAX_PLACE_RESULTS);
  assert.ok(find('lake', { limit: 2 }).results.length <= 2);
  for (const place of find('hills').results) {
    assert.deepEqual(Object.keys(place).sort(), PLACE_FIELDS);
    assert.equal(placeTypeLabel(place), 'City');
  }
  assert.equal(placeTypeLabel(example('Aloha', 'OR')), 'Census-designated place');
  assert.equal(placeLabel(example('Aloha', 'OR')), 'Aloha, OR');
  const split = splitPlaceStateQualifier('toledo washington', { qualifiers: new Map([['washington', 'WA']]) });
  assert.deepEqual(split, { text: 'toledo', state: 'WA' });
});

// ------------------------------------------------------------------ a place is the same search as its coordinates

// The one call the interface makes when a place is chosen: read the place centre into an ordinary search
// definition, exactly as typed coordinates would be read (src/app/main.js, selectPlace).
function definitionFor(place, radiusMiles) {
  const result = readSearchDefinition({ lat: place.center[1], lon: place.center[0], radiusMiles }, { region: REGION });
  assert.equal(result.ok, true, `${place.name} must produce a valid search definition`);
  return result.definition;
}

test('a chosen place produces the same definition, bounds and cells as its typed coordinates', () => {
  const cases = [['Hillsboro', 'OR', 10], ['Hillsboro', 'OR', 25], ['Toledo', 'WA', 25], ['Chehalis', 'WA', 50],
    ['Aloha', 'OR', 5], ['St. Helens', 'OR', 25], ['Prairie Ridge', 'WA', 50]];
  for (const [name, state, radiusMiles] of cases) {
    const place = example(name, state);
    assert.ok(place, `${name}, ${state} must be in the gazetteer`);
    const fromPlace = definitionFor(place, radiusMiles);
    const fromCoordinates = searchDefinitionOf(place.center, radiusMiles);
    assert.deepEqual(fromPlace.center, fromCoordinates.center, `${name}: the centre must not drift`);
    assert.deepEqual(fromPlace.center, place.center, `${name}: the definition centre is the published centre`);
    assert.equal(fromPlace.radiusMiles, radiusMiles, `${name}: the radius is the one the control holds`);
    assert.deepEqual([...fromPlace.bounds], [...fromCoordinates.bounds], `${name}: identical bounds`);
    assert.equal(fromPlace.radiusM, fromCoordinates.radiusM);
    const placeCells = selectDerivedCells(derivedManifest, fromPlace.bounds);
    const coordinateCells = selectDerivedCells(derivedManifest, fromCoordinates.bounds);
    assert.deepEqual(placeCells.cells.map(cell => cell.id), coordinateCells.cells.map(cell => cell.id),
      `${name}: identical metric cells`);
    assert.equal(placeCells.bytes, coordinateCells.bytes);
    assert.equal(placeCells.coverage, coordinateCells.coverage);
    assert.equal(searchRegionCoverage(fromPlace, REGION).coverage, searchRegionCoverage(fromCoordinates, REGION).coverage);
  }
  // The published interior point is already at the definition's precision, so nothing is rounded away.
  const hillsboro = example('Hillsboro', 'OR');
  assert.deepEqual(definitionFor(hillsboro, 25).center, [-122.93539, 45.5268]);
});

test('a place keeps honest coverage at the edge, and its radius decides how far the answer reaches', () => {
  const inside = example('Hillsboro', 'OR');
  const edge = example('Toledo', 'WA');          // 1.7 mi north of the published edge
  const near = example('Morton', 'WA');          // 9.4 mi north of it
  const beyond = example('Chehalis', 'WA');      // 16.8 mi north of it
  const farthest = example('Prairie Ridge', 'WA'); // 49.8 mi north of it, inside the window
  assert.equal(searchRegionCoverage(definitionFor(inside, 25), REGION).coverage, COVERAGE.FULL);
  assert.equal(searchRegionCoverage(definitionFor(edge, 25), REGION).coverage, COVERAGE.PARTIAL);
  assert.equal(searchRegionCoverage(definitionFor(edge, 10), REGION).coverage, COVERAGE.PARTIAL);
  assert.equal(searchRegionCoverage(definitionFor(near, 25), REGION).coverage, COVERAGE.PARTIAL);
  // A place farther out than the chosen radius is NONE, and the search is refused; widening the radius is the
  // user's decision, and the interface never makes it for them.
  for (const [place, radiusMiles] of [[beyond, 10], [farthest, 10], [beyond, 5]]) {
    const coverage = searchRegionCoverage(definitionFor(place, radiusMiles), REGION);
    assert.equal(coverage.coverage, COVERAGE.NONE, `${placeLabel(place)} at ${radiusMiles} mi`);
    assert.equal(searchIsRunnable({ ok: true, coverage }), false, 'a place is not a bypass around coverage');
    assert.equal(definitionFor(place, radiusMiles).radiusMiles, radiusMiles, 'the radius is never quietly reduced');
  }
  // The same place with a radius that reaches is a usable search: the window exists so that every place in it
  // can reach published coverage at the largest radius the interface offers.
  assert.notEqual(searchRegionCoverage(definitionFor(beyond, 25), REGION).coverage, COVERAGE.NONE);
  const unreachable = gazetteer.places.filter(place =>
    searchRegionCoverage(definitionFor(place, 50), REGION).coverage === COVERAGE.NONE);
  assert.deepEqual(unreachable.map(place => placeLabel(place)), [],
    'every place in the window must be able to reach published coverage at 50 miles');
  const outsideAtTen = gazetteer.places.filter(place => searchRegionCoverage(definitionFor(place, 10), REGION).coverage !== COVERAGE.FULL);
  assert.ok(outsideAtTen.length > 20, `places outside the region keep their own coverage answer (${outsideAtTen.length} at 10 mi)`);
});

// A minimal derived row: the columns the derived reader maps into a discovery result, with a geometry of this
// test's choosing. The derived-plane tests own the full row shape; this exists to prove that a search built
// from a place is filtered by the same exact-radius rule as one built from coordinates.
function row(id, coordinates) {
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

test('a place search runs the same derived discovery as the same coordinates typed by hand', async () => {
  const template = radiusTemplate(declaration);
  const place = example('Hillsboro', 'OR');
  const definition = definitionFor(place, 25);
  const near = [[place.center[0] + 0.001, place.center[1]], [place.center[0] + 0.002, place.center[1]]];
  // Inside the selection box the cells are chosen with, and outside the 25-mile disk: a square search wearing
  // a radius label would return it, so this is the exact-radius rule under a place-built area.
  const corner = [[definition.bounds[2] - 0.002, definition.bounds[3] - 0.002],
    [definition.bounds[2] - 0.001, definition.bounds[3] - 0.001]];
  const scope = { derived: true, fingerprint: 'f'.repeat(64),
    selection: Object.freeze({ coverage: COVERAGE.FULL, reason: null, bounds: definition.bounds, cells: [], present: [], bytes: 12,
      counts: { cells: 1, present: 1, empty: 0 } }),
    manifest: { cells: 1, present: 1, empty: 0, counts: {} },
    timing: Object.freeze({ manifestMs: 1, selectionMs: 1, totalPreparationMs: 2, fetchMs: 1, verifyMs: 1, registerMs: 0,
      downloadedBytes: 12, cacheHits: 0, registeredCells: 1 }),
    provenance: Object.freeze({ source: 'Precomputed from verified regional GIS', analysisFingerprint: 'f'.repeat(64) }),
    async queryDerivedCorridors() { return { rows: [row('drv1-near-rd-s1', near), row('drv1-corner-rd-s1', corner)],
      rowCount: 2, queryMs: 1 }; } };
  const gis = { async prepareDerivedSearch(searchArea) {
    assert.deepEqual([...searchArea.bbox], [...definition.bounds]);
    return scope;
  } };
  const fromPlace = await runDiscovery({ gis, searchArea: createInteractiveSearchArea(definition, { template }) });
  const fromCoordinates = await runDiscovery({ gis, searchArea: createInteractiveSearchArea(searchDefinitionOf(place.center, 25), { template }) });
  assert.equal(fromPlace.status, 'ready');
  assert.deepEqual(fromPlace.results.map(result => result.id), ['drv1-near-rd-s1'],
    'the disk still decides: a place centre does not turn the search into a box');
  assert.deepEqual(fromPlace.results.map(result => result.id), fromCoordinates.results.map(result => result.id));
  assert.deepEqual(fromPlace.results, fromCoordinates.results, 'place and coordinates produce the same result rows');
  assert.deepEqual(fromPlace.diagnostics.searchShape.center, place.center);
  assert.equal(fromPlace.diagnostics.searchShape.radiusMiles, 25);
  assert.equal(fromPlace.diagnostics.derivedSelection.cells.cells, scope.selection.counts.cells);
});

// ------------------------------------------------------------------ a label beside a search, never in it

test('a place is presentation metadata beside a search, and the coordinates stay the search', () => {
  const place = example('Hillsboro', 'OR');
  const definition = definitionFor(place, 25);
  const metadata = placeMetadata(place);
  assert.deepEqual(metadata, { id: '4134100', label: 'Hillsboro, OR', featureClass: 'city' });
  // The definition itself holds no place name, id or class: it is only ever a centre and a radius.
  assert.deepEqual(Object.keys(definition).sort(), ['bounds', 'center', 'kind', 'radiusM', 'radiusMiles', 'version']);
  assert.equal('place' in definition, false);
  assert.equal('label' in definition, false);
  let history = addSearchHistory([], definition, { at: '2026-01-01T00:00:00.000Z', place: metadata });
  assert.deepEqual(history[0].place, metadata);
  assert.deepEqual(history[0].center, definition.center, 'a remembered search still carries its coordinates');
  assert.equal(history[0].radiusMiles, 25);
  assert.equal(history[0].at, '2026-01-01T00:00:00.000Z');
  // Changing the radius keeps the label, because the centre did not move.
  history = addSearchHistory(history, searchDefinitionOf(place.center, 50), { place: metadata });
  assert.deepEqual(storedHistory(history).map(entry => entry.place?.label), ['Hillsboro, OR', 'Hillsboro, OR']);
  // Re-running the same search by coordinates drops the label: it described a place that is no longer the input.
  history = addSearchHistory(history, searchDefinitionOf(place.center, 25));
  assert.equal(history[0].place, undefined);
  assert.equal(placeForSearch(history, searchDefinitionOf(place.center, 25)), null);
  assert.equal(placeForSearch(history, searchDefinitionOf(place.center, 50))?.label, 'Hillsboro, OR',
    'the label is recovered for the search it belongs to');
  assert.equal(placeForSearch(history, searchDefinitionOf([-122.5, 45.4], 25)), null);
});

test('changing the radius re-derives the bounds: a definition is never a stale box', () => {
  // The failure this guards against: a radius control that changes the number but keeps the box, so the
  // search selects cells for the old radius and the coverage line answers for the wrong area.
  const place = example('Chehalis', 'WA');
  const atTen = definitionFor(place, 10);
  const atTwentyFive = searchDefinitionOf(atTen.center, 25);
  assert.deepEqual([...atTwentyFive.bounds], [...definitionFor(place, 25).bounds]);
  assert.notDeepEqual([...atTwentyFive.bounds], [...atTen.bounds]);
  assert.equal(atTen.radiusM, 10 * MI);
  assert.equal(atTwentyFive.radiusM, 25 * MI);
  assert.equal(searchRegionCoverage(atTen, REGION).coverage, COVERAGE.NONE);
  assert.equal(searchRegionCoverage(atTwentyFive, REGION).coverage, COVERAGE.PARTIAL);
  const stale = { ...atTen, radiusMiles: 25 };
  assert.notDeepEqual([...stale.bounds], [...atTwentyFive.bounds]);
  assert.equal(searchRegionCoverage(stale, REGION).coverage, COVERAGE.NONE,
    'a spread definition answers for the old radius, which is why a radius change builds a new definition');
  // Every published place keeps this invariant at every radius the interface offers.
  for (const radiusMiles of [1, 10, 25, 50]) {
    for (const sample of gazetteer.places.slice(0, 40)) {
      const definition = definitionFor(sample, radiusMiles);
      assert.deepEqual([...definition.bounds], [...searchDefinitionOf(definition.center, radiusMiles).bounds]);
      assert.equal(definition.radiusM, radiusMiles * MI);
    }
  }
});

test('place metadata is optional, validated, and its absence never breaks a search', () => {
  assert.equal(storedPlaceMetadata({ id: '4134100', label: 'Hillsboro, OR' }).label, 'Hillsboro, OR');
  assert.equal(storedPlaceMetadata({ id: '4134100', label: 'Hillsboro, OR', featureClass: 'city' }).featureClass, 'city');
  assert.equal(storedPlaceMetadata({ id: '4134100', label: 'Hillsboro, OR', featureClass: 'metropolis' }).featureClass, null);
  assert.equal(storedPlaceMetadata({ id: 'x', label: 'Nope' }), null);
  assert.equal(storedPlaceMetadata({ id: '4134100' }), null);
  assert.equal(storedPlaceMetadata({ id: '4134100', label: '   ' }), null);
  assert.equal(storedPlaceMetadata({ id: '4134100', label: 'h'.repeat(200) }), null);
  assert.equal(storedPlaceMetadata('<script>'), null);
  assert.equal(storedPlaceMetadata(null), null);
  // A stored label that is junk is dropped, and the coordinates it sat beside still work.
  const place = example('Hillsboro', 'OR');
  const dirty = storedHistory([{ center: place.center, radiusMiles: 25, at: '2026-01-01T00:00:00.000Z',
    place: { id: 'not-an-id', label: 'Hillsboro, OR' } }]);
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].place, undefined);
  assert.deepEqual(dirty[0].center, place.center);
  const recovered = searchDefinitionOf(dirty[0].center, dirty[0].radiusMiles);
  assert.deepEqual(recovered.center, definitionFor(place, 25).center, 'the coordinate search survives the lost label');
});
