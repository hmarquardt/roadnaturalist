import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COVERAGE, COVERAGE_DATASET, createCandidate, setCandidateCoverage } from '../src/domain/corridor.js';
import { CANDIDATES_KEY, CANDIDATES_KIND, CANDIDATES_SCHEMA_VERSION, CANDIDATE_STORAGE_STATUS,
  MAX_PERSISTED_CANDIDATES, PERSISTED_CANDIDATE_FIELDS, PERSISTED_RECORD_FIELDS, persistedCandidateRecord, readStoredCandidates,
  restoreCandidateRecord, writeStoredCandidates } from '../src/state/candidate-persistence.js';
import { createStore } from '../src/state/store.js';
import { buildDiscoveryResult } from '../src/discovery/signals.js';
import { buildDiscoveryUnits } from '../src/discovery/units.js';
import { segmentUnit } from '../src/discovery/segment.js';
import { promoteDiscoveryResult } from '../src/discovery/lifecycle.js';
import { corridorContextFromCenter, pendingSearchContext, CENTER_LABEL_KIND } from '../src/discovery/search-context.js';
import { buildCorridorBundle, validateBundle } from '../src/investigator/bundle.js';

// CANDIDATES KEPT ON THIS DEVICE.
//
// One versioned localStorage entry holds the durable candidate state: identity, the road records and corridor
// geometry, coverage, status, the candidate's own evidence, and the verified search context. These tests hold the
// promises that makes: a promoted corridor comes back after a reload with the same id and context, a decision and
// a measured coverage survive, removal is durable, and nothing about storage - corruption, an unknown version, a
// full quota - can cost a person anything except the entry that caused it.
const LON_PER_M = 1 / (111320 * Math.cos(45.5 * Math.PI / 180));
const CENTER = [-122.9, 45.55];

function fakeStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: key => { entries.delete(key); },
  };
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

// A promoted candidate the way the application builds one: a real discovery result, its road features, the raw
// corridor, and - when asked for - the verified search context.
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
  return { candidate, feature, corridor, unit };
}

// ------------------------------------------------------------------ the entry

test('a promoted candidate round-trips through one versioned entry', () => {
  const { candidate } = promotedCandidate({});
  const storage = fakeStorage();
  const written = writeStoredCandidates([candidate], { storage, savedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(written.ok, true);
  assert.equal(written.status, CANDIDATE_STORAGE_STATUS.SAVED);
  assert.ok(written.bytes > 0);
  const entry = JSON.parse(storage.getItem(CANDIDATES_KEY));
  assert.equal(entry.kind, CANDIDATES_KIND);
  assert.equal(entry.version, CANDIDATES_SCHEMA_VERSION);
  assert.equal(entry.savedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(entry.candidates.length, 1);
  const read = readStoredCandidates(storage);
  assert.equal(read.status, CANDIDATE_STORAGE_STATUS.RESTORED);
  assert.equal(read.savedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(read.skipped.length, 0);
  assert.equal(read.bytes, written.bytes);
  assert.equal(read.candidates.length, 1);
  const restored = read.candidates[0];
  assert.equal(restored.id, candidate.id, 'the identity is the one that was promoted');
  assert.equal(restored.name, candidate.name);
  assert.equal(restored.status, candidate.status);
  assert.equal(restored.summary, candidate.summary);
  assert.equal(restored.dataCatalogUrl, candidate.dataCatalogUrl);
  assert.deepEqual(restored.geometry, candidate.geometry, 'the corridor that is drawn and measured comes back');
  assert.ok(Math.abs(restored.corridor.lengthM - candidate.corridor.lengthM) < 1e-6);
  assert.equal(restored.corridor.roadCount, candidate.corridor.roadCount);
  assert.deepEqual(restored.roads.map(road => road.id), candidate.roads.map(road => road.id));
  assert.equal(restored.roads[0].provenance.organization, candidate.roads[0].provenance.organization);
  assert.equal(restored.evidence.length, candidate.evidence.length);
  assert.match(restored.evidence[0].statement, /Candidate discovery proposed this corridor/);
  assert.deepEqual([...restored.questions], [...candidate.questions]);
  assert.deepEqual(Object.keys(restored.coverage).sort(), Object.keys(candidate.coverage).sort());
  assert.equal(restored.coverage[COVERAGE_DATASET.ROAD_GEOMETRY].coverage, candidate.coverage[COVERAGE_DATASET.ROAD_GEOMETRY].coverage);
  assert.deepEqual(restored.searchContext, candidate.searchContext, 'the verified search context is history, not a fresh inference');
  assert.equal(restored.searchContext.centerLabel, 'Near Vernonia, OR');
});

test('the record carries exactly the durable candidate fields and nothing else', () => {
  const { candidate } = promotedCandidate({});
  const record = persistedCandidateRecord(candidate);
  assert.deepEqual(Object.keys(record).sort(), [...PERSISTED_RECORD_FIELDS].sort());
  // The annotation rides beside the candidate and never inside it.
  assert.deepEqual(Object.keys(record.userMeta).sort(), ['favorite', 'note', 'savedAt', 'updatedAt']);
  assert.equal(restoreCandidateRecord(record).candidate.userMeta, undefined);
  assert.equal(JSON.stringify(persistedCandidateRecord(candidate)), JSON.stringify(record),
    'the same candidate serializes to the same bytes');
  const storage = fakeStorage();
  writeStoredCandidates([candidate], { storage, savedAt: 'fixed' });
  writeStoredCandidates([candidate], { storage, savedAt: 'fixed' });
  const first = storage.getItem(CANDIDATES_KEY);
  writeStoredCandidates([candidate], { storage, savedAt: 'fixed' });
  assert.equal(storage.getItem(CANDIDATES_KEY), first, 'identical state and timestamp write identical bytes');
  // A record with fields this build does not model is cleaned on the way in, not spread into the candidate.
  const injected = { ...record, savedAt: '2026-01-01', selected: true, transientError: 'boom', habitat: { big: 'payload' } };
  const restored = restoreCandidateRecord(injected);
  assert.equal(restored.ok, true);
  for (const key of ['savedAt', 'selected', 'transientError', 'habitat']) assert.equal(restored.candidate[key], undefined, `${key} must not enter the candidate`);
});

test('an empty store writes nothing and reads as empty', () => {
  const storage = fakeStorage();
  const written = writeStoredCandidates([], { storage });
  assert.equal(written.ok, true);
  assert.equal(storage.getItem(CANDIDATES_KEY), null, 'no candidates means no entry, not an empty one');
  const read = readStoredCandidates(storage);
  assert.equal(read.status, CANDIDATE_STORAGE_STATUS.EMPTY);
  assert.deepEqual(read.candidates, []);
  assert.equal(read.skipped.length, 0);
});

// ------------------------------------------------------------------ untrusted storage

test('every field of a stored record is validated before it becomes a candidate', () => {
  const { candidate } = promotedCandidate({});
  const record = persistedCandidateRecord(candidate);
  const rejects = [
    [null, /not an object/],
    ['a string', /not an object/],
    [[], /not an object/],
    [{ ...record, id: '' }, /no candidate id/],
    [{ ...record, id: 42 }, /no candidate id/],
    [{ ...record, status: 'MAYBE' }, /unknown candidate status/],
    [{ ...record, status: undefined }, /unknown candidate status/],
    [{ ...record, name: '' }, /no name/],
    [{ ...record, roads: [] }, /no usable road records/],
    [{ ...record, roads: 'roads' }, /no usable road records/],
    [{ ...record, roads: [{ id: 'road-without-geometry' }] }, /no usable road records/],
    [{ ...record, roads: [{ ...record.roads[0], geometry: { type: 'Point', coordinates: [0, 0] } }] }, /No line geometry to merge/],
    [{ ...record, evidence: [{ kind: 'LOCAL', statement: 'Unattributed', coverage: 'FULL' }] }, /Evidence requires/],
    [{ ...record, questions: 'no' }, null],
  ];
  for (const [damaged, pattern] of rejects) {
    const restored = restoreCandidateRecord(damaged);
    if (pattern === null) { assert.equal(restored.ok, true, 'a wrong-typed optional field is normalized, not fatal'); continue; }
    assert.equal(restored.ok, false, `expected a refusal for ${JSON.stringify(damaged)?.slice(0, 60)}`);
    assert.match(restored.reason, pattern);
  }
  // A coverage claim this build does not know keeps that dataset UNKNOWN rather than entering the candidate, and
  // the rest of the candidate still loads.
  const unknownCoverage = restoreCandidateRecord({ ...record,
    coverage: { [COVERAGE_DATASET.WETLANDS]: { coverage: 'MAYBE', reason: 'made up' } } });
  assert.equal(unknownCoverage.ok, true);
  assert.equal(unknownCoverage.candidate.coverage[COVERAGE_DATASET.WETLANDS].coverage, COVERAGE.UNKNOWN);
  assert.equal(unknownCoverage.candidate.coverage[COVERAGE_DATASET.WETLANDS].reason, 'Not yet analyzed');
  // A search context that does not validate is dropped, not repaired: the candidate is still worth keeping.
  const badContext = restoreCandidateRecord({ ...record, searchContext: { center: ['north', 1], distanceFromCenterM: 'far' } });
  assert.equal(badContext.ok, true);
  assert.equal(badContext.candidate.searchContext, null);
});

test('one unreadable record costs only itself, and a read writes nothing', () => {
  const storage = fakeStorage();
  const one = promotedCandidate({ id: 'drv1-kept-rd-s1' }).candidate;
  const two = promotedCandidate({ id: 'drv1-second-rd-s1', lat: 45.6 }).candidate;
  const records = [persistedCandidateRecord(one), { ...persistedCandidateRecord(two), status: 'WHATEVER' }, persistedCandidateRecord(two)];
  storage.setItem(CANDIDATES_KEY, JSON.stringify({ kind: CANDIDATES_KIND, version: CANDIDATES_SCHEMA_VERSION, savedAt: 'saved', candidates: records }));
  const before = storage.getItem(CANDIDATES_KEY);
  const read = readStoredCandidates(storage);
  assert.equal(read.candidates.length, 2, 'the readable candidates come back');
  assert.deepEqual(read.candidates.map(candidate => candidate.id), [one.id, two.id]);
  assert.equal(read.skipped.length, 1);
  assert.equal(read.skipped[0].id, two.id);
  assert.match(read.skipped[0].reason, /unknown candidate status/);
  assert.equal(storage.getItem(CANDIDATES_KEY), before, 'reading never rewrites what it could not read');
  // The same candidate id twice is one candidate, and the second copy is reported rather than merged silently.
  storage.setItem(CANDIDATES_KEY, JSON.stringify({ kind: CANDIDATES_KIND, version: CANDIDATES_SCHEMA_VERSION, candidates: [persistedCandidateRecord(one), persistedCandidateRecord(one)] }));
  const duplicated = readStoredCandidates(storage);
  assert.equal(duplicated.candidates.length, 1);
  assert.match(duplicated.skipped[0].reason, /appears twice/);
});

test('a foreign or future entry is ignored, and never rewritten', () => {
  const { candidate } = promotedCandidate({});
  const record = persistedCandidateRecord(candidate);
  const cases = [
    ['{ not json', /could not be read/],
    [JSON.stringify({ kind: 'something-else', version: 1, candidates: [record] }), /not a candidate record/],
    [JSON.stringify({ kind: CANDIDATES_KIND, version: CANDIDATES_SCHEMA_VERSION + 1, candidates: [record] }), new RegExp(`version ${CANDIDATES_SCHEMA_VERSION + 1}`)],
    [JSON.stringify({ kind: CANDIDATES_KIND, version: CANDIDATES_SCHEMA_VERSION, candidates: 'many' }), null],
  ];
  for (const [text, pattern] of cases) {
    const storage = fakeStorage({ [CANDIDATES_KEY]: text });
    const read = readStoredCandidates(storage);
    assert.equal(read.status, CANDIDATE_STORAGE_STATUS.UNSUPPORTED, `expected an unsupported read for ${text.slice(0, 40)}`);
    assert.deepEqual(read.candidates, []);
    if (pattern) assert.match(read.reason, pattern);
    assert.equal(storage.getItem(CANDIDATES_KEY), text, 'an entry this build does not read is left exactly as it was');
  }
  // A supported version with no readable candidates at all is empty, not unsupported.
  const storage = fakeStorage({ [CANDIDATES_KEY]: JSON.stringify({ kind: CANDIDATES_KIND, version: CANDIDATES_SCHEMA_VERSION, candidates: [] }) });
  assert.equal(readStoredCandidates(storage).status, CANDIDATE_STORAGE_STATUS.EMPTY);
});

test('a blocked, missing or full storage is reported, never thrown', () => {
  const { candidate } = promotedCandidate({});
  const throwingWrite = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError: the quota has been exceeded.'); }, removeItem: () => {} };
  const refused = writeStoredCandidates([candidate], { storage: throwingWrite });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, CANDIDATE_STORAGE_STATUS.UNAVAILABLE);
  assert.match(refused.reason, /QuotaExceededError/);
  const throwingRead = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => {}, removeItem: () => {} };
  const unreadable = readStoredCandidates(throwingRead);
  assert.equal(unreadable.status, CANDIDATE_STORAGE_STATUS.UNSUPPORTED);
  assert.deepEqual(unreadable.candidates, []);
  // No storage at all (a browser that blocks it): candidates live for the session and the reason says so.
  assert.equal(writeStoredCandidates([candidate], { storage: null }).status, CANDIDATE_STORAGE_STATUS.UNAVAILABLE);
  assert.equal(readStoredCandidates(null).status, CANDIDATE_STORAGE_STATUS.UNAVAILABLE);
  assert.match(readStoredCandidates(null).reason, /no local storage/);
});

test('the cap refuses another save instead of evicting a kept candidate', () => {
  const storage = fakeStorage();
  const { candidate } = promotedCandidate({});
  const many = (count, idPrefix = 'drv1-kept-rd') => Array.from({ length: count }, (_, index) =>
    createCandidate({ ...candidate, id: `${idPrefix}-${index}` }));
  const full = writeStoredCandidates(many(MAX_PERSISTED_CANDIDATES), { storage, savedAt: 'full-set' });
  assert.equal(full.ok, true);
  const before = storage.getItem(CANDIDATES_KEY);
  const refused = writeStoredCandidates(many(MAX_PERSISTED_CANDIDATES + 1), { storage, savedAt: 'over-the-cap' });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, CANDIDATE_STORAGE_STATUS.FULL);
  assert.equal(refused.bytes, 0);
  assert.match(refused.reason, new RegExp(`maximum of ${MAX_PERSISTED_CANDIDATES} saved candidates`));
  assert.equal(storage.getItem(CANDIDATES_KEY), before, 'nothing was written and nothing was dropped');
  assert.equal(readStoredCandidates(storage).candidates.length, MAX_PERSISTED_CANDIDATES);
  assert.equal(MAX_PERSISTED_CANDIDATES, 100, 'the cap is a decided number, not whatever fits');
});

// ------------------------------------------------------------------ lifecycle

// A reload, as the application performs it: one store promotes and writes, a second store reads and hydrates.
function reload(storage) {
  const store = createStore({ storage });
  const restored = store.restoreCandidates();
  return { store, restored };
}

test('a promoted candidate is written and comes back after a reload, unchanged', () => {
  const storage = fakeStorage();
  const { candidate } = promotedCandidate({});
  const before = createStore({ storage });
  before.promoteDiscoveryCandidate(candidate, candidate.id);
  const saved = before.getState().candidateStorage;
  assert.equal(saved.status, CANDIDATE_STORAGE_STATUS.SAVED);
  assert.equal(saved.persisted, 1);
  assert.ok(saved.bytes > 0);
  assert.deepEqual(before.getState().durableCandidateIds, [candidate.id]);
  assert.equal(before.getState().restoredCandidateIds.length, 0, 'nothing is restored in the session that promoted it');
  const { store, restored } = reload(storage);
  assert.equal(restored.candidates.length, 1);
  const state = store.getState();
  assert.equal(state.candidates.length, 1);
  const reloaded = state.candidates[0];
  assert.equal(reloaded.id, candidate.id, 'the candidate is the same candidate, not a new one');
  assert.deepEqual(reloaded.geometry, candidate.geometry);
  assert.equal(reloaded.status, candidate.status);
  assert.deepEqual(reloaded.searchContext, candidate.searchContext);
  assert.equal(reloaded.searchContext.centerLabel, 'Near Vernonia, OR');
  assert.equal(state.selectedId, candidate.id, 'the restored candidate is on screen without running discovery');
  assert.deepEqual(state.restoredCandidateIds, [candidate.id]);
  assert.deepEqual(state.durableCandidateIds, [candidate.id]);
  assert.equal(state.candidateStorage.status, CANDIDATE_STORAGE_STATUS.RESTORED);
  assert.equal(state.candidateStorage.skipped.length, 0);
  // The road records the panel needs come back with it, and no detailed analysis was run to get them.
  assert.deepEqual(state.roadsByCandidate[candidate.id].map(road => road.id), candidate.roads.map(road => road.id));
  assert.deepEqual(state.ecologyByCandidate, {});
  assert.deepEqual(state.habitatByCandidate, {});
  assert.deepEqual(state.investigationByCandidate, {});
});

test('a decision and a coverage state that detailed analysis narrowed survive a reload', () => {
  const storage = fakeStorage();
  const { candidate } = promotedCandidate({});
  const before = createStore({ storage });
  before.promoteDiscoveryCandidate(candidate, candidate.id);
  before.decide(candidate.id, 'shortlisted');
  before.setCoverage(candidate.id, COVERAGE_DATASET.WETLANDS, { coverage: COVERAGE.PARTIAL, reason: 'the corridor leaves the wetland extract' });
  assert.equal(before.getState().candidateStorage.status, CANDIDATE_STORAGE_STATUS.SAVED);
  const { store } = reload(storage);
  const reloaded = store.getState().candidates[0];
  assert.equal(reloaded.status, 'shortlisted', 'a restored candidate is not reset to its discovered status');
  assert.equal(reloaded.coverage[COVERAGE_DATASET.WETLANDS].coverage, COVERAGE.PARTIAL);
  assert.equal(reloaded.coverage[COVERAGE_DATASET.WETLANDS].reason, 'the corridor leaves the wetland extract');
  assert.equal(reloaded.coverage[COVERAGE_DATASET.ROAD_GEOMETRY].coverage, candidate.coverage[COVERAGE_DATASET.ROAD_GEOMETRY].coverage);
  // A status change on a candidate this device keeps is written at the moment it happens.
  store.decide(reloaded.id, 'rejected');
  assert.equal(reload(storage).store.getState().candidates[0].status, 'rejected');
});

test('removal takes the candidate and its session results off this device, and stays removed', () => {
  const storage = fakeStorage();
  const first = promotedCandidate({ id: 'drv1-kept-rd-s1' }).candidate;
  const second = promotedCandidate({ id: 'drv1-second-rd-s1', lat: 45.62 }).candidate;
  const before = createStore({ storage });
  before.promoteDiscoveryCandidate(first, first.id);
  before.promoteDiscoveryCandidate(second, second.id);
  before.setHabitatResult(first.id, { diagnostics: { status: 'ready' } });
  before.setEcologyResult(first.id, { coverage: COVERAGE.FULL });
  assert.equal(before.getState().candidates.length, 2);
  const selected = before.removeCandidate(first.id);
  assert.equal(selected, second.id, 'the selection moves to a candidate that is still here');
  const state = before.getState();
  assert.deepEqual(state.candidates.map(candidate => candidate.id), [second.id]);
  assert.deepEqual(state.durableCandidateIds, [second.id]);
  assert.equal(state.roadsByCandidate[first.id], undefined);
  assert.equal(state.habitatByCandidate[first.id], undefined);
  assert.equal(state.ecologyByCandidate[first.id], undefined);
  assert.equal(state.candidateStorage.persisted, 1);
  const { store } = reload(storage);
  assert.deepEqual(store.getState().candidates.map(candidate => candidate.id), [second.id]);
  assert.equal(store.getState().selectedId, second.id);
  assert.equal(before.removeCandidate('not-a-candidate'), null);
});

test('only promoted corridors are kept: the pilot is merged, never written', () => {
  const storage = fakeStorage();
  const { candidate } = promotedCandidate({});
  const pilot = createCandidate({ id: 'pilot-1', name: 'Oregon pilot corridor', status: 'discovered',
    geometry: { type: 'LineString', coordinates: [[-122.6, 45.6], [-122.59, 45.61]] } });
  const store = createStore({ storage });
  store.loadPilot({ pilotId: 'oregon-pilot', candidates: [pilot], roadsByCandidate: { [pilot.id]: [] } });
  assert.equal(storage.getItem(CANDIDATES_KEY), null, 'a hand-declared pilot corridor is not written to this device');
  store.promoteDiscoveryCandidate(candidate, candidate.id);
  const { store: reloaded } = reload(storage);
  assert.deepEqual(reloaded.getState().candidates.map(item => item.id), [candidate.id]);
  // Opening the pilot in that session adds its corridors to the list without disturbing what was restored.
  reloaded.loadPilot({ pilotId: 'oregon-pilot', candidates: [pilot], roadsByCandidate: { [pilot.id]: [] } });
  assert.deepEqual(reloaded.getState().candidates.map(item => item.id), [candidate.id, pilot.id]);
  assert.equal(reloaded.getState().selectedId, pilot.id, 'opening the pilot selects its first corridor, as before');
  assert.deepEqual(reloaded.getState().durableCandidateIds, [candidate.id], 'the pilot corridor is still not durable');
});

test('re-promoting a corridor keeps one candidate, and a search never rewrites its context', () => {
  const storage = fakeStorage();
  const first = promotedCandidate({});
  const store = createStore({ storage });
  store.promoteDiscoveryCandidate(first.candidate, first.candidate.id);
  const original = store.getState().candidates[0].searchContext;
  // Another search runs, the centre moves, another place is chosen: the stored candidate's history is untouched.
  store.setSearchDefinition({ center: [-123.17, 45.54], radiusMiles: 10, bounds: [-123.5, 45.2, -122.9, 45.9], radiusM: 16093.44 });
  store.setSearchSelection({ areaId: 'custom-radius', definition: { center: [-123.17, 45.54], radiusMiles: 10 } });
  assert.deepEqual(store.getState().candidates[0].searchContext, original);
  // Promoting the same corridor from the new search replaces it: one candidate, and the context of the promotion
  // the person actually performed.
  const again = promotedCandidate({ context: false });
  const elsewhere = corridorContextFromCenter([-123.17, 45.54], again.corridor.geometry);
  const context = pendingSearchContext({ center: [-123.17, 45.54], radiusMiles: 10, centerLabel: 'Near Forest Grove, OR',
    centerLabelKind: CENTER_LABEL_KIND.NEAR_PLACE, distanceFromCenterM: elsewhere.distanceM,
    nearestCenterPoint: elsewhere.nearestPoint, bearingFromCenterDeg: elsewhere.bearingDeg, cardinalFromCenter: elsewhere.cardinal });
  store.promoteDiscoveryCandidate({ ...again.candidate, searchContext: context }, again.candidate.id);
  assert.equal(store.getState().candidates.length, 1, 'the same corridor is one candidate, not a copy');
  assert.equal(store.getState().candidates[0].searchContext.centerLabel, 'Near Forest Grove, OR');
  assert.equal(store.getState().durableCandidateIds.length, 1);
  assert.equal(readStoredCandidates(storage).candidates.length, 1);
  assert.equal(readStoredCandidates(storage).candidates[0].searchContext.centerLabel, 'Near Forest Grove, OR');
});

test('a candidate promoted from a declared window keeps its absent context across a reload', () => {
  const storage = fakeStorage();
  const { candidate } = promotedCandidate({ context: false });
  assert.equal(candidate.searchContext, null);
  const store = createStore({ storage });
  store.promoteDiscoveryCandidate(candidate, candidate.id);
  const { store: reloaded } = reload(storage);
  const restored = reloaded.getState().candidates[0];
  assert.equal(restored.searchContext, null, 'no centre was invented for a declared window');
  assert.equal(restored.id, candidate.id);
  assert.deepEqual(restored.geometry, candidate.geometry);
});

test('a refused save leaves the candidate usable and says plainly that it was not saved', () => {
  // The cap: a device that already holds the maximum keeps what it has and refuses the next save.
  const full = fakeStorage();
  const { candidate } = promotedCandidate({});
  writeStoredCandidates(Array.from({ length: MAX_PERSISTED_CANDIDATES }, (_, index) => createCandidate({ ...candidate, id: `kept-${index}` })), { storage: full });
  const before = full.getItem(CANDIDATES_KEY);
  const store = createStore({ storage: full });
  store.restoreCandidates();
  const extra = promotedCandidate({ id: 'drv1-one-too-many-s1', lat: 45.64 }).candidate;
  store.promoteDiscoveryCandidate(extra, extra.id);
  const state = store.getState();
  assert.ok(state.candidates.some(item => item.id === extra.id), 'the candidate exists in this session');
  assert.equal(state.candidateStorage.status, CANDIDATE_STORAGE_STATUS.FULL);
  assert.match(state.candidateStorage.reason, /maximum of 100 saved candidates/);
  assert.equal(state.candidateStorage.persisted, MAX_PERSISTED_CANDIDATES, 'the device holds what it held, not what was refused');
  assert.equal(full.getItem(CANDIDATES_KEY), before, 'nothing was evicted to make room');
  // A blocked or full quota reports the same way, and the candidate is still real.
  const blocked = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} };
  const blockedStore = createStore({ storage: blocked });
  blockedStore.promoteDiscoveryCandidate(candidate, candidate.id);
  assert.equal(blockedStore.getState().candidateStorage.status, CANDIDATE_STORAGE_STATUS.UNAVAILABLE);
  assert.match(blockedStore.getState().candidateStorage.reason, /could not be saved on this device/);
  assert.equal(blockedStore.getState().candidates.length, 1);
});

test('restoring reports the records it could not read and keeps the ones it could', () => {
  const storage = fakeStorage();
  const one = promotedCandidate({ id: 'drv1-kept-rd-s1' }).candidate;
  const two = promotedCandidate({ id: 'drv1-second-rd-s1', lat: 45.6 }).candidate;
  storage.setItem(CANDIDATES_KEY, JSON.stringify({ kind: CANDIDATES_KIND, version: CANDIDATES_SCHEMA_VERSION, savedAt: 'saved',
    candidates: [persistedCandidateRecord(one), { id: 'broken', name: 'Broken', status: 'discovered' }, persistedCandidateRecord(two)] }));
  const store = createStore({ storage });
  const restored = store.restoreCandidates();
  assert.deepEqual(store.getState().candidates.map(candidate => candidate.id), [one.id, two.id]);
  assert.equal(restored.skipped.length, 1);
  assert.equal(store.getState().candidateStorage.skipped.length, 1);
  assert.equal(store.getState().candidateStorage.skipped[0].id, 'broken');
  assert.match(store.getState().candidateStorage.skipped[0].reason, /no usable road records/);
  assert.equal(store.getState().candidateStorage.status, CANDIDATE_STORAGE_STATUS.RESTORED);
  assert.equal(store.getState().candidateStorage.bytes, storage.getItem(CANDIDATES_KEY).length);
});

test('it never disturbs the other device-local entries', () => {
  // The discovery marks, the last search and the search history keep their own entries. Restoring candidates
  // reads and writes exactly one key, and a boot keeps working when that key is missing or unreadable.
  const storage = fakeStorage({
    'roadnaturalist.discovery.marks.v1': JSON.stringify({ kind: 'roadnaturalist-discovery-marks', version: 1, marks: { 'drv1-a': 'PROMOTED' } }),
    'roadnaturalist.discovery.search.v1': JSON.stringify({ kind: 'roadnaturalist-discovery-search', version: 1,
      definition: { center: [-122.9, 45.55], radiusMiles: 10 } }),
    'someone-elses-key': 'kept',
  });
  const store = createStore({ storage });
  const restored = store.restoreCandidates();
  assert.deepEqual(restored.candidates, []);
  assert.equal(restored.status, CANDIDATE_STORAGE_STATUS.EMPTY);
  assert.equal(storage.getItem('roadnaturalist.discovery.marks.v1'), JSON.stringify({ kind: 'roadnaturalist-discovery-marks', version: 1, marks: { 'drv1-a': 'PROMOTED' } }));
  assert.equal(storage.getItem('someone-elses-key'), 'kept');
  assert.equal(storage.getItem(CANDIDATES_KEY), null, 'no candidate entry is created by reading');
  // A malformed candidate entry does not stop the other entries being usable either.
  storage.setItem(CANDIDATES_KEY, '{oops');
  const damaged = createStore({ storage });
  assert.equal(damaged.restoreCandidates().status, CANDIDATE_STORAGE_STATUS.UNSUPPORTED);
  assert.equal(storage.getItem('someone-elses-key'), 'kept');
});

test('a restored candidate still bundles its corridor evidence, and carries no search context in it', () => {
  const storage = fakeStorage();
  const { candidate } = promotedCandidate({});
  const store = createStore({ storage });
  store.promoteDiscoveryCandidate(candidate, candidate.id);
  const { store: reloaded } = reload(storage);
  const state = reloaded.getState();
  const restored = state.candidates[0];
  // The bundle is built from the candidate and the road records the panel shows; both came back from storage.
  const bundle = buildCorridorBundle({ candidate: restored, roads: state.roadsByCandidate[restored.id] ?? [] });
  assert.equal(validateBundle(bundle).valid, true);
  assert.equal(bundle.corridor.id, restored.id);
  assert.equal(bundle.corridor.name, restored.name);
  assert.match(bundle.corridor.declaredEvidence[0].statement, /Candidate discovery proposed this corridor/);
  assert.ok(bundle.geometry.source, 'the road provenance came back with the candidate');
  assert.equal(bundle.corridor.geometry.included, false);
  const text = JSON.stringify(bundle);
  assert.equal(text.includes('searchContext'), false, 'the bundle stays the sharing format, without browsing history');
  assert.equal(text.includes('Near Vernonia, OR'), false);
});
