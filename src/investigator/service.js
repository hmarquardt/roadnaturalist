// THE INVESTIGATOR SERVICE.
//
// One staged pipeline turns deterministic corridor evidence plus declared research into a qualified access
// finding. It is deliberately boring:
//
//   baseline → road context (OSM) → authority discovery → access research → contradiction search
//            → adversarial review → finding
//
// Rules of engagement:
//   * every stage records its status, counters, warnings, and the evidence ids it produced;
//   * a failed source degrades coverage and is reported — it never becomes "nothing found";
//   * the provisional finding is computed before the contradiction search, so a later discovery is visible
//     as a revision rather than as a foregone conclusion;
//   * coverage describes whether the research completed; the finding describes what the evidence supports.
//     They are separate numbers that never overwrite each other.
import { COVERAGE } from '../domain/corridor.js';
import { ACCESS_CLAIM, ACCESS_EFFECT, CLAIM_STRENGTH, EVIDENCE_SCOPE, SOURCE_CLASS, adversarialReview, createAccessEvidence, deriveAccessFinding } from './access.js';
import { OSM_ACCESS_SIGNAL } from './osm.js';
import { nameVariantsOf, matchOsmWaysToCorridor } from './osm-match.js';
import { PROBE_OUTCOME } from './research.js';
import { deriveAuthorities } from './sources.js';
import { STAGE_DEFS, STAGE_STATUS, finishStage, stageSummary, startStage } from './workflow.js';
import { retrievalModeCounts } from './retrieval.js';

export const ACCESS_COVERAGE_REASON = 'Access verification coverage describes whether the research completed: each source is either answered or reported as a failure or a deferred source. It says nothing about what the evidence supports.';
export const OSM_BOUNDS_PADDING_DEG = 0.003;   // ≈330 m north/south, ≈230 m east/west at pilot latitudes

// Road names to search for. Sources spell the same road differently: TIGER/Line says "NW Susbauer Rd" while
// OpenStreetMap says "Northwest Susbauer Road" (and "Northeast" for a Portland-quadrant prefix). The search set
// is generated deterministically — name as given, expanded abbreviations and direction, and core name without
// the direction — so a mapped way is retrieved rather than missed, and the match step, not the query, decides
// which ways belong to the corridor.
const NAME_ABBREVIATIONS = Object.freeze({ rd: 'road', st: 'street', ave: 'avenue', blvd: 'boulevard', dr: 'drive', ln: 'lane', hwy: 'highway', ct: 'court', pl: 'place', n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest' });
const DIRECTION_WORDS = new Set(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);
const titleCase = tokens => tokens.map(token => token.length <= 3 ? token.toUpperCase() : token[0].toUpperCase() + token.slice(1)).join(' ');

export function osmSearchNames(corridorName) {
  const tokens = String(corridorName).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const expanded = tokens.map(token => NAME_ABBREVIATIONS[token] ?? token);
  const names = [corridorName, titleCase(expanded), titleCase(expanded.filter(token => !DIRECTION_WORDS.has(token)))];
  return Object.freeze([...new Set(names.filter(Boolean))]);
}

export const padBounds = (bounds, padding = OSM_BOUNDS_PADDING_DEG) => [bounds[0] - padding, bounds[1] - padding, bounds[2] + padding, bounds[3] + padding];

// OSM evidence. Community-mapped facts only: what the tags say, the geometry relationship, and name variants.
// A missing access tag produces ACCESS_TAG_ABSENT, which is neutral: it is not evidence of public access.
export function osmEvidence({ corridorId, corridorName, ways, match, barriers, retrievedAt, osmTimestamp, status, failures }) {
  const items = [];
  for (const way of ways) {
    const signal = way.accessSignal;
    // Ways without an explicit access tag are aggregated into one item below: 100 identical 'no tag' items would
    // bury the two that actually say something. An explicit access tag always gets its own evidence item.
    if (signal.signal === OSM_ACCESS_SIGNAL.ABSENT) continue;
    const scope = { scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: way.name ?? null, note: `OpenStreetMap way ${way.osmId}` };
    const base = { corridorId, sourceClass: SOURCE_CLASS.TIER_3_COMMUNITY, sourceOrganization: 'OpenStreetMap contributors',
      sourceTitle: `OpenStreetMap ${way.osmType} ${way.osmId}`, sourceUrl: way.url, sourceType: 'community map data', appliesTo: way.name ?? corridorName,
      retrievedAt, geographicScope: scope, provenance: { method: 'OpenStreetMap tags retrieved through Overpass and matched to the corridor geometry',
        retrieval: { mirror: way.provenance.mirror, osmTimestamp: way.provenance.osmTimestamp, query: way.provenance.query, status } } };
    if (signal.signal === OSM_ACCESS_SIGNAL.EXPLICIT_PUBLIC || signal.signal === OSM_ACCESS_SIGNAL.EXPLICIT_PERMISSIVE) {
      items.push(createAccessEvidence({ ...base, id: `osm-${way.osmId}-access`, claimType: ACCESS_CLAIM.MOTOR_VEHICLES_ALLOWED, claimValue: Object.entries(signal.values).map(([key, value]) => `${key}=${value}`).join(' '),
        quote: Object.entries(signal.values).map(([key, value]) => `${key}=${value}`).join(' '), claimStrength: CLAIM_STRENGTH.DESCRIBED,
        summary: `OpenStreetMap states ${Object.entries(signal.values).map(([key, value]) => `${key}=${value}`).join(', ')} on ${way.name ?? 'a way'} matching the corridor.` }));
    } else if (signal.signal === OSM_ACCESS_SIGNAL.EXPLICIT_RESTRICTED) {
      items.push(createAccessEvidence({ ...base, id: `osm-${way.osmId}-restricted`, claimType: ACCESS_CLAIM.MOTOR_VEHICLES_RESTRICTED, claimValue: Object.entries(signal.values).map(([key, value]) => `${key}=${value}`).join(' '),
        quote: Object.entries(signal.values).map(([key, value]) => `${key}=${value}`).join(' '), claimStrength: CLAIM_STRENGTH.DESCRIBED,
        summary: `OpenStreetMap states a restrictive access value (${Object.entries(signal.values).map(([key, value]) => `${key}=${value}`).join(', ')}) on ${way.name ?? 'a way'} matching the corridor.` }));
    }
  }
  const untagged = ways.filter(way => way.accessSignal.signal === OSM_ACCESS_SIGNAL.ABSENT);
  if (untagged.length) {
    const classes = [...new Set(untagged.map(way => way.highway).filter(Boolean))].sort();
    const names = [...new Set(untagged.map(way => way.name).filter(Boolean))];
    items.push(createAccessEvidence({ id: 'osm-access-tag-absent', corridorId, claimType: ACCESS_CLAIM.ACCESS_TAG_ABSENT,
      claimValue: `${untagged.length} of ${ways.length} matched way(s)`, sourceClass: SOURCE_CLASS.TIER_3_COMMUNITY,
      sourceOrganization: 'OpenStreetMap contributors', sourceTitle: 'OpenStreetMap matched ways — access tags', sourceUrl: null,
      sourceType: 'community map data', appliesTo: corridorName, retrievedAt,
      quote: `access tags absent on ${untagged.length} of ${ways.length} matched way(s) (highway=${classes.join(', ') || 'unrecorded'})`,
      summary: `OpenStreetMap carries no access, motor_vehicle, motorcar or vehicle tag on ${untagged.length} of the ${ways.length} mapped ways matching this corridor${names.length ? ` (named ${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})` : ''}. That means the tags are absent: OpenStreetMap makes no access statement here, which is neither public access nor a restriction.`,
      geographicScope: { scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: untagged.length === ways.length ? 'every matched way' : `${untagged.length} matched ways` },
      provenance: { method: 'OpenStreetMap tags retrieved through Overpass and matched to the corridor geometry', retrieval: { osmTimestamp, status, failures: failures?.length ?? 0 } } }));
  }
  const classes = [...new Set(ways.map(way => way.highway).filter(Boolean))].sort();
  if (classes.length) {
    items.push(createAccessEvidence({ id: 'osm-road-class', corridorId, claimType: ACCESS_CLAIM.ROAD_CLASS, claimValue: classes.join(', '),
      sourceClass: SOURCE_CLASS.TIER_3_COMMUNITY, sourceOrganization: 'OpenStreetMap contributors', sourceTitle: 'OpenStreetMap highway classification (matched ways)',
      sourceUrl: null, sourceType: 'community map data', appliesTo: corridorName, retrievedAt, quote: `highway=${classes.join(', highway=')}`,
      summary: `Mapped ways matching this corridor carry highway=${classes.join(', ')}. Classification is mapped context, not a status statement.`,
      geographicScope: { scope: EVIDENCE_SCOPE.CORRIDOR_PART }, provenance: { method: 'OpenStreetMap tags retrieved through Overpass and matched to the corridor geometry' } }));
  }
  for (const variant of nameVariantsOf(corridorName, ways)) {
    items.push(createAccessEvidence({ id: `osm-name-variant-${variant.name}`, corridorId, claimType: ACCESS_CLAIM.ROAD_NAME_VARIANT, claimValue: variant.name,
      sourceClass: SOURCE_CLASS.TIER_3_COMMUNITY, sourceOrganization: 'OpenStreetMap contributors', sourceTitle: 'OpenStreetMap way names near the corridor',
      sourceUrl: null, sourceType: 'community map data', appliesTo: corridorName, retrievedAt, quote: `mapped name: ${variant.name}`,
      summary: `Mapped ways near this corridor are named "${variant.name}" (${variant.relation.toLowerCase().replace(/_/g, ' ')} relative to ${corridorName}). Check that a source statement about a similarly named road applies to this corridor.`,
      geographicScope: { scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: variant.name }, provenance: { method: 'Name comparison against the corridor name (directional prefixes recorded, not discarded)' } }));
  }
  if (barriers.length) {
    const gates = barriers.filter(barrier => barrier.barrier);
    items.push(createAccessEvidence({ id: 'osm-barriers', corridorId, claimType: ACCESS_CLAIM.GATE_REPORTED, claimValue: `${gates.length} barrier node(s)`,
      sourceClass: SOURCE_CLASS.TIER_3_COMMUNITY, sourceOrganization: 'OpenStreetMap contributors', sourceTitle: 'Mapped barrier nodes in the corridor bounding box',
      sourceUrl: null, sourceType: 'community map data', appliesTo: corridorName, retrievedAt,
      quote: `barrier tags near the corridor: ${[...new Set(gates.map(barrier => barrier.barrier))].join(', ') || 'none'}`,
      summary: `OpenStreetMap maps ${gates.length} barrier node(s) in the corridor's bounding box (${[...new Set(gates.map(barrier => barrier.barrier))].slice(0, 6).join(', ') || 'types unrecorded'}). These are mapped features, not confirmed gates on the carriageway.`,
      geographicScope: { scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: `bounding box (±${OSM_BOUNDS_PADDING_DEG}°)` }, provenance: { method: 'Overpass node query for barrier tags in the corridor bounding box' } }));
  }
  return Object.freeze({ items: Object.freeze(items), match, status, failures });
}

// Deterministic baseline: what already exists before any research, and what is missing.
export function baselineEvidence({ candidate, roads, evidence = {} }) {
  const road = roads?.[0] ?? null;
  const occurrenceSources = Object.values(evidence.occurrence?.sources ?? {});
  return Object.freeze({
    geometry: Object.freeze({ lengthM: candidate.corridor.lengthM, bounds: candidate.corridor.bounds,
      roadCount: candidate.corridor.roadCount, sourceFeatureCount: candidate.corridor.sourceFeatureCount,
      partCount: candidate.corridor.partCount, maxUnresolvedGapM: candidate.corridor.maxUnresolvedGapM,
      counties: candidate.corridor.sourceCounties, source: road?.provenance?.dataset ?? null, datasetVersion: road?.provenance?.datasetVersion ?? null }),
    ecology: evidence.ecology ? Object.freeze({ coverage: evidence.ecology.coverage ?? COVERAGE.UNKNOWN,
      level3: evidence.ecology.level3?.primary?.name ?? null, level4: evidence.ecology.level4?.primary?.name ?? null }) : null,
    habitat: evidence.habitat ? Object.freeze({ coverage: Object.freeze({ ...(evidence.habitat.coverage ?? {}) }) }) : null,
    occurrence: evidence.occurrence ? Object.freeze({ coverage: Object.freeze({ ...(evidence.occurrence.coverage ?? {}) }),
      sources: Object.freeze(occurrenceSources.map(source => Object.freeze({ source: source.source, coverage: source.coverage, observations: source.observations ?? 0 }))) }) : null,
    present: Object.freeze({ geometry: Boolean(road), ecology: Boolean(evidence.ecology), habitat: Boolean(evidence.habitat), occurrence: Boolean(evidence.occurrence) }),
  });
}

// COVERAGE. Every declared source is either answered or reported. `deferred` sources are work this
// environment cannot do (a browser cannot read a county site that sends no CORS header); they are named so a
// reader knows the finding rests on the recorded run for those sources rather than on a fresh check.
export function accessCoverage({ probeResults, osm }) {
  const outcomes = probeResults.map(result => result.outcome);
  const failures = probeResults.filter(result => result.outcome === PROBE_OUTCOME.FAILED);
  // A source can be answered and still not re-checkable here: `deferred` covers both, so a replay never reads as
  // a fresh check.
  const deferred = probeResults.filter(result => result.outcome === PROBE_OUTCOME.OPERATOR_ONLY || result.deferred === true);
  const notRun = probeResults.filter(result => result.outcome === PROBE_OUTCOME.NOT_RUN);
  const answered = probeResults.filter(result => result.outcome === PROBE_OUTCOME.EVIDENCE || result.outcome === PROBE_OUTCOME.NO_RELEVANT_EVIDENCE);
  const osmFailed = Boolean(osm && osm.status === 'FAILED');
  const osmPartial = Boolean(osm && osm.status === 'PARTIAL');
  // How each source was read matters to a reader even when coverage is the same: a live read, a cached read, a replay
  // of the reviewed capture, and a deferred source are different statements about how current the evidence is.
  // Retrieval modes come from the one shared implementation, so the transport, the coverage summary, and the bundle
  // can never disagree about how a source was read.
  const retrievalModes = retrievalModeCounts(probeResults);
  const probeSummary = Object.freeze({ total: probeResults.length, answered: answered.length, retrievalModes,
    evidence: outcomes.filter(outcome => outcome === PROBE_OUTCOME.EVIDENCE).length,
    noRelevantEvidence: outcomes.filter(outcome => outcome === PROBE_OUTCOME.NO_RELEVANT_EVIDENCE).length,
    failed: failures.length, deferred: deferred.length, notRun: notRun.length,
    osmStatus: osm?.status ?? 'NOT_RUN', failures: Object.freeze([...failures, ...deferred, ...notRun].map(result => Object.freeze({ probeId: result.probeId, url: result.url, outcome: result.outcome, reason: result.searched?.reason ?? null }))),
    osmFailures: Object.freeze((osm?.failures ?? []).map(failure => Object.freeze({ mirror: failure.mirror ?? null, reason: failure.reason ?? null, kind: failure.kind ?? null }))) });
  if (!probeResults.length && !osm) return Object.freeze({ coverage: COVERAGE.UNKNOWN, reason: 'No research transport ran: no declared source was asked and OpenStreetMap was not queried.', probeSummary });
  if (failures.length && !answered.length && !(osm?.ways?.length)) return Object.freeze({ coverage: COVERAGE.UNKNOWN, reason: `Every declared source failed (${failures.length}) and no OpenStreetMap context was retrieved. A failed request is not a result.`, probeSummary });
  const reasons = [];
  if (failures.length) reasons.push(`${failures.length} source request(s) failed`);
  if (deferred.length) reasons.push(`${deferred.length} source(s) deferred to the operator verification path (this environment cannot read them)`);
  if (notRun.length) reasons.push(`${notRun.length} source(s) were not part of the recorded run`);
  if (osmFailed) reasons.push('the OpenStreetMap query failed on every mirror tried');
  if (osmPartial) reasons.push('the OpenStreetMap query returned partial results');
  if (reasons.length) return Object.freeze({ coverage: COVERAGE.PARTIAL, reason: `${reasons.join('; ')}. ${ACCESS_COVERAGE_REASON}`, probeSummary });
  if (!osm || osm.status === 'NOT_RUN') return Object.freeze({ coverage: COVERAGE.PARTIAL, reason: `Official sources all answered, but no OpenStreetMap road context was requested. ${ACCESS_COVERAGE_REASON}`, probeSummary });
  return Object.freeze({ coverage: COVERAGE.FULL, reason: `Every declared source answered (evidence or no relevant evidence) and OpenStreetMap road context was retrieved. ${ACCESS_COVERAGE_REASON}`, probeSummary });
}

// The pipeline. Every dependency is injected, so the same code runs in the browser, in Node, and in tests.
export function createInvestigatorService({ osmSource = null, research, probes = [], record = null, now = () => new Date(), environment = 'unspecified' } = {}) {
  if (!research) throw new TypeError('The Investigator needs a research service (createResearchService)');
  return Object.freeze({
    environment,
    researchTransport: research.transportId,
    async investigate({ candidate, roads = [], evidence = {}, checkedAt = null } = {}) {
      if (!candidate?.id) throw new TypeError('The Investigator needs a candidate corridor');
      const at = checkedAt ?? now().toISOString();
      const checked = input => ({ checkedAt: at, now: () => new Date(at), ...input });
      let stages = createResearchPlanStages(candidate);
      const collected = [];
      const warnings = [];
      const counters = {};

      // 1. BASELINE — deterministic evidence already on hand.
      const baseline = baselineEvidence({ candidate, roads, evidence });
      stages = finishStage(stages, 'baseline', { summary: baselineSummary(baseline), counters: { sourceFeatures: baseline.geometry.sourceFeatureCount, roadParts: baseline.geometry.partCount }, ...checked() });

      // 2. ROAD CONTEXT — OpenStreetMap, matched against the canonical corridor geometry.
      stages = startStage(stages, 'road-context', checked());
      let osm = null;
      if (!osmSource) {
        stages = finishStage(stages, 'road-context', { status: STAGE_STATUS.SKIPPED, summary: 'No OpenStreetMap adapter is configured for this environment; road context was not requested.', ...checked() });
      } else {
        const limit = { bounds: padBounds(candidate.corridor.bounds), names: osmSearchNames(candidate.name) };
        const queried = await osmSource.queryCorridor(limit);
        // A recorded operator run replays reviewed evidence items; a live adapter derives them from ways.
        const match = queried.recorded ? queried.recorded.match : matchOsmWaysToCorridor(candidate.geometry, queried.ways);
        const derived = queried.recorded
          ? { items: Object.freeze((queried.recorded.evidence ?? []).map(item => createAccessEvidence({ ...item, corridorId: candidate.id }))) }
          : osmEvidence({ corridorId: candidate.id, corridorName: candidate.name, ways: queried.ways, match,
            barriers: queried.barriers, retrievedAt: queried.retrievedAt, osmTimestamp: queried.osmTimestamp, status: queried.status, failures: queried.failures });
        collected.push(...derived.items);
        const recorded = queried.recorded ?? null;
        osm = Object.freeze({ status: queried.status, ways: queried.ways, nonRoadWays: queried.nonRoadWays, barriers: queried.barriers,
          match, nameVariants: recorded ? recorded.nameVariants : nameVariantsOf(candidate.name, queried.ways),
          queries: recorded ? recorded.queries : queried.queries, failures: recorded ? recorded.failures : queried.failures,
          retrievedAt: recorded?.retrievedAt ?? queried.retrievedAt, osmTimestamp: recorded?.osmTimestamp ?? queried.osmTimestamp,
          mirrorsUsed: recorded ? recorded.mirrorsUsed : queried.mirrorsUsed, capturedAt: recorded?.capturedAt ?? null,
          // A recorded run carries the way summaries it captured; a live run summarises the ways it just retrieved.
          waySummaries: recorded?.waySummaries?.length ? recorded.waySummaries : queried.ways.map(way => Object.freeze({ osmId: way.osmId, name: way.name,
            highway: way.highway, ref: way.ref, surface: way.surface, url: way.url, accessSignal: way.accessSignal.signal })),
          searchNames: recorded?.searchNames ?? limit.names, searchBounds: queried.recorded ? recorded.searchBounds ?? limit.bounds : limit.bounds,
          evidenceIds: Object.freeze(derived.items.map(item => item.id)) });
        const status = queried.status === 'OK' ? STAGE_STATUS.COMPLETE : queried.status === 'PARTIAL' ? STAGE_STATUS.WARNING : STAGE_STATUS.FAILED;
        if (queried.status !== 'OK') warnings.push({ stage: 'road-context', note: `OpenStreetMap context ${queried.status.toLowerCase()}: ${(queried.failures ?? []).map(failure => `${failure.mirror ?? 'transport'} ${failure.reason}`).join('; ') || 'partial result'}` });
        stages = finishStage(stages, 'road-context', { status, summary: osmSummary(queried, match, recorded), counters: { requestedWays: queried.ways.length, matchedWays: match.matchedWayCount, barriers: queried.barriers.length, nonRoadWays: queried.nonRoadWays.length },
          warnings: status === STAGE_STATUS.COMPLETE ? [] : ['OpenStreetMap context is incomplete; coverage is PARTIAL and no conclusion rests on the missing part.'],
          evidenceIds: osm.evidenceIds, sourceIds: Object.freeze(['openstreetmap']), ...checked() });
      }

      // 3. AUTHORITY DISCOVERY — candidates with their basis, never an assumption from geography.
      const authorities = deriveAuthorities(roads);
      const declaredAuthorityIds = new Set(probes.map(probe => probe.authority).filter(Boolean));
      const discoveredIds = new Set(authorities.map(authority => authority.id));
      const underivedProbeAuthorities = [...declaredAuthorityIds].filter(id => !discoveredIds.has(id));
      stages = finishStage(stages, 'authority-discovery', { summary: authoritySummary(authorities, underivedProbeAuthorities), counters: { authorities: authorities.length, derived: authorities.filter(authority => authority.derived).length },
        warnings: underivedProbeAuthorities.length ? [`Declared research sources reference authorit${underivedProbeAuthorities.length === 1 ? 'y' : 'ies'} not derived from this corridor's facts: ${underivedProbeAuthorities.join(', ')}. The probes still run, and the mismatch is recorded.`] : [], ...checked() });
      if (underivedProbeAuthorities.length) warnings.push({ stage: 'authority-discovery', note: `Underived probe authorities: ${underivedProbeAuthorities.join(', ')}` });

      // 4. ACCESS RESEARCH — ask the declared sources; keep every answer, including none.
      stages = startStage(stages, 'access-research', checked());
      const accessRun = await research.run({ corridorId: candidate.id, stage: 'access-research' });
      const accessEvidence = accessRun.results.flatMap(result => result.evidence);
      collected.push(...accessEvidence);
      const provisionalItems = collected.slice();
      const provisional = deriveAccessFinding({ corridorId: candidate.id, corridorName: candidate.name, evidence: provisionalItems, checkedAt: at });
      stages = finishStage(stages, 'access-research', { status: accessResearchStatus(accessRun.results), summary: researchSummary(accessRun.results),
        counters: researchCounters(accessRun.results), warnings: researchWarnings(accessRun.results), evidenceIds: Object.freeze(accessEvidence.map(item => item.id)),
        sourceIds: Object.freeze([...new Set(accessRun.results.map(result => result.probeId))]), ...checked() });

      // 5. CONTRADICTION SEARCH — deliberately look for the closure, the gate, the permit, the private claim.
      stages = startStage(stages, 'contradiction-search', checked());
      const contradictionRun = await research.run({ corridorId: candidate.id, stage: 'contradiction-search' });
      const contradictionEvidence = contradictionRun.results.flatMap(result => result.evidence);
      collected.push(...contradictionEvidence);
      const contradictionCounters = { ...researchCounters(contradictionRun.results), restrictionsFound: contradictionEvidence.filter(item => item.effect === ACCESS_EFFECT.RESTRICTIVE).length };
      stages = finishStage(stages, 'contradiction-search', { status: accessResearchStatus(contradictionRun.results), summary: researchSummary(contradictionRun.results),
        counters: contradictionCounters, warnings: researchWarnings(contradictionRun.results), evidenceIds: Object.freeze(contradictionEvidence.map(item => item.id)),
        sourceIds: Object.freeze([...new Set(contradictionRun.results.map(result => result.probeId))]), ...checked() });
      if (contradictionEvidence.length) warnings.push({ stage: 'contradiction-search', note: `${contradictionEvidence.length} contradiction-stage item(s) retrieved, including ${contradictionCounters.restrictionsFound} restriction claim(s).` });

      // 6. ADVERSARIAL REVIEW — try to break the provisional finding.
      const review = adversarialReview({ finding: provisional, checkedAt: at });
      stages = finishStage(stages, 'adversarial-review', { status: review.concerns.length ? STAGE_STATUS.WARNING : STAGE_STATUS.COMPLETE,
        summary: review.conclusion, counters: { checks: review.checks.length, concerns: review.concerns.length },
        warnings: review.concerns.map(concern => `Adversarial concern: ${concern}`), ...checked() });

      // 7. FINDING — recomputed from all evidence, with the review attached.
      const access = deriveAccessFinding({ corridorId: candidate.id, corridorName: candidate.name, evidence: collected, checkedAt: at, review, provisionalFinding: provisional.finding });
      const coverage = accessCoverage({ probeResults: [...accessRun.results, ...contradictionRun.results], osm });
      const provenance = Object.freeze({ researchTransport: research.transportId, environment,
        recordedRunAt: record?.capturedAt ?? null, checkedAt: at, osmmTimestamp: osm?.osmTimestamp ?? null,
        osmMirrors: Object.freeze(osm?.mirrorsUsed ?? []), declaredProbes: Object.freeze(probes.map(probe => probe.id)) });
      stages = finishStage(stages, 'finding', { status: coverage.coverage === COVERAGE.FULL ? STAGE_STATUS.COMPLETE : STAGE_STATUS.WARNING,
        summary: `${access.finding} (${access.ruleId}); access-verification coverage ${coverage.coverage}.`,
        counters: { evidence: collected.length, contradictions: access.contradictions.length, unresolved: access.unresolved.length, restrictions: access.restrictions.length },
        evidenceIds: Object.freeze(collected.map(item => item.id)), ...checked() });

      return Object.freeze({
        corridorId: candidate.id, corridorName: candidate.name, checkedAsOf: new Date(at).toISOString(), ranAt: now().toISOString(),
        environment, transport: research.transportId, stages: Object.freeze(stages), stageSummary: stageSummary(stages),
        baseline, authorities: Object.freeze(authorities), osm, osmOsmtimestamp: osm?.osmTimestamp ?? null,
        research: Object.freeze({ probes: Object.freeze([...accessRun.results, ...contradictionRun.results]),
          noRelevantEvidence: Object.freeze([...accessRun.results, ...contradictionRun.results].filter(result => result.outcome === PROBE_OUTCOME.NO_RELEVANT_EVIDENCE)),
          failures: Object.freeze([...accessRun.results, ...contradictionRun.results].filter(result => result.outcome === PROBE_OUTCOME.FAILED)),
          deferred: Object.freeze([...accessRun.results, ...contradictionRun.results].filter(result => result.outcome === PROBE_OUTCOME.OPERATOR_ONLY || result.deferred === true)) }),
        evidence: Object.freeze(collected), access: Object.freeze({ ...access, coverage, provenance, sources: Object.freeze(sourceList([...accessRun.results, ...contradictionRun.results])) }),
        warnings: Object.freeze(warnings), plan: Object.freeze({ candidateId: candidate.id, stages: Object.freeze(stages.map(stage => Object.freeze({ id: stage.id, label: stage.label, status: stage.status }))), unresolvedQuestions: Object.freeze([...(candidate.questions ?? [])]) }),
      });
    },
  });
}

function createResearchPlanStages(candidate) {
  return STAGE_DEFS.map(def => ({ id: def.id, label: def.label, status: STAGE_STATUS.PENDING, startedAt: null, completedAt: null, summary: '', counters: {}, warnings: [], evidenceIds: [], sourceIds: [], error: null }));
}

function baselineSummary(baseline) {
  const parts = [`geometry ${(baseline.geometry.lengthM / 1609.344).toFixed(1)} mi from ${baseline.geometry.sourceFeatureCount} source feature(s) in ${baseline.geometry.counties.join(' / ') || 'county unrecorded'}`];
  parts.push(baseline.ecology ? `ecology ${baseline.ecology.coverage}` : 'ecology not analyzed');
  parts.push(baseline.habitat ? 'habitat summary present' : 'habitat not analyzed');
  parts.push(baseline.occurrence ? `occurrence ${Object.values(baseline.occurrence.coverage).join('/')}` : 'occurrence not queried');
  return parts.join(' · ');
}

function osmSummary(queried, match, recorded) {
  if (recorded) {
    const source = `recorded operator run captured ${String(recorded.capturedAt ?? '').slice(0, 10) || 'date unrecorded'}`;
    if (queried.status === 'FAILED') return `OpenStreetMap context comes from a ${source} in which every mirror failed: ${(recorded.failures ?? []).map(failure => failure.reason).join('; ') || 'all mirrors failed'}. No conclusion rests on OpenStreetMap.`;
    return `${source}: ${(recorded.waySummaries ?? []).length} mapped way(s) retrieved, ${match?.matchedWayCount ?? 0} within ${match?.toleranceM ?? 30} m of the corridor, ${((match?.matchedFraction ?? 0) * 100).toFixed(1)}% of the corridor matched${queried.status === 'PARTIAL' ? ' (partial retrieval)' : ''}.`;
  }
  if (queried.status === 'FAILED') return `OpenStreetMap unreachable: ${(queried.failures ?? []).map(failure => failure.reason).join('; ') || 'all mirrors failed'}. No conclusion rests on OpenStreetMap.`;
  return `${queried.ways.length} mapped way(s) matching the search names, ${match.matchedWayCount} within ${match.toleranceM} m of the corridor, ${(match.matchedFraction * 100).toFixed(1)}% of the corridor matched at ${match.sampleIntervalM} m sampling${queried.status === 'PARTIAL' ? ' (partial retrieval)' : ''}.`;
}

function authoritySummary(authorities, underived) {
  const derived = authorities.filter(authority => authority.derived).map(authority => authority.name);
  const unknown = authorities.filter(authority => !authority.derived).map(authority => authority.short);
  const parts = [`${derived.length} candidate authorit${derived.length === 1 ? 'y' : 'ies'} derived from corridor facts (${derived.join(', ') || 'none'})`,
    `${unknown.length} not established (${unknown.join(', ')})`];
  if (underived.length) parts.push(`${underived.length} declared source(s) point at authorities that were not derived (${underived.join(', ')})`);
  return parts.join(' · ');
}

function accessResearchStatus(results) {
  if (!results.length) return STAGE_STATUS.SKIPPED;
  const outcomes = results.map(result => result.outcome);
  if (outcomes.every(outcome => outcome === PROBE_OUTCOME.EVIDENCE || outcome === PROBE_OUTCOME.NO_RELEVANT_EVIDENCE)) return STAGE_STATUS.COMPLETE;
  if (outcomes.every(outcome => outcome === PROBE_OUTCOME.NOT_RUN || outcome === PROBE_OUTCOME.OPERATOR_ONLY)) return STAGE_STATUS.WARNING;
  if (outcomes.every(outcome => outcome === PROBE_OUTCOME.FAILED)) return STAGE_STATUS.FAILED;
  return STAGE_STATUS.WARNING;
}

function researchSummary(results) {
  if (!results.length) return 'No declared source was part of this run.';
  const counts = researchCounters(results);
  return `${counts.evidence} source(s) produced evidence, ${counts.noRelevantEvidence} answered with no relevant evidence, ${counts.failed} failed, ${counts.deferredOrNotRun} deferred or not run.`;
}

function researchCounters(results) {
  const count = outcome => results.filter(result => result.outcome === outcome).length;
  return { sources: results.length, evidence: count(PROBE_OUTCOME.EVIDENCE), noRelevantEvidence: count(PROBE_OUTCOME.NO_RELEVANT_EVIDENCE),
    failed: count(PROBE_OUTCOME.FAILED), deferredOrNotRun: count(PROBE_OUTCOME.OPERATOR_ONLY) + count(PROBE_OUTCOME.NOT_RUN),
    evidenceItems: results.reduce((total, result) => total + result.evidence.length, 0) };
}

function researchWarnings(results) {
  return results.filter(result => result.outcome === PROBE_OUTCOME.FAILED || result.outcome === PROBE_OUTCOME.OPERATOR_ONLY || result.outcome === PROBE_OUTCOME.NOT_RUN)
    .map(result => `${result.organization} — ${result.url}: ${result.searched?.reason ?? result.outcome}`);
}

function sourceList(results) {
  return results.map(result => Object.freeze({ organization: result.organization, sourceClass: result.sourceClass, title: result.title, url: result.url,
    question: result.question, outcome: result.outcome, retrievedAt: result.searched?.retrievedAt ?? null, httpStatus: result.searched?.httpStatus ?? null,
    probeId: result.probeId, note: result.note }));
}
