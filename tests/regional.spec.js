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
  await expect(page.locator('#discovery')).toContainText('Search data:', { timeout: 110000 });
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
    if (discoveryArea !== 'None mapped') expect(detailArea).toContain(discoveryArea);
  }
  await expect(page.locator('#candidate-detail')).toContainText('discovered');
});

test('small bounded search selects fewer cells and remains a deterministic browser run', async ({ page }) => {
  test.slow();
  await page.goto('/');
  const measurement = await page.evaluate(async () => {
    const { gis } = await import('/src/app/main.js');
    const { runDiscovery } = await import('/src/discovery/run.js');
    const searchArea = { id: 'performance-small', name: 'Small west Portland viewport',
      catalogUrl: 'regional/manifest.json', bbox: [-123.10, 45.51, -123.03, 45.57] };
    const started = performance.now();
    const run = await runDiscovery({ gis, searchArea });
    return { status: run.status, coverage: run.coverage.coverage, totalMs: Math.round(performance.now() - started),
      diagnostics: run.diagnostics, count: run.results.length, engine: gis.diagnostics(),
      jsHeapBytes: performance.memory?.usedJSHeapSize ?? null };
  });
  console.log('REGIONAL_SMALL', JSON.stringify({ totalMs: measurement.totalMs, corridors: measurement.count,
    selection: measurement.diagnostics.partitionSelection?.counts, bytes: measurement.diagnostics.partitionSelection?.bytes,
    preparation: measurement.diagnostics.partitionTimingMs, phases: measurement.diagnostics.batch?.phaseMs, engineInitMs: measurement.engine.initMs,
    jsHeapBytes: measurement.jsHeapBytes }));
  expect(measurement.status).toBe('ready');
  expect(measurement.count).toBeGreaterThan(0);
  expect(measurement.diagnostics.partitionSelection.bytes).toBeLessThan(25_000_000);
});

test('medium bounded search measures the browser mode before 50-mile scale', async ({ page }) => {
  test.slow();
  await page.goto('/');
  const measurement = await page.evaluate(async () => {
    const { gis } = await import('/src/app/main.js');
    const { runDiscovery } = await import('/src/discovery/run.js');
    const started = performance.now();
    const run = await runDiscovery({ gis, searchArea: { id: 'performance-medium', name: 'Medium west Portland extent',
      catalogUrl: 'regional/manifest.json', bbox: [-123.12, 45.50, -122.86, 45.65] } });
    return { status: run.status, count: run.results.length, ms: Math.round(performance.now() - started),
      selection: run.diagnostics.partitionSelection, preparation: run.diagnostics.partitionTimingMs,
      phases: run.diagnostics.batch?.phaseMs,
      initMs: gis.diagnostics().initMs, jsHeapBytes: performance.memory?.usedJSHeapSize ?? null };
  });
  console.log('REGIONAL_MEDIUM', JSON.stringify({ totalMs: measurement.ms, corridors: measurement.count,
    selection: measurement.selection?.counts, bytes: measurement.selection?.bytes,
    preparation: measurement.preparation, phases: measurement.phases, engineInitMs: measurement.initMs, jsHeapBytes: measurement.jsHeapBytes }));
  expect(measurement.status).toBe('ready');
  expect(measurement.count).toBeGreaterThan(50);
  expect(measurement.selection.bytes).toBeLessThan(25_000_000);
});

test('a missing habitat partition aborts the regional survey with UNKNOWN coverage', async ({ page }) => {
  await page.route('**/data/regional/partitions/**/wetlands/*.parquet', route => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto('/');
  await page.locator('#discovery-area').selectOption('or-portland-west-regional');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery')).toContainText('Discovery coverage UNKNOWN', { timeout: 60000 });
  await expect(page.locator('#discovery')).toContainText('HTTP 404');
  await expect(page.locator('#discovery-count')).toHaveText('0');
});
