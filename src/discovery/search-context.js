import { METRES_PER_MILE } from './search-area.js';
import { cardinalDirection, closestPointOnLineM, initialBearingDeg } from '../domain/geometry.js';
import { formatCenter } from './search-definition.js';

// SEARCH CONTEXT.
//
// Where the search is, and where a discovered road lies relative to it. Two measured facts, added to what
// discovery already reports:
//
//   centre  -> nearest published place   "Near Vernonia, OR"   (a label, inferred, never the coordinates)
//   centre  -> nearest point of a road   "8.4 mi NW"           (straight-line distance and bearing)
//
// Neither fact is a ranking, a score, or a recommendation, and neither can change what a search returns: the
// centre is never moved to a place, corridors are never snapped, and the distance reported for a corridor is
// the same measurement the exact-radius search decided with (src/domain/geometry.js has one primitive).
export const CENTER_LABEL_KIND = Object.freeze({
  EXPLICIT_PLACE: 'explicit-place',
  NEAR_PLACE: 'near-place',
  COORDINATES: 'coordinates',
});

// Below this the direction from the centre to the nearest point of a road is noise (a road essentially at the
// centre has no meaningful bearing), so the distance is reported and the direction is left out.
export const BEARING_MIN_DISTANCE_M = 10;

export const CONTEXT_NOTE = 'Straight-line distance from the search centre to the nearest point on this road — '
  + 'not a driving distance, and not a ranking.';

// The one call that turns a centre and a corridor geometry into the context a result carries. The distance is
// the same value the radius test uses, taken in the same pass.
export function corridorContextFromCenter(center, geometry, { bearingMinDistanceM = BEARING_MIN_DISTANCE_M } = {}) {
  const nearest = closestPointOnLineM(center, geometry);
  if (!nearest) return null;
  const bearingDeg = nearest.distanceM < bearingMinDistanceM ? null : initialBearingDeg(center, nearest.nearestPoint);
  return Object.freeze({ distanceM: nearest.distanceM, nearestPoint: nearest.nearestPoint, bearingDeg,
    cardinal: bearingDeg == null ? null : cardinalDirection(bearingDeg) });
}

// Statute miles, the unit this interface already uses for radius and corridor length. A road through or beside
// the centre reports a floor rather than a false precision.
export function formatContextDistance(distanceM) {
  if (distanceM == null || !Number.isFinite(Number(distanceM))) return 'Not measured';
  const miles = Number(distanceM) / METRES_PER_MILE;
  if (miles < 0.05) return '<0.1 mi';
  return `${miles.toFixed(1)} mi`;
}

export function formatContextDirection({ distanceM = null, cardinal = null } = {}) {
  const distance = formatContextDistance(distanceM);
  if (distance === 'Not measured') return distance;
  return cardinal ? `${distance} ${cardinal}` : distance;
}

// What the interface calls the current centre, in one place so every surface agrees:
//
//   1. the place a person chose            "Hillsboro, OR"        (explicit, authoritative)
//   2. the nearest published place          "Near Vernonia, OR"    (inferred label, with its distance)
//   3. nothing near enough                  "45.12345, -123.54321" (the coordinates, which are the search)
//
// The coordinates stay available as secondary text in every case: the label never replaces them, and the
// centre is never moved to a place.
export function centerPresentation({ place = null, near = null, center = null } = {}) {
  const coordinates = Array.isArray(center) && center.length === 2 ? formatCenter(center) : null;
  if (place?.label) {
    return Object.freeze({ kind: CENTER_LABEL_KIND.EXPLICIT_PLACE, label: place.label, distanceM: null,
      coordinates, detail: coordinates });
  }
  if (near?.label) {
    return Object.freeze({ kind: CENTER_LABEL_KIND.NEAR_PLACE, label: near.label,
      distanceM: Number.isFinite(near.distanceM) ? near.distanceM : null, coordinates,
      detail: coordinates ? `${coordinates} · ${formatContextDistance(near.distanceM)} away` : null });
  }
  return Object.freeze({ kind: CENTER_LABEL_KIND.COORDINATES, label: coordinates ?? 'No centre chosen',
    distanceM: null, coordinates, detail: null });
}
