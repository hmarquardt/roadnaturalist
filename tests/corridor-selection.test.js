import test from 'node:test';
import assert from 'node:assert/strict';

import { createCorridorSelection } from '../src/app/corridor-selection.js';
import { SELECTION_DOMAIN } from '../src/state/store.js';

// ONE CLICKED ROAD, ONE SELECTION, IN THE RIGHT COLLECTION.
//
// The map draws national discovery results and the candidate list - the pilot's corridors among them - beside each other,
// and reports a click as the corridor and the collection it came from. This is where that becomes a selection: each domain
// routes to the store action that already owns it, and nothing is ever inferred from the shape of an id.
function fakeStore({ candidates = [], discovery = [] } = {}) {
  const calls = { select: [], selectDiscovery: [] };
  return { calls,
    select(id) {
      if (!candidates.includes(id)) throw new Error('Unknown candidate');
      calls.select.push(id);
    },
    selectDiscovery(id) {
      if (id != null && !discovery.includes(id)) throw new Error('Unknown discovery corridor');
      calls.selectDiscovery.push(id);
    } };
}

test('a discovery road is selected through the discovery path, and its row is revealed', () => {
  const store = fakeStore({ discovery: ['drv1-river-rd-c455-s1'] });
  const revealed = [];
  const select = createCorridorSelection({ store, revealDiscoveryRow: id => revealed.push(id) });
  assert.equal(select({ id: 'drv1-river-rd-c455-s1', domain: SELECTION_DOMAIN.DISCOVERY }), true);
  assert.deepEqual(store.calls.selectDiscovery, ['drv1-river-rd-c455-s1']);
  assert.deepEqual(store.calls.select, [], 'and never through the candidate path');
  assert.deepEqual(revealed, ['drv1-river-rd-c455-s1'], 'the row it belongs to is revealed');
});

test('a pilot corridor is a candidate, and is selected through the candidate path', () => {
  // The pilot's corridors are candidates like any other: their ids start with `or-roads-`, and nothing here looks at that.
  const store = fakeStore({ candidates: ['or-roads-cornelius-pass-rd', 'drv1-nw-sunset-hwy-s4'] });
  const revealed = [];
  const select = createCorridorSelection({ store, revealDiscoveryRow: id => revealed.push(id) });
  for (const id of ['or-roads-cornelius-pass-rd', 'drv1-nw-sunset-hwy-s4']) {
    assert.equal(select({ id, domain: SELECTION_DOMAIN.CANDIDATE }), true);
  }
  assert.deepEqual(store.calls.select, ['or-roads-cornelius-pass-rd', 'drv1-nw-sunset-hwy-s4']);
  assert.deepEqual(store.calls.selectDiscovery, [], 'a candidate id is never routed through discovery selection');
  assert.deepEqual(revealed, [], 'and it reveals no discovery row');
});

test('a click the store refuses is an honest no-op, never a crash', () => {
  const store = fakeStore({ candidates: ['known'], discovery: ['drv1-known'] });
  const select = createCorridorSelection({ store });
  // A pilot corridor that is no longer in the candidate list, clicked on a map drawn before it left.
  assert.equal(select({ id: 'or-roads-gone-rd', domain: SELECTION_DOMAIN.CANDIDATE }), false);
  assert.equal(select({ id: 'drv1-gone', domain: SELECTION_DOMAIN.DISCOVERY }), false);
  assert.deepEqual(store.calls, { select: [], selectDiscovery: [] }, 'and nothing is selected instead');
  // No domain at all, or one this build does not know: nothing is guessed.
  assert.equal(select({ id: 'known' }), false);
  assert.equal(select({ id: 'or-roads-cornelius-pass-rd', domain: 'pilot' }), false,
    'an unknown domain is not silently treated as the candidate one');
  assert.equal(select({ domain: SELECTION_DOMAIN.CANDIDATE }), false, 'no id, no selection');
  assert.equal(select(), false);
  assert.deepEqual(store.calls, { select: [], selectDiscovery: [] });
});

test('the map is never asked to read a store, and the domains are the store own words', () => {
  // The vocabulary lives with the selection actions it names, so the app and its tests cannot drift from it.
  assert.deepEqual(SELECTION_DOMAIN, { DISCOVERY: 'discovery', CANDIDATE: 'candidate' });
  const store = fakeStore({ candidates: ['a'], discovery: ['b'] });
  const select = createCorridorSelection({ store });
  assert.equal(select({ id: 'a', domain: SELECTION_DOMAIN.CANDIDATE }), true);
  assert.equal(select({ id: 'b', domain: SELECTION_DOMAIN.DISCOVERY }), true);
  assert.deepEqual(store.calls.select, ['a']);
  assert.deepEqual(store.calls.selectDiscovery, ['b']);
});
