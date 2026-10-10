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
const ALL_CENTERS = [
  { id: 'pnw', center: [-122.92, 45.595] },
  { id: 'northeast', center: [-71.06, 42.36] },
  { id: 'gulf', center: [-90.07, 29.95] },
  { id: 'midwest', center: [-87.63, 41.88] },
  { id: 'plains', center: [-96.68, 40.81] },
  { id: 'southwest', center: [-112.07, 33.45] },
];
// `NATIONAL_CENTERS=pnw,gulf` narrows the check, so a region that is already published can be proven in a
// browser before the whole plane is.
const only = (process.env.NATIONAL_CENTERS ?? '').split(',').filter(Boolean);
const CENTERS = only.length ? ALL_CENTERS.filter(entry => only.includes(entry.id)) : ALL_CENTERS;
const DATA_ORIGIN = 'data.roadnaturalist.com';
// The runtime's own declared dependencies: DuckDB-WASM from jsDelivr and its spatial/parquet extensions from the
// DuckDB CDN. Anything else - an occurrence API, Overpass, the Investigator Worker, a tile server - is external.
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', DATA_ORIGIN, 'cdn.jsdelivr.net', 'extensions.duckdb.org',
  'roadnaturalist.com', 'www.roadnaturalist.com', 'roadnaturalist.pages.dev']);
// With no PRODUCTION_BASE_URL this runs against the local test server; with one it runs against the deployed
// site, which is how the cutover is proven end to end after the Pages release.
const BASE = process.env.PRODUCTION_BASE_URL ?? null;

test.skip(!process.env.RUN_NATIONAL_PRODUCTION,
  'Opt-in: the national production check reads the published R2 plane from a real browser');

test('national discovery serves six regions from the published derived plane', async ({ page }) => {
  test.setTimeout(1800000);
  const external = [];
  const failures = [];
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  page.on('pageerror', error => failures.push(error.message));
  // Discovery is the derived plane and nothing else. A raw road, wetland or hydrography cell fetched during a
  // search would mean discovery had started depending on the deep-inspection data, which is exactly what the
  // bounded publications exist to prevent - so the check is not that discovery was fast, it is that it never asked.
  const rawDuringDiscovery = [];
  page.on('request', request => {
    const url = request.url();
    if (url.startsWith('blob:')) return; // the DuckDB worker's own script, same origin
    if (/\/national\/(roads|wetlands|hydro)\//.test(new URL(url).pathname)) rawDuringDiscovery.push(url);
    if (!ALLOWED_HOSTS.has(new URL(url).hostname)) external.push(url);
  });
  await page.goto(BASE ? `${BASE}/` : '/', { waitUntil: 'domcontentloaded' });
  const report = [];
  for (const entry of CENTERS) {
    const outcome = await page.evaluate(async ({ center, radiusMiles }) => {
      const { createGisService } = await import('./src/gis/service.js');
      const { runDiscovery } = await import('./src/discovery/run.js');
      const { radiusBounds } = await import('./src/discovery/search-area.js');
      // Build the search exactly as the workspace does: take the *deployed* interactive template and replace only
      // the centre and radius. Nothing about which catalog a national search loads is restated here, so a
      // deployment whose declaration is wrong fails this check rather than a hand-written copy of it.
      const declaration = await (await fetch('./data/discovery/search-areas.json')).json();
      const template = (declaration.searchAreas ?? []).find(area => area.id === declaration.interactiveRadiusArea);
      if (!template) throw new Error('the deployed declaration names no interactive radius template');
      if (template.catalogType !== 'national') {
        throw new Error(`the interactive template loads a ${template.catalogType} catalog, not the national one`);
      }
      const gis = createGisService({});
      const searchArea = { ...template, id: 'national-smoke', name: 'National smoke test', kind: 'radius',
        center, radiusMiles, bbox: radiusBounds(center, radiusMiles) };
      const run = await runDiscovery({ gis, searchArea });
      const sample = run.results.slice(0, 3).map(result => ({ id: result.id, name: result.name,
        lengthM: Math.round(result.lengthM), geometry: result.geometry?.type ?? null,
        ecology: result.ecology?.ecoregionCount ?? null,
        ecologyLevel: result.ecology?.level3?.primary
          ? `${result.ecology.level3.primary.name} (${result.ecology.level3.primary.code})` : null,
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
  expect(rawDuringDiscovery, 'discovery reads the derived plane and never a raw road, wetland or hydrography cell').toEqual([]);
  expect(failures, 'the page must log no error').toEqual([]);
});
