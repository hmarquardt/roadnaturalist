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
  // The chain is derived == raw batch == detailed. A detailed comparison exists for the sampled corridors, and
  // only distances where both sides report FULL coverage were compared - the capture records the rest as
  // coverage, not as a difference.
  const detailed = fixture.detailed ?? [];
  const comparable = detailed.reduce((total, entry) => total + (entry.comparable ?? []).length, 0);
  if (!detailed.length) problems.push('the capture compared no corridor against the detailed analysis');
  if (!comparable) problems.push('no derived buffer distance was comparable with the detailed analysis');
  for (const entry of detailed) {
    const derivedRepaired = entry.geometryForAnalysis?.derived?.repaired;
    const detailedRepaired = entry.geometryForAnalysis?.detailed?.repaired;
    // Same rule as the batch comparison: a derived repair must also be a detailed repair, the reverse is a
    // recorded native-versus-WASM engine difference, and two repairs must choose the same rung.
    if (derivedRepaired === true && detailedRepaired !== true) {
      problems.push(`${entry.id}: repair provenance differs (derived ${derivedRepaired} vs detailed ${detailedRepaired})`);
    }
    const derivedMethod = entry.geometryForAnalysis?.derived?.method;
    const detailedMethod = entry.geometryForAnalysis?.detailed?.method;
    if (derivedRepaired === true && detailedRepaired === true && derivedMethod !== detailedMethod) {
      problems.push(`${entry.id}: repair method differs (derived ${derivedMethod} vs detailed ${detailedMethod})`);
    }
  }
  sections.repairProvenance = { corridors: detailed.length, engineDifferences: (fixture.repairEngineDifferences ?? []).length };
  sections.detailed = { corridors: detailed.length, comparableDistances: comparable };
  sections.presence = fixture.presence ?? null;
  if (fixture.presence) {
    // The derived path is narrower by design: it keeps a corridor only when the corridor itself lies in the
    // search region. That is only acceptable if every corridor it adds really does lie there.
    if (fixture.presence.derivedOnlyOutsideSearchBox) {
      problems.push(`${fixture.presence.derivedOnlyOutsideSearchBox} derived-only corridor(s) lie outside the search box`);
    }
    if (!fixture.presence.rawOnly) {
      problems.push('the capture found no raw-only corridor: the two selection rules are expected to differ');
    }
  }
  // A comparison of two nulls passes without ever looking at a number, so the capture's own evidence that it
  // compared real measurements is asserted here.
  const measuredWetland = (fixture.comparisons ?? []).filter(item =>
    item.derived?.wetlands?.areas?.[1000] != null && item.raw?.wetlands?.areas?.[1000] != null).length;
  const measuredHydro = (fixture.comparisons ?? []).filter(item =>
    item.derived?.hydrography?.flowlineLength1000M != null && item.raw?.hydrography?.flowlineLength1000M != null).length;
  if (!measuredWetland) problems.push('the capture compared no wetland area value');
  if (!measuredHydro) problems.push('the capture compared no hydrography length value');
  sections.measured = { wetlandArea1000: measuredWetland, hydroFlowlineLength1000: measuredHydro };
  sections.shapes = {
    segmented: (fixture.comparisons ?? []).filter(item => (item.derived?.segment?.[1] ?? 1) > 1).length,
    wetlandHeavy: (fixture.comparisons ?? []).filter(item => (item.derived?.wetlands?.areas?.[1000] ?? 0) > 10000).length,
    hydroHeavy: (fixture.comparisons ?? []).filter(item => (item.derived?.hydrography?.flowlineLength1000M ?? 0) > 500).length,
    partial: (fixture.comparisons ?? []).filter(item => item.derived?.coverage?.wetlands === 'PARTIAL' || item.derived?.coverage?.hydrography === 'PARTIAL').length,
    repaired: (fixture.comparisons ?? []).filter(item => item.derived?.geometryRepaired).length,
  };
  const edgeCases = fixture.edgeCases ?? [];
  if (edgeCases.length !== 2 || !edgeCases.some(item => item.expected === 'FULL')
    || !edgeCases.some(item => item.expected === 'PARTIAL')) {
    problems.push('the committed sample must contain real near-edge FULL and PARTIAL corridors');
  }
  for (const item of edgeCases) {
    if (item.declared?.wetlands !== item.expected || item.declared?.hydrography !== item.expected
      || item.detailed?.wetlands !== item.expected || item.detailed?.hydrography !== item.expected) {
      problems.push(`${item.id}: near-edge derived/detailed coverage differs`);
    }
    if (item.expected === 'FULL' && (Math.abs(item.metrics.wetlandArea1000 - item.metrics.detailedWetlandArea1000) > 1
      || Math.abs(item.metrics.hydroLength1000 - item.metrics.detailedHydroLength1000) > 1)) {
      problems.push(`${item.id}: near-edge FULL habitat metrics differ from raw detailed GIS`);
    }
  }
  sections.edgeCases = edgeCases.map(item => ({ id: item.id, coverage: item.expected }));
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
  if (sections.detailed) console.log(`  detailed     ${sections.detailed.corridors} corridor(s) compared with the detailed analysis, `
    + `${sections.detailed.comparableDistances} comparable distance measurement(s)`);
  if (sections.repairProvenance) console.log(`  repair       ${sections.repairProvenance.corridors} corridor(s) checked, `
    + `${sections.repairProvenance.engineDifferences} native-versus-WASM engine difference(s) recorded`);
  if (sections.derivedMs && sections.rawMs) console.log(`  transfer     derived ${sections.derivedMs} ms vs raw ${sections.rawMs} ms`);
  if (sections.measured) console.log(`  measured     ${sections.measured.wetlandArea1000} wetland-area and `
    + `${sections.measured.hydroFlowlineLength1000} hydrography-length value(s) compared`);
  if (sections.presence) console.log(`  selection    ${sections.presence.derivedOnly} derived-only corridor(s) `
    + `(all inside the search box), ${sections.presence.rawOnly} raw-only corridor(s) of selected units`);
  for (const problem of problems) console.log(`  PROBLEM  ${problem}`);
  console.log(problems.length ? `FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})` : 'VALID');
}
process.exit(problems.length ? 1 : 0);
