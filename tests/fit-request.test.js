import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createFitRequests } from '../src/map/fit-request.js';

// ONE FIT PER COMPLETED SEARCH, AND NO OTHERS.
//
// The camera moves for exactly one reason, so the reason is a token a completed run places and a single render
// spends - not a condition inferred from state. These tests are the invariants the browser gate then proves again
// against the deployed application.

test('a completed search with visible geometry spends exactly one fit', () => {
  const fit = createFitRequests();
  fit.request('search-a');
  assert.equal(fit.consume({ hasGeometry: true }), true, 'the request is spent on the render with geometry');
  assert.equal(fit.consume({ hasGeometry: true }), false, 'a redraw of the same search must not fit again');
  assert.equal(fit.pending(), null);
});

test('a request is not spent on a map with no geometry, and is still there when geometry arrives', () => {
  const fit = createFitRequests();
  fit.request('search-empty-then-drawn');
  assert.equal(fit.consume({ hasGeometry: false }), false, 'an empty map is not fitted');
  assert.notEqual(fit.pending(), null, 'the request waits rather than being wasted');
  assert.equal(fit.consume({ hasGeometry: true }), true);
  assert.equal(fit.consume({ hasGeometry: true }), false);
});

test('ordinary interactions have nothing to spend: selection, sort, save and detail updates cannot fit', () => {
  const fit = createFitRequests();
  fit.request('search-a');
  fit.consume({ hasGeometry: true });
  // Every later render - another selection, a sort change, a favourite, an analysis finishing - calls consume with
  // geometry present, and none of them may move the camera because no request exists.
  for (let render = 0; render < 6; render += 1) {
    assert.equal(fit.consume({ hasGeometry: true }), false);
  }
});

test('a second completed search spends one additional fit', () => {
  const fit = createFitRequests();
  fit.request('search-a');
  assert.equal(fit.consume({ hasGeometry: true }), true);
  fit.request('search-b');
  assert.equal(fit.consume({ hasGeometry: true }), true, 'the second search owns its own one fit');
  assert.equal(fit.consume({ hasGeometry: true }), false);
  assert.equal(fit.pending(), null);
});

test('a failed or refused search never fits', () => {
  const fit = createFitRequests();
  fit.cancel();
  assert.equal(fit.consume({ hasGeometry: true }), false, 'a cancelled search has nothing to fit');
  // And a request that is withdrawn before the render arrives is not spent either.
  fit.request('search-c');
  fit.cancel();
  assert.equal(fit.consume({ hasGeometry: true }), false);
});

test('the application requests a fit only where a run completes, and withdraws it on every failure path', () => {
  const source = readFileSync(new URL('../src/app/main.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  // One request, immediately after the run becomes authoritative, and one place that spends it.
  assert.equal((source.match(/discoveryFit\.request\(/g) ?? []).length, 1);
  assert.equal((source.match(/discoveryFit\.consume\(/g) ?? []).length, 1);
  const finish = source.indexOf('finishDiscovery(');
  const request = source.indexOf('discoveryFit.request(');
  assert.ok(finish > 0 && request > finish, 'the request is made as part of completing the search');
  // Every failure path withdraws: three of them, one per way a search can fail to produce results.
  assert.equal((source.match(/discoveryFit\.cancel\(\)/g) ?? []).length, 3);
  // The fit is not inferred from rendering state any more.
  assert.ok(!/fittedSearchKey/.test(source), 'no state-key heuristic may remain');
});
