import test from 'node:test';
import assert from 'node:assert/strict';

import { TRIP_SAMPLING, accuracyAcceptable, appendTrackPoint, formatDuration, formatTrackLength, samplingDecision,
  trackDurationMs, trackGeometry, trackLengthM, trackPoint, trackPointFromReading } from '../src/state/trip-track.js';
import { haversineM } from '../src/domain/geometry.js';

// A TRACK IS THE POINTS THE DEVICE REPORTED, SAMPLED AND VALIDATED - AND NOTHING ELSE.
//
// These tests pin the three rules this file exists for: what makes a reading a point at all, which points are worth keeping
// (so a parked car does not fill storage and a highway drive does not store every callback), and what length a recorded
// track may honestly claim. Nothing here smooths, matches or infers.
const CENTER = [-122.9, 45.55];
const LAT_PER_M = 1 / 110540;
// A point due north of the centre, `metres` away.
const northOf = (metres, seconds, { accuracyM = 10, from = CENTER } = {}) =>
  ({ lon: from[0], lat: from[1] + metres * LAT_PER_M, accuracyM,
    recordedAt: new Date(Date.UTC(2026, 9, 14, 15, 0, 0) + seconds * 1000).toISOString() });

test('a point is validated: finite, in-world coordinates and a usable time, and nothing is manufactured', () => {
  const good = trackPoint({ lon: -122.9, lat: 45.55, accuracyM: 12, recordedAt: '2026-10-14T15:00:00.000Z' });
  assert.deepEqual({ ...good }, { lon: -122.9, lat: 45.55, accuracyM: 12, recordedAt: '2026-10-14T15:00:00.000Z' });
  // NAN, INFINITY AND A MISSING COORDINATE ARE NOT A PLACE.
  assert.equal(trackPoint({ lon: NaN, lat: 45, recordedAt: '2026-10-14T15:00:00.000Z' }), null);
  assert.equal(trackPoint({ lon: -122.9, lat: Infinity, recordedAt: '2026-10-14T15:00:00.000Z' }), null);
  assert.equal(trackPoint({ lat: 45, recordedAt: '2026-10-14T15:00:00.000Z' }), null);
  // OUT OF THE WORLD IS OUT OF THE RECORD.
  assert.equal(trackPoint({ lon: -122.9, lat: 91, recordedAt: '2026-10-14T15:00:00.000Z' }), null);
  assert.equal(trackPoint({ lon: 181, lat: 45, recordedAt: '2026-10-14T15:00:00.000Z' }), null);
  // AN UNUSABLE TIME IS NOT A TIME: a point with no clock cannot be sampled, ordered or measured.
  assert.equal(trackPoint({ lon: -122.9, lat: 45.55, recordedAt: 'yesterday' }), null);
  assert.equal(trackPoint({ lon: -122.9, lat: 45.55 }), null);
  // AN ACCURACY THE DEVICE DID NOT REPORT IS NOT INVENTED, and neither is a negative one.
  assert.equal(trackPoint({ lon: -122.9, lat: 45.55, recordedAt: '2026-10-14T15:00:00.000Z' }).accuracyM, null);
  assert.equal(trackPoint({ lon: -122.9, lat: 45.55, accuracyM: -3, recordedAt: '2026-10-14T15:00:00.000Z' }).accuracyM, null);
  // A NUMERIC STRING IS READ AS THE NUMBER IT IS.
  assert.equal(trackPoint({ lon: '-122.9', lat: '45.55', recordedAt: '2026-10-14T15:00:00.000Z' }).lon, -122.9);
  // A LIVE READING BECOMES A POINT AT THE MOMENT IT IS OFFERED.
  const fromReading = trackPointFromReading({ point: [-122.9, 45.55], accuracyM: 8 },
    { at: '2026-10-14T15:00:00.000Z' });
  assert.equal(fromReading.lat, 45.55);
  assert.equal(fromReading.accuracyM, 8);
  assert.equal(fromReading.recordedAt, '2026-10-14T15:00:00.000Z');
  assert.equal(trackPointFromReading({ point: null }, { at: '2026-10-14T15:00:00.000Z' }), null);
});

test('the sampling rule keeps the first point, a real movement, and a slow drift - and nothing else', () => {
  const first = trackPoint(northOf(0, 0));
  // THE FIRST POINT IS ALWAYS KEPT: a recording with no points records nothing.
  assert.deepEqual({ ...samplingDecision(first, null) }, { record: true, reason: 'first' });
  // MOVEMENT KEEPS A POINT, however long or short the interval.
  const moved = samplingDecision(trackPoint(northOf(120, 2)), first);
  assert.equal(moved.record, true);
  assert.equal(moved.reason, 'moved', 'a hundred metres in two seconds is a point worth keeping');
  assert.equal(samplingDecision(trackPoint(northOf(TRIP_SAMPLING.MIN_MOVE_M, 1)), first).record, true);
  assert.equal(samplingDecision(trackPoint(northOf(TRIP_SAMPLING.MIN_MOVE_M - 1, 1)), first).record, false);
  // A SLOW DRIFT KEEPS A POINT ONLY ONCE THE INTERVAL HAS PASSED.
  const drifted = samplingDecision(trackPoint(northOf(40, 20)), first);
  assert.equal(drifted.record, true);
  assert.equal(drifted.reason, 'interval');
  assert.equal(samplingDecision(trackPoint(northOf(40, 5)), first).record, false, 'five seconds is not an interval');
  assert.equal(samplingDecision(trackPoint(northOf(10, 600)), first).record, false,
    'ten metres after ten minutes is noise, not movement');
  // A PARKED VEHICLE RECORDS NOTHING AT ALL, however long it stands: the rule is not "a point every fifteen seconds".
  let parked = [first];
  for (let index = 1; index <= 240; index += 1) {
    const outcome = appendTrackPoint(parked, northOf(3 * (index % 3), index * 15));
    parked = outcome.points;
  }
  assert.equal(parked.length, 1, 'two hours of standing still is still one point');
});

test('a fix too poor to place on a road is not recorded, and an unreported accuracy is not a poor one', () => {
  const good = trackPoint(northOf(0, 0, { accuracyM: 5 }));
  const poor = trackPoint(northOf(500, 30, { accuracyM: TRIP_SAMPLING.MAX_ACCURACY_M + 1 }));
  assert.equal(accuracyAcceptable(poor), false);
  const outcome = appendTrackPoint([good], poor);
  assert.equal(outcome.added, false);
  assert.equal(outcome.reason, 'poor-accuracy');
  assert.equal(outcome.points.length, 1, 'the track is untouched');
  // THE BOUNDARY IS INCLUSIVE, and a device that does not state its accuracy is recorded as it is.
  assert.equal(appendTrackPoint([good], trackPoint(northOf(500, 30, { accuracyM: TRIP_SAMPLING.MAX_ACCURACY_M }))).added, true);
  assert.equal(appendTrackPoint([good], trackPoint(northOf(500, 30, { accuracyM: null }))).added, true);
});

test('a reading that cannot be validated or is not needed is counted, never stored', () => {
  const first = trackPoint(northOf(0, 0));
  const invalid = appendTrackPoint([first], { lon: NaN, lat: 45, recordedAt: '2026-10-14T15:00:00.000Z' });
  assert.equal(invalid.added, false);
  assert.equal(invalid.reason, 'invalid');
  const unchanged = appendTrackPoint([first], trackPoint(northOf(5, 2)));
  assert.equal(unchanged.added, false);
  assert.equal(unchanged.reason, 'unchanged');
  assert.equal(unchanged.points.length, 1);
  // AND THE BOUND IS A BOUND: a track that reaches its own limit says so rather than growing without end.
  const capped = appendTrackPoint([first], trackPoint(northOf(500, 30)), { maxPoints: 1 });
  assert.equal(capped.added, false);
  assert.equal(capped.reason, 'full');
  assert.equal(capped.full, true);
  assert.equal(TRIP_SAMPLING.MAX_POINTS, 5000);
});


test('the recorded length is the sum of the legs that are physically possible', () => {
  const a = trackPoint(northOf(0, 0));
  const b = trackPoint(northOf(1000, 60));
  const straight = trackLengthM([a, b]);
  assert.equal(straight.countedLegs, 1);
  assert.equal(straight.skippedLegs, 0);
  assert.ok(Math.abs(straight.metres - haversineM([a.lon, a.lat], [b.lon, b.lat])) < 0.001,
    'the length is the geodesic distance between the points that were kept');
  // A TELEPORT IS EXCLUDED FROM THE LENGTH AND REPORTED - never removed from the track, and never smoothed over.
  const teleport = trackPoint(northOf(60000, 65));
  const jumped = trackLengthM([a, b, teleport]);
  assert.equal(jumped.skippedLegs, 1);
  assert.ok(jumped.skippedMetres > 50000);
  assert.ok(Math.abs(jumped.metres - straight.metres) < 0.001, 'the impossible leg added nothing');
  // A LEG WITH NO ELAPSED TIME IS NOT AUTOMATICALLY AN ARTEFACT - a browser can deliver two readings in the same
  // millisecond - but a long hop with no time at all is.
  const burst = trackLengthM([a, trackPoint(northOf(200, 0))]);
  assert.equal(burst.countedLegs, 1, 'a short movement in the same millisecond is still a movement');
  assert.equal(trackLengthM([a, trackPoint(northOf(2000, 0))]).skippedLegs, 1, 'a two-kilometre hop in no time is not');
  // A FAST BUT PLAUSIBLE LEG IS KEPT: a hundred kilometres an hour is not an artefact.
  const fast = trackLengthM([a, trackPoint(northOf(2800, 100))]);
  assert.equal(fast.countedLegs, 1);
  assert.equal(fast.skippedLegs, 0);
  // ONE POINT IS NOT A DISTANCE, AND NEITHER IS NOTHING.
  assert.equal(trackLengthM([a]).metres, 0);
  assert.equal(trackLengthM([]).metres, 0);
  assert.equal(trackLengthM(null).metres, 0);
});

test('the track is geometry the map can draw and an export can carry', () => {
  const points = [trackPoint(northOf(0, 0)), trackPoint(northOf(100, 30))];
  const line = trackGeometry(points);
  assert.equal(line.type, 'LineString');
  assert.deepEqual(line.coordinates.map(entry => [...entry]), [[CENTER[0], CENTER[1]],
    [CENTER[0], CENTER[1] + 100 * LAT_PER_M]]);
  assert.equal(trackGeometry([]), null, 'an empty track is no geometry at all');
  // A SINGLE POINT IS A DEGENERATE LINE, which is how GeoJSON says "here, once".
  assert.equal(trackGeometry([points[0]]).coordinates.length, 1);
});

test('a recorded length and a duration are said in the units a person reads', () => {
  assert.equal(formatTrackLength(0), '0 ft');
  assert.equal(formatTrackLength(30), '100 ft', 'a very short track is not "0.0 mi"');
  assert.equal(formatTrackLength(1609.344), '1.0 mi');
  assert.equal(formatTrackLength(1609.344 * 31.6), '32 mi');
  assert.equal(formatTrackLength(null), null);
  assert.equal(formatDuration(0), 'under a minute');
  assert.equal(formatDuration(90 * 1000), '2 min');
  assert.equal(formatDuration((2 * 60 + 14) * 60 * 1000), '2h 14m');
  assert.equal(formatDuration(3 * 60 * 60 * 1000), '3h');
  assert.equal(formatDuration(null), null);
  assert.equal(trackDurationMs([trackPoint(northOf(0, 0)), trackPoint(northOf(100, 90))]), 90000);
  assert.equal(trackDurationMs([]), 0);
});

test('a realistic two-hour drive is a small record, not a telemetry dump', () => {
  // MEASURED, because the storage decision depends on it: a two-hour drive at highway speed through the sampling rule, and
  // the JSON that would be written for it. One reading a second at 25 m/s, which is the noisiest the browser will be on a
  // road.
  let points = [];
  let seconds = 0;
  let metres = 0;
  for (let index = 0; index < 7200; index += 1) {
    seconds += 1;
    metres += 25;
    points = appendTrackPoint(points, northOf(metres, seconds, { accuracyM: 8 })).points;
  }
  const json = JSON.stringify(points);
  const bytesPerPoint = json.length / points.length;
  assert.equal(points.length, 1800,
    'two hours of highway driving is one point per hundred metres of movement, not one per second');
  assert.ok(bytesPerPoint < 100, `a recorded point is about ${Math.round(bytesPerPoint)} bytes of JSON`);
  assert.ok(json.length < 200 * 1024, `so the whole track is under 200 kB (got ${json.length})`);
  assert.ok(trackLengthM(points).metres > 160000, 'and it measures the drive it recorded');
  // eslint-disable-next-line no-console -- the measurement is the point of this test, and it holds no coordinate
  console.log(`TRIP_TRACK_SIZE ${JSON.stringify({ points: points.length, bytes: json.length,
    bytesPerPoint: Math.round(bytesPerPoint), metres: Math.round(trackLengthM(points).metres) })}`);
});
