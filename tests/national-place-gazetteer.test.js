import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_NATIONAL_PLACE_NAME_LENGTH, NATIONAL_PLACE_TIERS, createPlaceLibrary, nearestPlace,
  normalizePlaceText, parsePlaceQuery, placeDetail, placeLabel, placeMetadata, placeTypeLabel,
  searchPlaces, storedPlaceMetadata, validateNationalPlaceGazetteer,
} from '../src/discovery/place-gazetteer.js';
import { readSearchDefinition, searchDefinitionOf } from '../src/discovery/search-definition.js';
import { selectDerivedCells, validateDerivedManifest } from '../src/discovery/derived-catalog.js';

// THE NATIONAL PLACE GAZETTEER.
//
// One lookup, three tiers, no geocoder. These tests hold the three things that make it usable nationwide: the
// names people type resolve to the right place (ranking, state qualifiers, counties, ZIP codes), a name that
// collides stays distinguishable, and every result becomes the ordinary search definition the rest of the
// application already trusts. The committed artifacts are the subject, not a fixture: the counts, the reference
// places and the ids are read out of the files the browser loads.
const CORE = validateNationalPlaceGazetteer(JSON.parse(readFileSync(
  new URL('../data/places/national-places.json', import.meta.url))));
const POSTAL = validateNationalPlaceGazetteer(JSON.parse(readFileSync(
  new URL('../data/places/national-places-zip.json', import.meta.url))));
const COMMUNITY = validateNationalPlaceGazetteer(JSON.parse(readFileSync(
  new URL('../data/places/national-places-communities.json', import.meta.url))));
const REPORT = JSON.parse(readFileSync(new URL('../data/places/build-national-places.json', import.meta.url)));
const FIXTURE = JSON.parse(readFileSync(new URL('../data/places/place-normalization-fixture.json', import.meta.url)));

const core = () => createPlaceLibrary([CORE]);
const all = () => createPlaceLibrary([CORE, POSTAL, COMMUNITY]);
const names = outcome => outcome.results.map(place => `${place.name}, ${place.state}`);
const REGIONS = Object.freeze({
  'Pacific Northwest': ['portland oregon', 'Portland, OR'],
  Northeast: ['boston massachusetts', 'Boston, MA'],
  'Gulf/Southeast': ['miami florida', 'Miami, FL'],
  'Midwest/Great Lakes': ['minneapolis minnesota', 'Minneapolis, MN'],
  'Great Plains': ['omaha nebraska', 'Omaha, NE'],
  Southwest: ['phoenix arizona', 'Phoenix, AZ'],
});

test('the committed tiers declare the national schema, with the dictionaries they share', () => {
  for (const [label, document] of [['core', CORE], ['postal', POSTAL], ['community', COMMUNITY]]) {
    assert.equal(document.kind, 'road-discovery-place-gazetteer', `${label} kind`);
    assert.equal(document.schemaVersion, 2, `${label} schema version`);
    assert.deepEqual(document.columns, ['id', 'name', 'state', 'county', 'lat', 'lon', 'type', 'population',
      'prominence', 'source'], `${label} column order`);
    assert.deepEqual(document.scope.bounds, [-124.848974, 24.396308, -66.885444, 49.384479], `${label} coverage`);
    assert.ok(Object.keys(document.sources).length, `${label} declares its sources`);
    for (const [key, source] of Object.entries(document.sources)) {
      for (const field of ['agency', 'dataset', 'url', 'sha256', 'license', 'usage']) {
        assert.ok(source[field], `${label} source ${key} declares ${field}`);
      }
    }
    assert.ok(document.rows.length, `${label} has rows`);
    assert.equal(document.rows.length, REPORT.artifacts[label === 'core' ? 'core' : label === 'postal' ? 'postalCode' : 'community'].jsonRows);
  }
  // The tiers must share one dictionary ordering, or merging them would reinterpret every index.
  assert.deepEqual(CORE.dictionaries, POSTAL.dictionaries);
  assert.deepEqual(CORE.dictionaries, COMMUNITY.dictionaries);
  assert.equal(CORE.scope.tier, 'core');
  assert.equal(POSTAL.scope.tier, 'postal');
  assert.equal(COMMUNITY.scope.tier, 'community');
});

test('a malformed national document is refused rather than half-read', () => {
  const clone = () => JSON.parse(JSON.stringify(CORE));
  const wrongKind = clone(); wrongKind.kind = 'something else';
  assert.throws(() => validateNationalPlaceGazetteer(wrongKind), /Not a national place gazetteer document/);
  const wrongSchema = clone(); wrongSchema.schemaVersion = 1;
  // A schema-1 document is the regional artifact's shape and must not be read as this one.
  assert.throws(() => validateNationalPlaceGazetteer(wrongSchema), /Not a national place gazetteer document/);
  const wrongColumns = clone(); wrongColumns.columns = [...wrongColumns.columns].reverse();
  assert.throws(() => validateNationalPlaceGazetteer(wrongColumns), /unexpected column order/);
  const noRows = clone(); noRows.rows = [];
  assert.throws(() => validateNationalPlaceGazetteer(noRows), /carries no rows/);
  const badId = clone(); badId.rows[0][0] = 'no-prefix';
  assert.throws(() => validateNationalPlaceGazetteer(badId), /Invalid national place id/);
  const duplicate = clone(); duplicate.rows[1][0] = duplicate.rows[0][0];
  assert.throws(() => validateNationalPlaceGazetteer(duplicate), /Invalid national place id/);
  const outOfRange = clone(); outOfRange.rows[0][2] = 999;
  assert.throws(() => validateNationalPlaceGazetteer(outOfRange), /names no state/);
  const noCoordinate = clone(); noCoordinate.rows[0][4] = 'north';
  assert.throws(() => validateNationalPlaceGazetteer(noCoordinate), /has no coordinate/);
  const longName = clone(); longName.rows[0][1] = 'x'.repeat(MAX_NATIONAL_PLACE_NAME_LENGTH + 1);
  assert.throws(() => validateNationalPlaceGazetteer(longName), /Invalid national place name/);
  // A library refuses a tier whose dictionaries disagree with the one already loaded: the indices a row carries
  // only mean something against the dictionary they were written with.
  const library = createPlaceLibrary([CORE]);
  const foreign = clone();
  foreign.dictionaries.counties = [...foreign.dictionaries.counties];
  foreign.dictionaries.counties[0] = 'Elsewhere County';
  assert.throws(() => library.add(foreign), /different dictionaries/);
});

// ---------------------------------------------------------------- ranking

test('an exact name with a state qualifier resolves to that state', () => {
  const library = core();
  for (const [query, expected] of [['princeton in', 'Princeton, IN'], ['princeton indiana', 'Princeton, IN'],
    ['cookeville tn', 'Cookeville, TN'], ['cookeville tennessee', 'Cookeville, TN'],
    ['nashville tennessee', 'Nashville, TN'], ['portland oregon', 'Portland, OR'],
    ['moab utah', 'Moab, UT'], ['duluth mn', 'Duluth, MN']]) {
    const outcome = searchPlaces(library, query, { limit: 3 });
    assert.equal(outcome.status, 'ok', query);
    assert.equal(outcome.tier, 'exact', query);
    assert.equal(names(outcome)[0], expected, query);
  }
});

test('a plain name leads with the most populous namesake, and the rest stay distinguishable', () => {
  const library = core();
  const evansville = searchPlaces(library, 'evansville', { limit: 5 });
  assert.equal(names(evansville)[0], 'Evansville, IN');
  assert.ok(evansville.results[0].population > 100000, 'Evansville, Indiana is a city of over 100,000');
  assert.ok(new Set(names(evansville).map(label => label.split(', ')[1])).size > 1, 'other states are offered too');
  // The collision the brief names: three Springfields must stay three different places.
  const springfield = searchPlaces(library, 'springfield', { limit: 8 });
  assert.equal(names(springfield)[0], 'Springfield, MO');
  const states = new Set(names(springfield).map(label => label.split(', ')[1]));
  for (const state of ['MO', 'MA', 'IL', 'OR']) assert.ok(states.has(state), `Springfield, ${state}`);
  assert.equal(new Set(springfield.results.map(place => place.id)).size, springfield.results.length);
});

test('a county, a prefix and a typo each answer in their own tier', () => {
  const library = core();
  const county = searchPlaces(library, 'gibson county indiana', { limit: 3 });
  assert.deepEqual(names(county), ['Gibson County, IN']);
  assert.equal(county.results[0].type, 'county');
  assert.equal(placeDetail(county.results[0]), 'County');
  const prefix = searchPlaces(library, 'great smoky mountains', { limit: 3 });
  assert.equal(prefix.tier, 'prefix');
  assert.equal(names(prefix)[0], 'Great Smoky Mountains National Park, TN');
  assert.equal(prefix.results[0].type, 'national-park');
  const yellowstone = searchPlaces(library, 'yellowstone', { limit: 3 });
  assert.equal(yellowstone.tier, 'prefix');
  // A bare name that is both a division and a place means the place: the park leads, the county is offered below.
  assert.equal(names(yellowstone)[0], 'Yellowstone National Park, WY');
  assert.ok(names(yellowstone).includes('Yellowstone County, MT'), names(yellowstone).join(' | '));
  // Typing the division's own word is unaffected by that rule.
  assert.deepEqual(names(searchPlaces(library, 'yellowstone county montana', { limit: 2 }))[0], 'Yellowstone County, MT');
  assert.deepEqual(names(searchPlaces(library, 'orange county california', { limit: 2 }))[0], 'Orange County, CA');
  // A typo is tolerated inside a real name, and only for a query long enough to mean one.
  assert.equal(names(searchPlaces(library, 'princetn in', { limit: 3 }))[0], 'Princeton, IN');
  assert.equal(searchPlaces(library, 'princetn in', { limit: 3 }).tier, 'typo');
  // Forgiving input: case, punctuation and the documented abbreviations are all the same query.
  for (const query of ['PRINCETON, INDIANA', '  princeton   in  ', 'Princeton, IN']) {
    assert.equal(names(searchPlaces(library, query, { limit: 1 }))[0], 'Princeton, IN', query);
  }
  assert.equal(names(searchPlaces(library, 'st louis missouri', { limit: 1 }))[0], 'St. Louis, MO');
  assert.equal(names(searchPlaces(library, 'ft worth texas', { limit: 1 }))[0], 'Fort Worth, TX');
});

test('the ten reference places resolve, across the six national regions', () => {
  const library = core();
  for (const label of ['Princeton, IN', 'Evansville, IN', 'Nashville, TN', 'Cookeville, TN', 'Portland, OR',
    'Boston, MA', 'Miami, FL', 'Minneapolis, MN', 'Omaha, NE', 'Phoenix, AZ']) {
    const place = library.places.find(candidate => placeLabel(candidate) === label);
    assert.ok(place, `${label} is in the core tier`);
    assert.ok(place.population > 0, `${label} carries a population`);
    assert.ok(place.county && place.county.endsWith('County'), `${label} names its county`);
    assert.ok(place.center[0] > -125 && place.center[0] < -66, `${label} longitude`);
    assert.ok(place.center[1] > 24 && place.center[1] < 50, `${label} latitude`);
  }
  for (const [region, [query, label]] of Object.entries(REGIONS)) {
    const outcome = searchPlaces(library, query, { limit: 1 });
    assert.equal(outcome.status, 'ok', region);
    assert.equal(names(outcome)[0], label, region);
  }
});


// ---------------------------------------------------------------- failure cases

test('nothing found, too short, a malformed code and an unavailable tier are answered honestly', () => {
  const library = core();
  const nonsense = searchPlaces(library, 'zzzz', { limit: 3 });
  assert.equal(nonsense.status, 'none');
  assert.match(nonsense.message, /No place matching "zzzz"/);
  assert.deepEqual(nonsense.results, []);
  const short = searchPlaces(library, 'hi', { limit: 3 });
  assert.equal(short.status, 'too-short');
  assert.match(short.message, /Type at least 3 characters/);
  assert.equal(searchPlaces(library, '', { limit: 3 }).status, 'too-short');
  assert.equal(searchPlaces(library, null, { limit: 3 }).status, 'too-short');
  // A postal code that is not a postal code is a name that does not match, never a guess.
  assert.equal(searchPlaces(library, '4771', { limit: 3 }).status, 'none');
  assert.equal(searchPlaces(library, '47715x', { limit: 3 }).status, 'none');
  assert.equal(searchPlaces(library, '123 Main St', { limit: 3 }).status, 'none');
  // An empty library is unavailable, not empty: the field must say the data is missing rather than that the
  // place does not exist.
  const empty = searchPlaces(createPlaceLibrary([]), 'princeton', { limit: 3 });
  assert.equal(empty.status, 'unavailable');
  assert.match(empty.message, /not available in this build/);
});

test('a postal code answers from its own tier, and nowhere else', () => {
  assert.equal(searchPlaces(core(), '47715', { limit: 3 }).status, 'none', 'the core tier holds no codes');
  const library = all();
  const outcome = searchPlaces(library, '47715', { limit: 3 });
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.tier, 'zip');
  assert.deepEqual(names(outcome), ['47715, IN']);
  assert.equal(placeDetail(outcome.results[0]), 'Indiana · Vanderburgh County');
  // A territory's code is not published, because the derived plane does not cover it, and the answer says so.
  const territory = searchPlaces(library, '00601', { limit: 3 });
  assert.equal(territory.status, 'none');
  assert.match(territory.message, /conterminous United States/);
  assert.equal(parsePlaceQuery('47715 in', library.qualifiers).zip, '47715');
  assert.equal(parsePlaceQuery('47715 in', library.qualifiers).state, 'IN');
  // "new york" is a place, not a state with an empty name.
  assert.equal(parsePlaceQuery('new york', library.qualifiers).state, null);
  assert.deepEqual(names(searchPlaces(library, 'new york', { limit: 1 })), ['New York, NY']);
});

test('the community tier adds the names a Census place file does not carry', () => {
  // The core tier does not carry it: that is exactly why the tier exists.
  assert.equal(core().places.some(place => place.name === 'Adamana'), false);
  const library = all();
  const outcome = searchPlaces(library, 'adamana az', { limit: 3 });
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.results[0].type, 'community');
  assert.deepEqual(names(outcome)[0], 'Adamana, AZ');
  assert.equal(placeDetail(outcome.results[0]), 'Apache County');
  // A Census place wins over the GNIS community with the same name: the build drops the duplicate rather than
  // showing one real place twice.
  const cookeville = searchPlaces(library, 'cookeville tn', { limit: 3 });
  assert.deepEqual(names(cookeville).filter(name => name === 'Cookeville, TN'), ['Cookeville, TN']);
  assert.equal(cookeville.results[0].type, 'city');
  // One row per real place: every tier's rows are held once, and adding a tier twice changes nothing.
  assert.equal(library.size, CORE.rows.length + POSTAL.rows.length + COMMUNITY.rows.length);
  assert.equal(library.hasTier('core') && library.hasTier('postal') && library.hasTier('community'), true);
  assert.deepEqual(core().tiers, ['core']);
  const twice = all();
  twice.add(COMMUNITY);
  assert.equal(twice.size, library.size);
});

// ---------------------------------------------------------------- the search definition contract

test('a chosen place is the search definition its own coordinates produce', () => {
  const library = all();
  const publishedRegion = JSON.parse(readFileSync(
    new URL('../data/national/derived-catalog.json', import.meta.url))).region;
  for (const [query, radiusMiles] of [['princeton in', 10], ['nashville tennessee', 25], ['moab utah', 50],
    ['great smoky mountains', 25], ['gibson county indiana', 25], ['47715', 25]]) {
    const place = searchPlaces(library, query, { limit: 1 }).results[0];
    assert.ok(place, query);
    const read = readSearchDefinition({ lat: place.center[1], lon: place.center[0], radiusMiles },
      { region: publishedRegion });
    assert.equal(read.ok, true, `${query}: a chosen place must be a valid search`);
    const typed = searchDefinitionOf(place.center, radiusMiles);
    assert.deepEqual(read.definition.center, typed.center, `${query}: the centre must not drift`);
    assert.deepEqual([...read.definition.bounds], [...typed.bounds], `${query}: identical bounds`);
    assert.equal(read.definition.radiusM, typed.radiusM, query);
    assert.equal(read.definition.radiusMiles, radiusMiles, `${query}: the radius is the person's`);
    assert.deepEqual(read.definition.center, place.center, `${query}: the published interior point is the centre`);
  }
});

test('a place centre selects the same national metric cells as its typed coordinates', context => {
  const build = process.env.ROADNATURALIST_BUILD_VOLUME ?? '/Volumes/Lexar/roadnaturalist';
  const catalog = JSON.parse(readFileSync(new URL('../data/national/derived-catalog.json', import.meta.url)));
  const manifestPath = join(build, 'cells/derived/corridor-metrics', catalog.derived.analysisFingerprint,
    'manifest.json');
  if (!existsSync(manifestPath)) {
    context.skip('the national derived manifest is not on this machine');
    return;
  }
  const manifest = validateDerivedManifest(JSON.parse(readFileSync(manifestPath)));
  const library = core();
  let selected = 0;
  for (const [region, [query]] of Object.entries(REGIONS)) {
    const place = searchPlaces(library, query, { limit: 1 }).results[0];
    const definition = searchDefinitionOf(place.center, 25);
    const fromPlace = selectDerivedCells(manifest, definition.bounds);
    const fromCoordinates = selectDerivedCells(manifest, searchDefinitionOf(place.center, 25).bounds);
    assert.deepEqual(fromPlace.cells.map(cell => cell.id), fromCoordinates.cells.map(cell => cell.id), region);
    assert.ok(fromPlace.cells.length > 0, `${region}: a 25-mile search selects cells`);
    assert.ok(fromPlace.present.length > 0, `${region}: a 25-mile search selects readable cells`);
    assert.equal(fromPlace.coverage, 'FULL', region);
    selected += fromPlace.cells.length;
  }
  assert.ok(selected > 0);
});



// ---------------------------------------------------------------- normalization, labels, memory

test('the browser and the builder normalize text identically', () => {
  assert.equal(FIXTURE.kind, 'road-discovery-place-normalization-fixture');
  assert.ok(FIXTURE.cases.length >= 30, 'the fixture covers the documented cases');
  for (const [input, expected] of FIXTURE.cases) {
    assert.equal(normalizePlaceText(input), expected, JSON.stringify(input));
  }
  // The documented rewrites, and the deliberate absence of others: folding single letters would merge names
  // that are not the same, so a direction stays a direction and still matches "north" by prefix.
  assert.equal(normalizePlaceText('St. Louis'), 'saint louis');
  assert.equal(normalizePlaceText('Ft. Worth'), 'fort worth');
  assert.equal(normalizePlaceText('Mt. Vernon'), 'mount vernon');
  assert.equal(normalizePlaceText('N. Little Rock'), 'n little rock');
  assert.equal(normalizePlaceText('Winston-Salem'), 'winston salem');
  assert.equal(normalizePlaceText("Coeur d'Alene"), 'coeur d alene');
  assert.equal(normalizePlaceText('Cañon City'), 'canon city');
});

test('a result is labelled with the place and what separates it from its namesakes', () => {
  const library = all();
  const princeton = searchPlaces(library, 'princeton in', { limit: 1 }).results[0];
  assert.equal(placeLabel(princeton), 'Princeton, IN');
  assert.equal(placeDetail(princeton), 'Gibson County');
  assert.equal(placeTypeLabel(princeton), 'City');
  const county = searchPlaces(library, 'gibson county indiana', { limit: 1 }).results[0];
  assert.equal(placeDetail(county), 'County');
  assert.equal(placeTypeLabel(county), 'County');
  const park = searchPlaces(library, 'great smoky mountains', { limit: 1 }).results[0];
  assert.equal(placeDetail(park), 'National park');
  const zip = searchPlaces(library, '47715', { limit: 1 }).results[0];
  assert.equal(placeTypeLabel(zip), 'ZIP Code Tabulation Area');
  assert.equal(placeDetail(zip), 'Indiana · Vanderburgh County');
  // Presentation metadata is validated on the way back in, so a stored label can never change a search.
  const metadata = placeMetadata(park);
  assert.equal(metadata.id, park.id);
  assert.equal(metadata.label, 'Great Smoky Mountains National Park, TN');
  assert.deepEqual(storedPlaceMetadata({ ...metadata }), metadata);
  assert.equal(storedPlaceMetadata({ id: 'not-an-id', label: 'Nowhere, XX' }), null);
  assert.equal(storedPlaceMetadata(null), null);
  // A schema-1 stored id is still a stored id: the regional pilot's records keep their labels.
  assert.equal(storedPlaceMetadata({ id: '4134100', label: 'Hillsboro, OR' }).label, 'Hillsboro, OR');
});

test('the nearest published place to a centre is found without scanning the country', () => {
  const library = core();
  const princeton = searchPlaces(library, 'princeton in', { limit: 1 }).results[0];
  const near = nearestPlace(princeton.center, library);
  assert.equal(near.place.id, princeton.id);
  assert.equal(near.label, 'Near Princeton, IN');
  assert.ok(near.distanceM < 1, 'the place itself is at zero distance');
  // A point in the middle of the ocean has no published place within the label radius, and a malformed centre is
  // refused rather than labelled.
  assert.equal(nearestPlace([-150, 40], library), null);
  assert.equal(nearestPlace(['x', 40], library), null);
  // The grid answer and a full scan agree: the grid is a shortcut, not a different rule.
  const office = [princeton.center[0] + 0.12, princeton.center[1] - 0.07];
  const scanned = library.places.map(place => ({ place,
    distance: (place.center[0] - office[0]) ** 2 + (place.center[1] - office[1]) ** 2 }))
    .sort((left, right) => left.distance - right.distance);
  assert.equal(nearestPlace(office, library).place.id, scanned[0].place.id);
  // A library with no places has no nearest place: a label lost, and nothing more.
  assert.equal(nearestPlace(princeton.center, createPlaceLibrary([])), null);
});

test('the tiers are the sizes the build report says they are', () => {
  for (const [tier, document, key] of [['core', CORE, 'core'], ['postal', POSTAL, 'postalCode'],
    ['community', COMMUNITY, 'community']]) {
    const entry = REPORT.artifacts[key];
    assert.equal(document.rows.length, entry.jsonRows, `${tier} rows`);
    assert.equal(readFileSync(new URL(`../${entry.path}`, import.meta.url)).length, entry.bytes, `${tier} bytes`);
    assert.ok(entry.gzipBytes < entry.bytes, `${tier} compresses`);
  }
  assert.deepEqual(NATIONAL_PLACE_TIERS, ['zip', 'exact', 'prefix', 'token-prefix', 'typo']);
  assert.deepEqual(all().tiers, ['core', 'postal', 'community']);
});

