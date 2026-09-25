import { COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';
import { ANALYSIS_DISTANCES_M } from '../gis/habitat-result.js';

// Habitat context is PHYSICAL HABITAT EVIDENCE: deterministic facts about mapped wetland and
// hydrography features near a corridor. It is not species occurrence, not habitat quality, and not
// access. A mapped intersection between a road and a water feature is a geometric crossing only.
export const HABITAT_EVIDENCE_KIND = 'PHYSICAL_HABITAT_EVIDENCE';
export const CROSSING_CAVEAT = 'A mapped crossing means the road centerline and a mapped water feature intersect in two dimensions. It does not establish a bridge, a ford, public access, current water presence, or wildlife value.';
export const HABITAT_INTERPRETATION = 'Physical habitat evidence only: mapped wetland and hydrography features near this corridor. Not species occurrence, habitat quality, or access.';

export function summarizeHabitat(result) {
  const wetlands = summarizeWetlands(result?.wetlands);
  const hydrography = summarizeHydrography(result?.hydrography);
  return Object.freeze({
    kind: HABITAT_EVIDENCE_KIND,
    analysisDistancesM: Object.freeze([...(result?.analysisDistancesM ?? ANALYSIS_DISTANCES_M)]),
    units: Object.freeze({ distance: 'm', area: 'm2', length: 'm', measuredCrs: result?.measuredCrs ?? 'EPSG:5070' }),
    wetlands,
    hydrography,
    coverage: Object.freeze({
      [COVERAGE_DATASET.WETLANDS]: wetlands.coverage,
      [COVERAGE_DATASET.HYDROGRAPHY]: hydrography.coverage,
    }),
    provenance: Object.freeze({ ...(result?.provenance ?? {}) }),
    diagnostics: Object.freeze({ ...(result?.diagnostics ?? {}) }),
    interpretation: HABITAT_INTERPRETATION,
  });
}

function summarizeWetlands(wetlands) {
  if (!wetlands) return Object.freeze({ available: false, coverage: COVERAGE.UNKNOWN, reason: 'Wetland analysis has not run.' });
  const buffers = Object.freeze(Object.fromEntries(Object.entries(wetlands.buffers ?? {}).map(([distance, entry]) => [distance, Object.freeze({
    distanceM: Number(distance), areaM2: entry.areaM2, featureCount: entry.featureCount,
    coverage: wetlands.coverageByDistance?.[distance]?.coverage ?? wetlands.coverage,
    classes: Object.freeze((entry.breakdown ?? []).map(item => Object.freeze({ label: item.label, featureCount: item.featureCount, areaM2: item.areaM2 }))),
  })])));
  return Object.freeze({
    available: wetlands.coverage !== COVERAGE.UNKNOWN, coverage: wetlands.coverage ?? COVERAGE.UNKNOWN,
    nearestDistanceM: wetlands.nearestDistanceM ?? null, intersectsCorridor: Boolean(wetlands.intersectsCorridor),
    corridorFeatureCount: wetlands.corridorFeatureCount ?? 0,
    buffers, coverageByDistance: Object.freeze({ ...(wetlands.coverageByDistance ?? {}) }),
    classes: Object.freeze([...(wetlands.classes ?? [])]),
    classDistanceM: wetlands.classDistanceM ?? null,
    reason: wetlands.reason ?? null, note: wetlands.note ?? null,
  });
}

function summarizeHydrography(hydrography) {
  if (!hydrography) return Object.freeze({ available: false, coverage: COVERAGE.UNKNOWN, reason: 'Hydrography analysis has not run.' });
  const buffers = Object.freeze(Object.fromEntries(Object.entries(hydrography.buffers ?? {}).map(([distance, entry]) => [distance, Object.freeze({
    distanceM: Number(distance), flowlineLengthM: entry.lengthM, waterbodyAreaM2: entry.areaM2,
    flowlineFeatureCount: (entry.breakdown ?? []).filter(item => item.code === 'flowline').reduce((total, item) => total + item.featureCount, 0),
    waterbodyFeatureCount: (entry.breakdown ?? []).filter(item => item.code === 'waterbody').reduce((total, item) => total + item.featureCount, 0),
    coverage: hydrography.coverageByDistance?.[distance]?.coverage ?? hydrography.coverage,
  })])));
  const crossings = Object.freeze((hydrography.crossings ?? []).map(crossing => Object.freeze({ ...crossing })));
  return Object.freeze({
    available: hydrography.coverage !== COVERAGE.UNKNOWN, coverage: hydrography.coverage ?? COVERAGE.UNKNOWN,
    crossingCount: crossings.length, crossings,
    nearestFlowingWaterM: hydrography.nearestFlowingWaterM ?? null,
    nearestStandingWaterM: hydrography.nearestStandingWaterM ?? null,
    corridorFlowlineCount: hydrography.corridorFlowlineCount ?? 0,
    buffers, coverageByDistance: Object.freeze({ ...(hydrography.coverageByDistance ?? {}) }),
    types: Object.freeze([...(hydrography.types ?? [])]), names: Object.freeze([...(hydrography.names ?? [])]),
    reason: hydrography.reason ?? null, note: hydrography.note ?? null, caveat: CROSSING_CAVEAT,
  });
}
