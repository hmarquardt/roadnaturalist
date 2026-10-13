import { RANKING_VERSION, naturalistInterest, rankResults } from './ranking.js';
import { DEFAULT_SORT, sortResults } from './filter.js';
import { DEFAULT_DISTANCE_TRANSFORM, DISTANCE_TRANSFORMS, EXPLORATION_ORDER_VERSION, TRANSFORM_KEYS,
  explorationOrder, rankExploration } from './exploration-order.js';

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
export function evaluationRow(result, { rank = null, exploration = null } = {}) {
  const ranking = naturalistInterest(result);
  const wetlands = result?.signals?.wetlands ?? {};
  const hydro = result?.signals?.hydrography ?? {};
  const ecology = result?.ecology ?? {};
  // The distance-aware order travels beside the interest score, and only when a caller asked for it: an evaluation
  // of the interest score itself must report exactly what it always reported.
  const order = exploration ? explorationOrder(result, { radiusM: exploration.radiusM ?? null,
    transform: exploration.transform }) : null;
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
    ...(order ? { explorationScore: order.score, explorationVersion: order.version,
      explorationTransform: order.transform, distanceFraction: order.distanceFraction,
      distancePenalty: order.penalty } : {}),
  });
}

// The ordered top of one ordering. The heuristic uses `rankResults` (the runtime's own order); every other key
// uses `sortResults`, so neither ordering is a second implementation. `context` carries the search radius the
// exploration order normalises distance against.
export function orderedResults(results, sortKey, context = undefined) {
  if (sortKey === 'naturalistInterest') return rankResults(results).map(entry => entry.result);
  if (sortKey === 'explorationOrder') {
    return rankExploration(results, { radiusM: context?.radiusM ?? null, transform: context?.transform })
      .map(entry => entry.result);
  }
  return sortResults(results, sortKey);
}

export function topUnder(results, sortKey, topN, context = undefined) {
  return orderedResults(results, sortKey, context).slice(0, topN)
    .map((result, index) => evaluationRow(result, { rank: index + 1,
      exploration: sortKey === 'explorationOrder' ? context ?? {} : null }));
}

// The shared movement report for two orderings over the same results.
function compareTops(baseline, interest, { baselineKey, interestKey, interestVersion, topN }) {
  const baselineIds = new Set(baseline.map(row => row.corridorId));
  const interestIds = new Set(interest.map(row => row.corridorId));
  const overlapIds = [...interestIds].filter(id => baselineIds.has(id));
  const baselineRank = new Map(baseline.map(row => [row.corridorId, row.rank]));
  const interestRank = new Map(interest.map(row => [row.corridorId, row.rank]));
  // Promoted: a road the second ordering lifts into the top that the first did not show. Demoted: a road the first
  // showed that the second drops out. Both carry the values that produced the movement.
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
    baselineKey, interestKey, interestVersion, topN,
    baseline: Object.freeze(baseline), interest: Object.freeze(interest),
    overlap: overlapIds.length,
    overlapIds: Object.freeze(overlapIds),
    promoted: Object.freeze(promoted), demoted: Object.freeze(demoted), moved: Object.freeze(moved),
  });
}

// The two orderings side by side, with the movements and the context that explains them.
export function compareOrderings(results, { topN = 10, baselineKey = BASELINE_SORT } = {}) {
  const report = compareTops(topUnder(results, baselineKey, topN), topUnder(results, 'naturalistInterest', topN),
    { baselineKey, interestKey: 'naturalistInterest', interestVersion: RANKING_VERSION, topN });
  // The keys this evaluation has always reported, in the order it reported them.
  return Object.freeze({ baselineKey: report.baselineKey, interestVersion: report.interestVersion, topN,
    baseline: report.baseline, interest: report.interest, overlap: report.overlap,
    overlapIds: report.overlapIds, promoted: report.promoted, demoted: report.demoted, moved: report.moved });
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


// ---------------------------------------------------------------- exploration order (distance-aware)
// Evaluating a *distance-aware* order needs more than overlap: the point of the distance term is to improve practical
// usefulness, and the risk is that it quietly trades away environmental quality. So the report measures both sides
// of that trade - how far the top moved, and how much interest it kept.
export const NEAR_TIE_INTERVAL = 1; // interest points within which distance may legitimately reorder

const mean = values => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : null);

function distanceStats(rows) {
  const miles = rows.map(row => row.distanceFromCenterMi).filter(Number.isFinite).sort((a, b) => a - b);
  if (!miles.length) return { count: 0, median: null, mean: null, p90: null, max: null };
  return { count: miles.length, median: miles[Math.floor(miles.length / 2)], mean: round(mean(miles)),
    p90: miles[Math.min(miles.length - 1, Math.max(0, Math.ceil(miles.length * 0.9) - 1))], max: miles[miles.length - 1] };
}

function meanInterest(rows) {
  const values = rows.map(row => row.interestScore).filter(Number.isFinite);
  return values.length ? round(mean(values)) : null;
}

// NEAR-TIE RESOLUTION. Among pairs of roads whose interest scores are within `interval` of each other AND where the
// nearer road is the lower-scoring one, how often does the distance-aware order put the nearer road first? That is
// exactly the behaviour the design claims: distance should settle near-ties, not overrule clear differences.
export function nearTieResolution(results, { radiusM = null, transform = undefined, window = 30,
  interval = NEAR_TIE_INTERVAL } = {}) {
  const byInterest = orderedResults(results, 'naturalistInterest').slice(0, window);
  const orderRank = new Map(rankExploration(byInterest, { radiusM, transform })
    .map((entry, index) => [entry.result.id, index]));
  const measured = byInterest.map(result => ({ result, score: naturalistInterest(result).score,
    distanceM: result.distanceFromCenterM }));
  let tension = 0;
  let resolvedTowardNearer = 0;
  for (let left = 0; left < measured.length; left++) {
    for (let right = left + 1; right < measured.length; right++) {
      const a = measured[left];
      const b = measured[right];
      if (a.score == null || b.score == null) continue;
      if (Math.abs(a.score - b.score) > interval) continue;
      if (!Number.isFinite(a.distanceM) || !Number.isFinite(b.distanceM) || a.distanceM === b.distanceM) continue;
      const higher = a.score >= b.score ? a : b;
      const nearer = a.distanceM <= b.distanceM ? a : b;
      // Only the pairs in tension - the more interesting road is the farther one - can show the term at work.
      if (higher.result.id === nearer.result.id) continue;
      tension += 1;
      const nearRank = orderRank.get(nearer.result.id);
      const highRank = orderRank.get(higher.result.id);
      if (nearRank != null && highRank != null && nearRank < highRank) resolvedTowardNearer += 1;
    }
  }
  return Object.freeze({ interval, tension, resolvedTowardNearer,
    share: tension ? round(resolvedTowardNearer / tension) : null });
}

// What the distance term did to one region's top: both sides of the trade, measured.
function explorationMetrics({ results, interestTop, orderTop, radiusM, transform }) {
  const interestTopMean = meanInterest(interestTop);
  const orderTopMean = meanInterest(orderTop);
  const orderIds = orderTop.map(row => row.corridorId);
  const first = interestTop[0]?.corridorId ?? null;
  const firstScore = interestTop[0]?.interestScore ?? null;
  const lastScore = interestTop[interestTop.length - 1]?.interestScore ?? null;
  // SUPPRESSION, MADE MEASURABLE. The interest top is a narrow band in every region (a few points), so a distance
  // term MUST reorder inside it - that is what it is for. The question worth asking is how much interest the new
  // first row gives up against the old one. A gap that is small beside the band the order is reordering within is a
  // near-tie settled by convenience; a gap larger than the whole band would be a strong road buried, and would show
  // here.
  return Object.freeze({
    distanceFrom: Object.freeze(distanceStats(interestTop)),
    distanceAfter: Object.freeze(distanceStats(orderTop)),
    interestTopMean, orderTopMean,
    interestTopSpread: firstScore != null && lastScore != null ? round(firstScore - lastScore) : null,
    interestDelta: interestTopMean != null && orderTopMean != null ? round(orderTopMean - interestTopMean) : null,
    interestRetainedRatio: interestTopMean ? round(orderTopMean / interestTopMean, 3) : null,
    topInterestRetained: Object.freeze({ corridorId: first,
      inTop3: first != null && orderIds.slice(0, 3).includes(first),
      inTop5: first != null && orderIds.slice(0, 5).includes(first),
      inTop10: first != null && orderIds.includes(first),
      newTopId: orderTop[0]?.corridorId ?? null,
      replacedByGap: firstScore != null && orderTop[0]?.interestScore != null
        ? round(firstScore - orderTop[0].interestScore) : null }),
    nearTie: nearTieResolution(results, { radiusM, transform }),
  });
}

// The interest order against the distance-aware order, with every candidate transform measured on the same results.
export function compareExploration(results, { radiusM = null, transform = undefined, topN = 10 } = {}) {
  const context = { radiusM, transform };
  const interestTop = topUnder(results, 'naturalistInterest', topN);
  const orderTop = topUnder(results, 'explorationOrder', topN, context);
  const movement = compareTops(interestTop, orderTop, { baselineKey: 'naturalistInterest',
    interestKey: 'explorationOrder', interestVersion: EXPLORATION_ORDER_VERSION, topN });
  return Object.freeze({ orderVersion: EXPLORATION_ORDER_VERSION, interestVersion: RANKING_VERSION,
    radiusM, transform: orderTop[0]?.explorationTransform ?? transform ?? null, topN,
    interest: movement.baseline, order: movement.interest, overlap: movement.overlap,
    overlapIds: movement.overlapIds, promoted: movement.promoted, demoted: movement.demoted, moved: movement.moved,
    metrics: explorationMetrics({ results, interestTop, orderTop, radiusM, transform }) });
}


// ---------------------------------------------------------------- exploration evaluation artifact
export const EXPLORATION_EVALUATION_KIND = 'exploration-order-evaluation';
export const EXPLORATION_EVALUATION_VERSION = 1;

// One region, every candidate transform measured on the same results, plus the full top of the selected candidate.
export function evaluateExplorationRegion({ id, name, center, radiusMiles, radiusM = null, results, topN = 10,
  candidates = TRANSFORM_KEYS, selectedCandidate = DEFAULT_DISTANCE_TRANSFORM } = {}) {
  const perCandidate = {};
  let selected = null;
  for (const key of candidates) {
    const comparison = compareExploration(results, { radiusM, transform: key, topN });
    perCandidate[key] = Object.freeze({ overlap: comparison.overlap,
      promoted: Object.freeze(comparison.promoted.map(row => row.corridorId)),
      demoted: Object.freeze(comparison.demoted.map(row => row.corridorId)),
      metrics: comparison.metrics });
    if (key === selectedCandidate) selected = comparison;
  }
  return Object.freeze({
    id, name, center: Object.freeze([...center]), radiusMiles, searched: results.length,
    interestTop: topUnder(results, 'naturalistInterest', topN),
    candidates: Object.freeze(perCandidate), selectedCandidate,
    selected: selected ? Object.freeze({ order: selected.order, promoted: selected.promoted,
      demoted: selected.demoted, moved: selected.moved, metrics: selected.metrics }) : null,
  });
}

// The cross-region verdict for one candidate: did it move the top closer, and what did it cost in interest?
function candidateSummary(regions, key) {
  const entries = regions.map(region => region.candidates[key]).filter(Boolean);
  const mediansBefore = entries.map(entry => entry.metrics.distanceFrom.median).filter(Number.isFinite);
  const mediansAfter = entries.map(entry => entry.metrics.distanceAfter.median).filter(Number.isFinite);
  const deltas = entries.map(entry => entry.metrics.interestDelta).filter(Number.isFinite);
  const shares = entries.map(entry => entry.metrics.nearTie.share).filter(Number.isFinite);
  const spreads = entries.map(entry => entry.metrics.interestTopSpread).filter(Number.isFinite);
  const gaps = entries.filter(entry => entry.metrics.topInterestRetained.newTopId
    !== entry.metrics.topInterestRetained.corridorId)
    .map(entry => entry.metrics.topInterestRetained.replacedByGap).filter(Number.isFinite);
  return Object.freeze({
    transform: key, label: DISTANCE_TRANSFORMS[key]?.label ?? null, cap: DISTANCE_TRANSFORMS[key]?.cap ?? null,
    regions: entries.length,
    meanOverlap: entries.length ? round(mean(entries.map(entry => entry.overlap))) : null,
    meanMedianDistanceBefore: round(mean(mediansBefore)), meanMedianDistanceAfter: round(mean(mediansAfter)),
    regionsDistanceReduced: entries.filter(entry => Number.isFinite(entry.metrics.distanceAfter.median)
      && entry.metrics.distanceAfter.median < entry.metrics.distanceFrom.median).length,
    meanInterestDelta: round(mean(deltas)),
    worstInterestDelta: deltas.length ? Math.min(...deltas) : null,
    maxInterestTopSpread: spreads.length ? Math.max(...spreads) : null,
    topInterestRetainedInTop10: entries.filter(entry => entry.metrics.topInterestRetained.inTop10).length,
    topInterestRetainedInTop3: entries.filter(entry => entry.metrics.topInterestRetained.inTop3).length,
    regionsTopRowChanged: gaps.length,
    worstReplacedByGap: gaps.length ? Math.max(...gaps) : null,
    nearTiePairs: entries.reduce((total, entry) => total + entry.metrics.nearTie.tension, 0),
    nearTieShare: round(mean(shares)),
  });
}

export function explorationEvaluationArtifact({ regions, radiusMiles, topN = 10, candidates = TRANSFORM_KEYS,
  selectedCandidate = DEFAULT_DISTANCE_TRANSFORM, generatedAt = null, derivedPlane = null,
  baselineKey = BASELINE_SORT, successCriteria = null } = {}) {
  const byCandidate = Object.fromEntries(candidates.map(key => [key, candidateSummary(regions, key)]));
  return Object.freeze({
    kind: EXPLORATION_EVALUATION_KIND, schemaVersion: EXPLORATION_EVALUATION_VERSION,
    generatedAt, orderVersion: EXPLORATION_ORDER_VERSION, interestVersion: RANKING_VERSION, baselineKey,
    radiusMiles, topN, nearTieInterval: NEAR_TIE_INTERVAL,
    candidates: Object.freeze(candidates.map(key => Object.freeze({ key,
      label: DISTANCE_TRANSFORMS[key]?.label ?? null, cap: DISTANCE_TRANSFORMS[key]?.cap ?? null }))),
    selectedCandidate, successCriteria, derivedPlane, regions: Object.freeze(regions),
    summary: Object.freeze({ byCandidate: Object.freeze(byCandidate),
      selected: byCandidate[selectedCandidate] ?? null }),
  });
}

