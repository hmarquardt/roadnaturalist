import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COVERAGE, COVERAGE_DATASET, createCandidate } from '../src/domain/corridor.js';
import { createRoad, groupRoadFeatures } from '../src/roads/road.js';
import { ACCESS_CLAIM, ACCESS_EFFECT, ACCESS_FINDING, CLAIM_STRENGTH, EVIDENCE_SCOPE, RECURRENCE, SOURCE_CLASS, TEMPORAL_SCOPE, adversarialReview, createAccessEvidence, deriveAccessFinding, freshnessOf, temporalScopeOf } from '../src/investigator/access.js';
import { BUNDLE_KIND, BUNDLE_SCHEMA_VERSION, buildCorridorBundle, parseBundle, validateBundle } from '../src/investigator/bundle.js';
import { PROBE_OUTCOME, PROBE_STAGE, applyNarration, createExcerptTransport, createProbe, createRecordedTransport, createResearchService, extractProbeResult, hashText, htmlToText, normalizeWhitespace } from '../src/investigator/research.js';
import { PILOT_PROBES_BY_CORRIDOR, deriveAuthorities } from '../src/investigator/sources.js';
import { accessCoverage, baselineEvidence, createInvestigatorService, osmEvidence, osmSearchNames, padBounds } from '../src/investigator/service.js';
import { STAGES, STAGE_STATUS, createResearchPlan, finishStage, stageSummary, startStage } from '../src/investigator/workflow.js';

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const CHECKED_AT = '2026-09-25T12:00:00.000Z';

let evidenceCounter = 0;
function evidence(overrides = {}) {
  evidenceCounter += 1;
  return createAccessEvidence({ id: `e${evidenceCounter}`, corridorId: 'c1', claimType: ACCESS_CLAIM.PUBLIC_ROAD,
    sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceOrganization: 'Washington County Land Use & Transportation',
    sourceTitle: 'County road page', sourceUrl: 'https://example.gov/road', quote: 'the county maintains this road',
    summary: 'County road page names the road.', retrievedAt: '2026-09-01T00:00:00.000Z', geographicScope: { scope: EVIDENCE_SCOPE.CORRIDOR }, ...overrides });
}
const find = input => deriveAccessFinding({ corridorId: 'c1', evidence: input, checkedAt: CHECKED_AT });

function pilot(declarationIndex = 0) {
  const snapshot = readJson('./fixtures/or-roads-pilot.snapshot.json');
  const declaration = readJson('../data/roads/or-roads-pilot.json');
  const groups = new Map(groupRoadFeatures(snapshot.roads.flatMap(road => road.features.map(feature => ({ ...feature, roadId: road.roadId, name: road.name,
    roadClass: road.roadClass, routeType: road.routeType, countyFips: road.countyFips, countyName: road.countyName })))).map(group => [group.roadId, group]));
  const entry = declaration.candidates[declarationIndex];
  // Real provenance, as the app supplies it from the road dataset manifest.
  const provenance = { agency: 'U.S. Census Bureau', dataset: 'TIGER/Line 2025 ROADS', datasetId: 'tiger-2025-or-roads-pilot', datasetVersion: '2025',
    publicationDate: '2025-01-01', geometryCrs: 'EPSG:4269', crs: 'EPSG:4326', license: 'Public domain (U.S. Census Bureau)',
    referenceUrl: 'https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html' };
  const roads = entry.roadIds.filter(roadId => groups.has(roadId)).map(roadId => createRoad(groups.get(roadId), { provenance }));
  return { candidate: createCandidate({ ...entry, roads }), roads, entry, snapshot };
}

// ---- vocabulary and the evidence shape ----------------------------------------------------------

test('claim types decide an effect, and stance is stated from the corridor question', () => {
  assert.equal(evidence({ claimType: ACCESS_CLAIM.PUBLIC_ROAD }).effect, ACCESS_EFFECT.AFFIRMATIVE);
  assert.equal(evidence({ claimType: ACCESS_CLAIM.PRIVATE_ROAD }).stance, 'CONTRADICTS_PUBLIC_ACCESS');
  assert.equal(evidence({ claimType: ACCESS_CLAIM.GATE_REPORTED }).effect, ACCESS_EFFECT.ATTENTION);
  assert.equal(evidence({ claimType: ACCESS_CLAIM.SURFACE }).effect, ACCESS_EFFECT.NEUTRAL);
  assert.throws(() => evidence({ claimType: 'PROBABLY_FINE' }), /Unknown access claim type/);
  assert.throws(() => evidence({ sourceClass: 'TIER_0_VIBES' }), /Unknown source class/);
  assert.throws(() => evidence({ quote: '' }), /verbatim quote/);
});

test("an evidence item keeps the source’s own words, scope, dates, and provenance", () => {
  const item = evidence({ quote: 'Road closure has been extended to October 7, 2026', effectiveFrom: '2026-07-15', effectiveUntil: '2026-10-07',
    geographicScope: { scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'between Germantown Road and Kaiser Road' }, publishedAt: '2026-07-09' });
  assert.equal(item.quote, 'Road closure has been extended to October 7, 2026');
  assert.equal(item.effectiveUntil, '2026-10-07T00:00:00.000Z');
  assert.equal(item.geographicScope.corridorPart, 'between Germantown Road and Kaiser Road');
  assert.equal(item.provenance.method, 'Operator-reviewed source extraction');
  assert.throws(() => evidence({ effectiveFrom: '2026-10-07', effectiveUntil: '2026-07-15' }), /inverted/);
});

// ---- finding guardrails --------------------------------------------------------------------------

test('no access evidence is UNVERIFIED, the default, and not a negative finding', () => {
  const finding = find([]);
  assert.equal(finding.finding, ACCESS_FINDING.UNVERIFIED);
  assert.equal(finding.ruleId, 'R1_NO_ACCESS_EVIDENCE');
  assert.match(finding.unresolved[0].text, /not evidence that the road is private/);
});

test('an authoritative whole-corridor source reaches VERIFIED_PUBLIC', () => {
  const finding = find([evidence()]);
  assert.equal(finding.finding, ACCESS_FINDING.VERIFIED_PUBLIC);
  assert.equal(finding.ruleId, 'R6_AUTHORITATIVE_WHOLE_CORRIDOR');
  assert.equal(finding.publicRoadEvidence, 'VERIFIED');
  assert.equal(finding.motorVehicleAccess, 'VERIFIED');
  assert.match(finding.meaning, /not a legal guarantee/);
});

test('authoritative evidence about part of the corridor is PROBABLE_PUBLIC, with the gap named', () => {
  const finding = find([evidence({ geographicScope: { scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: '185th Avenue to Kaiser Road' } })]);
  assert.equal(finding.finding, ACCESS_FINDING.PROBABLE_PUBLIC);
  assert.equal(finding.ruleId, 'R7_AUTHORITATIVE_PART_OF_CORRIDOR');
  assert.equal(finding.scope.wholeCorridor, false);
  assert.equal(finding.unresolved[0].code, 'CORRIDOR_PART_ONLY');
  assert.deepEqual(finding.scope.parts, ['185th Avenue to Kaiser Road']);
});

test('community mapping alone cannot reach the strongest state', () => {
  const finding = find([evidence({ sourceClass: SOURCE_CLASS.TIER_3_COMMUNITY, sourceOrganization: 'OpenStreetMap contributors', claimType: ACCESS_CLAIM.MOTOR_VEHICLES_ALLOWED })]);
  assert.equal(finding.finding, ACCESS_FINDING.PROBABLE_PUBLIC);
  assert.equal(finding.ruleId, 'R8_COMMUNITY_ONLY');
  assert.equal(finding.publicRoadEvidence, 'COMMUNITY ONLY');
});

test('evidence that says nothing about access cannot produce a public finding', () => {
  const finding = find([evidence({ claimType: ACCESS_CLAIM.SURFACE, claimValue: 'asphalt' })]);
  assert.equal(finding.finding, ACCESS_FINDING.UNVERIFIED);
  assert.equal(finding.ruleId, 'R9_NO_DECIDING_EVIDENCE');
});

test('an active restriction is RESTRICTED_OR_CLOSED and cannot be flattened into a public finding', () => {
  const finding = find([evidence(),
    evidence({ claimType: ACCESS_CLAIM.TEMPORARY_CLOSURE, sourceTitle: 'Bridge project page', quote: 'A full road closure is needed',
      effectiveFrom: '2026-07-15', effectiveUntil: '2026-10-07', geographicScope: { scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'at Rock Creek' } })]);
  assert.equal(finding.finding, ACCESS_FINDING.RESTRICTED_OR_CLOSED);
  assert.equal(finding.ruleId, 'R3_CURRENT_RESTRICTION');
  assert.equal(finding.restrictionsFound, true);
  assert.equal(finding.restrictions[0].temporalScope, TEMPORAL_SCOPE.CURRENT);
  assert.equal(finding.motorVehicleAccess, 'RESTRICTED OR CLOSED');
  assert.equal(finding.publicRoadEvidence, 'VERIFIED');
  assert.ok(finding.qualifiers.some(qualifier => /Restriction in scope: TEMPORARY_CLOSURE/.test(qualifier)));
});

test('a source-stated recurring closure is a restriction, not an old event to ignore', () => {
  const finding = find([evidence({ claimType: ACCESS_CLAIM.SEASONAL_CLOSURE, quote: 'Susbauer and Fern Hill roads both flood often during heavy rainfall.',
    recurrence: RECURRENCE.HIGH_WATER, publishedAt: '2022-12-30', retrievedAt: '2026-09-25T00:00:00.000Z' })]);
  assert.equal(finding.finding, ACCESS_FINDING.RESTRICTED_OR_CLOSED);
  assert.equal(finding.ruleId, 'R4_RECURRING_RESTRICTION');
  assert.equal(finding.restrictions[0].temporalScope, TEMPORAL_SCOPE.RECURRING);
});

test('conflicting authoritative status claims are CONFLICTED and neither side is chosen', () => {
  const finding = find([evidence(), evidence({ claimType: ACCESS_CLAIM.PRIVATE_ROAD, sourceOrganization: 'Another agency', quote: 'private road' })]);
  assert.equal(finding.finding, ACCESS_FINDING.CONFLICTED);
  assert.equal(finding.ruleId, 'R2_STATUS_CONFLICT');
  assert.equal(finding.contradictions[0].kind, 'STATUS_DISAGREEMENT');
  assert.match(finding.contradictions[0].note, /does not choose|comparable reliability/);
});

test('a lower-tier restrictive claim caps the finding at probable and stays visible', () => {
  const finding = find([evidence(), evidence({ claimType: ACCESS_CLAIM.PRIVATE_ROAD, sourceClass: SOURCE_CLASS.TIER_4_ANECDOTAL, sourceOrganization: 'Forum post' })]);
  assert.equal(finding.finding, ACCESS_FINDING.PROBABLE_PUBLIC);
  assert.equal(finding.ruleId, 'R5_LOWER_TIER_RESTRICTION');
  assert.ok(finding.contradictions.some(entry => entry.kind === 'LOWER_TIER_RESTRICTION'));
});

test('an anecdotal report never overrides an authoritative active restriction', () => {
  const finding = find([evidence({ claimType: ACCESS_CLAIM.TEMPORARY_CLOSURE, effectiveFrom: '2026-09-01', effectiveUntil: '2026-11-01' }),
    evidence({ claimType: ACCESS_CLAIM.MOTOR_VEHICLES_ALLOWED, sourceClass: SOURCE_CLASS.TIER_4_ANECDOTAL, sourceOrganization: 'Trip report', quote: 'drove it yesterday' })]);
  assert.equal(finding.finding, ACCESS_FINDING.RESTRICTED_OR_CLOSED);
  assert.equal(finding.ruleId, 'R3_CURRENT_RESTRICTION');
  assert.deepEqual(finding.affirmative, []);
});

test('two organizations publishing maintenance claims for one road are recorded, not resolved', () => {
  const finding = find([evidence({ claimType: ACCESS_CLAIM.ROAD_MAINTAINED, sourceOrganization: 'Oregon Department of Transportation', appliesTo: 'NW Cornelius Pass Road' }),
    evidence({ claimType: ACCESS_CLAIM.ROAD_MAINTAINED, sourceOrganization: 'Multnomah County Transportation', appliesTo: 'NW Cornelius Pass Road',
      geographicScope: { scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'Highway 30 – Skyline Boulevard' } })]);
  assert.ok(finding.contradictions.some(entry => entry.kind === 'MULTIPLE_AUTHORITY_CLAIMS'));
  assert.ok(finding.unresolved.some(entry => entry.code === 'MULTIPLE_AUTHORITY_CLAIMS'));
  const review = adversarialReview({ finding, checkedAt: CHECKED_AT });
  assert.ok(review.concerns.includes('AUTHORITY_OVERLAP'));
});

// ---- freshness -----------------------------------------------------------------------------------

test('an expired dated closure cannot act on today’s finding, and it is still reported', () => {
  const closure = evidence({ claimType: ACCESS_CLAIM.TEMPORARY_CLOSURE, effectiveFrom: '2026-04-01', effectiveUntil: '2026-06-01' });
  const finding = find([evidence(), closure]);
  assert.equal(finding.finding, ACCESS_FINDING.VERIFIED_PUBLIC);
  assert.equal(finding.restrictions[0].temporalScope, TEMPORAL_SCOPE.EXPIRED);
  assert.equal(finding.notActing.length, 1);
  assert.ok(finding.contradictions.some(entry => entry.kind === 'NOT_CURRENT'));
  assert.ok(adversarialReview({ finding, checkedAt: CHECKED_AT }).concerns.includes('STALE_EVIDENCE'));
});

test('freshness separates current, recent, stale, and undated evidence', () => {
  assert.equal(freshnessOf(evidence({ publishedAt: '2026-09-01' }), { checkedAt: CHECKED_AT }).state, 'CURRENT');
  assert.equal(freshnessOf(evidence({ publishedAt: '2026-05-01' }), { checkedAt: CHECKED_AT }).state, 'RECENT');
  assert.equal(freshnessOf(evidence({ publishedAt: '2024-01-01' }), { checkedAt: CHECKED_AT }).state, 'STALE');
  assert.equal(freshnessOf(evidence({ publishedAt: null, retrievedAt: null, effectiveFrom: null, effectiveUntil: null }), { checkedAt: CHECKED_AT }).state, 'UNDATED');
});

test('an undated restriction claim is reported and cannot act', () => {
  const finding = find([evidence(), evidence({ claimType: ACCESS_CLAIM.MOTOR_VEHICLES_RESTRICTED, publishedAt: null, retrievedAt: null, effectiveFrom: null, effectiveUntil: null })]);
  assert.equal(finding.restrictions[0].temporalScope, TEMPORAL_SCOPE.UNDATED);
  assert.equal(finding.finding, ACCESS_FINDING.VERIFIED_PUBLIC);
  assert.ok(finding.unresolved.some(entry => entry.code === 'UNDATED_EVIDENCE'));
});

test('the finding reports when the evidence was checked and what it was checked as of', () => {
  const finding = find([evidence()]);
  assert.equal(finding.checkedAsOf, CHECKED_AT);
  assert.equal(finding.evidenceCheckedAt, '2026-09-01T00:00:00.000Z');
  assert.ok(finding.qualifiers.some(qualifier => /not a legal determination/.test(qualifier)));
});

// ---- adversarial review ---------------------------------------------------------------------------

test('adversarial review records concerns without amending the finding', () => {
  const finding = find([evidence({ geographicScope: { scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'part' } })]);
  const review = adversarialReview({ finding, checkedAt: CHECKED_AT });
  assert.ok(review.concerns.includes('CORRIDOR_PARTIAL'));
  assert.ok(review.checks.some(check => check.id === 'SINGLE_ORGANIZATION' && check.outcome === 'CONCERN'));
  assert.equal(review.checks.length, 9);
  assert.match(review.conclusion, /never amend it silently/);
  assert.throws(() => adversarialReview({ finding: null, checkedAt: CHECKED_AT }), /provisional finding/);
});

test('an empty result set is flagged as absence of evidence, not as a private road', () => {
  const review = adversarialReview({ finding: find([]), checkedAt: CHECKED_AT });
  assert.ok(review.concerns.includes('EVIDENCE_ABSENCE'));
  assert.ok(review.checks.some(check => check.id === 'EVIDENCE_ABSENCE' && /recorded as UNVERIFIED rather than as evidence that the road is private/.test(check.note)));
});

// ---- research boundary ---------------------------------------------------------------------------

const SPRINGVILLE_PROBE = PILOT_PROBES_BY_CORRIDOR['or-roads-springville-rd'][0];
const SPRINGVILLE_NEWS_PROBE = PILOT_PROBES_BY_CORRIDOR['or-roads-springville-rd'][1];

test('a declared fact only becomes evidence when the source actually served that text', () => {
  const served = extractProbeResult(SPRINGVILLE_PROBE, { corridorId: 'c1', retrievedAt: '2026-09-25T00:00:00.000Z',
    text: 'prefix text ' + SPRINGVILLE_PROBE.facts[0].find + ' suffix text', httpStatus: 200 });
  assert.equal(served.outcome, PROBE_OUTCOME.EVIDENCE);
  assert.equal(served.evidence[0].quote, SPRINGVILLE_PROBE.facts[0].find);
  assert.equal(served.evidence[0].sourceUrl, SPRINGVILLE_PROBE.url);
  assert.equal(served.evidence[0].geographicScope.corridorPart, '185th Avenue to Kaiser Road (North Bethany urban section)');
  const noResult = extractProbeResult(SPRINGVILLE_PROBE, { corridorId: 'c1', retrievedAt: '2026-09-25T00:00:00.000Z', text: 'a page that does not mention the road' });
  assert.equal(noResult.outcome, PROBE_OUTCOME.NO_RELEVANT_EVIDENCE);
  assert.equal(noResult.evidence.length, 0);
  assert.match(noResult.note, /no-result search, not evidence that nothing exists/);
});

test('declared phrases survive inline markup and collapsed whitespace in served HTML', () => {
  const html = `<p>The work improved Springville <strong>Road</strong> from 185th Avenue intersection   to\n  Kaiser Road in four phases:</p>`;
  const text = normalizeWhitespace(htmlToText(html));
  assert.equal(text, 'The work improved Springville Road from 185th Avenue intersection to Kaiser Road in four phases:');
  const result = extractProbeResult(SPRINGVILLE_NEWS_PROBE, { corridorId: 'or-roads-springville-rd', retrievedAt: '2026-09-25T00:00:00.000Z', text });
  assert.equal(result.outcome, PROBE_OUTCOME.EVIDENCE);
  assert.equal(result.evidence[0].quote, SPRINGVILLE_NEWS_PROBE.facts[1].find);
});

test('a probe validates its own declaration: it needs a source, a question, and verbatim phrases', () => {
  assert.throws(() => createProbe({ id: 'p', stage: PROBE_STAGE.ACCESS_RESEARCH, sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, url: 'http://x', question: 'q', facts: [{ find: 'a', claimType: 'PUBLIC_ROAD' }] }), /https url/);
  assert.throws(() => createProbe({ id: 'p', stage: 'guessing', sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, url: 'https://x', question: 'q', facts: [{ find: 'a', claimType: 'PUBLIC_ROAD' }] }), /known stage/);
  assert.throws(() => createProbe({ id: 'p', stage: PROBE_STAGE.ACCESS_RESEARCH, sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, url: 'https://x', question: 'q', facts: [] }), /at least one declared fact/);
  assert.throws(() => createProbe({ id: 'p', stage: PROBE_STAGE.ACCESS_RESEARCH, sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, url: 'https://x', question: 'q',
    facts: [{ find: 'a', claimType: 'TEMPORARY_CLOSURE', effectiveUntil: '2026-10-07' }] }), /quoted window text/);
});

test('a failed source stays a failure and never becomes a no-result search', async () => {
  const service = createResearchService({ transport: { id: 'failing', async run(probe) { return { probeId: probe.id, url: probe.url, outcome: PROBE_OUTCOME.FAILED, searched: { reason: 'HTTP 429' }, evidence: [], matches: [], note: 'Source failed: HTTP 429' }; } }, probes: [SPRINGVILLE_PROBE] });
  const run = await service.run({ corridorId: 'or-roads-springville-rd', stage: PROBE_STAGE.ACCESS_RESEARCH });
  assert.equal(run.results[0].outcome, PROBE_OUTCOME.FAILED);
  const coverage = accessCoverage({ probeResults: run.results, osm: { status: 'OK', ways: [{ osmId: '1' }] } });
  assert.equal(coverage.coverage, COVERAGE.PARTIAL);
  assert.match(coverage.reason, /1 source request\(s\) failed/);
  assert.deepEqual(coverage.probeSummary.failures[0], { probeId: SPRINGVILLE_PROBE.id, url: SPRINGVILLE_PROBE.url, outcome: PROBE_OUTCOME.FAILED, reason: 'HTTP 429' });
});

test('the recorded operator run replays official evidence and marks what a browser cannot re-check', async () => {
  const record = { capturedAt: '2026-09-25T23:54:00.000Z', corridors: {} };
  const recorded = createRecordedTransport({ record: { ...record, probes: [{ probeId: SPRINGVILLE_PROBE.id, outcome: PROBE_OUTCOME.EVIDENCE, searched: { url: SPRINGVILLE_PROBE.url, retrievedAt: '2026-09-25T23:54:00.000Z', httpStatus: 200 },
    evidence: [evidence({ id: 'recorded-1', sourceUrl: SPRINGVILLE_PROBE.url })] }] }, browserOrigins: ['https://www.washingtoncountyor.gov'] });
  const result = await recorded.run(SPRINGVILLE_PROBE, { corridorId: 'or-roads-springville-rd', now: () => new Date(CHECKED_AT) });
  // The recorded evidence is shown, and the source is marked deferred so coverage reports a replay, not a check.
  assert.equal(result.outcome, PROBE_OUTCOME.EVIDENCE);
  assert.equal(result.deferred, true);
  assert.equal(result.searched.liveVerified, false);
  assert.match(result.searched.reason, /cannot read .*no CORS header/);
  assert.match(result.note, /Replayed from the recorded operator run/);
  assert.equal(result.evidence.length, 1);
  const replayed = await createRecordedTransport({ record: { ...record, probes: [{ probeId: SPRINGVILLE_PROBE.id, outcome: PROBE_OUTCOME.EVIDENCE, searched: {}, evidence: [evidence({ id: 'recorded-2' })] }] } }).run(SPRINGVILLE_PROBE, { corridorId: 'or-roads-springville-rd', now: () => new Date(CHECKED_AT) });
  assert.equal(replayed.outcome, PROBE_OUTCOME.EVIDENCE);
  assert.equal(replayed.deferred, false);
  assert.equal(replayed.evidence[0].id, 'recorded-2');
  const missing = await createRecordedTransport({ record: { ...record, probes: [] } }).run(SPRINGVILLE_PROBE, { corridorId: 'or-roads-springville-rd', now: () => new Date(CHECKED_AT) });
  assert.equal(missing.outcome, PROBE_OUTCOME.NOT_RUN);
});

test('an interpretation may annotate a finding but never set it, and unretrieved citations are rejected', () => {
  const finding = find([evidence()]);
  const { narration, rejectedCitations } = applyNarration(finding, { text: 'The county pages are consistent.', generator: 'operator note',
    citations: ['https://example.gov/road', 'https://invented.example/never-fetched'] }, { evidenceIndex: [evidence({ sourceUrl: 'https://example.gov/road' })] });
  assert.deepEqual(narration.citations, ['https://example.gov/road']);
  assert.deepEqual(rejectedCitations, ['https://invented.example/never-fetched']);
  assert.equal(narration.canSetFinding, false);
  assert.equal(finding.finding, ACCESS_FINDING.VERIFIED_PUBLIC);
});

test('retrieved page digests are stable', () => { assert.equal(hashText('abc'), hashText('abc')); assert.notEqual(hashText('abc'), hashText('abd')); });

// ---- the staged pipeline (offline, fixture-backed) -------------------------------------------------

const EXCERPTS = readJson('./fixtures/investigator/source-excerpts.json');
const CORRIDOR_INDEX = { 'or-roads-cornelius-pass-rd': 0, 'or-roads-springville-rd': 1, 'or-roads-susbauer-rd': 2 };
// A stub OpenStreetMap source that answers like the live adapter, without touching the network.
function stubOsmSource({ status = 'OK', ways = [], barriers = [], failures = [] } = {}) {
  return { id: 'stub-osm', async queryCorridor(limit) { return { status, ways, barriers, nonRoadWays: [], failures,
    retrievedAt: '2026-09-25T12:00:00.000Z', osmTimestamp: '2026-09-25T11:00:00Z', mirrorsUsed: ['stub'], queries: [], searchNames: limit.names, searchBounds: limit.bounds }; } };
}

function investigateOffline(corridorId, { osmSource = stubOsmSource(), record = null } = {}) {
  const { candidate, roads } = pilot(CORRIDOR_INDEX[corridorId]);
  const probes = PILOT_PROBES_BY_CORRIDOR[corridorId];
  const research = createResearchService({ transport: createExcerptTransport({ excerpts: EXCERPTS.sources }), probes });
  // A fixed clock: an investigation must be reproducible from its inputs, timestamps included.
  const service = createInvestigatorService({ osmSource, research, probes, record, environment: 'test/fixture', now: () => new Date(CHECKED_AT) });
  return service.investigate({ candidate, roads, checkedAt: CHECKED_AT });
}

test('the pipeline answers the three pilot corridors from their own sources, with different findings', async () => {
  const cornelius = await investigateOffline('or-roads-cornelius-pass-rd');
  assert.equal(cornelius.access.finding, ACCESS_FINDING.RESTRICTED_OR_CLOSED);
  assert.equal(cornelius.access.ruleId, 'R3_CURRENT_RESTRICTION');
  assert.ok(cornelius.access.restrictions.some(item => item.claimType === ACCESS_CLAIM.TEMPORARY_CLOSURE && item.temporalScope === TEMPORAL_SCOPE.CURRENT));
  assert.ok(cornelius.access.affirmative.some(item => item.claimType === ACCESS_CLAIM.PUBLIC_ROAD));
  assert.ok(cornelius.access.contradictions.some(entry => entry.kind === 'MULTIPLE_AUTHORITY_CLAIMS'));
  assert.equal(cornelius.stages.find(stage => stage.id === 'road-context').status, STAGE_STATUS.COMPLETE);

  const springville = await investigateOffline('or-roads-springville-rd');
  assert.equal(springville.access.finding, ACCESS_FINDING.PROBABLE_PUBLIC);
  assert.equal(springville.access.ruleId, 'R7_AUTHORITATIVE_PART_OF_CORRIDOR');
  assert.ok(springville.access.unresolved.some(entry => entry.code === 'CORRIDOR_PART_ONLY'));
  assert.equal(springville.access.restrictions.length, 0);

  const susbauer = await investigateOffline('or-roads-susbauer-rd');
  assert.equal(susbauer.access.finding, ACCESS_FINDING.RESTRICTED_OR_CLOSED);
  assert.equal(susbauer.access.ruleId, 'R4_RECURRING_RESTRICTION');
  assert.ok(susbauer.access.attention.some(item => item.claimType === ACCESS_CLAIM.GATE_REPORTED));
  assert.ok(susbauer.access.restrictions.some(item => item.recurrence === RECURRENCE.HIGH_WATER));
});

test('every stage finishes and the plan stays inspectable', async () => {
  const investigation = await investigateOffline('or-roads-susbauer-rd');
  assert.deepEqual(investigation.stages.map(stage => stage.id), [...STAGES]);
  assert.equal(investigation.stages.filter(stage => stage.status === STAGE_STATUS.PENDING).length, 0);
  assert.equal(investigation.stageSummary.total, STAGES.length);
  assert.ok(investigation.stages.every(stage => stage.summary));
  assert.equal(investigation.access.provisionalFinding, ACCESS_FINDING.RESTRICTED_OR_CLOSED);
  assert.equal(investigation.access.findingChangedByReview, false);
  assert.ok(investigation.access.review.checks.length >= 8);
  assert.deepEqual(investigation.plan.unresolvedQuestions.length > 0, true);
});

test('a provisional finding can change after the contradiction search, and the change is visible', async () => {
  // The access-research stage sees only the county road page; the contradiction stage finds the closure.
  const { candidate, roads } = pilot(CORRIDOR_INDEX['or-roads-cornelius-pass-rd']);
  const probes = PILOT_PROBES_BY_CORRIDOR['or-roads-cornelius-pass-rd'].filter(probe => probe.stage === PROBE_STAGE.ACCESS_RESEARCH);
  const research = createResearchService({ transport: createExcerptTransport({ excerpts: EXCERPTS.sources }), probes });
  const service = createInvestigatorService({ osmSource: stubOsmSource(), research, probes, environment: 'test/fixture', now: () => new Date(CHECKED_AT) });
  const investigation = await service.investigate({ candidate, roads, checkedAt: CHECKED_AT });
  // Access research alone finds only affirmative evidence (state highway, county plan), so the provisional finding
  // is VERIFIED_PUBLIC; the contradiction search then finds an active closure and the finding moves.
  assert.equal(investigation.access.provisionalFinding, ACCESS_FINDING.VERIFIED_PUBLIC);
  assert.equal(investigation.access.finding, ACCESS_FINDING.VERIFIED_PUBLIC);
  const withContradictions = await investigateOffline('or-roads-cornelius-pass-rd');
  assert.equal(withContradictions.access.finding, ACCESS_FINDING.RESTRICTED_OR_CLOSED);
  assert.notEqual(withContradictions.access.provisionalFinding, withContradictions.access.finding);
  assert.equal(withContradictions.access.findingChangedByReview, true);
});

test('a failed OpenStreetMap query degrades coverage and leaves the finding on the surviving evidence', async () => {
  const investigation = await investigateOffline('or-roads-susbauer-rd', { osmSource: stubOsmSource({ status: 'FAILED', failures: [{ mirror: 'osm-mail-ru', reason: 'Overpass HTTP 504', kind: 'ways' }] }) });
  assert.equal(investigation.stages.find(stage => stage.id === 'road-context').status, STAGE_STATUS.FAILED);
  assert.equal(investigation.access.coverage.coverage, COVERAGE.PARTIAL);
  assert.match(investigation.access.coverage.reason, /OpenStreetMap query failed on every mirror/);
  assert.equal(investigation.access.finding, ACCESS_FINDING.RESTRICTED_OR_CLOSED);
  assert.equal(investigation.osm.evidenceIds.length, 0);
});

test('coverage is FULL only when every declared source answered and OSM was retrieved', async () => {
  const investigation = await investigateOffline('or-roads-susbauer-rd');
  assert.equal(investigation.access.coverage.coverage, COVERAGE.FULL);
  assert.equal(investigation.access.coverage.probeSummary.failed, 0);
  assert.equal(investigation.access.coverage.probeSummary.deferred, 0);
  assert.ok(investigation.access.coverage.probeSummary.noRelevantEvidence >= 1);
  assert.match(investigation.access.coverage.reason, /says nothing about what the evidence supports/);
});

test('coverage without a research run is UNKNOWN, and no source is reported as a result', () => {
  const coverage = accessCoverage({ probeResults: [], osm: null });
  assert.equal(coverage.coverage, COVERAGE.UNKNOWN);
  assert.match(coverage.reason, /no declared source was asked/);
  const allFailed = accessCoverage({ probeResults: [{ probeId: 'p', url: 'https://x', outcome: PROBE_OUTCOME.FAILED, searched: { reason: 'HTTP 500' }, evidence: [] }], osm: null });
  assert.equal(allFailed.coverage, COVERAGE.UNKNOWN);
  assert.match(allFailed.reason, /A failed request is not a result/);
});

test('a browser-only run that defers official sources reports PARTIAL coverage, not a clean result', async () => {
  const { candidate, roads } = pilot(CORRIDOR_INDEX['or-roads-springville-rd']);
  const probes = PILOT_PROBES_BY_CORRIDOR['or-roads-springville-rd'];
  const recorded = { capturedAt: '2026-09-25T23:54:00.000Z', probes: probes.map(probe => ({ probeId: probe.id, outcome: PROBE_OUTCOME.EVIDENCE,
    searched: { url: probe.url, retrievedAt: '2026-09-25T23:54:00.000Z', httpStatus: 200 }, evidence: [evidence({ id: `replayed-${probe.id}`, corridorId: candidate.id, sourceUrl: probe.url })] })) };
  const research = createResearchService({ transport: createRecordedTransport({ record: recorded, browserOrigins: ['https://www.washingtoncountyor.gov', 'https://multco.us', 'https://www.wc-roads.com'] }), probes });
  const service = createInvestigatorService({ osmSource: stubOsmSource(), research, probes, record: recorded, environment: 'test/browser-replay' });
  const investigation = await service.investigate({ candidate, roads, checkedAt: CHECKED_AT });
  assert.equal(investigation.access.coverage.coverage, COVERAGE.PARTIAL);
  assert.ok(investigation.access.coverage.probeSummary.deferred >= 1);
  assert.match(investigation.access.coverage.reason, /deferred to the operator verification path/);
  assert.equal(investigation.research.deferred.length, recorded.probes.length);
  // Every official source still contributes its recorded evidence, and no source claims to have been re-checked.
  assert.ok(investigation.access.affirmative.length > 0);
  assert.ok(investigation.research.probes.every(probe => probe.searched.liveVerified === false));
  assert.equal(investigation.access.provenance.recordedRunAt, '2026-09-25T23:54:00.000Z');
});

test('community evidence alone cannot decide access, and the claim stays on the record', async () => {
  const { candidate, roads } = pilot(CORRIDOR_INDEX['or-roads-susbauer-rd']);
  const probes = PILOT_PROBES_BY_CORRIDOR['or-roads-susbauer-rd'];
  // A research run in which every declared source answered with nothing relevant, plus one community-mapped
  // restrictive claim. Nothing authoritative exists, so access stays UNVERIFIED and the claim stays visible.
  const research = createResearchService({ transport: { id: 'stub-no-results', async run(probe) { return { probeId: probe.id, stage: probe.stage, organization: probe.organization,
    sourceClass: probe.sourceClass, title: probe.title, url: probe.url, question: probe.question, outcome: PROBE_OUTCOME.NO_RELEVANT_EVIDENCE,
    searched: { url: probe.url, retrievedAt: CHECKED_AT, httpStatus: 200 }, matches: [], evidence: [], note: 'no declared phrase present' }; } }, probes });
  const ways = [{ osmId: '1', name: 'Northwest Susbauer Road', highway: 'secondary', ref: null, url: 'https://www.openstreetmap.org/way/1', tags: { access: 'private' },
    accessSignal: { signal: 'EXPLICIT_RESTRICTED', keys: ['access'], values: { access: 'private' }, note: 'explicit' }, geometry: [[-123.04, 45.54], [-123.04, 45.56]], provenance: { mirror: 'stub' } }];
  const service = createInvestigatorService({ osmSource: stubOsmSource({ ways }), research, probes, environment: 'test/no-results' });
  const investigation = await service.investigate({ candidate, roads, checkedAt: CHECKED_AT });
  assert.equal(investigation.access.finding, ACCESS_FINDING.UNVERIFIED);
  assert.equal(investigation.access.ruleId, 'R9_NO_DECIDING_EVIDENCE');
  assert.ok(investigation.access.restrictions.some(item => item.sourceClass === SOURCE_CLASS.TIER_3_COMMUNITY));
  assert.deepEqual(investigation.access.affirmative, []);
  assert.ok(investigation.access.unresolved.some(entry => entry.code === 'COMMUNITY_RESTRICTION_NO_AUTHORITY'));
  assert.equal(investigation.access.coverage.coverage, COVERAGE.FULL);
  assert.equal(investigation.access.coverage.probeSummary.noRelevantEvidence, probes.length);
});

test('OpenStreetMap evidence records absent tags as absence, not as public access', async () => {
  const ways = [{ osmId: '1', name: 'Northwest Susbauer Road', highway: 'secondary', ref: null, url: 'https://www.openstreetmap.org/way/1', tags: {},
    accessSignal: { signal: 'ABSENT', keys: [], values: {}, note: 'absent' }, geometry: [[-123.04, 45.54], [-123.04, 45.56]], provenance: { mirror: 'stub', osmTimestamp: '2026-09-25T11:00:00Z' } }];
  const built = osmEvidence({ corridorId: 'c1', corridorName: 'NW Susbauer Rd', ways, match: { matchedWayCount: 1, candidateWayCount: 1, matchedFraction: 1, toleranceM: 30, sampleIntervalM: 25 },
    barriers: [], retrievedAt: '2026-09-25T12:00:00.000Z', osmTimestamp: '2026-09-25T11:00:00Z', status: 'OK', failures: [] });
  const absent = built.items.find(item => item.claimType === ACCESS_CLAIM.ACCESS_TAG_ABSENT);
  assert.equal(absent.effect, ACCESS_EFFECT.NEUTRAL);
  assert.match(absent.summary, /makes no access statement here, which is neither public access nor a restriction/);
  assert.equal(built.items.filter(item => item.effect === ACCESS_EFFECT.AFFIRMATIVE).length, 0);
  assert.ok(built.items.some(item => item.claimType === ACCESS_CLAIM.ROAD_CLASS));
});

test('authorities are derived from corridor facts with a stated basis, and unknowns stay unknown', () => {
  const { roads } = pilot(CORRIDOR_INDEX['or-roads-cornelius-pass-rd']);
  const authorities = deriveAuthorities(roads);
  const counties = authorities.filter(authority => authority.role === 'county-road-authority');
  assert.deepEqual(counties.map(authority => authority.id).sort(), ['county:multnomah', 'county:washington']);
  assert.ok(counties.every(authority => /TIGER\/Line road records name/.test(authority.basis)));
  assert.ok(authorities.some(authority => authority.id === 'city:unknown' && authority.derived === false));
  assert.ok(authorities.some(authority => authority.id === 'land-manager:unknown' && authority.derived === false));
  assert.equal(deriveAuthorities(roads).some(authority => authority.id === 'state:odot'), false);
  assert.deepEqual(padBounds([-122.9, 45.5, -122.8, 45.6], 0.003), [-122.903, 45.497, -122.797, 45.603]);
  assert.deepEqual(osmSearchNames('NW Springville Rd'), ['NW Springville Rd', 'Northwest Springville Road', 'Springville Road']);
});

test('the baseline records what the deterministic layers had before any research', async () => {
  const { candidate, roads } = pilot(CORRIDOR_INDEX['or-roads-susbauer-rd']);
  const baseline = baselineEvidence({ candidate, roads, evidence: { ecology: { coverage: 'PARTIAL', level3: { primary: { name: 'Willamette Valley' } } }, occurrence: { coverage: { occurrence: 'FULL' }, sources: { inaturalist: { source: 'inaturalist', coverage: 'FULL', observations: 12 } } } } });
  assert.equal(baseline.present.geometry, true);
  assert.equal(baseline.present.habitat, false);
  assert.equal(baseline.ecology.level3, 'Willamette Valley');
  assert.equal(baseline.occurrence.sources[0].observations, 12);
  assert.equal(baseline.geometry.sourceFeatureCount, 1);
});

test('the workflow helper keeps stage transitions explicit', () => {
  const plan = createResearchPlan(pilot(0).candidate);
  const running = startStage(plan.stages, 'baseline', { now: () => new Date(CHECKED_AT) });
  assert.equal(running.find(stage => stage.id === 'baseline').status, 'running');
  const done = finishStage(running, 'baseline', { summary: 'ok', counters: { a: 1 }, now: () => new Date(CHECKED_AT) });
  assert.equal(done.find(stage => stage.id === 'baseline').status, 'complete');
  assert.deepEqual(stageSummary(done).pending, STAGES.length - 1);
  assert.throws(() => startStage(plan.stages, 'nope'), /Unknown investigator stage/);
  assert.throws(() => finishStage(plan.stages, 'baseline', { status: 'bogus' }), /Unknown stage status/);
});

// ---- the portable evidence bundle -----------------------------------------------------------------

const OCCURRENCE_SAMPLE = { coverage: { occurrence: 'FULL', 'occurrence-inaturalist': 'FULL', 'occurrence-ebird': 'UNKNOWN' }, analysisRadiiM: [1000, 5000, 10000], measuredCrs: 'EPSG:5070', lenses: [{ id: 'birds', label: 'Birds' }],
  sources: { inaturalist: { source: 'inaturalist', label: 'iNaturalist', coverage: 'FULL', available: true, observations: 166, uniqueTaxa: 120, preciseObservations: 12,
    regionalOnlyObservations: 154, nearestM: 84, latestObservedAt: '2026-09-20T00:00:00.000Z', buckets: { 1000: { observations: 3 } }, recency: { d30: { observations: 5 } },
    groups: [{ id: 'birds', observations: 40 }], taxa: Array.from({ length: 30 }, (_, index) => ({ scientificName: `Species ${index}`, commonName: `Common ${index}`, taxonomicGroup: 'birds', observations: 1 })),
    points: [{ source: 'inaturalist', location: [-122.9, 45.53] }], records: [{ location: [-122.9, 45.53] }] } } };

async function bundleFixture() {
  const { candidate, roads } = pilot(CORRIDOR_INDEX['or-roads-cornelius-pass-rd']);
  const investigation = await investigateOffline('or-roads-cornelius-pass-rd');
  const at = '2026-09-25T12:30:00.000Z';
  const bundle = buildCorridorBundle({ candidate, roads, investigation,
    ecology: { coverage: 'FULL', level3: { primary: { name: 'Willamette Valley', code: '3a' }, coverage: 'FULL' }, level4: { primary: { name: 'Portland Hills', code: '3a1' }, coverage: 'PARTIAL' }, provenance: { method: 'EPA intersect', sources: [{ agency: 'EPA', url: 'https://epa.gov' }] } },
    habitat: { coverage: { wetlands: 'FULL', hydrography: 'PARTIAL' }, wetlands: { coverage: 'FULL', count: 4 }, hydrography: { coverage: 'PARTIAL', count: 2 }, provenance: { method: 'NWI/NHD overlay' } },
    occurrence: OCCURRENCE_SAMPLE, generatedAt: at });
  return { bundle, investigation, candidate, at };
}

test('the bundle carries identity, summaries, evidence, coverage, and freshness under one schema version', async () => {
  const { bundle } = await bundleFixture();
  assert.equal(bundle.schemaVersion, BUNDLE_SCHEMA_VERSION);
  assert.equal(bundle.kind, BUNDLE_KIND);
  assert.equal(bundle.corridor.id, 'or-roads-cornelius-pass-rd');
  assert.ok(bundle.corridor.lengthM > 16000);
  assert.equal(bundle.corridor.geometry.included, false);
  assert.equal(bundle.geometry.source, 'U.S. Census Bureau');
  assert.equal(bundle.ecology.level3.primary.name, 'Willamette Valley');
  assert.equal(bundle.habitat.coverage.wetlands, 'FULL');
  assert.equal(bundle.occurrence.sources.inaturalist.observations, 166);
  assert.equal(bundle.access.finding, ACCESS_FINDING.RESTRICTED_OR_CLOSED);
  assert.equal(bundle.access.ruleId, 'R3_CURRENT_RESTRICTION');
  assert.ok(bundle.access.restrictions.some(item => item.temporalScope === 'CURRENT'));
  assert.ok(bundle.access.contradictions.length > 0);
  assert.ok(bundle.access.sources.length > 0);
  assert.equal(bundle.investigation.stages.length, STAGES.length);
  assert.ok(bundle.investigation.authorities.length >= 2);
  assert.ok(bundle.investigation.osm.match.matchedWayCount >= 0);
  assert.equal(bundle.investigation.research.probes.length, PILOT_PROBES_BY_CORRIDOR['or-roads-cornelius-pass-rd'].length);
  assert.equal(bundle.coverage[COVERAGE_DATASET.ACCESS_VERIFICATION].coverage, COVERAGE.FULL);
  assert.equal(bundle.freshness.generatedAt, '2026-09-25T12:30:00.000Z');
  assert.equal(bundle.freshness.accessEvaluatedAsOf, CHECKED_AT);
});

test('the bundle carries no credential, no observation record, and no uncapped raw payload', async () => {
  const { bundle } = await bundleFixture();
  const text = JSON.stringify(bundle);
  assert.doesNotMatch(text, /api[_-]?key|X-eBirdApiToken|secret|bearer /i);
  assert.equal(Object.hasOwn(bundle.occurrence.sources.inaturalist, 'records'), false);
  assert.equal(Object.hasOwn(bundle.occurrence.sources.inaturalist, 'points'), false);
  assert.equal(bundle.occurrence.sources.inaturalist.taxa.length, 12);
  assert.equal(bundle.occurrence.sources.inaturalist.taxaTruncated, true);
  const leaks = [];
  const walk = (value, path) => { if (Array.isArray(value)) { if (value.length === 2 && value.every(entry => typeof entry === 'number')) leaks.push(path); else value.forEach(entry => walk(entry, path)); }
    else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`); };
  walk({ ecology: bundle.ecology, habitat: bundle.habitat, occurrence: bundle.occurrence, access: bundle.access, investigation: bundle.investigation }, 'bundle');
  assert.deepEqual(leaks, []);
});

test('the same inputs produce the same bundle, and a bundle survives a JSON roundtrip', async () => {
  const first = await bundleFixture();
  const second = await bundleFixture();
  assert.equal(JSON.stringify(first.bundle), JSON.stringify(second.bundle));
  const parsed = parseBundle(JSON.stringify(first.bundle));
  assert.equal(parsed.access.finding, first.bundle.access.finding);
  assert.equal(parsed.validation.valid, true);
  assert.equal(validateBundle(first.bundle).valid, true);
  assert.throws(() => parseBundle('{ not json'), /not valid JSON/);
});

test('validation refuses a tampered or unsafe bundle', async () => {
  const { bundle } = await bundleFixture();
  assert.match(validateBundle({ ...bundle, schemaVersion: 'roadnaturalist-corridor-evidence/2' }).errors.join(' '), /schemaVersion must be/);
  assert.match(validateBundle({ ...bundle, access: { ...bundle.access, ruleId: undefined } }).errors.join(' '), /must cite its guardrail/);
  assert.match(validateBundle({ ...bundle, access: { ...bundle.access, apiKey: 'x' } }).errors.join(' '), /credential-like/);
  const withCoordinates = { ...bundle, occurrence: { ...bundle.occurrence, sources: { inaturalist: { ...bundle.occurrence.sources.inaturalist, points: [[-122.9, 45.53]] } } } };
  assert.match(validateBundle(withCoordinates).errors.join(' '), /coordinates in a section that must stay summarized/);
  assert.equal(validateBundle(null).valid, false);
});

test('a human review is carried beside the automated finding, not instead of it', async () => {
  const { bundle, investigation, candidate, at } = await bundleFixture();
  const human = { finding: 'CONFLICTED', annotation: 'County plan may be stale after the transfer.', decidedAt: '2026-09-25T13:00:00.000Z', automatedFinding: ACCESS_FINDING.RESTRICTED_OR_CLOSED };
  const reviewed = buildCorridorBundle({ candidate, roads: pilot(CORRIDOR_INDEX['or-roads-cornelius-pass-rd']).roads,
    investigation: { ...investigation, access: { ...investigation.access, human } }, generatedAt: at });
  assert.equal(reviewed.access.finding, ACCESS_FINDING.RESTRICTED_OR_CLOSED);
  assert.equal(reviewed.access.human.finding, 'CONFLICTED');
  assert.equal(reviewed.access.human.automatedFinding, ACCESS_FINDING.RESTRICTED_OR_CLOSED);
  assert.equal(validateBundle(reviewed).valid, true);
  assert.equal(bundle.access.human, null);
});

test('a corridor with no investigation still produces a valid bundle that says so', () => {
  const { candidate, roads } = pilot(CORRIDOR_INDEX['or-roads-susbauer-rd']);
  const bundle = buildCorridorBundle({ candidate, roads, generatedAt: '2026-09-25T12:00:00.000Z' });
  assert.equal(bundle.access, null);
  assert.equal(bundle.investigation, null);
  assert.equal(validateBundle(bundle).valid, true);
  assert.equal(bundle.coverage[COVERAGE_DATASET.ACCESS_VERIFICATION].coverage, COVERAGE.UNKNOWN);
  assert.match(bundle.coverage[COVERAGE_DATASET.ACCESS_VERIFICATION].reason ?? 'Not yet analyzed', /Not yet analyzed/);
});
