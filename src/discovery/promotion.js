import { minDistanceToLineM } from '../domain/geometry.js';
import { buildDiscoveryUnits } from './units.js';

// The acceptance tolerance for a reconstructed corridor: one metre, not a rounding of convenience.
export const PROMOTION_MAX_DRIFT_M = 1;
import { segmentUnit } from './segment.js';

// Promotion verification for a precomputed corridor row.
//
// A derived row is an index over the raw road partitions: it accelerates browsing, and it is never evidence.
// Before a precomputed corridor may become a candidate, the raw road network is composed again and the corridor is
// proved to be the same road - but not by its id, because the id is a build artifact (see the verification below).
export function linesOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  return geometry.type === 'MultiLineString' ? geometry.coordinates : [];
}

// The furthest any cached point sits from the raw line: used in both directions, so a rebuilt corridor that is a
// truncated or extended version of the row is refused as well as one that has moved.
export function maxDriftM(from, to) {
  let worst = 0;
  for (const line of linesOf(from)) {
    for (const point of line) worst = Math.max(worst, minDistanceToLineM(point, to));
  }
  return worst;
}

function identityOf(ids) {
  return [...new Set((ids ?? []).map(String))].sort();
}

function sameIdentity(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// What a developer with the evidence flag on is told when the reconstruction does not match: counts and the sizes
// of the differences, never a wall of ids in ordinary use.
function identityMismatch({ derived, wanted, units, features }) {
  const candidates = units
    .filter(unit => unit.sourceFeatureIds?.length)
    .map(unit => ({ id: unit.id, features: unit.sourceFeatureIds.length,
      shared: unit.sourceFeatureIds.filter(id => wanted.includes(String(id))).length }))
    .filter(entry => entry.shared > 0)
    .sort((left, right) => right.shared - left.shared)
    .slice(0, 4);
  const note = candidates.length
    ? ` Closest composed units by shared source features: ${candidates.map(entry => `${entry.id} (${entry.shared}/${entry.features})`).join(', ')}.`
    : ' No composed unit shares a single source feature with the row.';
  if (globalThis.__RN_DEBUG_EVIDENCE) {
    console.log('promotionVerification:mismatch ' + JSON.stringify({ row: derived.id, wantedFeatures: wanted.length,
      composedUnits: units.length, features: features?.length ?? 0, candidates }));
  }
  return `the raw road network does not compose the corridor this row describes (${wanted.length} source feature(s) `
    + `expected, ${units.length} unit(s) composed).${note}`;
}

// THE VERIFICATION, AND WHY IT IS NOT AN ID COMPARISON.
//
// `drv1-<normalized-name>-c<N>-s<M>` is a build artifact: the builder composes every name across the whole nation
// and numbers that name's connected components in order (scripts/build-national-derived.py walks
// `components.each_name` bucket by bucket), so `c<N>` is a national ordinal. A promotion loads a handful of cells,
// composes the *same* name over far fewer features and numbers those components again - so the same physical road
// legitimately carries a different `c<N>`. Measured in production: promoting `drv1-river-rd-c226-s1` composed 18,964
// units over 31,086 features and did not contain that id at all, while the road itself was right there.
//
// The row's `source_feature_ids` are the TIGER/Line features of one connected component of one normalized name:
// source-grounded, and therefore identical in the build and in the runtime. The reconstruction must compose a unit
// whose source feature set is exactly that set - not a superset (an extra feature is a different road group), not a
// subset (a missing feature is an incomplete road) - and then the row's segment index must select a segment whose
// geometry matches the row's to within a metre. That is strictly stronger than comparing one generated string: it
// checks membership, segmentation and geometry, and it fails closed on ambiguity instead of taking the first match.
export function verifyDerivedPromotion({ derived, features, sourceFeatureIds = null, segmentIndex = null,
  segmentCount = null, toleranceM = PROMOTION_MAX_DRIFT_M } = {}) {
  if (!derived?.id) throw new TypeError('Promotion verification needs the precomputed corridor row');
  const wanted = identityOf(sourceFeatureIds ?? derived.sourceFeatureIds ?? []);
  if (!wanted.length) {
    throw new Error('the precomputed row carries no source feature identity, so the reconstruction cannot be '
      + 'verified as the same road');
  }
  const wantedIndex = Number(segmentIndex ?? derived.segmentIndex ?? 1);
  const wantedCount = segmentCount ?? derived.segmentCount ?? null;
  const units = buildDiscoveryUnits(features ?? []).units;
  const matches = units.filter(unit => sameIdentity(identityOf(unit.sourceFeatureIds), wanted));
  if (matches.length > 1) {
    throw new Error(`the raw road network composes ${matches.length} units with the source features of ${derived.id}, `
      + 'so the corridor is ambiguous and none is promoted');
  }
  if (!matches.length) throw new Error(identityMismatch({ derived, wanted, units, features }));
  const unit = matches[0];
  const segmentation = segmentUnit(unit);
  const corridors = segmentation.corridors ?? [];
  if (wantedCount != null && Number(wantedCount) !== corridors.length) {
    throw new Error(`the row describes ${wantedCount} segment(s) but the composed road divides into ${corridors.length}`);
  }
  const corridor = corridors.find(entry => Number(entry.segmentIndex) === wantedIndex) ?? corridors[wantedIndex - 1] ?? null;
  if (!corridor) {
    throw new Error(`the row describes segment ${wantedIndex} of ${wantedCount ?? corridors.length}, which the composed road does not have`);
  }
  // Both directions are measured and reported: the identity evidence a release records quotes the pair, and the
  // acceptance rule is unchanged - the worst of the two must stay inside the metre.
  const drift = Object.freeze({ derivedToSource: maxDriftM(derived.geometry, corridor.geometry),
    sourceToDerived: maxDriftM(corridor.geometry, derived.geometry) });
  const driftM = Math.max(drift.derivedToSource, drift.sourceToDerived);
  if (driftM > toleranceM) {
    throw new Error(`the raw corridor differs from the precomputed row by about ${Math.round(driftM)} m`);
  }
  return Object.freeze({ unit, corridor, features: features ?? [], driftM, drift,
    sourceFeatureIds: Object.freeze(wanted), derivedId: derived.id });
}
