import test from 'node:test';
import assert from 'node:assert/strict';

import { createOuting, isRoadVisited, markRoadVisited, normalizeRoadState, roadProgress, storedOuting,
  unmarkRoadVisited, updateOuting, visitedAt, withRoad, withoutRoad, writeStoredOutings, readStoredOutings,
  OUTINGS_KEY, OUTINGS_KIND, OUTINGS_SCHEMA_VERSION } from '../src/state/outings.js';
import { createStore } from '../src/state/store.js';
import { COVERAGE } from '../src/domain/corridor.js';
import { buildDiscoveryResult } from '../src/discovery/signals.js';
import { buildDiscoveryUnits } from '../src/discovery/units.js';
import { segmentUnit } from '../src/discovery/segment.js';
import { promoteDiscoveryResult } from '../src/discovery/lifecycle.js';

// PROGRESS THROUGH A PLAN, AND NOTHING ELSE.
//
// Which roads of one outing have been visited is durable state of the plan: it survives a reload, it belongs to the
// outing rather than to the road, it leaves with a road that is removed, and a record that carries nonsense carries
// nothing. None of these tests involve a position, a time or a distance, because the model has none.
const LON_PER_M = 1 / (111320 * Math.cos(45.5 * Math.PI / 180));
const CENTER = [-122.9, 45.55];

function fakeStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return { entries, getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: key => { entries.delete(key); } };
}

function promotedCandidate({ id = 'drv1-kept-rd-s1', lat = 45.58 } = {}) {
  const feature = { roadId: `tiger-2025-or-41067-${id}`, name: `NW ${id}`, roadClass: 'S1400', routeType: 'M',
    countyFips: '41067', countyName: 'Washington County, Oregon', sourceFeatureId: `f-${id}`,
    geometry: { type: 'LineString', coordinates: Array.from({ length: 9 }, (_, index) =>
      [-122.93 + 3000 * index / 8 * LON_PER_M, lat]) } };
  const unit = buildDiscoveryUnits([feature]).units[0];
  const corridor = segmentUnit(unit).corridors[0];
  const result = buildDiscoveryResult({ unit, corridor,
    metrics: { wetlands: { coverage: COVERAGE.FULL, reason: null, perDistance: {}, coverageByDistance: {}, buffers: {}, classes: [] },
      hydrography: { coverage: COVERAGE.FULL, reason: null, perDistance: {}, coverageByDistance: {}, buffers: {}, crossings: [] },
      ecology: { coverage: COVERAGE.FULL, levels: {} } },
    roadState: COVERAGE.FULL, provenance: { datasetId: 'regional-roads' }, analysisDistancesM: [250, 500, 1000] });
  return promoteDiscoveryResult({ ...result, id }, { features: [feature], corridor,
    provenance: { agency: 'U.S. Census Bureau' } });
}

function savedStore({ count = 3 } = {}) {
  const storage = fakeStorage();
  const store = createStore({ storage });
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = promotedCandidate({ id: `road-${index}`, lat: 45.5 + index * 0.05 });
    store.promoteDiscoveryCandidate(candidate, candidate.id);
    candidates.push(candidate);
  }
  return { storage, store, candidates };
}

test('a visited road round-trips through storage, and undo leaves no trace of it', () => {
  let roadState = normalizeRoadState({}, { roadIds: ['a', 'b'] });
  assert.deepEqual(roadState, {}, 'nothing visited is an empty map, not a map of false');
  roadState = markRoadVisited(roadState, 'a', { at: '2026-10-14T15:00:00.000Z' });
  assert.equal(isRoadVisited(roadState, 'a'), true);
  assert.equal(isRoadVisited(roadState, 'b'), false);
  assert.equal(visitedAt(roadState, 'a'), '2026-10-14T15:00:00.000Z');
  assert.equal(visitedAt(roadState, 'b'), null);
  const outing = createOuting({ title: 'Loop', roadIds: ['a', 'b'], roadState });
  assert.deepEqual(roadProgress(outing), { total: 2, visited: 1, remaining: 1, percent: 50 });
  // THE WHOLE RECORD SURVIVES A WRITE AND A READ.
  const storage = fakeStorage();
  writeStoredOutings([outing], { storage, savedAt: '2026-10-14T15:01:00.000Z' });
  const stored = JSON.parse(storage.getItem(OUTINGS_KEY));
  assert.equal(stored.kind, OUTINGS_KIND);
  assert.equal(stored.version, OUTINGS_SCHEMA_VERSION);
  assert.deepEqual(stored.outings[0].roadState, { a: { visited: true, visitedAt: '2026-10-14T15:00:00.000Z' } });
  const read = readStoredOutings(storage);
  assert.equal(read.status, 'restored');
  assert.equal(isRoadVisited(read.outings[0].roadState, 'a'), true, 'the progress comes back with the plan');
  // UNDO REMOVES THE ENTRY: "not visited" is the absence of progress, never a second value to keep in step.
  const undone = unmarkRoadVisited(read.outings[0].roadState, 'a');
  assert.deepEqual(undone, {});
  assert.equal(isRoadVisited(undone, 'a'), false);
  assert.deepEqual(unmarkRoadVisited(undone, 'a'), {}, 'undoing what is not visited changes nothing');
  assert.equal(roadProgress({ roadIds: ['a', 'b'], roadState: undone }).percent, 0);
  // A plan nobody has started serializes without the field at all.
  const fresh = createOuting({ title: 'Fresh', roadIds: ['a'] });
  writeStoredOutings([fresh], { storage });
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(storage.getItem(OUTINGS_KEY)).outings[0], 'roadState'), false);
});

test('progress belongs to the plan, so two plans can hold the same road differently', () => {
  const first = createOuting({ title: 'Saturday', roadIds: ['a', 'b'] });
  const second = createOuting({ title: 'Sunday', roadIds: ['b', 'c'] });
  const visited = updateOuting(first, { roadState: markRoadVisited(first.roadState, 'a') });
  assert.equal(isRoadVisited(visited.roadState, 'a'), true);
  assert.deepEqual(second.roadState, {}, 'the other plan is untouched');
  assert.equal(isRoadVisited(second.roadState, 'b'), false, 'and a road visited in one plan is unvisited in the other');
  // The road itself carries nothing: this is plan state, not candidate state.
  assert.equal(second.roadState.b, undefined);
});

test('a road that leaves the plan takes its progress with it', () => {
  const base = createOuting({ title: 'Loop', roadIds: ['a', 'b', 'c'] });
  const withProgress = updateOuting(base, { roadState: { ...markRoadVisited(base.roadState, 'a'),
    ...markRoadVisited(base.roadState, 'b') } });
  assert.deepEqual(roadProgress(withProgress), { total: 3, visited: 2, remaining: 1, percent: 67 });
  const without = withoutRoad(withProgress, 'a');
  assert.deepEqual([...without.roadIds], ['b', 'c']);
  assert.equal(isRoadVisited(without.roadState, 'a'), false, 'the removed road leaves no progress behind');
  assert.equal(isRoadVisited(without.roadState, 'b'), true, 'and the other progress is kept');
  assert.deepEqual(roadProgress(without), { total: 2, visited: 1, remaining: 1, percent: 50 });
  // RE-ADDING THE ROAD IS A NEW STOP, so it starts unvisited rather than restoring an old mark.
  const readded = withRoad(without, 'a').outing;
  assert.deepEqual([...readded.roadIds], ['b', 'c', 'a']);
  assert.equal(isRoadVisited(readded.roadState, 'a'), false);
  // And a patch that never mentions progress cannot drop it either.
  assert.equal(isRoadVisited(updateOuting(without, { title: 'Renamed' }).roadState, 'b'), true);
  assert.equal(isRoadVisited(updateOuting(without, { roadIds: ['b'] }).roadState, 'b'), true);
  assert.equal(isRoadVisited(updateOuting(without, { roadIds: ['b'] }).roadState, 'c'), false, 'a dropped road is pruned');
});

test('a record written before progress existed still reads, as an unvisited plan', () => {
  const legacy = { id: 'outing-legacy', title: 'Older plan', status: 'planned', roadIds: ['a', 'b'], notes: 'Kept.',
    checklist: [{ id: 'item-1', text: 'Binoculars', checked: true }], createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z' };
  const restored = storedOuting(legacy);
  assert.ok(restored, 'a version 1 record without progress is a valid plan');
  assert.deepEqual(restored.roadState, {}, 'and it is simply unvisited');
  assert.deepEqual([...restored.roadIds], ['a', 'b']);
  assert.equal(restored.notes, 'Kept.');
  assert.equal(restored.checklist[0].checked, true);
  assert.deepEqual(roadProgress(restored), { total: 2, visited: 0, remaining: 2, percent: 0 });
  // The same record read through the whole entry, from storage, behaves identically.
  const storage = fakeStorage({ [OUTINGS_KEY]: JSON.stringify({ kind: OUTINGS_KIND, version: OUTINGS_SCHEMA_VERSION,
    savedAt: '2026-01-02T00:00:00.000Z', outings: [legacy] }) });
  const read = readStoredOutings(storage);
  assert.equal(read.status, 'restored');
  assert.deepEqual(read.outings[0].roadState, {});
});

test('progress that cannot be trusted is ignored, entry by entry', () => {
  const roadIds = ['a', 'b', 'c'];
  const cases = [
    ['not an object', 'nonsense'],
    ['an array', [1, 2, 3]],
    ['a string entry', { a: 'visited' }],
    ['a number entry', { a: 1 }],
    ['an explicit false', { a: { visited: false } }],
    ['a truthy non-boolean', { a: { visited: 'yes' } }],
    ['an unknown road', { zzz: { visited: true } }],
    ['an empty object entry', { a: {} }],
  ];
  for (const [label, value] of cases) {
    assert.deepEqual(normalizeRoadState(value, { roadIds }), {}, `${label} carries no progress`);
  }
  // A partly valid record keeps exactly the entries that are usable, and drops the rest.
  const mixed = normalizeRoadState({ a: { visited: true, visitedAt: '2026-10-14T15:00:00.000Z' },
    b: { visited: true, visitedAt: 'not-a-date' }, c: { visited: false }, zzz: { visited: true } }, { roadIds });
  assert.deepEqual(Object.keys(mixed), ['a', 'b']);
  assert.equal(mixed.b.visitedAt, null, 'an unusable timestamp is absent rather than invented');
  // A plan whose roads are all gone keeps no progress at all.
  assert.deepEqual(normalizeRoadState({ a: { visited: true } }, { roadIds: [] }), {});
});


test('the store marks, undoes and persists progress, and prunes it when a road leaves', () => {
  const { storage, store } = savedStore({ count: 3 });
  const created = store.createOutingFromRoads(['road-0', 'road-1', 'road-2'], { title: 'Field plan' });
  assert.equal(created.ok, true);
  const id = created.outing.id;
  const persisted = () => JSON.parse(storage.getItem(OUTINGS_KEY)).outings.find(entry => entry.id === id);
  assert.equal(persisted().roadState, undefined, 'a plan nobody has started writes no progress');

  const marked = store.markRoadVisited(id, 'road-1');
  assert.equal(isRoadVisited(marked.roadState, 'road-1'), true);
  assert.ok(persisted().roadState['road-1'].visitedAt, 'and it is written to the device with the moment it was marked');
  assert.deepEqual(roadProgress(store.getState().outings[0]), { total: 3, visited: 1, remaining: 2, percent: 33 });

  // A road that is not in the plan cannot be marked, and nothing is written for it.
  assert.equal(store.markRoadVisited(id, 'not-in-the-plan'), null);
  assert.deepEqual(Object.keys(persisted().roadState), ['road-1']);

  // Undo removes it from the device again.
  store.markRoadVisited(id, 'road-1', false);
  assert.equal(isRoadVisited(store.getState().outings[0].roadState, 'road-1'), false);
  assert.equal(persisted().roadState, undefined, 'a plan with no progress left writes no progress field at all');

  // Removing a road from the plan prunes its progress in the same write.
  store.markRoadVisited(id, 'road-0');
  store.markRoadVisited(id, 'road-2');
  assert.deepEqual(Object.keys(persisted().roadState).sort(), ['road-0', 'road-2']);
  store.removeRoadFromOuting(id, 'road-0');
  assert.deepEqual(Object.keys(persisted().roadState), ['road-2'], 'the removed road leaves no orphaned progress');
  // And the reloaded plan has exactly the progress that was written.
  const reloaded = readStoredOutings(storage);
  assert.equal(reloaded.outings[0].roadIds.length, 2);
  assert.equal(isRoadVisited(reloaded.outings[0].roadState, 'road-2'), true);
  assert.equal(isRoadVisited(reloaded.outings[0].roadState, 'road-0'), false);
});

test('progress survives a reload in a fresh store, with the rest of the plan', () => {
  const storage = fakeStorage();
  const first = createStore({ storage });
  const road = promotedCandidate({ id: 'road-a' });
  first.promoteDiscoveryCandidate(road, 'road-a');
  const created = first.createOutingFromRoads(['road-a'], { title: 'Reloaded plan' });
  first.markRoadVisited(created.outing.id, 'road-a');
  first.updateOuting(created.outing.id, { notes: 'Start before light.' });

  // A NEW STORE, the same device: exactly what a reload is.
  const second = createStore({ storage });
  second.restoreCandidates();
  second.restoreOutings();
  const restored = second.getState().outings[0];
  assert.equal(restored.title, 'Reloaded plan');
  assert.equal(restored.notes, 'Start before light.');
  assert.equal(isRoadVisited(restored.roadState, 'road-a'), true, 'the visited mark is still there');
  assert.deepEqual(roadProgress(restored), { total: 1, visited: 1, remaining: 0, percent: 100 });
});
