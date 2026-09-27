import { test, expect } from '@playwright/test';

// The regional path, as the application actually offers it: discovery reads the precomputed derived
// corridor-metrics cells, and the detailed panel measures the raw regional partitions for the promoted
// corridor. Raw regional discovery is kept and checked here too, because tests, debugging and equivalence work
// still need it - but it is never the automatic fallback for a derived failure.

test('regional discovery reads precomputed metrics, and promotion verifies the raw corridor', async ({ page }) => {
  test.slow();
  const outside = [];
  const derivedCells = [];
  const partitions = [];
  const failures = [];
  page.on('request', request => {
    if (/api\.inaturalist|api\.ebird|overpass|api\.roadnaturalist\.com/.test(request.url())) outside.push(request.url());
    if (request.url().includes('/derived/corridor-metrics/')) derivedCells.push(request.url());
    if (request.url().includes('/data/regional/partitions/')) partitions.push(request.url());
  });
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('/');
  await expect(page.locator('#discovery-area')).toBeVisible();
  await page.locator('#discovery-area').selectOption('or-portland-west-regional');
  const started = Date.now();
  await page.locator('#discover-roads').click();
  // The derived layer is the point of this path: the banner names it, the corridor count is the radius
  // selection, and no raw regional partition is touched until a corridor is promoted.
  await expect(page.locator('#discovery')).toContainText('Discovery metrics', { timeout: 120000 });
  await expect(page.locator('#discovery')).toContainText('metric cell(s) selected');
  const elapsedMs = Date.now() - started;
  await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 60000 });
  const count = Number(await page.locator('#discovery-count').innerText());
  expect(count).toBeGreaterThan(100);
  expect(derivedCells.length).toBeGreaterThan(0);
  expect(partitions).toEqual([]);
  expect(outside).toEqual([]);
  expect(failures).toEqual([]);
  const engine = await page.evaluate(async () => (await import('/src/app/main.js')).gis.diagnostics());
  console.log('REGIONAL_DERIVED', JSON.stringify({ elapsedMs, corridorCount: count,
    derivedObjects: derivedCells.length, rawPartitions: partitions.length, engineInitMs: engine.initMs,
    jsHeapBytes: await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null) }));
  const fullRow = page.locator('#discovery-results tbody tr').filter({ has: page.locator('td:nth-child(6):text-is("FULL")') }).first();
  await expect(fullRow).toBeVisible();
  await fullRow.locator('.discovery-row').click();
  const selected = page.locator('#discovery-selected');
  await expect(selected).toContainText('Mapped wetland within 250 m');
  const discoveryArea = await selected.locator('.discovery-facts div', { hasText: 'Mapped wetland within 250 m' }).locator('dd').innerText();
  await page.locator('#discovery-promote').click();
  const habitat = page.locator('.habitat-section');
  await expect(habitat).toContainText('PHYSICAL HABITAT EVIDENCE', { timeout: 180000 });
  // The interface says which claim is on screen: the list is precomputed deterministic metrics, the panel is
  // detailed GIS measured from the raw regional partitions.
  await expect(habitat).toContainText('Detailed GIS', { timeout: 180000 });
  expect(partitions.length).toBeGreaterThan(0);
  if (discoveryArea !== 'Unknown') {
    const wetlandFacts = habitat.locator('.habitat-block').first();
    await expect(wetlandFacts).toContainText('Within 250 m', { timeout: 60000 });
    const detailArea = await wetlandFacts.locator('dl div', { hasText: /^Within 250 m/ }).first().locator('dd').innerText();
    // Promotion reconstructs the corridor from the raw partitions and verifies it before the panel measures it,
    // so the detailed number is the same number the precomputed row showed.
    console.log('REGIONAL_PROMOTION Area', JSON.stringify({ discoveryArea, detailArea }));
    if (discoveryArea !== 'None mapped') expect(detailArea).toContain(discoveryArea);
  }
  await expect(page.locator('#candidate-detail')).toContainText('discovered');
});

test('raw regional discovery is still available on request, and is never the automatic fallback', async ({ page }) => {
  test.slow();
  const partitions = [];
  page.on('request', request => { if (request.url().includes('/data/regional/partitions/')) partitions.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  // A narrow box: raw discovery on the published region really does compose and measure every corridor, and
  // this test is about availability, not about re-recording its cost (npm run benchmark:regional does that).
  const run = await page.evaluate(async () => {
    const { gis } = await import('/src/app/main.js');
    const { runDiscovery } = await import('/src/discovery/run.js');
    const searchArea = { id: 'raw-probe', name: 'Raw availability probe', kind: 'bbox',
      catalogUrl: 'regional/manifest.json', bbox: [-122.90, 45.52, -122.87, 45.55], raw: true };
    const result = await runDiscovery({ gis, searchArea });
    return { status: result.status, derived: Boolean(result.derived), corridors: result.results.length,
      note: result.diagnostics?.note ?? null, coverage: result.coverage?.coverage ?? null };
  });
  expect(run.status).toBe('ready');
  expect(run.derived).toBe(false);
  expect(run.corridors).toBeGreaterThan(0);
  expect(partitions.length).toBeGreaterThan(0);
});


// The two bounded-search *measurement* tests that used to live here (a 5 x 7 km viewport and a 20 x 17 km
// extent) asserted the byte and timing numbers of the first, narrow regional slice. They are superseded by
// the opt-in benchmark harness, which measures the committed 10-, 25- and 50-mile radius scenarios cold and
// warm and reports every phase: `npm run benchmark:regional`. Keep functional regional coverage here and
// keep scale numbers there, so this suite never silently re-encodes a performance claim.

test('a missing derived cell fails explicitly and never silently re-runs the raw regional survey', async ({ page }) => {
  const partitions = [];
  page.on('request', request => { if (request.url().includes('/data/regional/partitions/')) partitions.push(request.url()); });
  await page.route('**/data/derived/corridor-metrics/**/cells/*.parquet', route => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto('/');
  await page.locator('#discovery-area').selectOption('or-portland-west-regional');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery')).toContainText('Discovery coverage UNKNOWN', { timeout: 60000 });
  await expect(page.locator('#discovery')).toContainText('HTTP 404');
  await expect(page.locator('#discovery-count')).toHaveText('0');
  expect(partitions).toEqual([]);
});

test('a missing raw habitat partition aborts a raw regional survey with UNKNOWN coverage', async ({ page }) => {
  await page.route('**/data/regional/partitions/**/wetlands/*.parquet', route => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto('/');
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  const run = await page.evaluate(async () => {
    const { gis } = await import('/src/app/main.js');
    const { runDiscovery } = await import('/src/discovery/run.js');
    const searchArea = { id: 'raw-missing-partition', name: 'Raw missing partition probe', kind: 'bbox',
      catalogUrl: 'regional/manifest.json', bbox: [-122.90, 45.52, -122.87, 45.55], raw: true };
    try {
      const result = await runDiscovery({ gis, searchArea });
      return { status: result.status, coverage: result.coverage?.coverage ?? null, corridors: result.results.length,
        reasons: result.diagnostics?.datasetErrors ?? [] };
    } catch (error) {
      return { status: 'unavailable', coverage: 'UNKNOWN', corridors: 0, reasons: [error.message] };
    }
  });
  expect(run.status).toBe('unavailable');
  expect(run.coverage).toBe('UNKNOWN');
  expect(run.corridors).toBe(0);
  expect(run.reasons.join(' ')).toMatch(/404/);
});
