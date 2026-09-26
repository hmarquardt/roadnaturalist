import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { createInvestigatorHandler, DEFAULT_ALLOWED_ORIGINS, parseAllowedOrigins } from '../worker/investigator/handler.js';
import { createProbeRegistry, normalizeProbeId, defaultProbeRegistry } from '../worker/investigator/registry.js';
import { HOST_POLICY, assertAllowedRedirect, assertStaticSourceUrl, buildProbePolicy } from '../worker/investigator/policies.js';
import { CACHE_STATUS, createProbeCache } from '../worker/investigator/cache.js';
import { createRateLimiter, createSingleFlight } from '../worker/investigator/ratelimit.js';
import { FAILURE_CODE, fetchProbePage } from '../worker/investigator/fetch-probe.js';
import { DRIFT_STATE, buildBaselineFromRecord, buildProbeBaseline } from '../src/investigator/drift.js';
import { readFileSync } from 'node:fs';
import { DRIFT_BASELINE } from '../src/investigator/probes/drift-baseline.js';
import { ALL_PROBE_DECLARATIONS } from '../src/investigator/probes/or-pilot.js';
import { extractProbeFacts, htmlToText, normalizeWhitespace } from '../src/investigator/research.js';

// ---------------------------------------------------------------------------------------------------------------
// No test in this file touches the network. Every upstream answer is a stub, so the security properties of the
// boundary (what it may fetch, what it refuses, what it returns) are asserted deterministically.
// ---------------------------------------------------------------------------------------------------------------

const RAW_MARKER = 'RAW-PAGE-MARKER-DO-NOT-RETURN';
const ORIGIN = 'https://roadnaturalist.com';
const CORNELIUS_ADVISORY = 'wc-roads-cornelius-advisory';
const ADVISORY_TEXT = `Road Closures & Traffic Advisories ${RAW_MARKER} ` +
  'Cornelius Pass Road From/To: At Rock Creek (View Detour Map) Impact: Road closure Reason: Bridge replacement ' +
  'Schedule: From: 07/15/2026 To: 10/07/2026 Use alternate route';
const SUSBAUER_TEXT = 'Flooding and Winds. Susbauer and Fern Hill roads both flood often during heavy rainfall. ' +
  'We have installed permanent, manual-locking flood gates on both these roads. ' +
  'The gates on Susbauer Road are south of Hornecker Road and north of Long Road.';

const htmlResponse = (body, { status = 200, contentType = 'text/html; charset=utf-8', location = null } = {}) => {
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (location) headers.Location = location;
  return new Response(body, { status, headers });
};

// A fetch stub that records every call and answers from a scripted list.
function stubFetch(script) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, hasSignal: Boolean(init.signal), redirect: init.redirect ?? null });
    const answer = typeof script === 'function' ? script(url, init, calls.length) : script;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  impl.calls = calls;
  return impl;
}

function fakeCacheStore() {
  const map = new Map();
  return { map, size: () => map.size,
    async match(key) { const text = map.get(String(key)); return text === undefined ? undefined : new Response(text); },
    async put(key, response) { map.set(String(key), await response.text()); },
    async delete(key) { return map.delete(String(key)); } };
}

let clockOffsetMs = 0;
const testClock = () => new Date(Date.parse('2026-09-26T12:00:00.000Z') + clockOffsetMs);

function harness({ script = () => htmlResponse(ADVISORY_TEXT), store = fakeCacheStore(), baseline = DRIFT_BASELINE,
  limits = { maxBytes: 524288, timeoutMs: 15000, maxRedirects: 1, maxResponseBytes: 65536, maxFactsPerProbe: 32 },
  hosts = HOST_POLICY, probes = ALL_PROBE_DECLARATIONS, rateLimiter = null, allowedOrigins = DEFAULT_ALLOWED_ORIGINS, log = null } = {}) {
  const fetchImpl = typeof script === 'object' && typeof script.calls !== 'undefined' ? script : stubFetch(script);
  const registry = createProbeRegistry({ declarations: probes, hosts });
  const cache = createProbeCache({ store, clock: testClock });
  const handler = createInvestigatorHandler({ registry, fetchImpl, cache, clock: testClock, baseline, limits, allowedOrigins, log, rateLimiter,
    singleFlight: createSingleFlight() });
  const call = (probeId, { origin = ORIGIN, method = 'GET', query = '', headers = {} } = {}) => handler.handle(new Request(
    `https://investigator.test/api/investigator/probes/${probeId}${query}`, { method, headers: { ...(origin ? { Origin: origin } : {}), ...headers } }));
  const list = ({ origin = ORIGIN } = {}) => handler.handle(new Request('https://investigator.test/api/investigator/probes', { headers: origin ? { Origin: origin } : {} }));
  return { handler, registry, cache, fetchImpl, call, list, store };
}

const bodyOf = response => response.json();

// ---------------------------------------------------------------------------------------------------------------
// Registry and SSRF surface
// ---------------------------------------------------------------------------------------------------------------

test('the registry is server-owned and can only resolve declared probe ids', () => {
  const registry = defaultProbeRegistry;
  assert.equal(registry.size, ALL_PROBE_DECLARATIONS.length);
  assert.deepEqual(registry.sourceHosts.slice().sort(), ['content.govdelivery.com', 'multco.us', 'www.washingtoncountyor.gov', 'www.wc-roads.com']);
  assert.equal(registry.get(CORNELIUS_ADVISORY).policy.host, 'www.wc-roads.com');
  assert.equal(registry.get('wc-roads-cornelius-advisory').probe.url.startsWith('https://'), true);
  // Ids are opaque: nothing URL-shaped, encoded, or traversal-shaped can be looked up.
  for (const attempt of ['../../etc/passwd', 'https://evil.example/', 'wc-roads.cornelius', 'WC-ROADS-CORNELIUS-ADVISORY',
    'wc-roads-cornelius-advisory%2F..%2Fadmin', 'ab', 'a'.repeat(80), '', null, undefined, 42, { id: CORNELIUS_ADVISORY }]) {
    assert.equal(normalizeProbeId(attempt), null, `expected ${String(attempt)} to be rejected as a probe id shape`);
    assert.equal(registry.get(normalizeProbeId(attempt) ?? ''), null);
  }
  // A well-formed id that is simply not declared is a valid shape but resolves to nothing: the endpoint answers 404
  // without contacting anybody.
  assert.equal(normalizeProbeId('nope'), 'nope');
  assert.equal(registry.get('nope'), null);
});

test('a source URL is rejected unless it is exactly the kind of URL this project declares by hand', () => {
  assert.equal(assertStaticSourceUrl('https://www.wc-roads.com/').hostname, 'www.wc-roads.com');
  const rejected = ['http://www.wc-roads.com/', 'https://127.0.0.1/', 'https://localhost/', 'https://169.254.169.254/latest/meta-data/',
    'https://metadata.google.internal/computeMetadata/v1/', 'https://user:pass@www.wc-roads.com/', 'https://www.wc-roads.com:8443/',
    'https://[::1]/', 'https://212.1.2.3/', 'https://www.wc-roads.com', 'https://www.wc-roads.com/?x=1', 'file:///etc/passwd'];
  for (const url of rejected) assert.throws(() => assertStaticSourceUrl(url), /TypeError/, `expected ${url} to be rejected`);
  // A well-formed URL on a host this project did not declare is not a shape problem: the allow-list is what refuses
  // it, and that refusal happens when the registry is built.
  assert.equal(assertStaticSourceUrl('https://evil.example/page').hostname, 'evil.example');
});

test('a probe whose host is not allow-listed cannot be built into the registry at all', () => {
  const declaration = { ...ALL_PROBE_DECLARATIONS[0], id: 'unknown-host-probe', url: 'https://evil.example/page' };
  assert.throws(() => createProbeRegistry({ declarations: [declaration] }), /not in the Worker source allow-list/);
  // And a probe that the shared validator would reject is rejected here too.
  assert.throws(() => createProbeRegistry({ declarations: [{ ...ALL_PROBE_DECLARATIONS[0], id: 'no-facts-probe', facts: [] }] }), /at least one declared fact/);
});

test('an allowed redirect must stay on the same host, under the declared path prefix', () => {
  const policy = buildProbePolicy(ALL_PROBE_DECLARATIONS.find(entry => entry.id === 'wc-cornelius-closure-news'));
  assert.equal(assertAllowedRedirect('/lut/news/2026/07/09/same-page', policy.url.href, policy).hostname, 'www.washingtoncountyor.gov');
  assert.throws(() => assertAllowedRedirect('https://evil.example/lut/news', policy.url.href, policy), /only www\.washingtoncountyor\.gov/);
  assert.throws(() => assertAllowedRedirect('http://www.washingtoncountyor.gov/lut/news', policy.url.href, policy), /https/);
  assert.throws(() => assertAllowedRedirect('/private/other-section', policy.url.href, policy), /path prefix/);
});

// ---------------------------------------------------------------------------------------------------------------
// Endpoint behaviour
// ---------------------------------------------------------------------------------------------------------------

test('an unknown probe id is rejected with 404 and no upstream request is made', async () => {
  const { call, fetchImpl } = harness();
  for (const id of ['not-declared', 'wc-roads-cornelius-advisory%2F..%2F..%2Fetc', 'https:%2F%2Fevil.example%2F']) {
    const response = await call(id);
    assert.equal(response.status, 404);
    assert.equal((await bodyOf(response)).error.code, 'UNKNOWN_PROBE');
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('a client-supplied URL or query is ignored: the declared source is the only thing fetched', async () => {
  const { call, fetchImpl } = harness();
  const response = await call(CORNELIUS_ADVISORY, { query: '?url=https://evil.example/steal&host=evil.example&probeUrl=https://evil.example' });
  assert.equal(response.status, 200);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://www.wc-roads.com/');
  assert.equal(fetchImpl.calls.every(callEntry => !callEntry.url.includes('evil.example')), true);
});

test('the Worker sends no credential, cookie, or client header upstream', async () => {
  const { call, fetchImpl } = harness({});
  await call(CORNELIUS_ADVISORY, { headers: { Authorization: 'Bearer client-secret', Cookie: 'session=abc', 'X-Forwarded-For': '10.0.0.9' } });
  const [{ method, headers, hasSignal, redirect }] = fetchImpl.calls;
  assert.equal(method, 'GET');
  assert.deepEqual(Object.keys(headers).sort(), ['Accept', 'Accept-Language', 'User-Agent']);
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers.Cookie, undefined);
  assert.equal(headers['X-Forwarded-For'], undefined);
  assert.equal(hasSignal, true, 'a timeout signal must be passed so a slow source cannot hang the Worker');
  assert.equal(redirect, 'manual', 'redirects must be inspected, never followed automatically');
});

test('a successful read returns normalized facts and never the page text', async () => {
  const { call } = harness();
  const response = await call(CORNELIUS_ADVISORY);
  const body = await bodyOf(response);
  assert.equal(response.status, 200);
  assert.equal(body.status, 'EVIDENCE');
  assert.equal(body.probeId, CORNELIUS_ADVISORY);
  assert.equal(body.organization, 'Washington County Road Closures & Traffic Advisories (wc-roads.com)');
  assert.equal(body.sourceClass, 'TIER_1_AUTHORITATIVE');
  assert.equal(body.sourceUrl, 'https://www.wc-roads.com/');
  assert.equal(body.facts.length, 1);
  assert.equal(body.facts[0].claimType, 'TEMPORARY_CLOSURE');
  assert.equal(body.facts[0].effectiveFrom, '2026-07-15');
  assert.equal(body.facts[0].effectiveUntil, '2026-10-07');
  assert.match(body.facts[0].quote, /Cornelius Pass Road From\/To: At Rock Creek/);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(RAW_MARKER), false, 'raw page text must never be returned');
  assert.equal(/<html|<body|<div|&nbsp;/i.test(serialized), false, 'no markup may survive into the answer');
  assert.equal(serialized.includes('9 a.m.-3:30 p.m.'), false, 'text the probe did not declare is not returned');
  assert.equal(response.headers.get('X-Normalized-Bytes') !== null, true);
  assert.equal(Number(response.headers.get('X-Normalized-Bytes')) < 4096, true);
});

test('a read that succeeds without any declared phrase is NO_RELEVANT_EVIDENCE, not a failure', async () => {
  const { call } = harness({ script: () => htmlResponse('<html><body>Nothing relevant here.</body></html>') });
  const body = await bodyOf(await call(CORNELIUS_ADVISORY));
  assert.equal(body.status, 'NO_RELEVANT_EVIDENCE');
  assert.deepEqual(body.facts, []);
  assert.equal(body.drift.state, DRIFT_STATE.NO_LONGER_MATCHES);
});

test('upstream failures stay explicit and are never a no-result search', async () => {
  const cases = [
    { name: 'throttled', script: () => htmlResponse('slow down', { status: 429 }), code: FAILURE_CODE.THROTTLED, attempts: 1 },
    { name: 'server error', script: () => htmlResponse('boom', { status: 500 }), code: FAILURE_CODE.HTTP_ERROR, attempts: 2 },
    { name: 'not found', script: () => htmlResponse('gone', { status: 404 }), code: FAILURE_CODE.HTTP_ERROR, attempts: 1 },
  ];
  for (const testCase of cases) {
    const { call, fetchImpl } = harness({ script: testCase.script });
    const response = await call(CORNELIUS_ADVISORY);
    const body = await bodyOf(response);
    assert.equal(response.status, 200, `${testCase.name}: the endpoint worked, the source did not`);
    assert.equal(body.status, 'FAILED', `${testCase.name}: a failed source is not a no-result search`);
    assert.equal(body.diagnostics.some(entry => entry.code === testCase.code), true, `${testCase.name}: expected ${testCase.code}`);
    assert.equal(body.drift.state, DRIFT_STATE.SOURCE_UNAVAILABLE);
    assert.equal(fetchImpl.calls.length, testCase.attempts, `${testCase.name}: expected ${testCase.attempts} upstream attempt(s)`);
    assert.notEqual(response.headers.get('Cache-Control'), 'public, max-age=60', 'a failure must never be browser-cached');
  }
});

test('a timeout is reported as a timeout, and no retry storm is created', async () => {
  const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const { call, fetchImpl } = harness({ script: () => timeoutError });
  const body = await bodyOf(await call(CORNELIUS_ADVISORY));
  assert.equal(body.status, 'FAILED');
  assert.equal(body.diagnostics[0].code, FAILURE_CODE.TIMEOUT);
  assert.match(body.diagnostics[0].message, /within 15000 ms/);
  assert.equal(fetchImpl.calls.length, 2, 'exactly one retry for a transient failure');
});

test('an oversized upstream body is aborted, and a declared oversized length is not read at all', async () => {
  const small = { maxBytes: 512, timeoutMs: 5000, maxRedirects: 1, maxResponseBytes: 65536, maxFactsPerProbe: 32 };
  const cappedHosts = { ...HOST_POLICY, 'www.wc-roads.com': { ...HOST_POLICY['www.wc-roads.com'], maxBytes: 512 } };
  const big = `${'x'.repeat(4000)}${ADVISORY_TEXT}`;
  const declared = harness({ script: () => htmlResponse(big), limits: small, hosts: cappedHosts });
  const declaredBody = await bodyOf(await declared.call(CORNELIUS_ADVISORY));
  assert.equal(declaredBody.status, 'FAILED');
  assert.equal(declaredBody.diagnostics[0].code, FAILURE_CODE.RESPONSE_TOO_LARGE);
  assert.match(declaredBody.diagnostics[0].message, /larger than the 512 byte cap/);
  assert.equal(declaredBody.meta.upstreamBytes, null, 'a declared oversized length must not be downloaded');

  // No content-length header: the streaming read must abort as soon as the cap is passed.
  const streaming = harness({ limits: small, hosts: cappedHosts, script: () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('y'.repeat(600))); controller.enqueue(new TextEncoder().encode('z'.repeat(600))); controller.close(); } });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } });
  const streamedBody = await bodyOf(await streaming.call(CORNELIUS_ADVISORY));
  assert.equal(streamedBody.status, 'FAILED');
  assert.equal(streamedBody.diagnostics[0].code, FAILURE_CODE.RESPONSE_TOO_LARGE);
  assert.match(streamedBody.diagnostics[0].message, /while streaming/);
});

test('an unexpected or missing content type is refused instead of being treated as a page', async () => {
  for (const contentType of ['application/pdf', 'image/png', '', 'application/octet-stream']) {
    const { call } = harness({ script: () => htmlResponse('%PDF-1.7 not html', { contentType }) });
    const body = await bodyOf(await call(CORNELIUS_ADVISORY));
    assert.equal(body.status, 'FAILED', `content type ${contentType || '(missing)'} must not be parsed as a page`);
    assert.equal(body.diagnostics[0].code, FAILURE_CODE.UNEXPECTED_CONTENT_TYPE);
  }
});

test('a redirect to another host is refused, and a same-host redirect is followed exactly once', async () => {
  const offsite = harness({ script: (url, init, callNumber) => callNumber === 1
    ? htmlResponse('', { status: 302, location: 'https://evil.example/lut/news/redirected' })
    : htmlResponse(ADVISORY_TEXT) });
  const refused = await bodyOf(await offsite.call('wc-cornelius-closure-news'));
  assert.equal(refused.status, 'FAILED');
  assert.equal(refused.diagnostics[0].code, FAILURE_CODE.REDIRECT_BLOCKED);
  assert.match(refused.diagnostics[0].message, /only www\.washingtoncountyor\.gov/);
  assert.equal(offsite.fetchImpl.calls.length, 1, 'the Worker must not follow the redirect in order to find out');

  const sameHost = harness({ script: (url, init, callNumber) => callNumber === 1
    ? htmlResponse('', { status: 302, location: '/lut/news/2026/07/09/safety-and-freight-improvements-cornelius-pass-road-bridge-replacement-rock-creek' })
    : htmlResponse(`Cornelius Pass Road (OR-127) will be closed between Germantown Road and Kaiser Road from July 15 to October 7, 2026`) });
  const followed = await bodyOf(await sameHost.call('wc-cornelius-closure-news'));
  assert.equal(followed.status, 'EVIDENCE');
  assert.equal(followed.diagnostics.some(entry => entry.code === 'redirect'), true);
  assert.equal(followed.meta.redirects, 1);
  assert.equal(sameHost.fetchImpl.calls.length, 2);
});

test('a redirect that cannot be read is refused rather than guessed at', async () => {
  const opaque = new Response('', { status: 302 });
  const { call } = harness({ script: () => opaque });
  const body = await bodyOf(await call(CORNELIUS_ADVISORY));
  assert.equal(body.status, 'FAILED');
  assert.equal(body.diagnostics[0].code, FAILURE_CODE.REDIRECT_BLOCKED);
  assert.match(body.diagnostics[0].message, /not readable/);
});

// ---------------------------------------------------------------------------------------------------------------
// Methods, origins, and rate limits
// ---------------------------------------------------------------------------------------------------------------

test('the endpoint is read-only: other methods are refused with an Allow header', async () => {
  const { call } = harness();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await call(CORNELIUS_ADVISORY, { method });
    assert.equal(response.status, 405);
    assert.equal((await bodyOf(response)).error.code, 'METHOD_NOT_ALLOWED');
    assert.equal(response.headers.get('Allow'), 'GET, OPTIONS');
  }
});

test('CORS is granted only to the declared Road Naturalist origins', async () => {
  const { call, list } = harness();
  const allowed = await call(CORNELIUS_ADVISORY, { origin: 'http://localhost:8000' });
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000');
  assert.equal(allowed.headers.get('Vary'), 'Origin');
  const refused = await call(CORNELIUS_ADVISORY, { origin: 'https://evil.example' });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await bodyOf(refused)).error.code, 'ORIGIN_NOT_ALLOWED');
  const preflight = await call(CORNELIUS_ADVISORY, { method: 'OPTIONS', origin: 'https://roadnaturalist.com' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal(preflight.headers.get('Access-Control-Max-Age'), '600');
  const preflightRefused = await call(CORNELIUS_ADVISORY, { method: 'OPTIONS', origin: 'https://evil.example' });
  assert.equal(preflightRefused.status, 403);
  assert.equal(preflightRefused.headers.get('Access-Control-Allow-Origin'), null);
  // A script or same-origin call with no Origin header is served, and the listing carries no policy detail.
  const noOrigin = await list({ origin: null });
  assert.equal(noOrigin.status, 200);
  const listing = await bodyOf(noOrigin);
  assert.equal(listing.probes.every(entry => !('policy' in entry) && !('maxBytes' in entry)), true);
  assert.equal(listing.sourceHosts.length, 4);
  assert.match(listing.note, /No client-supplied URL is accepted/);
});

test('parseAllowedOrigins falls back to the committed defaults and never widens to a wildcard', () => {
  assert.deepEqual(parseAllowedOrigins(undefined), [...DEFAULT_ALLOWED_ORIGINS]);
  assert.deepEqual(parseAllowedOrigins(''), [...DEFAULT_ALLOWED_ORIGINS]);
  assert.deepEqual(parseAllowedOrigins('https://a.example, https://b.example ,'), ['https://a.example', 'https://b.example']);
  assert.equal(parseAllowedOrigins('*').includes('*'), true);
  // A wildcard is only ever possible if an operator deliberately configures one; the committed default never has one.
  assert.equal(DEFAULT_ALLOWED_ORIGINS.includes('*'), false);
});

test('a client loop is rate limited by this Worker before it can reach a county server', async () => {
  const limiter = createRateLimiter({ clock: testClock, client: { windowMs: 60000, max: 3 }, source: { windowMs: 60000, max: 100 } });
  const { call, fetchImpl } = harness({ rateLimiter: limiter, store: null });
  const responses = [];
  for (let index = 0; index < 4; index += 1) responses.push(await call(CORNELIUS_ADVISORY));
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 429]);
  assert.equal(responses[3].headers.get('Retry-After') !== null, true);
  assert.equal((await bodyOf(responses[3])).error.code, 'RATE_LIMITED');
  assert.equal(fetchImpl.calls.length, 3, 'the refused request must not touch the source');
});

test('the per-source budget protects the upstream even when the cache is unavailable', async () => {
  const limiter = createRateLimiter({ clock: testClock, client: { windowMs: 60000, max: 100 }, source: { windowMs: 60000, max: 2 } });
  const { call, fetchImpl } = harness({ rateLimiter: limiter, store: null });
  for (let index = 0; index < 2; index += 1) assert.equal((await call(CORNELIUS_ADVISORY)).status, 200);
  const refused = await call(CORNELIUS_ADVISORY);
  assert.equal(refused.status, 429);
  assert.equal((await bodyOf(refused)).error.code, 'SOURCE_BUDGET_EXHAUSTED');
  assert.equal(fetchImpl.calls.length, 2, 'the source must not be read past its budget');
});

test('simultaneous identical requests share one upstream read', async () => {
  let resolveBody = null;
  const script = () => new Promise(resolve => { resolveBody = () => resolve(htmlResponse(ADVISORY_TEXT)); });
  const { call, fetchImpl } = harness({ script });
  const first = call(CORNELIUS_ADVISORY);
  const second = call(CORNELIUS_ADVISORY);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fetchImpl.calls.length, 1, 'the second request must join the first rather than race it');
  resolveBody();
  const [a, b] = await Promise.all([first, second]);
  assert.equal((await bodyOf(a)).status, 'EVIDENCE');
  assert.equal((await bodyOf(b)).status, 'EVIDENCE');
  assert.equal(fetchImpl.calls.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// Cache, freshness, drift, observability
// ---------------------------------------------------------------------------------------------------------------

test('a cached page is served without touching the source, and is labelled as cached', async () => {
  const { call, fetchImpl, store } = harness();
  const live = await bodyOf(await call(CORNELIUS_ADVISORY));
  assert.equal(live.cacheStatus, CACHE_STATUS.MISS);
  assert.equal(live.meta.cachedAt, null);
  const retrievedAt = live.retrievedAt;
  const beforeSecond = fetchImpl.calls.length;
  clockOffsetMs = 30000;
  const cached = await bodyOf(await call(CORNELIUS_ADVISORY));
  clockOffsetMs = 0;
  assert.equal(fetchImpl.calls.length, beforeSecond, 'a cached answer must not read the source again');
  assert.equal(cached.cacheStatus, CACHE_STATUS.HIT);
  assert.equal(cached.retrievedAt, retrievedAt, 'a cached answer keeps the original retrieval time');
  assert.equal(cached.meta.cachedAt, retrievedAt);
  assert.notEqual(cached.meta.answeredAt, cached.retrievedAt, 'the answer time is recorded separately');
  assert.equal(cached.diagnostics.some(entry => entry.code === 'cache'), true);
  assert.equal(store.size(), 1);
});

test('a cached page expires on its declared TTL and is then refetched', async () => {
  const { call, fetchImpl } = harness();
  await call(CORNELIUS_ADVISORY);
  clockOffsetMs = 16 * 60 * 1000;   // past the 15 minute closure-page TTL
  const refreshed = await bodyOf(await call(CORNELIUS_ADVISORY));
  clockOffsetMs = 0;
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(refreshed.cacheStatus, CACHE_STATUS.MISS);
  assert.equal(refreshed.diagnostics.some(entry => entry.code === 'cache' && /freshness window/.test(entry.message)), true);
});

test('two probes that read the same page share one cached read and keep their own facts', async () => {
  const { call, fetchImpl } = harness({ script: (url, init, callNumber) => htmlResponse('Wren Road/Susbauer Road intersection : Improvements to intersection (roundabout assumed).') });
  const first = await bodyOf(await call('wc-mstip-susbauer'));
  const second = await bodyOf(await call('wc-mstip-cornelius-roadsafety'));
  assert.equal(first.status, 'EVIDENCE');
  assert.equal(second.status, 'NO_RELEVANT_EVIDENCE', 'the other probe declares a different phrase');
  assert.equal(fetchImpl.calls.length, 1, 'one page, one upstream read');
  assert.equal(second.cacheStatus, CACHE_STATUS.HIT);
});

test('failures are never cached', async () => {
  let attempt = 0;
  const script = () => { attempt += 1; return attempt === 1 ? htmlResponse('throttled', { status: 429 }) : htmlResponse(ADVISORY_TEXT); };
  const { call, fetchImpl, store } = harness({ script });
  const failed = await bodyOf(await call(CORNELIUS_ADVISORY));
  assert.equal(failed.status, 'FAILED');
  assert.equal(store.size(), 0, 'a failed read must not be stored');
  const recovered = await bodyOf(await call(CORNELIUS_ADVISORY));
  assert.equal(recovered.status, 'EVIDENCE');
  assert.equal(fetchImpl.calls.length, 2);
});

test('a runtime without a cache store still answers, and says the cache is bypassed', async () => {
  const { call } = harness({ store: null });
  const body = await bodyOf(await call(CORNELIUS_ADVISORY));
  assert.equal(body.status, 'EVIDENCE');
  assert.equal(body.cacheStatus, CACHE_STATUS.BYPASS);
  assert.equal(body.diagnostics.some(entry => entry.code === 'cache'), true);
});

test('every answer carries the observability fields, and the log never contains page text', async () => {
  const lines = [];
  const { call } = harness({ log: line => lines.push(line) });
  const response = await call(CORNELIUS_ADVISORY);
  const body = await bodyOf(response);
  const meta = body.meta;
  for (const field of ['requestId', 'probeId', 'sourceHost', 'durationMs', 'upstreamBytes', 'cacheStatus', 'extractionStatus', 'answeredAt', 'normalizedBytes']) {
    assert.equal(field in meta, true, `meta.${field} is required`);
  }
  assert.equal(response.headers.get('X-Request-Id'), meta.requestId);
  assert.equal(response.headers.get('X-Worker-Version'), 'roadnaturalist-investigator-worker/1');
  assert.equal(lines.length > 0, true);
  const parsed = lines.map(line => JSON.parse(line));
  assert.equal(parsed.some(entry => entry.event === 'probe_served' && entry.probeId === CORNELIUS_ADVISORY), true);
  assert.equal(lines.join('\n').includes(RAW_MARKER), false, 'logs must not contain page content');
  assert.equal(/Bear|client-secret|cookie/i.test(lines.join('\n')), false);
});

test('drift is reported against the reviewed baseline without changing the answer', async () => {
  const probe = defaultProbeRegistry.get(CORNELIUS_ADVISORY).probe;
  // A first read of the same page defines the baseline, so the comparison is complete by construction.
  const first = harness();
  const firstBody = await bodyOf(await first.call(CORNELIUS_ADVISORY));
  const baseline = { schemaVersion: 'test', capturedAt: '2026-09-26T12:00:00.000Z',
    probes: [buildProbeBaseline(CORNELIUS_ADVISORY, { capturedAt: '2026-09-26T12:00:00.000Z', outcome: firstBody.status, facts: firstBody.facts })] };

  const unchanged = harness({ baseline });
  const unchangedBody = await bodyOf(await unchanged.call(CORNELIUS_ADVISORY));
  assert.equal(unchangedBody.drift.state, DRIFT_STATE.UNCHANGED);
  assert.match(unchangedBody.drift.note, /identical to the baseline/);

  const changed = harness({ baseline, script: () => htmlResponse(`${ADVISORY_TEXT} Impact: Lane closure Schedule: From: 11/01/2026 To: 11/20/2026`) });
  const changedBody = await bodyOf(await changed.call(CORNELIUS_ADVISORY));
  assert.equal(changedBody.status, 'EVIDENCE');
  assert.equal(changedBody.facts[0].effectiveUntil, '2026-10-07', 'the declared fact is returned verbatim; drift is only a diagnostic');

  const missing = harness({ baseline, script: () => htmlResponse('Cornelius Pass Road is somewhere else on this page') });
  const missingBody = await bodyOf(await missing.call(CORNELIUS_ADVISORY));
  assert.equal(missingBody.drift.state, DRIFT_STATE.NO_LONGER_MATCHES);
  assert.deepEqual(missingBody.drift.removed, [probe.facts[0].find]);
  assert.match(missingBody.drift.note, /does not treat it as a closure or a restriction/);

  const noBaseline = harness({ baseline: { schemaVersion: 'x', capturedAt: null, probes: [] } });
  assert.equal((await bodyOf(await noBaseline.call(CORNELIUS_ADVISORY))).drift.state, DRIFT_STATE.NO_BASELINE);
});

test('the committed baseline agrees with what the shared matching rules produce from the captured phrases', async () => {
  // The shipped baseline was generated from the reviewed operator capture. This asserts the two cannot drift apart
  // silently: extracting facts from the captured phrases with the shared rule set reproduces the baseline digests.
  const excerpts = JSON.parse(readFileSync(new URL('./fixtures/investigator/source-excerpts.json', import.meta.url)));
  const served = excerpts.sources;
  let compared = 0;
  for (const entry of DRIFT_BASELINE.probes) {
    const probe = defaultProbeRegistry.get(entry.probeId)?.probe;
    const excerpt = probe ? served[probe.url] : null;
    if (!probe || !excerpt || entry.factCount === 0) continue;
    const extracted = extractProbeFacts(probe, excerpt.text);
    assert.equal(extracted.facts.length, entry.factCount, `${entry.probeId}: the captured phrases no longer yield the baseline fact count`);
    assert.deepEqual(extracted.facts.map(fact => fact.quote).sort(), entry.facts.map(fact => fact.quote).sort(), `${entry.probeId}: quotes differ`);
    compared += 1;
  }
  assert.equal(compared >= 6, true, 'at least six probes should be comparable against the captured phrases');
});

test('the shipped baseline covers every declared probe and carries no page text', () => {
  const ids = new Set(DRIFT_BASELINE.probes.map(entry => entry.probeId));
  for (const declaration of ALL_PROBE_DECLARATIONS) assert.equal(ids.has(declaration.id), true, `${declaration.id} is missing from the baseline`);
  const serialized = JSON.stringify(DRIFT_BASELINE);
  assert.equal(serialized.length < 100000, true);
  assert.equal(/<html|<body|api[_-]?key|token|secret/i.test(serialized), false);
  assert.equal(DRIFT_BASELINE.probes.every(entry => typeof entry.digest === 'string' && Array.isArray(entry.facts)), true);
});

test('the normalized result is capped: a runaway fact set is withheld rather than truncated silently', async () => {
  const manyFacts = Array.from({ length: 3 }, (_, index) => ({ find: `declared phrase ${index}`, claimType: 'PUBLIC_ROAD', summary: 'x'.repeat(400) }));
  const probe = { ...ALL_PROBE_DECLARATIONS.find(entry => entry.id === CORNELIUS_ADVISORY), id: 'synthetic-fact-flood', facts: manyFacts };
  const { call } = harness({ probes: [probe], limits: { maxBytes: 524288, timeoutMs: 5000, maxRedirects: 1, maxResponseBytes: 600, maxFactsPerProbe: 32 },
    script: () => htmlResponse(manyFacts.map(fact => fact.find).join(' ')) });
  const body = await bodyOf(await call('synthetic-fact-flood'));
  assert.deepEqual(body.facts, []);
  assert.equal(body.diagnostics.some(entry => entry.code === 'response_truncated'), true);
});

// ---------------------------------------------------------------------------------------------------------------
// Extraction equivalence with the browser path
// ---------------------------------------------------------------------------------------------------------------

test('the Worker extracts exactly what the shared rule set extracts', async () => {
  const cases = [
    { id: 'wc-flooding-susbauer', text: SUSBAUER_TEXT },
    { id: 'wc-flooding-susbauer', text: 'Flooding and Winds. <strong>Susbauer and Fern Hill roads</strong> both flood often during heavy rainfall. We have installed permanent, manual-locking flood gates on both these roads. The gates on Susbauer Road are south of Hornecker Road and north of Long Road.' },
  ];
  for (const testCase of cases) {
    const { call } = harness({ probes: ALL_PROBE_DECLARATIONS.filter(entry => entry.id === testCase.id), script: () => htmlResponse(testCase.text) });
    const body = await bodyOf(await call(testCase.id));
    const probe = defaultProbeRegistry.get(testCase.id).probe;
    // The Worker reduces HTML to text before matching, so the shared rule set is fed the same text here.
    const shared = extractProbeFacts(probe, sharedTextOf(testCase.text));
    assert.equal(body.facts.length, shared.facts.length);
    assert.deepEqual(body.facts.map(fact => fact.quote), shared.facts.map(fact => fact.quote));
    assert.deepEqual(body.facts.map(fact => fact.claimType), shared.facts.map(fact => fact.claimType));
  }
});

test('a phrase that spans inline markup is still found, and the quote is the declared phrase', async () => {
  const page = 'The work improved Springville <strong>Road</strong> from 185th Avenue intersection   to\n  Kaiser Road in four phases:';
  const { call } = harness({ probes: ALL_PROBE_DECLARATIONS.filter(entry => entry.id === 'wc-springville-improvements-news'), script: () => htmlResponse(page) });
  const body = await bodyOf(await call('wc-springville-improvements-news'));
  assert.equal(body.status, 'EVIDENCE');
  assert.equal(body.facts[0].quote, 'The work improved Springville Road from 185th Avenue intersection to Kaiser Road in four phases:');
  assert.equal(body.facts[0].claimType, 'PUBLIC_ROAD');
});

test('several facts from one page keep their own claim types, values, and windows', async () => {
  const page = 'Susbauer and Fern Hill roads both flood often during heavy rainfall. ' +
    'We have installed permanent, manual-locking flood gates on both these roads. ' +
    'The gates on Susbauer Road are south of Hornecker Road and north of Long Road.';
  const { call } = harness({ probes: ALL_PROBE_DECLARATIONS.filter(entry => entry.id === 'wc-flooding-susbauer'), script: () => htmlResponse(page) });
  const body = await bodyOf(await call('wc-flooding-susbauer'));
  assert.equal(body.facts.length, 3);
  assert.deepEqual(body.facts.map(fact => fact.claimType), ['SEASONAL_CLOSURE', 'ROAD_MAINTAINED', 'GATE_REPORTED']);
  assert.equal(body.facts[0].recurrence, 'high-water');
  assert.equal(body.facts[0].scope, 'CORRIDOR');
  assert.equal(body.facts[2].corridorPart, 'south of Hornecker Road and north of Long Road');
});

test('a source that changes but still matches no longer reports the removed fact', async () => {
  const baseline = buildBaselineFromRecord({ capturedAt: '2026-09-26T00:02:01.389Z', corridors: { c1: { probes: [
    { probeId: 'wc-flooding-susbauer', outcome: 'EVIDENCE', evidence: [
      { claimType: 'SEASONAL_CLOSURE', quote: 'Susbauer and Fern Hill roads both flood often during heavy rainfall.' },
      { claimType: 'GATE_REPORTED', quote: 'The gates on Susbauer Road are south of Hornecker Road and north of Long Road.' }] },
  ] } } });
  const { call } = harness({ baseline, probes: ALL_PROBE_DECLARATIONS.filter(entry => entry.id === 'wc-flooding-susbauer'),
    script: () => htmlResponse('We have installed permanent, manual-locking flood gates on both these roads.') });
  const body = await bodyOf(await call('wc-flooding-susbauer'));
  assert.equal(body.drift.state, DRIFT_STATE.EVIDENCE_CHANGED);
  // Drift lists are reported in the signature's stable order (claim type, then quote), never in page order.
  assert.deepEqual(body.drift.removed, ['The gates on Susbauer Road are south of Hornecker Road and north of Long Road.',
    'Susbauer and Fern Hill roads both flood often during heavy rainfall.']);
  assert.deepEqual(body.drift.added, ['We have installed permanent, manual-locking flood gates on both these roads.']);
  assert.match(body.drift.note, /differ from the baseline/);
});

// ---------------------------------------------------------------------------------------------------------------
// Direct unit coverage of the fetch layer
// ---------------------------------------------------------------------------------------------------------------

test('fetchProbePage refuses to run without a registry policy and reports its own failures', async () => {
  const policy = buildProbePolicy(ALL_PROBE_DECLARATIONS.find(entry => entry.id === CORNELIUS_ADVISORY), { limits: { maxBytes: 1024, timeoutMs: 1000, maxRedirects: 0, maxResponseBytes: 4096 } });
  const probe = defaultProbeRegistry.get(CORNELIUS_ADVISORY).probe;
  const tooManyRedirects = await fetchProbePage({ probe, policy, fetchImpl: stubFetch(() => htmlResponse('', { status: 302, location: 'https://www.wc-roads.com/other' })) });
  assert.equal(tooManyRedirects.ok, false);
  assert.equal(tooManyRedirects.failure.code, FAILURE_CODE.REDIRECT_BLOCKED);
  const latin1 = await fetchProbePage({ probe, policy, fetchImpl: stubFetch(() => new Response(new TextEncoder().encode('Cornelius Pass Road From/To: At Rock Creek'), { status: 200, headers: { 'Content-Type': 'text/html; charset=iso-8859-1' } })) });
  assert.equal(latin1.ok, true);
  assert.match(latin1.text, /At Rock Creek/);
});

test('the worker entry rejects an unknown path and reports internal failures honestly', async () => {
  const notFound = await worker.fetch(new Request('https://investigator.test/whatever', { headers: { Origin: ORIGIN } }), {}, {});
  assert.equal(notFound.status, 404);
  const root = await worker.fetch(new Request('https://investigator.test/', { headers: { Origin: ORIGIN } }), {}, {});
  assert.equal(root.status, 200);
  const rootBody = await root.json();
  assert.match(rootBody.note, /declared probes only/);
  assert.equal(bodyHasNoSecrets(rootBody), true);
});

const sharedTextOf = text => normalizeWhitespace(htmlToText(text));

function bodyHasNoSecrets(value) { return !/api[_-]?key|token|secret|bearer/i.test(JSON.stringify(value)); }

test('production origins are allowed exactly, with no wildcard and no suffix matching', async () => {
  const production = ['https://roadnaturalist.com', 'https://www.roadnaturalist.com', 'https://roadnaturalist.pages.dev'];
  for (const origin of production) assert.equal(DEFAULT_ALLOWED_ORIGINS.includes(origin), true, `${origin} must be allowed`);
  assert.equal(DEFAULT_ALLOWED_ORIGINS.includes('*'), false);
  assert.equal(DEFAULT_ALLOWED_ORIGINS.every(origin => /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)), true,
    'every allowed origin is either https or an explicit local development origin');

  const { call } = harness();
  const pages = await call(CORNELIUS_ADVISORY, { origin: 'https://roadnaturalist.pages.dev' });
  assert.equal(pages.status, 200);
  assert.equal(pages.headers.get('Access-Control-Allow-Origin'), 'https://roadnaturalist.pages.dev');
  // A preview deployment has a generated hostname, and is refused: the app replays the reviewed capture there and says
  // so, which is better than the boundary accepting any *.pages.dev host.
  const preview = await call(CORNELIUS_ADVISORY, { origin: 'https://abc123.roadnaturalist.pages.dev' });
  assert.equal(preview.status, 403);
  assert.equal(preview.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await bodyOf(preview)).error.code, 'ORIGIN_NOT_ALLOWED');
});
