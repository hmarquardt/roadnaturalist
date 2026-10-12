import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureLoader } from '../src/app/feature-loader.js';

// A feature loader is the whole of the lazy boundary's behaviour, so it is tested on its own: no DOM, no network, just
// the three things a dynamic import can do.

test('a feature is loaded once, and every later request reuses it', async () => {
  let loads = 0;
  const feature = { name: 'investigator' };
  const loader = createFeatureLoader({ name: 'demo', load: async () => { loads += 1; return feature; } });
  assert.equal(loader.loaded(), false, 'nothing is loaded until it is asked for');
  assert.equal(await loader.load(), feature);
  assert.equal(await loader.load(), feature, 'the second request gets the same module, not a second load');
  assert.equal(loads, 1, 'the feature was loaded exactly once');
  assert.equal(loader.loaded(), true);
});

test('two requests while the feature is still arriving share one load', async () => {
  let loads = 0;
  let release = null;
  const feature = { name: 'investigator' };
  const gate = new Promise(resolve => { release = resolve; });
  const loader = createFeatureLoader({ name: 'demo', load: () => { loads += 1; return gate.then(() => feature); } });
  const first = loader.load();
  const second = loader.load();
  release();
  assert.deepEqual(await Promise.all([first, second]), [feature, feature], 'both callers get the loaded module');
  assert.equal(loads, 1, 'in-flight requests are not a reason to load twice');
});

test('a failed load is reported, is not remembered as the answer, and can be retried', async () => {
  const feature = { name: 'investigator' };
  let attempts = 0;
  const loader = createFeatureLoader({ name: 'demo', load: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Failed to fetch dynamically imported module');
    return feature;
  } });
  await assert.rejects(loader.load(), /Failed to fetch dynamically imported module/, 'the failure reaches the caller');
  assert.equal(loader.loaded(), false, 'a failed load does not count as loaded');
  assert.equal(loader.failureCount(), 1);
  assert.match(loader.lastFailure().message, /Failed to fetch/);
  assert.equal(await loader.load(), feature, 'the next request tries again rather than replaying the rejection');
  assert.equal(attempts, 2);
  assert.equal(await loader.load(), feature);
  assert.equal(attempts, 2, 'and once it loads, it stays loaded');
});

test('a feature that loads nothing is a failure, not a silent success', async () => {
  const loader = createFeatureLoader({ name: 'demo', load: async () => null });
  await assert.rejects(loader.load(), /loaded nothing/);
  assert.equal(loader.loaded(), false);
});

test('a loader without a load function is refused at construction', () => {
  assert.throws(() => createFeatureLoader({}), /needs a load function/);
});
