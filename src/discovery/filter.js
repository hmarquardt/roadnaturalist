import { COVERAGE } from '../domain/corridor.js';

// Filters and sorts are deterministic and local: discovery measures every corridor once, and the
// interface only selects and orders what was measured. Every sort dimension is a raw measured value,
// named in the unit it was measured in. One display default exists for usability and is labelled as a
// display default, never as a recommendation.
export const SORT_OPTIONS = Object.freeze([
  Object.freeze({ key: 'wetlandArea250', label: 'Wetland area within 250 m', unit: 'm²', direction: 'desc' }),
  Object.freeze({ key: 'name', label: 'Road name', unit: null, direction: 'asc' }),
  Object.freeze({ key: 'length', label: 'Corridor length', unit: 'm', direction: 'desc' }),
  Object.freeze({ key: 'nearestWetland', label: 'Nearest mapped wetland', unit: 'm', direction: 'asc' }),
  Object.freeze({ key: 'wetlandArea1000', label: 'Wetland area within 1 km', unit: 'm²', direction: 'desc' }),
  Object.freeze({ key: 'crossings', label: 'Mapped water crossings', unit: 'count', direction: 'desc' }),
  Object.freeze({ key: 'ecoregionTransitions', label: 'Ecoregion transitions', unit: 'count', direction: 'desc' }),
  Object.freeze({ key: 'ecoregionCount', label: 'Distinct ecoregions', unit: 'count', direction: 'desc' }),
]);
export const DEFAULT_SORT = 'wetlandArea250';
export const DEFAULT_SORT_NOTE = 'Display default only: it orders the table by one measured value. '
  + 'It is not a ranking, a score, or a statement that the first road is better than the last.';

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

export function sortResults(results, sortKey = DEFAULT_SORT) {
  const option = SORT_OPTIONS.find(entry => entry.key === sortKey) ?? SORT_OPTIONS.find(entry => entry.key === DEFAULT_SORT);
  const value = result => {
    switch (option.key) {
      case 'name': return result.name;
      case 'length': return result.lengthM;
      case 'nearestWetland': return result.signals.wetlands.nearestM;
      case 'wetlandArea1000': return result.signals.wetlands.area1000M2;
      case 'crossings': return result.signals.hydrography.crossingCount;
      case 'ecoregionTransitions': return result.ecology.transitions;
      case 'ecoregionCount': return result.ecology.ecoregionCount;
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

export function filterAndSort(results, filters, sortKey) {
  return sortResults(filterResults(results, filters), sortKey);
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
