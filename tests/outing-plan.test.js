import test from 'node:test';
import assert from 'node:assert/strict';

import { OUTING_PLAN_NOTE, OUTING_SEPARATION_LABEL, geometryMidpoint, outingMapRoads, outingPlan,
  representativePoint, savedRoadsById, separationLine, straightLineM } from '../src/state/outing-plan.js';
import { storedPlanningContext } from '../src/state/planning-context.js';
import { createOuting, moveRoad, withRoad } from '../src/state/outings.js';
import { createStore } from '../src/state/store.js';
import { CANDIDATES_KEY, restoreCandidateRecord, writeStoredCandidates } from '../src/state/candidate-persistence.js';
import { COVERAGE } from '../src/domain/corridor.js';
import { buildDiscoveryResult } from '../src/discovery/signals.js';
import { buildDiscoveryUnits } from '../src/discovery/units.js';
import { segmentUnit } from '../src/discovery/segment.js';
import { promoteDiscoveryResult } from '../src/discovery/lifecycle.js';
import { naturalistInterest } from '../src/discovery/ranking.js';
import { corridorContextFromCenter, pendingSearchContext, CENTER_LABEL_KIND } from '../src/discovery/search-context.js';

// AN OUTING READ AS A PLAN.
//
// The plan module measures nothing of its own: it reads what a saved road already recorded and states the straight-line
// gap between two consecutive roads. These tests hold that line - the representative point rule, the arithmetic, what the
// summary may and may not claim, what happens to a road that is no longer saved, and the wording no distance may use.
const LON_PER_M = 1 / (111320 * Math.cos(45.5 * Math.PI / 180));
const CENTER = [-122.9, 45.55];

function fakeStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return { entries, getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: key => { entries.delete(key); } };
}

// One promoted corridor, with measured signals rich enough for all three ranking components.
function promotedRoad({ id = 'drv1-kept-rd-s1', lat = 45.58, center = CENTER, radiusMiles = 25, crossings = 2,
  transitions = 1, intersectsCorridor = true, area250M2 = 60_000, coverage = COVERAGE.FULL, at = null } = {}) {
  const feature = { roadId: `tiger-2025-or-41067-${id}`, name: `NW ${id}`, roadClass: 'S1400', routeType: 'M',
    countyFips: '41067', countyName: 'Washington County, Oregon', sourceFeatureId: `f-${id}`,
    geometry: { type: 'LineString', coordinates: Array.from({ length: 9 }, (_, index) =>
      [-122.93 + 3000 * index / 8 * LON_PER_M, lat]) } };
  const unit = buildDiscoveryUnits([feature]).units[0];
  const corridor = segmentUnit(unit).corridors[0];
  const measured = corridorContextFromCenter(center, corridor.geometry);
  const result = buildDiscoveryResult({ unit, corridor,
    metrics: { wetlands: { coverage, reason: null, intersectsCorridor, nearestDistanceM: 40, perDistance: {},
      coverageByDistance: {}, buffers: { 250: { areaM2: area250M2, lengthM: 900, featureCount: 1, breakdown: [] },
        500: { areaM2: area250M2 * 2, lengthM: 1200, featureCount: 1, breakdown: [] },
        1000: { areaM2: area250M2 * 3, lengthM: 1500, featureCount: 1, breakdown: [] } }, classes: [] },
      hydrography: { coverage, reason: null, crossingCount: crossings, crossings: [],
        nearestFlowingWaterM: 120, nearestStandingWaterM: 300, perDistance: {}, coverageByDistance: {},
        buffers: { 1000: { areaM2: 0, lengthM: 4000, featureCount: 2, breakdown: [] } }, names: [] },
      ecology: { coverage, levels: {}, ecoregionCount: 2, transitions } },
    roadState: coverage, provenance: { datasetId: 'regional-roads' }, analysisDistancesM: [250, 500, 1000],
    fromCenter: measured });
  const searchContext = pendingSearchContext({ center, radiusMiles, centerLabel: 'Near Vernonia, OR',
    centerLabelKind: CENTER_LABEL_KIND.NEAR_PLACE, distanceFromCenterM: measured.distanceM,
    nearestCenterPoint: measured.nearestPoint, bearingFromCenterDeg: measured.bearingDeg, cardinalFromCenter: measured.cardinal });
  return promoteDiscoveryResult({ ...result, id }, { features: [feature], corridor, searchContext,
    provenance: { agency: 'U.S. Census Bureau' }, dataCatalogUrl: 'regional/manifest.json', at });
}

function planOf(outing, roads) {
  return outingPlan({ outing, savedRoads: savedRoadsById({ candidates: roads,
    durableCandidateIds: roads.map(road => road.id), userMetaById: {} }) });
}

test('a saved road keeps the measurements its own score was computed from', () => {
  const road = promotedRoad({ at: '2026-09-28T10:00:00.000Z' });
  const kept = road.planningContext;
  assert.ok(kept, 'the promotion keeps a snapshot of the measured context');
  assert.equal(kept.rankingVersion, 'naturalist-interest-v2');
  assert.equal(kept.recordedAt, '2026-09-28T10:00:00.000Z');
  // THE KEPT NUMBERS ARE THE ONES THE SCORE CAME FROM: recomputing from the snapshot gives the same score the search
  // result did, which is the only reason to keep them.
  const fromSnapshot = naturalistInterest(kept);
  assert.ok(Number.isFinite(fromSnapshot.score));
  assert.equal(fromSnapshot.score, naturalistInterest({ signals: kept.signals, ecology: kept.ecology }).score);
  assert.deepEqual(kept.signals.wetlands, { coverage: COVERAGE.FULL, intersectsCorridor: true, nearestM: 40,
    area250M2: 60_000, area500M2: 120_000, area1000M2: 180_000 });
  assert.equal(kept.signals.hydrography.crossingCount, 2);
  assert.equal(kept.ecology.transitions, 1);
  // Only numbers are kept: no geometry, no dataset, no archive.
  const serialized = JSON.stringify(kept);
  assert.ok(!serialized.includes('coordinates'), 'no geometry is kept with the measurements');
  assert.ok(serialized.length < 900, `the snapshot stays small (was ${serialized.length} bytes)`);
});

test('a snapshot that cannot be trusted is dropped rather than believed', () => {
  assert.equal(storedPlanningContext(null), null);
  assert.equal(storedPlanningContext('nonsense'), null);
  assert.equal(storedPlanningContext({ signals: {} }), null, 'no measured context at all is not a snapshot');
  const handEdited = storedPlanningContext({ signals: { wetlands: { coverage: 'ABSOLUTE', area250M2: 'lots' },
    hydrography: { coverage: COVERAGE.PARTIAL, crossingCount: 3 } }, ecology: { coverage: COVERAGE.FULL,
    ecoregionCount: 2, transitions: 1 }, injected: { x: 1 } });
  assert.equal(handEdited.signals.wetlands.coverage, COVERAGE.UNKNOWN, 'an unknown coverage value is not a claim');
  assert.equal(handEdited.signals.wetlands.area250M2, 0);
  assert.equal(handEdited.signals.hydrography.crossingCount, 3);
  assert.equal(handEdited.injected, undefined, 'a hand-added key is dropped');
});

test('a saved road and its measurements survive a reload together', () => {
  const road = promotedRoad({ at: '2026-09-28T10:00:00.000Z' });
  const storage = fakeStorage();
  const written = writeStoredCandidates([road], { storage });
  assert.equal(written.ok, true);
  const raw = JSON.parse(storage.getItem(CANDIDATES_KEY));
  assert.equal(raw.candidates[0].planningContext.signals.hydrography.crossingCount, 2, 'the snapshot is written');
  // A HAND-EDITED SNAPSHOT IS REBUILT THROUGH THE VALIDATOR, and a record whose snapshot is unusable still restores as a
  // candidate: losing the numbers must never cost the road.
  const tampered = JSON.parse(storage.getItem(CANDIDATES_KEY));
  tampered.candidates[0].planningContext = { signals: { wetlands: { coverage: 'FULL', area250M2: 1 } } };
  const record = restoreCandidateRecord(tampered.candidates[0]);
  assert.equal(record.ok, true, 'the road is still a road');
  assert.equal(record.candidate.planningContext.signals.wetlands.area250M2, 1);
  const broken = restoreCandidateRecord({ ...tampered.candidates[0], planningContext: { signals: 'nope' } });
  assert.equal(broken.ok, true);
  assert.equal(broken.candidate.planningContext, null, 'an unreadable snapshot is absent, not invented');
});

test('the representative point is a measured point when there is one, and the middle of the road otherwise', () => {
  const geometry = { type: 'LineString', coordinates: [[-122.93, 45.58], [-122.90, 45.58]] };
  const measured = representativePoint(geometry, { nearestCenterPoint: [-122.915, 45.58] });
  assert.deepEqual(measured, [-122.915, 45.58], 'the point the promotion measured is used as it stands');
  const middle = representativePoint(geometry, null);
  assert.ok(Math.abs(middle[0] - -122.915) < 0.0005, 'with no measured point, the middle of the road is used');
  assert.ok(Math.abs(middle[1] - 45.58) < 1e-9, 'and it lies on the road');
  assert.deepEqual(representativePoint(geometry, null), middle, 'and the rule is deterministic');
  assert.deepEqual(geometryMidpoint(geometry), middle);
  // No geometry, no point: a plan says so rather than measuring from a guess.
  assert.equal(representativePoint({ type: 'LineString', coordinates: [] }, null), null);
  assert.equal(representativePoint(null, null), null);
  assert.equal(straightLineM(null, [0, 0]), null);
  assert.equal(straightLineM([0, 0], [0.1, 'x']), null);
});



test('the plan measures the gap between consecutive roads as a straight line, in the person’s order', () => {
  const roads = [promotedRoad({ id: 'road-a', lat: 45.50 }), promotedRoad({ id: 'road-b', lat: 45.60 }),
    promotedRoad({ id: 'road-c', lat: 45.75 })];
  let outing = createOuting({ title: 'Loop', roadIds: ['road-a', 'road-b', 'road-c'] });
  const plan = planOf(outing, roads);
  assert.equal(plan.members.length, 3);
  assert.deepEqual(plan.members.map(member => member.stop), [1, 2, 3]);
  assert.equal(plan.legs.length, 2, 'three roads have two gaps between them');
  assert.deepEqual(plan.legs.map(leg => [leg.fromId, leg.toId]), [['road-a', 'road-b'], ['road-b', 'road-c']]);
  // A degree of latitude is about 69 miles: the numbers are the geometry's, not an invented route's.
  assert.ok(Math.abs(plan.legs[0].miles - 6.9) < 0.4, `expected ~6.9 mi, got ${plan.legs[0].miles}`);
  assert.ok(plan.legs[1].miles > plan.legs[0].miles, 'the second gap is the longer one');
  // REORDERING RE-MEASURES THE GAPS, because the gaps belong to the person's order rather than to the roads.
  outing = moveRoad(outing, 'road-c', 'up');
  const moved = planOf(outing, roads);
  assert.deepEqual(moved.legs.map(leg => [leg.fromId, leg.toId]), [['road-a', 'road-c'], ['road-c', 'road-b']]);
  assert.ok(moved.legs[0].miles > plan.legs[0].miles);
});

test('the summary counts only what the roads themselves measured, and computes no score', () => {
  const roads = [promotedRoad({ id: 'road-a', lat: 45.50, crossings: 4, transitions: 1, area250M2: 80_000 }),
    promotedRoad({ id: 'road-b', lat: 45.62, crossings: 0, transitions: 0, area250M2: 40_000,
      intersectsCorridor: false })];
  const plan = planOf(createOuting({ title: 'Loop', roadIds: ['road-a', 'road-b'] }), roads);
  const summary = plan.summary;
  assert.equal(summary.roads, 2);
  assert.equal(summary.resolved, 2);
  assert.equal(summary.unresolved, 0);
  assert.equal(summary.scored, 2);
  assert.equal(summary.waterCrossings, 4, 'crossings are summed because they are counts of the same thing');
  assert.equal(summary.intersectsMappedWetland, 1);
  assert.equal(summary.transitionCorridors, 1);
  assert.equal(summary.interestMin, Math.min(...plan.members.map(member => member.naturalistInterest)));
  assert.ok(summary.interestMin <= summary.interestMax);
  assert.ok(summary.spanMiles > 7 && summary.spanMiles < 9, `the span is the plan's own extent (got ${summary.spanMiles})`);
  assert.equal(summary.vertices, 18);
  // NO COMPOSITE: there is no field that scores the plan as a whole, and nothing that ranks one plan above another.
  for (const forbidden of ['score', 'outingScore', 'rating', 'quality', 'better', 'rank']) {
    assert.ok(!Object.keys(summary).includes(forbidden), `a summary must not carry ${forbidden}`);
  }
});

test('a road that is no longer saved stays in the plan, is not measured, and is not invented', () => {
  const roads = [promotedRoad({ id: 'road-a' })];
  const outing = createOuting({ title: 'Loop', roadIds: ['road-a', 'road-gone'] });
  const plan = planOf(outing, roads);
  assert.equal(plan.members.length, 2, 'the reference is kept rather than silently dropped');
  const missing = plan.members[1];
  assert.equal(missing.roadId, 'road-gone');
  assert.equal(missing.stop, 2, 'and it keeps its place in the order');
  assert.equal(missing.resolved, false);
  assert.equal(missing.naturalistInterest, null);
  assert.ok(missing.unavailableReason, 'and the workspace can say why');
  assert.equal(plan.summary.unresolved, 1);
  assert.equal(plan.summary.resolved, 1);
  // The gap that cannot be measured is reported as unavailable rather than as zero.
  assert.equal(plan.legs[0].metres, null);
  assert.equal(plan.legs[0].miles, null);
  assert.match(separationLine(plan.legs[0], { toName: 'A road that is no longer saved' }), /not available here/);
  // AND IT IS NOT DRAWN: the map gets the roads it can resolve and nothing else.
  assert.deepEqual(outingMapRoads(plan).map(road => road.id), ['road-a']);
  assert.equal(outingMapRoads(plan)[0].stop, 1);
  assert.equal(outingMapRoads(plan)[0].of, 2, 'the stop is stated against the plan it belongs to');

test('a plan assembled from two searches keeps each road’s own centre and order', () => {
  const first = promotedRoad({ id: 'road-a', lat: 45.50, center: [-122.90, 45.55], radiusMiles: 25 });
  const far = promotedRoad({ id: 'road-b', lat: 38.28, center: [-87.51, 38.29], radiusMiles: 8 });
  const plan = planOf(createOuting({ title: 'Two searches', roadIds: ['road-a', 'road-b'] }), [first, far]);
  const [a, b] = plan.members;
  assert.equal(a.explorationRadiusMiles, 25);
  assert.equal(b.explorationRadiusMiles, 8, 'each road is read against the search that found it, not the last one run');
  assert.equal(a.explorationBasis, 'with-search-centre');
  assert.equal(b.explorationBasis, 'with-search-centre');
  assert.notDeepEqual(a.searchContext.center, b.searchContext.center);
  // The order is the distance-aware one within each road's own search, so each road's penalty is its own.
  assert.ok(a.explorationScore <= a.naturalistInterest && b.explorationScore <= b.naturalistInterest);
  // THE PLAN SPANS BOTH: the gap between the two is a real straight-line number, and it is not a drive.
  assert.ok(plan.legs[0].miles > 400, `expected a long separation, got ${plan.legs[0].miles}`);
});

test('a road with no centre scores on interest alone, and says so', () => {
  const road = promotedRoad({ id: 'road-a' });
  const plan = planOf(createOuting({ title: 'No centre', roadIds: ['road-a'] }), [{ ...road, searchContext: null }]);
  const member = plan.members[0];
  assert.equal(member.explorationBasis, 'interest-only');
  assert.equal(member.explorationScore, member.naturalistInterest, 'the interest score stands alone');
  assert.equal(member.distanceFromSearchCentreM, null);
  // A saved road promoted before this build kept no snapshot: its interest is reported as not recorded, not as zero.
  const legacyPlan = planOf(createOuting({ title: 'Legacy', roadIds: ['road-a'] }), [{ ...road, planningContext: null }]);
  assert.equal(legacyPlan.members[0].naturalistInterest, null);
  assert.equal(legacyPlan.summary.scored, 0);
  assert.equal(legacyPlan.members[0].resolved, true, 'the road is still resolved; only its score was never kept');
});

test('the same road cannot enter one outing twice', () => {
  const outing = createOuting({ title: 'Loop', roadIds: ['road-a'] });
  const again = withRoad(outing, 'road-a');
  assert.equal(again.changed, false);
  assert.match(again.reason, /already in this outing/);
  assert.deepEqual([...again.outing.roadIds], ['road-a']);
  const added = withRoad(outing, 'road-b');
  assert.equal(added.changed, true);
  assert.deepEqual([...added.outing.roadIds], ['road-a', 'road-b']);
  assert.equal(planOf(added.outing, [promotedRoad({ id: 'road-a' }), promotedRoad({ id: 'road-b' })]).members.length, 2);
});

test('a distance between two roads is called a straight line, and never a drive', () => {
  // THE SENTENCE THAT CARRIES THE NUMBER names it: it is a straight line between two roads, and it says so every time.
  const line = separationLine({ miles: 7.44 }, { toName: 'NW Kept Rd' });
  assert.equal(line, '≈ 7.4 mi straight-line planning distance to NW Kept Rd.');
  for (const text of [line, separationLine({ miles: 0.4 }, { toName: 'the next road' })]) {
    assert.match(text, /straight-line planning distance/);
    assert.ok(!/drive|driving|travel|route/i.test(text), `a distance is never worded as a drive: ${text}`);
  }
  // THE STANDING NOTE names what the number is not, in the person's own words.
  assert.match(OUTING_SEPARATION_LABEL, /^Straight-line planning distance/);
  assert.match(OUTING_SEPARATION_LABEL, /not a driving distance, a travel time, or a route/);
  assert.match(OUTING_PLAN_NOTE, /approximate geographic separation/);
  assert.match(OUTING_PLAN_NOTE, /has not calculated a drive/);
  assert.match(OUTING_PLAN_NOTE, /does not know whether these roads connect/);
});

test('the plan is read through the same store an outing is written to', () => {
  const store = createStore({ storage: fakeStorage() });
  const road = promotedRoad({ id: 'road-a' });
  store.promoteDiscoveryCandidate(road, 'road-a');
  const created = store.createOutingFromRoads(['road-a'], { title: 'Saturday Creek Loop' });
  assert.equal(created.ok, true);
  const state = store.getState();
  const plan = outingPlan({ outing: state.outings[0], savedRoads: savedRoadsById(state) });
  assert.equal(plan.title, 'Saturday Creek Loop');
  assert.equal(plan.members.length, 1);
  assert.equal(plan.members[0].naturalistInterest, naturalistInterest(road.planningContext).score,
    'the workspace reads the same score the search produced');
  assert.equal(plan.summary.roads, 1);
  assert.equal(plan.legs.length, 0, 'a plan of one road has no separation to state');
});

});
