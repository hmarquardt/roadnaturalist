import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SORT, SORT_OPTIONS, sortResults } from '../src/discovery/filter.js';
import { createStore } from '../src/state/store.js';
import * as persistence from '../src/discovery/persistence.js';

// THE PRODUCT DEFAULT IS THE EXPLORATION ORDER, AND A DELIBERATE CHOICE STILL WINS.
//
// The default changed from a measured value (`wetlandArea250`) to the distance-aware exploration order. These tests
// pin the three things that makes true: a fresh search leads with the exploration order, a person's explicit choice
// survives the rest of the run, and a search with no centre honestly reduces to the interest order.

const MILE = 1609.344;

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

// A slightly more interesting road that is far, and barely less interesting roads nearer in: by interest alone the
// far road leads, with a centre the near tie resolves toward the closer roads. That is what makes the default real.
function fixture() {
  return [result('far', 'Far Rd', { miles: 22, area250: 205_000 }),
    result('mid', 'Mid Rd', { miles: 10, area250: 200_000 }),
    result('near', 'Near Rd', { miles: 1, area250: 195_000 })];
}

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key) };
}

test('a fresh store orders by the exploration order, and that key is a real option', () => {
  const store = createStore();
  assert.equal(DEFAULT_SORT, 'explorationOrder');
  assert.equal(store.getState().discovery.sort, DEFAULT_SORT);
  assert.ok(SORT_OPTIONS.some(option => option.key === DEFAULT_SORT), 'the default names an offered sort');
  assert.equal(SORT_OPTIONS.find(option => option.key === DEFAULT_SORT).heuristic, true,
    'the default is named as an order, not as a measured value');
  assert.ok(SORT_OPTIONS.some(option => option.key === 'naturalistInterest'),
    'the centre-independent interest order is still offered beside it');
});

test('an explicit sort choice is never pushed back to the default by the rest of a run', () => {
  const store = createStore();
  store.setDiscoverySort('naturalistInterest');
  assert.equal(store.getState().discovery.sort, 'naturalistInterest');
  // Every state change a run makes - starting, phases, finishing, selecting, marking - must leave the choice alone.
  store.startDiscovery({ id: 'area', kind: 'radius', center: [0, 0], radiusMiles: 25 }, {});
  store.setDiscoveryPhase('Composing road corridors…');
  store.finishDiscovery({ results: fixture(), coverage: null, diagnostics: null, eligibility: [], raw: null,
    searchArea: { id: 'area' }, marks: {} });
  store.selectDiscovery(null);
  store.setDiscoveryMarks({});
  assert.equal(store.getState().discovery.sort, 'naturalistInterest');
  // And an explicit choice of a factual sort is equally preserved.
  store.setDiscoverySort('wetlandArea250');
  store.setDiscoveryPhase('Filtering precomputed corridors…');
  assert.equal(store.getState().discovery.sort, 'wetlandArea250');
});

test('a search with no centre falls back to the interest order instead of inventing a distance', () => {
  const results = fixture();
  const interestOrder = sortResults(results, 'naturalistInterest').map(entry => entry.id);
  const boxOrder = sortResults(results, 'explorationOrder', { radiusM: null }).map(entry => entry.id);
  assert.deepEqual(boxOrder, interestOrder, 'with no centre the exploration order IS the interest order');
  const radiusOrder = sortResults(results, 'explorationOrder', { radiusM: 25 * MILE }).map(entry => entry.id);
  assert.deepEqual(interestOrder, ['far', 'mid', 'near'], 'by interest alone the far road still leads');
  assert.deepEqual(radiusOrder, ['near', 'mid', 'far'],
    'with a centre the near tie resolves toward the closer roads, so the default really is a different order');
});

test('every factual sort is untouched and still available beside the two orderings', () => {
  const results = [result('b', 'B Rd', { miles: 2, area250: 5 }), result('a', 'A Rd', { miles: 10, area250: 50 })];
  for (const key of ['wetlandArea250', 'name', 'length', 'nearestWetland', 'wetlandArea1000', 'crossings',
    'ecoregionTransitions', 'ecoregionCount', 'distanceFromCenter']) {
    assert.ok(SORT_OPTIONS.some(option => option.key === key), `${key} is still offered`);
    assert.equal(sortResults(results, key).length, 2, `${key} still orders the table`);
  }
  assert.equal(sortResults(results, 'wetlandArea250').map(entry => entry.id).join(','), 'a,b',
    'the measured-value order is unchanged by the default moving');
});

test('no sort is persisted or carried in the URL, so a reload takes the default and there is no stored choice to honour', () => {
  // The audit, as an executable fact: the persistence surface remembers marks, the last search and its history, and
  // nothing else. A deliberate sort therefore lasts the session and is never fought by a restored value.
  const keys = Object.keys(persistence).filter(name => name.startsWith('DISCOVERY_'));
  assert.ok(keys.length > 0);
  assert.ok(!keys.some(name => /sort/i.test(name)), `no sort is persisted (found ${keys.join(', ')})`);
  assert.deepEqual(persistence.readDiscoveryMarks(memoryStorage({})), {});
  assert.equal(persistence.readDiscoverySearch(memoryStorage({})), null);
  const store = createStore();
  assert.equal(store.getState().discovery.sort, DEFAULT_SORT,
    'a fresh load has no stored sort to override the default');
});

