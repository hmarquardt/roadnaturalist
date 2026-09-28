import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHECKLIST_ITEMS, MAX_OUTING_ROADS, MAX_OUTINGS, OUTING_NOTE_MAX_LENGTH, OUTING_STATUS, OUTING_STORAGE_STATUS,
  OUTINGS_KEY, OUTINGS_KIND, OUTINGS_SCHEMA_VERSION, createOuting, moveRoad, normalizeChecklist, normalizeDate, normalizeOutingNote,
  normalizeRoadIds, normalizeTitle, readStoredOutings, removeRoadEverywhere, roadPosition, storedOuting, updateOuting,
  withRoad, withoutRoad, writeStoredOutings } from '../src/state/outings.js';
import { createStore } from '../src/state/store.js';
import { COVERAGE } from '../src/domain/corridor.js';
import { buildDiscoveryResult } from '../src/discovery/signals.js';
import { buildDiscoveryUnits } from '../src/discovery/units.js';
import { segmentUnit } from '../src/discovery/segment.js';
import { promoteDiscoveryResult } from '../src/discovery/lifecycle.js';
import { corridorContextFromCenter, pendingSearchContext, CENTER_LABEL_KIND } from '../src/discovery/search-context.js';

// OUTINGS: PLANS MADE OF ROADS A PERSON CHOSE.
//
// An outing owns planning state and nothing else. These tests hold that line: the order is exactly the order that
// was asked for, a plan references saved roads rather than copying them, one unreadable plan never costs the
// others, an unknown version is left alone, a full device refuses rather than evicts, and removing a plan never
// touches a road.
const LON_PER_M = 1 / (111320 * Math.cos(45.5 * Math.PI / 180));
const CENTER = [-122.9, 45.55];

function fakeStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return { entries, getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: key => { entries.delete(key); } };
}

function promotedCandidate({ id = 'drv1-kept-rd-s1', lat = 45.58, context = true } = {}) {
  const feature = { roadId: 'tiger-2025-or-41067-kept-rd', name: 'NW Kept Rd', roadClass: 'S1400', routeType: 'M',
    countyFips: '41067', countyName: 'Washington County, Oregon', sourceFeatureId: 'f1',
    geometry: { type: 'LineString', coordinates: Array.from({ length: 9 }, (_, index) =>
      [-122.93 + 3000 * index / 8 * LON_PER_M, lat]) } };
  const unit = buildDiscoveryUnits([feature]).units[0];
  const corridor = segmentUnit(unit).corridors[0];
  const measured = corridorContextFromCenter(CENTER, corridor.geometry);
  const result = buildDiscoveryResult({ unit, corridor, metrics: { wetlands: { coverage: COVERAGE.FULL, reason: null, perDistance: {}, coverageByDistance: {}, buffers: {}, classes: [] },
    hydrography: { coverage: COVERAGE.FULL, reason: null, perDistance: {}, coverageByDistance: {}, buffers: {}, crossings: [] },
    ecology: { coverage: COVERAGE.FULL, levels: {} } }, roadState: COVERAGE.FULL, provenance: { datasetId: 'regional-roads' },
    analysisDistancesM: [250, 500, 1000], fromCenter: measured });
  const searchContext = context ? pendingSearchContext({ center: CENTER, radiusMiles: 25, centerLabel: 'Near Vernonia, OR',
    centerLabelKind: CENTER_LABEL_KIND.NEAR_PLACE, distanceFromCenterM: measured.distanceM, nearestCenterPoint: measured.nearestPoint,
    bearingFromCenterDeg: measured.bearingDeg, cardinalFromCenter: measured.cardinal }) : null;
  return promoteDiscoveryResult({ ...result, id }, { features: [feature], corridor, searchContext,
    provenance: { agency: 'U.S. Census Bureau' }, dataCatalogUrl: 'regional/manifest.json' });
}

// Three saved roads in a store, so an outing can reference them.
function savedStore({ count = 3 } = {}) {
  const storage = fakeStorage();
  const store = createStore({ storage });
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = promotedCandidate({ id: `drv1-road-${index}-s1`, lat: 45.5 + index * 0.05 });
    store.promoteDiscoveryCandidate(candidate, candidate.id);
    candidates.push(candidate);
  }
  return { storage, store, candidates };
}

// ------------------------------------------------------------------ the model

test('an outing keeps only planning state, and validates everything that reaches it', () => {
  const outing = createOuting({ title: '  Saturday   wildlife loop ', date: '2026-10-03', roadIds: ['a', 'b', 'a', '', 7],
    notes: 'Start after sunrise.\r\nCheck Dairy Creek.', checklist: [{ text: 'Binoculars' }, { text: '  ' }, { text: 'Water' }],
    at: '2026-09-28T10:00:00.000Z' }, { existing: [] });
  assert.match(outing.id, /^outing-/);
  assert.equal(outing.title, 'Saturday wildlife loop');
  assert.equal(outing.date, '2026-10-03');
  assert.equal(outing.status, OUTING_STATUS.PLANNED);
  assert.deepEqual([...outing.roadIds], ['a', 'b'], 'a road appears once: the list is a sequence, not a commute');
  assert.equal(outing.notes, 'Start after sunrise.\nCheck Dairy Creek.', 'line endings are normalised, breaks kept');
  assert.equal(outing.checklist.length, 2, 'an empty item is not an item');
  assert.equal(outing.checklist[0].text, 'Binoculars');
  assert.equal(outing.checklist[0].checked, false);
  assert.match(outing.checklist[0].id, /^item-/);
  assert.equal(outing.createdAt, '2026-09-28T10:00:00.000Z');
  assert.equal(outing.updatedAt, outing.createdAt);
  // Nothing about a candidate is copied into a plan.
  for (const forbidden of ['corridor', 'coverage', 'evidence', 'geometry', 'roads', 'searchContext']) {
    assert.equal(outing[forbidden], undefined, `an outing must not carry ${forbidden}`);
  }
  // Bounds and refusal of nonsense.
  assert.equal(normalizeTitle('   '), 'Untitled outing');
  assert.equal(normalizeTitle('x'.repeat(400)).length, 120);
  assert.equal(normalizeDate('2026-02-30'), null, 'a date the calendar does not have is refused');
  assert.equal(normalizeDate('2026-2-3'), null);
  assert.equal(normalizeDate(''), null);
  assert.equal(normalizeDate('2026-12-31'), '2026-12-31');
  assert.equal(normalizeOutingNote('n'.repeat(OUTING_NOTE_MAX_LENGTH + 50)).length, OUTING_NOTE_MAX_LENGTH);
  assert.equal(normalizeOutingNote('a\u0000b'), 'ab');
  assert.equal(normalizeRoadIds(Array.from({ length: 40 }, (_, index) => `r${index}`)).length, MAX_OUTING_ROADS);
  assert.equal(normalizeChecklist(Array.from({ length: 40 }, (_, index) => ({ text: `item ${index}` }))).length, MAX_CHECKLIST_ITEMS);
  assert.equal(normalizeChecklist([{ text: 'x'.repeat(500) }])[0].text.length, 120);
});

test('the order is the person’s, and moving stops at the ends', () => {
  let outing = createOuting({ title: 'A B C', roadIds: ['a', 'b', 'c'] });
  assert.deepEqual([...outing.roadIds], ['a', 'b', 'c']);
  outing = moveRoad(outing, 'c', 'up');
  assert.deepEqual([...outing.roadIds], ['a', 'c', 'b'], 'C moves above B, exactly as asked');
  assert.equal(roadPosition(outing, 'a'), 1);
  assert.equal(roadPosition(outing, 'c'), 2);
  assert.equal(roadPosition(outing, 'missing'), null);
  // The ends stay put, and an unknown road changes nothing.
  assert.deepEqual([...moveRoad(outing, 'a', 'up').roadIds], ['a', 'c', 'b']);
  assert.deepEqual([...moveRoad(outing, 'b', 'down').roadIds], ['a', 'c', 'b']);
  assert.deepEqual([...moveRoad(outing, 'nope', 'up').roadIds], ['a', 'c', 'b']);
  // Adding and removing roads is bounded and explicit.
  const added = withRoad(outing, 'd');
  assert.equal(added.changed, true);
  assert.deepEqual([...added.outing.roadIds], ['a', 'c', 'b', 'd']);
  assert.equal(withRoad(outing, 'a').changed, false, 'the same road is not added twice');
  assert.match(withRoad(outing, 'a').reason, /already in this outing/);
  const full = createOuting({ title: 'full', roadIds: Array.from({ length: MAX_OUTING_ROADS }, (_, index) => `r${index}`) });
  const refused = withRoad(full, 'one-more');
  assert.equal(refused.changed, false);
  assert.match(refused.reason, new RegExp(`up to ${MAX_OUTING_ROADS} roads`));
  assert.deepEqual([...withoutRoad(outing, 'c').roadIds], ['a', 'b']);
});

// ------------------------------------------------------------------ persistence

test('outings round-trip, isolate a corrupt record, and leave an unknown version alone', () => {
  const storage = fakeStorage();
  const outings = [createOuting({ title: 'Saturday', roadIds: ['a', 'b'], date: '2026-10-03',
    notes: 'Start after sunrise.', checklist: [{ text: 'Binoculars', checked: true }] }, { existing: [] }),
    createOuting({ title: 'Sunday', roadIds: ['c'] }, { existing: [] })];
  const written = writeStoredOutings(outings, { storage, savedAt: 'fixed' });
  assert.equal(written.ok, true);
  assert.equal(written.count, 2);
  assert.ok(written.bytes > 0 && written.bytes < 4000, 'two small plans are a few kilobytes at most');
  const entry = JSON.parse(storage.getItem(OUTINGS_KEY));
  assert.equal(entry.kind, OUTINGS_KIND);
  assert.equal(entry.version, OUTINGS_SCHEMA_VERSION);
  const read = readStoredOutings(storage);
  assert.equal(read.status, OUTING_STORAGE_STATUS.RESTORED);
  assert.deepEqual(read.outings.map(outing => outing.title), ['Saturday', 'Sunday']);
  assert.equal(read.outings[0].checklist[0].checked, true);
  assert.equal(read.outings[0].notes, 'Start after sunrise.');
  assert.equal(read.skipped.length, 0);
  // One unreadable plan costs only itself.
  storage.setItem(OUTINGS_KEY, JSON.stringify({ kind: OUTINGS_KIND, version: OUTINGS_SCHEMA_VERSION,
    outings: [entry.outings[0], { title: 'no id' }, entry.outings[1]] }));
  const damaged = readStoredOutings(storage);
  assert.equal(damaged.outings.length, 2);
  assert.equal(damaged.skipped.length, 1);
  assert.match(damaged.skipped[0].reason, /not a usable outing/);
  // An unknown version is reported and left untouched, byte for byte.
  const future = JSON.stringify({ kind: OUTINGS_KIND, version: OUTINGS_SCHEMA_VERSION + 1, outings: [] });
  const other = fakeStorage({ [OUTINGS_KEY]: future });
  const refused = readStoredOutings(other);
  assert.equal(refused.status, OUTING_STORAGE_STATUS.UNSUPPORTED);
  assert.match(refused.reason, new RegExp(`version ${OUTINGS_SCHEMA_VERSION + 1}`));
  assert.equal(other.getItem(OUTINGS_KEY), future);
  // A foreign or unparsable entry is not an outing record.
  assert.equal(readStoredOutings(fakeStorage({ [OUTINGS_KEY]: '{nope' })).status, OUTING_STORAGE_STATUS.UNSUPPORTED);
  assert.equal(readStoredOutings(fakeStorage({ [OUTINGS_KEY]: JSON.stringify({ kind: 'other', version: 1 }) })).status, OUTING_STORAGE_STATUS.UNSUPPORTED);
  assert.equal(readStoredOutings(fakeStorage()).status, OUTING_STORAGE_STATUS.EMPTY);
  const noCandidates = writeStoredOutings([], { storage });
  assert.equal(noCandidates.ok, true);
  assert.equal(storage.getItem(OUTINGS_KEY), null, 'no outings means no entry, not an empty one');
});

test('a full device refuses another plan, and a blocked device says so honestly', () => {
  const storage = fakeStorage();
  const many = Array.from({ length: MAX_OUTINGS + 1 }, (_, index) => createOuting({ title: `Outing ${index}`, roadIds: ['a'] }));
  assert.equal(writeStoredOutings(many.slice(0, MAX_OUTINGS), { storage }).ok, true);
  const before = storage.getItem(OUTINGS_KEY);
  const refused = writeStoredOutings(many, { storage });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, OUTING_STORAGE_STATUS.FULL);
  assert.match(refused.reason, new RegExp(`maximum of ${MAX_OUTINGS} outings`));
  assert.equal(storage.getItem(OUTINGS_KEY), before, 'nothing was evicted to make room');
  const throwing = fakeStorage();
  throwing.setItem = () => { throw new Error('QuotaExceededError'); };
  const failed = writeStoredOutings([createOuting({ title: 'x', roadIds: ['a'] })], { storage: throwing });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, OUTING_STORAGE_STATUS.UNAVAILABLE);
  assert.match(failed.reason, /could not be saved on this device/);
  assert.equal(writeStoredOutings([], { storage: null }).status, OUTING_STORAGE_STATUS.UNAVAILABLE);
  assert.equal(readStoredOutings(null).status, OUTING_STORAGE_STATUS.UNAVAILABLE);
  // An unreadable stored record is validated, not trusted.
  assert.equal(storedOuting({ id: 'x' }), null, 'a record without a title is refused');
  assert.equal(storedOuting(null), null);
  assert.equal(storedOuting({ id: 'x', title: 't', roadIds: 'nope', checklist: 'nope' }).roadIds.length, 0);
});

// ------------------------------------------------------------------ the store and the candidates it points at

test('the store creates, edits, orders and removes plans without touching a road', async () => {
  const { storage, store, candidates } = savedStore({ count: 3 });
  const ids = candidates.map(candidate => candidate.id);
  const created = store.createOutingFromRoads([ids[0], ids[1]], { title: 'Saturday loop', date: '2026-10-03' });
  assert.equal(created.ok, true);
  const outing = created.outing;
  assert.deepEqual([...outing.roadIds], [ids[0], ids[1]]);
  assert.equal(store.getState().selectedOutingId, outing.id, 'a new plan opens');
  assert.equal(store.getState().outingStorage.status, OUTING_STORAGE_STATUS.SAVED);
  // Adding a road, reordering it, and writing the plan's own words.
  assert.equal(store.addRoadToOuting(outing.id, ids[2]).changed, true);
  store.moveOutingRoad(outing.id, ids[2], 'up');
  store.updateOuting(outing.id, { notes: 'Lunch in Vernonia.', checklist: [{ text: 'Binoculars' }, { text: 'Water' }] });
  let current = store.getState().outings[0];
  assert.deepEqual([...current.roadIds], [ids[0], ids[2], ids[1]]);
  assert.equal(current.notes, 'Lunch in Vernonia.');
  assert.equal(current.checklist.length, 2);
  assert.ok(current.updatedAt >= current.createdAt);
  // A road that is not saved on this device cannot join a plan, and a plan cannot be created from nothing.
  assert.equal(store.addRoadToOuting(outing.id, 'not-saved').changed, false);
  assert.equal(store.createOutingFromRoads(['not-saved']).ok, false);
  assert.match(store.createOutingFromRoads(['not-saved']).reason, /at least one saved road/);
  // Marking it completed is durable, and reopening it is allowed.
  store.updateOuting(outing.id, { status: OUTING_STATUS.COMPLETED });
  assert.equal(store.getState().outings[0].status, OUTING_STATUS.COMPLETED);
  const reloaded = createStore({ storage });
  reloaded.restoreCandidates();
  reloaded.restoreOutings();
  assert.equal(reloaded.getState().outings.length, 1);
  assert.equal(reloaded.getState().outings[0].status, OUTING_STATUS.COMPLETED);
  assert.equal(reloaded.getState().outings[0].notes, 'Lunch in Vernonia.');
  assert.deepEqual([...reloaded.getState().outings[0].roadIds], [ids[0], ids[2], ids[1]]);
  // A plan resolves its roads against the saved collection: it holds references, not copies.
  assert.equal(reloaded.getState().outings[0].roadIds.every(id => reloaded.getState().durableCandidateIds.includes(id)), true);
});

test('a road used by a plan is not removed behind the person’s back', () => {
  const { storage, store, candidates } = savedStore({ count: 2 });
  const [first, second] = candidates;
  const created = store.createOutingFromRoads([first.id, second.id], { title: 'Two roads' });
  assert.equal(store.outingsUsingCandidate(first.id).length, 1);
  // The plain removal is refused, with a reason the workspace can show, and nothing changes.
  assert.equal(store.removeCandidate(first.id), null);
  assert.match(store.getState().outingStorage.reason, /used in 1 outing/);
  assert.equal(store.getState().candidates.length, 2);
  assert.equal(store.getState().outings[0].roadIds.length, 2);
  // The explicit removal takes the road out of the plan as well, and leaves the other road alone.
  const selected = store.removeCandidate(first.id, { removeFromOutings: true });
  assert.equal(selected, second.id);
  assert.deepEqual(store.getState().candidates.map(candidate => candidate.id), [second.id]);
  assert.deepEqual([...store.getState().outings[0].roadIds], [second.id]);
  assert.equal(store.getState().userMetaById[first.id], undefined);
  const reloaded = createStore({ storage });
  reloaded.restoreCandidates();
  reloaded.restoreOutings();
  assert.equal(reloaded.getState().candidates.length, 1);
  assert.deepEqual([...reloaded.getState().outings[0].roadIds], [second.id]);
  assert.equal(created.ok, true);
});

test('removing an outing removes the plan and nothing else', () => {
  const { store, candidates } = savedStore({ count: 2 });
  const created = store.createOutingFromRoads(candidates.map(candidate => candidate.id), { title: 'Saturday' });
  store.removeOuting(created.outing.id);
  const state = store.getState();
  assert.equal(state.outings.length, 0);
  assert.equal(state.candidates.length, 2, 'the roads stay saved, with their notes and favorites');
  assert.equal(state.durableCandidateIds.length, 2);
  assert.equal(state.candidateStorage.persisted, 2);
  assert.equal(state.selectedOutingId, null);
  assert.equal(removeRoadEverywhere([created.outing], candidates[0].id)[0].roadIds.length, 1);
});
