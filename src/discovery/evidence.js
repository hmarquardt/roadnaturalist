// TWO LEVELS OF DETAIL, AND NEVER A BLURRED LINE BETWEEN THEM.
//
// A discovered corridor can always be inspected. What it is inspected *with* is a different question, and the
// answer is stated rather than implied:
//
//   derived  - the corridor's metrics as the national analysis build computed them and the immutable derived plane
//              stores them. Available everywhere a corridor exists, read from the row, no source cell fetched.
//   source   - the corridor rebuilt from the published raw road network and measured against the published raw
//              wetland and hydrography cells: the deeper inspection, available only where those cells are online.
//
// The distinction is not decoration. The derived metrics are exactly what the build measured from the same sources
// - they are not estimates, and they are not re-measured live - while source evidence is a fresh read of the
// published cells, which is why it can also disagree (a different published version) and why it is optional. A
// corridor whose raw wetland cells have never been published is therefore *derivable* and not *unopenable*: the
// detail opens, says which level it is, and offers the deeper one only when the cells are there.
//
// Evidence is per plane, because a corridor can be source-backed for its road (the national road plane is online
// everywhere) while its wetlands are still precomputed. `detailLevel` is `source` only when every plane is;
// anything else is `derived`, and each section carries its own label.
export const DETAIL_LEVEL = Object.freeze({ DERIVED: 'derived', SOURCE: 'source' });
export const EVIDENCE_PLANES = Object.freeze(['roads', 'ecology', 'wetlands', 'hydrography']);
export const EVIDENCE_SOURCE = Object.freeze({ DERIVED: 'derived', SOURCE: 'source' });

// The wording the whole application uses. One term per level, everywhere: "precomputed" for values the national
// build measured and stored, "source-backed" for values measured now from published source cells. Nothing is
// called estimated (the derived values are exact measurements), verified (that word belongs to the digest checks),
// or live (nothing here is a live feed).
export const EVIDENCE_TERM = Object.freeze({
  derived: Object.freeze({ short: 'Precomputed', long: 'Precomputed source metrics',
    note: 'Measured by the national analysis build from the source datasets and stored in the derived plane.' }),
  source: Object.freeze({ short: 'Source-backed', long: 'Source-level evidence',
    note: 'Measured now from the published source cells: the corridor rebuilt from the raw road network and read '
      + 'against the published wetland and hydrography cells.' }),
});

export function evidenceLabel(value) {
  return EVIDENCE_TERM[value]?.short ?? EVIDENCE_TERM.derived.short;
}

export function derivedEvidence() {
  return Object.freeze(Object.fromEntries(EVIDENCE_PLANES.map(plane => [plane, EVIDENCE_SOURCE.DERIVED])));
}

// The evidence a source run produced. A plane the run did not cover stays derived, so a partially source-backed
// corridor is representable without pretending the other planes were read.
export function sourceEvidence({ roads = false, ecology = false, wetlands = false, hydrography = false } = {}) {
  const value = { roads, ecology, wetlands, hydrography };
  return Object.freeze(Object.fromEntries(EVIDENCE_PLANES
    .map(plane => [plane, value[plane] ? EVIDENCE_SOURCE.SOURCE : EVIDENCE_SOURCE.DERIVED])));
}

export function detailLevelFor(evidence) {
  return EVIDENCE_PLANES.every(plane => evidence?.[plane] === EVIDENCE_SOURCE.SOURCE)
    ? DETAIL_LEVEL.SOURCE : DETAIL_LEVEL.DERIVED;
}

// What a corridor's detail may claim about itself, computed once so the panel and the tests agree.
export function detailEvidence({ detailLevel = DETAIL_LEVEL.DERIVED, evidence = null, sourceStatus = null } = {}) {
  const planes = evidence ?? derivedEvidence();
  return Object.freeze({ detailLevel, evidence: planes, sourceStatus,
    sourceBacked: EVIDENCE_PLANES.filter(plane => planes[plane] === EVIDENCE_SOURCE.SOURCE) });
}

// The one sentence a person reads when the deeper level is not published for this corridor. It names the bounded
// planes that are missing and nothing else: roads are published nationally, so they are never a reason.
export function unavailableMessage(missing, { detail = false } = {}) {
  const planes = Object.entries(missing ?? {}).filter(([, cells]) => cells.length);
  if (!planes.length) {
    return 'Source-level wetland and hydrography evidence has not yet been published for this corridor. '
      + 'The metrics shown are the precomputed national analysis values. National discovery is unaffected.';
  }
  const cells = planes.flatMap(([, ids]) => ids);
  const counts = planes.map(([plane, ids]) => `${plane}: ${ids.length}`).join(', ');
  const message = `Source-level evidence has not yet been published for this corridor: ${cells.length} raw source `
    + `cell${cells.length === 1 ? '' : 's'} (${counts}) ${cells.length === 1 ? 'is' : 'are'} missing. The metrics `
    + 'shown are the precomputed national analysis values. National discovery is unaffected.';
  return detail ? `${message} Missing cells: ${cells.join(', ')}.` : message;
}

// WHO OWNS A SOURCE-EVIDENCE RUN.
//
// A selection can change while a promotion is still composing its road network. The run that finishes later must
// not write its metrics over the corridor the person is now looking at, so every run takes an identity token when it
// starts and may only settle while it still holds it. This is the whole of the guard, kept here as plain bookkeeping
// so it can be tested directly rather than only through the panel.
export function createEvidenceRequests() {
  const tokens = new Map();
  return {
    begin(id) {
      const token = Symbol(String(id));
      tokens.set(String(id), token);
      return () => tokens.get(String(id)) === token;
    },
    finish(id, isMine) {
      if (isMine()) tokens.delete(String(id));
    },
    pending() {
      return tokens.size;
    },
  };
}
