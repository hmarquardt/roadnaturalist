import test from 'node:test';
import assert from 'node:assert/strict';

import { RANKING_VERSION, RANKING_WEIGHTS, naturalistInterest } from '../src/discovery/ranking.js';
import { DEFAULT_SORT } from '../src/discovery/filter.js';
import { BASELINE_SORT, compareOrderings, evaluateRegion, evaluationRow, rankingEvaluationArtifact,
  RANKING_EVALUATION_KIND, topUnder } from '../src/discovery/ranking-evaluation.js';

// THE EVALUATION IS A MEASUREMENT, NOT A SECOND RANKING.
//
// These tests pin the *shape and determinism* of the evaluation: it reports the application's own order, it is
// reproducible from the same results, and it never becomes a place where v1's own numbers are restated by hand.
// Every fixture is a discovery result as `buildDiscoveryResult` produces one.

function result(id, name, { area250 = 0, area500 = area250 * 3, area1000 = area250 * 10, nearestM = 100,
  crossings = 0, nearestFlowingM = null, nearestStandingM = null, flowline = 0, ecoregionCount = 1,
  transitions = 0, wetlandsCoverage = 'FULL', hydroCoverage = 'FULL', ecologyCoverage = 'FULL',
  distanceFromCenterM = 5000, lengthM = 5000, roadClass = 'S1400' } = {}) {
  return Object.freeze({ id, name, lengthM, distanceFromCenterM, road: { class: roadClass },
    signals: {
      wetlands: { coverage: wetlandsCoverage, intersectsCorridor: area250 > 0, nearestM,
        area250M2: area250, area500M2: area500, area1000M2: area1000 },
      hydrography: { coverage: hydroCoverage, crossingCount: crossings, crossings: [],
        nearestFlowingM, nearestStandingM, flowlineLength1000M: flowline },
    },
    ecology: { coverage: ecologyCoverage, ecoregionCount, transitions,
      level3: { primary: { name: 'Some Level 3' } }, level4: { primary: { name: 'Some Level 4' } } } });
}

// A fixture whose two orderings genuinely diverge: two roads strong on both orderings, one wetland giant the
// measured default surfaces and the heuristic drops, one drainage/ecology road with no wetland area at all that the
// heuristic lifts, and one corridor whose habitat could not be measured.
function fixture() {
  return [
    result('drv1-shared-river-rd-s1', 'Shared River Rd', { area250: 1_000_000, nearestM: 50, crossings: 3,
      nearestFlowingM: 100, nearestStandingM: 300, flowline: 6000, ecoregionCount: 3, transitions: 2 }),
    result('drv1-creek-rd-s1', 'Creek Rd', { area250: 300_000, nearestM: 80, crossings: 2,
      nearestFlowingM: 200, nearestStandingM: 400, flowline: 4000, ecoregionCount: 2, transitions: 1 }),
    result('drv1-wetland-giant-s1', 'Wetland Giant Rd', { area250: 5_000_000, nearestM: 0, crossings: 0,
      nearestFlowingM: 900, nearestStandingM: 900, flowline: 0, ecoregionCount: 1, transitions: 0 }),
    result('drv1-drainage-rd-s1', 'Drainage Rd', { area250: 0, nearestM: 5000, crossings: 20,
      nearestFlowingM: 0, nearestStandingM: 0, flowline: 200_000, ecoregionCount: 8, transitions: 10 }),
    result('drv1-blind-rd-s1', 'Blind Rd', { wetlandsCoverage: 'UNKNOWN', hydroCoverage: 'UNKNOWN',
      ecologyCoverage: 'UNKNOWN' }),
  ];
}

test('the evaluation is deterministic and carries the ranking version it is about', () => {
  assert.equal(RANKING_EVALUATION_KIND, 'road-ranking-evaluation');
  const first = compareOrderings(fixture(), { topN: 4 });
  const second = compareOrderings(fixture(), { topN: 4 });
  assert.deepEqual(first, second, 'the same results always produce the same evaluation');
  assert.equal(first.interestVersion, RANKING_VERSION);
  assert.equal(first.interestVersion, 'naturalist-interest-v1');
  const artifact = rankingEvaluationArtifact({ regions: [evaluateRegion({ id: 'x', name: 'X', center: [0, 0],
    radiusMiles: 25, results: fixture(), topN: 4 })], radiusMiles: 25, topN: 4, generatedAt: 'fixed' });
  assert.equal(artifact.rankingVersion, RANKING_VERSION);
  assert.equal(artifact.baselineKey, BASELINE_SORT);
  assert.equal(artifact.baselineKey, DEFAULT_SORT, 'the baseline is the product default, named once');
  assert.equal(artifact.baselineKey, 'wetlandArea250');
});

test('the top-N is stable for a fixed fixture and independent of input order', () => {
  const forward = topUnder(fixture(), 'naturalistInterest', 4).map(row => row.corridorId);
  const reversed = topUnder([...fixture()].reverse(), 'naturalistInterest', 4).map(row => row.corridorId);
  assert.deepEqual(forward, reversed, 'the input order never changes the order');
  // The order the model produces for this fixture: the two roads strong on both orderings, then the drainage road
  // the measured default cannot see (no wetland area at all), then the wetland giant. The unmeasurable corridor is
  // omitted from the top (no score).
  assert.deepEqual(forward, ['drv1-shared-river-rd-s1', 'drv1-creek-rd-s1', 'drv1-drainage-rd-s1', 'drv1-wetland-giant-s1']);
});

test('the overlap is the intersection of the two top sets, counted exactly', () => {
  const comparison = compareOrderings(fixture(), { topN: 3 });
  const baselineIds = new Set(comparison.baseline.map(row => row.corridorId));
  const interestIds = new Set(comparison.interest.map(row => row.corridorId));
  const expected = [...interestIds].filter(id => baselineIds.has(id)).length;
  assert.equal(comparison.overlap, expected);
  assert.deepEqual([...comparison.overlapIds].sort(),
    ['drv1-shared-river-rd-s1', 'drv1-creek-rd-s1', 'drv1-wetland-giant-s1', 'drv1-drainage-rd-s1', 'drv1-blind-rd-s1']
      .filter(id => baselineIds.has(id) && interestIds.has(id)).sort());
  // Promotions and demotions partition the two tops: everything shown by one and not the other.
  assert.equal(comparison.promoted.length + comparison.overlap, comparison.interest.length);
  assert.equal(comparison.demoted.length + comparison.overlap, comparison.baseline.length);
  assert.equal(comparison.demoted[0].corridorId, 'drv1-wetland-giant-s1',
    'the sheer wetland quantity the default surfaces is the road the heuristic demotes');
});

test('a corridor with no measured context has no score, is reported as missing, and never ranks above a measured one', () => {
  const rows = topUnder(fixture(), 'naturalistInterest', 4);
  assert.ok(!rows.some(row => row.corridorId === 'drv1-blind-rd-s1'), 'an unmeasured corridor is not in the top');
  const blind = evaluationRow(fixture()[4]);
  assert.equal(blind.interestScore, null);
  assert.equal(blind.evidenceFraction, 0);
  assert.deepEqual([...blind.missingComponents].sort(), ['ecologicalVariety', 'water', 'wetland']);
  const artifact = rankingEvaluationArtifact({ regions: [evaluateRegion({ id: 'x', name: 'X', center: [0, 0],
    radiusMiles: 25, results: fixture(), topN: 4 })], radiusMiles: 25, topN: 4, generatedAt: 'fixed' });
  assert.equal(artifact.regions[0].observations.missingData.resultsWithPartialEvidence, 1);
  assert.equal(artifact.regions[0].observations.missingData.topWithPartialEvidence.length, 0,
    'thin evidence never appears in the top of a region that has measured corridors');
});

test('every reported road carries identity, context, components and the raw measurements behind them', () => {
  const row = topUnder(fixture(), 'naturalistInterest', 1)[0];
  for (const key of ['rank', 'corridorId', 'name', 'distanceFromCenterM', 'distanceFromCenterMi', 'derivedLengthM',
    'interestScore', 'evidenceFraction', 'components', 'nearestWetlandM', 'wetlandArea250M2', 'wetlandArea500M2',
    'wetlandArea1000M2', 'hydroCrossingCount', 'nearestFlowingM', 'nearestStandingM', 'ecoregionCount',
    'ecoregionTransitions', 'wetlandCoverage', 'hydroCoverage', 'ecologyCoverage']) {
    assert.ok(key in row, `row carries ${key}`);
  }
  assert.equal(row.rank, 1);
  assert.ok(Number.isFinite(row.interestScore) && row.interestScore >= 0 && row.interestScore <= 100);
});

test('v1 is immutable: the evaluation reads it, never restates it, and its weights and version are pinned', () => {
  // The evaluation must not become a second copy of the model. If these change, that is a *versioned* decision that
  // has to introduce naturalist-interest-v2 rather than silently move v1.
  assert.equal(RANKING_VERSION, 'naturalist-interest-v1');
  assert.deepEqual({ ...RANKING_WEIGHTS }, { wetland: 0.45, water: 0.35, ecologicalVariety: 0.2 });
  // And the evaluation's own reported component values are exactly the ones the model returns, not recomputed here.
  const row = evaluationRow(fixture()[0]);
  const model = naturalistInterest(fixture()[0]);
  assert.equal(row.interestScore, model.score);
  assert.equal(row.components.wetland, model.components.wetland.value);
  assert.equal(row.components.water, model.components.water.value);
  assert.equal(row.components.ecologicalVariety, model.components.ecologicalVariety.value);
  assert.equal(row.evidenceFraction, model.evidenceFraction);
});

test('pathology probes report the movement context for the classes the model claims to avoid', () => {
  const region = evaluateRegion({ id: 'fixture', name: 'Fixture', center: [0, 0], radiusMiles: 25,
    results: fixture(), topN: 4 });
  const o = region.observations;
  assert.equal(o.corridorCount, 5);
  for (const key of ['wetlandDomination', 'hydroDomination', 'ecology', 'dryRegion', 'coastalInflation',
    'urbanArtifacts', 'missingData', 'distance']) assert.ok(o[key], `observation ${key} is present`);
  assert.ok(o.hydroDomination.crossingMedianTop >= 0);
  assert.ok(Array.isArray(o.hydroDomination.waterDominated));
  assert.equal(typeof o.urbanArtifacts.proxy, 'string');
  // The variety probe distinguishes a region whose ecology actually varies from one where it does not: the fixture
  // has corridors in 1, 2, 3 and 8 ecoregions, so it must NOT be reported as constant.
  assert.ok(o.ecology.varietyDistinctValues >= 2, `fixture variety should vary (got ${o.ecology.varietyDistinctValues})`);
  assert.equal(o.ecology.varietyConstant, false);
  assert.equal(o.ecology.transitionsMax, 10);
});

