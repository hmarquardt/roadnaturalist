// THE ENDPOINT.
//
// Two read-only routes, and nothing else:
//
//   GET /api/investigator/probes               → the declared probe ids and their public sources (no upstream contact)
//   GET /api/investigator/probes/:probeId      → one normalized probe result for that declared source
//
// The client sends a probe id. It cannot send a URL, a host, a header, a method, a query string that reaches the
// source, or a body. Everything else this Worker needs is committed policy, which is the whole reason the boundary
// can exist without becoming a proxy.
//
// A probe that fails upstream is still an HTTP 200 answer: the endpoint succeeded in determining that the source
// failed, and the result says so (`status: FAILED`, `diagnostics`). HTTP 429 from THIS Worker means the caller was
// rate limited; that is a different statement from the source throttling us, and the diagnostics say which.
import { CACHE_STATUS, createProbeCache } from './cache.js';
import { extractFacts, fetchProbePage } from './fetch-probe.js';
import { FETCH_LIMITS, WORKER_VERSION } from './policies.js';
import { defaultProbeRegistry, normalizeProbeId } from './registry.js';
import { createRateLimiter, createSingleFlight } from './ratelimit.js';
import { DRIFT_BASELINE } from '../../src/investigator/probes/drift-baseline.js';
import { DRIFT_STATE, baselineIndex, compareProbeEvidence } from '../../src/investigator/drift.js';
import { PROBE_OUTCOME } from '../../src/investigator/research.js';

export const API = Object.freeze({ LIST: '/api/investigator/probes', DETAIL_PREFIX: '/api/investigator/probes/' });

// Origins the frontend is served from, plus local development. A request with no Origin header (a script, curl, or a
// same-origin call) is allowed; a browser request from an origin that is not listed here is refused with 403 and no
// CORS header, so the boundary stays intentional even though everything served is public.
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'https://roadnaturalist.com',
  'https://www.roadnaturalist.com',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);

export function parseAllowedOrigins(value, fallback = DEFAULT_ALLOWED_ORIGINS) {
  if (typeof value !== 'string' || !value.trim()) return Object.freeze([...fallback]);
  return Object.freeze([...new Set(value.split(',').map(entry => entry.trim()).filter(Boolean))]);
}

const jsonResponse = (body, { status = 200, origin = null, allowedOrigins = DEFAULT_ALLOWED_ORIGINS, requestId = null, cacheControl = 'no-store', extraHeaders = {} } = {}) => {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl,
    'X-Worker-Version': WORKER_VERSION });
  if (requestId) headers.set('X-Request-Id', requestId);
  // CORS is only ever granted to a listed origin, and the answer varies by origin.
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
    headers.set('Access-Control-Expose-Headers', 'X-Request-Id, X-Worker-Version');
  }
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(JSON.stringify(body), { status, headers });
};

export function createInvestigatorHandler({ registry = defaultProbeRegistry, fetchImpl = fetch, cache = null, clock = () => new Date(),
  log = null, allowedOrigins = DEFAULT_ALLOWED_ORIGINS, rateLimiter = null, singleFlight = null, baseline = DRIFT_BASELINE,
  limits = FETCH_LIMITS } = {}) {
  const probeRegistry = typeof registry === 'function' ? registry() : registry;
  const probeCache = cache ?? createProbeCache({ clock });
  const limiter = rateLimiter ?? createRateLimiter({ clock });
  const flights = singleFlight ?? createSingleFlight();
  const baselines = baselineIndex(baseline);
  const requestCounter = { value: 0 };
  const nextRequestId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `rn-${Date.now().toString(36)}-${(requestCounter.value += 1).toString(36)}`);
  const clientKeyOf = request => request.headers.get('CF-Connecting-IP') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip') ?? 'unknown-client';

  function emit(event) { if (!log) return; try { log(JSON.stringify({ worker: WORKER_VERSION, ...event })); } catch { /* logging must never break a response */ } }

  // One probe: cache → (rate limit → single-flight fetch) → extract → drift → normalized result.
  async function runProbe({ entry, requestId, at }) {
    const { probe, policy } = entry;
    const sourceKey = policy.url.href;
    const cached = await probeCache.read({ sourceUrl: sourceKey });
    let page = null;
    let cacheStatus = cached.status;
    let upstreamDurationMs = null;
    let upstreamBytes = null;
    const diagnostics = [];
    if (cached.status === CACHE_STATUS.HIT && cached.entry?.text) {
      page = { ok: true, text: cached.entry.text, httpStatus: cached.entry.httpStatus ?? 200, contentType: cached.entry.contentType ?? null,
        upstreamBytes: cached.entry.upstreamBytes ?? null, textBytes: cached.entry.text.length, fetchedAt: cached.entry.fetchedAt,
        finalUrl: cached.entry.finalUrl ?? sourceKey, redirects: cached.entry.redirects ?? 0, durationMs: 0, fromCache: true };
      diagnostics.push({ code: 'cache', message: `served from the Worker cache, fetched ${cached.entry.fetchedAt}` });
    } else {
      if (cached.status === CACHE_STATUS.EXPIRED) diagnostics.push({ code: 'cache', message: 'the cached copy was past its freshness window and was refreshed' });
      if (cached.status === CACHE_STATUS.BYPASS) diagnostics.push({ code: 'cache', message: cached.reason ?? 'no cache store is bound in this runtime' });
      const sourceBudget = limiter.checkSource(sourceKey);
      if (!sourceBudget.allowed) {
        emit({ event: 'source_budget_exhausted', requestId, probeId: probe.id, sourceHost: policy.host, retryAfterSeconds: sourceBudget.retryAfterSeconds });
        return { httpStatus: 429, body: { error: { code: 'SOURCE_BUDGET_EXHAUSTED', message: `this Worker is reading ${policy.host} at its allowed rate; try again in ${sourceBudget.retryAfterSeconds}s` },
          retryAfterSeconds: sourceBudget.retryAfterSeconds }, cacheStatus, diagnostics: [...diagnostics, { code: 'source_budget', message: 'the per-source upstream budget for this minute is spent' }] };
      }
      const started = Date.now();
      const fetched = await flights.run(`${sourceKey}|${policy.maxBytes}`, () => fetchProbePage({ probe, policy, fetchImpl, now: clock, requestId }));
      upstreamDurationMs = Date.now() - started;
      if (fetched.ok) {
        page = fetched;
        upstreamBytes = fetched.upstreamBytes;
        const written = await probeCache.write({ sourceUrl: sourceKey, ttlSeconds: policy.cacheTtlSeconds ?? policy.ttlSeconds, entry: { text: fetched.text,
          httpStatus: fetched.httpStatus, contentType: fetched.contentType, upstreamBytes: fetched.upstreamBytes, fetchedAt: fetched.fetchedAt,
          finalUrl: fetched.finalUrl, redirects: fetched.redirects } });
        if (written?.status === CACHE_STATUS.UNCACHEABLE) diagnostics.push({ code: 'cache', message: written.reason });
        if (fetched.redirected) diagnostics.push({ code: 'redirect', message: `the source redirected once within ${policy.host}; the final URL is ${fetched.finalUrl}` });
        cacheStatus = cached.status === CACHE_STATUS.BYPASS ? CACHE_STATUS.BYPASS : CACHE_STATUS.MISS;
      } else {
        // A failure is never cached: the next request tries the source again (within its budget).
        const failureEntry = fetched.failure;
        // A failed source cannot be compared to the baseline: SOURCE_UNAVAILABLE is reported and the recorded
        // baseline stays visible, because this run learned nothing about the page's content.
        const drift = compareProbeEvidence(baselines.get(probe.id), { outcome: 'FAILED', facts: [] });
        const failureDiagnostics = [...diagnostics, { code: failureEntry.code, message: failureEntry.message }];
        emit({ event: 'source_failed', requestId, probeId: probe.id, sourceHost: policy.host, status: failureEntry.code,
          httpStatus: fetched.httpStatus ?? null, durationMs: fetched.durationMs, attempts: fetched.attempts?.length ?? 0, driftState: drift.state });
        return { httpStatus: 200, cacheStatus, drift, diagnostics: failureDiagnostics,
          body: probeResult({ probe, at, status: 'FAILED', facts: [], cacheStatus, drift, diagnostics: failureDiagnostics, retrievedAt: null,
            meta: probeMeta({ requestId, probe, policy, durationMs: fetched.durationMs, upstreamDurationMs, upstreamBytes: null, answeredAt: at.toISOString(),
              cacheStatus, cacheReason: diagnostics.find(entry => entry.code === 'cache')?.message ?? null,
              extractionStatus: 'not_run', httpStatus: fetched.httpStatus ?? null, attempts: fetched.attempts?.length ?? 1 }) }) };
      }
    }

    const extraction = extractFacts(probe, page.text);
    const facts = extraction.facts.slice(0, limits.maxFactsPerProbe);
    const status = facts.length ? PROBE_OUTCOME.EVIDENCE : PROBE_OUTCOME.NO_RELEVANT_EVIDENCE;
    const drift = compareProbeEvidence(baselines.get(probe.id), { outcome: status, facts });
    const durationMs = (page.durationMs ?? 0);
    if (drift.state !== DRIFT_STATE.UNCHANGED && drift.state !== DRIFT_STATE.NO_BASELINE) {
      emit({ event: 'source_drift', requestId, probeId: probe.id, sourceHost: policy.host, driftState: drift.state, added: drift.added.length, removed: drift.removed.length });
    }
    emit({ event: 'probe_served', requestId, probeId: probe.id, sourceHost: policy.host, status, durationMs, upstreamDurationMs,
      upstreamBytes, cacheStatus, extractionStatus: facts.length ? `${facts.length}_facts` : 'no_facts', driftState: drift.state,
      httpStatus: page.httpStatus });
    return { httpStatus: 200, cacheStatus, drift, diagnostics,
      body: probeResult({ probe, at, status, facts, cacheStatus, drift, diagnostics, retrievedAt: page.fetchedAt,
        meta: probeMeta({ requestId, probe, policy, durationMs, upstreamDurationMs, upstreamBytes, cacheStatus, answeredAt: at.toISOString(),
          cachedAt: page.fromCache ? page.fetchedAt : null, cacheReason: diagnostics.find(entry => entry.code === 'cache')?.message ?? null,
          extractionStatus: facts.length ? `${facts.length}_facts` : 'no_facts', httpStatus: page.httpStatus,
          sourceTextBytes: page.textBytes, redirects: page.redirects ?? 0, attempts: page.attempts?.length ?? 1 }) }) };
  }

  // The observability block on every probe answer. No credential, no page text, no user data: only what a reviewer
  // needs to see how the answer was produced.
  function probeMeta({ requestId, probe, policy, durationMs, upstreamDurationMs, upstreamBytes, cacheStatus, extractionStatus,
    httpStatus, sourceTextBytes = null, redirects = 0, attempts = 1, answeredAt = null, cachedAt = null, cacheReason = null }) {
    return { requestId, probeId: probe.id, sourceHost: policy.host, durationMs, upstreamDurationMs, upstreamBytes,
      cacheStatus, cacheReason, extractionStatus, httpStatus, sourceTextBytes, redirects, attempts, answeredAt, cachedAt, normalizedBytes: 0,
      policy: { ttlSeconds: policy.cacheTtlSeconds ?? policy.ttlSeconds, maxBytes: policy.maxBytes, timeoutMs: policy.timeoutMs } };
  }

  async function handle(request) {
    const at = clock();
    const requestId = nextRequestId();
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const originAllowed = !origin || allowedOrigins.includes(origin);

    if (request.method === 'OPTIONS') {
      if (!originAllowed) return jsonResponse({ error: { code: 'ORIGIN_NOT_ALLOWED', message: `${origin} is not an allowed Road Naturalist origin` } }, { status: 403, requestId });
      // A preflight answer has no body by definition.
      const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Worker-Version': WORKER_VERSION, 'X-Request-Id': requestId,
        'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Accept, Content-Type', 'Access-Control-Max-Age': '600' });
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'GET') return jsonResponse({ error: { code: 'METHOD_NOT_ALLOWED', message: 'this endpoint is read-only; use GET' } }, { status: 405, origin: originAllowed ? origin : null, allowedOrigins, requestId, extraHeaders: { Allow: 'GET, OPTIONS' } });
    if (!originAllowed) {
      emit({ event: 'origin_refused', requestId, origin, path: url.pathname });
      return jsonResponse({ error: { code: 'ORIGIN_NOT_ALLOWED', message: `${origin} is not an allowed Road Naturalist origin` } }, { status: 403, requestId });
    }
    const clientBudget = limiter.checkClient(clientKeyOf(request));
    if (!clientBudget.allowed) {
      emit({ event: 'client_rate_limited', requestId, retryAfterSeconds: clientBudget.retryAfterSeconds, path: url.pathname });
      return jsonResponse({ error: { code: 'RATE_LIMITED', message: `too many requests; try again in ${clientBudget.retryAfterSeconds}s` } }, { status: 429, origin, allowedOrigins, requestId,
        extraHeaders: { 'Retry-After': String(clientBudget.retryAfterSeconds) } });
    }

    if (url.pathname === API.LIST || url.pathname === `${API.LIST}/`) {
      return jsonResponse({ worker: WORKER_VERSION, probeCount: probeRegistry.size, probes: probeRegistry.list(),
        sourceHosts: probeRegistry.sourceHosts, cache: { enabled: probeCache.enabled, scope: 'per source URL, per declared TTL' },
        note: 'Declared investigator probes. Request one by id: GET /api/investigator/probes/:probeId. No client-supplied URL is accepted.', requestId },
        { origin, allowedOrigins, requestId, cacheControl: 'public, max-age=300' });
    }

    if (url.pathname.startsWith(API.DETAIL_PREFIX)) {
      const rawId = url.pathname.slice(API.DETAIL_PREFIX.length);
      const probeId = normalizeProbeId(decodeURIComponent(rawId));
      const entry = probeId ? probeRegistry.get(probeId) : null;
      if (!entry) {
        emit({ event: 'unknown_probe', requestId, requested: rawId.slice(0, 64) });
        return jsonResponse({ error: { code: 'UNKNOWN_PROBE', message: 'this probe id is not declared by Road Naturalist; no request was made to any source' } },
          { status: 404, origin, allowedOrigins, requestId });
      }
      const result = await runProbe({ entry, requestId, at });
      // A 429 is this Worker refusing to read the source again this minute; every other answer is a probe result.
      if (result.httpStatus === 429) return jsonResponse(result.body, { status: 429, origin, allowedOrigins, requestId,
        extraHeaders: { 'Retry-After': String(result.body.retryAfterSeconds ?? 5) } });
      const normalized = JSON.stringify({ ...result.body, meta: { ...result.body.meta, normalizedBytes: normalizedBytesOf(result.body) } });
      if (normalized.length > limits.maxResponseBytes) {
        emit({ event: 'response_truncated', requestId, probeId: entry.probe.id, bytes: normalized.length });
        return jsonResponse({ ...result.body, facts: [], meta: { ...result.body.meta, normalizedBytes: 0 },
          diagnostics: [...result.body.diagnostics, { code: 'response_truncated', message: `the normalized result exceeded ${limits.maxResponseBytes} bytes, so the facts were withheld rather than truncated silently` }] },
          { status: 200, origin, allowedOrigins, requestId, cacheControl: 'no-store' });
      }
      return jsonResponse(JSON.parse(normalized), { status: 200, origin, allowedOrigins, requestId,
        cacheControl: result.body.status === 'FAILED' ? 'no-store' : 'public, max-age=60',
        extraHeaders: { 'X-Normalized-Bytes': String(normalized.length) } });
    }

    if (url.pathname === '/' || url.pathname === '') {
      return jsonResponse({ worker: WORKER_VERSION, endpoints: [API.LIST, `${API.DETAIL_PREFIX}:probeId`],
        note: 'Road Naturalist investigator source boundary: declared probes only, no client-supplied URLs, normalized results only.', requestId },
        { origin, allowedOrigins, requestId, cacheControl: 'public, max-age=300' });
    }
    emit({ event: 'not_found', requestId, path: url.pathname.slice(0, 128) });
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'unknown endpoint' } }, { status: 404, origin, allowedOrigins, requestId });
  }

  // The size of the part that would otherwise have been a page: facts, drift, and diagnostics.
  const normalizedBytesOf = body => new TextEncoder().encode(JSON.stringify({ facts: body.facts, drift: body.drift, diagnostics: body.diagnostics })).length;

  // The response contract the browser Investigator already expects, plus freshness, cache, and drift fields.
  // `retrievedAt` is when the SOURCE was read (an upstream fetch time), never when this request was answered: a
  // cached answer must not look like a fresh read. `meta.answeredAt` carries the request time and `meta.cachedAt`
  // the time the cached copy was stored.
  function probeResult({ probe, at, retrievedAt, status, facts, cacheStatus, drift, diagnostics, meta }) {
    return { probeId: probe.id, status, organization: probe.organization, sourceClass: probe.sourceClass, sourceUrl: probe.url,
      stage: probe.stage, kind: probe.kind, title: probe.title, question: probe.question, appliesTo: probe.appliesTo ?? null,
      retrievedAt: retrievedAt ?? at.toISOString(), publishedAt: null,
      facts: facts.map(fact => ({ claimType: fact.claimType, quote: fact.quote, claimValue: fact.claimValue ?? null, summary: fact.summary ?? null,
        claimStrength: fact.claimStrength ?? null, corridorPart: fact.corridorPart ?? null, scope: fact.scope ?? null,
        effectiveFrom: fact.effectiveFrom ?? null, effectiveUntil: fact.effectiveUntil ?? null, recurrence: fact.recurrence ?? null })),
      drift, cacheStatus, diagnostics,
      meta: { ...meta, worker: WORKER_VERSION } };
  }

  return Object.freeze({ handle, registry: probeRegistry, cache: probeCache, limiter, flights, baselines, allowedOrigins,
    version: WORKER_VERSION });
}
