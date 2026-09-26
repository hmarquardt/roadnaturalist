#!/usr/bin/env node
/**
 * Validate the investigator probe catalog. Offline, fast, and reviewer-first.
 *
 *   npm run validate:probes
 *   npm run validate:probes -- --json      # machine-readable issues as well as the sentences
 *
 * It loads the catalog and its schema, runs the shared schema and semantic validation, then the checks only the server
 * side can make: that every declared source host is in the Worker's allow-list, that every policy profile resolves to
 * a cache lifetime, and that the reviewed capture and drift baseline only speak about probes the catalog still
 * declares (and mention every probe it does declare). It contacts no network and changes no file.
 *
 * Exit status: 1 if there is an error, 0 with warnings printed if there are only warnings. Warnings are things a
 * reviewer should look at (a corridor part without the source's own words, a probe missing from the capture), not
 * reasons to block a commit.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkReviewedArtifacts, loadProbeCatalog, validateCatalog } from '../src/investigator/probes/catalog.js';
import { PROFILE_NAMES, buildProbePolicy, checkCatalogAgainstPolicy } from '../worker/investigator/policies.js';
import { DRIFT_BASELINE } from '../src/investigator/probes/drift-baseline.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CATALOG_PATH = 'data/investigator/probe-catalog.json';
const SCHEMA_PATH = 'data/investigator/probe-catalog.schema.json';
const CAPTURE_PATH = 'data/investigator/or-pilot-access-evidence.json';
const asJson = process.argv.includes('--json');
const readJson = path => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));

const errors = [];
const warnings = [];
const fail = (scope, message, detail = null) => errors.push({ scope, message, detail });

// 1. The catalog itself: schema first, then the semantic rules a schema cannot express.
const catalog = readJson(CATALOG_PATH);
const schema = readJson(SCHEMA_PATH);
const validation = validateCatalog(catalog, schema);
for (const issue of validation.errors) fail('catalog', issue.message, issue.pointer);
for (const issue of validation.warnings) warnings.push({ scope: 'catalog', message: issue.message, detail: issue.pointer });

// 2. Server-side policy: every declared host allow-listed, every profile implemented, every probe buildable.
if (!validation.errors.length) {
  const policy = checkCatalogAgainstPolicy(catalog);
  for (const issue of policy.errors) fail('worker-policy', issue.message, issue.pointer);
  for (const probe of catalog.probes) {
    try { buildProbePolicy(probe); } catch (error) { fail('worker-policy', `Probe "${probe.id}": ${error.message}`, `/probes/${catalog.probes.indexOf(probe)}`); }
  }
  // The loaded catalog is what both sides actually run with; a load failure is a hard error here too.
  try { loadProbeCatalog(); } catch (error) { fail('catalog', error.message); }
}

// 3. Reviewed artifacts against the catalog: the capture and the baseline are separate, and they must agree on ids.
let capture = null;
try { capture = readJson(CAPTURE_PATH); } catch (error) { fail('capture', `${CAPTURE_PATH} could not be read: ${error.message}`); }
for (const issue of checkReviewedArtifacts({ catalog, capture, baseline: DRIFT_BASELINE })) {
  warnings.push({ scope: issue.artifact, message: issue.message, detail: issue.probeId });
}

// 4. Report.
const print = entry => {
  console.log(`${entry.scope === 'catalog' ? '' : `[${entry.scope}] `}${entry.message}`);
  if (entry.detail) console.log(`    ${entry.detail}`);
};
console.log(`Probe catalog: ${CATALOG_PATH} (${catalog.probes.length} probes, ${catalog.corridors.length} corridors, schema ${schema.$id ?? SCHEMA_PATH})`);
console.log(`Source hosts declared: ${[...new Set(catalog.probes.map(probe => new URL(probe.url).hostname))].join(', ')}`);
console.log(`Policy profiles used: ${[...new Set(catalog.probes.map(probe => probe.policyProfile))].join(', ')} | implemented: ${PROFILE_NAMES.join(', ')}`);
if (warnings.length) { console.log(`\n${warnings.length} warning(s) for a reviewer:`); warnings.forEach(print); }
if (errors.length) { console.log(`\n${errors.length} error(s):`); errors.forEach(print); }
if (asJson) console.log(`\n${JSON.stringify({ errors, warnings }, null, 1)}`);
console.log(`\n${errors.length ? 'INVALID' : 'VALID'} — ${errors.length} error(s), ${warnings.length} warning(s). ${errors.length ? 'Fix the errors above before committing.' : 'The catalog, the Worker policy, and the reviewed artifacts agree.'}`);
process.exit(errors.length ? 1 : 0);
