// SOURCE DRIFT DETECTION.
//
// An official web page is not a data feed: a county rewrites a project page, moves a closure to a new notice, or
// quietly drops a sentence. This module compares the *normalized extracted facts* of a probe against a reviewed
// baseline (the committed operator capture), never the raw HTML, so a layout change is not reported as evidence
// drift and a finding is never changed merely because a page moved something.
//
// It is dependency-free and pure, because both sides of the research boundary use it: the Worker compares its own
// fresh fetch against the compact baseline it ships with, and the browser compares a live Worker result against
// the recorded capture it already replays. One implementation, one vocabulary.

export const DRIFT_STATE = Object.freeze({
  UNCHANGED: 'UNCHANGED',
  EVIDENCE_CHANGED: 'EVIDENCE_CHANGED',
  NO_LONGER_MATCHES: 'NO_LONGER_MATCHES',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  NO_BASELINE: 'NO_BASELINE',
});

export const DRIFT_SCHEMA_VERSION = 'roadnaturalist-investigator-drift-baseline/1';

export function stableDigest(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

// A fact signature accepts either an access-evidence item (whose part of the corridor lives in geographicScope) or a
// Worker fact (which states it directly). Only fields that carry meaning are compared: never a page position, a
// retrieval time, or a byte count.
//
// Dates are compared as instants, because the same declared window travels as '2026-10-07' in a declaration and as an
// ISO timestamp once it has been normalized into an evidence item. That difference must not read as drift.
export function normalizeDateValue(value) {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

export function factSignature(facts = []) {
  return [...facts].map(fact => ({
    claimType: fact.claimType ?? null,
    quote: fact.quote ?? null,
    claimValue: fact.claimValue ?? null,
    effectiveFrom: normalizeDateValue(fact.effectiveFrom),
    effectiveUntil: normalizeDateValue(fact.effectiveUntil),
    recurrence: fact.recurrence ?? null,
    corridorPart: fact.corridorPart ?? fact.geographicScope?.corridorPart ?? null,
    corridorScope: fact.geographicScope?.scope ?? fact.scope ?? null,
  })).sort((left, right) => String(left.claimType).localeCompare(String(right.claimType))
    || String(left.quote).localeCompare(String(right.quote)));
}

export const evidenceDigest = facts => stableDigest(factSignature(facts));

export function buildProbeBaseline(probeId, { capturedAt, outcome, facts = [], sourceUrl = null }) {
  const signature = factSignature(facts);
  return Object.freeze({ probeId, capturedAt: capturedAt ?? null, outcome: outcome ?? null, sourceUrl,
    factCount: signature.length, digest: stableDigest(signature), facts: Object.freeze(signature) });
}

// The compact baseline the Worker ships with, derived from the reviewed operator capture. It carries the extracted
// facts only: no page text, no HTML, no credential, and no corridor context it does not need.
export function buildBaselineFromRecord(record, { capturedAt = null } = {}) {
  const probes = [];
  for (const entry of Object.values(record?.corridors ?? {})) {
    for (const probe of entry.probes ?? []) {
      probes.push(buildProbeBaseline(probe.probeId, { capturedAt: record.capturedAt ?? capturedAt,
        outcome: probe.outcome ?? null, facts: probe.evidence ?? [], sourceUrl: probe.searched?.url ?? null }));
    }
  }
  return Object.freeze({ schemaVersion: DRIFT_SCHEMA_VERSION, kind: 'investigator-drift-baseline',
    capturedAt: record?.capturedAt ?? capturedAt ?? null,
    note: 'Normalized extracted facts from the reviewed operator capture. The Worker compares its own fresh fetch against this; it never compares raw pages, and it never changes a finding because a page changed.',
    probes: Object.freeze(probes) });
}

export const baselineIndex = baseline => new Map((baseline?.probes ?? []).map(entry => [entry.probeId, entry]));

const UNAVAILABLE_OUTCOMES = new Set(['FAILED', 'OPERATOR_ONLY', 'NOT_RUN']);

// Compare one live probe result against its baseline. A state is reported; the finding is not touched.
export function compareProbeEvidence(baselineEntry, { outcome = null, facts = [] } = {}) {
  const live = factSignature(facts);
  const digest = stableDigest(live);
  if (!baselineEntry) return Object.freeze({ state: DRIFT_STATE.NO_BASELINE, digest, baselineDigest: null, baselineCapturedAt: null, factCount: live.length, added: Object.freeze(live.map(entry => entry.quote)), removed: Object.freeze([]),
    note: 'No reviewed baseline exists for this probe, so a change cannot be detected yet. The live result stands on its own and is not compared to anything.' });
  if (UNAVAILABLE_OUTCOMES.has(outcome)) return Object.freeze({ state: DRIFT_STATE.SOURCE_UNAVAILABLE, digest: null, baselineDigest: baselineEntry.digest, baselineCapturedAt: baselineEntry.capturedAt, factCount: live.length,
    added: Object.freeze([]), removed: Object.freeze([]), note: `The source could not be read in this run (${outcome}), so drift cannot be judged. The recorded baseline of ${baselineEntry.capturedAt ?? 'an unrecorded date'} is unchanged and still shown.` });
  if (digest === baselineEntry.digest) return Object.freeze({ state: DRIFT_STATE.UNCHANGED, digest, baselineDigest: baselineEntry.digest, baselineCapturedAt: baselineEntry.capturedAt, factCount: live.length,
    added: Object.freeze([]), removed: Object.freeze([]), note: `The declared facts extracted from this source are identical to the baseline of ${baselineEntry.capturedAt ?? 'an unrecorded date'}.` });
  const baselineQuotes = new Set((baselineEntry.facts ?? []).map(entry => entry.quote));
  const liveQuotes = new Set(live.map(entry => entry.quote));
  const added = live.filter(entry => !baselineQuotes.has(entry.quote)).map(entry => entry.quote);
  const removed = (baselineEntry.facts ?? []).filter(entry => !liveQuotes.has(entry.quote)).map(entry => entry.quote);
  if (!live.length) return Object.freeze({ state: DRIFT_STATE.NO_LONGER_MATCHES, digest, baselineDigest: baselineEntry.digest, baselineCapturedAt: baselineEntry.capturedAt, factCount: 0,
    added: Object.freeze([]), removed: Object.freeze(removed), note: `The source was read successfully but none of its declared phrases is present any more. The baseline of ${baselineEntry.capturedAt ?? 'an unrecorded date'} contained ${baselineEntry.factCount ?? (baselineEntry.facts ?? []).length} fact(s); this run found none. Road Naturalist reports this as drift and does not treat it as a closure or a restriction.` });
  return Object.freeze({ state: DRIFT_STATE.EVIDENCE_CHANGED, digest, baselineDigest: baselineEntry.digest, baselineCapturedAt: baselineEntry.capturedAt, factCount: live.length,
    added: Object.freeze(added), removed: Object.freeze(removed), note: `The extracted facts differ from the baseline of ${baselineEntry.capturedAt ?? 'an unrecorded date'} (${added.length} new, ${removed.length} no longer present). The live facts are used; the difference is reported for review.` });
}

export function summarizeDrift(entries = []) {
  const counts = Object.fromEntries(Object.values(DRIFT_STATE).map(state => [state, 0]));
  for (const entry of entries) if (entry?.state) counts[entry.state] = (counts[entry.state] ?? 0) + 1;
  const changed = counts.EVIDENCE_CHANGED + counts.NO_LONGER_MATCHES;
  return Object.freeze({ counts: Object.freeze(counts), changed, hasDrift: changed > 0,
    note: changed ? `${changed} source(s) differ from the reviewed baseline; each difference is listed with the facts involved.`
      : 'No source differs from the reviewed baseline.' });
}
