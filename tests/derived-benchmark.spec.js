import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Derived regional discovery benchmarks: the committed concentric 10/25/50-mile scenarios on the committed
// centre, measured through the path production uses (precomputed metric cells). Each scenario runs twice in
// one browser session so a warm measurement is comparable with the cold one, and the raw 25/50-mile guard is
// never re-run: the committed raw baseline stays the comparison.
//
//     RUN_DERIVED_BENCHMARK=1 npx playwright test tests/derived-benchmark.spec.js --reporter=line --retries=0
const OUT = process.env.DERIVED_BENCHMARK_OUT ?? 'data/regional/derived-benchmarks.json';
const SCENARIOS = JSON.parse(readFileSync(new URL('../data/regional/benchmarks.json', import.meta.url))).scenarios;
const CLASSIFY = ms => ms <= 10000 ? 'COMFORTABLE' : ms <= 25000 ? 'USABLE' : ms <= 45000 ? 'SLOW' : 'UNSUITABLE';

test.skip(!process.env.RUN_DERIVED_BENCHMARK, 'The derived benchmark is opt-in: it measures real radius searches in a browser');

test('benchmark derived regional discovery at 10, 25, and 50 miles', async ({ page }) => {
  test.setTimeout(2400000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const externalRequests = [];
  page.on('request', request => {
    const url = request.url();
    if (/(inaturalist|ebird|overpass|workers\.dev)/i.test(url)) externalRequests.push(url);
  });
  await page.goto('/');
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  const report = await page.evaluate(async scenarios => {
    const { gis } = await import('/src/app/main.js');
    const { runDiscovery } = await import('/src/discovery/run.js');
    const heapMb = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
    const measured = [];
    for (const scenario of scenarios) {
      const searchArea = { id: `derived-${scenario.id}`, name: `${scenario.label} (derived)`, kind: 'radius',
        center: scenario.center, radiusMiles: scenario.radiusMiles, catalogUrl: 'regional/manifest.json' };
      const passes = [];
      for (const pass of ['cold', 'warm']) {
        const started = performance.now();
        const run = await runDiscovery({ gis, searchArea });
        const totalMs = Math.round(performance.now() - started);
        const diagnostics = run.diagnostics ?? {};
        const timing = diagnostics.derivedTimingMs ?? {};
        passes.push({ pass, totalMs, classification: null, cellsSelected: diagnostics.derivedSelection?.cells?.cells ?? null,
          cellsPresent: diagnostics.derivedSelection?.cells?.present ?? null, cellsEmpty: diagnostics.derivedSelection?.cells?.empty ?? null,
          cellsRegistered: timing.registeredCells ?? null, selectedBytes: diagnostics.derivedSelection?.bytes ?? null,
          transferredBytes: timing.downloadedBytes ?? null, cacheHits: timing.cacheHits ?? null,
          manifestMs: timing.manifestMs ?? null, fetchMs: timing.fetchMs ?? null, verifyMs: timing.verifyMs ?? null,
          registerMs: timing.registerMs ?? null, queryAndFilterMs: (diagnostics.queryMs ?? 0) + (diagnostics.selectionMs ?? 0),
          queryMs: diagnostics.queryMs ?? null, selectionMs: diagnostics.selectionMs ?? null, buildMs: diagnostics.buildMs ?? null,
          rowsLoaded: diagnostics.counts?.storedRows ?? null, replicatedRows: (diagnostics.counts?.storedRows ?? 0) - (diagnostics.counts?.corridors ?? 0),
          uniqueCorridors: diagnostics.counts?.corridors ?? null, radiusSelected: run.results.length,
          displayed: diagnostics.counts?.displayed ?? null, coverage: run.coverage?.coverage ?? null,
          heapMb: heapMb(), status: run.status, errors: run.diagnostics?.datasetErrors ?? [] });
      }
      for (const entry of passes) entry.classification = CLASSIFY(entry.totalMs);
      measured.push({ id: scenario.id, label: scenario.label, radiusMiles: scenario.radiusMiles, center: scenario.center,
        derived: true, passes });
    }
    return { kind: 'road-derived-corridor-discovery-benchmarks', version: 1, region: 'or-sw-wa-portland-v2',
      capturedAt: new Date().toISOString(), measurements: measured };
  }, SCENARIOS);
  mkdirSync(new URL('../data/regional/', import.meta.url), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
  for (const entry of report.measurements) {
    for (const pass of entry.passes) {
      console.log(`${entry.id} ${pass.pass}: ${pass.totalMs} ms ${pass.classification} | cells ${pass.cellsPresent}/${pass.cellsSelected}`
        + ` | bytes ${pass.selectedBytes} -> ${pass.transferredBytes} | corridors ${pass.uniqueCorridors} -> ${pass.radiusSelected}`
        + ` | fetch ${pass.fetchMs} verify ${pass.verifyMs} register ${pass.registerMs} query ${pass.queryMs} build ${pass.buildMs} | heap ${pass.heapMb} MB`);
    }
  }
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  for (const entry of report.measurements) for (const pass of entry.passes) expect(pass.status).toBe('ready');
});
