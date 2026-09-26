import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

// Regional scale benchmarks. These are multi-minute browser runs, so they are opt-in:
//
//     npm run benchmark:regional
//
// One Chromium context per scenario is the COLD case (no partition registered yet); a second run in the
// same page is the WARM case (the same verified buffers are reused). Results are printed as
// REGIONAL_BENCHMARK lines and written to /tmp/regional-benchmark.json for machine-readable review.
const benchmarks = JSON.parse(readFileSync(new URL('../data/regional/benchmarks.json', import.meta.url)));
const OUT = process.env.BENCHMARK_OUTPUT ?? '/tmp/regional-benchmark.json';
const EVIDENCE = /api\.inaturalist|api\.ebird|overpass|api\.roadnaturalist\.com/;
const results = [];

test.skip(!process.env.RUN_REGIONAL_BENCHMARK,
  'Regional benchmarks are opt-in: npm run benchmark:regional (RUN_REGIONAL_BENCHMARK=1)');

async function measure(page, scenario) {
  return page.evaluate(async ({ scenario }) => {
    const { gis } = await import('/src/app/main.js');
    const { runDiscovery } = await import('/src/discovery/run.js');
    const { resolveSearchArea } = await import('/src/discovery/search-area.js');
    const searchArea = resolveSearchArea({ id: scenario.id, name: scenario.label, kind: 'radius',
      catalogUrl: 'regional/manifest.json', center: scenario.center, radiusMiles: scenario.radiusMiles, bbox: scenario.bbox });
    const started = performance.now();
    let run = null;
    let failure = null;
    try {
      run = await runDiscovery({ gis, searchArea });
    } catch (error) {
      failure = String(error && error.message ? error.message : error);
    }
    const totalMs = Math.round(performance.now() - started);
    const heap = performance.memory?.usedJSHeapSize ?? null;
    if (run && !failure && run.status === 'ready') {
      const diagnostics = run.diagnostics;
      const scope = gis.lastRegionalScope;
      return {
        scenario: scenario.id, radiusMiles: scenario.radiusMiles, totalMs, heapBytes: heap,
        status: run.status, coverage: run.coverage.coverage, searchCoverage: run.coverage.searchCoverage ?? null,
        selection: { counts: diagnostics.partitionSelection?.counts ?? {}, emptyCounts: diagnostics.partitionSelection?.emptyCounts ?? {},
          bytes: diagnostics.partitionSelection?.bytes ?? 0, closure: diagnostics.partitionSelection?.closure ?? null },
        data: { roadRows: diagnostics.counts?.features ?? 0, units: diagnostics.counts?.eligibleUnits ?? 0,
          corridors: diagnostics.counts?.corridors ?? 0, displayed: diagnostics.counts?.displayed ?? 0,
          repairedCorridors: diagnostics.counts?.repairedCorridors ?? 0,
          unbufferableCorridors: diagnostics.counts?.unbufferableCorridors ?? 0 },
        timing: { partition: diagnostics.partitionTimingMs, roadQueryMs: diagnostics.roadQueryMs,
          unitsMs: diagnostics.unitsMs, segmentationMs: diagnostics.segmentationMs, analysisMs: diagnostics.analysisMs,
          buildMs: diagnostics.buildMs, runTotalMs: diagnostics.totalMs },
        batch: diagnostics.batch?.phaseMs ?? {},
        datasetRows: await (async () => { try { return await scope.datasetRowCounts(); } catch { return null; } })(),
        searchShape: diagnostics.searchShape ?? null,
      };
    }
    // The run stopped. The selection and the load are still measurable, and reporting them is what makes a
    // failure boundary useful instead of just "it did not finish".
    let selection = null;
    let datasetRows = null;
    let loadFailure = null;
    try {
      const scope = await gis.prepareRegionalSearch(searchArea, {});
      selection = { counts: scope.selection.counts, emptyCounts: scope.selection.emptyCounts, bytes: scope.selection.bytes,
        closure: scope.selection.closure, coverage: scope.selection.coverage, timing: scope.timing };
      datasetRows = await scope.datasetRowCounts();
    } catch (error) {
      loadFailure = String(error && error.message ? error.message : error);
    }
    return { scenario: scenario.id, radiusMiles: scenario.radiusMiles, totalMs, heapBytes: heap, status: 'failed',
      failure, loadFailure, selection, datasetRows,
      // The selection figures below come from a preparation that ran after the failure, so its load was warm.
      selectionSource: 're-prepared after the run stopped' };
  }, { scenario });
}

for (const scenario of benchmarks.scenarios) {
  test(`regional benchmark ${scenario.id}`, async ({ page }) => {
    test.setTimeout(1500000);
    const external = [];
    page.on('request', request => { if (EVIDENCE.test(request.url())) external.push(request.url()); });
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.goto('/');
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
    const cold = await measure(page, scenario);
    const warm = cold.failure ? null : await measure(page, scenario);
    const record = { ...cold, warm, externalRequests: external.length, pageErrors: failures };
    results.push(record);
    console.log('REGIONAL_BENCHMARK ' + JSON.stringify(record));
    writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
    expect(external).toEqual([]);
    expect(failures).toEqual([]);
    // A scenario that fails is recorded with its own boundary rather than retried until it looks better.
    if (!cold.failure) expect(cold.status).toBe('ready');
  });
}
