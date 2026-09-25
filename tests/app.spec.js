import { test, expect } from '@playwright/test';

// Offline layout and honest degraded-state coverage. DuckDB-WASM is blocked, so the road dataset
// cannot be read: the UI must report UNKNOWN road-geometry coverage instead of pretending that
// no roads exist, and the layout must stay healthy at desktop and mobile widths.
for (const width of [1440, 390]) {
  test(`road pilot degraded state and layout at ${width}px`, async ({ page }) => {
    await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('#candidate-list')).toContainText('No corridor loaded');
    await expect(page.locator('#map')).toContainText('No corridor loaded');
    await expect(page.locator('#data-context')).toContainText('Published GIS datasets3');
    await expect(page.locator('#data-context')).toContainText('WetlandsUNKNOWN');
    await page.getByRole('button', { name: /Open Oregon road pilot/ }).click();
    await expect(page.locator('#candidate-list')).toContainText('Road geometry could not be loaded');
    await expect(page.locator('#candidate-list')).toContainText('not evidence that no roads exist');
    await expect(page.locator('#data-context')).toContainText('Road geometry is UNKNOWN because the road dataset query failed');
    await expect(page.locator('#candidate-list')).not.toContainText('No corridor loaded');
    await expect(page.locator('#data-context')).toContainText('DuckDB Spatial initialization failed');
    await expect(page.locator('#map svg .road')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(errors).toEqual([]);
  });
}

test('real Oregon road pilot resolves through DuckDB Spatial into EPA ecology', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto('/');
  await page.getByRole('button', { name: /Open Oregon road pilot/ }).click();
  const list = page.locator('#candidate-list');
  const detail = page.locator('#candidate-detail');
  await expect(list).toContainText('NW Cornelius Pass Rd', { timeout: 60000 });
  await expect(list).toContainText('NW Springville Rd');
  await expect(list).toContainText('NW Susbauer Rd');
  await expect(list).not.toContainText('Road geometry could not be loaded');
  await expect(detail).toContainText('10.5 mi');
  await expect(detail).toContainText('Local road (S1400)');
  await expect(detail).toContainText('U.S. Census Bureau TIGER/Line 2025 ROADS');
  await expect(detail).toContainText('Not provided by this source');
  await expect(detail).toContainText('ACCESS UNVERIFIED');
  await expect(detail).toContainText('not evidence of legal public access');
  await expect(detail).toContainText('GEOMETRY VERIFIED');
  await expect(detail).toContainText('1 reversed duplicate link(s) collapsed');
  const ecology = page.locator('.ecology-section');
  await expect(ecology).toContainText('Willamette Valley (3)', { timeout: 30000 });
  await expect(ecology).toContainText('Also crosses Coast Range');
  await expect(ecology).toContainText('Prairie Terraces (3c)');
  await expect(ecology).toContainText('Coverage: FULL');
  await ecology.locator('summary').click();
  await expect(ecology).toContainText('U.S. Environmental Protection Agency');
  const context = page.locator('#data-context');
  await expect(context).toContainText('Road geometryFULL');
  await expect(context).toContainText('EPA Level IIIFULL');
  await expect(context).toContainText('EPA Level IVFULL');
  await expect(context).toContainText('WetlandsUNKNOWN');
  await expect(context).toContainText('Access verificationNONE');
  await expect(page.locator('#map svg .road')).toHaveCount(1);
  await expect(page.locator('#map svg .road-faint')).toHaveCount(2);
  await expect(page.locator('#map svg .map-badge')).toContainText('TIGER2025 · GEOMETRY VERIFIED · ACCESS UNVERIFIED');
  await expect(page.locator('#map-caption')).toContainText('U.S. Census Bureau TIGER/Line 2025');
  await page.locator('#map svg').hover({ position: { x: 100, y: 100 } });
  await page.mouse.wheel(0, -500);
  await expect(page.locator('#map svg')).not.toHaveAttribute('viewBox', '0 0 1000 700');
  await page.getByRole('button', { name: 'Fit corridor' }).click();
  await expect(page.locator('#map svg')).toHaveAttribute('viewBox', '0 0 1000 700');
  await list.getByRole('button', { name: /NW Springville Rd/ }).click();
  await expect(page.locator('#map svg .road')).toHaveCount(1);
  await expect(page.locator('#map svg .road-faint')).toHaveCount(2);
  await expect(detail).toContainText('GEOMETRY PARTIAL');
  await expect(detail).toContainText('unresolved gap between parts — kept visible, not bridged');
  await expect(page.locator('#map-caption')).toContainText('246 m source gap shown, not bridged');
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(detail).toContainText('rejected');
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const api = await page.evaluate(async () => {
    const { gis } = await import('/src/app/main.js');
    const road = await gis.queryRoads({ roadIds: ['tiger-2025-or-41067-nw-susbauer-rd'] });
    const missing = await gis.queryRoads({ roadIds: ['tiger-2025-or-99999-not-a-road'] });
    const springville = await gis.queryRoads({ roadIds: ['tiger-2025-or-41051-nw-springville-rd'] });
    const ecology = await gis.getEcoregions({ type: 'MultiLineString', coordinates: springville.features.map(row => row.geometry.coordinates) });
    return { road: { coverage: road.coverage, features: road.features.length, bytes: road.diagnostics.datasetBytes, queryMs: road.diagnostics.queryMs },
      missing: { coverage: missing.coverage, missing: missing.missingRoadIds, note: missing.note },
      ecology: { coverage: ecology.coverage, l3: ecology.level3.primary, l4: ecology.level4.primary, spansMultiple: ecology.spansMultiple, queryMs: ecology.diagnostics.queryMs },
      diagnostics: gis.diagnostics() };
  });
  expect(api.road.coverage).toBe('FULL');
  expect(api.road.features).toBe(1);
  expect(api.road.bytes).toBe(28918);
  expect(api.missing.coverage).toBe('NONE');
  expect(api.missing.missing).toEqual(['tiger-2025-or-99999-not-a-road']);
  expect(api.missing.note).toContain('not evidence about the road network on the ground');
  expect(api.ecology.coverage).toBe('FULL');
  expect(api.ecology.l3.name).toBe('Willamette Valley');
  expect(api.ecology.spansMultiple).toBe(true);
  expect(api.diagnostics.status).toBe('ready');
  expect(api.diagnostics.spatial).toBe('loaded');
  expect(api.diagnostics.datasets).toContain('or-roads-pilot');
  expect(api.diagnostics.roadDatasetBytes).toBe(28918);
  console.log('Road pilot GIS performance:', api);
});
