// PORTABLE CORRIDOR EVIDENCE BUNDLE.
//
// One versioned JSON document per corridor that carries what Road Naturalist knows and how it knows it:
// corridor identity, geometry reference, deterministic ecology/habitat/occurrence summaries, access evidence,
// contradictions, the qualified finding, investigation state, coverage, and freshness.
//
// What it must not contain, and does not:
//   * credentials or API keys — this pipeline holds none, and the validator rejects key-like field names;
//   * raw GIS datasets or cached API payloads — the bundle carries summaries and provenance, and it copies
//     no occurrence record, no wetland polygon, and no OSM way geometry;
//   * unqualified conclusions — every finding carries its rule, its date, its unresolved items, and its
//     contradictions. An interpretation may be attached as `interpretation`, which cannot set the finding.
//
// Corridor coordinates are omitted by default: a consumer that needs them can pass includeGeometry, and the
// bundle then records that it decided to carry them.
import { COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';

export const BUNDLE_SCHEMA_VERSION = 'roadnaturalist-corridor-evidence/1';
export const BUNDLE_KIND = 'corridor-evidence-bundle';
const MAX_TAXA = 12;
const FORBIDDEN_KEY = /(api[_-]?key|apikey|secret|token|password|credential|authorization|bearer)/i;

const sortById = list => [...list].sort((a, b) => String(a.id ?? a.probeId ?? '').localeCompare(String(b.id ?? b.probeId ?? '')));

function evidenceSummary(item) {
  return Object.freeze({ id: item.id, claimType: item.claimType, claimValue: item.claimValue, effect: item.effect, stance: item.stance,
    sourceClass: item.sourceClass, sourceTier: item.sourceTier, sourceOrganization: item.sourceOrganization, sourceTitle: item.sourceTitle,
    sourceUrl: item.sourceUrl, sourceType: item.sourceType, appliesTo: item.appliesTo, quote: item.quote, summary: item.summary,
    claimStrength: item.claimStrength, publishedAt: item.publishedAt, retrievedAt: item.retrievedAt, effectiveFrom: item.effectiveFrom,
    effectiveUntil: item.effectiveUntil, recurrence: item.recurrence, geographicScope: item.geographicScope,
    temporalScope: item.temporalScope ?? null, freshness: item.freshness ?? null, provenance: item.provenance });
}

function sectionSummary(section) {
  if (!section) return null;
  const { provenance, diagnostics, ...rest } = section;
  return Object.freeze({ ...rest, provenance: provenance ? Object.freeze({ ...provenance }) : null,
    diagnostics: diagnostics ? Object.freeze({ status: diagnostics.status ?? null, reason: diagnostics.reason ?? null, queryMs: diagnostics.queryMs ?? null }) : null });
}

export function buildCorridorBundle({ candidate, roads = [], ecology = null, habitat = null, occurrence = null, investigation = null,
  generatedAt = new Date().toISOString(), includeGeometry = false } = {}) {
  if (!candidate?.id) throw new TypeError('A bundle needs a corridor');
  const road = roads[0] ?? null;
  const access = investigation?.access ?? null;
  const coverage = Object.freeze(Object.fromEntries(Object.entries(candidate.coverage ?? {}).map(([datasetId, entry]) => [datasetId, Object.freeze({ coverage: entry.coverage, reason: entry.reason })])));
  // The access-verification row describes the research run, so an investigation in hand is the authority for it:
  // the bundle must not export a stale 'not yet analyzed' beside a finding.
  const accessCoverageRow = investigation?.access?.coverage
    ? Object.freeze({ ...coverage, [COVERAGE_DATASET.ACCESS_VERIFICATION]: Object.freeze({ coverage: investigation.access.coverage.coverage, reason: investigation.access.coverage.reason ?? null }) })
    : coverage;
  const occurrenceSources = Object.freeze(Object.fromEntries(Object.entries(occurrence?.sources ?? {}).map(([sourceId, source]) => [sourceId, Object.freeze({
    source: source.source, label: source.label, coverage: source.coverage, reason: source.reason ?? null, available: source.available ?? null,
    observations: source.observations ?? 0, uniqueTaxa: source.uniqueTaxa ?? 0, preciseObservations: source.preciseObservations ?? 0,
    regionalOnlyObservations: source.regionalOnlyObservations ?? 0, nearestM: source.nearestM ?? null, latestObservedAt: source.latestObservedAt ?? null,
    buckets: Object.freeze({ ...(source.buckets ?? {}) }), recency: Object.freeze({ ...(source.recency ?? {}) }), groups: Object.freeze([...(source.groups ?? [])]),
    // Taxa names only, capped: the bundle carries no per-observation record and no coordinate.
    taxa: Object.freeze((source.taxa ?? []).slice(0, MAX_TAXA).map(taxon => Object.freeze({ scientificName: taxon.scientificName, commonName: taxon.commonName ?? null,
      taxonomicGroup: taxon.taxonomicGroup ?? null, observations: taxon.observations ?? 0 }))),
    taxaTruncated: (source.taxa ?? []).length > MAX_TAXA,
    provenance: Object.freeze({ ...(source.provenance ?? {}) }), searchRadiusM: source.searchRadiusM ?? null, windowDays: source.windowDays ?? null })])));
  return Object.freeze({
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    kind: BUNDLE_KIND,
    generatedAt,
    corridor: Object.freeze({
      id: candidate.id, name: candidate.name, status: candidate.status ?? null, summary: candidate.summary ?? null,
      lengthM: candidate.corridor.lengthM, bounds: candidate.corridor.bounds, roadCount: candidate.corridor.roadCount,
      sourceFeatureCount: candidate.corridor.sourceFeatureCount, partCount: candidate.corridor.partCount,
      maxUnresolvedGapM: candidate.corridor.maxUnresolvedGapM, sourceCounties: candidate.corridor.sourceCounties,
      roadIds: candidate.corridor.roadIds, questions: Object.freeze([...(candidate.questions ?? [])]),
      declaredEvidence: Object.freeze((candidate.evidence ?? []).map(item => Object.freeze({ kind: item.kind, statement: item.statement, coverage: item.coverage, provenance: item.provenance }))),
      geometry: Object.freeze({ reference: 'geometry is held by the corridor and its road records', crs: 'EPSG:4326',
        included: Boolean(includeGeometry), coordinates: includeGeometry ? candidate.geometry : null }),
    }),
    geometry: road ? Object.freeze({ source: road.provenance.organization, dataset: road.provenance.dataset, datasetId: road.provenance.datasetId,
      datasetVersion: road.provenance.datasetVersion, publicationDate: road.provenance.sourcePublicationDate, license: road.provenance.license,
      documentationUrl: road.provenance.documentationUrl, datasetDigest: road.provenance.datasetDigest, retrievedAt: road.provenance.retrievedAt,
      crs: road.provenance.crs, sourceFeatureIds: road.provenance.sourceFeatureIds, composition: road.composition,
      normalization: road.provenance.normalization, perRoad: Object.freeze(roads.map(item => Object.freeze({ id: item.id, countyName: item.county?.name ?? null,
        lengthM: item.lengthM, sourceFeatureCount: item.evidence.geometry.sourceFeatureCount, composition: item.composition })) ) }) : null,
    ecology: ecology ? Object.freeze({ coverage: ecology.coverage, level3: sectionSummary(ecology.level3), level4: sectionSummary(ecology.level4),
      provenance: ecology.provenance ? Object.freeze({ method: ecology.provenance.method ?? null, sources: Object.freeze([...(ecology.provenance.sources ?? [])]) }) : null }) : null,
    habitat: habitat ? Object.freeze({ coverage: Object.freeze({ ...(habitat.coverage ?? {}) }), wetlands: sectionSummary(habitat.wetlands),
      hydrography: sectionSummary(habitat.hydrography), provenance: habitat.provenance ? Object.freeze({ method: habitat.provenance.method ?? null,
        wetlands: habitat.provenance.wetlands ? Object.freeze({ ...habitat.provenance.wetlands }) : null, hydrography: habitat.provenance.hydrography ? Object.freeze({ ...habitat.provenance.hydrography }) : null }) : null }) : null,
    occurrence: occurrence ? Object.freeze({ coverage: Object.freeze({ ...(occurrence.coverage ?? {}) }), analysisRadiiM: Object.freeze([...(occurrence.analysisRadiiM ?? [])]),
      measuredCrs: occurrence.measuredCrs ?? null, lenses: Object.freeze([...(occurrence.lenses ?? [])]), sources: occurrenceSources,
      provenance: Object.freeze({ ...(occurrence.provenance ?? {}) }), interpretation: occurrence.interpretation ?? null }) : null,
    access: access ? Object.freeze({
      finding: access.finding, meaning: access.meaning, ruleId: access.ruleId, rule: access.rule, checkedAsOf: access.checkedAsOf,
      evidenceCheckedAt: access.evidenceCheckedAt, publicRoadEvidence: access.publicRoadEvidence, motorVehicleAccess: access.motorVehicleAccess,
      restrictionsFound: access.restrictionsFound, scope: access.scope, evidenceCounts: access.evidenceCounts, organizations: access.organizations,
      affirmative: Object.freeze(sortById(access.affirmative).map(evidenceSummary)),
      community: Object.freeze(sortById(access.community).map(evidenceSummary)),
      restrictions: Object.freeze(sortById(access.restrictions).map(evidenceSummary)),
      attention: Object.freeze(sortById(access.attention).map(evidenceSummary)),
      contradictions: Object.freeze([...access.contradictions]),
      unresolved: Object.freeze([...access.unresolved]),
      qualifiers: Object.freeze([...access.qualifiers]),
      notActing: Object.freeze(sortById(access.notActing ?? []).map(evidenceSummary)),
      provisionalFinding: access.provisionalFinding ?? null, findingChangedByReview: access.findingChangedByReview ?? null,
      review: access.review ?? null,
      coverage: Object.freeze({ coverage: access.coverage?.coverage ?? COVERAGE.UNKNOWN, reason: access.coverage?.reason ?? null,
        probeSummary: access.coverage?.probeSummary ?? null }),
      sources: Object.freeze([...(access.sources ?? [])].map(source => Object.freeze({ ...source }))),
      provenance: Object.freeze({ ...(access.provenance ?? {}) }),
      human: access.human ? Object.freeze({ ...access.human }) : null,
      interpretation: access.interpretation ? Object.freeze({ ...access.interpretation }) : null,
      rejectedInterpretationCitations: Object.freeze([...(access.rejectedCitations ?? [])]),
    }) : null,
    investigation: investigation ? Object.freeze({
      environment: investigation.environment ?? null, transport: investigation.transport ?? null, ranAt: investigation.ranAt ?? null,
      stageSummary: investigation.stageSummary ?? null,
      stages: Object.freeze(investigation.stages.map(stage => Object.freeze({ id: stage.id, label: stage.label, status: stage.status, summary: stage.summary,
        counters: Object.freeze({ ...stage.counters }), warnings: Object.freeze([...(stage.warnings ?? [])]), evidenceIds: Object.freeze([...(stage.evidenceIds ?? [])]),
        sourceIds: Object.freeze([...(stage.sourceIds ?? [])]), startedAt: stage.startedAt, completedAt: stage.completedAt }))),
      authorities: Object.freeze((investigation.authorities ?? []).map(authority => Object.freeze({ ...authority }))),
      warnings: Object.freeze([...(investigation.warnings ?? [])]),
      osm: investigation.osm ? Object.freeze({ status: investigation.osm.status, retrievedAt: investigation.osm.retrievedAt, osmTimestamp: investigation.osm.osmTimestamp,
        capturedAt: investigation.osm.capturedAt ?? null, mirrorsUsed: Object.freeze([...(investigation.osm.mirrorsUsed ?? [])]),
        searchNames: Object.freeze([...(investigation.osm.searchNames ?? [])]), searchBounds: investigation.osm.searchBounds ?? null,
        match: investigation.osm.match ? Object.freeze({ ...investigation.osm.match, ways: Object.freeze((investigation.osm.match.ways ?? []).map(way => Object.freeze({ ...way }))) }) : null,
        nameVariants: Object.freeze([...(investigation.osm.nameVariants ?? [])]), waySummaries: Object.freeze([...(investigation.osm.waySummaries ?? [])]),
        failures: Object.freeze([...(investigation.osm.failures ?? [])]), queries: Object.freeze([...(investigation.osm.queries ?? [])]) }) : null,
      research: investigation.research ? Object.freeze({ probes: Object.freeze(investigation.research.probes.map(probe => Object.freeze({ probeId: probe.probeId, stage: probe.stage,
        organization: probe.organization, sourceClass: probe.sourceClass, title: probe.title, url: probe.url, question: probe.question, outcome: probe.outcome,
        searched: Object.freeze({ ...(probe.searched ?? {}) }), note: probe.note, evidenceIds: Object.freeze(probe.evidence.map(item => item.id)) }))),
        noRelevantEvidence: Object.freeze(investigation.research.noRelevantEvidence.map(probe => probe.probeId)),
        failures: Object.freeze(investigation.research.failures.map(probe => probe.probeId)),
        deferred: Object.freeze(investigation.research.deferred.map(probe => probe.probeId)) }) : null,
      plan: investigation.plan ?? null,
      baseline: investigation.baseline ?? null,
    }) : null,
    coverage: accessCoverageRow,
    freshness: Object.freeze({ generatedAt, accessEvidenceCheckedAt: access?.evidenceCheckedAt ?? null, accessEvaluatedAsOf: access?.checkedAsOf ?? null,
      osmRetrievedAt: investigation?.osm?.retrievedAt ?? null, staleAccessEvidenceIds: Object.freeze((access?.notActing ?? []).filter(item => item.temporalScope === 'STALE').map(item => item.id)) }),
  });
}

// IMPORT CONTRACT. Validation is strict about identity, version, and the few fields a consumer must rely on,
// and it refuses a document that carries something this bundle is never allowed to carry.
export function validateBundle(bundle) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  check(bundle && typeof bundle === 'object', 'bundle must be an object');
  if (!bundle || typeof bundle !== 'object') return Object.freeze({ valid: false, errors: Object.freeze(errors) });
  check(bundle.schemaVersion === BUNDLE_SCHEMA_VERSION, `schemaVersion must be ${BUNDLE_SCHEMA_VERSION}`);
  check(bundle.kind === BUNDLE_KIND, `kind must be ${BUNDLE_KIND}`);
  check(typeof bundle.generatedAt === 'string' && !Number.isNaN(Date.parse(bundle.generatedAt)), 'generatedAt must be an ISO date');
  check(bundle.corridor && typeof bundle.corridor.id === 'string' && bundle.corridor.id, 'corridor.id is required');
  check(bundle.corridor && typeof bundle.corridor.name === 'string' && bundle.corridor.name, 'corridor.name is required');
  check(bundle.corridor && Number.isFinite(bundle.corridor.lengthM), 'corridor.lengthM is required');
  check(bundle.coverage && typeof bundle.coverage === 'object', 'coverage is required');
  check(bundle.corridor.geometry.coordinates == null || bundle.corridor.geometry.included === true, 'corridor coordinates need includeGeometry, so the bundle states that it decided to carry them');
  if (bundle.access) {
    check(typeof bundle.access.finding === 'string' && bundle.access.finding, 'access.finding is required when access is present');
    check(typeof bundle.access.ruleId === 'string' && bundle.access.ruleId, 'access.ruleId is required: a finding must cite its guardrail');
    check(Array.isArray(bundle.access.contradictions), 'access.contradictions must be an array');
    check(Array.isArray(bundle.access.unresolved), 'access.unresolved must be an array');
    check(typeof bundle.access.checkedAsOf === 'string' && !Number.isNaN(Date.parse(bundle.access.checkedAsOf)), 'access.checkedAsOf is required');
  }
  const offending = forbiddenKeys(bundle);
  check(offending.length === 0, `bundle must not carry credential-like fields: ${offending.join(', ')}`);
  const coordinateLeak = coordinateLeakOf(bundle);
  check(coordinateLeak.length === 0, `bundle carries coordinates in a section that must stay summarized: ${coordinateLeak.join(', ')}`);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors), schemaVersion: bundle.schemaVersion ?? null, corridorId: bundle.corridor?.id ?? null });
}

// Field names that must never appear anywhere in a bundle.
function forbiddenKeys(value, path = '', found = []) {
  if (Array.isArray(value)) { value.forEach((entry, index) => forbiddenKeys(entry, `${path}[${index}]`, found)); return found; }
  if (!value || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key) && key !== 'credentialSafe') found.push(path ? `${path}.${key}` : key);
    forbiddenKeys(entry, path ? `${path}.${key}` : key, found);
  }
  return found;
}

// Per-feature data must stay out of the summarized sections: no occurrence record, no wetland polygon, no mapped
// way geometry, no observation coordinate. The check is by field name because that is what a consumer would look
// for, and a name-based check cannot be fooled by an array that merely happens to hold two numbers.
// Feature-level payload names. Section names like `geometry` are allowed: what is not allowed is an actual
// feature list, an observation point, a vertex array, or a coordinate pair inside a summarized section.
const SUMMARY_FORBIDDEN_FIELDS = Object.freeze(['points', 'records', 'coordinates', 'location', 'locations', 'lat', 'lon', 'latitude', 'longitude', 'centroid', 'rings', 'vertices', 'features', 'fields']);
function coordinateLeakOf(bundle) {
  const leaks = [];
  const inspect = (value, path) => {
    if (Array.isArray(value)) { value.forEach((entry, index) => inspect(entry, `${path}[${index}]`)); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (SUMMARY_FORBIDDEN_FIELDS.includes(key)) leaks.push(path ? `${path}.${key}` : key);
      else inspect(entry, path ? `${path}.${key}` : key);
    }
  };
  for (const section of ['ecology', 'habitat', 'occurrence', 'access', 'investigation']) inspect(bundle[section], section);
  return leaks;
}

export function parseBundle(text) {
  let parsed;
  try { parsed = typeof text === 'string' ? JSON.parse(text) : text; }
  catch (error) { throw new TypeError(`Bundle is not valid JSON: ${error.message}`); }
  const result = validateBundle(parsed);
  if (!result.valid) throw new TypeError(`Bundle failed validation: ${result.errors.join('; ')}`);
  return Object.freeze({ ...parsed, validation: result });
}

// A stable digest for the bundle's identity and provenance, so a reader can tell two exports apart without
// diffing them. This is a drift check, not a security hash.
export function bundleDigest(bundle) { return hashOf(JSON.stringify([bundle.schemaVersion, bundle.corridor?.id, bundle.generatedAt, bundle.access?.finding, bundle.access?.checkedAsOf])); }

function hashOf(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
