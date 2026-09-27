import { METRES_PER_MILE } from './search-area.js';
import { cardinalDirection, closestPointOnLineM, initialBearingDeg, minDistanceToLineM } from '../domain/geometry.js';
import { formatCenter } from './search-definition.js';
import { nearestPlace } from './place-gazetteer.js';
import { PROMOTION_MAX_DRIFT_M } from './promotion.js';

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

// The presentation of the search a run actually made, for a centre that may no longer be the draft centre: a
// label that still describes that centre is kept exactly as it was, and otherwise the label is derived from
// that centre now. A newer draft centre can never relabel an older run, and a centre no published place is near
// is labelled by its coordinates.
export function runCenterPresentation({ center, place = null, near = null, definitionCenter = null, gazetteer = null } = {}) {
  if (!validCoordinate(center)) return null;
  const draft = validCoordinate(definitionCenter) ? definitionCenter : null;
  const sameCenter = Boolean(draft && draft[0] === center[0] && draft[1] === center[1]);
  if (sameCenter) return Object.freeze({ ...centerPresentation({ place, near, center }), placeId: place?.id ?? near?.id ?? null });
  const found = gazetteer ? nearestPlace(center, gazetteer) : null;
  return Object.freeze({ ...centerPresentation({ near: found, center }), placeId: found?.place?.id ?? null });
}

// ------------------------------------------------ promotion context
//
// A corridor promoted out of a radius search keeps the orientation it was chosen with: the centre of that
// search, how that centre was named, and the measured relationship between the centre and the nearest point of
// this corridor. It is historical presentation metadata - the same class of fact as the discovery row's
// "8.4 mi NW", kept so a person does not lose their bearings when they move from discovery into investigation.
// It is not GIS evidence, not a ranking, and not an input to anything the detailed panel measures.
//
// The centre is a snapshot: changing the search afterwards (a new centre, a new radius, another place) never
// rewrites a candidate that was already promoted. The measured values are re-derived from the promoted
// corridor at promotion time and checked against the discovery measurement (verifyPromotionSearchContext), so a
// promoted candidate always describes the corridor it actually carries.
export const SEARCH_CONTEXT_KIND = 'discovery-search-context';
export const SEARCH_CONTEXT_NOTE = 'Straight-line distance from the search centre to the nearest point of this '
  + 'corridor — not a driving distance, and not a ranking.';
export const MAX_SEARCH_CONTEXT_LABEL_LENGTH = 80;

// A candidate with no centre, no measurement, or an unmeasurable corridor gets no context at all: a candidate
// without one is a valid candidate, and inventing a centre would be worse than saying nothing.
export function pendingSearchContext({ center = null, radiusMiles = null, centerLabel = null, centerLabelKind = null,
  placeId = null, distanceFromCenterM = null, nearestCenterPoint = null, bearingFromCenterDeg = null,
  cardinalFromCenter = null } = {}) {
  if (!validCoordinate(center) || !validCoordinate(nearestCenterPoint)) return null;
  if (!Number.isFinite(distanceFromCenterM) || distanceFromCenterM < 0) return null;
  const kind = Object.values(CENTER_LABEL_KIND).includes(centerLabelKind) ? centerLabelKind : CENTER_LABEL_KIND.COORDINATES;
  const label = typeof centerLabel === 'string' && centerLabel.trim() && centerLabel.trim().length <= MAX_SEARCH_CONTEXT_LABEL_LENGTH
    ? centerLabel.trim() : formatCenter(center);
  return Object.freeze({ kind: SEARCH_CONTEXT_KIND, center: Object.freeze([center[0], center[1]]),
    centerLabel: label, centerLabelKind: kind, placeId: typeof placeId === 'string' && placeId ? placeId : null,
    radiusMiles: Number.isFinite(radiusMiles) && radiusMiles > 0 ? radiusMiles : null,
    distanceFromCenterM: Number(distanceFromCenterM),
    nearestCenterPoint: Object.freeze([nearestCenterPoint[0], nearestCenterPoint[1]]),
    bearingFromCenterDeg: Number.isFinite(bearingFromCenterDeg) ? Number(bearingFromCenterDeg) : null,
    cardinalFromCenter: typeof cardinalFromCenter === 'string' && cardinalFromCenter ? cardinalFromCenter : null,
    verification: null });
}

// The measured relationship of a promotion context, in the shape the discovery row and the formatters share:
// "4.2 mi NW". One place maps the record's field names onto the display vocabulary.
export function contextDirection(context) {
  const stored = storedSearchContext(context);
  return stored ? formatContextDirection({ distanceM: stored.distanceFromCenterM, cardinal: stored.cardinalFromCenter }) : 'Not measured';
}

// The line every surface shows for a promoted candidate: the measured relationship, then the centre as it was
// named when the road was chosen. "4.2 mi NW of Near Vernonia, OR".
export function searchContextLine(context) {
  const stored = storedSearchContext(context);
  if (!stored) return '';
  return `${contextDirection(stored)} of ${stored.centerLabel}`;
}

// A defensive read of an optional field that may come from anywhere: a candidate promoted by this build, a
// candidate built before this feature existed (no field at all), or a stored record. Anything that does not
// describe a centre and a measured relationship is discarded rather than trusted.
export function storedSearchContext(value) {
  if (!value || typeof value !== 'object') return null;
  if (!validCoordinate(value.center) || !validCoordinate(value.nearestCenterPoint)) return null;
  if (!Number.isFinite(value.distanceFromCenterM) || value.distanceFromCenterM < 0) return null;
  if (typeof value.centerLabel !== 'string' || !value.centerLabel.trim() || value.centerLabel.length > MAX_SEARCH_CONTEXT_LABEL_LENGTH) return null;
  const kind = Object.values(CENTER_LABEL_KIND).includes(value.centerLabelKind) ? value.centerLabelKind : CENTER_LABEL_KIND.COORDINATES;
  return Object.freeze({ kind: SEARCH_CONTEXT_KIND, center: Object.freeze([...value.center]),
    centerLabel: value.centerLabel.trim(), centerLabelKind: kind,
    placeId: typeof value.placeId === 'string' && value.placeId ? value.placeId : null,
    radiusMiles: Number.isFinite(value.radiusMiles) && value.radiusMiles > 0 ? value.radiusMiles : null,
    distanceFromCenterM: Number(value.distanceFromCenterM), nearestCenterPoint: Object.freeze([...value.nearestCenterPoint]),
    bearingFromCenterDeg: Number.isFinite(value.bearingFromCenterDeg) ? Number(value.bearingFromCenterDeg) : null,
    cardinalFromCenter: typeof value.cardinalFromCenter === 'string' && value.cardinalFromCenter ? value.cardinalFromCenter : null,
    verification: value.verification && typeof value.verification === 'object' ? Object.freeze({ ...value.verification }) : null });
}

function validCoordinate(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
}

// Verify a carried context against the corridor a promotion is about to publish, and return the context to
// keep. The kept values are re-derived from the promoted corridor with the shared primitive, so a promoted
// candidate always describes the corridor it carries; the discovery measurement is what the re-derived values
// are checked against.
//
// A disagreement beyond the corridor tolerance is a failure, not a rounding difference: an orientation that
// describes a different corridor is worse than no orientation at all, and promotion already fails closed when
// the raw corridor cannot be reproduced. A context that is absent or unusable verifies as absent, so a declared
// box search (no centre) and an old candidate (no field) both promote normally.
export function verifyPromotionSearchContext(context, geometry, { toleranceM = PROMOTION_MAX_DRIFT_M } = {}) {
  const carried = storedSearchContext(context);
  if (!carried) return Object.freeze({ ok: true, context: null, reason: null });
  const measured = corridorContextFromCenter(carried.center, geometry);
  if (!measured) {
    return Object.freeze({ ok: false, context: null,
      reason: 'the promoted corridor geometry could not be measured against the search centre' });
  }
  const distanceDeltaM = Math.abs(measured.distanceM - carried.distanceFromCenterM);
  if (!(distanceDeltaM <= toleranceM + 1e-6)) {
    return Object.freeze({ ok: false, context: null,
      reason: `the promoted corridor is ${formatContextDistance(measured.distanceM)} from the search centre, but the discovery `
        + `row measured ${formatContextDistance(carried.distanceFromCenterM)}` });
  }
  // The recorded nearest point has to lie on the promoted corridor. It may sit further along the road than the
  // re-derived nearest point - a metre of geometry drift slides a point far along a road crossing the disk - so
  // it is checked against the geometry rather than against the new point.
  const nearestPointDeltaM = minDistanceToLineM(carried.nearestCenterPoint, geometry);
  if (!(nearestPointDeltaM <= toleranceM + 1e-6)) {
    return Object.freeze({ ok: false, context: null,
      reason: `the nearest point recorded for this corridor is ${Math.round(nearestPointDeltaM)} m from the promoted corridor` });
  }
  const bearingDeltaDeg = carried.bearingFromCenterDeg == null || measured.bearingDeg == null ? null
    : angularDeltaDeg(carried.bearingFromCenterDeg, measured.bearingDeg);
  if (bearingDeltaDeg != null && bearingDeltaDeg > bearingToleranceDeg(measured.distanceM, toleranceM)) {
    return Object.freeze({ ok: false, context: null,
      reason: `the direction to the promoted corridor differs by ${bearingDeltaDeg.toFixed(1)}° from the discovery row` });
  }
  return Object.freeze({ ok: true, reason: null, context: Object.freeze({ ...carried,
    distanceFromCenterM: measured.distanceM, nearestCenterPoint: measured.nearestPoint,
    bearingFromCenterDeg: measured.bearingDeg, cardinalFromCenter: measured.cardinal,
    verification: Object.freeze({ toleranceM, distanceDeltaM, nearestPointDeltaM, bearingDeltaDeg }) }) });
}

// An angular difference is only meaningful relative to how far away the road is: two nearest points that may sit
// a few geometry tolerances apart cannot disagree by more than atan(offset / distance).
function bearingToleranceDeg(distanceM, toleranceM) {
  return (Math.atan2(4 * toleranceM, Math.max(distanceM, toleranceM)) * 180) / Math.PI;
}

function angularDeltaDeg(left, right) {
  const raw = Math.abs(((left - right) % 360 + 360) % 360);
  return Math.min(raw, 360 - raw);
}
