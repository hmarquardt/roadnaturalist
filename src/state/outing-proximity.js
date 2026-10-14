import { haversineM, linesOf, minDistanceToLineM } from '../domain/geometry.js';

// HOW FAR THE PERSON IS FROM THE ROAD THEY ARE WORKING.
//
// One measurement, taken from the geometry the saved road already carries: the shortest distance from the current
// position to the road itself - not to its middle, not to its bounding box, and not to the representative point. Nothing
// is fetched, nothing is routed, and no road is snapped to.
export const PROXIMITY_NOTE = 'Distance is straight-line proximity to the mapped road, not driving distance or road access.';
export const PROXIMITY_UNAVAILABLE = 'Road proximity is unavailable: this road has no mapped geometry to measure against.';
export const METRES_PER_FOOT = 0.3048;
const FEET_PER_MILE = 5280;
const FEET_THRESHOLD_M = 161;   // below a tenth of a mile, feet are the readable unit

// POINT TO CORRIDOR, in metres, over the geometry types the saved-road model actually publishes: a LineString or a
// MultiLineString (both handled by `linesOf`), measured with the domain's own nearest-point primitive so a distance can
// never disagree with the geometry decisions made from it. Anything else - a point, a polygon, no geometry at all -
// has no line to measure against and returns null rather than a made-up number.
export function pointToCorridorM(point, geometry) {
  if (!Array.isArray(point) || !point.every(Number.isFinite)) return null;
  if (!linesOf(geometry).length) return null;
  const distanceM = minDistanceToLineM(point, geometry);
  return Number.isFinite(distanceM) ? distanceM : null;
}

// THE PROXIMITY OF ONE PLAN MEMBER TO ONE POSITION, with the basis it was measured on.
//
//   road-geometry        the shortest distance to the road's own mapped line (the answer)
//   representative-point the distance to the road's representative point, used ONLY when the road has no mapped line to
//                        measure against, and labelled as such
//   null                 neither is available
export function roadProximity({ point = null, member = null } = {}) {
  if (!Array.isArray(point) || !point.every(Number.isFinite) || !member) return Object.freeze({ metres: null, basis: null });
  const onRoad = pointToCorridorM(point, member.geometry ?? null);
  if (onRoad != null) return Object.freeze({ metres: onRoad, basis: 'road-geometry' });
  const representative = member.representative ?? null;
  if (Array.isArray(representative) && representative.every(Number.isFinite)) {
    return Object.freeze({ metres: haversineM(point, representative), basis: 'representative-point' });
  }
  return Object.freeze({ metres: null, basis: null });
}

// A DISTANCE ROUNDED TO WHAT THE FIX CAN ACTUALLY SUPPORT.
//
// A reading that is only accurate to 30 m cannot support "23 ft away". So when the device reports its accuracy, the
// distance is rounded to at least that accuracy - and never below ten metres, so a very good fix still does not produce
// false precision - and the result is never smaller than one step of that granularity.
export function proximityDistance(metres, { accuracyM = null } = {}) {
  if (!Number.isFinite(metres) || metres < 0) return null;
  const step = Number.isFinite(accuracyM) && accuracyM > 0 ? Math.max(accuracyM, 10) : 0;
  if (!step) return metres;
  return Math.max(step, Math.round(metres / step) * step);
}

export function formatProximityDistance(metres) {
  if (!Number.isFinite(metres) || metres < 0) return null;
  if (metres < FEET_THRESHOLD_M) {
    const feet = Math.round(metres / METRES_PER_FOOT / 10) * 10;
    return `${Math.max(10, feet)} ft`;
  }
  // The precision follows the ROUNDED value, so a distance that rounds up to ten miles reads as "10 mi" rather than
  // "10.0 mi".
  const rounded = Math.round(metres / METRES_PER_FOOT / FEET_PER_MILE * 10) / 10;
  return `${rounded.toFixed(rounded < 10 ? 1 : 0)} mi`;
}

// THE SENTENCE. Two bands, deterministically:
//   * a distance at or below the device's own accuracy is reported as "Near this road" - the fix cannot support a
//     number, and a number there would be a claim the reading does not make;
//   * otherwise the distance is stated as a rounded straight line.
// A distance measured to a representative point instead of to the road says so, because it is a different claim.
export function proximityLabel({ metres = null, accuracyM = null, basis = 'road-geometry' } = {}) {
  if (!Number.isFinite(metres)) return null;
  if (basis === 'representative-point') {
    return `About ${formatProximityDistance(proximityDistance(metres, { accuracyM }))} from this road's representative point`;
  }
  if (Number.isFinite(accuracyM) && accuracyM > 0 && metres <= accuracyM) return 'Near this road';
  return `About ${formatProximityDistance(proximityDistance(metres, { accuracyM }))} from this road`;
}

// HOW CLOSE COUNTS AS "NEAR", in one rule shared by the sentence above and by the emphasis the field view puts on the
// Mark visited button: within the fix's own accuracy, or within 100 m when the device did not report one. Being near a
// road never marks anything - it only makes the person's own button easier to see.
export const NEAR_ROAD_M = 100;
export function isNearRoad({ metres = null, accuracyM = null } = {}) {
  if (!Number.isFinite(metres)) return false;
  const threshold = Number.isFinite(accuracyM) && accuracyM > 0 ? accuracyM : NEAR_ROAD_M;
  return metres <= threshold;
}
