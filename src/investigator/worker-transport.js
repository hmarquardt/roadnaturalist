// WORKER-BACKED RESEARCH TRANSPORT.
//
// The browser cannot read a county site that sends no CORS header, so live official-source research goes through the
// Road Naturalist Worker boundary (worker/README.md). This transport is the browser's only client for it, and it
// sends a probe id — never a URL. The Worker answers with normalized facts; this module turns them into the same
// access-evidence items the recorded and live transports produce, so the finding logic cannot tell where a fact came
// from, and the retrieval mode is recorded rather than implied.
//
// It also records the *client-side* comparison against the reviewed capture, so a reader can see both "the Worker's
// own baseline says this source changed" and "the live facts differ from the capture this app replays".
import { createAccessEvidence } from './access.js';
import { PROBE_OUTCOME, failedProbeResult, factToAccessEvidence } from './research.js';
import { DRIFT_STATE, baselineIndex, compareProbeEvidence } from './drift.js';
import { RETRIEVAL_MODE, retrievalModeCounts } from './retrieval.js';

export const PROBE_LIST_PATH = '/api/investigator/probes';

function failureReasonFor(response, body) {
  const code = body?.error?.code ?? null;
  if (code === 'RATE_LIMITED') return { reason: 'the Worker rate limited this request; try again shortly', retryAfterSeconds: body?.retryAfterSeconds ?? null };
  if (code === 'SOURCE_BUDGET_EXHAUSTED') return { reason: 'the Worker has read this source at its allowed rate; try again shortly', retryAfterSeconds: body?.retryAfterSeconds ?? null };
  if (code === 'ORIGIN_NOT_ALLOWED') return { reason: 'this origin is not allowed to call the Worker boundary' };
  if (code === 'UNKNOWN_PROBE') return { reason: 'the Worker does not declare this probe, so nothing was read: the deployed boundary is older than this build' };
  return { reason: `the Worker answered HTTP ${response.status}${code ? ` (${code})` : ''}` };
}

// Ask the boundary what it declares. This contacts no source: it is the cheap check that decides whether the app can
// do live research at all, and its answer is recorded rather than assumed.
export async function probeAvailability({ baseUrl, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!baseUrl) return Object.freeze({ available: false, reason: 'no investigator Worker is configured for this build', worker: null, probeIds: Object.freeze([]) });
  try {
    const response = await fetchImpl(`${baseUrl}${PROBE_LIST_PATH}`, { headers: { Accept: 'application/json' },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined });
    if (!response.ok) return Object.freeze({ available: false, reason: `the Worker boundary answered HTTP ${response.status}`, worker: null, probeIds: Object.freeze([]) });
    const body = await response.json();
    return Object.freeze({ available: true, reason: null, worker: body.worker ?? null,
      probeIds: Object.freeze([...(body.probes ?? []).map(entry => entry.probeId)]), sourceHosts: Object.freeze([...(body.sourceHosts ?? [])]) });
  } catch (error) {
    return Object.freeze({ available: false, reason: `the Worker boundary could not be reached (${error.message})`, worker: null, probeIds: Object.freeze([]) });
  }
}

// The transport itself. `recordedBaseline` is the reviewed capture's probe entry for this probe, when one exists.
export function createWorkerResearchTransport({ baseUrl, fetchImpl = fetch, timeoutMs = 20000, now = () => new Date(),
  baseline = null, recordedProbes = null, id = 'worker-live' } = {}) {
  if (!baseUrl) throw new TypeError('The worker transport needs the boundary base URL');
  const recorded = recordedProbes ? baselineIndex({ probes: recordedProbes }) : baselineIndex(baseline);

  return Object.freeze({
    id, live: true, baseUrl,
    async run(probe, { corridorId }) {
      const retrieval = { transport: id, boundary: baseUrl, probeId: probe.id };
      let response = null;
      try {
        response = await fetchImpl(`${baseUrl}${PROBE_LIST_PATH}/${encodeURIComponent(probe.id)}`, { headers: { Accept: 'application/json' },
          signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined });
      } catch (error) {
        return failedProbeResult(probe, { reason: `the Road Naturalist worker boundary could not be reached (${error.message})`, retrievedAt: now().toISOString(), transport: id });
      }
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok || !body || typeof body !== 'object') {
        const { reason } = failureReasonFor(response, body);
        return failedProbeResult(probe, { reason, retrievedAt: now().toISOString(), transport: id });
      }

      const at = now().toISOString();
      const facts = Array.isArray(body.facts) ? body.facts : [];
      const retrievedAt = body.retrievedAt ?? at;
      const cacheStatus = body.cacheStatus ?? body.meta?.cacheStatus ?? null;
      const retrievalMode = cacheStatus === 'HIT' ? RETRIEVAL_MODE.CACHE : RETRIEVAL_MODE.LIVE;
      const diagnostics = collectDiagnostics(body);
      // The Worker's facts become the same evidence items the other transports produce. It cannot pass anything the
      // shared validator would reject, because every item is built here.
      const evidence = facts.map((fact, position) => factToAccessEvidence({ ...probe, id: probe.id }, fact, { corridorId,
        retrievedAt, httpStatus: body.meta?.httpStatus ?? null, bytes: body.meta?.upstreamBytes ?? null, transport: id,
        sourceTextHash: diagnostics.sourceTextHash ?? null, index: position + 1 })).map(item => createAccessEvidence({ ...item,
        provenance: { ...item.provenance, retrieval: { ...item.provenance.retrieval, retrievalMode, cacheStatus, requestId: body.meta?.requestId ?? null,
          answeredAt: body.meta?.answeredAt ?? null, cachedAt: body.meta?.cachedAt ?? null, viaWorker: true } } }));
      const outcome = PROBE_OUTCOME[body.status] ?? PROBE_OUTCOME.FAILED;
      const liveFacts = facts;
      const driftAgainstCapture = recorded.has(probe.id)
        ? compareProbeEvidence(recorded.get(probe.id), { outcome, facts: liveFacts })
        : compareProbeEvidence(null, { outcome, facts: liveFacts });
      // Coverage and the UI read `searched.reason`; a failed Worker read must put its diagnostics there rather than only
      // in prose, or a reader sees a failure with no cause.
      const failureReason = outcome === PROBE_OUTCOME.FAILED
        ? (diagnostics.entries.map(entry => `${entry.code}: ${entry.message}`).join('; ') || 'the boundary reported a failure without a diagnostic')
        : null;
      return Object.freeze({
        probeId: probe.id, stage: probe.stage, kind: probe.kind, organization: probe.organization, sourceClass: probe.sourceClass,
        title: probe.title, url: probe.url, question: probe.question, outcome,
        searched: Object.freeze({ url: probe.url, retrievedAt, reason: failureReason, httpStatus: body.meta?.httpStatus ?? null, bytes: body.meta?.upstreamBytes ?? null,
          transport: id, retrievalMode, cacheStatus, requestId: body.meta?.requestId ?? null, answeredAt: body.meta?.answeredAt ?? null,
          cachedAt: body.meta?.cachedAt ?? null, bytesNormalized: body.meta?.normalizedBytes ?? null,
          worker: { version: body.meta?.worker ?? null, policy: body.meta?.policy ?? null } }),
        matches: Object.freeze(facts.map(fact => Object.freeze({ claimType: fact.claimType, quote: fact.quote,
          windowQuote: null, recurrenceQuote: null }))),
        evidence: Object.freeze(evidence),
        drift: Object.freeze({ worker: body.drift ?? null, recorded: driftAgainstCapture }),
        diagnostics: Object.freeze(diagnostics.entries),
        deferred: false,
        note: outcome === PROBE_OUTCOME.EVIDENCE ? `${facts.length} declared fact(s) matched the source through the Worker boundary (${retrievalMode.toLowerCase()}).`
          : outcome === PROBE_OUTCOME.NO_RELEVANT_EVIDENCE ? 'The Worker read the source and none of the declared phrases is present. That is a no-result search, not evidence that nothing exists.'
          : `The Worker could not read this source: ${diagnostics.entries.map(entry => entry.message).join('; ') || 'no reason given'}`,
      });
    },
  });
}

// Diagnostics that matter to a reader, kept separate from the facts.
function collectDiagnostics(body) {
  const entries = Array.isArray(body.diagnostics) ? body.diagnostics.map(entry => ({ code: entry.code, message: entry.message })) : [];
  return { entries: Object.freeze(entries), sourceTextHash: null };
}

export const isWorkerUnavailable = result => result?.outcome === PROBE_OUTCOME.FAILED && /worker boundary could not be reached|worker boundary answered HTTP/.test(result?.searched?.reason ?? '');

export const driftStatesOf = results => Object.freeze(results.map(result => ({ probeId: result.probeId, worker: result.drift?.worker?.state ?? null,
  recorded: result.drift?.recorded?.state ?? DRIFT_STATE.NO_BASELINE })));

// Re-exported so a caller can ask for the vocabulary and the counts from the transport it already imports.
export { RETRIEVAL_MODE, retrievalModeCounts };

