import { COVERAGE } from '../domain/corridor.js';
import { naturalistInterest } from './ranking.js';
import { EXPLORATION_ORDER_VERSION, explorationOrder } from './exploration-order.js';

// Filters and sorts are deterministic and local: discovery measures every corridor once, and the
// interface only selects and orders what was measured. Every sort dimension is a raw measured value,
// named in the unit it was measured in. One display default exists for usability and is labelled as a
// display default, never as a recommendation.
export const SORT_OPTIONS = Object.freeze([
  Object.freeze({ key: 'wetlandArea250', label: 'Wetland area within 250 m', unit: 'm²', direction: 'desc' }),
  Object.freeze({ key: 'distanceFromCenter', label: 'Distance from center', unit: 'm', direction: 'asc' }),
  Object.freeze({ key: 'name', label: 'Road name', unit: null, direction: 'asc' }),
  Object.freeze({ key: 'length', label: 'Corridor length', unit: 'm', direction: 'desc' }),
  Object.freeze({ key: 'nearestWetland', label: 'Nearest mapped wetland', unit: 'm', direction: 'asc' }),
  Object.freeze({ key: 'wetlandArea1000', label: 'Wetland area within 1 km', unit: 'm²', direction: 'desc' }),
  Object.freeze({ key: 'crossings', label: 'Mapped water crossings', unit: 'count', direction: 'desc' }),
  Object.freeze({ key: 'ecoregionTransitions', label: 'Ecoregion transitions', unit: 'count', direction: 'desc' }),
  Object.freeze({ key: 'ecoregionCount', label: 'Distinct ecoregions', unit: 'count', direction: 'desc' }),
  // The two orderings that are not raw measured values, listed last and named as orders rather than measurements so
  // neither can be mistaken for one. They answer different questions: `naturalistInterest` scores the mapped
  // environmental context and does not change with the search centre; `explorationOrder` adjusts that score by
  // distance from the search centre, so the list leads with roads it is practical to consider first. Their labels
  // stay short; the meaning of each is explained beside the control (see SORT_HELP).
  Object.freeze({ key: 'naturalistInterest', label: 'Naturalist interest', unit: 'score',
    direction: 'desc', heuristic: true, version: naturalistInterest({}).version }),
  Object.freeze({ key: 'explorationOrder', label: 'Exploration order', unit: 'score',
    direction: 'desc', heuristic: true, version: EXPLORATION_ORDER_VERSION }),
]);

// THE PRODUCT DEFAULT, IN ONE PLACE. A search is a request to find roads worth considering *from where the person
// searched*, so the table leads with the distance-aware exploration order: mapped naturalist interest with a
// bounded, radius-normalized preference for roads that are closer to the centre. `naturalistInterest` remains the
// centre-independent environmental-context order, and every factual sort is untouched. A declared box search has no
// centre, so the exploration order honestly reduces to the interest score there rather than inventing a distance.
export const DEFAULT_SORT = 'explorationOrder';

// The baseline the ranking evaluation compares against. It is deliberately NOT the product default: the committed
// evaluations (`data/ranking/naturalist-interest-v1-evaluation.json` and its v2 successor) measured the interest
// order against this measured-value baseline, and re-pointing it would silently rewrite that history. See
// docs/RANKING-DECISION.md.
export const EVALUATION_BASELINE_SORT = 'wetlandArea250';

// What each heuristic ordering means, said once and shown beside the control. A factual sort needs no help: its
// label names the value it orders by and its unit is in the option.
export const SORT_HELP = Object.freeze({
  explorationOrder: 'Balances mapped naturalist interest with distance from your search centre.',
  naturalistInterest: 'Uses mapped wetlands, water and ecological variety without considering distance.',
});

// The line under the results. It follows the ordering that is actually active, and it never calls a heuristic a
// measurement or the other way round.
export function sortNote(sortKey = DEFAULT_SORT, { radiusM = null } = {}) {
  if (sortKey === 'explorationOrder') {
    const because = radiusM == null
      ? 'This search declares no centre, so no distance is considered.'
      : 'Roads closer to your search centre are preferred, modestly: distance can settle a near tie but never bury a '
        + 'clearly more interesting road.';
    return 'Roads are ordered by mapped naturalist interest with a bounded preference for roads closer to your '
      + `search centre. ${because} This is an exploration heuristic, not a wildlife prediction, an access `
      + 'recommendation, or a drivability assessment.';
  }
  if (sortKey === 'naturalistInterest') {
    return 'Roads are ordered by mapped naturalist interest alone - mapped wetlands, water and ecological variety - '
      + 'with the search centre not considered. It is not a wildlife prediction, an access or safety statement, or a '
      + 'claim that one road is better.';
  }
  return 'The table is ordered by one measured value. It is not a ranking, a score, or a statement that the first '
    + 'road is better than the last.';
}

// Shown wherever the interest score is offered, so the claim is never implicit.
export const NATURALIST_INTEREST_NOTE = 'A score for the mapped naturalist-interest signals around a corridor - '
  + 'wetland area at the analysis distances, proximity to water, mapped crossings, and ecological variety. It does '
  + 'not change with your search centre. It is not a wildlife prediction, an access or safety statement, or a claim '
  + 'that one road is better.';
export const DEFAULT_FILTERS = Object.freeze({
  minLengthMi: null, maxLengthMi: null, roadClasses: Object.freeze([]), wetland: 'any',
  maxNearestWetlandM: null, minCrossings: null, ecoregion: null,
});

export const WETLAND_FILTERS = Object.freeze([
  Object.freeze({ key: 'any', label: 'Any' }),
  Object.freeze({ key: 'intersects', label: 'Intersects a mapped wetland' }),
  Object.freeze({ key: 'nearby', label: 'Mapped wetland within 200 m' }),
  Object.freeze({ key: 'none-nearby', label: 'No mapped wetland within 200 m' }),
]);

const NEARBY_M = 200;


export function filterResults(results, filters = {}) {
  const options = { ...DEFAULT_FILTERS, ...filters };
  const minM = options.minLengthMi == null ? null : Number(options.minLengthMi) * 1609.344;
  const maxM = options.maxLengthMi == null ? null : Number(options.maxLengthMi) * 1609.344;
  const classes = new Set(options.roadClasses ?? []);
  const maxNearest = options.maxNearestWetlandM == null ? null : Number(options.maxNearestWetlandM);
  return results.filter(result => {
    if (minM != null && result.lengthM < minM) return false;
    if (maxM != null && result.lengthM > maxM) return false;
    if (classes.size && !result.road.classes.some(code => classes.has(code))) return false;
    const wetlands = result.signals.wetlands;
    if (options.wetland === 'intersects' && !wetlands.intersectsCorridor) return false;
    if (options.wetland === 'nearby' && !(wetlands.nearestM != null && wetlands.nearestM <= NEARBY_M)) return false;
    if (options.wetland === 'none-nearby' && wetlands.nearestM != null && wetlands.nearestM <= NEARBY_M) return false;
    if (maxNearest != null && !(wetlands.nearestM != null && wetlands.nearestM <= maxNearest)) return false;
    if (options.minCrossings != null && result.signals.hydrography.crossingCount < Number(options.minCrossings)) return false;
    if (options.ecoregion) {
      const codes = [result.ecology.level3, result.ecology.level4]
        .flatMap(level => (level?.intersections ?? []).map(entry => entry.code));
      if (!codes.includes(options.ecoregion)) return false;
    }
    return true;
  });
}

// `context` carries the search context an ordering may legitimately need - today only the requested radius, which
// the exploration order normalizes distance against. Every other sort ignores it, so a caller that has no context
// still gets the raw-value order it always had.
export function sortResults(results, sortKey = DEFAULT_SORT, context = {}) {
  const option = SORT_OPTIONS.find(entry => entry.key === sortKey) ?? SORT_OPTIONS.find(entry => entry.key === DEFAULT_SORT);
  const value = result => {
    switch (option.key) {
      case 'name': return result.name;
      case 'distanceFromCenter': return result.distanceFromCenterM;
      case 'length': return result.lengthM;
      case 'nearestWetland': return result.signals.wetlands.nearestM;
      case 'wetlandArea1000': return result.signals.wetlands.area1000M2;
      case 'crossings': return result.signals.hydrography.crossingCount;
      case 'ecoregionTransitions': return result.ecology.transitions;
      case 'ecoregionCount': return result.ecology.ecoregionCount;
      case 'naturalistInterest': return naturalistInterest(result).score;
      case 'explorationOrder': return explorationOrder(result, { radiusM: context.radiusM ?? null,
        transform: context.transform }).score;
      default: return result.signals.wetlands.area250M2;
    }
  };
  const direction = option.direction === 'asc' ? 1 : -1;
  return [...results].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    // Missing measurements sort last in either direction: unknown is not a small number.
    const missingA = a == null || (typeof a === 'number' && !Number.isFinite(a));
    const missingB = b == null || (typeof b === 'number' && !Number.isFinite(b));
    if (missingA !== missingB) return missingA ? 1 : -1;
    if (missingA && missingB) return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    if (typeof a === 'string') return a.localeCompare(b) * direction || left.id.localeCompare(right.id);
    return (a - b) * direction || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}

export function filterAndSort(results, filters, sortKey, context = {}) {
  return sortResults(filterResults(results, filters), sortKey, context);
}

export function ecoregionOptions(results) {
  const seen = new Map();
  for (const result of results) {
    for (const level of [result.ecology.level3, result.ecology.level4]) {
      for (const entry of level?.intersections ?? []) {
        if (!seen.has(entry.code)) seen.set(entry.code, `${entry.name} (${entry.code})`);
      }
    }
  }
  return [...seen.entries()].map(([code, label]) => Object.freeze({ code, label })).sort((a, b) => a.label.localeCompare(b.label));
}

// The coverage flag a result row shows: the worst state among its dimensions, so a row that is partly
// outside a dataset is never displayed as fully covered.
export function coverageFlag(result) {
  const states = Object.values(result.coverage ?? {}).map(entry => entry.coverage);
  if (!states.length) return COVERAGE.UNKNOWN;
  if (states.includes(COVERAGE.UNKNOWN)) return COVERAGE.UNKNOWN;
  if (states.includes(COVERAGE.NONE)) return COVERAGE.NONE;
  if (states.includes(COVERAGE.PARTIAL)) return COVERAGE.PARTIAL;
  return COVERAGE.FULL;
}
