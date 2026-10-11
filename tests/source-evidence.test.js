import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createEvidenceRequests, unavailableMessage } from '../src/discovery/evidence.js';

// The unavailable state must speak the published vocabulary, and roads must never be named as the reason: the road
// plane is published nationally, so a missing road cell cannot be why a corridor has no source evidence.
test('the unavailable state uses the documented sentence and never blames the road plane', () => {
  const source = readFileSync(new URL('../src/app/main.js', import.meta.url), 'utf8');
  assert.match(source, /unavailableMessage\(/, 'the unavailable state must use the one documented sentence');
  assert.match(source, /plane !== 'roads'/, 'the message must drop the road plane before it is named');
  const message = unavailableMessage({ wetlands: ['x1_y1'], hydrography: ['x1_y1'] });
  assert.match(message, /has not yet been published/);
  assert.match(message, /precomputed national analysis values/);
  assert.ok(!/roads/.test(message), 'roads are published nationally and cannot be the reason');
});


// THE EVIDENCE PATH MAY NOT CALL SOMETHING THAT DOES NOT EXIST.
//
// The road stage failing first hid a second, unrelated defect: the ecology stage called `resolveEcoregions`, which
// this module has never defined, so the moment roads succeeded the panel failed on a ReferenceError. Nothing
// static in the repository would have caught it - the module parses, and the call is well formed - so the check
// lives here: every bare function the source-evidence path calls must be defined or imported by the module.
test('every function the source-evidence path calls is defined by the app module', () => {
  const source = readFileSync(new URL('../src/app/main.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function requestSourceEvidence(');
  assert.ok(start > 0, 'the source-evidence path must exist to be checked');
  const end = source.indexOf('\n}\n', source.indexOf('sourceEvidenceRequests.finish', start));
  assert.ok(end > start);
  const path = source.slice(start, end);
  // Comments are prose, not code: strip them before reading calls, or a sentence like "roads are never named
  // (they are published nationally)" is mistaken for a call to something called `named`.
  const code = path.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const defined = new Set([
    ...source.matchAll(/function\s+([A-Za-z_$][\w$]*)/g),
    ...source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g),
    ...source.matchAll(/import\s*\{([^}]*)\}/g),
  ].flatMap(match => (match[1].includes(',') ? match[1].split(',') : [match[1]]).map(name => name.trim())));
  const allowed = new Set(['Boolean', 'Number', 'String', 'Symbol', 'Error', 'Promise', 'Math', 'JSON', 'Object',
    'Array', 'setTimeout', 'clearTimeout', 'async', 'if', 'for', 'while', 'catch', 'switch', 'typeof', 'reject']);
  const called = [...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]);
  const missing = [...new Set(called)].filter(name => !defined.has(name) && !allowed.has(name));
  assert.deepEqual(missing, [], `the source-evidence path calls ${missing.join(', ')}, which nothing defines`);
});


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
