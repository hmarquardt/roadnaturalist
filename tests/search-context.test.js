import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COVERAGE } from '../src/domain/corridor.js';
import { cardinalDirection, closestPointOnLineM, haversineM, initialBearingDeg, minDistanceToLineM } from '../src/domain/geometry.js';
import { MAX_NEAR_PLACE_M, MAX_NEAR_PLACE_MILES, nearestPlace, nearPlaceLabel, nearPlaceMetadata,
  validatePlaceGazetteer } from '../src/discovery/place-gazetteer.js';
import { BEARING_MIN_DISTANCE_M, CENTER_LABEL_KIND, centerPresentation, corridorContextFromCenter,
  formatContextDirection, formatContextDistance } from '../src/discovery/search-context.js';
import { DEFAULT_SORT, SORT_OPTIONS, filterResults, sortResults } from '../src/discovery/filter.js';
import { readSearchDefinition } from '../src/discovery/search-definition.js';
import { radiusBounds, validateSearchAreas } from '../src/discovery/search-area.js';
import { runDiscovery } from '../src/discovery/run.js';

// SEARCH CONTEXT: where the search is, and where a discovered road lies relative to it.
//
// Two measured facts, one geometry primitive, no ranking. These tests hold the four promises the feature
// makes: a label is inferred and modest (never a claim that the centre is inside the place), a centre is never
// moved to a place, the distance a result reports is the same measurement the exact-radius search decided
// with, and a bearing points from the centre toward the nearest part of the road.
const MI = 1609.344;
const METRES_PER_DEGREE_LAT = 6371000 * Math.PI / 180;
const LON_PER_M = 1 / (111320 * Math.cos(45.5 * Math.PI / 180));
const declaration = validateSearchAreas(JSON.parse(readFileSync(new URL('../data/discovery/search-areas.json', import.meta.url))),
  JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url))));
const REGION = declaration.publishedRegion;
const gazetteer = validatePlaceGazetteer(JSON.parse(readFileSync(new URL('../data/places/or-sw-wa-portland-places.json', import.meta.url))),
  { region: REGION });

function place(name, state) {
  return gazetteer.places.find(entry => entry.name === name && entry.state === state);
}

function line(from, to, segments = 4) {
  return Array.from({ length: segments + 1 },
    (_, index) => [from[0] + (to[0] - from[0]) * index / segments, from[1] + (to[1] - from[1]) * index / segments]);
}

// A straight line `lengthM` long, `startM` east of a centre: the simplest fixture a bearing can be read from.
function eastOf(center, startM, lengthM) {
  const lon = center[0] + startM * LON_PER_M;
  return { type: 'LineString', coordinates: line([lon, center[1]], [lon + lengthM * LON_PER_M, center[1]], 8) };
}

function northOf(center, startM, lengthM) {
  const lat = center[1] + startM / METRES_PER_DEGREE_LAT;
  return { type: 'LineString', coordinates: line([center[0], lat], [center[0], lat + lengthM / METRES_PER_DEGREE_LAT], 8) };
}


// ------------------------------------------------------------------ nearest place

test('the nearest published place to a place centre is that place, at no distance', () => {
  const hillsboro = place('Hillsboro', 'OR');
  const found = nearestPlace(hillsboro.center, gazetteer);
  assert.equal(found.place.id, hillsboro.id);
  assert.ok(found.distanceM < 0.001, `a place centre is no distance from itself, measured ${found.distanceM}`);
  assert.equal(found.label, 'Near Hillsboro, OR');
  // The label is always the modest wording: the gazetteer point is a Census interior point, so even a centre
  // that is exactly a place centre is reported as being near it.
  assert.match(found.label, /^Near /);
});

test('a map point is labelled by its nearest published place, measured independently', () => {
  const vancouver = place('Vancouver', 'WA');
  const center = [vancouver.center[0] + 2 * MI * LON_PER_M, vancouver.center[1]];
  const found = nearestPlace(center, gazetteer);
  // The expected answer is recomputed here from the artifact by a plain scan, so the lookup is checked against
  // an independent measurement rather than against itself.
  const expected = [...gazetteer.places].sort((left, right) => haversineM(center, left.center) - haversineM(center, right.center)
    || left.name.localeCompare(right.name))[0];
  assert.equal(found.place.id, expected.id);
  assert.ok(Math.abs(found.distanceM - 2 * MI) < 2 * MI * 0.01,
    `two miles east of a place centre, measured ${(found.distanceM / MI).toFixed(2)} mi`);
  assert.equal(found.label, `Near ${expected.name}, ${expected.state}`);
});

test('equidistant places are broken deterministically, and repeated lookups agree', () => {
  const base = place('Vernonia', 'OR');
  const offset = 5000 * LON_PER_M;
  const ties = { places: [{ ...base, id: '0000002', name: 'Beta', center: [base.center[0] + offset, base.center[1]] },
    { ...base, id: '0000003', name: 'Alpha', center: [base.center[0] - offset, base.center[1]] }] };
  assert.ok(Math.abs(haversineM(base.center, ties.places[0].center) - haversineM(base.center, ties.places[1].center)) < 1,
    'the fixture must be a tie for the tie rule to be the thing under test');
  assert.equal(nearestPlace(base.center, ties).place.name, 'Alpha',
    'a tie falls back to name, then state, then id, so the same centre never labels differently');
  const centres = Array.from({ length: 200 }, (_, index) => [-123.4 + index * 0.002, 45.2 + (index % 17) * 0.01]);
  for (const center of centres) {
    const first = nearestPlace(center, gazetteer);
    const second = nearestPlace(center, gazetteer);
    assert.deepEqual([first?.place.id, first?.distanceM], [second?.place.id, second?.distanceM]);
  }
});

test('a centre with no place near enough is left to its coordinates', () => {
  // The threshold is measured, not asserted from memory: find a point inside the published region whose
  // nearest place is further away than the labelling distance.
  const region = REGION.bounds;
  let far = null;
  for (let row = 0; row <= 20 && !far; row++) {
    for (let column = 0; column <= 20 && !far; column++) {
      const candidate = [region[0] + (region[2] - region[0]) * column / 20, region[1] + (region[3] - region[1]) * row / 20];
      if (!nearestPlace(candidate, gazetteer)
        && nearestPlace(candidate, gazetteer, { maxDistanceM: Infinity }).distanceM > MAX_NEAR_PLACE_M) far = candidate;
    }
  }
  assert.ok(far, 'the published region must contain a centre no published place is near');
  assert.equal(nearestPlace(far, gazetteer), null);
  // Nothing is invented for it: the coordinates are the label, and there is no place relationship at all.
  const presentation = centerPresentation({ center: far });
  assert.equal(presentation.kind, CENTER_LABEL_KIND.COORDINATES);
  assert.equal(presentation.label, presentation.coordinates);
  assert.equal(presentation.distanceM, null);
  // The distant place exists and is genuinely beyond the threshold; it is the threshold that suppresses it.
  const distant = nearestPlace(far, gazetteer, { maxDistanceM: Infinity });
  assert.ok(distant.distanceM > MAX_NEAR_PLACE_M);
  assert.match(distant.label, /^Near /);
});

test('the labelling distance is the documented threshold and it is honoured exactly', () => {
  assert.equal(MAX_NEAR_PLACE_MILES, 10);
  assert.equal(MAX_NEAR_PLACE_M, 10 * MI);
  const vernonia = place('Vernonia', 'OR');
  const onePlace = { places: [vernonia] };
  const thresholdDegrees = MAX_NEAR_PLACE_M / METRES_PER_DEGREE_LAT;
  const inside = [vernonia.center[0], vernonia.center[1] + thresholdDegrees * (1 - 1e-6)];
  const outside = [vernonia.center[0], vernonia.center[1] + thresholdDegrees * (1 + 1e-6)];
  assert.equal(nearestPlace(inside, onePlace)?.place.id, vernonia.id, 'a centre just inside the threshold is labelled');
  assert.equal(nearestPlace(outside, onePlace), null, 'a centre just outside the threshold is not labelled');
  assert.ok(nearestPlace(inside, onePlace).distanceM <= MAX_NEAR_PLACE_M);
});

test('an explicitly chosen place stays authoritative beside an inferred label', () => {
  const chosen = placeMetadataFixture('Hillsboro', 'OR');
  const vernonia = place('Vernonia', 'OR');
  const inferred = nearPlaceMetadata(nearestPlace(vernonia.center, gazetteer));
  const both = centerPresentation({ place: chosen, near: inferred, center: vernonia.center });
  assert.equal(both.kind, CENTER_LABEL_KIND.EXPLICIT_PLACE);
  assert.equal(both.label, 'Hillsboro, OR');
  assert.equal(both.distanceM, null, 'an explicit place is not a distance from anything');
  // The inferred label is a different kind of fact and is marked as one.
  const onlyInferred = centerPresentation({ near: inferred, center: vernonia.center });
  assert.equal(onlyInferred.kind, CENTER_LABEL_KIND.NEAR_PLACE);
  assert.equal(onlyInferred.label, 'Near Vernonia, OR');
  assert.ok(onlyInferred.distanceM < 1);
  assert.equal(onlyInferred.coordinates, both.coordinates, 'the coordinates are the same in both cases: the search did not move');
  assert.equal(nearPlaceMetadata(null), null);
  assert.equal(nearPlaceLabel(null), '');
});

test('a typed or URL coordinate is labelled but never moved or rewritten', () => {
  const vernonia = place('Vernonia', 'OR');
  // A typed centre 3 miles from the place: the search is where it was typed, and the place is only a label.
  const center = [vernonia.center[0] + 3 * MI * LON_PER_M, vernonia.center[1]];
  const definition = readSearchDefinition({ lat: center[1], lon: center[0], radiusMiles: 10 }, { region: REGION }).definition;
  assert.ok(Math.abs(definition.center[0] - center[0]) < 1e-4 && Math.abs(definition.center[1] - center[1]) < 1e-4,
    'the centre is the coordinate that was entered, to the precision the search itself stores');
  assert.ok(haversineM(definition.center, vernonia.center) > 3 * MI * 0.99, 'the centre was not snapped to the place');
  assert.equal(nearestPlace(definition.center, gazetteer).place.id, vernonia.id);
  // A definition is coordinates and a radius: presentation never becomes part of the search's own state.
  assert.deepEqual(Object.keys(definition).filter(key => /place|near/i.test(key)), []);
  assert.ok(definition.bounds[0] < definition.bounds[2] && definition.bounds[1] < definition.bounds[3]);
});

// The presentation form a chosen place is kept in: the label a person reads, beside the identity it came from.
function placeMetadataFixture(name, state) {
  const found = place(name, state);
  return { id: found.id, label: `${found.name}, ${found.state}`, featureClass: found.featureClass };
}

test('across the region, every label is within the threshold and the far centres get none', () => {
  const region = REGION.bounds;
  let labelled = 0;
  let unlabelled = 0;
  for (let row = 0; row <= 24; row++) {
    for (let column = 0; column <= 24; column++) {
      const center = [region[0] + (region[2] - region[0]) * column / 24, region[1] + (region[3] - region[1]) * row / 24];
      const nearest = gazetteer.places.reduce((best, entry) => Math.min(best, haversineM(center, entry.center)), Infinity);
      const found = nearestPlace(center, gazetteer);
      if (found) {
        labelled += 1;
        assert.ok(found.distanceM <= MAX_NEAR_PLACE_M, 'a label is never attached beyond the threshold');
        assert.ok(haversineM(center, found.place.center) - found.distanceM < 1e-6, 'the reported distance is the measured one');
      } else {
        unlabelled += 1;
        assert.ok(nearest > MAX_NEAR_PLACE_M, 'a centre without a label has no place inside the threshold');
      }
    }
  }
  // Both outcomes are reachable in the published region, and labels are the common case rather than a rarity.
  assert.ok(unlabelled > 0 && labelled > 0);
  assert.ok(labelled / (labelled + unlabelled) > 0.6,
    `labels should cover most in-region centres, measured ${labelled}/${labelled + unlabelled}`);
});

test('nearest-place lookups are fast enough that no index is justified', () => {
  const started = performance.now();
  for (let index = 0; index < 2000; index++) {
    nearestPlace([-123.4 + index * 1e-4, 44.2 + (index % 31) * 0.05], gazetteer);
  }
  const perLookupMs = (performance.now() - started) / 2000;
  // A linear scan over a few hundred places. The bound is deliberately loose: it exists to fail if someone
  // makes the lookup quadratic, not to police a millisecond.
  assert.ok(perLookupMs < 1,
    `a linear scan over ${gazetteer.places.length} places should stay far below a millisecond, measured ${perLookupMs.toFixed(3)} ms`);
});

// ------------------------------------------------------------------ distance and bearing

const CENTER = [-122.9, 45.55];

test('a corridor east or west of the centre reports its measured distance and bearing', () => {
  const eastGeometry = eastOf(CENTER, 4000, 2000);
  const eastStart = eastGeometry.coordinates[0];
  const east = corridorContextFromCenter(CENTER, eastGeometry);
  // The expected distance is measured from the fixture's own coordinates, so the test compares the context
  // against the geometry rather than against an approximation of it.
  assert.ok(Math.abs(east.distanceM - haversineM(CENTER, eastStart)) < 1e-6, `measured ${east.distanceM.toFixed(1)} m`);
  assert.ok(Math.abs(east.distanceM - 4000) < 12, `about four kilometres, measured ${east.distanceM.toFixed(1)} m`);
  assert.ok(Math.abs(east.bearingDeg - 90) < 0.5, `bearing ${east.bearingDeg.toFixed(2)}`);
  assert.equal(east.cardinal, 'E');
  assert.match(formatContextDirection(east), /^\d\.\d mi E$/);
  const westGeometry = eastOf(CENTER, -6000, 2000);
  const west = corridorContextFromCenter(CENTER, westGeometry);
  // The near end of a west-running corridor is its far end: the nearest point is measured, not assumed.
  assert.ok(Math.abs(west.distanceM - haversineM(CENTER, westGeometry.coordinates.at(-1))) < 1e-6);
  assert.ok(Math.abs(west.distanceM - 4000) < 12, `about four kilometres, measured ${west.distanceM.toFixed(1)} m`);
  assert.ok(Math.abs(west.bearingDeg - 270) < 0.5, `bearing ${west.bearingDeg.toFixed(2)}`);
  assert.equal(west.cardinal, 'W');
  assert.match(formatContextDirection(west), /^\d\.\d mi W$/);
});

test('a corridor north or south of the centre reports the matching bearing', () => {
  const northGeometry = northOf(CENTER, 3000, 1000);
  const north = corridorContextFromCenter(CENTER, northGeometry);
  assert.ok(Math.abs(north.distanceM - haversineM(CENTER, northGeometry.coordinates[0])) < 1e-6);
  assert.ok(north.bearingDeg < 0.5, `bearing ${north.bearingDeg}`);
  assert.equal(north.cardinal, 'N');
  const southGeometry = northOf(CENTER, -3000, 1000);
  const south = corridorContextFromCenter(CENTER, southGeometry);
  assert.ok(Math.abs(south.distanceM - haversineM(CENTER, southGeometry.coordinates.at(-1))) < 1e-6);
  assert.ok(Math.abs(south.distanceM - 2000) < 12, `about two kilometres, measured ${south.distanceM.toFixed(1)} m`);
  assert.ok(Math.abs(south.bearingDeg - 180) < 0.5, `bearing ${south.bearingDeg}`);
  assert.equal(south.cardinal, 'S');
  assert.equal(formatContextDirection(south), '1.2 mi S');
});

test('a diagonal corridor reports its own quadrant and its measured distance', () => {
  // A corridor whose nearest point is south-east of the centre: the direction is the compass point, not a
  // heading along the road.
  const offset = 3000;
  const start = [CENTER[0] + offset * LON_PER_M, CENTER[1] - offset / METRES_PER_DEGREE_LAT];
  const diagonal = { type: 'LineString', coordinates: [start, [start[0] + 2000 * LON_PER_M, start[1] - 2000 / METRES_PER_DEGREE_LAT]] };
  const context = corridorContextFromCenter(CENTER, diagonal);
  assert.ok(Math.abs(context.distanceM - Math.SQRT2 * offset) < 60, `measured ${context.distanceM.toFixed(1)} m`);
  assert.ok(Math.abs(context.bearingDeg - 135) < 0.5, `bearing ${context.bearingDeg.toFixed(2)}`);
  assert.equal(context.cardinal, 'SE');
});

test('a corridor through the centre reports a floor distance and no invented direction', () => {
  const through = { type: 'LineString', coordinates: [[CENTER[0] - 3000 * LON_PER_M, CENTER[1]], [CENTER[0] + 3000 * LON_PER_M, CENTER[1]]] };
  const context = corridorContextFromCenter(CENTER, through);
  assert.ok(context.distanceM < 1, `a road through the centre is at no distance, measured ${context.distanceM}`);
  assert.equal(context.bearingDeg, null, 'a direction is not invented for a road at the centre');
  assert.equal(context.cardinal, null);
  assert.equal(formatContextDistance(context.distanceM), '<0.1 mi');
  assert.equal(formatContextDirection(context), '<0.1 mi');
  // The direction appears exactly when it means something: a road a few metres away has one, and a road at
  // the documented minimum does not.
  const near = corridorContextFromCenter(CENTER, northOf(CENTER, BEARING_MIN_DISTANCE_M * 4, 100));
  assert.equal(near.cardinal, 'N');
  const noise = corridorContextFromCenter(CENTER, northOf(CENTER, BEARING_MIN_DISTANCE_M / 2, 100));
  assert.equal(noise.bearingDeg, null, 'below the documented minimum the bearing is left out');
});

test('the nearest segment decides, not a vertex, a midpoint, or a centroid', () => {
  // An L whose near arm runs north-south a kilometre east of the centre, and whose far arm runs 30 km further
  // east. The answer must be the interior point of the near arm, not the geometry's midpoint or centroid.
  const nearLon = CENTER[0] + 1000 * LON_PER_M;
  const farLon = CENTER[0] + 30000 * LON_PER_M;
  const geometry = { type: 'MultiLineString', coordinates: [
    [[nearLon, CENTER[1] + 5000 / METRES_PER_DEGREE_LAT], [nearLon, CENTER[1] - 5000 / METRES_PER_DEGREE_LAT]],
    [[farLon, CENTER[1]], [farLon + 10000 * LON_PER_M, CENTER[1]]],
  ] };
  const context = corridorContextFromCenter(CENTER, geometry);
  const midpoint = [nearLon, CENTER[1]];
  assert.ok(context.distanceM < 1100, `the near arm decides, measured ${context.distanceM.toFixed(1)} m`);
  assert.equal(context.cardinal, 'E');
  // The nearest point is on the near line, at the centre's own latitude: an interior projection, not a vertex.
  assert.ok(Math.abs(context.nearestPoint[0] - nearLon) < 1e-9);
  assert.ok(Math.abs(context.nearestPoint[1] - CENTER[1]) < 1e-9);
  assert.ok(Math.abs(context.distanceM - haversineM(CENTER, midpoint)) < 1e-6);
  // Every other obvious answer is wrong by a wide margin.
  assert.ok(haversineM(CENTER, geometry.coordinates[1][0]) > 29000, 'the far arm is far, and it is not the answer');
});

test('bearings wrap at north, and the compass sectors have fixed edges', () => {
  const edges = [[0, 'N'], [22.4, 'N'], [22.5, 'NE'], [67.4, 'NE'], [67.5, 'E'], [112.5, 'SE'], [157.5, 'S'],
    [202.5, 'SW'], [247.5, 'W'], [292.5, 'NW'], [337.4, 'NW'], [337.5, 'N'], [359.9, 'N'], [360, 'N'], [-0.1, 'N']];
  for (const [bearing, expected] of edges) assert.equal(cardinalDirection(bearing), expected, `${bearing} should be ${expected}`);
  assert.equal(cardinalDirection(null), null);
  assert.equal(cardinalDirection(NaN), null);
  assert.equal(initialBearingDeg(CENTER, CENTER), 0, 'a degenerate bearing is north rather than NaN');
  // A corridor a hair west of due north wraps to just under 360 rather than to a negative bearing.
  const westOfNorth = northOf([CENTER[0] - 20 * LON_PER_M, CENTER[1]], 3000, 1000);
  const context = corridorContextFromCenter(CENTER, westOfNorth);
  assert.ok(context.bearingDeg > 359 && context.bearingDeg < 360, `bearing ${context.bearingDeg}`);
  assert.equal(context.cardinal, 'N');
  // Due north measures as 0: the two ends of the circle are the same direction.
  const dueNorth = corridorContextFromCenter(CENTER, northOf(CENTER, 3000, 1000));
  assert.equal(dueNorth.bearingDeg, 0);
});

test('context distances are statute miles with a floor, never a driving distance', () => {
  assert.equal(formatContextDistance(0), '<0.1 mi');
  assert.equal(formatContextDistance(39), '<0.1 mi');
  assert.equal(formatContextDistance(1288), '0.8 mi');
  assert.equal(formatContextDistance(6759), '4.2 mi');
  assert.equal(formatContextDistance(28318), '17.6 mi');
  assert.equal(formatContextDistance(null), 'Not measured');
  assert.equal(formatContextDistance(Infinity), 'Not measured');
  assert.equal(formatContextDirection({ distanceM: 13522, cardinal: 'NW' }), '8.4 mi NW');
  assert.equal(formatContextDirection({ distanceM: 13522 }), '8.4 mi');
  assert.equal(formatContextDirection({}), 'Not measured');
});

test('the distance primitive is one function, shared with the radius decision', () => {
  const fixtures = [eastOf(CENTER, 100, 200), eastOf(CENTER, -6000, 2000), northOf(CENTER, 3000, 1000),
    northOf(CENTER, -3000, 1000), { type: 'LineString', coordinates: [[CENTER[0] - 3000 * LON_PER_M, CENTER[1]],
      [CENTER[0] + 3000 * LON_PER_M, CENTER[1]]] }];
  for (const geometry of fixtures) {
    const nearest = closestPointOnLineM(CENTER, geometry);
    assert.equal(minDistanceToLineM(CENTER, geometry), nearest.distanceM, 'inclusion and context share one measurement');
    assert.equal(corridorContextFromCenter(CENTER, geometry).distanceM, nearest.distanceM);
    assert.ok(Math.abs(haversineM(CENTER, nearest.nearestPoint) - nearest.distanceM) < 1e-6,
      'the reported point is at the reported distance');
  }
  // An unmeasurable geometry is infinite distance, which is what keeps it out of a radius search.
  assert.equal(minDistanceToLineM(CENTER, { type: 'LineString', coordinates: [] }), Infinity);
  assert.equal(closestPointOnLineM(CENTER, { type: 'Point', coordinates: [0, 0] }), null);
  assert.equal(corridorContextFromCenter(CENTER, null), null);
});

test('distance from center is an explicit sort and never an implicit filter', () => {
  const option = SORT_OPTIONS.find(entry => entry.key === 'distanceFromCenter');
  assert.ok(option, 'the sort is offered as one named measured value among the others');
  assert.equal(option.direction, 'asc');
  assert.equal(option.unit, 'm');
  assert.equal(option.label, 'Distance from center');
  assert.notEqual(DEFAULT_SORT, 'distanceFromCenter', 'the default ordering of the table is unchanged');
  const results = [
    { id: 'a', name: 'A Rd', distanceFromCenterM: 5000, lengthM: 2000, road: { classes: ['S1400'] },
      signals: { wetlands: {}, hydrography: {} }, ecology: {} },
    { id: 'b', name: 'B Rd', distanceFromCenterM: null, lengthM: 2000, road: { classes: ['S1400'] },
      signals: { wetlands: {}, hydrography: {} }, ecology: {} },
    { id: 'c', name: 'C Rd', distanceFromCenterM: 1000, lengthM: 2000, road: { classes: ['S1400'] },
      signals: { wetlands: {}, hydrography: {} }, ecology: {} },
  ];
  assert.deepEqual(sortResults(results, 'distanceFromCenter').map(result => result.id), ['c', 'a', 'b'],
    'ascending by the measured distance, with an unmeasured distance last');
  assert.deepEqual(sortResults([...results].reverse(), 'distanceFromCenter').map(result => result.id), ['c', 'a', 'b'],
    'the order is a property of the measurements, not of the input');
  assert.equal(filterResults(results, {}).length, results.length, 'a distance is context, not a filter');
});

// ------------------------------------------------------------------ the radius invariant

const RADIUS_MILES = 25;
const SEARCH_CENTER = [-122.9, 45.55];
const RADIUS_M = RADIUS_MILES * MI;
const RADIUS_AREA = { id: 'context-radius', name: '25-mile radius', kind: 'radius', center: SEARCH_CENTER,
  radiusMiles: RADIUS_MILES, catalogUrl: 'regional/manifest.json' };

function derivedRow(overrides = {}) {
  const coordinates = overrides.coordinates ?? [[SEARCH_CENTER[0] + 1 * MI * LON_PER_M, SEARCH_CENTER[1]],
    [SEARCH_CENTER[0] + 2 * MI * LON_PER_M, SEARCH_CENTER[1]]];
  const lons = coordinates.map(point => point[0]);
  const lats = coordinates.map(point => point[1]);
  return { corridor_id: 'drv1-context-rd-s1', road_component_id: 'drv1-context-rd', road_unit_id: 'drv1-context-rd',
    name: 'NW Context Rd', normalized_name: 'nw context rd', length_m: 1609, road_classes: ['S1400'],
    county_names: ['Washington County, Oregon'], counties: ['41067'], road_ids: ['tiger-context'],
    source_feature_ids: ['1'], segment_index: 1, segment_count: 1, geometry_repaired: false,
    geometry_repair_method: 'none', analysis_fingerprint: 'f'.repeat(64), wetland_intersects: false,
    hydro_crossing_count: 0, coverage: COVERAGE.FULL, min_lon: Math.min(...lons), min_lat: Math.min(...lats),
    max_lon: Math.max(...lons), max_lat: Math.max(...lats), geometry: { type: 'LineString', coordinates }, ...overrides };
}

function scopeFor(rows) {
  return { derived: true, fingerprint: 'f'.repeat(64),
    selection: Object.freeze({ coverage: COVERAGE.FULL, reason: null, bounds: radiusBounds(SEARCH_CENTER, RADIUS_MILES),
      cells: [], present: [], bytes: 12, counts: { cells: 1, present: 1, empty: 0 } }),
    manifest: { cells: 1, present: 1, empty: 0, counts: {} },
    timing: Object.freeze({ manifestMs: 1, selectionMs: 1, totalPreparationMs: 2, fetchMs: 1, verifyMs: 1, registerMs: 0,
      downloadedBytes: 12, cacheHits: 0, registeredCells: 1 }),
    provenance: Object.freeze({ source: 'Precomputed from verified regional GIS', analysisFingerprint: 'f'.repeat(64) }),
    async queryDerivedCorridors() { return { rows, rowCount: rows.length, queryMs: 1 }; } };
}

function derivedGis(scope) {
  return { async prepareDerivedSearch(searchArea) {
    assert.deepEqual([...searchArea.bbox], [...radiusBounds(SEARCH_CENTER, RADIUS_MILES)]);
    return scope;
  } };
}

test('every derived result carries the distance the exact-radius search decided with', async () => {
  const through = derivedRow({ corridor_id: 'drv1-through-rd-s1', name: 'Through Rd',
    coordinates: [[SEARCH_CENTER[0] - 3000 * LON_PER_M, SEARCH_CENTER[1]], [SEARCH_CENTER[0] + 3000 * LON_PER_M, SEARCH_CENTER[1]]] });
  const near = derivedRow({ corridor_id: 'drv1-near-rd-s1', name: 'Near Rd' });
  // A hair inside the radius and a hair outside it, due north: the boundary is decided by the same measurement
  // the result reports, and the comparison is exact rather than fudged with a tolerance.
  const boundaryLat = offset => SEARCH_CENTER[1] + RADIUS_M * offset / METRES_PER_DEGREE_LAT;
  const edge = derivedRow({ corridor_id: 'drv1-edge-rd-s1', name: 'Edge Rd',
    coordinates: [[SEARCH_CENTER[0] - 500 * LON_PER_M, boundaryLat(1 - 1e-9)], [SEARCH_CENTER[0] + 500 * LON_PER_M, boundaryLat(1 - 1e-9)]] });
  const outside = derivedRow({ corridor_id: 'drv1-outside-rd-s1', name: 'Outside Rd',
    coordinates: [[SEARCH_CENTER[0] - 500 * LON_PER_M, boundaryLat(1 + 1e-9)], [SEARCH_CENTER[0] + 500 * LON_PER_M, boundaryLat(1 + 1e-9)]] });
  const rows = [through, near, edge, outside];
  const run = await runDiscovery({ gis: derivedGis(scopeFor(rows)), searchArea: RADIUS_AREA });
  assert.equal(run.status, 'ready');
  assert.deepEqual(run.results.map(result => result.id),
    ['drv1-through-rd-s1', 'drv1-near-rd-s1', 'drv1-edge-rd-s1'], 'the corridor outside the radius is not a result');
  for (const result of run.results) {
    const row = rows.find(entry => entry.corridor_id === result.id);
    assert.equal(result.distanceFromCenterM, minDistanceToLineM(SEARCH_CENTER, row.geometry),
      'the reported distance is the primitive the radius test uses, not a second measurement');
    assert.ok(result.distanceFromCenterM <= RADIUS_M, 'an included corridor is inside the radius by its own reported distance');
    assert.ok(Math.abs(haversineM(SEARCH_CENTER, result.nearestCenterPoint) - result.distanceFromCenterM) < 1e-6,
      'the nearest point is at the reported distance');
  }
  const byId = Object.fromEntries(run.results.map(result => [result.id, result]));
  assert.ok(byId['drv1-through-rd-s1'].distanceFromCenterM < 1, 'a road through the centre is at no distance');
  assert.equal(byId['drv1-through-rd-s1'].bearingFromCenterDeg, null);
  assert.equal(byId['drv1-through-rd-s1'].cardinalFromCenter, null);
  assert.equal(byId['drv1-near-rd-s1'].cardinalFromCenter, 'E');
  assert.ok(Math.abs(byId['drv1-near-rd-s1'].distanceFromCenterM - MI) < 12);
  assert.ok(RADIUS_M - byId['drv1-edge-rd-s1'].distanceFromCenterM < 0.1,
    'a corridor a hair inside the radius is included, and its distance is that close to the boundary');
  // The excluded corridor is excluded for its own measured distance, and the same call says so.
  assert.ok(corridorContextFromCenter(SEARCH_CENTER, outside.geometry).distanceM > RADIUS_M);
});

test('a declared box search has no centre, so no result claims a distance', async () => {
  const row = derivedRow({ corridor_id: 'drv1-box-rd-s1' });
  const scope = scopeFor([row]);
  const run = await runDiscovery({ gis: { async prepareDerivedSearch() { return scope; } },
    searchArea: { id: 'context-box', name: 'Declared window', catalogUrl: 'regional/manifest.json',
      bbox: [-122.95, 45.53, -122.85, 45.57] } });
  assert.equal(run.status, 'ready');
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].distanceFromCenterM, null);
  assert.equal(run.results[0].nearestCenterPoint, null);
  assert.equal(run.results[0].bearingFromCenterDeg, null);
  assert.equal(run.results[0].cardinalFromCenter, null);
});

test('the raw path measures the corridor while the unit rule stays the inclusion rule', async () => {
  // A 20-mile road whose nearest end is half a mile from the centre: the composed unit is inside a 1-mile
  // disk, so the raw path admits it, and its corridors far outside the disk keep their own measured context.
  const startLon = SEARCH_CENTER[0] + 0.5 * MI * LON_PER_M;
  const coordinates = line([startLon, SEARCH_CENTER[1]], [startLon + 20 * MI * LON_PER_M, SEARCH_CENTER[1]], 40);
  const feature = { roadId: 'tiger-2025-or-41067-context-rd', name: 'NW Context Rd', roadClass: 'S1400', routeType: 'M',
    countyFips: '41067', countyName: 'Washington County, Oregon', sourceFeatureId: 'f1',
    geometry: { type: 'LineString', coordinates } };
  const regional = {
    provenance: Object.freeze({ source: 'Precomputed from verified regional GIS' }),
    selection: Object.freeze({ coverage: COVERAGE.FULL, reason: null, maxAnalysisDistanceM: 1000,
      publishedBounds: [SEARCH_CENTER[0] - 1, SEARCH_CENTER[1] - 1, SEARCH_CENTER[0] + 1, SEARCH_CENTER[1] + 1] }),
    async queryRoadNetwork() {
      return { coverage: COVERAGE.FULL, reason: null, note: null, features: [feature], bounded: true,
        provenance: { datasetId: 'regional-roads', agency: 'U.S. Census Bureau' }, diagnostics: { status: 'ready' } };
    },
    async analyzeDiscovery(corridors) {
      return { corridors: Object.fromEntries(corridors.map(entry => [entry.id, {}])),
        diagnostics: { status: 'ready', reason: null, corridorCount: corridors.length, queryMs: 1, datasetErrors: [] } };
    },
  };
  const gis = { async prepareRegionalSearch() { return regional; } };
  const run = await runDiscovery({ gis, searchArea: { id: 'context-raw', name: '1-mile radius', kind: 'radius',
    center: SEARCH_CENTER, radiusMiles: 1, catalogUrl: 'regional/manifest.json', raw: true } });
  assert.equal(run.status, 'ready');
  assert.equal(run.derived, undefined, 'this is the raw path, not the derived plane');
  assert.ok(run.results.length > 1, 'a 20-mile road is segmented into several corridors');
  const distances = run.results.map(result => result.distanceFromCenterM);
  assert.ok(distances.every(distance => Number.isFinite(distance)), 'every raw result is measured against the centre');
  assert.ok(Math.min(...distances) <= 1 * MI, 'the nearest corridor of the unit is inside the disk');
  assert.ok(Math.max(...distances) > 1 * MI,
    'the far corridors of an admitted unit are measured on themselves, not on the unit or a centroid');
  for (const result of run.results) {
    const corridor = run.raw.corridors.find(entry => entry.corridor.id === result.id).corridor;
    assert.equal(result.distanceFromCenterM, minDistanceToLineM(SEARCH_CENTER, corridor.geometry));
    assert.ok(Math.abs(haversineM(SEARCH_CENTER, result.nearestCenterPoint) - result.distanceFromCenterM) < 1e-6);
  }
  // Inclusion is still the unit rule, which is why the far corridors are here at all (the equivalence capture
  // records this difference from the derived plane, which selects per corridor).
  assert.ok(minDistanceToLineM(SEARCH_CENTER, { type: 'LineString', coordinates }) <= 1 * MI,
    'the unit that admitted these corridors is inside the disk');
});
