import { naturalistInterest } from './ranking.js';

// EXPLORATION ORDER: WHICH ROAD TO CONSIDER FIRST FROM WHERE YOU SEARCHED.
//
// This is a different question from `naturalist-interest-v2`, and it is a different family of version, not the next
// number after it. Naturalist interest says how interesting the *mapped environmental context* around a corridor
// looks; distance from the search centre must not change that value, and it does not. Exploration order says which
// roads to consider first *from this search centre*, and there distance is legitimate evidence of convenience.
//
// So this module CONSUMES `naturalistInterest(result)` and never recomputes it, and the exploration score is the
// interest score minus a bounded distance penalty:
//
//   explorationOrder = interest - penalty(distanceFromCenter / requestedRadius)
//
// Three deliberate properties:
//
//   * BOUNDED. Every transform caps its penalty (ten points, or six for the gentler one), so distance can reorder
//     near-ties but can never invert a clear environmental difference: a road 20 miles away loses the same small
//     amount whether its interest is 82 or 41, and a corridor more than ~10 points better is never buried by it.
//   * NORMALIZED TO THE REQUESTED RADIUS. The penalty is a function of distance / requested radius, so 20 miles in a
//     50-mile search is a middle-distance road and 20 miles in a 25-mile search is at the rim. No national
//     assumption about what "far" means.
//   * NO CENTRE, NO PENALTY. A declared-box search has no centre, so it has no distance: the order is the interest
//     score unchanged. A search that did not define a distance must not invent one.
//
// It is still an exploration heuristic, not a wildlife prediction, an access statement, or a recommendation.
export const EXPLORATION_ORDER_VERSION = 'exploration-order-v1';
export const EXPLORATION_ORDER_FAMILY = 'exploration-order';

// The distance transforms. Each turns a distance fraction (0 at the centre, 1 at the requested radius) into the
// number of points subtracted from the interest score. They are deterministic, bounded, and cheap to explain.
export const DISTANCE_TRANSFORMS = Object.freeze({
  // Even penalty across the radius. Included as the simplest reference, not as the default: it charges a real price
  // for being anywhere that is not near the centre, which is the behaviour most likely to bury a good far road.
  linear: Object.freeze({ key: 'linear', label: 'Even across the radius', cap: 10,
    penalty: fraction => 10 * fraction }),
  // Gentle near the centre, stronger toward the rim: at half the radius only a quarter of the cap is charged.
  quadratic: Object.freeze({ key: 'quadratic', label: 'Gentle near the centre, stronger at the rim', cap: 10,
    penalty: fraction => 10 * fraction * fraction }),
  // Bands, so a person can read the rule off the numbers: nothing inside 20% of the radius, then quarters of the cap.
  tiered: Object.freeze({ key: 'tiered', label: 'Banded', cap: 10,
    penalty: fraction => 10 * (fraction <= 0.2 ? 0 : fraction <= 0.4 ? 0.25 : fraction <= 0.6 ? 0.5
      : fraction <= 0.8 ? 0.75 : 1) }),
  // The same shape as `quadratic` with a smaller cap. Selected by the eight-region evaluation
  // (`data/ranking/exploration-order-v1-evaluation.json`): of the four candidates it gave up the least interest
  // (worst region -1.5 points), kept the interest's first road in the top ten in 7 of 8 regions and in the top three
  // in 6 of 8, and still halved the median top-10 distance in every region.
  gentle: Object.freeze({ key: 'gentle', label: 'Gentle near the centre, smaller cap', cap: 6,
    penalty: fraction => 6 * fraction * fraction }),
});
export const DEFAULT_DISTANCE_TRANSFORM = 'gentle';
export const TRANSFORM_KEYS = Object.freeze(Object.keys(DISTANCE_TRANSFORMS));

export function distanceTransform(key = DEFAULT_DISTANCE_TRANSFORM) {
  return DISTANCE_TRANSFORMS[key] ?? DISTANCE_TRANSFORMS[DEFAULT_DISTANCE_TRANSFORM];
}

// The distance as a fraction of the requested radius, clamped to [0, 1]. `null` means "this search has no distance
// to speak of": no centre, no declared radius, or no measured distance.
export function distanceFraction(distanceM, radiusM) {
  if (!Number.isFinite(distanceM) || distanceM < 0) return null;
  if (!Number.isFinite(radiusM) || radiusM <= 0) return null;
  return Math.min(1, Math.max(0, distanceM / radiusM));
}

// One corridor's exploration order: the interest score, the distance penalty that adjusts it, and the inputs to both.
export function explorationOrder(result, { radiusM = null, transform = DEFAULT_DISTANCE_TRANSFORM } = {}) {
  const model = distanceTransform(transform);
  const interest = naturalistInterest(result);
  const measured = result?.distanceFromCenterM;
  const distanceM = Number.isFinite(measured) && measured >= 0 ? measured : null;
  const fraction = distanceFraction(distanceM, radiusM);
  if (interest.score == null || fraction == null) {
    const penalty = fraction == null ? 0 : round1(model.penalty(fraction));
    return Object.freeze({ version: EXPLORATION_ORDER_VERSION, interestVersion: interest.version, transform: model.key,
      cap: model.cap, score: interest.score, naturalistInterest: interest.score, penalty,
      distanceM, distanceFraction: fraction == null ? null : round3(fraction) });
  }
  // The floor keeps the order on the same 0-100 scale as the interest score it adjusts; the penalty is bounded, so
  // this only ever affects roads whose interest is already at the bottom of the range.
  const score = Math.max(0, interest.score - model.penalty(fraction));
  return Object.freeze({ version: EXPLORATION_ORDER_VERSION, interestVersion: interest.version, transform: model.key,
    cap: model.cap, score: round1(score), naturalistInterest: interest.score,
    penalty: round1(interest.score - score), distanceM, distanceFraction: round3(fraction) });
}

// The whole order: score first, then name and id, so it is deterministic and never depends on input order. A
// corridor with no interest score (nothing measured) has no exploration score either, and orders last.
export function rankExploration(results, { radiusM = null, transform = DEFAULT_DISTANCE_TRANSFORM } = {}) {
  return [...(results ?? [])].map(result => ({ result, order: explorationOrder(result, { radiusM, transform }) }))
    .sort((left, right) => {
      const a = left.order.score;
      const b = right.order.score;
      if ((a == null) !== (b == null)) return a == null ? 1 : -1;
      if (a != null && b !== a) return b - a;
      return String(left.result.name ?? '').localeCompare(String(right.result.name ?? ''))
        || String(left.result.id).localeCompare(String(right.result.id));
    });
}

// Shown wherever the order is offered, so the distinction from the interest score is never implicit.
export const EXPLORATION_ORDER_NOTE = 'An exploration order that combines the mapped naturalist-interest signals '
  + 'with distance from your search centre. Distance affects the ordering, never the underlying naturalist-interest '
  + 'score, and its influence is capped so a clearly more interesting road is never buried for being farther away. '
  + 'It is not a wildlife prediction, an access or safety statement, or a claim that one road is better.';

const round1 = value => Math.round(value * 10) / 10;
const round3 = value => Math.round(value * 1000) / 1000;

