import test from 'node:test';
import assert from 'node:assert/strict';

import { FIELD_MODE_NOTE, currentFieldRoadId, fieldFacts, fieldView } from '../src/state/outing-field.js';
import { createOuting, markRoadVisited, roadProgress, updateOuting } from '../src/state/outings.js';
import { outingPlan, savedRoadsById } from '../src/state/outing-plan.js';
import { navigationLinks } from '../src/state/outing-navigation.js';
import { createStore } from '../src/state/store.js';
import { COVERAGE } from '../src/domain/corridor.js';
import { buildDiscoveryResult } from '../src/discovery/signals.js';
import { buildDiscoveryUnits } from '../src/discovery/units.js';
import { segmentUnit } from '../src/discovery/segment.js';
import { promoteDiscoveryResult } from '../src/discovery/lifecycle.js';

// THE FIELD VIEW OF A PLAN, WITHOUT A PHONE.
//
// The rules a person drives by: which road is current, what Previous and Next walk, what progress means, what the
// current road measured, and what an unresolvable road does to all of it. None of it tracks anything.
const member = (roadId, overrides = {}) => ({ roadId, stop: 1, resolved: true, name: `Road ${roadId}`, geometry: null,
  representative: [-122.9, 45.55], representativeRule: 'measured-search-context', lengthM: 4828,
  naturalistInterest: 84, interestVersion: 'naturalist-interest-v2', exploration: null, explorationScore: 84,
  explorationBasis: 'interest-only', explorationRadiusMiles: null, distanceFromSearchCentreM: 1931, searchContext: null,
  favorite: false, note: '', intersectsWetland: true, wetlandArea250M2: 120_000, crossingCount: 4,
  ecoregionCount: 2, ecoregionTransitions: 1, recordedAt: '2026-10-14T15:00:00.000Z', unavailableReason: null,
  ...overrides });

const planFor = (ids, { overrides = {} } = {}) => ({
  id: 'outing-1', title: 'Loop',
  members: ids.map((id, index) => member(id, { stop: index + 1, ...(overrides[id] ?? {}) })),
  legs: ids.slice(0, -1).map((id, index) => ({ fromId: id, toId: ids[index + 1], metres: 4828, miles: 3 })),
  summary: {},
});

test('the current road is the one chosen, else the first unvisited, else the first', () => {
  const fresh = createOuting({ title: 'Loop', roadIds: ['a', 'b', 'c'] });
  assert.equal(currentFieldRoadId({ outing: fresh, roadIds: ['a', 'b', 'c'] }), 'a',
    'nothing visited yet: the first road is where the person stands');
  // AN EXPLICIT CHOICE WINS while it is still a road of this plan.
  assert.equal(currentFieldRoadId({ outing: fresh, roadIds: ['a', 'b', 'c'], selectedId: 'c' }), 'c');
  assert.equal(currentFieldRoadId({ outing: fresh, roadIds: ['a', 'b', 'c'], selectedId: 'gone' }), 'a',
    'a road that is not in this plan is not a place to stand');
  // OTHERWISE THE FIRST ROAD NOT YET VISITED.
  const visitedA = updateOuting(fresh, { roadState: markRoadVisited(fresh.roadState, 'a') });
  assert.equal(currentFieldRoadId({ outing: visitedA, roadIds: ['a', 'b', 'c'] }), 'b');
  const visitedAb = updateOuting(visitedA, { roadState: markRoadVisited(visitedA.roadState, 'b') });
  assert.equal(currentFieldRoadId({ outing: visitedAb, roadIds: ['a', 'b', 'c'] }), 'c');
  // AND WHEN EVERY ROAD IS VISITED, THE FIRST: the plan is finished, and the view does not invent a next step.
  const all = updateOuting(visitedAb, { roadState: markRoadVisited(visitedAb.roadState, 'c') });
  assert.equal(currentFieldRoadId({ outing: all, roadIds: ['a', 'b', 'c'] }), 'a');
  // An empty plan has no current road at all.
  assert.equal(currentFieldRoadId({ outing: createOuting({ title: 'Empty' }), roadIds: [] }), null);
  const empty = fieldView({ outing: createOuting({ title: 'Empty' }), plan: { members: [], legs: [], title: 'Empty' } });
  assert.equal(empty.current, null);
  assert.equal(empty.previousId, null);
  assert.equal(empty.nextId, null);
  assert.equal(empty.legToNext, null);
});

test('the field view walks the person’s order, and stops at its ends', () => {
  const outing = createOuting({ title: 'Loop', roadIds: ['a', 'b', 'c'] });
  const plan = planFor(['a', 'b', 'c']);
  const first = fieldView({ outing, plan });
  assert.equal(first.currentId, 'a');
  assert.equal(first.index, 0);
  assert.equal(first.previousId, null, 'there is nothing before the first road');
  assert.equal(first.nextId, 'b');
  const middle = fieldView({ outing, plan, selectedId: 'b' });
  assert.equal(middle.previousId, 'a');
  assert.equal(middle.nextId, 'c');
  const last = fieldView({ outing, plan, selectedId: 'c' });
  assert.equal(last.previousId, 'b');
  assert.equal(last.nextId, null, 'and nothing after the last');
  assert.equal(last.index, 2);
  // Every road keeps its place and its state, in the person's order.
  assert.deepEqual(first.roads.map(road => [road.roadId, road.stop, road.visited]),
    [['a', 1, false], ['b', 2, false], ['c', 3, false]]);
  // THE GAP TO THE NEXT ROAD is the plan's own straight-line separation, in the plan's own words.
  assert.equal(first.legToNext.toId, 'b');
  assert.match(first.legToNext.text, /straight-line planning distance to Road b/);
  assert.equal(last.legToNext, null, 'the last road has no next road to be separated from');
});

test('progress counts the roads the person marked, out of the roads the plan holds', () => {
  const base = createOuting({ title: 'Loop', roadIds: ['a', 'b', 'c', 'd'] });
  const outing = updateOuting(base, { roadState: markRoadVisited(markRoadVisited(base.roadState, 'a'), 'c') });
  const view = fieldView({ outing, plan: planFor(['a', 'b', 'c', 'd']) });
  assert.deepEqual(view.progress, { total: 4, visited: 2, remaining: 2, percent: 50 });
  assert.deepEqual(view.roads.map(road => road.visited), [true, false, true, false]);
  assert.equal(view.currentId, 'b', 'and the current road is the first one not visited');
  // Nothing about the view is a distance covered, a time or an arrival.
  for (const key of Object.keys(view.progress)) {
    assert.ok(['total', 'visited', 'remaining', 'percent'].includes(key), `no invented progress field: ${key}`);
  }
  assert.equal(FIELD_MODE_NOTE, 'Field mode helps you work through the roads you saved for this outing.');
});

test('an unresolvable road keeps its place, its state and its neighbours', () => {
  const base = createOuting({ title: 'Loop', roadIds: ['a', 'gone', 'c'] });
  const plan = planFor(['a', 'gone', 'c'], { overrides: { gone: { resolved: false, name: null,
    geometry: null, representative: null, representativeRule: null, naturalistInterest: null,
    unavailableReason: 'This road is not saved on this device any more.' } } });
  const view = fieldView({ outing: base, plan, selectedId: 'gone' });
  assert.equal(view.currentId, 'gone', 'the person can stand on a road the workspace cannot describe');
  assert.equal(view.current.resolved, false);
  assert.deepEqual(fieldFacts(view.current), [], 'and no fact is invented for it');
  assert.deepEqual(navigationLinks(view.current), [], 'and there is nowhere to navigate to');
  // Previous and Next walk straight past it, in both directions.
  assert.equal(view.previousId, 'a');
  assert.equal(view.nextId, 'c');
  assert.equal(view.roads.length, 3, 'it is still one of the plan’s roads');
  assert.equal(view.progress.total, 3, 'and it counts towards the plan’s progress');
  // It can still be marked visited, because the person may have been there.
  const marked = updateOuting(base, { roadState: markRoadVisited(base.roadState, 'gone') });
  assert.equal(roadProgress(marked).visited, 1);
  assert.equal(fieldView({ outing: marked, plan, selectedId: 'gone' }).roads[1].visited, true);
});

test('the field facts are the stored measurements, and an unrecorded one says so', () => {
  const full = fieldFacts(member('a'));
  assert.deepEqual(full.map(fact => [fact.key, fact.value]), [['interest', '84'], ['wetland', '12.0 ha'],
    ['crossings', '4'], ['ecoregions', '2 ecoregions / 1 transition'], ['length', '3.0 mi']]);
  // A road saved before the measurements were kept reports them as not recorded - never as zero.
  const bare = fieldFacts(member('a', { naturalistInterest: null, wetlandArea250M2: null, crossingCount: null,
    ecoregionCount: null, ecoregionTransitions: null, lengthM: null, explorationScore: null }));
  assert.deepEqual(bare.map(fact => [fact.key, fact.value]), [['interest', 'not recorded'], ['wetland', 'not recorded'],
    ['crossings', 'not recorded'], ['ecoregions', 'not recorded']]);
  assert.ok(!bare.some(fact => /\b0\b/.test(fact.value)), 'nothing unrecorded is reported as a zero');
  // The exploration order is shown only when it differs from the interest score, and it says which search it used.
  const ordered = fieldFacts(member('a', { explorationScore: 61.2, explorationBasis: 'with-search-centre',
    explorationRadiusMiles: 25 }));
  assert.equal(ordered.find(fact => fact.key === 'order').value, '61.2 within 25 mi of its search centre');
  assert.equal(fieldFacts(member('a')).find(fact => fact.key === 'order'), undefined,
    'an order identical to the interest score is not repeated');
  assert.deepEqual(fieldFacts({ resolved: false }), []);
});

test('the field view reads a real plan, with the plan’s own facts and separation', () => {
  // ONE INTEGRATION CASE, through the same pipeline the application uses: a promoted road, an outing, a plan.
  const LON_PER_M = 1 / (111320 * Math.cos(45.5 * Math.PI / 180));
  const feature = { roadId: 'tiger-2025-or-41067-kept-rd', name: 'NW Kept Rd', roadClass: 'S1400', routeType: 'M',
    countyFips: '41067', countyName: 'Washington County, Oregon', sourceFeatureId: 'f1',
    geometry: { type: 'LineString', coordinates: Array.from({ length: 9 }, (_, index) =>
      [-122.93 + 3000 * index / 8 * LON_PER_M, 45.58]) } };
  const unit = buildDiscoveryUnits([feature]).units[0];
  const corridor = segmentUnit(unit).corridors[0];
  const result = buildDiscoveryResult({ unit, corridor,
    metrics: { wetlands: { coverage: COVERAGE.FULL, reason: null, intersectsCorridor: true, nearestDistanceM: 40,
      perDistance: {}, coverageByDistance: {}, buffers: { 250: { areaM2: 120_000, lengthM: 900, featureCount: 1,
        breakdown: [] } }, classes: [] },
    hydrography: { coverage: COVERAGE.FULL, reason: null, crossingCount: 4, crossings: [], perDistance: {},
      coverageByDistance: {}, buffers: {}, names: [] },
    ecology: { coverage: COVERAGE.FULL, levels: {}, ecoregionCount: 2, transitions: 1 } },
    roadState: COVERAGE.FULL, provenance: { datasetId: 'regional-roads' }, analysisDistancesM: [250, 500, 1000] });
  const candidate = promoteDiscoveryResult({ ...result, id: 'road-a' }, { features: [feature], corridor,
    provenance: { agency: 'U.S. Census Bureau' } });

  const store = createStore({ storage: null });
  store.promoteDiscoveryCandidate(candidate, 'road-a');
  const created = store.createOutingFromRoads(['road-a'], { title: 'Field plan' });
  const state = store.getState();
  const outing = state.outings.find(entry => entry.id === created.outing.id);
  const plan = outingPlan({ outing, savedRoads: savedRoadsById(state) });
  const view = fieldView({ outing, plan });
  assert.equal(view.currentId, 'road-a');
  assert.equal(view.current.name, 'NW Kept Rd');
  assert.equal(view.progress.total, 1);
  // The facts come from the road's own kept measurements, and the destination from the plan's representative point.
  assert.equal(fieldFacts(view.current).find(fact => fact.key === 'wetland').value, '12.0 ha');
  assert.equal(fieldFacts(view.current).find(fact => fact.key === 'crossings').value, '4');
  const destination = navigationLinks(view.current)[0];
  assert.match(destination.url, /destination=45\.\d{5},-122\.\d{5}$/,
    'the navigation point is the plan’s own representative point on this road');
});
