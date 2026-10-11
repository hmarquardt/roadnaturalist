import test from 'node:test';
import assert from 'node:assert/strict';

import { createEvidenceRequests } from '../src/discovery/evidence.js';

//
// A person can select another corridor, or the same corridor again, while a promotion is still composing its road
// network. The run that finishes later must not write its metrics over the corridor the person is now looking at -
// this is the race the token guard exists for, and it is the one the panel's own behaviour depends on.
test('a run that finishes after the selection moved on cannot settle over the newer one', () => {
  const requests = createEvidenceRequests();
  const first = requests.begin('drv1-river-rd-c226-s1');
  const second = requests.begin('drv1-river-rd-c226-s1');
  assert.equal(first(), false, 'the older run no longer owns this corridor');
  assert.equal(second(), true, 'the newer run does');
  assert.equal(requests.pending(), 1, 'one corridor, one live run');
  requests.finish('drv1-river-rd-c226-s1', first);
  assert.equal(second(), true, 'a stale run finishing cannot release the live one');
  requests.finish('drv1-river-rd-c226-s1', second);
  assert.equal(requests.pending(), 0);
});

// Two corridors are independent: one finishing must not cancel the other, and a corridor that runs again takes
// ownership from its own earlier run only.
test('runs for different corridors do not disturb each other', () => {
  const requests = createEvidenceRequests();
  const river = requests.begin('drv1-river-rd-c226-s1');
  const main = requests.begin('drv1-main-st-c9-s1');
  assert.equal(river(), true);
  assert.equal(main(), true);
  requests.finish('drv1-main-st-c9-s1', main);
  assert.equal(river(), true, 'the other corridor keeps its own run');
  assert.equal(requests.pending(), 1);
  requests.finish('drv1-river-rd-c226-s1', river);
  assert.equal(requests.pending(), 0);
});

test('a request token is not transferable to another corridor', () => {
  const requests = createEvidenceRequests();
  const mine = requests.begin('drv1-river-rd-c226-s1');
  requests.begin('drv1-main-st-c9-s1');
  assert.equal(mine(), true, 'each token answers only for its own corridor');
  requests.finish('drv1-main-st-c9-s1', mine);
  assert.equal(requests.pending(), 1, 'finishing with a foreign token releases nothing');
});
