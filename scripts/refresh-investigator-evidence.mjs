#!/usr/bin/env node
/**
 * Refresh the reviewed capture and the drift baseline from the probe catalog.
 *
 *   npm run investigator:refresh
 *   npm run investigator:refresh -- --check     # validate and report, contact nothing, change nothing
 *
 * The three artifacts are deliberately separate:
 *
 *   data/investigator/probe-catalog.json            what is expected (reviewed data; the catalog drives this run)
 *   data/investigator/or-pilot-access-evidence.json what was retrieved (historical evidence, replayed offline)
 *   src/investigator/probes/drift-baseline.js       the normalized signature of that evidence
 *
 * This command validates the catalog first, retrieves every declared probe through the same operator path the
 * Investigator uses, rewrites the capture and the baseline together, validates the result, and prints what changed per
 * probe. It never commits: the diff is what a reviewer reads, and live results become reviewed evidence only when
 * somebody commits them.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkReviewedArtifacts } from '../src/investigator/probes/catalog.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CAPTURE_PATH = 'data/investigator/or-pilot-access-evidence.json';
const BASELINE_PATH = 'src/investigator/probes/drift-baseline.js';
const checkOnly = process.argv.includes('--check');

const readJson = path => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
const baselineOf = async () => (await import(`../${BASELINE_PATH}?v=${Date.now()}`)).DRIFT_BASELINE;

const summarize = record => {
  const probes = new Map();
  for (const corridor of Object.values(record?.corridors ?? {})) {
    for (const entry of corridor.probes ?? []) probes.set(entry.probeId, entry);
  }
  return probes;
};

console.log('Step 1 — validate the probe catalog');
execFileSync(process.execPath, [resolve(ROOT, 'scripts/validate-probes.mjs')], { cwd: ROOT, stdio: 'inherit' });

if (checkOnly) {
  console.log('\n--check was passed: the catalog and the artifacts were validated and nothing was retrieved or written.');
  process.exit(0);
}

const beforeCapture = (() => { try { return readJson(CAPTURE_PATH); } catch { return null; } })();
const beforeBaseline = await baselineOf();

console.log('\nStep 2 — retrieve every declared probe through the operator path and rewrite the artifacts');
execFileSync(process.execPath, [resolve(ROOT, 'scripts/verify-investigator-live.mjs'), '--write-record'], { cwd: ROOT, stdio: 'inherit' });

console.log('\nStep 3 — validate the refreshed artifacts against the catalog');
const afterCapture = readJson(CAPTURE_PATH);
const afterBaseline = await baselineOf();
const problems = checkReviewedArtifacts({ catalog: readJson('data/investigator/probe-catalog.json'), capture: afterCapture, baseline: afterBaseline });
for (const problem of problems) console.log(`  WARNING ${problem.message}`);
if (!problems.length) console.log('  capture and baseline mention exactly the probes the catalog declares');

console.log('\nStep 4 — what changed');
const beforeProbes = summarize(beforeCapture);
const afterProbes = summarize(afterCapture);
const beforeBaselineProbes = new Map((beforeBaseline.probes ?? []).map(entry => [entry.probeId, entry]));
const afterBaselineProbes = new Map((afterBaseline.probes ?? []).map(entry => [entry.probeId, entry]));
const ids = [...new Set([...beforeProbes.keys(), ...afterProbes.keys()])].sort();
let changed = 0;
for (const probeId of ids) {
  const before = beforeProbes.get(probeId);
  const after = afterProbes.get(probeId);
  const beforeDigest = beforeBaselineProbes.get(probeId)?.digest ?? null;
  const afterDigest = afterBaselineProbes.get(probeId)?.digest ?? null;
  if (!before) { console.log(`  + ${probeId}: added (${after.outcome}, ${after.evidence?.length ?? 0} fact(s))`); changed += 1; continue; }
  if (!after) { console.log(`  - ${probeId}: removed from the capture`); changed += 1; continue; }
  const factsBefore = before.evidence?.length ?? 0;
  const factsAfter = after.evidence?.length ?? 0;
  if (before.outcome !== after.outcome || factsBefore !== factsAfter || beforeDigest !== afterDigest) {
    console.log(`  ~ ${probeId}: ${before.outcome} ${factsBefore} fact(s) [${beforeDigest}] -> ${after.outcome} ${factsAfter} fact(s) [${afterDigest}]`);
    changed += 1;
  }
}
console.log(changed ? `  ${changed} probe(s) differ; the capture is ${afterCapture.capturedAt}.` : '  no probe changed; the capture was rewritten with a new capture time and identical evidence.');
console.log('\nNothing was committed. Review `git diff -- ' + CAPTURE_PATH + ' ' + BASELINE_PATH + '` before committing: this capture is what the browser build replays offline.');
