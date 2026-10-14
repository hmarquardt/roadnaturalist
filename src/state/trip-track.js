import { haversineM } from '../domain/geometry.js';

// A RECORDED TRACK: THE POINTS THE DEVICE ACTUALLY REPORTED, SAMPLED AND VALIDATED.
//
// Nothing here infers anything. A track is a list of fixes the browser gave, thinned by one documented rule so a parked
// car does not fill storage with duplicates and a highway drive does not store every callback; a fix too poor to place
// on a road is not recorded at all (live location still shows it honestly); and the length is the sum of the straight
// lines between the points that were kept, which is a recorded GPS track and never a driving distance.
export const TRIP_SAMPLING = Object.freeze({
  // A POINT EVERY HUNDRED METRES, however fast the movement: at road speed this is the rule that fires, and it gives a
  // trace detailed enough to see which roads were driven without storing a point per second.
  MIN_MOVE_M: 100,
  // OR A POINT EVERY FIFTEEN SECONDS, but only once the position has drifted further than ordinary GPS noise. A vehicle
  // that is parked therefore records nothing at all, however long it stands.
  MIN_DRIFT_M: 25,
  MIN_INTERVAL_MS: 15_000,
  // A FIX THIS POOR IS NOT RECORDED. Two hundred and fifty metres is far beyond any road width: such a point cannot be
  // placed on a road, so it would only add noise to a trace. Live location still displays it, with its accuracy.
  MAX_ACCURACY_M: 250,
  // The bound on one trip. Five thousand points is over twenty hours of continuous recording at the time rule below, and
  // about 470 kB of JSON at the measured 93 bytes a point - a recording that reaches it is reported as truncated rather
  // than silently losing data.
  MAX_POINTS: 5000,
  // A LEG FASTER THAN THIS IS AN IMPLAUSIBLE JUMP - a GPS artefact, a resumed session, a teleport - and it is excluded
  // from the recorded length and counted, never removed from the track and never smoothed away.
  MAX_LEG_SPEED_MPS: 100,
  MAX_LEG_M: 1000,
});

// ONE POINT, VALIDATED. Only finite, in-world coordinates and a usable timestamp are a recorded fix; nothing is
// manufactured for a value the device did not report.
export function trackPoint(value) {
  if (!value || typeof value !== 'object') return null;
  const lon = Number(value.lon);
  const lat = Number(value.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const recordedAt = typeof value.recordedAt === 'string' && Number.isFinite(new Date(value.recordedAt).getTime())
    ? value.recordedAt : null;
  if (!recordedAt) return null;
  const accuracyM = Number.isFinite(value.accuracyM) && value.accuracyM >= 0 ? Number(value.accuracyM) : null;
  return Object.freeze({ lon, lat, accuracyM, recordedAt });
}

export function trackPointFromReading(location, { at = new Date().toISOString() } = {}) {
  return trackPoint({ lon: location?.point?.[0], lat: location?.point?.[1], accuracyM: location?.accuracyM ?? null,
    recordedAt: at });
}

export function accuracyAcceptable(point, { maxAccuracyM = TRIP_SAMPLING.MAX_ACCURACY_M } = {}) {
  // An unreported accuracy is not a bad one: a device that does not say how well it knows is recorded as it is.
  if (point?.accuracyM == null) return true;
  return point.accuracyM <= maxAccuracyM;
}

// THE SAMPLING RULE, in one place, and deterministic:
//   1. the first point of a trip is always recorded;
//   2. a point that has moved at least `MIN_MOVE_M` from the last recorded one is recorded;
//   3. otherwise a point that has drifted at least `MIN_DRIFT_M` AND is at least `MIN_INTERVAL_MS` after the last
//      recorded one is recorded;
//   4. anything else is skipped, and counted.
export function samplingDecision(point, last, options = {}) {
  const { minMoveM = TRIP_SAMPLING.MIN_MOVE_M, minDriftM = TRIP_SAMPLING.MIN_DRIFT_M,
    minIntervalMs = TRIP_SAMPLING.MIN_INTERVAL_MS } = options;
  if (!point) return Object.freeze({ record: false, reason: 'invalid' });
  if (!last) return Object.freeze({ record: true, reason: 'first' });
  const moved = haversineM([last.lon, last.lat], [point.lon, point.lat]);
  if (moved >= minMoveM) return Object.freeze({ record: true, reason: 'moved' });
  const elapsed = new Date(point.recordedAt).getTime() - new Date(last.recordedAt).getTime();
  if (moved >= minDriftM && elapsed >= minIntervalMs) return Object.freeze({ record: true, reason: 'interval' });
  return Object.freeze({ record: false, reason: 'unchanged' });
}

// APPEND ONE READING TO A TRACK, and say what happened. The caller keeps the diagnostics; the rule itself is not
// duplicated anywhere.
export function appendTrackPoint(points, value, options = {}) {
  const maxPoints = options.maxPoints ?? TRIP_SAMPLING.MAX_POINTS;
  const point = trackPoint(value);
  if (!point) return Object.freeze({ points, added: false, reason: 'invalid', full: false });
  if (!accuracyAcceptable(point, options)) {
    return Object.freeze({ points, added: false, reason: 'poor-accuracy', full: false });
  }
  if (points.length >= maxPoints) return Object.freeze({ points, added: false, reason: 'full', full: true });
  const decision = samplingDecision(point, points[points.length - 1] ?? null, options);
  if (!decision.record) return Object.freeze({ points, added: false, reason: decision.reason, full: false });
  return Object.freeze({ points: Object.freeze([...points, point]), added: true, reason: decision.reason, full: false });
}

// THE RECORDED LENGTH: the straight lines between consecutive recorded points, with an implausible jump excluded and
// reported rather than smoothed over.
export function trackLengthM(points, options = {}) {
  const { maxSpeedMps = TRIP_SAMPLING.MAX_LEG_SPEED_MPS, maxLegM = TRIP_SAMPLING.MAX_LEG_M } = options;
  let metres = 0;
  let countedLegs = 0;
  let skippedLegs = 0;
  let skippedMetres = 0;
  for (let index = 1; index < (points ?? []).length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const legM = haversineM([from.lon, from.lat], [to.lon, to.lat]);
    const seconds = (new Date(to.recordedAt).getTime() - new Date(from.recordedAt).getTime()) / 1000;
    // NO ELAPSED TIME IS NOT EVIDENCE OF A JUMP: a browser can deliver two readings in the same millisecond, and the
    // distance between them is still a movement. A leg is only an artefact when it is longer than any plausible single leg
    // AND the time it claims to have taken is too short to have driven it.
    const implausible = legM > maxLegM && (seconds <= 0 || legM / seconds > maxSpeedMps);
    if (implausible) { skippedLegs += 1; skippedMetres += legM; continue; }
    metres += legM;
    countedLegs += 1;
  }
  return Object.freeze({ metres, countedLegs, skippedLegs, skippedMetres });
}

export function trackDurationMs(points) {
  if (!points?.length) return 0;
  return new Date(points[points.length - 1].recordedAt).getTime() - new Date(points[0].recordedAt).getTime();
}

// The track as GeoJSON, which is what an export carries and what the map draws. One point is a degenerate line: it is
// still a place the device reported, and a LineString of one coordinate is how GeoJSON says that.
export function trackGeometry(points) {
  if (!(points ?? []).length) return null;
  return Object.freeze({ type: 'LineString',
    coordinates: Object.freeze(points.map(point => Object.freeze([point.lon, point.lat]))) });
}

// The recorded track, said the way the interface says it: a recorded GPS track, never a driving distance.
export function formatTrackLength(metres) {
  if (!Number.isFinite(metres) || metres < 0) return null;
  const miles = metres / 1609.344;
  if (miles < 0.1) {
    // UNDER A TENTH OF A MILE IS SAID IN FEET, rounded to ten of them: "0.0 mi" would be a claim about precision this
    // does not have, and a zero-length track is honestly zero.
    const feet = Math.round(metres / 0.3048);
    return feet < 10 ? `${feet} ft` : `${Math.round(feet / 10) * 10} ft`;
  }
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
