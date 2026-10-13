import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SORT, SORT_OPTIONS } from '../src/discovery/filter.js';
import { DISCOVERY_SEARCH_KEY, readDiscoveryMarks, readDiscoverySearch, readDiscoverySearchHistory,
  readDiscoverySort, writeDiscoveryMarks, writeDiscoverySearch, writeDiscoverySearchHistory,
  writeDiscoverySort } from '../src/discovery/persistence.js';
import { createStore } from '../src/state/store.js';

// A SORT CHOICE OUTLIVES THE SESSION; A DEFAULT DOES NOT BECOME ONE.
//
// The distinction this file exists to hold: a *missing* preference follows the product default (so a future default
// reaches everyone who never picked), while an *explicit* choice is remembered and respected across reloads. The
// preference lives in the discovery record this module already owns - no new storage key - and it is validated on
// read like everything else here.

const MILE = 1609.344;
const SEARCH = Object.freeze({ center: Object.freeze([-122.65, 45.53]), radiusMiles: 25 });

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key), keys: () => [...map.keys()], raw: () => map };
}

function record(storage) {
  const raw = storage.getItem(DISCOVERY_SEARCH_KEY);
  return raw == null ? null : JSON.parse(raw);
}

function result(id, name, { miles, area250 }) {
  return Object.freeze({ id, name, lengthM: 5000, distanceFromCenterM: miles * MILE, road: { class: 'S1400' },
    signals: {
      wetlands: { coverage: 'FULL', intersectsCorridor: area250 > 0, nearestM: 60,
        area250M2: area250, area500M2: area250 * 3, area1000M2: area250 * 10 },
      hydrography: { coverage: 'FULL', crossingCount: 3, crossings: [], nearestFlowingM: 120,
        nearestStandingM: 300, flowlineLength1000M: 6000 },
    },
    ecology: { coverage: 'FULL', ecoregionCount: 2, transitions: 1,
      level3: { primary: { name: 'L3' } }, level4: { primary: { name: 'L4' } } } });
}

test('no stored preference means the product default, and nothing is written to remember that', () => {
  const storage = memoryStorage();
  assert.equal(readDiscoverySort(storage), null);
  const store = createStore({ storage });
  assert.equal(store.getState().discovery.sort, DEFAULT_SORT);
  // Merely starting up must not persist today's default as if the person had chosen it.
  assert.equal(storage.getItem(DISCOVERY_SEARCH_KEY), null, 'initialisation writes nothing');
  assert.deepEqual(storage.keys(), []);
});

test('a valid stored preference is restored at startup', () => {
  const storage = memoryStorage();
  storage.setItem(DISCOVERY_SEARCH_KEY, JSON.stringify({ kind: 'roadnaturalist-discovery-search', version: 1,
    definition: SEARCH, preferredSort: 'naturalistInterest' }));
  assert.equal(readDiscoverySort(storage), 'naturalistInterest');
  assert.equal(createStore({ storage }).getState().discovery.sort, 'naturalistInterest');
});

test('an explicit sort change is persisted, through the record this module already owns', () => {
  const storage = memoryStorage();
  const store = createStore({ storage });
  store.setDiscoverySort('wetlandArea250');
  assert.equal(store.getState().discovery.sort, 'wetlandArea250');
  assert.equal(readDiscoverySort(storage), 'wetlandArea250');
  assert.equal(record(storage).kind, 'roadnaturalist-discovery-search');
  assert.equal(record(storage).version, 1, 'no version bump: the field is an optional addition');
  // And a reload sees it: a second store over the same storage starts where the person left off.
  assert.equal(createStore({ storage }).getState().discovery.sort, 'wetlandArea250');
  store.setDiscoverySort('naturalistInterest');
  assert.equal(createStore({ storage }).getState().discovery.sort, 'naturalistInterest');
});

test('a run does not turn the default into a stored preference', () => {
  const storage = memoryStorage();
  const store = createStore({ storage });
  store.startDiscovery({ id: 'area', kind: 'radius', center: SEARCH.center, radiusMiles: 25 }, {});
  store.setDiscoveryPhase('Composing road corridors…');
  store.finishDiscovery({ results: [result('a', 'A Rd', { miles: 2, area250: 50 })], coverage: null,
    diagnostics: null, eligibility: [], raw: null, searchArea: { id: 'area' }, marks: {} });
  store.selectDiscovery('a');
  store.setDiscoveryMarks({ a: 'promoted' });
  assert.equal(store.getState().discovery.sort, DEFAULT_SORT);
  assert.equal(storage.getItem(DISCOVERY_SEARCH_KEY), null, 'the run wrote no sort preference');
});

test('an unreadable or obsolete stored preference is ignored, and discovery still works', () => {
  for (const bad of ['nonsense', '', 42, {}, [], null]) {
    const storage = memoryStorage();
    storage.setItem(DISCOVERY_SEARCH_KEY, JSON.stringify({ kind: 'roadnaturalist-discovery-search', version: 1,
      definition: SEARCH, preferredSort: bad }));
    assert.equal(readDiscoverySort(storage), null, `${JSON.stringify(bad)} is not a sort this build offers`);
    const store = createStore({ storage });
    assert.equal(store.getState().discovery.sort, DEFAULT_SORT);
    // A run still works rather than throwing on the bad value.
    store.startDiscovery({ id: 'area', kind: 'radius', center: SEARCH.center, radiusMiles: 25 }, {});
    assert.equal(store.getState().discovery.status, 'running');
  }
});

test('a record written before the field existed stays valid and usable', () => {
  const storage = memoryStorage();
  // Exactly the shape an older build wrote: no `preferredSort` at all.
  storage.setItem(DISCOVERY_SEARCH_KEY, JSON.stringify({ kind: 'roadnaturalist-discovery-search', version: 1,
    definition: SEARCH }));
  assert.equal(readDiscoverySearch(storage)?.radiusMiles, 25, 'the last search is still read');
  assert.deepEqual(readDiscoverySearch(storage)?.center, SEARCH.center);
  assert.equal(readDiscoverySort(storage), null, 'an older record simply has no preference');
  assert.equal(createStore({ storage }).getState().discovery.sort, DEFAULT_SORT);
  // Choosing a sort adds the field without losing what the older record carried.
  writeDiscoverySort('crossings', storage);
  assert.equal(readDiscoverySort(storage), 'crossings');
  assert.equal(readDiscoverySearch(storage)?.radiusMiles, 25);
  assert.deepEqual(record(storage).definition.center, SEARCH.center);
});

test('writing a sort leaves every other discovery record exactly as it was', () => {
  const storage = memoryStorage();
  const marks = writeDiscoveryMarks({ 'drv1-a': 'promoted' }, storage);
  const history = writeDiscoverySearchHistory([SEARCH], storage);
  const definition = writeDiscoverySearch(SEARCH, storage);
  writeDiscoverySort('length', storage);
  assert.deepEqual(readDiscoveryMarks(storage), marks, 'marks are untouched');
  assert.deepEqual(readDiscoverySearchHistory(storage), history, 'the search history is untouched');
  assert.deepEqual(readDiscoverySearch(storage), definition, 'the last search is untouched');
  // Clearing the preference is not a reason to forget the search, and vice versa.
  writeDiscoverySort(null, storage);
  assert.equal(readDiscoverySort(storage), null);
  assert.deepEqual(readDiscoverySearch(storage), definition);
  assert.deepEqual(readDiscoveryMarks(storage), marks);
});

test('changing the search never changes the preferred sort', () => {
  const storage = memoryStorage();
  writeDiscoverySearch(SEARCH, storage);
  writeDiscoverySort('nearestWetland', storage);
  // A person runs one search after another; each rewrites the record, and none of them is a sort choice.
  for (const center of [[-87.56, 38.35], [-122.65, 45.53], [-112.07, 33.45]]) {
    writeDiscoverySearch({ center, radiusMiles: 25 }, storage);
    assert.equal(readDiscoverySort(storage), 'nearestWetland', 'the preference belongs to the person, not a search');
  }
  assert.equal(createStore({ storage }).getState().discovery.sort, 'nearestWetland');
});

test('every sort this build offers round-trips through storage', () => {
  const storage = memoryStorage();
  for (const option of SORT_OPTIONS) {
    assert.equal(writeDiscoverySort(option.key, storage), option.key);
    assert.equal(readDiscoverySort(storage), option.key);
    assert.equal(createStore({ storage }).getState().discovery.sort, option.key,
      `${option.key} survives a reload`);
  }
  assert.ok(SORT_OPTIONS.some(option => option.key === DEFAULT_SORT), 'and the default is among them');
  // An unknown key is ignored rather than stored, so a bad value cannot replace a real choice.
  const last = SORT_OPTIONS[SORT_OPTIONS.length - 1].key;
  assert.equal(writeDiscoverySort('not-a-sort', storage), last);
  assert.equal(readDiscoverySort(storage), last);
});

