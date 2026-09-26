import { COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';

// Discovery coverage is its own dimension. A search area is FULL only when the road network extract,
// the wetlands, the hydrography, and the ecoregions all cover the corridors that were proposed, in the
// distances discovery measured. Anything less is PARTIAL with the reason: an area that is only partly
// covered can never be compared with a fully covered one as though the missing habitat were zero.

const WORSE = Object.freeze({ [COVERAGE.FULL]: 0, [COVERAGE.PARTIAL]: 1, [COVERAGE.NONE]: 2, [COVERAGE.UNKNOWN]: 3 });

export function combineDiscoveryCoverage(values) {
  if (!values.length) return COVERAGE.UNKNOWN;
  return values.reduce((worst, value) => WORSE[value] > WORSE[worst] ? value : worst, COVERAGE.FULL);
}

// Search-area coverage summary. It describes the run, not any single corridor: per-corridor coverage
// travels with each result.
export function summarizeDiscoveryCoverage({ roadQuery, searchArea, results = [], eligibility = [], diagnostics = null } = {}) {
  const corridorCount = results.length;
  const habitatStates = results.map(result => result.coverage?.[COVERAGE_DATASET.WETLANDS]?.coverage ?? COVERAGE.UNKNOWN);
  const hydroStates = results.map(result => result.coverage?.[COVERAGE_DATASET.HYDROGRAPHY]?.coverage ?? COVERAGE.UNKNOWN);
  const roadState = roadQuery?.coverage ?? COVERAGE.UNKNOWN;
  const wetlands = corridorCount ? combineDiscoveryCoverage(habitatStates) : (roadState === COVERAGE.FULL ? COVERAGE.NONE : roadState);
  const hydrography = corridorCount ? combineDiscoveryCoverage(hydroStates) : (roadState === COVERAGE.FULL ? COVERAGE.NONE : roadState);
  const dimensions = {
    [COVERAGE_DATASET.ROAD_NETWORK]: {
      coverage: roadState,
      reason: roadQuery?.reason ?? roadQuery?.note ?? (roadState === COVERAGE.FULL
        ? `The bounded road-network extract covers the whole search area (${searchArea?.name ?? 'search area'}).` : null),
      note: roadQuery?.note ?? null,
    },
    [COVERAGE_DATASET.WETLANDS]: { coverage: wetlands, reason: stateReason(results, COVERAGE_DATASET.WETLANDS) },
    [COVERAGE_DATASET.HYDROGRAPHY]: { coverage: hydrography, reason: stateReason(results, COVERAGE_DATASET.HYDROGRAPHY) },
  };
  const coverage = combineDiscoveryCoverage([dimensions[COVERAGE_DATASET.ROAD_NETWORK].coverage,
    dimensions[COVERAGE_DATASET.WETLANDS].coverage, dimensions[COVERAGE_DATASET.HYDROGRAPHY].coverage]);
  const excludedFeatureCount = eligibility.reduce((total, entry) => total + entry.count, 0);
  const counts = Object.freeze({
    corridors: corridorCount,
    fullHabitat: results.filter(result => result.coverage?.[COVERAGE_DATASET.WETLANDS]?.coverage === COVERAGE.FULL
      && result.coverage?.[COVERAGE_DATASET.HYDROGRAPHY]?.coverage === COVERAGE.FULL).length,
    excludedFeatureCount,
    droppedShortUnits: diagnostics?.droppedShortUnits ?? 0,
  });
  const reasons = [dimensions[COVERAGE_DATASET.ROAD_NETWORK], dimensions[COVERAGE_DATASET.WETLANDS], dimensions[COVERAGE_DATASET.HYDROGRAPHY]]
    .filter(entry => entry.coverage !== COVERAGE.FULL && entry.reason).map(entry => entry.reason);
  return Object.freeze({
    coverage, dimensions: Object.freeze(dimensions), counts,
    reason: coverage === COVERAGE.FULL ? null : (reasons[0] ?? 'The search area is not fully covered by every required dataset.'),
    note: coverage === COVERAGE.FULL ? null
      : 'PARTIAL coverage means part of the search area is outside the loaded road or habitat datasets, so these corridors cannot be compared with fully covered ones as though the missing habitat were zero.',
  });
}

function stateReason(results, datasetId) {
  const states = results.map(result => result.coverage?.[datasetId] ?? null);
  const notFull = states.filter(state => state && state.coverage !== COVERAGE.FULL);
  if (!results.length) return 'No discovery corridor was proposed in this search area.';
  if (!notFull.length) return null;
  return notFull.find(state => state.reason)?.reason ?? `${notFull.length} of ${results.length} corridors are not fully covered by this dataset.`;
}

// Discovery coverage for one result, from the batch metrics of that corridor.
export function corridorCoverage({ roadState, wetlands, hydrography }) {
  return Object.freeze({
    [COVERAGE_DATASET.ROAD_NETWORK]: Object.freeze({ coverage: roadState, reason: roadState === COVERAGE.FULL ? null
      : 'The corridor is at the edge of the bounded road-network extract.' }),
    [COVERAGE_DATASET.WETLANDS]: Object.freeze({ coverage: wetlands.coverage, reason: wetlands.reason ?? wetlands.note ?? null }),
    [COVERAGE_DATASET.HYDROGRAPHY]: Object.freeze({ coverage: hydrography.coverage, reason: hydrography.reason ?? hydrography.note ?? null }),
  });
}
