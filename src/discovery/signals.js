import { COVERAGE } from '../domain/corridor.js';
import { corridorCoverage } from './coverage.js';

// A discovery result is a lightweight, interpretable summary: raw measured values, explicit coverage,
// and provenance. There is no wildlife score, no likelihood, and no "best road" label — only the facts a
// person can sort and filter, and the units they were measured in.

export function buildDiscoveryResult({ unit, corridor, metrics, roadState = COVERAGE.FULL, provenance = null, analysisDistancesM = [] }) {
  const wetlands = metrics?.wetlands ?? null;
  const hydrography = metrics?.hydrography ?? null;
  const ecology = metrics?.ecology ?? null;
  const at = distance => wetlands?.buffers?.[distance] ?? { areaM2: 0, lengthM: 0, featureCount: 0, breakdown: [] };
  const hydroAt = distance => hydrography?.buffers?.[distance] ?? { areaM2: 0, lengthM: 0, featureCount: 0, breakdown: [] };
  const classes = (wetlands?.classes ?? []).map(entry => Object.freeze({ label: entry.label, code: entry.code,
    areaM2: entry.areaM2, featureCount: entry.featureCount }));
  return Object.freeze({
    id: corridor.id, name: corridor.name, unitId: unit.id,
    geometry: corridor.geometry, bounds: corridor.bounds, lengthM: corridor.lengthM,
    road: Object.freeze({
      class: unit.roadClasses.length === 1 ? unit.roadClasses[0] : null,
      classes: Object.freeze([...unit.roadClasses]),
      counties: Object.freeze([...unit.countyNames]),
      countyFips: Object.freeze([...unit.countyFips]),
      sourceFeatureCount: unit.composition.usedFeatureCount,
      sourceFeatureIds: unit.sourceFeatureIds,
      roadIds: unit.roadIds,
      partCount: unit.composition.partCount,
      maxUnresolvedGapM: unit.composition.maxUnresolvedGapM,
      segmentation: Object.freeze({ index: corridor.segmentIndex, count: corridor.segmentCount, method: 'contiguous vertices along the composed unit' }),
    }),
    ecology: Object.freeze({
      coverage: ecology?.coverage ?? COVERAGE.UNKNOWN,
      level3: summarizeLevelEntry(ecology?.level3 ?? null),
      level4: summarizeLevelEntry(ecology?.level4 ?? null),
      ecoregionCount: new Set([...(ecology?.level3?.intersections ?? []).map(entry => `L3:${entry.code}`),
        ...(ecology?.level4?.intersections ?? []).map(entry => `L4:${entry.code}`)]).size,
      transitions: Math.max(0, (ecology?.level3?.intersections?.length ?? 1) - 1)
        + Math.max(0, (ecology?.level4?.intersections?.length ?? 1) - 1),
      spansMultiple: Boolean(ecology?.spansMultiple),
      measuredM: ecology?.level3?.measuredM ?? null,
    }),
    signals: Object.freeze({
      wetlands: Object.freeze({
        coverage: wetlands?.coverage ?? COVERAGE.UNKNOWN,
        intersectsCorridor: Boolean(wetlands?.intersectsCorridor),
        nearestM: wetlands?.nearestDistanceM ?? null,
        area250M2: at(250).areaM2, area500M2: at(500).areaM2, area1000M2: at(1000).areaM2,
        featureCount250: at(250).featureCount, featureCount1000: at(1000).featureCount,
        types: Object.freeze(classes),
      }),
      hydrography: Object.freeze({
        coverage: hydrography?.coverage ?? COVERAGE.UNKNOWN,
        crossingCount: hydrography?.crossingCount ?? 0,
        crossings: Object.freeze((hydrography?.crossings ?? []).map(crossing => Object.freeze({ ...crossing }))),
        nearestFlowingM: hydrography?.nearestFlowingWaterM ?? null,
        nearestStandingM: hydrography?.nearestStandingWaterM ?? null,
        flowlineLength1000M: hydroAt(1000).lengthM, waterbodyArea1000M: hydroAt(1000).areaM2,
        namedWaters: Object.freeze([...(hydrography?.names ?? [])]),
      }),
    }),
    coverage: corridorCoverage({ roadState, wetlands: wetlands ?? {}, hydrography: hydrography ?? {} }),
    analysisDistancesM: Object.freeze([...analysisDistancesM]),
    provenance: Object.freeze({
      road: provenance ? Object.freeze({ ...provenance, kind: 'road-network-extract' }) : null,
      method: 'Deterministic discovery analysis: road eligibility, named-road composition, contiguous segmentation, '
        + 'then one set-oriented DuckDB Spatial pass over the wetlands, hydrography, and EPA ecoregion layers in EPSG:5070.',
      occurrence: 'Not queried during discovery: occurrence evidence is an explicit, separate deeper-analysis step.',
      access: 'Not researched during discovery: presence in a road centerline dataset is not access evidence.',
      note: 'Discovery exposes measured facts and coverage. It is not a wildlife prediction, a ranking, or a recommendation.',
    }),
  });
}

function summarizeLevelEntry(level) {
  if (!level) return null;
  return Object.freeze({ coverage: level.coverage, primary: level.primary ? Object.freeze({ ...level.primary }) : null,
    intersections: Object.freeze((level.intersections ?? []).map(entry => Object.freeze({ ...entry }))) });
}
