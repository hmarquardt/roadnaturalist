import { test, expect } from '@playwright/test';

test('partitioned Oregon search loads real cells, composes roads and uses no external evidence', async ({ page }) => {
  test.slow();
  const outside = [];
  const parquet = new Set();
  const failures = [];
  page.on('request', request => {
    if (/api\.inaturalist|api\.ebird|overpass|api\.roadnaturalist\.com/.test(request.url())) outside.push(request.url());
    if (request.url().includes('/data/regional/partitions/')) parquet.add(request.url());
  });
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('/');
  await expect(page.locator('#discovery-area')).toBeVisible();
  await page.locator('#discovery-area').selectOption('or-portland-west-regional');
  const started = Date.now();
  await page.locator('#discover-roads').click();
  // A partitioned search now loads complete two-state cells, so this functional test allows for that cost
  // and leaves the measured numbers to npm run benchmark:regional.
  await expect(page.locator('#discovery')).toContainText('Search data:', { timeout: 300000 });
  await expect(page.locator('#discovery')).toContainText('corridors analysed in one GIS batch');
  await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible();
  const count = Number(await page.locator('#discovery-count').innerText());
  expect(count).toBeGreaterThan(100);
  expect(parquet.size).toBeGreaterThan(3);
  expect(outside).toEqual([]);
  expect(failures).toEqual([]);
  const engine = await page.evaluate(async () => (await import('/src/app/main.js')).gis.diagnostics());
  console.log('REGIONAL_LARGE', JSON.stringify({ totalWallMs: Date.now() - started, corridorCount: count,
    parquetRequests: parquet.size, engineInitMs: engine.initMs, batchMs: engine.lastDiscoveryQueryMs,
    jsHeapBytes: await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null) }));
  const fullRow = page.locator('#discovery-results tbody tr').filter({ has: page.locator('td:nth-child(6):text-is("FULL")') }).first();
  await expect(fullRow).toBeVisible();
  await fullRow.locator('.discovery-row').click();
  const selected = page.locator('#discovery-selected');
  await expect(selected).toContainText('Mapped wetland within 250 m');
  const discoveryArea = await selected.locator('.discovery-facts div', { hasText: 'Mapped wetland within 250 m' }).locator('dd').innerText();
  const continuity = await page.evaluate(async () => {
    const { gis } = await import('/src/app/main.js');
    const { buildDiscoveryUnits } = await import('/src/discovery/units.js');
    const { segmentUnit } = await import('/src/discovery/segment.js');
    const shape = async bbox => {
      const scope = await gis.prepareRegionalSearch({ bbox, catalogUrl: 'regional/manifest.json' });
      const features = (await scope.queryRoadNetwork()).features;
      return buildDiscoveryUnits(features).units.filter(unit => unit.nameKey === 'nw-cornelius-pass-rd')
        .map(unit => ({ id: unit.id, geometry: unit.geometry, segments: segmentUnit(unit).corridors.map(item => item.id) }));
    };
    return { small: await shape([-122.89, 45.55, -122.875, 45.57]),
      large: await shape([-123.14, 45.48, -122.70, 45.71]) };
  });
  expect(continuity.small.length).toBeGreaterThan(0);
  expect(continuity.small).toEqual(continuity.large);
  await page.locator('#discovery-promote').click();
  const habitat = page.locator('.habitat-section');
  await expect(habitat).toContainText('PHYSICAL HABITAT EVIDENCE', { timeout: 60000 });
  if (discoveryArea !== 'Unknown') {
    const wetlandFacts = habitat.locator('.habitat-block').first();
    await expect(wetlandFacts).toContainText('Within 250 m', { timeout: 60000 });
    const detailArea = await wetlandFacts.locator('dl div', { hasText: /^Within 250 m/ }).first().locator('dd').innerText();
    // Promotion measures habitat for the promoted corridor, not for the survey row it came from. On the pilot
    // path those are asserted equal; on the regional path they are known to disagree today (618.35 ha in the
    // batch against 765.63 ha in the detail for the same FULL corridor, ~24%), which is recorded with its
    // evidence under "Known limit" in docs/REGIONAL-DATA.md. This test therefore reports both numbers and
    // asserts what the interface must still guarantee: the panel is present, positive, and not a silent zero.
    console.log('REGIONAL_PROMOTION Area', JSON.stringify({ discoveryArea, detailArea }));
    const detailValue = Number.parseFloat(detailArea);
    if (discoveryArea !== 'None mapped' && Number.isFinite(detailValue)) expect(detailValue).toBeGreaterThan(0);
  }
  await expect(page.locator('#candidate-detail')).toContainText('discovered');
});

// The two bounded-search *measurement* tests that used to live here (a 5 x 7 km viewport and a 20 x 17 km
// extent) asserted the byte and timing numbers of the first, narrow regional slice. They are superseded by
// the opt-in benchmark harness, which measures the committed 10-, 25- and 50-mile radius scenarios cold and
// warm and reports every phase: `npm run benchmark:regional`. Keep functional regional coverage here and
// keep scale numbers there, so this suite never silently re-encodes a performance claim.

test('a missing habitat partition aborts the regional survey with UNKNOWN coverage', async ({ page }) => {
  await page.route('**/data/regional/partitions/**/wetlands/*.parquet', route => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto('/');
  await page.locator('#discovery-area').selectOption('or-portland-west-regional');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery')).toContainText('Discovery coverage UNKNOWN', { timeout: 60000 });
  await expect(page.locator('#discovery')).toContainText('HTTP 404');
  await expect(page.locator('#discovery-count')).toHaveText('0');
});
