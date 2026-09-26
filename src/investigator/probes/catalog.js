// THE INVESTIGATOR PROBE CATALOG (SHARED LOADER).
//
// The declared sources live in data/investigator/probe-catalog.json, described by
// data/investigator/probe-catalog.schema.json. Both sides of the boundary load them through this module:
//
//   * the browser Investigator (src/investigator/sources.js) builds probes from the loaded catalog and reads those
//     sources only through a transport;
//   * the Worker (worker/investigator/registry.js) builds its server-owned registry from the same load and adds the
//     fetch policy there, so a client can never choose a URL.
//
// One loader, one validation pass, one corridor lookup: the two sides cannot disagree about what a probe says.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT KNOW: which hosts may be contacted, byte caps, timeouts, redirect policy,
// accepted content types, rate limits, and cache lifetimes. Those are server policy (worker/investigator/policies.js).
// The catalog names a logical profile ("closure-status"), and the profile vocabulary here is the shared contract the
// Worker's map must cover — which a test asserts, so the two cannot drift apart.
//
// Adding or updating a corridor's sources is a review of this catalog file, not a change to this module.
import catalogSource from '../../../data/investigator/probe-catalog.json' with { type: 'json' };
import schemaSource from '../../../data/investigator/probe-catalog.schema.json' with { type: 'json' };
import { ACCESS_CLAIM, CLAIM_STRENGTH, EVIDENCE_SCOPE, RECURRENCE, SOURCE_CLASS } from '../access.js';
import { PROBE_KIND, PROBE_STAGE, createProbe } from '../research.js';
import { checkAgainstSchema } from './schema-check.js';

export const CATALOG_SCHEMA_VERSION = 'roadnaturalist-investigator-probes/1';

// The id shape is the same one the Worker's route uses, so a catalog entry can never describe an id a client could
// not address (and never a path, an encoding trick, or a URL).
export const PROBE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

// Logical freshness profiles. Only the NAME travels in the catalog; the Worker maps a name to a cache lifetime, and
// refuses a name it does not implement. `checkPolicyProfiles` in scripts/validate-probes.mjs asserts that this list
// and the Worker's map are the same set.
export const POLICY_PROFILES = Object.freeze(['closure-status', 'project-page', 'jurisdiction-document']);

const SOURCE_CLASSES = Object.freeze(Object.values(SOURCE_CLASS));
const CLAIM_TYPES = Object.freeze(Object.values(ACCESS_CLAIM));
const CLAIM_STRENGTHS = Object.freeze(Object.values(CLAIM_STRENGTH));
const EVIDENCE_SCOPES = Object.freeze(Object.values(EVIDENCE_SCOPE));
const RECURRENCES = Object.freeze(Object.values(RECURRENCE));
const STAGES = Object.freeze(Object.values(PROBE_STAGE));
const KINDS = Object.freeze(Object.values(PROBE_KIND));

export const CATALOG_VOCABULARIES = Object.freeze({ sourceClasses: SOURCE_CLASSES, claimTypes: CLAIM_TYPES,
  claimStrengths: CLAIM_STRENGTHS, evidenceScopes: EVIDENCE_SCOPES, recurrences: RECURRENCES, stages: STAGES, kinds: KINDS,
  policyProfiles: POLICY_PROFILES });

// A probe is addressed by id; a corridor declares its own id and display name.
const describeProbe = (probe, index) => (probe && typeof probe.id === 'string' && probe.id) ? `Probe "${probe.id}"` : `Probe ${index}`;

// Turn a schema issue into a sentence a reviewer can act on, leading with the probe and the fact involved.
export function humanizeIssue(issue, catalog) {
  const segments = issue.pointer.split('/').filter(Boolean);
  const where = [];
  const probeIndex = segments[0] === 'probes' ? Number(segments[1]) : null;
  const probe = probeIndex === null ? null : catalog?.probes?.[probeIndex];
  const lead = probe ? describeProbe(probe, probeIndex) : 'Catalog';
  const factIndex = segments[0] === 'probes' && segments[2] === 'facts' ? Number(segments[3]) : null;
  if (factIndex !== null) where.push(`fact ${factIndex}${probe?.facts?.[factIndex]?.claimType ? ` (${probe.facts[factIndex].claimType})` : ''}`);
  const field = ['probes', 'corridors'].includes(segments[0]) && segments.length >= 3 ? segments.slice(segments.length - 1)[0] : null;
  if (field) where.push(`field "${field}"`);
  const subject = where.length ? `${lead}: ${where.join(', ')} ` : `${lead} `;
  return { message: `${subject}${issue.message}`, pointer: issue.pointer || '/', keyword: issue.keyword, detail: `${issue.pointer || '/'} — ${issue.message}` };
}


const freezeDeep = value => {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeep));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, freezeDeep(entry)])));
  return value;
};

const isoDate = value => Date.parse(`${value}T00:00:00Z`);

// Validation is one pass over the catalog: the committed schema first (shape, vocabularies, patterns), then the rules a
// schema cannot express — uniqueness, corridor references, contradictory definitions, and quoted evidence.
export function validateCatalog(catalog = catalogSource, schema = schemaSource) {
  const errors = [];
  const warnings = [];
  const push = (list, message, pointer, keyword = null) => list.push({ message, pointer, keyword, detail: `${pointer} — ${message}` });

  for (const issue of checkAgainstSchema(catalog, schema).map(entry => humanizeIssue(entry, catalog))) {
    errors.push({ ...issue, keyword: issue.keyword ?? 'schema' });
  }
  if (errors.length) return Object.freeze({ errors: Object.freeze(errors), warnings: Object.freeze(warnings) });

  const corridorIds = new Set();
  (catalog.corridors ?? []).forEach((corridor, index) => {
    if (corridorIds.has(corridor.id)) push(errors, `Corridor "${corridor.id}" is declared twice.`, `/corridors/${index}/id`, 'duplicate-corridor');
    corridorIds.add(corridor.id);
  });

  const seenProbeIds = new Map();
  (catalog.probes ?? []).forEach((probe, index) => {
    const label = describeProbe(probe, index);
    if (seenProbeIds.has(probe.id)) {
      push(errors, `Probe "${probe.id}" is declared twice (also at probe ${seenProbeIds.get(probe.id)}). Probe ids are the only thing a client may send, so they must be unique.`,
        `/probes/${index}/id`, 'duplicate-probe-id');
    }
    seenProbeIds.set(probe.id, index);

    for (const [position, corridorId] of (probe.corridorIds ?? []).entries()) {
      if (!corridorIds.has(corridorId)) {
        push(errors, `${label}: corridor "${corridorId}" is not declared in this catalog's corridors (${[...corridorIds].join(', ')}). Declare the corridor or fix the id.`,
          `/probes/${index}/corridorIds/${position}`, 'unknown-corridor');
      }
    }

    const seenFacts = new Map();
    (probe.facts ?? []).forEach((fact, factIndex) => {
      if (typeof fact.find === 'string' && !fact.find.trim()) {
        push(errors, `${label}: fact ${factIndex} has an empty phrase; the phrase must be text the source actually serves.`, `/probes/${index}/facts/${factIndex}/find`, 'empty-phrase');
      }
      if (typeof fact.find === 'string' && fact.find.trim() && seenFacts.has(fact.find)) {
        const previous = seenFacts.get(fact.find);
        const detail = previous.claimType === fact.claimType ? 'with the same claim type' : `but claims a different type (${previous.claimType} and ${fact.claimType})`;
        push(errors, `${label}: fact ${factIndex} repeats the phrase from fact ${previous.index} ${detail}. One phrase, one declared fact.`,
          `/probes/${index}/facts/${factIndex}/find`, 'duplicate-fact');
      } else if (typeof fact.find === 'string') {
        seenFacts.set(fact.find, { index: factIndex, claimType: fact.claimType });
      }
      const hasWindow = Boolean(fact.effectiveFrom || fact.effectiveUntil);
      if (hasWindow && !fact.windowQuote) {
        push(errors, `${label}: fact ${factIndex} declares an effective window without the verbatim windowQuote it was read from. A window must come from the source's own words.`,
          `/probes/${index}/facts/${factIndex}/windowQuote`, 'window-without-quote');
      }
      if (!hasWindow && fact.windowQuote) {
        push(warnings, `${label}: fact ${factIndex} quotes a window but declares no effectiveFrom/effectiveUntil.`, `/probes/${index}/facts/${factIndex}/windowQuote`, 'quote-without-window');
      }
      if (fact.effectiveFrom && fact.effectiveUntil && isoDate(fact.effectiveFrom) > isoDate(fact.effectiveUntil)) {
        push(errors, `${label}: fact ${factIndex} has effectiveFrom ${fact.effectiveFrom} after effectiveUntil ${fact.effectiveUntil}.`, `/probes/${index}/facts/${factIndex}/effectiveFrom`, 'inverted-window');
      }
      if (fact.recurrence && !fact.recurrenceQuote) {
        push(errors, `${label}: fact ${factIndex} declares recurrence "${fact.recurrence}" without the verbatim recurrenceQuote. Recurrence is only recorded when the source says it.`,
          `/probes/${index}/facts/${factIndex}/recurrenceQuote`, 'recurrence-without-quote');
      }
      if (!fact.recurrence && fact.recurrenceQuote) {
        push(warnings, `${label}: fact ${factIndex} quotes a recurrence but declares none.`, `/probes/${index}/facts/${factIndex}/recurrenceQuote`, 'quote-without-recurrence');
      }
      if (fact.scope === EVIDENCE_SCOPE.CORRIDOR_PART && !fact.corridorPart) {
        push(warnings, `${label}: fact ${factIndex} claims a corridor part without corridorPart, so the reader cannot see which part the source means.`,
          `/probes/${index}/facts/${factIndex}/corridorPart`, 'part-without-words');
      }
    });
  });

  // The same source declared twice with the same question and the same facts is one declaration that should list both
  // corridors, not two probes that can drift apart.
  const signatures = new Map();
  (catalog.probes ?? []).forEach((probe, index) => {
    const signature = JSON.stringify([probe.url, probe.question, probe.facts]);
    if (!signatures.has(signature)) { signatures.set(signature, probe); return; }
    push(warnings, `Probe "${probe.id}" declares exactly the same source, question, and facts as "${signatures.get(signature).id}". Merge them into one probe with both corridorIds instead of keeping two copies.`,
      `/probes/${index}/id`, 'duplicate-declaration');
  });

  return Object.freeze({ errors: Object.freeze(errors), warnings: Object.freeze(warnings) });
}

// The reviewed capture and the drift baseline are separate artifacts from the catalog: the catalog says what is
// expected, they say what was retrieved. This checks the three against each other without contacting anything.
export function checkReviewedArtifacts({ catalog, capture = null, baseline = null } = {}) {
  const warnings = [];
  const push = (message, artifact, probeId) => warnings.push({ message, artifact, probeId, detail: `${artifact}: ${message}` });
  const known = new Set((catalog.probes ?? []).map(probe => probe.id));

  const captureProbes = new Map();
  for (const corridor of Object.values(capture?.corridors ?? {})) {
    for (const entry of corridor.probes ?? []) captureProbes.set(entry.probeId, entry);
  }
  for (const probeId of captureProbes.keys()) {
    if (!known.has(probeId)) push(`the reviewed capture holds probe "${probeId}", which the catalog no longer declares. Refresh the capture (npm run investigator:refresh) or restore the probe.`, 'capture', probeId);
  }
  for (const probeId of known) {
    if (!captureProbes.has(probeId)) push(`probe "${probeId}" has no reviewed capture entry, so the browser replays nothing for it until the capture is refreshed (npm run investigator:refresh).`, 'capture', probeId);
  }

  const baselineIds = new Set((baseline?.probes ?? []).map(entry => entry.probeId));
  if (baseline) {
    for (const probeId of baselineIds) {
      if (!known.has(probeId)) push(`the drift baseline holds probe "${probeId}", which the catalog no longer declares, so its drift can never be compared. Refresh it (npm run investigator:refresh).`, 'drift-baseline', probeId);
    }
    for (const probeId of known) {
      if (!baselineIds.has(probeId)) push(`probe "${probeId}" has no drift baseline entry, so a live read of it cannot be compared with anything; run npm run investigator:refresh to record one.`, 'drift-baseline', probeId);
    }
  }

  return Object.freeze(warnings.map(entry => Object.freeze(entry)));
}

// Load, validate, and normalize. A catalog with errors throws: the Worker must not start able to serve a declaration
// nobody reviewed, and the browser must not silently run with no sources.
export function loadProbeCatalog({ source = catalogSource, schema = schemaSource } = {}) {
  if (source?.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new TypeError(`probe catalog schema version "${source?.schemaVersion ?? 'missing'}" is not supported by this build (expected ${CATALOG_SCHEMA_VERSION})`);
  }
  const validation = validateCatalog(source, schema);
  if (validation.errors.length) {
    throw new TypeError(`probe catalog is invalid:\n${validation.errors.map(entry => `  - ${entry.message}\n    ${entry.pointer}`).join('\n')}`);
  }

  const corridors = freezeDeep(source.corridors);
  const declarations = freezeDeep(source.probes);
  const probes = Object.freeze(declarations.map(createProbe));
  const probeById = new Map(probes.map(probe => [probe.id, probe]));
  const declarationById = new Map(declarations.map(declaration => [declaration.id, declaration]));
  const corridorIds = Object.freeze(corridors.map(corridor => corridor.id));

  // A probe with no corridorIds applies to every declared corridor; a probe with them applies to exactly those.
  const probesForCorridor = corridorId => Object.freeze(probes.filter(probe => !probe.corridorIds || probe.corridorIds.includes(corridorId)));

  return Object.freeze({ schemaVersion: source.schemaVersion, kind: source.kind ?? null, corridors, corridorIds,
    declarations, probes, probeIds: Object.freeze(probes.map(probe => probe.id)), probeById, declarationById,
    profileFor: probeId => declarationById.get(probeId)?.policyProfile ?? null,
    probesForCorridor, warnings: validation.warnings });
}

// The catalog this build ships with. Loaded once at module level: the same load serves the browser Investigator and the
// Worker registry, so a declaration cannot differ between them.
export const PROBE_CATALOG = loadProbeCatalog();
