import test from 'node:test';
import assert from 'node:assert/strict';
import { COVERAGE, COVERAGE_DATASET, createCandidate } from '../src/domain/corridor.js';
import { CANDIDATES_KEY, CANDIDATES_KIND, CANDIDATES_SCHEMA_VERSION, CANDIDATE_STORAGE_STATUS, MAX_PERSISTED_CANDIDATES,
  persistedCandidateRecord, readStoredCandidates, writeStoredCandidates } from '../src/state/candidate-persistence.js';
import { createStore } from '../src/state/store.js';
import { NOTE_MAX_LENGTH, normalizeNote, savedDateLabel, storedUserMeta } from '../src/state/user-meta.js';
import { COMPARISON_LIMIT_REASON, MAX_COMPARISON, SAVED_FILTERS, SAVED_SORTS, comparisonDimensions, comparisonIds,
  comparisonSelection, nextComparison, notePreview, savedCounts, savedRoadRowsFor, sortSavedRoads } from '../src/state/saved-roads.js';
import { buildDiscoveryResult } from '../src/discovery/signals.js';
import { buildDiscoveryUnits } from '../src/discovery/units.js';
import { segmentUnit } from '../src/discovery/segment.js';
import { promoteDiscoveryResult } from '../src/discovery/lifecycle.js';
import { corridorContextFromCenter, pendingSearchContext, CENTER_LABEL_KIND } from '../src/discovery/search-context.js';
import { buildCorridorBundle } from '../src/investigator/bundle.js';

// SAVED ROADS: A COLLECTION A PERSON ARRANGES.
//
// These tests hold the line between what a road *is* and what a person *said about it*. Candidates migrate from
// version 1 without inventing a saved date, favorites and notes survive reloads, re-promotion never erases them,
// the collection sorts and filters deterministically, and a comparison lists facts side by side without ever
// ranking them - including saying "not measured this session" instead of showing a zero.
const LON_PER_M = 1 / (111320 * Math.cos(45.5 * Math.PI / 180));
const CENTER = [-122.9, 45.55];

function fakeStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return { entries, getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: key => { entries.delete(key); } };
}

function line(lengthM, { lon = -122.93, lat = 45.58, segments = 8 } = {}) {
  return Array.from({ length: segments + 1 }, (_, index) => [lon + lengthM * index / segments * LON_PER_M, lat]);
}

function metrics() {
  const states = Object.fromEntries([250, 500, 1000].map(distance =>
    [distance, { covered: true, corridorInside: false, coverage: COVERAGE.FULL }]));
  return {
    wetlands: { coverage: COVERAGE.FULL, reason: null, perDistance: states, coverageByDistance: states,
      buffers: { 250: { areaM2: 0, lengthM: 0, featureCount: 0, breakdown: [] } }, classes: [],
      nearestDistanceM: 420, intersectsCorridor: false, corridorFeatureCount: 0 },
    hydrography: { coverage: COVERAGE.FULL, reason: null, perDistance: states, coverageByDistance: states,
      buffers: { 1000: { areaM2: 0, lengthM: 0, featureCount: 0, breakdown: [] } }, crossings: [], crossingCount: 0,
      nearestFlowingWaterM: 200, nearestStandingWaterM: null, corridorFlowlineCount: 0, types: [], names: [] },
    ecology: { coverage: COVERAGE.FULL, spansMultiple: false,
      level3: { coverage: COVERAGE.FULL, primary: { code: '3', name: 'Willamette Valley', overlapM: 3000, percent: 100 },
        intersections: [{ code: '3', name: 'Willamette Valley', overlapM: 3000, percent: 100 }] },
      level4: { coverage: COVERAGE.FULL, primary: { code: '3a', name: 'Portland/Vancouver Basin', overlapM: 3000, percent: 100 },
        intersections: [{ code: '3a', name: 'Portland/Vancouver Basin', overlapM: 3000, percent: 100 }] } },
  };
}

function promotedCandidate({ id = 'drv1-kept-rd-s1', lat = 45.58, context = true } = {}) {
  const feature = { roadId: 'tiger-2025-or-41067-kept-rd', name: 'NW Kept Rd', roadClass: 'S1400', routeType: 'M',
    countyFips: '41067', countyName: 'Washington County, Oregon', sourceFeatureId: 'f1',
    geometry: { type: 'LineString', coordinates: line(3000, { lat }) } };
  const unit = buildDiscoveryUnits([feature]).units[0];
  const corridor = segmentUnit(unit).corridors[0];
  const measured = corridorContextFromCenter(CENTER, corridor.geometry);
  const result = buildDiscoveryResult({ unit, corridor, metrics: metrics(), roadState: COVERAGE.FULL,
    provenance: { datasetId: 'regional-roads' }, analysisDistancesM: [250, 500, 1000], fromCenter: measured });
  const searchContext = context ? pendingSearchContext({ center: CENTER, radiusMiles: 25, centerLabel: 'Near Vernonia, OR',
    centerLabelKind: CENTER_LABEL_KIND.NEAR_PLACE, distanceFromCenterM: measured.distanceM,
    nearestCenterPoint: measured.nearestPoint, bearingFromCenterDeg: measured.bearingDeg, cardinalFromCenter: measured.cardinal }) : null;
  const candidate = promoteDiscoveryResult({ ...result, id }, { features: [feature], corridor, searchContext,
    provenance: { agency: 'U.S. Census Bureau' }, dataCatalogUrl: 'regional/manifest.json' });
  return candidate;
}

// A version 1 entry, exactly as the previous build wrote it: the same record without user metadata.
function versionOneEntry(candidates, { savedAt = '2026-01-01T00:00:00.000Z' } = {}) {
  return JSON.stringify({ kind: CANDIDATES_KIND, version: 1, savedAt,
    candidates: candidates.map(candidate => { const { userMeta, ...record } = persistedCandidateRecord(candidate); return record; }) });
}

async function reload(storage) {
  const store = createStore({ storage });
  const restored = store.restoreCandidates();
  return { store, restored };
}

// ------------------------------------------------------------------ migration

test('a version 1 collection migrates without inventing a saved date', async () => {
  const storage = fakeStorage();
  const first = promotedCandidate({ id: 'drv1-kept-rd-s1' });
  const second = promotedCandidate({ id: 'drv1-second-rd-s1', lat: 45.62 });
  storage.setItem(CANDIDATES_KEY, versionOneEntry([first, second]));
  const before = storage.getItem(CANDIDATES_KEY);
  const { store, restored } = await reload(storage);
  assert.equal(restored.migrated, true, 'the entry says which format it was written in');
  assert.equal(restored.version, 1);
  assert.deepEqual(restored.candidates.map(candidate => candidate.id), [first.id, second.id], 'nothing is lost');
  assert.equal(restored.skipped.length, 0);
  const state = store.getState();
  assert.equal(state.candidates.length, 2);
  for (const candidate of state.candidates) {
    const meta = state.userMetaById[candidate.id];
    assert.deepEqual({ ...meta }, { favorite: false, note: '', savedAt: null, updatedAt: null },
      'metadata starts at its defaults, with no fabricated save time');
    assert.equal(candidate.userMeta, undefined, 'and it never enters the candidate itself');
  }
  assert.equal(state.candidateStorage.migrated, true, 'the panel can say the collection came from an earlier format');
  assert.equal(storage.getItem(CANDIDATES_KEY), before, 'reading a version 1 entry does not rewrite it');
  // The next durable change writes the current format, with the annotation beside the facts.
  store.setCandidateFavorite(first.id, true);
  const entry = JSON.parse(storage.getItem(CANDIDATES_KEY));
  assert.equal(entry.version, CANDIDATES_SCHEMA_VERSION);
  assert.equal(entry.candidates.length, 2, 'the migration keeps every candidate');
  assert.equal(entry.candidates[0].userMeta.favorite, true);
  assert.equal(entry.candidates[0].userMeta.savedAt, null, 'the unknown saved date stays unknown');
  assert.equal(entry.candidates[1].userMeta.favorite, false);
  assert.deepEqual(readStoredCandidates(storage).candidates.map(candidate => candidate.id), [first.id, second.id]);
});

test('a broken version 1 record is isolated, and an unknown version is still left alone', () => {
  const storage = fakeStorage();
  const good = promotedCandidate({});
  const broken = versionOneEntry([good]);
  const entry = JSON.parse(broken);
  entry.candidates.push({ id: 'broken', name: 'Broken', status: 'discovered', roads: [] });
  storage.setItem(CANDIDATES_KEY, JSON.stringify(entry));
  const read = readStoredCandidates(storage);
  assert.equal(read.candidates.length, 1, 'the readable candidate still loads');
  assert.equal(read.skipped.length, 1);
  assert.match(read.skipped[0].reason, /no usable road records/);
  assert.equal(read.userMetaById[good.id].favorite, false);
  // A version this build does not know is untouched, byte for byte.
  const future = JSON.stringify({ kind: CANDIDATES_KIND, version: CANDIDATES_SCHEMA_VERSION + 1, candidates: [] });
  const other = fakeStorage({ [CANDIDATES_KEY]: future });
  const refused = readStoredCandidates(other);
  assert.equal(refused.status, CANDIDATE_STORAGE_STATUS.UNSUPPORTED);
  assert.match(refused.reason, new RegExp(`version ${CANDIDATES_SCHEMA_VERSION + 1}`));
  assert.equal(other.getItem(CANDIDATES_KEY), future);
});

// ------------------------------------------------------------------ favorites and notes

test('a favorite and a note are durable, and come back with the road', async () => {
  const storage = fakeStorage();
  const candidate = promotedCandidate({});
  const store = createStore({ storage });
  store.promoteDiscoveryCandidate(candidate, candidate.id);
  const savedMeta = store.getState().userMetaById[candidate.id];
  assert.equal(savedMeta.favorite, false);
  assert.ok(savedMeta.savedAt, 'a newly saved candidate records when it was saved');
  assert.equal(savedMeta.updatedAt, null, 'nothing has been edited yet');
  store.setCandidateFavorite(candidate.id, true);
  assert.equal(store.getState().userMetaById[candidate.id].favorite, true);
  assert.ok(store.getState().userMetaById[candidate.id].updatedAt, 'a favorite is an edit, and it is dated');
  store.setCandidateNote(candidate.id, 'Good early-morning loop.\nCheck the northern section after heavy rain.');
  const note = store.getState().userMetaById[candidate.id].note;
  assert.equal(note.split('\n').length, 2, 'line breaks are kept');
  assert.equal(store.getState().candidateStorage.status, CANDIDATE_STORAGE_STATUS.SAVED);
  const { store: reloaded } = await reload(storage);
  const meta = reloaded.getState().userMetaById[candidate.id];
  assert.equal(meta.favorite, true, 'the favorite survives a reload');
  assert.equal(meta.note, note, 'the note survives a reload');
  assert.equal(meta.savedAt, savedMeta.savedAt, 'and the saved date is the one it was saved with');
  assert.equal(reloaded.getState().candidates[0].userMeta, undefined, 'still never inside the candidate');
  // Unfavoriting is durable too, and does not touch the note.
  reloaded.setCandidateFavorite(candidate.id, false);
  const after = await reload(storage);
  assert.equal(after.store.getState().userMetaById[candidate.id].favorite, false);
  assert.equal(after.store.getState().userMetaById[candidate.id].note, note);
});

test('notes are bounded, normalized, and stored exactly as words', () => {
  assert.equal(normalizeNote('a\r\nb\rc'), 'a\nb\nc', 'every line ending becomes a newline');
  assert.equal(normalizeNote('tab\there\u0000nul'), 'tab\there\nnul'.replace('\n', ''), 'control characters are dropped, tabs are not');
  assert.equal(normalizeNote('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>',
    'markup is stored as text: rendering, not storage, is what keeps a note safe');
  const long = 'x'.repeat(NOTE_MAX_LENGTH + 500);
  assert.equal(normalizeNote(long).length, NOTE_MAX_LENGTH);
  assert.equal(normalizeNote(null), '');
  assert.equal(normalizeNote(42), '');
  assert.deepEqual({ ...storedUserMeta({ favorite: 'yes', note: 5, savedAt: 'not-a-date', updatedAt: 'x' }) },
    { favorite: false, note: '', savedAt: null, updatedAt: null }, 'untrusted metadata falls back to the defaults');
  assert.equal(notePreview('  line one\n\nline two  '), 'line one line two');
  assert.ok(notePreview('y'.repeat(400)).length < 200, 'a comparison shows a preview, never the whole note');
  assert.equal(notePreview(''), '');
});

test('re-promoting a road keeps the annotation a person wrote about it', async () => {
  const storage = fakeStorage();
  const candidate = promotedCandidate({});
  const store = createStore({ storage });
  store.promoteDiscoveryCandidate(candidate, candidate.id);
  store.setCandidateFavorite(candidate.id, true);
  store.setCandidateNote(candidate.id, 'Worth a second look in spring.');
  const before = store.getState().userMetaById[candidate.id];
  // The same corridor, discovered again from another search and promoted again: one candidate, same annotation.
  const again = promotedCandidate({ id: candidate.id, lat: 45.7 });
  store.promoteDiscoveryCandidate({ ...candidate, searchContext: again.searchContext }, candidate.id);
  const after = store.getState().userMetaById[candidate.id];
  assert.deepEqual({ ...after }, { ...before }, 'favorite, note and saved date are untouched');
  assert.equal(store.getState().candidates.length, 1, 'still one candidate');
  const { store: reloaded } = await reload(storage);
  assert.equal(reloaded.getState().userMetaById[candidate.id].note, 'Worth a second look in spring.');
  assert.equal(reloaded.getState().userMetaById[candidate.id].favorite, true);
});

test('removing a road removes its annotation and its comparison slot', async () => {
  const storage = fakeStorage();
  const first = promotedCandidate({ id: 'drv1-a-s1' });
  const second = promotedCandidate({ id: 'drv1-b-s1', lat: 45.7 });
  const store = createStore({ storage });
  store.promoteDiscoveryCandidate(first, first.id);
  store.promoteDiscoveryCandidate(second, second.id);
  store.setCandidateFavorite(first.id, true);
  store.setCandidateNote(first.id, 'note A');
  store.toggleSavedRoadCompare(first.id);
  store.toggleSavedRoadCompare(second.id);
  assert.equal(comparisonIds(store.getState()).length, 2);
  store.removeCandidate(first.id);
  const state = store.getState();
  assert.equal(state.userMetaById[first.id], undefined, 'no orphan annotation is left behind');
  assert.deepEqual([...state.savedRoads.compare], [second.id], 'the comparison drops the removed road');
  const entry = JSON.parse(storage.getItem(CANDIDATES_KEY));
  assert.equal(entry.candidates.length, 1);
  assert.equal(JSON.stringify(entry).includes('note A'), false);
});

// ------------------------------------------------------------------ the collection

function savedState(entries) {
  return { candidates: entries.map(entry => entry.candidate),
    durableCandidateIds: entries.map(entry => entry.candidate.id),
    userMetaById: Object.fromEntries(entries.map(entry => [entry.candidate.id, storedUserMeta(entry.meta)])) };
}

function collection() {
  const near = promotedCandidate({ id: 'drv1-near-s1' });
  const far = promotedCandidate({ id: 'drv1-far-s1', lat: 45.62 });
  const noCentre = promotedCandidate({ id: 'drv1-window-s1', context: false });
  return savedState([
    { candidate: near, meta: { favorite: true, note: 'first note', savedAt: '2026-02-02T10:00:00.000Z', updatedAt: null } },
    { candidate: far, meta: { favorite: false, note: '', savedAt: '2026-03-03T10:00:00.000Z', updatedAt: null } },
    { candidate: noCentre, meta: { favorite: false, note: 'second note', savedAt: null, updatedAt: null } },
  ]);
}

test('the collection counts, sorts and filters deterministically', () => {
  const state = collection();
  assert.deepEqual({ ...savedCounts(state) }, { total: 3, favorites: 1, noted: 2 });
  const rows = savedRoadRowsFor(state, {});
  assert.deepEqual(rows.map(row => row.candidate.id), ['drv1-far-s1', 'drv1-near-s1', 'drv1-window-s1'],
    'saved date, newest first, with an unknown saved date last');
  assert.deepEqual(savedRoadRowsFor(state, { sort: SAVED_SORTS.NAME }).map(row => row.candidate.name), ['NW Kept Rd', 'NW Kept Rd', 'NW Kept Rd'],
    'name order falls back to the id, so it is never arbitrary');
  assert.deepEqual(savedRoadRowsFor(state, { sort: SAVED_SORTS.FAVORITE }).map(row => row.candidate.id),
    ['drv1-near-s1', 'drv1-far-s1', 'drv1-window-s1'], 'favorites first, then the newest');
  assert.deepEqual(savedRoadRowsFor(state, { sort: SAVED_SORTS.DISTANCE }).map(row => row.candidate.id),
    ['drv1-near-s1', 'drv1-far-s1', 'drv1-window-s1'], 'nearest first, and a road with no search centre last');
  assert.deepEqual(savedRoadRowsFor(state, { filter: SAVED_FILTERS.FAVORITE }).map(row => row.candidate.id), ['drv1-near-s1']);
  assert.deepEqual(savedRoadRowsFor(state, { filter: SAVED_FILTERS.NOTED }).map(row => row.candidate.id).sort(), ['drv1-near-s1', 'drv1-window-s1']);
  assert.equal(savedRoadRowsFor(state, { filter: SAVED_FILTERS.ALL }).length, 3);
  assert.equal(JSON.stringify(sortSavedRoads([], SAVED_SORTS.DISTANCE)), '[]', 'an empty collection is not an error');
});

test('comparison takes two or three, refuses a fourth out loud, and follows what is saved', () => {
  const first = promotedCandidate({ id: 'drv1-a-s1' });
  const second = promotedCandidate({ id: 'drv1-b-s1', lat: 45.7 });
  const third = promotedCandidate({ id: 'drv1-c-s1', lat: 45.8 });
  const fourth = promotedCandidate({ id: 'drv1-d-s1', lat: 45.9 });
  const savedIds = [first.id, second.id, third.id, fourth.id];
  let compare = [];
  for (const id of [first.id, second.id, third.id]) {
    const outcome = nextComparison(compare, id, { savedIds });
    assert.equal(outcome.changed, true);
    compare = outcome.compare;
  }
  assert.equal(compare.length, MAX_COMPARISON);
  const refused = nextComparison(compare, fourth.id, { savedIds });
  assert.equal(refused.changed, false);
  assert.equal(refused.reason, COMPARISON_LIMIT_REASON);
  assert.match(refused.reason, /Up to 3 saved roads/);
  assert.deepEqual([...refused.compare], compare, 'the fourth attempt changes nothing');
  // Toggling the second one off frees the slot, and a road that is not saved cannot be compared.
  const removed = nextComparison(compare, second.id, { savedIds });
  assert.deepEqual([...removed.compare], [first.id, third.id]);
  assert.equal(nextComparison(compare, 'not-saved', { savedIds }).changed, false);
  // A comparison selection always matches what is saved: an id that is gone simply drops out.
  const state = { candidates: [first, third], durableCandidateIds: [first.id, third.id],
    userMetaById: {}, savedRoads: { compare: [first.id, second.id, third.id], sort: SAVED_SORTS.SAVED, filter: SAVED_FILTERS.ALL } };
  assert.deepEqual([...comparisonIds(state)], [first.id, third.id]);
  assert.equal(comparisonSelection(state).length, 2);
});

// ------------------------------------------------------------------ comparison

test('a comparison lists facts, says what this session has not measured, and never ranks', () => {
  const near = promotedCandidate({ id: 'drv1-near-s1' });
  const window = promotedCandidate({ id: 'drv1-window-s1', context: false });
  const selection = [
    { candidate: near, meta: { favorite: true, note: 'Looks like a good early-morning loop.\nCheck the north after rain.', savedAt: '2026-02-02T10:00:00.000Z', updatedAt: null } },
    { candidate: window, meta: { favorite: false, note: '', savedAt: null, updatedAt: null } },
  ];
  const dimensions = comparisonDimensions(selection, {});
  const byId = Object.fromEntries(dimensions.map(row => [row.id, row]));
  for (const id of ['road', 'length', 'class', 'status', 'favorite', 'saved', 'note', 'origin', 'coverage']) {
    assert.ok(byId[id], `the comparison shows ${id}`);
  }
  assert.equal(byId.road.values.length, 2, 'one column per candidate, in the selection order');
  assert.match(byId.length.values[0], /^[0-9.]+ mi$/);
  assert.equal(byId.favorite.values[0], 'Yes');
  assert.equal(byId.favorite.values[1], 'No');
  assert.match(byId.origin.label, /From original search centre/, 'the row names the origin it measured from');
  assert.match(byId.origin.values[0], /of Near Vernonia, OR$/);
  assert.equal(byId.origin.values[1], 'No original search centre');
  assert.equal(byId.saved.values[1], 'Saved date unknown', 'an unknown saved date is stated, not invented');
  assert.equal(byId.note.values[1], 'No note');
  assert.ok(byId.note.values[0].length < 200, 'a note appears as a short preview');
  // Nothing was measured in this session, so nothing claims a zero.
  const sessionRows = dimensions.filter(row => row.kind === 'session');
  assert.deepEqual(sessionRows.map(row => row.id), ['ecology', 'wetlands', 'hydrography', 'occurrence', 'access']);
  assert.equal(byId.wetlands.values[0], 'Not measured this session');
  assert.equal(byId.occurrence.values[0], 'Not queried this session');
  assert.equal(byId.access.values[0], 'Not investigated this session');
  // Session measurements appear only when they genuinely exist, and a partial one says so.
  const measured = comparisonDimensions(selection, {
    [near.id]: { ecology: { coverage: COVERAGE.FULL, level3: { primary: { code: '3', name: 'Willamette Valley' } },
      level4: { primary: { code: '3a', name: 'Portland/Vancouver Basin' } } },
      habitat: { wetlands: { coverage: COVERAGE.PARTIAL, buffers: { 250: { areaM2: 2131600, lengthM: 0, featureCount: 108, breakdown: [] } } },
        hydrography: { coverage: COVERAGE.FULL, crossingCount: 2, buffers: { 1000: { areaM2: 0, lengthM: 4500, featureCount: 9, breakdown: [] } } } },
      occurrence: { coverage: COVERAGE.UNKNOWN }, access: { access: { finding: 'UNVERIFIED', coverage: COVERAGE.PARTIAL } } },
  });
  const measuredById = Object.fromEntries(measured.map(row => [row.id, row]));
  assert.match(measuredById.ecology.values[0], /Willamette Valley \(3\)/);
  assert.match(measuredById.wetlands.values[0], /Partial coverage/);
  assert.match(measuredById.wetlands.values[0], /213\.2 ha within 250 m/);
  assert.match(measuredById.hydrography.values[0], /4\.50 km within 1 km/);
  assert.equal(measuredById.occurrence.values[0], 'Unknown', 'an unavailable source is unknown, never zero');
  assert.match(measuredById.access.values[0], /UNVERIFIED/);
  assert.equal(measuredById.wetlands.values[1], 'Not measured this session', 'the other column stays honest');
  // No dimension is a verdict.
  const text = JSON.stringify(dimensions).toLowerCase();
  for (const forbidden of ['winner', 'best', 'score', 'rank', 'recommend']) {
    assert.equal(text.includes(forbidden), false, `the comparison must not say "${forbidden}"`);
  }
});

test('an annotation never reaches the evidence bundle', () => {
  const candidate = promotedCandidate({});
  const bundle = buildCorridorBundle({ candidate, roads: candidate.roads,
    userMeta: { favorite: true, note: 'A private note about this road.' } });
  const text = JSON.stringify(bundle);
  assert.equal(text.includes('A private note about this road.'), false, 'the note stays on this device');
  assert.equal(text.includes('userMeta'), false);
  assert.equal(bundle.corridor.userMeta, undefined);
  assert.equal(bundle.corridor.favorite, undefined);
  assert.ok(bundle.corridor.declaredEvidence.length, 'the bundle still carries the candidate evidence it always did');
});

test('a note that could not be written says so, and is not claimed as saved', () => {
  const storage = fakeStorage();
  const candidate = promotedCandidate({});
  const store = createStore({ storage });
  store.promoteDiscoveryCandidate(candidate, candidate.id);
  const before = storage.getItem(CANDIDATES_KEY);
  // A device whose storage is full or blocked: the annotation is real in this session, and the write fails.
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  store.setCandidateNote(candidate.id, 'typed while storage was full');
  const state = store.getState();
  assert.equal(state.userMetaById[candidate.id].note, 'typed while storage was full', 'the note is not discarded');
  assert.equal(state.candidateStorage.status, CANDIDATE_STORAGE_STATUS.UNAVAILABLE);
  assert.match(state.candidateStorage.reason, /could not be saved on this device/);
  assert.equal(storage.entries.get(CANDIDATES_KEY) ?? before, before, 'and the stored entry is unchanged');
  // A storage-less browser is the same honest answer.
  const offline = createStore({ storage: null });
  offline.promoteDiscoveryCandidate(promotedCandidate({}), 'drv1-kept-rd-s1');
  assert.equal(offline.getState().candidateStorage.status, CANDIDATE_STORAGE_STATUS.UNAVAILABLE);
});

test('the cap and the storage budget survive a full set of notes', () => {
  const storage = fakeStorage();
  const template = promotedCandidate({});
  const note = 'n'.repeat(NOTE_MAX_LENGTH);
  const many = count => Array.from({ length: count }, (_, index) => createCandidate({ ...template, id: `saved-${index}` }));
  const measured = [[10, 'no notes', {}], [10, 'maximum note', undefined], [50, 'maximum note', undefined], [100, 'maximum note', undefined]];
  for (const [count, label, meta] of measured) {
    const candidates = many(count);
    const userMetaById = meta === undefined
      ? Object.fromEntries(candidates.map(candidate => [candidate.id, { favorite: indexOf(candidate) % 2 === 0, note }]))
      : meta;
    const written = writeStoredCandidates(candidates, { storage, savedAt: 'fixed', userMetaById });
    assert.equal(written.ok, true);
    console.log(`SAVED_ROADS_SIZE ${JSON.stringify({ count, notes: label, bytes: written.bytes })}`);
    assert.ok(written.bytes < 5 * 1024 * 1024, 'a full collection with maximum notes stays inside a localStorage budget');
  }
  const over = writeStoredCandidates(many(MAX_PERSISTED_CANDIDATES + 1), { storage });
  assert.equal(over.ok, false);
  assert.match(over.reason, /maximum of 100 saved candidates/);
  function indexOf(candidate) { return Number(String(candidate.id).replace('saved-', '')); }
});

test('restoring saved roads with their annotations still touches nothing but storage', async () => {
  const storage = fakeStorage();
  const candidate = promotedCandidate({});
  const store = createStore({ storage });
  store.promoteDiscoveryCandidate(candidate, candidate.id);
  store.setCandidateFavorite(candidate.id, true);
  store.setCandidateNote(candidate.id, 'kept for spring');
  const { store: reloaded } = await reload(storage);
  const state = reloaded.getState();
  assert.equal(state.userMetaById[candidate.id].note, 'kept for spring');
  assert.equal(state.userMetaById[candidate.id].favorite, true);
  // No analysis is run to restore a saved road, and no per-session result is invented for it.
  assert.deepEqual(state.ecologyByCandidate, {});
  assert.deepEqual(state.habitatByCandidate, {});
  assert.deepEqual(state.occurrenceByCandidate, {});
  assert.deepEqual(state.investigationByCandidate, {});
  assert.equal(state.restoredCandidateIds.length, 1);
  assert.equal(state.selectedId, candidate.id, 'a saved road is ready to inspect without running discovery');
  // Opening the saved collection changes no measurement and no candidate fact.
  reloaded.setSavedRoadsSort(SAVED_SORTS.NAME);
  reloaded.setSavedRoadsFilter(SAVED_FILTERS.FAVORITE);
  reloaded.toggleSavedRoadCompare(candidate.id);
  assert.equal(reloaded.getState().candidates[0].corridor.lengthM, candidate.corridor.lengthM);
  assert.deepEqual(reloaded.getState().candidates[0].coverage, candidate.coverage);
  assert.equal(reloaded.getState().candidateStorage.status, CANDIDATE_STORAGE_STATUS.RESTORED,
    'arranging the collection is not a write');
});
