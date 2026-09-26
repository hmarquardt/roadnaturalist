import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATALOG_SCHEMA_VERSION, CATALOG_VOCABULARIES, PROBE_CATALOG, checkReviewedArtifacts, loadProbeCatalog, validateCatalog } from '../src/investigator/probes/catalog.js';
import { checkSchemaValue } from '../src/investigator/probes/schema-check.js';
import { HOST_POLICY, PROFILE_NAMES, buildProbePolicy, checkCatalogAgainstPolicy } from '../worker/investigator/policies.js';
import { createProbeRegistry } from '../worker/investigator/registry.js';
import { buildBaselineFromRecord } from '../src/investigator/drift.js';
import { DRIFT_BASELINE } from '../src/investigator/probes/drift-baseline.js';
import { extractProbeFacts } from '../src/investigator/research.js';
import { getProbesForCorridor, PILOT_CORRIDOR_IDS, PILOT_PROBES_BY_CORRIDOR, PROBE_CATALOG as SOURCES_CATALOG } from '../src/investigator/sources.js';
import { CLAIM_STRENGTH, EVIDENCE_SCOPE, RECURRENCE, SOURCE_CLASS } from '../src/investigator/access.js';

// The catalog is data, so these tests treat it the way a reviewer would: take the shipped catalog, change exactly one
// thing, and require the validator to say what is wrong in words a person can act on.
const CATALOG = readFileSync(new URL('../data/investigator/probe-catalog.json', import.meta.url), 'utf8');
const SCHEMA = readFileSync(new URL('../data/investigator/probe-catalog.schema.json', import.meta.url), 'utf8');
const shipped = () => JSON.parse(CATALOG);
const schema = JSON.parse(SCHEMA);
const regression = JSON.parse(readFileSync(new URL('./fixtures/investigator/probe-catalog-regression.json', import.meta.url), 'utf8'));
const CAPTURE = JSON.parse(readFileSync(new URL('../data/investigator/or-pilot-access-evidence.json', import.meta.url), 'utf8'));

const mutate = change => { const catalog = shipped(); change(catalog); return catalog; };
const errorsFor = catalog => validateCatalog(catalog, schema).errors;
const warningsFor = catalog => validateCatalog(catalog, schema).warnings;
const firstError = catalog => errorsFor(catalog)[0]?.message ?? '';

// ---------------------------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------------------------

test('the shipped catalog satisfies its committed schema, and the schema covers the runtime vocabularies', () => {
  assert.equal(shipped().schemaVersion, CATALOG_SCHEMA_VERSION);
  assert.deepEqual(validateCatalog(shipped(), schema).errors, []);
  const probeFields = schema.$defs.probe.properties;
  const factFields = schema.$defs.fact.properties;
  assert.deepEqual([...probeFields.sourceClass.enum].sort(), [...CATALOG_VOCABULARIES.sourceClasses].sort());
  assert.deepEqual([...factFields.claimType.enum].sort(), [...CATALOG_VOCABULARIES.claimTypes].sort());
  assert.deepEqual([...factFields.claimStrength.enum].sort(), [...CATALOG_VOCABULARIES.claimStrengths].sort());
  assert.deepEqual([...factFields.scope.enum].sort(), [...CATALOG_VOCABULARIES.evidenceScopes].sort());
  assert.deepEqual([...factFields.recurrence.enum].filter(Boolean).sort(), [...CATALOG_VOCABULARIES.recurrences].sort());
  assert.deepEqual([...probeFields.policyProfile.enum].sort(), [...PROFILE_NAMES].sort());
  assert.deepEqual([...probeFields.stage.enum].sort(), [...CATALOG_VOCABULARIES.stages].sort());
  assert.deepEqual([...probeFields.kind.enum].sort(), [...CATALOG_VOCABULARIES.kinds].sort());
  // The vocabularies the schema lists are the ones access.js actually defines, so a new claim type cannot be added to
  // one without the other.
  assert.deepEqual([...CATALOG_VOCABULARIES.sourceClasses], Object.values(SOURCE_CLASS));
  assert.deepEqual([...CATALOG_VOCABULARIES.recurrences], Object.values(RECURRENCE));
  assert.deepEqual([...CATALOG_VOCABULARIES.evidenceScopes], Object.values(EVIDENCE_SCOPE));
  assert.deepEqual([...CATALOG_VOCABULARIES.claimStrengths], Object.values(CLAIM_STRENGTH));
});

test('a missing required field is reported with the probe and the field', () => {
  assert.match(firstError(mutate(catalog => { delete catalog.probes[2].question; })), /Probe "wc-cornelius-closure-news": field "question" is required and is missing/);
});

test('a malformed probe id is rejected', () => {
  assert.match(firstError(mutate(catalog => { catalog.probes[0].id = 'Bad_ID'; })), /field "id".*does not match/);
  assert.match(firstError(mutate(catalog => { catalog.probes[0].id = 'a'; })), /field "id".*does not match/);
});

test('a duplicate probe id is rejected', () => {
  assert.match(firstError(mutate(catalog => { catalog.probes[1].id = catalog.probes[0].id; })), /Probe "odot-cornelius-transfer" is declared twice/);
});

test('an invalid or unsafe source URL is rejected', () => {
  assert.match(firstError(mutate(catalog => { catalog.probes[0].url = 'http://example.com/page'; })), /field "url".*does not match/);
  assert.match(firstError(mutate(catalog => { catalog.probes[0].url = 'https://user:secret@example.com/page'; })), /field "url".*does not match/);
  assert.match(firstError(mutate(catalog => { catalog.probes[0].url = 'https://example.com/page#section'; })), /field "url".*does not match/);
  assert.match(firstError(mutate(catalog => { catalog.probes[0].url = 'https://example.com/page?q=1'; })), /field "url".*does not match/);
});

test('an unsupported source tier, claim type, or profile is rejected', () => {
  assert.match(firstError(mutate(catalog => { catalog.probes[0].sourceClass = 'TIER_1_OFFICIAL'; })), /field "sourceClass" must be one of/);
  assert.match(firstError(mutate(catalog => { catalog.probes[0].facts[0].claimType = 'CLOSED_ROADZ'; })), /Probe "odot-cornelius-transfer": fact 0 \(CLOSED_ROADZ\), field "claimType" must be one of/);
  assert.match(firstError(mutate(catalog => { catalog.probes[0].policyProfile = 'forever'; })), /field "policyProfile" must be one of/);
});

test('an impossible or malformed effective date is rejected', () => {
  assert.match(firstError(mutate(catalog => { catalog.probes[1].facts[0].effectiveUntil = '2026-13-45'; })), /field "effectiveUntil" "2026-13-45" is not a real calendar date/);
  assert.match(firstError(mutate(catalog => { catalog.probes[1].facts[0].effectiveFrom = '2026-02-31'; })), /field "effectiveFrom" "2026-02-31" is not a real calendar date/);
  assert.match(firstError(mutate(catalog => { catalog.probes[1].facts[0].effectiveUntil = '07-15-2026'; })), /field "effectiveUntil".*does not match/);
});

test('a typo in a field name is caught instead of being ignored', () => {
  const message = firstError(mutate(catalog => { const fact = catalog.probes[0].facts[0]; fact.cliamType = fact.claimType; delete fact.claimType; }));
  assert.match(message, /field "claimType" is required|field "cliamType" is not a known field/);
  assert.match(firstError(mutate(catalog => { catalog.probes[0].maxBytes = 999999; })), /field "maxBytes" is not a known field here/);
});

test('the checker refuses a schema that uses a keyword it does not implement', () => {
  assert.throws(() => checkSchemaValue({ a: 1 }, { type: 'object', if: { required: ['a'] } }), /keyword "if".*is not implemented/);
  assert.throws(() => checkSchemaValue({}, { $ref: '#/$defs/missing' }), /does not resolve to a local \$defs entry/);
});

// ---------------------------------------------------------------------------------------------------------------
// Semantics
// ---------------------------------------------------------------------------------------------------------------

test('an unknown corridor reference is rejected with the list of declared corridors', () => {
  const message = firstError(mutate(catalog => { catalog.probes[0].corridorIds = ['or-roads-cornelius-pass-rodd']; }));
  assert.match(message, /corridor "or-roads-cornelius-pass-rodd" is not declared in this catalog's corridors/);
  assert.match(message, /or-roads-cornelius-pass-rd/);
});

test('a repeated phrase is rejected, whether the claim type matches or contradicts', () => {
  const repeated = mutate(catalog => { const [first, second] = catalog.probes[0].facts; second.find = first.find; second.claimType = first.claimType; });
  assert.match(firstError(repeated), /fact 1 repeats the phrase from fact 0 with the same claim type/);
  const contradictory = mutate(catalog => { const [first, second] = catalog.probes[0].facts; second.find = first.find; second.claimType = 'PRIVATE_ROAD'; });
  assert.match(firstError(contradictory), /repeats the phrase from fact 0 but claims a different type \(PUBLIC_ROAD and PRIVATE_ROAD\)/);
});

test('an empty phrase, a window without its quote, and an inverted window are rejected', () => {
  assert.match(firstError(mutate(catalog => { catalog.probes[0].facts[0].find = '   '; })), /fact 0 has an empty phrase/);
  assert.match(firstError(mutate(catalog => { delete catalog.probes[1].facts[0].windowQuote; })), /declares an effective window without the verbatim windowQuote/);
  assert.match(firstError(mutate(catalog => { const fact = catalog.probes[1].facts[0]; fact.effectiveFrom = '2026-11-01'; fact.effectiveUntil = '2026-10-07'; })), /has effectiveFrom 2026-11-01 after effectiveUntil 2026-10-07/);
});

test('a recurrence without the source text that states it is rejected', () => {
  assert.match(firstError(mutate(catalog => { delete catalog.probes[10].facts[0].recurrenceQuote; })), /declares recurrence "high-water" without the verbatim recurrenceQuote/);
});

test('warnings are warnings: the shipped catalog keeps its three corridor-part gaps visible', () => {
  const warnings = warningsFor(shipped());
  assert.equal(warnings.length, 3);
  assert.equal(warnings.every(entry => entry.keyword === 'part-without-words'), true);
  assert.deepEqual(warnings.map(entry => entry.pointer), ['/probes/5/facts/0/corridorPart', '/probes/9/facts/0/corridorPart', '/probes/13/facts/0/corridorPart']);
  assert.deepEqual(errorsFor(shipped()), [], 'a warning must never fail validation');
});

test('two identical declarations are reported so one probe can list both corridors instead', () => {
  const duplicate = mutate(catalog => {
    const copy = JSON.parse(JSON.stringify(catalog.probes[0]));
    copy.id = 'odot-cornelius-transfer-copy';
    copy.corridorIds = ['or-roads-springville-rd'];
    catalog.probes.push(copy);
  });
  assert.deepEqual(errorsFor(duplicate), []);
  assert.match(warningsFor(duplicate).map(entry => entry.message).join('\n'), /declares exactly the same source, question, and facts as "odot-cornelius-transfer"/);
});

test('corridor-to-probe lookup is declarative and total', () => {
  for (const corridorId of PILOT_CORRIDOR_IDS) {
    const probes = getProbesForCorridor(corridorId);
    assert.deepEqual(probes.map(probe => probe.id), regression.probesByCorridor[corridorId].map(probe => probe.id));
    assert.equal(PILOT_PROBES_BY_CORRIDOR[corridorId].length, probes.length);
  }
  assert.deepEqual(getProbesForCorridor('or-roads-not-declared'), [], 'an undeclared corridor has no declared sources');
  assert.equal(SOURCES_CATALOG, PROBE_CATALOG, 'the application reads the same load the Worker reads');
});

test('one source declaration can serve several corridors, and a probe may apply to every corridor', () => {
  const shared = mutate(catalog => {
    catalog.probes[0].corridorIds = ['or-roads-cornelius-pass-rd', 'or-roads-springville-rd'];
    const everyCorridor = JSON.parse(JSON.stringify(catalog.probes[0]));
    everyCorridor.id = 'odot-all-corridors-transfer';
    delete everyCorridor.corridorIds;
    catalog.probes.push(everyCorridor);
  });
  assert.deepEqual(validateCatalog(shared, schema).errors, []);
  const loaded = loadProbeCatalog({ source: shared, schema });
  const idsFor = corridorId => loaded.probesForCorridor(corridorId).map(probe => probe.id);
  assert.equal(idsFor('or-roads-springville-rd').includes('odot-cornelius-transfer'), true, 'the shared declaration serves both corridors');
  assert.equal(idsFor('or-roads-cornelius-pass-rd').length, regression.probesByCorridor['or-roads-cornelius-pass-rd'].length + 1);
  assert.equal(idsFor('or-roads-springville-rd').length, regression.probesByCorridor['or-roads-springville-rd'].length + 2);
  assert.equal(idsFor('or-roads-susbauer-rd').length, regression.probesByCorridor['or-roads-susbauer-rd'].length + 1);
  for (const corridorId of PILOT_CORRIDOR_IDS) assert.equal(idsFor(corridorId).includes('odot-all-corridors-transfer'), true);
  // The declaration is shared, not copied: each corridor sees the same normalized probe object.
  assert.equal(loaded.probesForCorridor('or-roads-cornelius-pass-rd').find(probe => probe.id === 'odot-cornelius-transfer'),
    loaded.probesForCorridor('or-roads-springville-rd').find(probe => probe.id === 'odot-cornelius-transfer'));
});

test('the catalog normalizes to exactly the declarations this build shipped before the refactor', () => {
  assert.deepEqual(PROBE_CATALOG.probes, regression.probesByCorridor['or-roads-cornelius-pass-rd']
    .concat(regression.probesByCorridor['or-roads-springville-rd'], regression.probesByCorridor['or-roads-susbauer-rd']));
  for (const corridorId of PILOT_CORRIDOR_IDS) {
    assert.equal(JSON.stringify(PILOT_PROBES_BY_CORRIDOR[corridorId]), JSON.stringify(regression.probesByCorridor[corridorId]));
  }
  for (const probeId of PROBE_CATALOG.probeIds) {
    const policy = createProbeRegistry().get(probeId).policy;
    assert.deepEqual({ ttlSeconds: policy.ttlSeconds, maxBytes: policy.maxBytes, timeoutMs: policy.timeoutMs, host: policy.host, contentTypes: [...policy.contentTypes] },
      regression.effectivePolicies[probeId], `${probeId} must keep the fetch policy it had before the catalog existed`);
  }
  assert.equal(PROBE_CATALOG.probeIds.length, 14);
  assert.equal(PROBE_CATALOG.declarations.every(declaration => typeof declaration.policyProfile === 'string'), true);
});

// ---------------------------------------------------------------------------------------------------------------
// Security: the catalog cannot widen the Worker boundary
// ---------------------------------------------------------------------------------------------------------------

test('a catalog entry on an unapproved host is refused, and declaring a host does not allow it', () => {
  const hostile = mutate(catalog => { catalog.probes[0].url = 'https://evil.example/cornelius'; });
  // The catalog itself is well formed: a URL is a URL. The refusal comes from the server-owned allow-list.
  assert.deepEqual(validateCatalog(hostile, schema).errors, []);
  assert.throws(() => createProbeRegistry({ declarations: hostile.probes }), /host evil\.example is not in the Worker source allow-list/);
  const policy = checkCatalogAgainstPolicy(hostile);
  assert.equal(policy.errors.length, 1);
  assert.match(policy.errors[0].message, /declares evil\.example, which is not in the Worker source allow-list/);
  assert.match(policy.errors[0].message, /Declaring a host in the catalog does not allow it/);
  // The allow-list is a server constant the catalog never touches.
  assert.equal('evil.example' in HOST_POLICY, false);
  assert.equal(PROBE_CATALOG.declarations.some(declaration => declaration.url.includes('evil.example')), false);
});

test('the catalog cannot supply a byte cap, a timeout, a redirect rule, a header, or a method', () => {
  for (const [key, value] of [['maxBytes', 10 ** 9], ['timeoutMs', 600000], ['allowRedirects', true], ['maxRedirects', 5],
    ['headers', { Authorization: 'Bearer x' }], ['method', 'POST'], ['host', 'evil.example'], ['contentTypes', ['application/pdf']]]) {
    const message = firstError(mutate(catalog => { catalog.probes[0][key] = value; }));
    assert.match(message, new RegExp(`field "${key}" is not a known field here`), `${key} must be refused by the schema`);
  }
  // And the effective policy is the server's, not anything a declaration could carry.
  const policy = buildProbePolicy(shipped().probes[0]);
  assert.equal(policy.maxBytes, HOST_POLICY['content.govdelivery.com'].maxBytes);
  assert.equal(policy.timeoutMs, HOST_POLICY['content.govdelivery.com'].timeoutMs);
  assert.equal(policy.maxRedirects, 1);
  assert.equal(policy.method, 'GET');
  assert.deepEqual([...policy.contentTypes], [...HOST_POLICY['content.govdelivery.com'].contentTypes]);
  assert.equal(policy.ttlSeconds, 86400);
});

test('an unimplemented policy profile fails closed instead of defaulting to a lifetime', () => {
  const withUnknownProfile = shipped().probes.map((probe, index) => (index === 0 ? { ...probe, policyProfile: 'forever' } : probe));
  assert.throws(() => createProbeRegistry({ declarations: withUnknownProfile }), /policy profile "forever" is not implemented by this Worker/);
  assert.match(checkCatalogAgainstPolicy({ probes: withUnknownProfile }).errors[0].message, /uses policy profile "forever", which this Worker does not implement/);
});

test('the Worker serves exactly the probes the browser runs, from one load', () => {
  const registry = createProbeRegistry();
  assert.deepEqual([...registry.probeIds], [...PROBE_CATALOG.probeIds]);
  assert.equal(registry.size, PROBE_CATALOG.declarations.length);
  for (const probeId of PROBE_CATALOG.probeIds) {
    const entry = registry.get(probeId);
    assert.equal(entry.probe.url, PROBE_CATALOG.declarationById.get(probeId).url);
    assert.equal(entry.policy.profile, PROBE_CATALOG.profileFor(probeId));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Capture and drift baseline stay separate, and are checked against the catalog
// ---------------------------------------------------------------------------------------------------------------

test('the committed capture and baseline speak only about declared probes, and about all of them', () => {
  assert.deepEqual(checkReviewedArtifacts({ catalog: shipped(), capture: CAPTURE, baseline: DRIFT_BASELINE }), []);
  assert.equal(DRIFT_BASELINE.probes.length, PROBE_CATALOG.probeIds.length);
});

test('adding a probe to the catalog warns that the capture and baseline do not know it yet', () => {
  const added = mutate(catalog => {
    const copy = JSON.parse(JSON.stringify(catalog.probes[0]));
    copy.id = 'odot-cornelius-transfer-second';
    copy.question = 'A second, differently worded question about the same transfer.';
    catalog.probes.push(copy);
  });
  assert.deepEqual(validateCatalog(added, schema).errors, []);
  const warnings = checkReviewedArtifacts({ catalog: added, capture: CAPTURE, baseline: DRIFT_BASELINE });
  const captureWarning = warnings.find(entry => entry.artifact === 'capture');
  const baselineWarning = warnings.find(entry => entry.artifact === 'drift-baseline');
  assert.equal(warnings.length, 2);
  assert.equal(captureWarning.probeId, 'odot-cornelius-transfer-second');
  assert.match(captureWarning.message, /has no reviewed capture entry/);
  assert.match(baselineWarning.message, /has no drift baseline entry/);
  assert.match(baselineWarning.message, /npm run investigator:refresh/);
});

test('removing a probe from the catalog warns that the capture and baseline still hold it', () => {
  const removed = mutate(catalog => { catalog.probes = catalog.probes.filter(probe => probe.id !== 'wc-roads-cornelius-advisory'); });
  const warnings = checkReviewedArtifacts({ catalog: removed, capture: CAPTURE, baseline: DRIFT_BASELINE });
  assert.equal(warnings.filter(entry => entry.artifact === 'capture').length, 1);
  assert.equal(warnings.filter(entry => entry.artifact === 'drift-baseline').length, 1);
  assert.match(warnings[0].message, /which the catalog no longer declares/);
  assert.equal(warnings[0].probeId, 'wc-roads-cornelius-advisory');
});

test('the committed baseline is exactly what the committed capture produces, twice', () => {
  const first = buildBaselineFromRecord(CAPTURE);
  const second = buildBaselineFromRecord(CAPTURE);
  assert.deepEqual(first, second, 'the refresh must be deterministic');
  assert.deepEqual(first.probes.map(entry => ({ probeId: entry.probeId, digest: entry.digest, factCount: entry.factCount })),
    DRIFT_BASELINE.probes.map(entry => ({ probeId: entry.probeId, digest: entry.digest, factCount: entry.factCount })));
  assert.equal(first.capturedAt, DRIFT_BASELINE.capturedAt, 'the baseline records the capture date it came from');
});

test('the catalog drives extraction: every probe reproduces its baseline from the captured phrases', () => {
  const excerpts = JSON.parse(readFileSync(new URL('./fixtures/investigator/source-excerpts.json', import.meta.url), 'utf8')).sources;
  const baseline = new Map(DRIFT_BASELINE.probes.map(entry => [entry.probeId, entry]));
  let compared = 0;
  for (const probe of PROBE_CATALOG.probes) {
    const excerpt = excerpts[probe.url];
    const expected = baseline.get(probe.id);
    if (!excerpt || !expected) continue;
    const extracted = extractProbeFacts(probe, excerpt.text);
    assert.equal(extracted.facts.length, expected.factCount, `${probe.id}: the captured phrases no longer yield the recorded fact count`);
    assert.deepEqual(extracted.facts.map(fact => fact.quote).sort(), expected.facts.map(fact => fact.quote).sort(), `${probe.id}: quotes differ`);
    compared += 1;
  }
  assert.equal(compared >= 6, true, 'at least six declared probes should be comparable against the captured phrases');
});

test('an unsupported catalog version is refused rather than guessed', () => {
  assert.throws(() => loadProbeCatalog({ source: mutate(catalog => { catalog.schemaVersion = 'roadnaturalist-investigator-probes/2'; }), schema }), /schema version "roadnaturalist-investigator-probes\/2" is not supported/);
  assert.throws(() => loadProbeCatalog({ source: { probes: [] }, schema }), /schema version "missing"/);
});

test('an invalid catalog is refused at load, with the reviewer message rather than a stack trace', () => {
  assert.throws(() => loadProbeCatalog({ source: mutate(catalog => { catalog.probes[0].facts[0].claimType = 'CLOSED_ROADZ'; }), schema }), /probe catalog is invalid:[\s\S]*fact 0 \(CLOSED_ROADZ\), field "claimType"/);
});
