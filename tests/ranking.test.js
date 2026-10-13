import test from 'node:test';
import assert from 'node:assert/strict';

import { RANKING_VERSION, RANKING_WEIGHTS, naturalistInterest, proximity, rankResults, saturate }
  from '../src/discovery/ranking.js';

// AN EXPLORATION ORDER THAT CANNOT OVERCLAIM.
//
// The ranking is derived from measured signals only, so these tests are about its *shape*: bounded, deterministic,
// coverage-aware, and explainable. Every fixture is a discovery result as the analysis actually produces one.

function result(overrides = {}) {
  const base = { id: 'drv1-river-rd-c1-s1', name: 'River Rd', lengthM: 5000,
    signals: { wetlands: { coverage: 'FULL', intersectsCorridor: false, nearestM: 120, area250M2: 20_000,
      area500M2: 60_000, area1000M2: 200_000, featureCount250: 2, featureCount1000: 5, types: [] },
    hydrography: { coverage: 'FULL', crossingCount: 1, crossings: [], nearestFlowingM: 300, nearestStandingM: 500,
      flowlineLength1000M: 2000, namedWaters: [] } },
    ecology: { coverage: 'FULL', ecoregionCount: 1, transitions: 0,
      level3: { primary: { name: 'Willamette Valley' } }, level4: { primary: { name: 'Portland/Vancouver Basin' } } } };
  return { ...base, ...overrides, signals: { ...base.signals, ...(overrides.signals ?? {}) },
    ecology: { ...base.ecology, ...(overrides.ecology ?? {}) } };
}

test('the ranking is deterministic and carries its version', () => {
  assert.deepEqual(naturalistInterest(result()), naturalistInterest(result()));
  assert.equal(RANKING_VERSION, 'naturalist-interest-v2');
  assert.equal(naturalistInterest(result()).version, RANKING_VERSION);
});

test('bounded transforms: a half-point is 0.5, and nothing ever reaches the top of the curve', () => {
  assert.equal(saturate(0, 3), 0);
  assert.equal(saturate(3, 3), 0.5);
  assert.ok(saturate(1_000_000_000, 3) < 1);
  assert.equal(proximity(0, 200), 1);
  assert.equal(proximity(200, 200), 0.5);
  assert.equal(proximity(null, 200), 0, 'an unknown distance is no proximity, not a negative one');
});

test('the score stays on its scale even for an extreme corridor', () => {
  const extreme = naturalistInterest(result({
    signals: { wetlands: { coverage: 'FULL', nearestM: 0, area250M2: 1e12, area500M2: 1e12, area1000M2: 1e12,
      intersectsCorridor: true },
    hydrography: { coverage: 'FULL', crossingCount: 500, nearestFlowingM: 0, nearestStandingM: 0,
      flowlineLength1000M: 1e9 } },
    ecology: { coverage: 'FULL', ecoregionCount: 40, transitions: 90 } }));
  assert.ok(extreme.score > 90 && extreme.score <= 100, `extreme corridor: ${extreme.score}`);
});

test('diminishing returns: ten times the wetland is not ten times the component', () => {
  const small = naturalistInterest(result({ signals: { wetlands: { coverage: 'FULL', nearestM: 100, area250M2: 10_000,
    area500M2: 30_000, area1000M2: 100_000, intersectsCorridor: false } } }));
  const large = naturalistInterest(result({ signals: { wetlands: { coverage: 'FULL', nearestM: 100, area250M2: 100_000,
    area500M2: 300_000, area1000M2: 1_000_000, intersectsCorridor: false } } }));
  const ratio = large.components.wetland.value / small.components.wetland.value;
  assert.ok(ratio > 1 && ratio < 4, `the curve must bend well short of linear (ratio ${ratio})`);
  assert.notEqual(ratio, 10, 'ten times the measured area is never ten times the component');
});


test('unknown measurements are never scored as zero, and the shortfall is exposed', () => {
  const blindWetlands = { wetlands: { coverage: 'UNKNOWN', nearestM: null, area250M2: 0, area500M2: 0, area1000M2: 0,
    intersectsCorridor: false } };
  const partial = naturalistInterest(result({ signals: blindWetlands }));
  assert.deepEqual(partial.missing, ['wetland']);
  assert.equal(partial.components.wetland.measured, false);
  assert.equal(partial.components.wetland.value, null);
  assert.equal(partial.evidenceFraction, 0.55, 'the evidence fraction reports what was measured');
  // The omitted component neither helps nor hurts: the mean is taken over what was measured, so a corridor with
  // wetland coverage missing is not pushed down the order as though it had no wetland.
  const weight = RANKING_WEIGHTS.water + RANKING_WEIGHTS.ecologicalVariety;
  const expected = Math.round(10 * 100 * (RANKING_WEIGHTS.water * partial.components.water.value / 100
    + RANKING_WEIGHTS.ecologicalVariety * partial.components.ecologicalVariety.value / 100) / weight) / 10;
  assert.equal(partial.score, expected);
  assert.ok(!partial.explanation.some(line => /no mapped wetland/.test(line)),
    'an unmeasured wetland component asserts nothing about wetland');
});

test('a corridor with no coverage at all has no score rather than a bad one, and orders last', () => {
  const blind = result({ id: 'blind', signals: { wetlands: { coverage: 'UNKNOWN' }, hydrography: { coverage: 'UNKNOWN' } },
    ecology: { coverage: 'UNKNOWN', ecoregionCount: null, transitions: null } });
  const ranking = naturalistInterest(blind);
  assert.equal(ranking.score, null);
  assert.equal(ranking.evidenceFraction, 0);
  assert.deepEqual(ranking.missing, ['wetland', 'water', 'ecologicalVariety']);
  const ordered = rankResults([blind, result({ id: 'seen' })]);
  assert.equal(ordered[0].result.id, 'seen');
  assert.equal(ordered[ordered.length - 1].result.id, 'blind');
});

test('ordering is deterministic under ties, and never depends on input order', () => {
  const a = result({ id: 'b-2', name: 'B Rd' });
  const b = result({ id: 'a-1', name: 'A Rd' });
  const c = result({ id: 'b-1', name: 'B Rd' });
  const forward = rankResults([a, b, c]).map(entry => entry.result.id);
  const backward = rankResults([c, b, a]).map(entry => entry.result.id);
  assert.deepEqual(forward, backward, 'the same set always produces the same order');
  assert.deepEqual(forward, ['a-1', 'b-1', 'b-2'], 'ties break on name, then on the stable corridor id');
});

test('the pathologies the model is built to avoid stay avoided', () => {
  // A wetland giant does not swamp a corridor that has genuinely varied context, and quantity is capped.
  const swamp = naturalistInterest(result({ signals: { wetlands: { coverage: 'FULL', nearestM: 0, area250M2: 5e8,
    area500M2: 5e8, area1000M2: 5e8, intersectsCorridor: true }, hydrography: { coverage: 'FULL', crossingCount: 0 } },
    ecology: { coverage: 'FULL', ecoregionCount: 1, transitions: 0 } }));
  const varied = naturalistInterest(result({ signals: { wetlands: { coverage: 'FULL', nearestM: 30, area250M2: 120_000,
    area500M2: 400_000, area1000M2: 900_000, intersectsCorridor: true },
    hydrography: { coverage: 'FULL', crossingCount: 5, nearestFlowingM: 25, nearestStandingM: 200,
      flowlineLength1000M: 12_000 } }, ecology: { coverage: 'FULL', ecoregionCount: 3, transitions: 2 } }));
  assert.ok(varied.score > swamp.score, 'context in several planes beats sheer wetland quantity');
  // Crossings cap: twenty crossings do not beat five by four times.
  const five = naturalistInterest(result({ signals: { hydrography: { coverage: 'FULL', crossingCount: 5 } } }));
  const twenty = naturalistInterest(result({ signals: { hydrography: { coverage: 'FULL', crossingCount: 20 } } }));
  // Four times the crossings is about 1.4 times the component, never four times: the crossing term is capped.
  const crossingRatio = twenty.components.water.value / five.components.water.value;
  assert.ok(crossingRatio > 1 && crossingRatio < 1.5, `crossings must saturate (ratio ${crossingRatio})`);
  assert.notEqual(crossingRatio, 4, 'twenty crossings are not four times as interesting as five');
  // Length does not enter the score at all.
  const short = naturalistInterest(result({ lengthM: 800 }));
  const long = naturalistInterest(result({ lengthM: 40_000 }));
  assert.equal(short.score, long.score, 'a long corridor gains nothing for being long');
});
