// ONE REAL DIVERGENCE, RECORDED.
//
// `corridor_id` is a build identity. The national builder composes every road name across the whole country and
// numbers that name's connected components in order, so `c<N>` is a national ordinal; a windowed reconstruction
// composes the same name over far fewer features and numbers those components again, so the same physical road
// legitimately carries a different generated id. Source-evidence verification therefore does *not* compare ids: it
// requires the row's source feature set exactly, the segment position, and geometry within a metre (promotion.js).
//
// This module carries the record of that contract: the compact payload the promotion path emits for a real
// production run (counts and booleans, never feature-id arrays), the parser the release recorder applies to the
// browser output, and the rules under which a release may call itself verified. Keeping it here rather than inside
// the recorder means the shape the application emits and the shape a release accepts cannot drift apart.
import { PROMOTION_MAX_DRIFT_M } from './promotion.js';

export const IDENTITY_STAGE = 'sourceEvidence:identity';
export const IDENTITY_BASIS = 'source_feature_ids_exact';
export const IDENTITY_SOURCE_MATCH = Object.freeze({ EXACT: 'exact' });
export const IDENTITY_LABEL = Object.freeze({ SOURCE: 'Source-backed' });

// The representative divergence: the Princeton corridor the ordinal mismatch was first measured on. Its derived id
// is a build identity and must not change; what a release proves is that the reconstruction matched it anyway.
export const REPRESENTATIVE_IDENTITY = Object.freeze({
  place: 'Princeton, IN', corridor: 'River Rd', derivedId: 'drv1-river-rd-c226-s1',
});

// What the promotion path emits once a corridor is verified and its source reads have finished. The match is
// "exact" by construction: this payload only exists when verification accepted the reconstruction on source-feature
// membership, so a payload claiming anything else could not have been produced by the running code.
export function identityStagePayload({ identity = null, evidenceLevel = null } = {}) {
  const drift = identity?.geometryDriftM ?? {};
  return Object.freeze({
    corridorName: identity?.corridorName ?? null,
    derivedId: identity?.derivedId ?? null,
    reconstructedId: identity?.reconstructedId ?? null,
    idsDiffer: Boolean(identity?.derivedId) && Boolean(identity?.reconstructedId)
      && identity.derivedId !== identity.reconstructedId,
    identityBasis: IDENTITY_BASIS,
    sourceFeatureCount: Number(identity?.sourceFeatureCount ?? 0),
    sourceFeatureMatch: IDENTITY_SOURCE_MATCH.EXACT,
    segmentIndex: Number(identity?.segmentIndex ?? 0),
    segmentCount: Number(identity?.segmentCount ?? 0),
    geometryDriftM: Object.freeze({ derivedToSource: Number(drift.derivedToSource ?? 0),
      sourceToDerived: Number(drift.sourceToDerived ?? 0) }),
    sourceEvidence: evidenceLevel ?? null,
  });
}

// Every identity stage in a body of browser output. A malformed line is a problem, not an absence: a release may
// not be recorded as verified while the evidence it is supposed to rest on is unreadable.
export function parseIdentityEvidence(text) {
  const payloads = [];
  const problems = [];
  for (const line of String(text ?? '').split('\n')) {
    const at = line.indexOf(`${IDENTITY_STAGE} `);
    if (at < 0) continue;
    const json = line.slice(at + IDENTITY_STAGE.length + 1).trim();
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
      payloads.push(parsed);
    } catch (error) {
      problems.push(`an identity stage line is not readable JSON (${error.message})`);
    }
  }
  return Object.freeze({ count: payloads.length, payloads: Object.freeze(payloads),
    payload: payloads.length ? Object.freeze(payloads[payloads.length - 1]) : null, problems: Object.freeze(problems) });
}
// The compact block a release records: counts, booleans and the two drifts. Never the feature ids themselves.
export function recordIdentityEvidence({ payload = null } = {}) {
  if (!payload) return null;
  return Object.freeze({
    corridorName: payload.corridorName ?? null,
    derivedId: payload.derivedId ?? null,
    reconstructedId: payload.reconstructedId ?? null,
    idsDiffer: Boolean(payload.idsDiffer),
    identityBasis: payload.identityBasis ?? null,
    sourceFeatureCount: payload.sourceFeatureCount ?? null,
    sourceFeatureMatch: payload.sourceFeatureMatch ?? null,
    segmentIndex: payload.segmentIndex ?? null,
    segmentCount: payload.segmentCount ?? null,
    geometryDriftM: Object.freeze({ derivedToSource: payload.geometryDriftM?.derivedToSource ?? null,
      sourceToDerived: payload.geometryDriftM?.sourceToDerived ?? null }),
    sourceEvidence: payload.sourceEvidence ?? null,
  });
}

function driftProblems(payload, where) {
  const problems = [];
  const drift = payload.geometryDriftM ?? {};
  for (const key of ['derivedToSource', 'sourceToDerived']) {
    const value = drift[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      problems.push(`${where} records no usable ${key} geometry drift`);
    } else if (value > PROMOTION_MAX_DRIFT_M) {
      problems.push(`${where} geometry drift ${key} is ${value} m, beyond the ${PROMOTION_MAX_DRIFT_M} m contract`);
    }
  }
  return problems;
}

function payloadProblems(payload, where) {
  const problems = [];
  for (const name of ['corridorName', 'derivedId', 'reconstructedId']) {
    if (typeof payload[name] !== 'string' || !payload[name]) problems.push(`${where} names no ${name}`);
  }
  if (typeof payload.derivedId === 'string' && typeof payload.reconstructedId === 'string'
    && payload.idsDiffer !== (payload.derivedId !== payload.reconstructedId)) {
    problems.push(`${where} contradicts itself about whether the ids differ`);
  }
  if (payload.identityBasis !== IDENTITY_BASIS) {
    problems.push(`${where} does not rest on source-feature identity (basis ${payload.identityBasis ?? 'missing'})`);
  }
  if (payload.sourceFeatureMatch !== IDENTITY_SOURCE_MATCH.EXACT) {
    problems.push(`${where} does not record an exact source-feature match (match ${payload.sourceFeatureMatch ?? 'missing'})`);
  }
  if (!Number.isInteger(payload.sourceFeatureCount) || payload.sourceFeatureCount < 1) {
    problems.push(`${where} records no source feature count`);
  }
  if (!Number.isInteger(payload.segmentIndex) || payload.segmentIndex < 1) {
    problems.push(`${where} records no segment index`);
  }
  if (!Number.isInteger(payload.segmentCount) || payload.segmentCount < payload.segmentIndex) {
    problems.push(`${where} records no usable segment count`);
  }
  if (payload.sourceEvidence !== IDENTITY_LABEL.SOURCE) {
    problems.push(`${where} does not record source-backed evidence (recorded ${payload.sourceEvidence ?? 'nothing'})`);
  }
  return problems.concat(driftProblems(payload, where));
}

// The payload a release records: the representative divergence when the run produced one, otherwise the last
// corridor it promoted. A release artefact is about the case that proves the contract, not about volume.
export function representativePayload(state = {}) {
  const payloads = state.payloads ?? [];
  return payloads.find(payload => payload.derivedId === REPRESENTATIVE_IDENTITY.derivedId) ?? state.payload ?? null;
}

// The rules a release record must satisfy. Every payload that was emitted has to be internally sound, and when the
// representative corridor ran, one of them must be *it*: resting on exact source-feature identity, promoted with the
// ids differing, and reached source-backed evidence. Differing ids are not required in general - some corridors
// reconstruct to the same string - the contract is that identity matched either way.
export function identityEvidenceProblems(state = {}, { required = false } = {}) {
  const problems = [...(state.problems ?? [])];
  const payloads = state.payloads ?? [];
  if (!state.count) {
    if (required) {
      problems.push(`the representative corridor ${REPRESENTATIVE_IDENTITY.corridor} `
        + `(${REPRESENTATIVE_IDENTITY.derivedId}) was exercised but no ${IDENTITY_STAGE} line was recorded`);
    }
    return problems;
  }
  payloads.forEach((payload, index) => problems.push(...payloadProblems(payload, `identity evidence ${index + 1}`)));
  const representative = payloads.find(payload => payload.derivedId === REPRESENTATIVE_IDENTITY.derivedId) ?? null;
  if (required && !representative) {
    problems.push(`no identity evidence was recorded for ${REPRESENTATIVE_IDENTITY.derivedId}, the build id of the `
      + 'representative corridor');
  }
  if (required && representative && representative.corridorName !== REPRESENTATIVE_IDENTITY.corridor) {
    problems.push(`${REPRESENTATIVE_IDENTITY.derivedId} was recorded for ${representative.corridorName ?? 'no corridor'}, `
      + `not ${REPRESENTATIVE_IDENTITY.corridor}: the canonical release proves the contract with the known divergence`);
  }
  if (required && representative && !representative.idsDiffer) {
    problems.push(`${REPRESENTATIVE_IDENTITY.derivedId} reconstructed under its own build id, so this run does not show `
      + 'that a diverging reconstruction is still verified by source identity');
  }
  return problems;
}


// Was the representative corridor actually exercised by this browser run? Read from the run's own report line, so a
// release that skipped the case is not failed for missing evidence, and one that ran it cannot pass without any.
export function representativeExercised(text) {
  const marker = 'DETAIL_PRODUCTION ';
  for (const line of String(text ?? '').split('\n')) {
    const at = line.indexOf(marker);
    if (at < 0) continue;
    try {
      const entry = JSON.parse(line.slice(at + marker.length).trim());
      if (entry?.corridor === REPRESENTATIVE_IDENTITY.corridor) return true;
    } catch { /* a printed line that is not the report is simply not the report */ }
  }
  return false;
}
