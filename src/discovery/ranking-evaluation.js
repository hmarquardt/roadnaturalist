import { RANKING_VERSION, naturalistInterest, rankResults } from './ranking.js';
import { DEFAULT_SORT, sortResults } from './filter.js';

// EVALUATING AN EXPLORATION ORDER AGAINST A MEASURED-COLUMN DEFAULT.
//
// This module is the pure half of the ranking evaluation: given ordinary discovery results (exactly the objects
// `runDiscovery` produces), it orders them two ways - the display default (`wetlandArea250`, one raw measured
// value) and the `naturalist-interest-v1` heuristic - and reports what changed and why. It reads no data plane,
// touches no GIS, and is deterministic, so the numbers a run reports can be reproduced from the same results.
//
// The comparison deliberately reports the *physical context* behind each movement (component values and the raw
// measurements they are built from), never only the score, because a score alone cannot say whether a road moved
// for a good reason.
export const RANKING_EVALUATION_KIND = 'road-ranking-evaluation';
export const RANKING_EVALUATION_VERSION = 1;

const M_PER_MILE = 1609.344;
const round = (value, digits = 2) => (value == null || !Number.isFinite(value) ? null
  : Math.round(value * 10 ** digits) / 10 ** digits);

// A road as the evaluation reports it: identity + search context + every ranking input + every raw measurement the
// components are built from. One row is enough to explain any movement without re-reading anything.
export function evaluationRow(result, { rank = null } = {}) {
  const ranking = naturalistInterest(result);
  const wetlands = result?.signals?.wetlands ?? {};
  const hydro = result?.signals?.hydrography ?? {};
  const ecology = result?.ecology ?? {};
  return Object.freeze({
    rank,
    corridorId: result.id,
    name: result.name ?? null,
    derivedLengthM: round(result.lengthM, 1),
    distanceFromCenterM: result.distanceFromCenterM ?? null,
    distanceFromCenterMi: round(result.distanceFromCenterM == null ? null : result.distanceFromCenterM / M_PER_MILE),
    interestScore: ranking.score,
    evidenceFraction: ranking.evidenceFraction,
    components: Object.freeze({
      wetland: ranking.components.wetland.value,
      water: ranking.components.water.value,
      ecologicalVariety: ranking.components.ecologicalVariety.value,
    }),
    missingComponents: ranking.missing,
    nearestWetlandM: wetlands.nearestM ?? null,
    wetlandArea250M2: wetlands.area250M2 ?? 0,
    wetlandArea500M2: wetlands.area500M2 ?? 0,
    wetlandArea1000M2: wetlands.area1000M2 ?? 0,
    wetlandIntersectsCorridor: Boolean(wetlands.intersectsCorridor),
    wetlandCoverage: wetlands.coverage ?? null,
    hydroCrossingCount: hydro.crossingCount ?? 0,
    nearestFlowingM: hydro.nearestFlowingM ?? null,
    nearestStandingM: hydro.nearestStandingM ?? null,
    flowlineLength1000M: hydro.flowlineLength1000M ?? 0,
    hydroCoverage: hydro.coverage ?? null,
    ecoregionCount: ecology.ecoregionCount ?? null,
    ecoregionTransitions: ecology.transitions ?? null,
    ecologyCoverage: ecology.coverage ?? null,
    roadClass: result?.road?.class ?? null,
  });
}

// The ordered top of one ordering. The heuristic uses `rankResults` (the runtime's own order); every other key
// uses `sortResults`, so neither ordering is a second implementation.
export function orderedResults(results, sortKey) {
  return sortKey === 'naturalistInterest' ? rankResults(results).map(entry => entry.result)
    : sortResults(results, sortKey);
}

export function topUnder(results, sortKey, topN) {
  return orderedResults(results, sortKey).slice(0, topN).map((result, index) => evaluationRow(result, { rank: index + 1 }));
}

// The two orderings side by side, with the movements and the context that explains them.
export function compareOrderings(results, { topN = 10, baselineKey = BASELINE_SORT } = {}) {
  const baseline = topUnder(results, baselineKey, topN);
  const interest = topUnder(results, 'naturalistInterest', topN);
  const baselineIds = new Set(baseline.map(row => row.corridorId));
  const interestIds = new Set(interest.map(row => row.corridorId));
  const overlapIds = [...interestIds].filter(id => baselineIds.has(id));
  const baselineRank = new Map(baseline.map(row => [row.corridorId, row.rank]));
  const interestRank = new Map(interest.map(row => [row.corridorId, row.rank]));
  // Promoted: a road the heuristic lifts into the top that the measured default did not show. Demoted: a road the
  // default showed that the heuristic drops out. Both carry the component values that produced the movement.
  const promoted = interest.filter(row => !baselineIds.has(row.corridorId))
    .map(row => Object.freeze({ ...row, baselineRank: null }));
  const demoted = baseline.filter(row => !interestIds.has(row.corridorId))
    .map(row => Object.freeze({ ...row, interestRank: null }));
  const moved = overlapIds.map(id => Object.freeze({ corridorId: id,
    name: interest.find(row => row.corridorId === id)?.name ?? null,
    baselineRank: baselineRank.get(id), interestRank: interestRank.get(id),
    delta: baselineRank.get(id) - interestRank.get(id) }))
    .filter(entry => Math.abs(entry.delta) >= 2)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
  return Object.freeze({
    baselineKey, interestVersion: RANKING_VERSION, topN,
    baseline: Object.freeze(baseline), interest: Object.freeze(interest),
    overlap: overlapIds.length,
    overlapIds: Object.freeze(overlapIds),
    promoted: Object.freeze(promoted), demoted: Object.freeze(demoted), moved: Object.freeze(moved),
  });
}


// Which baseline the default ordering is: named here, once, so the evaluation and the product cannot drift.
export const BASELINE_SORT = DEFAULT_SORT;

// ---------------------------------------------------------------- pathology probes
// Each probe answers one of the failure classes the model claims to avoid, from the results themselves. A probe
// reports a measurement and a plain verdict; it never guesses a cause the derived data cannot show (whether a
// drainage-dense road is "urban infrastructure" is a proxy, and is named as one).
function stats(values) {
  const finite = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!finite.length) return { count: 0, min: null, max: null, mean: null, median: null };
  const sum = finite.reduce((total, value) => total + value, 0);
  return { count: finite.length, min: finite[0], max: finite[finite.length - 1],
    mean: round(sum / finite.length), median: finite[Math.floor(finite.length / 2)] };
}

const share = (rows, predicate) => (rows.length ? round(rows.filter(predicate).length / rows.length) : 0);


export function pathologyObservations({ results, comparison, region = {} } = {}) {
  const interest = comparison?.interest ?? [];
  const baseline = comparison?.baseline ?? [];
  const component = (row, name) => row.components?.[name];
  const saturation = (rows, name, threshold) => share(rows, row => (component(row, name) ?? 0) >= threshold);

  // 1. Wetland domination: does the heuristic just re-derive the wetland default? Measured by how much of the top
  // it shares and by the wetland component's own values, not by inspecting the weights.
  const wetlandDomination = {
    overlapWithBaseline: comparison?.overlap ?? 0,
    baselineIsWetlandOrder: comparison?.baselineKey === 'wetlandArea250',
    topWetlandComponentMedian: stats(interest.map(row => component(row, 'wetland'))).median,
    shareWetlandSaturated: saturation(interest, 'wetland', 80),
    shareWetlandIntersects: share(interest, row => row.wetlandIntersectsCorridor),
  };
  // 2. Hydrography domination: crossings and flowline quantity driving the top on their own.
  const hydroDomination = {
    crossingMedianTop: stats(interest.map(row => row.hydroCrossingCount)).median,
    crossingMedianBaseline: stats(baseline.map(row => row.hydroCrossingCount)).median,
    shareCrossingsAtLeast5: share(interest, row => row.hydroCrossingCount >= 5),
    waterDominated: interest.filter(row => (component(row, 'water') ?? 0) >= 60
      && (component(row, 'wetland') ?? 0) < 40 && (component(row, 'ecologicalVariety') ?? 0) < 40)
      .map(row => Object.freeze({ corridorId: row.corridorId, name: row.name, water: component(row, 'water'),
        crossings: row.hydroCrossingCount })),
  };
  // 3. Ecological-boundary gaming: roads whose only unusual feature is many ecoregion transitions. Also measures
  // whether the variety component varies AT ALL over the region's results: a constant component cannot game an
  // order, but it also cannot inform one - and reporting that is how a dead signal is caught rather than assumed.
  const distinctCount = values => new Set(values).size;
  const varietyValues = (results ?? []).map(result => naturalistInterest(result).components.ecologicalVariety.value)
    .filter(value => value != null);
  const ecology = {
    shareMultipleEcoregions: share(interest, row => (row.ecoregionCount ?? 1) > 1),
    shareWithTransitions: share(interest, row => (row.ecoregionTransitions ?? 0) > 0),
    varietyDistinctValues: distinctCount(varietyValues),
    varietyConstant: distinctCount(varietyValues) <= 1,
    ecoregionCountDistinct: distinctCount((results ?? []).map(result => result.ecology?.ecoregionCount ?? null)
      .filter(value => value != null)),
    transitionsDistinct: distinctCount((results ?? []).map(result => result.ecology?.transitions ?? 0)),
    transitionsMax: (results ?? []).reduce((max, result) => Math.max(max, result.ecology?.transitions ?? 0), 0),
    varietyDominant: interest.filter(row => (component(row, 'ecologicalVariety') ?? 0) >= 60
      && (component(row, 'wetland') ?? 0) < 40 && (component(row, 'water') ?? 0) < 40)
      .map(row => Object.freeze({ corridorId: row.corridorId, name: row.name, variety: component(row, 'ecologicalVariety'),
        ecoregionCount: row.ecoregionCount, transitions: row.ecoregionTransitions })),
  };
  // 4. Dry-region collapse: can the model still differentiate where wetlands are scarce? A collapsed order has one
  // effective value and a degenerate spread across the top.
  const scores = interest.map(row => row.interestScore).filter(value => Number.isFinite(value));
  const spread = scores.length > 1 ? round(scores[0] - scores[scores.length - 1]) : 0;
  const baselineValues = baseline.map(row => row.wetlandArea250M2).filter(Number.isFinite);
  const dryRegion = {
    wetlandScarce: share(results ?? [], row => ((row.signals?.wetlands?.area250M2 ?? 0) === 0
      && (row.signals?.wetlands?.area1000M2 ?? 0) === 0)) >= 0.5,
    distinctTopScores: new Set(scores).size,
    topSpread: spread,
    baselineTopSpread: baselineValues.length > 1 ? round(baselineValues[0] - baselineValues[baselineValues.length - 1]) : 0,
  };
  // 5. Coastal inflation: if most coastal corridors saturate the wetland component, the heuristic collapses toward
  // the wetland default there. Measured as saturation share and overlap.
  const coastalInflation = {
    shareWetlandSaturated: saturation(interest, 'wetland', 80),
    shareWetlandIntersects: wetlandDomination.shareWetlandIntersects,
    overlapWithBaseline: comparison?.overlap ?? 0,
  };
  // 6. Urban artifacts (a PROXY): drainage density can be an artifact of built infrastructure. A road surfaced by
  // water alone, with high crossings and no other context, is the shape to watch. It is not proof of anything.
  const urbanArtifacts = {
    proxy: 'roads surfaced by the water component alone (water >= 60, wetland and variety < 40)',
    count: hydroDomination.waterDominated.length,
    medianCrossings: stats(interest.map(row => row.hydroCrossingCount)).median,
  };
  // 7. Missing data: does a corridor with partial coverage rank surprisingly high? It cannot be scored below a
  // covered one (unmeasured components are omitted), so a high score on thin evidence is the thing to catch.
  const thin = (results ?? []).filter(result => naturalistInterest(result).evidenceFraction < 1);
  const missingData = {
    resultsWithPartialEvidence: thin.length,
    shareOfResults: (results?.length ?? 0) ? round(thin.length / results.length) : 0,
    topWithPartialEvidence: interest.filter(row => (row.evidenceFraction ?? 1) < 1)
      .map(row => Object.freeze({ corridorId: row.corridorId, name: row.name, evidenceFraction: row.evidenceFraction,
        score: row.interestScore, missing: row.missingComponents })),
    shareOfTopPartial: share(interest, row => (row.evidenceFraction ?? 1) < 1),
  };
  // 8. Distance blindness: distance is deliberately not in the score, so measure whether the top drifts outward.
  const distancesMi = (rows) => rows.map(row => row.distanceFromCenterMi).filter(Number.isFinite);
  const distance = {
    interestMedianMi: stats(distancesMi(interest)).median,
    baselineMedianMi: stats(distancesMi(baseline)).median,
    interestMaxMi: stats(distancesMi(interest)).max,
    baselineMaxMi: stats(distancesMi(baseline)).max,
  };
  return Object.freeze({
    region: region.id ?? null, corridorCount: results?.length ?? 0,
    wetlandDomination: Object.freeze(wetlandDomination), hydroDomination: Object.freeze(hydroDomination),
    ecology: Object.freeze(ecology), dryRegion: Object.freeze(dryRegion),
    coastalInflation: Object.freeze(coastalInflation), urbanArtifacts: Object.freeze(urbanArtifacts),
    missingData: Object.freeze(missingData), distance: Object.freeze(distance),
  });
}


// One region's evaluation: the two orderings, the movements, the probes, and the sort keys considered.
export function evaluateRegion({ id, name, center, radiusMiles, results, topN = 10 } = {}) {
  const comparison = compareOrderings(results, { topN });
  return Object.freeze({
    id, name, center: Object.freeze([...center]), radiusMiles, searched: results.length,
    comparison,
    observations: pathologyObservations({ results, comparison, region: { id } }),
  });
}

// What changed between two evaluations of the same regions. It is used to isolate the effect of ONE input change
// (here, the corrected ecology signal) from a weight change: nothing else differs between the two runs, so a road
// that entered or left a top moved because its ecology input changed. It reports the ecology distinctness before and
// after, which is the measurement that proves the change was real.
export function compareVersions({ previous = null, current = null } = {}) {
  if (!previous || !current) return null;
  const before = new Map((previous.regions ?? []).map(region => [region.id, region]));
  const regions = (current.regions ?? []).filter(region => before.has(region.id)).map(region => {
    const earlier = before.get(region.id);
    const previousTop = (earlier.comparison?.interest ?? []).map(row => row.corridorId);
    const currentTop = region.comparison.interest.map(row => row.corridorId);
    const previousSet = new Set(previousTop);
    const currentSet = new Set(currentTop);
    return Object.freeze({ id: region.id,
      overlap: currentTop.filter(id => previousSet.has(id)).length,
      entered: Object.freeze(currentTop.filter(id => !previousSet.has(id))),
      exited: Object.freeze(previousTop.filter(id => !currentSet.has(id))),
      previousEcologyDistinct: earlier.observations?.ecology?.varietyDistinctValues ?? null,
      currentEcologyDistinct: region.observations?.ecology?.varietyDistinctValues ?? null,
      previousTransitionsMax: earlier.observations?.ecology?.transitionsMax ?? null,
      currentTransitionsMax: region.observations?.ecology?.transitionsMax ?? null });
  });
  return Object.freeze({ previousVersion: previous.rankingVersion ?? null, currentVersion: current.rankingVersion ?? null,
    topN: current.topN ?? null, regions: Object.freeze(regions),
    meanOverlap: regions.length ? round(regions.reduce((total, entry) => total + entry.overlap, 0) / regions.length) : 0 });
}

// The whole artifact: the runs, the cross-region overlap summary, and the version the evaluation is about.
export function rankingEvaluationArtifact({ regions, radiusMiles, topN = 10, generatedAt = null,
  derivedPlane = null, baselineKey = BASELINE_SORT, previous = null } = {}) {
  const overlaps = regions.map(region => ({ region: region.id, searched: region.searched,
    overlap: region.comparison.overlap,
    overlapFraction: round(region.comparison.overlap / topN) }));
  const totalOverlap = overlaps.reduce((total, entry) => total + entry.overlap, 0);
  // Cross-region findings: which pathologies fired everywhere versus nowhere. A component that is constant in
  // every region is a dead signal, not a small one - `regionsWithConstantVariety` is how that is asserted.
  const constantVariety = regions.filter(region => region.observations?.ecology?.varietyConstant).length;
  const saturation = regions.map(region => region.observations?.wetlandDomination?.shareWetlandSaturated ?? 0);
  const comparisonToPrevious = compareVersions({ previous,
    current: { rankingVersion: RANKING_VERSION, topN, regions } });
  return Object.freeze({
    kind: RANKING_EVALUATION_KIND, schemaVersion: RANKING_EVALUATION_VERSION,
    generatedAt, rankingVersion: RANKING_VERSION, baselineKey, radiusMiles, topN, derivedPlane,
    regions: Object.freeze(regions),
    summary: Object.freeze({
      regionCount: regions.length,
      meanOverlap: regions.length ? round(totalOverlap / regions.length) : 0,
      maxOverlap: overlaps.reduce((max, entry) => Math.max(max, entry.overlap), 0),
      minOverlap: overlaps.reduce((min, entry) => Math.min(min, entry.overlap), topN),
      regionsWithConstantVariety: constantVariety,
      regionsWithZeroOverlap: Object.freeze(overlaps.filter(entry => entry.overlap === 0).map(entry => entry.region)),
      meanTopWetlandSaturation: regions.length ? round(saturation.reduce((total, value) => total + value, 0) / regions.length) : 0,
      overlaps: Object.freeze(overlaps),
    }),
    ...(comparisonToPrevious ? { comparisonToPrevious } : {}),
  });
}

