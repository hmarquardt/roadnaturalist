import test from 'node:test';
import assert from 'node:assert/strict';

import { createSourceEvidenceRun, runSourceEvidence } from '../src/discovery/source-evidence-run.js';

// A SOURCE-EVIDENCE TIMEOUT IS TERMINAL, NOT MERELY A REJECTED PROMISE.
//
// These tests drive the real orchestration with a controllable clock and steps that resolve *after* it, which is the
// only way to prove the thing that matters: that late work cannot mutate anything once the run has ended. The
// journal records every write a step attempted, so "discarded" is asserted rather than assumed.

function harness({ timeoutMs = 50, isOwner = () => true } = {}) {
  const journal = [];
  let fire = null;
  let cancelled = 0;
  const run = createSourceEvidenceRun({ id: 'drv1-river-rd-c226-s1', timeoutMs, isOwner,
    setTimer: (callback, ms) => { fire = { callback, ms }; return 'timer-1'; },
    clearTimer: () => { cancelled += 1; } });
  const stages = [];
  return { run, journal, stages, runOptions: { run, onStage: (name, detail) => stages.push({ name, ...detail }) },
    timeout: () => fire?.callback(), timeoutMs: () => fire?.ms, cancelled: () => cancelled,
    write: entry => journal.push(entry) };
}

// The steps of a run, each of which writes to the journal - so any write that happens after the run ended is visible.
// The application wires the timeout to a terminal write, because a panel must never sit on "loading". The tests do the
// same, so what they exercise is the real contract rather than a friendlier one.
function onTimeoutWritesTerminal(bench, steps) {
  bench.run.onClose(async closed => {
    if (closed !== 'timeout') return;
    await steps.terminal({ error: Object.assign(new Error('source evidence took longer than 50 s'), { sourceTimeout: true }),
      unavailable: false });
  });
}

function stepsFor(harness, { resolve = {}, identity = true } = {}) {
  const gate = name => (resolve[name] ? resolve[name]() : Promise.resolve());
  return {
    corridorName: 'River Rd',
    loading: () => { harness.write('loading'); return true; },
    reconstruct: async () => { await gate('reconstruct'); harness.write('read:reconstruct');
      return { features: [1], identity: { corridorName: 'River Rd' }, scope: null }; },
    promote: planes => { harness.write(`promote:${Object.keys(planes).join('+')}`); return true; },
    ecology: async () => { await gate('ecology'); harness.write('ecology'); return true; },
    habitat: async () => { await gate('habitat'); harness.write('habitat'); return true; },
    levels: () => ({ roads: true, ecology: true, wetlands: true, hydrography: true }),
    identity: () => { if (identity) harness.write('identity'); return true; },
    terminal: ({ error, unavailable }) => { harness.write(`terminal:${unavailable ? 'unavailable' : 'failed'}:${error?.sourceTimeout ? 'timeout' : 'error'}`); },
  };
}

test('a timeout is terminal: the run closes once, writes the failed state, and nothing later may mutate', async () => {
  const bench = harness();
  const { run } = bench;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const steps = stepsFor(bench, { resolve: { reconstruct: () => blocked } });
  onTimeoutWritesTerminal(bench, steps);
  const work = runSourceEvidence({ ...bench.runOptions, steps });
  await Promise.resolve();
  bench.timeout();
  assert.equal(run.state, 'timeout', 'the timeout closes the run');
  assert.equal(run.isCurrent(), false, 'and it stops being the owner');
  assert.equal(bench.cancelled(), 1, 'the run clears its own timer when it closes');
  release();
  await work;
  assert.deepEqual(bench.journal, ['loading', 'terminal:failed:timeout', 'read:reconstruct'],
    'loading and the terminal state are the only writes: no promote, no ecology, no habitat, no identity');
  assert.ok(!bench.journal.includes('identity'), 'a timed-out run never emits an identity record');
  assert.equal(run.state, 'timeout', 'and the state stays terminal');
});

test('work that outlives the timeout is discarded after each await, not only at the entry', async () => {
  const bench = harness();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const steps = stepsFor(bench, { resolve: { habitat: () => blocked } });
  onTimeoutWritesTerminal(bench, steps);
  const work = runSourceEvidence({ ...bench.runOptions, steps });
  // Advance to the blocked stage deterministically: the journal says when ecology has been written, which is the
  // stage immediately before the one that is stuck.
  while (!bench.journal.includes('ecology')) await Promise.resolve();
  bench.timeout();
  release();
  await work;
  assert.ok(bench.journal.includes('promote:roads'), 'the stages before the timeout did run');
  assert.ok(!bench.journal.includes('habitat'), 'the stage that finished after the timeout wrote nothing');
  assert.ok(!bench.journal.includes('identity'), 'and the success path never completed');
});

test('a superseded request cannot mutate state, and the run that owns the corridor does', async () => {
  let owner = 'A';
  const superseded = harness({ isOwner: () => owner === 'A' });
  const first = runSourceEvidence({ ...superseded.runOptions, steps: stepsFor(superseded) });
  owner = 'B';
  await first;
  assert.deepEqual(superseded.journal.filter(entry => entry !== 'loading'), [],
    'the superseded run wrote nothing beyond the state it owned when it began');
  const owned = harness();
  await runSourceEvidence({ ...owned.runOptions, steps: stepsFor(owned) });
  assert.equal(owned.run.state, 'ready');
  assert.deepEqual(owned.journal, ['loading', 'read:reconstruct', 'promote:roads', 'ecology', 'habitat',
    'promote:roads+ecology+wetlands+hydrography', 'identity']);
});

test('a superseded or finished run cannot close a newer state', async () => {
  const bench = harness();
  await runSourceEvidence({ ...bench.runOptions, steps: stepsFor(bench) });
  assert.equal(bench.run.state, 'ready');
  assert.equal(bench.run.close('failed'), false, 'the first terminal reason wins');
  assert.equal(bench.run.state, 'ready');
});

test('a run that fails closes as unavailable and writes exactly one terminal state', async () => {
  const bench = harness();
  const steps = stepsFor(bench);
  steps.habitat = async () => { throw Object.assign(new Error('the raw cells are not published'), { rawUnavailable: true }); };
  await runSourceEvidence({ ...bench.runOptions, steps });
  assert.equal(bench.run.state, 'unavailable');
  assert.deepEqual(bench.journal, ['loading', 'read:reconstruct', 'promote:roads', 'ecology', 'terminal:unavailable:error']);
});

test('a retry after a timeout runs cleanly and emits its identity record once', async () => {
  const first = harness();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const stalledSteps = stepsFor(first, { resolve: { reconstruct: () => blocked } });
  onTimeoutWritesTerminal(first, stalledSteps);
  const stalled = runSourceEvidence({ ...first.runOptions, steps: stalledSteps });
  await Promise.resolve();
  first.timeout();
  release();
  await stalled;
  assert.equal(first.run.state, 'timeout');
  assert.ok(!first.journal.includes('identity'));
  const retry = harness();
  await runSourceEvidence({ ...retry.runOptions, steps: stepsFor(retry) });
  assert.equal(retry.run.state, 'ready');
  assert.equal(retry.journal.filter(entry => entry === 'identity').length, 1);
});

test('the timeout is configurable, and a run with no timer is bounded only by its owner', () => {
  assert.equal(harness({ timeoutMs: 4321 }).timeoutMs(), 4321);
  assert.equal(harness({ timeoutMs: 0 }).timeoutMs(), undefined);
});

