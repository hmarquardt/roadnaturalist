import test from 'node:test';
import assert from 'node:assert/strict';

import { ADVANCED_HEADING, BEST_OVERALL_LABEL, NEAR_TIE_POINTS, RECOMMENDATION_HEADING_AREA,
  RECOMMENDATION_HEADING_CENTERED, RECOMMENDATION_LIMIT, RECOMMENDED_TERM, recommendationHeading,
  recommendationRankText, recommendationSummary, recommendations } from '../src/discovery/recommendation.js';
import { EXPLORATION_ORDER_VERSION } from '../src/discovery/exploration-order.js';
import { naturalistInterest } from '../src/discovery/ranking.js';

// THE ANSWER, BUILT FROM THE MEASUREMENTS AND NOTHING ELSE.
//
// These tests hold the recommendation surface to three claims: that the top five are the top five of the evaluated
// exploration order (no new ranking), that every sentence on a card is produced by a measurement the discovery run already
// made (no fabrication), and that the copy stays honest when the data is thin, absent, or nearly tied.
const RADIUS_M = 40233.6; // 25 miles

// A discovery result with the fields the analysis really produces, overridden per test.
function result(id, name, { distanceM = 2000, lengthM = 11000, wetland = null, water = null, ecology = null,
  coverage = 'FULL', status = 'proposed' } = {}) {
  return { id, name, lengthM, distanceFromCenterM: distanceM, cardinalFromCenter: 'north', status,
    road: { classes: ['S1400'], counties: ['Gibson'], sourceFeatureCount: 3,
      segmentation: { index: 1, count: 1, method: 'contiguous vertices along the composed unit' } },
    ecology: { coverage, ecoregionCount: ecology?.ecoregionCount ?? 1, transitions: ecology?.transitions ?? 0,
      spansMultiple: false, measuredM: 11000, level3: { primary: { name: 'Interior River Valleys', code: '72' } },
      level4: { primary: { name: 'Wabash Lowlands', code: '72a' } } },
    signals: {
      wetlands: { coverage: wetland?.coverage ?? coverage, intersectsCorridor: wetland?.intersectsCorridor ?? false,
        nearestM: wetland?.nearestM ?? null, area250M2: wetland?.area250M2 ?? 0, area500M2: wetland?.area500M2 ?? 0,
        area1000M2: wetland?.area1000M2 ?? 0, featureCount250: 1, featureCount1000: 2, types: [] },
      hydrography: { coverage: water?.coverage ?? coverage, crossingCount: water?.crossingCount ?? 0, crossings: [],
        nearestFlowingM: water?.nearestFlowingM ?? null, nearestStandingM: water?.nearestStandingM ?? null,
        flowlineLength1000M: water?.flowlineLength1000M ?? 0, waterbodyArea1000M: 0, namedWaters: [] },
    },
    coverage: { road: { coverage: 'FULL', reason: null }, wetlands: { coverage: 'FULL', reason: null },
      hydrography: { coverage: 'FULL', reason: null } },
    analysisDistancesM: [250, 500, 1000], provenance: {}, bounds: null, geometry: null };
}

// The measured shapes the evaluation artifact itself recorded, so the fixtures are not invented either.
const WET = { intersectsCorridor: true, nearestM: 0, area250M2: 1272682.9, area500M2: 2836802.8, area1000M2: 6243141.8 };
const DITCHES = { crossingCount: 14, nearestFlowingM: 0, nearestStandingM: 444, flowlineLength1000M: 153841.3 };
const DRY_WET = { intersectsCorridor: false, nearestM: 4200, area250M2: 0, area500M2: 0, area1000M2: 0 };
const DRY_WATER = { crossingCount: 0, nearestFlowingM: null, nearestStandingM: null, flowlineLength1000M: 0 };
const RICH = { ecoregionCount: 3, transitions: 1 };
const PLAIN = { ecoregionCount: 1, transitions: 0 };

test('the top five are the top five of the evaluated exploration order, and nothing is re-ranked', () => {
  const results = Array.from({ length: 9 }, (unused, index) => result(`r${index}`, `Road ${index}`,
    { distanceM: 1500 + index * 3000, wetland: WET, water: DITCHES, ecology: RICH }));
  const top = recommendations(results, { radiusM: RADIUS_M });
  assert.equal(top.length, RECOMMENDATION_LIMIT);
  assert.deepEqual(top.map(entry => entry.summary.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(top.map(entry => entry.result.id), ['r0', 'r1', 'r2', 'r3', 'r4'],
    'the nearest of nine otherwise equal roads leads, because distance is the only difference');
  // THE SCORES ARE THE EXPLORATION ORDER'S OWN, not a second computation of them.
  for (const entry of top) {
    assert.equal(entry.order.version, EXPLORATION_ORDER_VERSION);
    assert.equal(entry.summary.score, entry.order.score);
    assert.equal(entry.summary.interestScore, naturalistInterest(entry.result).score);
  }
  // A LIMIT IS A LIMIT, AND NOTHING IS A LEGITIMATE ANSWER.
  assert.equal(recommendations(results, { radiusM: RADIUS_M, limit: 2 }).length, 2);
  assert.deepEqual([...recommendations(results, { radiusM: RADIUS_M, limit: 0 })], []);
  assert.deepEqual([...recommendations([], { radiusM: RADIUS_M })], []);
  assert.deepEqual([...recommendations(null, { radiusM: RADIUS_M })], []);
});

test('fewer than five results are all shown, in order, with no padding and no apology', () => {
  const results = [result('a', 'First Rd', { wetland: WET, water: DITCHES }),
    result('b', 'Second Rd', { wetland: DRY_WET, water: DRY_WATER })];
  const top = recommendations(results, { radiusM: RADIUS_M });
  assert.equal(top.length, 2);
  assert.equal(top[0].summary.rankText, `#1 ${BEST_OVERALL_LABEL}`);
  assert.equal(top[1].summary.rankText, '#2');
  assert.equal(recommendationRankText(1), '#1 Best overall');
  assert.equal(recommendationRankText(7), '#7');
  assert.equal(recommendationRankText(null), null);
  assert.equal(recommendationRankText(0), null);
});

test('the first card is best overall, and only the first', () => {
  const results = [result('a', 'First Rd', { wetland: WET, water: DITCHES, ecology: RICH }),
    result('b', 'Second Rd', { wetland: DRY_WET, water: DRY_WATER, ecology: PLAIN })];
  const top = recommendations(results, { radiusM: RADIUS_M });
  assert.equal(top[0].summary.best, true);
  assert.equal(top[0].summary.rankText, `#1 ${BEST_OVERALL_LABEL}`);
  assert.equal(top[1].summary.best, false);
  assert.equal(top[1].summary.rankText, '#2');
  assert.ok(top[0].summary.score > top[1].summary.score, 'and it is first because it scores first');
});

test('every sentence is produced by a measurement, and the label follows the components', () => {
  // STRONG WETLAND AND WATER: the label names both, and the reasons carry the numbers behind them.
  const wet = recommendationSummary(result('w', 'Wet Rd', { wetland: WET, water: DITCHES }), { rank: 1, radiusM: RADIUS_M });
  assert.equal(wet.label, 'Wetland and water corridor');
  assert.deepEqual(wet.reasons.map(reason => reason.key), ['wetland', 'water']);
  assert.match(wet.reasons[0].text, /Mapped wetland crosses the road, 127 ha within 250 m/);
  assert.match(wet.reasons[1].text, /14 mapped/);
  // WETLAND ALONE.
  const wetlandOnly = recommendationSummary(result('m', 'Marsh Rd', { wetland: WET, water: DRY_WATER }), { radiusM: RADIUS_M });
  assert.equal(wetlandOnly.label, 'Wetland-rich corridor');
  // WATER ALONE.
  const waterOnly = recommendationSummary(result('r', 'Creek Rd', { wetland: DRY_WET, water: DITCHES }), { radiusM: RADIUS_M });
  assert.equal(waterOnly.label, 'Water and crossings');
  // ECOLOGY ALONE: a road crossing between ecoregions with little mapped water.
  const variety = recommendationSummary(result('e', 'Ridge Rd',
    { wetland: DRY_WET, water: DRY_WATER, ecology: { ecoregionCount: 4, transitions: 2 } }), { radiusM: RADIUS_M });
  assert.equal(variety.label, 'Habitat transition zone');
  assert.deepEqual(variety.reasons.map(reason => reason.key), ['ecologicalVariety']);
  assert.match(variety.reasons[0].text, /Crosses 4 mapped ecoregions with 2 transitions/);
  // AND THE LABEL CAN NEVER DISAGREE WITH THE NUMBER THE DETAIL PANEL SHOWS.
  for (const summary of [wet, wetlandOnly, waterOnly, variety]) {
    const { wetland, water, ecologicalVariety } = summary.components;
    if (summary.label === 'Wetland and water corridor') assert.ok(wetland >= 60 && water >= 60);
    if (summary.label === 'Wetland-rich corridor') assert.ok(wetland >= 60);
    if (summary.label === 'Water and crossings') assert.ok(water >= 60);
    if (summary.label === 'Habitat transition zone') assert.ok(ecologicalVariety >= 60);
  }
});

test('a component that was not measured produces no claim about it, and a thin card says less', () => {
  // NOTHING MEASURED AT ALL: no habitat sentence is invented, and the card says so once.
  const unknown = recommendationSummary(result('u', 'Unmeasured Rd', { coverage: 'UNKNOWN', wetland: null, water: null }),
    { radiusM: RADIUS_M });
  assert.equal(unknown.label, 'Context not measured here');
  assert.deepEqual([...unknown.reasons], []);
  assert.deepEqual([...unknown.missing], ['wetland', 'water', 'ecologicalVariety']);
  assert.match(unknown.caution, /Not measured here: mapped wetland, mapped water and ecological variety/);
  // ONE MEASURED COMPONENT IS ONE REASON, and the card does not pad itself to three. A dataset that was not measured at
  // all produces no claim and no reason, and the card says which signal it is missing.
  const oneReason = recommendationSummary(result('o', 'One Rd', { wetland: WET, water: { coverage: 'UNKNOWN' } }),
    { radiusM: RADIUS_M });
  assert.equal(oneReason.reasons.length, 1);
  assert.equal(oneReason.reasons[0].key, 'wetland');
  assert.deepEqual([...oneReason.missing], ['water']);
  assert.match(oneReason.caution, /Not measured here: mapped water/);
  // MEASURED AND EMPTY IS NOT THE SAME AS UNMEASURED: a dry road is described with what was measured, and nothing about
  // wetland is claimed to be absent from the landscape.
  const dry = recommendationSummary(result('d', 'Dry Rd', { wetland: DRY_WET, water: DRY_WATER, ecology: PLAIN }),
    { radiusM: RADIUS_M });
  assert.equal(dry.label, 'Limited mapped context');
  assert.deepEqual(dry.reasons.map(reason => reason.key), ['wetland', 'water']);
  assert.match(dry.reasons[0].text, /Nearest mapped wetland 4200 m away/);
  assert.match(dry.reasons[1].text, /No mapped crossing or nearby water/);
  assert.equal(dry.caution, null, 'a fully measured road needs no coverage caution');
  assert.ok(dry.reasons.every(reason => !/wildlife|bird|scenic|guaranteed|best/i.test(reason.text)),
    'and no sentence claims anything the data does not contain');
});

test('a search with no centre has no distance, so no distance is shown or implied', () => {
  const results = [result('a', 'First Rd', { distanceM: null, wetland: WET, water: DITCHES }),
    result('b', 'Second Rd', { distanceM: null, wetland: WET, water: DRY_WATER })];
  const top = recommendations(results, { radiusM: null });
  assert.equal(top.length, 2);
  for (const entry of top) {
    assert.equal(entry.summary.distanceText, null, 'no distance from a centre that does not exist');
    assert.equal(entry.order.distanceFraction, null);
    assert.equal(entry.order.penalty, 0, 'and no penalty is applied');
  }
  // The order is then the interest score itself, which is the documented centreless fallback.
  assert.deepEqual(top.map(entry => entry.result.id), ['a', 'b']);
  assert.equal(top[0].summary.lengthText, '6.8 mi of road', 'the corridor length is still a fact about the road');
  // AND THE HEADING CHANGES WITH THE SEARCH: only a centred search can be said to be near something.
  assert.equal(recommendationHeading({ hasCenter: true }), RECOMMENDATION_HEADING_CENTERED);
  assert.equal(recommendationHeading({ hasCenter: false }), RECOMMENDATION_HEADING_AREA);
  assert.equal(recommendationHeading({}), RECOMMENDATION_HEADING_AREA);
  assert.equal(RECOMMENDATION_HEADING_CENTERED, 'Best road-naturalist drives near this search');
  assert.equal(RECOMMENDATION_HEADING_AREA, 'Top roads in this search area');
});


test('a near tie is said in words, and a clear gap is not dressed up as one', () => {
  // TWO ROADS THAT DIFFER BY A FRACTION OF A POINT: the order still decides, and the copy says the difference is small.
  const tied = [result('a', 'First Rd', { distanceM: 2000, wetland: WET, water: DITCHES, ecology: RICH }),
    result('b', 'Second Rd', { distanceM: 2100, wetland: WET, water: DITCHES, ecology: RICH })];
  const close = recommendations(tied, { radiusM: RADIUS_M });
  const gap = Math.abs(close[0].summary.score - close[1].summary.score);
  assert.ok(gap < NEAR_TIE_POINTS, `the fixture is a near tie (gap ${gap})`);
  assert.match(close[0].summary.note, /Close call: the next road is near-equal on the same measurements/);
  assert.match(close[1].summary.note, /Another strong option: near-equal to #1 on the same measurements/);
  assert.equal(close[0].summary.label, close[1].summary.label, 'and both are described by the same evidence');
  // A CLEAR GAP IS NOT A NEAR TIE: no note is invented to soften a real difference.
  const apart = [result('a', 'First Rd', { distanceM: 2000, wetland: WET, water: DITCHES, ecology: RICH }),
    result('b', 'Second Rd', { distanceM: 22000, wetland: DRY_WET, water: DRY_WATER, ecology: PLAIN })];
  const wide = recommendations(apart, { radiusM: RADIUS_M });
  assert.ok(Math.abs(wide[0].summary.score - wide[1].summary.score) >= NEAR_TIE_POINTS);
  assert.equal(wide[0].summary.note, null);
  assert.equal(wide[1].summary.note, null);
  // AND A DECIMAL SCORE IS NEVER THE HEADLINE: the card carries the rank, the label and the reasons, and the score only
  // travels as a data attribute a reader can check.
  assert.match(wide[0].summary.rankText, /^#1 /);
  assert.equal(typeof wide[0].summary.score, 'number');
});

test('the same results always produce the same cards, in the same order', () => {
  const build = () => [result('c', 'Third Rd', { distanceM: 8000, wetland: WET, water: DITCHES, ecology: RICH }),
    result('a', 'First Rd', { distanceM: 2000, wetland: WET, water: DITCHES, ecology: RICH }),
    result('b', 'Second Rd', { distanceM: 5000, wetland: DRY_WET, water: DRY_WATER, ecology: PLAIN })];
  const first = JSON.stringify(recommendations(build(), { radiusM: RADIUS_M }));
  const second = JSON.stringify(recommendations(build().reverse(), { radiusM: RADIUS_M }));
  assert.equal(first, second, 'input order does not change the answer');
  // AND THE SAME RESULT GIVES THE SAME CARD WHEN IT IS ASKED FOR ON ITS OWN - the same label, the same reasons and the
  // same numbers. (The near-tie sentence is the one part that depends on the road's neighbours, so it is compared there.)
  const alone = recommendationSummary(build()[1], { rank: 1, radiusM: RADIUS_M });
  const inList = recommendations(build(), { radiusM: RADIUS_M })[0].summary;
  for (const key of ['rank', 'best', 'rankText', 'label', 'distanceText', 'lengthText', 'score', 'interestScore',
    'components']) {
    assert.deepEqual({ [key]: alone[key] }, { [key]: inList[key] }, `one road, one ${key}, however it was reached`);
  }
  assert.deepEqual(alone.reasons.map(reason => reason.text), inList.reasons.map(reason => reason.text));
});

test('the words a person sees never use the machinery\'s vocabulary, and the boundary keeps the workbench', () => {
  assert.equal(RECOMMENDED_TERM, 'Recommended');
  assert.equal(ADVANCED_HEADING, 'Explore all results');
  const summary = recommendationSummary(result('a', 'First Rd', { wetland: WET, water: DITCHES }), { radiusM: RADIUS_M });
  const words = [summary.label, ...summary.reasons.map(reason => reason.text), summary.distanceText, summary.lengthText,
    summary.note, summary.caution].filter(Boolean).join(' ');
  for (const term of ['exploration order', 'exploration-order', 'naturalist-interest', 'score', 'heuristic']) {
    assert.equal(words.toLowerCase().includes(term), false, `a card never says "${term}"`);
  }
});

// THE SELECTION A CARD MAKES IS THE SELECTION THE TABLE AND THE MAP MAKE.
//
// A recommendation is a view of the discovery results, so it must not carry selection state of its own: the card, the
// table row and a click on the map all go through `selectDiscovery`, and the panel renders from that one value.
test('a card selects the corridor through the one discovery selection, and nothing else selects', async () => {
  const { createStore } = await import('../src/state/store.js');
  const store = createStore({ storage: null });
  const rows = [result('a', 'First Rd', { wetland: WET, water: DITCHES }),
    result('b', 'Second Rd', { wetland: DRY_WET, water: DRY_WATER })];
  store.finishDiscovery({ results: rows, coverage: null, diagnostics: null, eligibility: [],
    raw: { corridors: rows.map(row => ({ corridor: { id: row.id } })) },
    searchArea: { id: 'custom', center: [-87.5675, 38.3553], radiusMiles: 25 }, marks: {} });
  const cards = recommendations(rows, { radiusM: RADIUS_M });
  const chosen = cards[1].result.id;
  store.selectDiscovery(chosen);
  assert.equal(store.getState().discovery.selectedId, chosen, 'the card wrote the one discovery selection');
  // AND IT IS THE SAME STATE THE TABLE RENDERS FROM: there is no second selection for it to disagree with.
  assert.equal(store.getState().discovery.selectedId, chosen);
  assert.throws(() => store.selectDiscovery('not-a-corridor'), /Unknown discovery corridor/,
    'and a card cannot select a corridor the search never produced');
});
