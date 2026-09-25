import { test, expect } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`sample workflow and layout at ${width}px`, async ({ page }) => {
    await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByText('No corridors yet')).toBeVisible();
    await expect(page.locator('#data-context')).toContainText('Published GIS datasets2');
    await page.getByRole('button', { name: /Open sample corridor/ }).click();
    await expect(page.getByRole('heading', { name: 'Sample wetland-edge corridor' })).toBeVisible();
    await expect(page.locator('#candidate-detail')).toContainText('Synthetic UI fixture');
    await expect(page.locator('.ecology-section')).toContainText('Ecoregions unavailable', { timeout: 15000 });
    await expect(page.locator('.ecology-section')).toContainText('Coverage: UNKNOWN');
    await expect(page.locator('#candidate-detail')).toContainText('UNKNOWN');
    await expect(page.locator('#map svg .road')).toHaveCount(1);
    await page.locator('#map svg').hover({ position: { x: 100, y: 100 } });
    await page.mouse.wheel(0, -500);
    await expect(page.locator('#map svg')).not.toHaveAttribute('viewBox', '0 0 1000 700');
    await page.getByRole('button', { name: 'Fit corridor' }).click();
    await expect(page.locator('#map svg')).toHaveAttribute('viewBox', '0 0 1000 700');
    await page.getByRole('button', { name: 'Shortlist' }).click();
    await expect(page.locator('#candidate-detail')).toContainText('shortlisted');
    await page.getByRole('button', { name: 'Reject' }).click();
    await expect(page.locator('#candidate-detail')).toContainText('rejected');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    expect(errors).toEqual([]);
  });
}

test('real DuckDB Spatial resolves two EPA levels and coverage states', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Open sample corridor/ }).click();
  await expect(page.locator('.ecology-section')).toContainText('Coast Range', { timeout: 30000 });
  await expect(page.locator('.ecology-section')).toContainText('Volcanics');
  await expect(page.locator('.ecology-section')).toContainText('Also crosses');
  await expect(page.locator('.ecology-section')).toContainText('Coverage: FULL');
  await page.locator('.ecology-section summary').click();
  await expect(page.locator('.ecology-section')).toContainText('U.S. Environmental Protection Agency');
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const results = await page.evaluate(async () => {
    const { gis } = await import('/src/app/main.js');
    const partial = await gis.getEcoregions({ type: 'LineString', coordinates: [[-122.8, 45.6], [-122.8, 47.0]] });
    const none = await gis.getEcoregions({ type: 'LineString', coordinates: [[-100, 40], [-99.9, 40.1]] });
    const outsideCoverage = await gis.getCoverage('epa-ecoregions-or-l4', { type: 'LineString', coordinates: [[-100, 40], [-99.9, 40.1]] });
    const repeat = await gis.getEcoregions({ type: 'LineString', coordinates: [[-122.876, 45.602], [-122.836, 45.608]] });
    return { partial: partial.coverage, none: none.coverage, outsideCoverage: outsideCoverage.status, repeat: repeat.coverage, diagnostics: gis.diagnostics(), repeatQueryMs: repeat.diagnostics.queryMs };
  });
  expect(results.partial).toBe('PARTIAL');
  expect(results.none).toBe('NONE');
  expect(results.outsideCoverage).toBe('NONE');
  expect(results.repeat).toBe('FULL');
  expect(results.diagnostics.status).toBe('ready');
  expect(results.diagnostics.spatial).toBe('loaded');
  expect(results.diagnostics.firstQueryMs).toBeGreaterThan(0);
  console.log('GIS browser performance:', results);
});
