// OFFICIAL-SOURCE AND WEB RESEARCH BOUNDARY.
//
// The Investigator asks named sources named questions and keeps the answer. Research results are not
// evidence until a declared fact matches text that the source actually served, and every result records
// what was searched, when, where it came from, and whether it could be re-verified.
//
// Deliberate limits:
//   * A probe declares its source and the phrases it looks for. A quote is therefore always a verbatim
//     substring of the retrieved document, never written by a model or by this code.
//   * A probe with no match is NO_RELEVANT_EVIDENCE. Absence of a source is never evidence of absence.
//   * A failed request is FAILED with its status and reason. It never degrades into "no restrictions found".
//   * A source that cannot be reached from the current environment (no CORS in a browser) is OPERATOR_ONLY,
//     which is visible in coverage as deferred work, not as a completed search.
//   * No credential is required or accepted here. Research that needs a secret belongs behind a reviewed
//     server boundary (worker/README.md) and is out of scope for this task.
// An optional narration hook exists only to attach interpretation text; it can never set a finding, and any
// citation it returns that was not actually retrieved is rejected and recorded.

import { CLAIM_STRENGTH, EVIDENCE_SCOPE, RECURRENCE, SOURCE_CLASS, createAccessEvidence } from './access.js';

export const PROBE_STAGE = Object.freeze({ ACCESS_RESEARCH: 'access-research', CONTRADICTION_SEARCH: 'contradiction-search' });
export const PROBE_OUTCOME = Object.freeze({ EVIDENCE: 'EVIDENCE', NO_RELEVANT_EVIDENCE: 'NO_RELEVANT_EVIDENCE', FAILED: 'FAILED', OPERATOR_ONLY: 'OPERATOR_ONLY', NOT_RUN: 'NOT_RUN' });
export const PROBE_KIND = Object.freeze({ ROAD_STATUS: 'road-status', AUTHORITY: 'authority', CLOSURE: 'closure', PRIVATE_ACCESS: 'private-access', PERMIT: 'permit', SURFACE: 'surface' });

// A public page should be able to see who is reading it. The only client identification sent.
export const RESEARCH_USER_AGENT = 'roadnaturalist/1.0 (corridor access evidence; +https://github.com/hmarquardt/roadnaturalist)';

const stageValues = new Set(Object.values(PROBE_STAGE));
const kindValues = new Set(Object.values(PROBE_KIND));

// A probe is a reviewable declaration: who is being asked, at what address, in which stage, and which
// verbatim phrases count as a fact.
//   facts[].find          — literal text that must appear in the retrieved document (the quote)
//   facts[].effectiveFrom / effectiveUntil — ISO dates read from that text (and checked against it by the
//                                           operator), so a closure window is explicit rather than implied
//   facts[].recurrenceFrom — literal text stating that the condition repeats (source-stated recurrence)
export function createProbe(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id) throw new TypeError('Probe needs an id');
  if (!stageValues.has(raw.stage)) throw new TypeError(`Probe ${raw.id} needs a known stage`);
  if (!Object.values(SOURCE_CLASS).includes(raw.sourceClass)) throw new TypeError(`Probe ${raw.id} needs a source class`);
  if (typeof raw.url !== 'string' || !raw.url.startsWith('https://')) throw new TypeError(`Probe ${raw.id} needs an https url`);
  if (typeof raw.question !== 'string' || !raw.question) throw new TypeError(`Probe ${raw.id} needs a question`);
  if (!Array.isArray(raw.facts) || !raw.facts.length) throw new TypeError(`Probe ${raw.id} needs at least one declared fact`);
  const facts = raw.facts.map(fact => {
    if (typeof fact.find !== 'string' || !fact.find) throw new TypeError(`Probe ${raw.id} facts need verbatim find text`);
    if (!fact.claimType) throw new TypeError(`Probe ${raw.id} facts need a claim type`);
    const effectiveFrom = fact.effectiveFrom ?? null;
    const effectiveUntil = fact.effectiveUntil ?? null;
    if ((effectiveFrom || effectiveUntil) && !fact.windowQuote) throw new TypeError(`Probe ${raw.id} closure facts need the quoted window text`);
    if (fact.recurrence != null && !Object.values(RECURRENCE).includes(fact.recurrence)) throw new TypeError(`Probe ${raw.id} has an unknown recurrence`);
    const scope = fact.scope ?? EVIDENCE_SCOPE.NOT_APPLICABLE;
    if (!Object.values(EVIDENCE_SCOPE).includes(scope)) throw new TypeError(`Probe ${raw.id} has an unknown evidence scope`);
    return Object.freeze({ find: fact.find, claimType: fact.claimType, claimValue: fact.claimValue ?? null, summary: fact.summary ?? null,
      claimStrength: fact.claimStrength ?? CLAIM_STRENGTH.DESCRIBED, scope, corridorPart: fact.corridorPart ?? null,
      effectiveFrom, effectiveUntil, windowQuote: fact.windowQuote ?? null, recurrence: fact.recurrence ?? null, recurrenceQuote: fact.recurrenceQuote ?? null });
  });
  return Object.freeze({ id: raw.id, stage: raw.stage, kind: raw.kind ?? PROBE_KIND.ROAD_STATUS, organization: raw.organization,
    authority: raw.authority ?? null,
    sourceClass: raw.sourceClass, sourceType: raw.sourceType ?? 'official web page', title: raw.title, url: raw.url, question: raw.question,
    appliesTo: raw.appliesTo ?? null, corridorIds: raw.corridorIds ? Object.freeze([...raw.corridorIds]) : null, facts: Object.freeze(facts) });
}

// Evaluate one retrieved document against one probe's declared facts. This is the ONLY place that decides whether
// a declared phrase counts as a fact, and it is shared by the browser transport, the operator script, the tests,
// and the Worker — so a proxied read can never become a different kind of evidence.
//
// `text` is the source's own text; HTML is reduced to text content and all whitespace is collapsed before matching,
// so a declared phrase that spans inline markup in the served page still matches, and a quote in the record is
// verbatim page text with normalized whitespace. Matching is exact substring matching on that normalized text:
// nothing is inferred, fuzzy-matched, or model-interpreted.
export function extractProbeFacts(probe, text) {
  if (typeof text !== 'string') throw new TypeError('Probe extraction needs the retrieved text');
  const haystack = normalizeWhitespace(text);
  const facts = [];
  for (const fact of probe.facts) {
    const needle = normalizeWhitespace(fact.find);
    if (haystack.indexOf(needle) < 0) continue;
    if (fact.windowQuote && !haystack.includes(normalizeWhitespace(fact.windowQuote))) continue;
    if (fact.recurrenceQuote && !haystack.includes(normalizeWhitespace(fact.recurrenceQuote))) continue;
    facts.push(Object.freeze({ claimType: fact.claimType, quote: fact.find, claimValue: fact.claimValue, summary: fact.summary,
      claimStrength: fact.claimStrength, scope: fact.scope, corridorPart: fact.corridorPart,
      effectiveFrom: fact.effectiveFrom, effectiveUntil: fact.effectiveUntil, windowQuote: fact.windowQuote,
      recurrence: fact.recurrence, recurrenceQuote: fact.recurrenceQuote }));
  }
  return Object.freeze({ facts: Object.freeze(facts), sourceTextHash: hashText(haystack) });
}

// One matched fact becomes one access-evidence item. The corridor is client-owned context, so extraction produces
// facts and this step attaches the corridor, the source identity, and the retrieval provenance.
export function factToAccessEvidence(probe, fact, { corridorId, retrievedAt, httpStatus = 200, bytes = null, transport = null, sourceTextHash = null, index = 1 }) {
  return createAccessEvidence({
    id: `probe-${probe.id}-${index}`,
    corridorId,
    claimType: fact.claimType,
    claimValue: fact.claimValue,
    sourceClass: probe.sourceClass,
    sourceOrganization: probe.organization,
    sourceTitle: probe.title,
    sourceUrl: probe.url,
    sourceType: probe.sourceType,
    appliesTo: probe.appliesTo,
    quote: fact.quote,
    summary: fact.summary ?? `${probe.organization}: ${probe.title}`,
    claimStrength: fact.claimStrength,
    publishedAt: null,
    retrievedAt,
    effectiveFrom: fact.effectiveFrom,
    effectiveUntil: fact.effectiveUntil,
    recurrence: fact.recurrence,
    geographicScope: { scope: fact.scope, corridorPart: fact.corridorPart },
    provenance: { method: 'Declared probe fact matched verbatim source text',
      retrieval: { httpStatus, bytes, sourceTextHash, transport, question: probe.question, stage: probe.stage } },
  });
}

export function extractProbeResult(probe, { corridorId, text, retrievedAt, httpStatus = 200, bytes = null, transport = null, sourceTextHash = null }) {
  const extracted = extractProbeFacts(probe, text);
  const matches = extracted.facts.map((fact, position) => Object.freeze({ claimType: fact.claimType, quote: fact.quote,
    windowQuote: fact.windowQuote, recurrenceQuote: fact.recurrenceQuote,
    evidence: factToAccessEvidence(probe, fact, { corridorId, retrievedAt, httpStatus, bytes, transport, sourceTextHash: sourceTextHash ?? extracted.sourceTextHash, index: position + 1 }) }));
  return Object.freeze({
    probeId: probe.id, stage: probe.stage, kind: probe.kind, organization: probe.organization, sourceClass: probe.sourceClass,
    title: probe.title, url: probe.url, question: probe.question,
    outcome: matches.length ? PROBE_OUTCOME.EVIDENCE : PROBE_OUTCOME.NO_RELEVANT_EVIDENCE,
    searched: Object.freeze({ url: probe.url, retrievedAt, httpStatus, bytes, transport, sourceTextHash: sourceTextHash ?? extracted.sourceTextHash }),
    matches: Object.freeze(matches),
    evidence: Object.freeze(matches.map(match => match.evidence)),
    note: matches.length ? `${matches.length} declared fact(s) matched source text.`
      : 'The source was retrieved but none of the declared phrases is present. That is a no-result search, not evidence that nothing exists.',
  });
}

export function failedProbeResult(probe, { reason, retrievedAt, transport = null, outcome = PROBE_OUTCOME.FAILED }) {
  return Object.freeze({ probeId: probe.id, stage: probe.stage, kind: probe.kind, organization: probe.organization, sourceClass: probe.sourceClass,
    title: probe.title, url: probe.url, question: probe.question, outcome,
    searched: Object.freeze({ url: probe.url, retrievedAt, httpStatus: null, bytes: null, transport, reason }),
    matches: Object.freeze([]), evidence: Object.freeze([]),
    note: outcome === PROBE_OUTCOME.OPERATOR_ONLY ? `Not run in this environment: ${reason}` : `Source failed: ${reason}` });
}

// TRANSPORTS.
//
//   createLiveResearchTransport  — operator/Node: fetch the declared URL and evaluate the declared facts.
//   createExcerptTransport       — tests and offline runs: evaluate captured page excerpts with the same code path.
//   createRecordedTransport      — browser: replay an operator-recorded research run, marking probes that this
//                                  environment cannot re-run instead of pretending they ran.
// A transport is the only place that knows about the network, so the stages never do.

export function createLiveResearchTransport({ fetchImpl = fetch, timeoutMs = 25000, operatorOnlyOrigins = [] } = {}) {
  return Object.freeze({
    id: 'live-http', live: true, operatorOnlyOrigins: Object.freeze([...operatorOnlyOrigins]),
    async run(probe, { corridorId, now }) {
      const retrievedAt = now().toISOString();
      const origin = new URL(probe.url).origin;
      if (operatorOnlyOrigins.includes(origin)) return failedProbeResult(probe, { reason: `this environment does not fetch ${origin}`, retrievedAt, transport: 'live-http', outcome: PROBE_OUTCOME.OPERATOR_ONLY });
      try {
        const response = await fetchImpl(probe.url, { headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'User-Agent': RESEARCH_USER_AGENT }, signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined, redirect: 'follow' });
        const raw = await response.text();
        if (!response.ok) return failedProbeResult(probe, { reason: `HTTP ${response.status}`, retrievedAt, transport: 'live-http' });
        const contentType = response.headers?.get?.('content-type') ?? '';
        const text = contentType.includes('json') ? raw : htmlToText(raw);
        return extractProbeResult(probe, { corridorId, text, retrievedAt, httpStatus: response.status, bytes: raw.length, transport: 'live-http', sourceTextHash: hashText(text) });
      } catch (error) {
        return failedProbeResult(probe, { reason: error.message, retrievedAt, transport: 'live-http' });
      }
    },
  });
}

export function createExcerptTransport({ excerpts, id = 'recorded-excerpts' } = {}) {
  const byUrl = new Map(Object.entries(excerpts ?? {}));
  return Object.freeze({
    id, live: false,
    async run(probe) {
      const entry = byUrl.get(probe.url);
      if (!entry) return failedProbeResult(probe, { reason: 'no captured excerpt for this source', retrievedAt: null, transport: id });
      return extractProbeResult(probe, { corridorId: entry.corridorId ?? null, text: entry.text, retrievedAt: entry.retrievedAt,
        httpStatus: entry.httpStatus ?? 200, bytes: entry.text.length, transport: id, sourceTextHash: hashText(entry.text) });
    },
  });
}

// Recorded runs keep the probe outcome and its retrieval metadata. A probe the record marks as not
// re-runnable here becomes OPERATOR_ONLY, so the UI can say which sources it could not re-check.
export function createRecordedTransport({ record, browserOrigins = [], id = 'recorded-operator-run' } = {}) {
  const byProbe = new Map((record?.probes ?? []).map(entry => [entry.probeId, entry]));
  return Object.freeze({
    id, live: false,
    async run(probe, { corridorId, now }) {
      const origin = new URL(probe.url).origin;
      const cannotFetchHere = browserOrigins.includes(origin);
      const entry = byProbe.get(probe.id);
      if (!entry) return failedProbeResult(probe, { reason: 'this source was not part of the recorded research run', retrievedAt: now().toISOString(), transport: id, outcome: PROBE_OUTCOME.NOT_RUN });
      // The recorded evidence is replayed with its own retrieval date and source URL. When this environment
      // cannot re-check the origin (a browser cannot read a county site that sends no CORS header), the source is
      // reported as deferred: the evidence is shown, and coverage is PARTIAL so nobody reads a replay as a fresh
      // check. The recorded outcome is never upgraded by replaying it.
      const evidence = (entry.evidence ?? []).map(item => createAccessEvidence({ ...item, corridorId: item.corridorId ?? corridorId }));
      const outcome = entry.outcome ?? (evidence.length ? PROBE_OUTCOME.EVIDENCE : PROBE_OUTCOME.NO_RELEVANT_EVIDENCE);
      const reason = cannotFetchHere
        ? `a browser cannot read ${new URL(probe.url).origin} (no CORS header), so this source is replayed from the recorded operator run and was not re-checked here; re-run the operator verification script to refresh it`
        : null;
      return Object.freeze({ probeId: probe.id, stage: probe.stage, kind: probe.kind, organization: probe.organization, sourceClass: probe.sourceClass,
        title: probe.title, url: probe.url, question: probe.question, outcome,
        searched: Object.freeze({ ...(entry.searched ?? {}), transport: id, liveVerified: !cannotFetchHere, reason: reason ?? entry.searched?.reason ?? null }),
        deferred: cannotFetchHere, matches: Object.freeze([]), evidence: Object.freeze(evidence),
        note: cannotFetchHere ? `Replayed from the recorded operator run${entry.searched?.retrievedAt ? ` (${String(entry.searched.retrievedAt).slice(0, 10)})` : ''} and not re-checked in this environment.` : (entry.note ?? 'Replayed from the recorded operator run.') });
    },
  });
}

// The research service: run the probes declared for a stage, in a fixed order, and keep every outcome.
export function createResearchService({ transport, probes, now = () => new Date() } = {}) {
  if (!transport) throw new TypeError('A research service needs a transport');
  const probeList = (probes ?? []).map(createProbe);
  return Object.freeze({
    transportId: transport.id,
    probes: probeList,
    probesFor(corridorId, stage) {
      return probeList.filter(probe => probe.stage === stage && (!probe.corridorIds || probe.corridorIds.includes(corridorId)));
    },
    async run({ corridorId, stage }) {
      const selected = probeList.filter(probe => probe.stage === stage && (!probe.corridorIds || probe.corridorIds.includes(corridorId)));
      const results = [];
      for (const probe of selected) results.push(await transport.run(probe, { corridorId, now }));
      return Object.freeze({ stage, transport: transport.id, results: Object.freeze(results), ranAt: now().toISOString() });
    },
  });
}

// A stable short digest of retrieved text, so a re-run can tell "same page" from "page changed" without
// keeping the page. (FNV-1a: no dependency, enough for drift detection, not a security hash.)
export function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// OPTIONAL NARRATION. A model or a person may attach interpretation to a finding. It cannot set one, and a
// citation to something that was not retrieved is rejected rather than displayed.
export function applyNarration(finding, narration, { evidenceIndex = [] } = {}) {
  if (!narration) return Object.freeze({ finding, narration: null, rejectedCitations: Object.freeze([]) });
  const known = new Set(evidenceIndex.map(item => item.sourceUrl).filter(Boolean));
  const citations = (narration.citations ?? []).map(String);
  const accepted = citations.filter(url => known.has(url));
  const rejected = citations.filter(url => !known.has(url));
  return Object.freeze({
    finding,
    narration: Object.freeze({ text: String(narration.text ?? '').slice(0, 2000), citations: Object.freeze(accepted),
      generatedAt: narration.generatedAt ?? null, generator: narration.generator ?? 'unrecorded',
      canSetFinding: false }),
    rejectedCitations: Object.freeze(rejected),
  });
}

// HTML pages are reduced to their text content before matching, and all whitespace is collapsed, because a
// declared phrase must be found in what the source actually served. Quotes in the UI are therefore verbatim
// page text with whitespace normalized, which docs/INVESTIGATOR.md states.
export function htmlToText(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#x2019;|&rsquo;/gi, '\u2019').replace(/&mdash;/gi, '\u2014')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export const normalizeWhitespace = text => String(text).replace(/[\s\u00a0]+/g, ' ').trim();
