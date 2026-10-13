import test from 'node:test';
import assert from 'node:assert/strict';

import { naturalistInterest } from '../src/discovery/ranking.js';
import { DEFAULT_DISTANCE_TRANSFORM, DISTANCE_TRANSFORMS, EXPLORATION_ORDER_VERSION, distanceFraction,
  explorationOrder, rankExploration } from '../src/discovery/exploration-order.js';
import { evaluateExplorationRegion, explorationEvaluationArtifact } from '../src/discovery/ranking-evaluation.js';

// THE ORDERING IS A DIFFERENT CLAIM FROM THE SCORE.
//
// These tests pin the two things that matter about the distance-aware order: distance is NORMALIZED to the radius a
// search asked for (so it means the same thing at 10 and 50 miles), and it is BOUNDED (so it settles near-ties
// without ever burying a clearly more interesting road). The interest score itself is never touched.

const MILE = 1609.344;

function result(id, name, { interest = {}, miles = 0, ...overrides } = {}) {
  const area250 = interest.area250 ?? 0;
  return Object.freeze({ id, name, lengthM: 5000, distanceFromCenterM: miles * MILE, road: { class: 'S1400' },
    signals: {
      wetlands: { coverage: 'FULL', intersectsCorridor: area250 > 0, nearestM: interest.nearestM ?? 100,
        area250M2: area250, area500M2: area250 * 3, area1000M2: area250 * 10 },
      hydrography: { coverage: 'FULL', crossingCount: interest.crossings ?? 0, crossings: [],
        nearestFlowingM: interest.flowingM ?? 500, nearestStandingM: interest.standingM ?? 800,
        flowlineLength1000M: interest.flowline ?? 1000 },
    },
    ecology: { coverage: 'FULL', ecoregionCount: interest.ecoregions ?? 1, transitions: interest.transitions ?? 0,
      level3: { primary: { name: 'L3' } }, level4: { primary: { name: 'L4' } } }, ...overrides });
}

// A road whose interest score is roughly `target`: solved by hand for this fixture's shape, so the tests compare
// roads whose interest is genuinely close rather than roads that happen to be.
function road(id, name, { miles, area250 }) {
  return result(id, name, { miles, interest: { area250, nearestM: 60, crossings: 3, flowingM: 120,
    standingM: 300, flowline: 6000, ecoregions: 2, transitions: 1 } });
}

test('distance is normalized to the radius the search asked for, and clamped', () => {
  assert.equal(distanceFraction(0, 40_000), 0, 'at the centre there is no distance');
  assert.equal(distanceFraction(20_000, 40_000), 0.5, 'half the radius is half the fraction');
  assert.equal(distanceFraction(40_000, 40_000), 1, 'at the radius the fraction is one');
  assert.equal(distanceFraction(80_000, 40_000), 1, 'beyond the radius it is clamped, never over one');
  assert.equal(distanceFraction(500, null), null, 'no declared radius means no distance to speak of');
  assert.equal(distanceFraction(null, 40_000), null, 'no measured distance means the same');
  // THE POINT OF NORMALISING: 20 miles is the rim of a 25-mile search and the middle of a 50-mile one.
  assert.equal(distanceFraction(20 * MILE, 25 * MILE), 0.8);
  assert.equal(distanceFraction(20 * MILE, 50 * MILE), 0.4);
});

test('no centre, no radius, or no distance: the order is the interest score, unchanged', () => {
  const far = road('far', 'Far Rd', { miles: 20, area250: 40000 });
  const interest = naturalistInterest(far).score;
  for (const context of [{ radiusM: null }, {}, { radiusM: 0 }]) {
    const order = explorationOrder(far, context);
    assert.equal(order.score, interest, 'with no radius the order equals the interest score');
    assert.equal(order.penalty, 0);
    assert.equal(order.distanceFraction, null);
  }
  const blind = result('blind', 'Blind Rd', { miles: 20 });
  assert.equal(explorationOrder(blind, { radiusM: 25 * MILE }).distanceFraction, 0.8,
    'a measured distance still yields a fraction');
});

test('the penalty is bounded by the transform cap, and zero at the centre', () => {
  const centre = road('centre', 'Centre Rd', { miles: 0, area250: 40000 });
  const rim = road('rim', 'Rim Rd', { miles: 25, area250: 40000 });
  const model = DISTANCE_TRANSFORMS[DEFAULT_DISTANCE_TRANSFORM];
  assert.equal(model.key, 'gentle');
  assert.equal(model.cap, 6);
  const atCentre = explorationOrder(centre, { radiusM: 25 * MILE });
  assert.equal(atCentre.penalty, 0, 'a road at the centre pays nothing');
  assert.equal(atCentre.score, atCentre.naturalistInterest);
  const atRim = explorationOrder(rim, { radiusM: 25 * MILE });
  assert.equal(atRim.penalty, model.cap, 'a road at the rim pays the cap, not more');
  assert.equal(atRim.score, Math.max(0, atRim.naturalistInterest - model.cap));
  // Bounded means bounded: beyond the radius the penalty cannot grow.
  const beyond = explorationOrder(road('beyond', 'Beyond Rd', { miles: 40, area250: 40000 }), { radiusM: 25 * MILE });
  assert.equal(beyond.penalty, model.cap);
});

test('distance can never raise the score it adjusts', () => {
  for (const miles of [0, 1, 5, 12.5, 24, 25, 40]) {
    const order = explorationOrder(road('r', 'R Rd', { miles, area250: 60000 }), { radiusM: 25 * MILE });
    assert.ok(order.score <= order.naturalistInterest, `${miles} mi: the order may not exceed the interest score`);
    assert.ok(order.penalty >= 0);
  }
});

test('the order is deterministic and never depends on input order', () => {
  const roads = [road('a', 'A Rd', { miles: 4, area250: 200000 }), road('b', 'B Rd', { miles: 22, area250: 3_000_000 }),
    road('c', 'C Rd', { miles: 12, area250: 250000 })];
  const forward = rankExploration(roads, { radiusM: 25 * MILE }).map(entry => entry.result.id);
  const again = rankExploration(roads, { radiusM: 25 * MILE }).map(entry => entry.result.id);
  const reversed = rankExploration([...roads].reverse(), { radiusM: 25 * MILE }).map(entry => entry.result.id);
  assert.deepEqual(forward, again);
  assert.deepEqual(forward, reversed, 'the same set always produces the same order');
});

test('a clearly more interesting road is never buried by distance', () => {
  // The interest gap is larger than the largest penalty any transform can charge, so no distance can flip it.
  const strongFar = road('strong', 'Strong Far Rd', { miles: 24, area250: 3_000_000 });
  const weakNear = road('weak', 'Weak Near Rd', { miles: 1, area250: 200_000 });
  const gap = naturalistInterest(strongFar).score - naturalistInterest(weakNear).score;
  const cap = DISTANCE_TRANSFORMS[DEFAULT_DISTANCE_TRANSFORM].cap;
  assert.ok(gap > cap, `the fixture must be a clear difference (gap ${gap}, cap ${cap})`);
  for (const key of Object.keys(DISTANCE_TRANSFORMS)) {
    const ordered = rankExploration([weakNear, strongFar], { radiusM: 25 * MILE, transform: key })
      .map(entry => entry.result.id);
    assert.equal(ordered[0], 'strong', `${key}: the more interesting road survives a 23-mile disadvantage`);
  }
  // And the weaker road is still ordered by its own interest: nothing invents interest for being near.
  const near = explorationOrder(weakNear, { radiusM: 25 * MILE });
  assert.equal(near.score, near.naturalistInterest);
});

test('among near-tied roads, the nearer one is preferred', () => {
  const far = road('far', 'Far Rd', { miles: 20, area250: 205_000 });
  const near = road('near', 'Near Rd', { miles: 2, area250: 195_000 });
  const gap = Math.abs(naturalistInterest(far).score - naturalistInterest(near).score);
  assert.ok(gap <= 1, `the fixture must be a near tie (gap ${gap})`);
  assert.ok(naturalistInterest(near).score < naturalistInterest(far).score,
    'the nearer road is the lower-scoring one, so the two orderings disagree');
  const ordered = rankExploration([far, near], { radiusM: 25 * MILE }).map(entry => entry.result.id);
  assert.equal(ordered[0], 'near', 'distance settles the near tie');
  // The interest order still puts the higher score first: the score itself is untouched.
  assert.ok(naturalistInterest(far).score > naturalistInterest(near).score);
});

test('the naturalist-interest score is unchanged by being ordered, and is reported beside the order', () => {
  const roads = [road('a', 'A Rd', { miles: 2, area250: 200000 }), road('b', 'B Rd', { miles: 20, area250: 260000 })];
  const before = roads.map(entry => naturalistInterest(entry));
  const order = explorationOrder(roads[1], { radiusM: 25 * MILE });
  assert.equal(order.naturalistInterest, before[1].score, 'the order reports the interest score it adjusted');
  assert.equal(order.interestVersion, 'naturalist-interest-v2');
  assert.equal(order.version, EXPLORATION_ORDER_VERSION);
  assert.ok(order.score < order.naturalistInterest, 'and the adjusted score is lower, never the same by accident');
  assert.deepEqual(roads.map(entry => naturalistInterest(entry)), before, 'ordering does not change the score');
});

test('the evaluation artifact records both scores and both version names', () => {
  const results = [road('d', 'D Rd', { miles: 1, area250: 150000 }), road('a', 'A Rd', { miles: 2, area250: 200000 }),
    road('b', 'B Rd', { miles: 6, area250: 220000 }), road('e', 'E Rd', { miles: 12, area250: 250000 }),
    road('c', 'C Rd', { miles: 20, area250: 300000 })];
  const region = evaluateExplorationRegion({ id: 'fixture', name: 'Fixture', center: [0, 0], radiusMiles: 25,
    radiusM: 25 * MILE, results, topN: 3 });
  const artifact = explorationEvaluationArtifact({ regions: [region], radiusMiles: 25, topN: 3, generatedAt: 'fixed' });
  assert.equal(artifact.orderVersion, EXPLORATION_ORDER_VERSION);
  assert.equal(artifact.interestVersion, 'naturalist-interest-v2');
  assert.equal(artifact.selectedCandidate, DEFAULT_DISTANCE_TRANSFORM);
  assert.ok(artifact.successCriteria == null || typeof artifact.successCriteria === 'object');
  for (const row of artifact.regions[0].selected.order) {
    assert.ok(Number.isFinite(row.interestScore), 'each row keeps the interest score');
    assert.ok(Number.isFinite(row.explorationScore), 'and carries the exploration score beside it');
    assert.ok(row.distanceFraction >= 0 && row.distanceFraction <= 1);
    assert.ok(row.distancePenalty >= 0);
  }
  assert.ok(artifact.regions[0].interestTop.every(row => row.explorationScore === undefined),
    'the interest top is reported as the interest score alone');
  const summary = artifact.summary.selected;
  assert.equal(summary.regionsDistanceReduced, 1);
  assert.ok(summary.worstInterestDelta <= 0, 'the distance term only ever costs interest');
});

