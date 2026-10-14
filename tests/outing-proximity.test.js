import test from 'node:test';
import assert from 'node:assert/strict';

import { NEAR_ROAD_M, PROXIMITY_NOTE, formatProximityDistance, isNearRoad, pointToCorridorM, proximityDistance,
  proximityLabel, roadProximity } from '../src/state/outing-proximity.js';
import { fieldProximity } from '../src/state/outing-field.js';
import { LIVE_LOCATION_STATUS, liveLocationReading } from '../src/state/live-location.js';
import { LOCATION_STATUS } from '../src/discovery/geolocation.js';

// HOW FAR THE ROAD IS, MEASURED TO THE ROAD.
//
// The distance is the shortest straight line from the person to the mapped line of the road they are working - not to its
// middle, not to its representative point, and not a drive. These tests pin the geometry, the fallback, the units and the
// one rule that keeps a coarse fix from claiming a precise distance.
const LON_PER_M = 1 / (111320 * Math.cos(45.5 * Math.PI / 180));
const CENTER = [-122.9, 45.55];
// A road running due east, so "north of it" is a clean distance.
const eastWest = (lon, lat, metres = 3000) => ({ type: 'LineString', coordinates: [[lon, lat],
  [lon + metres * LON_PER_M, lat]] });
const northOf = (lat, metres) => [CENTER[0], lat + metres / 110540];

test('the distance is to the road itself, over every line it is made of', () => {
  const road = eastWest(CENTER[0], CENTER[1]);
  // A point 100 m north of the line is 100 m from the road, wherever along it the point is.
  assert.ok(Math.abs(pointToCorridorM(northOf(CENTER[1], 100), road) - 100) < 1);
  assert.ok(Math.abs(pointToCorridorM([CENTER[0] + 1000 * LON_PER_M, CENTER[1] + 100 / 110540], road) - 100) < 1);
  // A POINT ON THE SEGMENT IS AT ZERO, and so is a point on its far end.
  assert.ok(pointToCorridorM([CENTER[0], CENTER[1]], road) < 0.001);
  const far = [CENTER[0] + 3000 * LON_PER_M, CENTER[1]];
  assert.ok(pointToCorridorM(far, road) < 0.001, 'the far end of the line is on the line');
  // Beyond the end, the distance is to the endpoint - a line, not an infinite ray.
  assert.ok(Math.abs(pointToCorridorM([CENTER[0] + 4000 * LON_PER_M, CENTER[1]], road) - 1000) < 5);
  // A MULTILINE STRING IS MEASURED OVER ALL OF ITS PARTS, and the nearest part wins.
  const multi = { type: 'MultiLineString', coordinates: [eastWest(CENTER[0], CENTER[1]).coordinates,
    eastWest(CENTER[0], CENTER[1] + 0.02).coordinates] };
  const between = northOf(CENTER[1] + 0.02, 60);
  assert.ok(Math.abs(pointToCorridorM(between, multi) - 60) < 1, 'the nearer of the two lines is the answer');
  assert.ok(pointToCorridorM(northOf(CENTER[1], 5), multi) < 6);
  // A NEAREST VERTEX BEATS A FAR PROJECTION: a point beside the junction of two parts.
  const corner = { type: 'MultiLineString', coordinates: [[[CENTER[0], CENTER[1]], [CENTER[0] + 0.01, CENTER[1]]],
    [[CENTER[0], CENTER[1]], [CENTER[0], CENTER[1] + 0.01]]] };
  assert.ok(pointToCorridorM([CENTER[0] - 50 * LON_PER_M, CENTER[1] - 50 / 110540], corner) < 80);
  // No line at all - a point, a polygon, nothing - is not a measurement.
  assert.equal(pointToCorridorM([CENTER[0], CENTER[1]], { type: 'Point', coordinates: CENTER }), null);
  assert.equal(pointToCorridorM([CENTER[0], CENTER[1]], null), null);
  assert.equal(pointToCorridorM(null, road), null);
  assert.equal(pointToCorridorM(['x', 'y'], road), null);
});

test('a road with no mapped line falls back to its representative point, and says so', () => {
  const point = northOf(CENTER[1], 400);
  const withGeometry = { geometry: eastWest(CENTER[0], CENTER[1]), representative: [CENTER[0], CENTER[1] + 0.02] };
  const measured = roadProximity({ point, member: withGeometry });
  assert.equal(measured.basis, 'road-geometry');
  assert.ok(Math.abs(measured.metres - 400) < 5, 'the road itself is what is measured');
  assert.ok(measured.metres < 1000, 'and never the representative point, which is much further away');
  // WITHOUT GEOMETRY, the representative point is used - and the answer is labelled as a different claim.
  const noGeometry = { geometry: null, representative: [CENTER[0], CENTER[1] + 0.02] };
  const fallback = roadProximity({ point, member: noGeometry });
  assert.equal(fallback.basis, 'representative-point');
  assert.ok(fallback.metres > 1500, 'the distance is to the point, not to a road');
  assert.match(proximityLabel({ ...fallback, accuracyM: null }), /from this road's representative point$/);
  // A road with neither is not measured at all, and no number is invented for it.
  const neither = roadProximity({ point, member: { geometry: null, representative: null } });
  assert.equal(neither.metres, null);
  assert.equal(neither.basis, null);
  assert.equal(proximityLabel(neither), null);
  assert.equal(roadProximity({ point: null, member: withGeometry }).metres, null);
  assert.equal(roadProximity({ point: ['x', 'y'], member: withGeometry }).metres, null);
});

test('a distance is stated in feet or miles, and rounded to what the fix supports', () => {
  assert.equal(formatProximityDistance(67), '220 ft');
  assert.equal(formatProximityDistance(3), '10 ft');
  assert.equal(formatProximityDistance(150), '490 ft');
  assert.equal(formatProximityDistance(161), '0.1 mi');
  assert.equal(formatProximityDistance(644), '0.4 mi');
  assert.equal(formatProximityDistance(16_093), '10 mi');
  assert.equal(formatProximityDistance(40_234), '25 mi');
  assert.equal(formatProximityDistance(null), null);
  // ROUNDING FOLLOWS THE FIX. A reading accurate to 30 m cannot support a distance of 21 m, so the distance is rounded to
  // the accuracy; a very good fix still never produces sub-10 m precision.
  assert.equal(proximityDistance(21, { accuracyM: 30 }), 30);
  assert.equal(proximityDistance(45, { accuracyM: 30 }), 60);
  assert.equal(proximityDistance(200, { accuracyM: 5 }), 200);
  assert.equal(proximityDistance(204, { accuracyM: null }), 204, 'with no accuracy, the measurement stands as it is');
  assert.equal(proximityDistance(204, { accuracyM: 0 }), 204);
  assert.equal(proximityDistance(null), null);
});

test('a distance inside the fix’s own accuracy is reported as near, not as a number', () => {
  // 23 ft away with a fix accurate to 30 m: the number would be a claim the reading cannot make.
  assert.equal(proximityLabel({ metres: 7, accuracyM: 30 }), 'Near this road');
  assert.equal(proximityLabel({ metres: 30, accuracyM: 30 }), 'Near this road');
  assert.equal(proximityLabel({ metres: 31, accuracyM: 30 }), 'About 100 ft from this road', 'a 31 m measurement with a 30 m fix is reported at the fix’s own granularity');
  assert.equal(proximityLabel({ metres: 644, accuracyM: 18 }), 'About 0.4 mi from this road');
  assert.equal(proximityLabel({ metres: 67, accuracyM: null }), 'About 220 ft from this road');
  assert.equal(proximityLabel({ metres: 0, accuracyM: null }), 'About 10 ft from this road');
  assert.equal(proximityLabel({ metres: null }), null);
  assert.equal(proximityLabel({}), null);
  // The same rule decides what "near" means for the emphasis on the person's own button.
  assert.equal(isNearRoad({ metres: 7, accuracyM: 30 }), true);
  assert.equal(isNearRoad({ metres: 40, accuracyM: 30 }), false);
  assert.equal(isNearRoad({ metres: 40, accuracyM: null }), true, 'with no accuracy, a hundred metres is near');
  assert.equal(isNearRoad({ metres: NEAR_ROAD_M + 1, accuracyM: null }), false);
  assert.equal(isNearRoad({ metres: null }), false);
});

test('the wording is proximity, and never a drive, a time or an arrival', () => {
  const labels = [proximityLabel({ metres: 644, accuracyM: 18 }), proximityLabel({ metres: 7, accuracyM: 30 }),
    proximityLabel({ metres: 900, accuracyM: null, basis: 'representative-point' })];
  for (const text of labels) {
    assert.ok(!/drive|driving|travel|ETA|arriv|turn|route|minute/i.test(text), `no routing claim: ${text}`);
  }
  assert.match(PROXIMITY_NOTE, /straight-line proximity to the mapped road/);
  assert.match(PROXIMITY_NOTE, /not driving distance or road access/);
});
