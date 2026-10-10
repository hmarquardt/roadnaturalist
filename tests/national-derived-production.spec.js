import { test, expect } from '@playwright/test';

// Opt-in browser verification of national discovery against the *published* R2 plane.
//
//   RUN_NATIONAL_PRODUCTION=1 npx playwright test tests/national-derived-production.spec.js --reporter=line --retries=0
//   PRODUCTION_BASE_URL=https://roadnaturalist.com RUN_NATIONAL_PRODUCTION=1 npx playwright test tests/national-derived-production.spec.js
//
// It runs in a real browser the exact modules production runs, against the exact objects production reads.
// For a 25-mile search at a centre in each of six regions it lets the runtime load the national catalog, fetch
// the manifest and the selected cells from R2, register them in DuckDB-WASM, measure, and report corridors. It
// asserts corridors come back, that road geometry is present, that ecology/wetland/hydrography facts populate,
// that the only data host contacted is data.roadnaturalist.com, and that the page logs no error.
//
// It uses the runtime modules directly rather than the workspace DOM: that is where CORS, object paths, schema
// and the analysis gate actually live, and it keeps the check stable while the interface changes.
const CENTERS = [
  { id: 'pnw', center: [-122.92, 45.595] },
  { id: 'northeast', center: [-71.06, 42.36] },
  { id: 'gulf', center: [-90.07, 29.95] },
  { id: 'midwest', center: [-87.63, 41.88] },
  { id: 'plains', center: [-96.68, 40.81] },
  { id: 'southwest', center: [-112.07, 33.45] },
];
const DATA_ORIGIN = 'data.roadnaturalist.com';

test.skip(!process.env.RUN_NATIONAL_PRODUCTION,
  'Opt-in: the national production check reads the published R2 plane from a real browser');

test('national discovery serves six regions from the published derived plane', async ({ page }) => {
  test.setTimeout(1800000);
  const external = [];
  const failures = [];
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => {
    const host = new URL(request.url()).hostname;
    if (!['127.0.0.1', 'localhost', DATA_ORIGIN, 'cdn.jsdelivr.net'].includes(host)) external.push(request.url());
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const report = [];
  for (const entry of CENTERS) {
    const outcome = await page.evaluate(async ({ center, radiusMiles }) => {
      const { createGisService } = await import('./src/gis/service.js');
      const { runDiscovery } = await import('./src/discovery/run.js');
      const { radiusBounds } = await import('./src/discovery/search-area.js');
      const gis = createGisService({});
      const searchArea = { id: 'national-smoke', kind: 'radius', name: 'National smoke test',
        catalogUrl: 'national/derived-catalog.json', derivedOnly: true, center,
        radiusMiles, bbox: radiusBounds(center, radiusMiles) };
      const run = await runDiscovery({ gis, searchArea });
      const sample = run.results.slice(0, 3).map(result => ({ id: result.id, name: result.name,
        lengthM: Math.round(result.lengthM), geometry: result.geometry?.type ?? null,
        ecology: result.ecology?.ecoregionCount ?? null,
        ecologyLevel: result.ecology?.level3?.name ?? result.ecology?.level3?.code ?? null,
        wetland250: result.signals?.wetlands?.area250M2 ?? null,
        wetlandNearest: result.signals?.wetlands?.nearestM ?? null,
        hydro: result.signals?.hydrography?.crossingCount ?? null }));
      const derived = run.diagnostics?.derivedSelection ?? {};
      const problems = [];
      if (run.status !== 'ready') problems.push(`status ${run.status}`);
      if (!run.results.length) problems.push('no corridors returned');
      if (!sample.some(item => item.geometry)) problems.push('no road geometry');
      if (!sample.some(item => item.ecologyLevel != null)) problems.push('no ecology');
      if (!sample.some(item => item.wetland250 != null)) problems.push('no wetland metrics');
      if (!sample.some(item => item.hydro != null)) problems.push('no hydro metrics');
      return { center, coverage: run.coverage?.coverage ?? null, fingerprint: run.diagnostics?.analysisFingerprint ?? null,
        cells: derived.cells ?? null, bytes: derived.bytes ?? 0, corridors: run.results.length,
        datasetErrors: run.diagnostics?.datasetErrors ?? [], sample, problems };
    }, { center: entry.center, radiusMiles: 25 });
    report.push({ id: entry.id, ...outcome });
    console.log(`NATIONAL_SMOKE ${JSON.stringify({ id: entry.id, coverage: outcome.coverage, corridors: outcome.corridors,
      cells: outcome.cells, bytes: outcome.bytes, problems: outcome.problems, sample: outcome.sample })}`);
    expect(outcome.fingerprint, `${entry.id}: the national plane must carry the catalog fingerprint`)
      .toBe('a13a883c16f6d6e897407eab0de325ea355f5edeb292ecfb36b092f9ea959ee9');
    expect(outcome.problems, `${entry.id}: national discovery must serve this region`).toEqual([]);
  }
  expect(report.every(entry => entry.coverage === 'FULL'), 'every centre is inside the national region').toBe(true);
  expect(external, 'a search must reach no host but the data origin').toEqual([]);
  expect(failures, 'the page must log no error').toEqual([]);
});
