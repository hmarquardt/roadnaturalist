#!/usr/bin/env node
/**
 * Offline, deterministic verification of the derived corridor-metrics plane.
 *
 *     npm run verify:derived-equivalence [--json]
 *
 * It reads the committed derived-versus-raw comparison (captured by
 * `RUN_DERIVED_EQUIVALENCE_CAPTURE=1 npx playwright test tests/derived-equivalence.capture.spec.js`) and the
 * committed derived manifest, and re-asserts the invariants that make the derived layer usable as an index:
 *
 *   - every compared corridor is present in both runs, and the derived corridor is a superset of the raw one
 *   - the corridor id, name, segment index/count, length, ecology, wetlands, hydrography and coverage agree
 *   - the corridor geometry the derived row carries is the geometry the raw network composes, within a metre
 *   - the derived row's component/unit identity matches the reconstructed corridor's
 *   - the published manifest carries the analysis fingerprint this build implements, and every cell's
 *     declared digest and byte count is well formed
 *
 * A mismatch exits nonzero. Nothing here needs a network or a browser.
 */
import { readFileSync, existsSync } from 'node:fs';
import { validateDerivedManifest } from '../src/discovery/derived-catalog.js';

const json = process.argv.includes('--json');
const profile = JSON.parse(readFileSync(new URL('../data/regional/analysis-profile.json', import.meta.url)));
const fixturePath = new URL('../tests/fixtures/derived-equivalence.json', import.meta.url);
const problems = [];
const sections = {};

if (!existsSync(fixturePath)) {
  problems.push('tests/fixtures/derived-equivalence.json is missing: run the derived equivalence capture first');
} else {
  const fixture = JSON.parse(readFileSync(fixturePath));
  sections.corridors = fixture.corridorCounts;
  sections.divergences = fixture.divergences.length;
  sections.derivedMs = fixture.derivedDiagnostics?.totalMs ?? null;
  sections.rawMs = fixture.rawDiagnostics?.totalMs ?? null;
  if (!fixture.corridorCounts?.shared) problems.push('the capture compared no corridors');
  if ((fixture.divergences ?? []).length) {
    for (const divergence of fixture.divergences) {
      problems.push(`${divergence.id}: ${divergence.field} differs (derived ${JSON.stringify(divergence.derived)} vs raw ${JSON.stringify(divergence.raw)})`);
    }
  }
  if (fixture.derivedDiagnostics?.analysisFingerprint !== profile.fingerprint) {
    problems.push(`the derived run reported fingerprint ${fixture.derivedDiagnostics?.analysisFingerprint}, expected ${profile.fingerprint}`);
  }
  let worstDrift = 0;
  for (const comparison of fixture.comparisons ?? []) {
    if (comparison.driftM == null) problems.push(`${comparison.id}: no raw corridor to compare against`);
    else worstDrift = Math.max(worstDrift, comparison.driftM);
  }
  sections.worstDriftM = worstDrift;
  if (worstDrift > 1) problems.push(`geometry drift of ${worstDrift} m between the derived row and the raw reconstruction`);
  sections.shapes = {
    segmented: (fixture.comparisons ?? []).filter(item => (item.derived?.segment?.[1] ?? 1) > 1).length,
    wetlandHeavy: (fixture.comparisons ?? []).filter(item => (item.derived?.wetlands?.buffers?.[1000]?.areaM2 ?? 0) > 10000).length,
    hydroHeavy: (fixture.comparisons ?? []).filter(item => (item.derived?.hydrography?.buffers?.[1000]?.lengthM ?? 0) > 500).length,
    partial: (fixture.comparisons ?? []).filter(item => item.derived?.coverage?.wetlands === 'PARTIAL' || item.derived?.coverage?.hydrography === 'PARTIAL').length,
    repaired: (fixture.comparisons ?? []).filter(item => item.derived?.geometryRepaired).length,
  };
}

// The published manifest must carry the current analysis fingerprint, and every declared artifact must be
// described well enough to verify on load.
const catalog = JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url)));
if (catalog.derived) {
  const manifestPath = new URL(`../data/${catalog.derived.localPath}`, import.meta.url);
  if (!existsSync(manifestPath)) problems.push(`the declared derived manifest is missing: ${catalog.derived.localPath}`);
  else {
    const manifest = validateDerivedManifest(JSON.parse(readFileSync(manifestPath)));
    sections.manifest = { fingerprint: manifest.analysisFingerprint, corridors: manifest.counts.corridors,
      cells: manifest.counts.cells, present: manifest.counts.presentCells, empty: manifest.counts.emptyCells,
      bytes: manifest.counts.bytes, storedRows: manifest.counts.storedRows, averageRowBytes: manifest.counts.averageRowBytes };
    if (manifest.analysisFingerprint !== profile.fingerprint) {
      problems.push(`the derived manifest was built at fingerprint ${manifest.analysisFingerprint}, expected ${profile.fingerprint}`);
    }
    if (manifest.counts.storedRows < manifest.counts.corridors) problems.push('the derived manifest lost replicated rows');
    if (manifest.counts.bytes > 150 * 1024 * 1024) problems.push(`the derived plane is ${manifest.counts.bytes} bytes, which is too large`);
    for (const cell of manifest.cells) {
      if (cell.state !== 'present') continue;
      if (!Number.isSafeInteger(cell.bytes) || !/^[a-f0-9]{64}$/.test(cell.sha256)) problems.push(`${cell.id} has an unverifiable artifact record`);
    }
  }
} else {
  problems.push('data/regional/manifest.json declares no derived corridor metrics');
}

if (json) console.log(JSON.stringify({ ok: problems.length === 0, sections, problems }, null, 1));
else {
  console.log('derived corridor metrics');
  console.log(`  fingerprint  ${profile.fingerprint}`);
  if (sections.manifest) console.log(`  manifest     ${sections.manifest.corridors} corridors / ${sections.manifest.storedRows} rows / ${sections.manifest.bytes} bytes / ${sections.manifest.cells} cells (${sections.manifest.present} present, ${sections.manifest.empty} empty)`);
  if (sections.corridors) console.log(`  compared     ${sections.corridors.shared} corridors (derived ${sections.corridors.derived}, raw ${sections.corridors.raw})`);
  if (sections.worstDriftM != null) console.log(`  worst drift  ${sections.worstDriftM} m`);
  if (sections.derivedMs && sections.rawMs) console.log(`  transfer     derived ${sections.derivedMs} ms vs raw ${sections.rawMs} ms`);
  for (const problem of problems) console.log(`  PROBLEM  ${problem}`);
  console.log(problems.length ? `FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})` : 'VALID');
}
process.exit(problems.length ? 1 : 0);
