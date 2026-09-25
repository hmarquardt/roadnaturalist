import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const inatFixture = JSON.parse(readFileSync(new URL('./fixtures/inaturalist-observations.json', import.meta.url)));

// Deterministic stand-in for api.inaturalist.org: identical request construction to production (the app
// really calls fetch), but answered from the captured fixture so browser tests never depend on a live
// public API. Counts are returned for per_page=0 and record pages for the real record requests.
const SMALL_REGION_SWLAT = '45.5218';
async function stubInaturalist(page, { records = inatFixture.records, regionTotal = 5000, smallRegionTotal = 240, temporalTotal = 120 } = {}) {
  await page.route('https://api.inaturalist.org/**', async route => {
    const url = new URL(route.request().url());
    const perPage = Number(url.searchParams.get('per_page'));
    if (perPage === 0) {
      const total = url.searchParams.get('d1') ? temporalTotal : url.searchParams.get('swlat') === SMALL_REGION_SWLAT ? smallRegionTotal : regionTotal;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total_results: total, results: [] }) });
    }
    const slice = url.searchParams.get('swlat') === SMALL_REGION_SWLAT ? records.slice(0, 8) : records;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total_results: regionTotal, page: 1, per_page: perPage, results: slice }) });
  });
}

test('occurrence evidence loads lazily, stays privacy-safe, and separates its sources', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  const externalCalls = [];
  page.on('request', request => { if (request.url().includes('api.inaturalist.org') || request.url().includes('api.ebird.org')) externalCalls.push(request.url()); });
  await stubInaturalist(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Open Oregon road pilot/ }).click();
  const detail = page.locator('#candidate-detail');
  await expect(detail).toContainText('NW Cornelius Pass Rd', { timeout: 60000 });
  const occurrence = page.locator('.occurrence-section');
  await expect(occurrence).toContainText('SPECIES OCCURRENCE EVIDENCE');
  await expect(occurrence).toContainText('Query the public occurrence sources');
  await expect(occurrence).toContainText('never wait on an external service');
  // Lazy: nothing external was requested just by loading the pilot, and the other panels already work.
  expect(externalCalls).toEqual([]);
  await expect(page.locator('.habitat-section')).toContainText('PHYSICAL HABITAT EVIDENCE');
  await expect(page.locator('.ecology-section')).toContainText('Willamette Valley');

  await occurrence.getByRole('button', { name: 'Query public occurrence sources' }).click();
  await expect(occurrence).toContainText('iNaturalist', { timeout: 60000 });
  await expect(occurrence).toContainText('Reported in region');
  await expect(occurrence).toContainText('source-reported');
  await expect(occurrence).toContainText('Retrieved in detail');
  await expect(occurrence).toContainText('most recent first');
  await expect(occurrence).toContainText('Regional/obscured');
  await expect(occurrence).toContainText('CoveragePARTIAL');
  await expect(occurrence).toContainText('at least, from retrieved records');
  // eBird has no browser credential: UNKNOWN with a reason, never a zero result.
  await expect(occurrence).toContainText('eBird');
  await expect(occurrence).toContainText('personal API key');
  await expect(occurrence).toContainText('not evidence that no species were reported');
  // The interpretation refuses prediction language.
  await expect(occurrence).toContainText('not a prediction that a species is on this road');
  await expect(occurrence).not.toContainText('likely');

  // Taxa detail with lenses, and no obscured coordinate anywhere in the rendered panel.
  const taxa = occurrence.locator('.occurrence-taxa');
  await taxa.locator('summary').first().click();
  await expect(taxa.locator('.taxon-row')).not.toHaveCount(0);
  await expect(taxa).toContainText('observation');
  const obscured = inatFixture.records.filter(record => record.obscured || record.geoprivacy === 'obscured' || record.taxon_geoprivacy === 'obscured');
  const panelText = await occurrence.innerText();
  for (const record of obscured) {
    const [lon, lat] = record.geojson.coordinates;
    expect(panelText.includes(String(lon))).toBe(false);
    expect(panelText.includes(String(lat))).toBe(false);
  }
  await taxa.getByRole('button', { name: 'Birds' }).click();
  await expect(taxa.locator('.lens-button[aria-pressed="true"]')).toHaveText('Birds');

  // Coverage panel keeps source detail.
  const context = page.locator('#data-context');
  await expect(context).toContainText('Occurrence — iNaturalistPARTIAL');
  await expect(context).toContainText('Occurrence — eBirdUNKNOWN');
  await expect(context).toContainText('OccurrencePARTIAL');
});

test('an unavailable occurrence source never blocks the rest of the panel and never reads as zero', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 900 });
  await page.route('https://api.inaturalist.org/**', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: /Open Oregon road pilot/ }).click();
  const detail = page.locator('#candidate-detail');
  await expect(detail).toContainText('NW Cornelius Pass Rd', { timeout: 60000 });
  // Road, ecology, and habitat evidence are unaffected while occurrence sources are unreachable.
  await expect(page.locator('.habitat-section')).toContainText('PHYSICAL HABITAT EVIDENCE');
  await expect(page.locator('.ecology-section')).toContainText('Willamette Valley');
  await expect(detail).toContainText('U.S. Census Bureau TIGER/Line 2025 ROADS');
  const occurrence = page.locator('.occurrence-section');
  await occurrence.getByRole('button', { name: 'Query public occurrence sources' }).click();
  await expect(occurrence).toContainText('Coverage UNKNOWN', { timeout: 60000 });
  await expect(occurrence).toContainText('not evidence that no species were reported');
  await expect(occurrence).not.toContainText('0 observations');
  const context = page.locator('#data-context');
  await expect(context).toContainText('Occurrence — iNaturalistUNKNOWN');
  await expect(context).toContainText('OccurrenceUNKNOWN');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});

test('only precise public observations reach the map, and distances are real projected measurements', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await stubInaturalist(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Open Oregon road pilot/ }).click();
  await expect(page.locator('#candidate-detail')).toContainText('NW Cornelius Pass Rd', { timeout: 60000 });
  await page.locator('.occurrence-section').getByRole('button', { name: 'Query public occurrence sources' }).click();
  await expect(page.locator('.occurrence-section')).toContainText('CoveragePARTIAL', { timeout: 60000 });
  await expect(page.locator('#map svg .occurrence-point')).toHaveCount(0);
  await page.locator('#occurrence-layer').check();
  const points = page.locator('#map svg .occurrence-point');
  await expect(points.first()).toBeVisible();
  const drawn = await points.count();
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThanOrEqual(300);
  // Every plotted point is a precise public observation, and no obscured coordinate is plotted.
  const plotted = await page.evaluate(() => [...document.querySelectorAll('#map svg .occurrence-point title')].map(node => node.textContent));
  const obscuredCoordinates = inatFixture.records
    .filter(record => record.obscured || record.geoprivacy === 'obscured' || record.taxon_geoprivacy === 'obscured')
    .map(record => `${Math.round(record.geojson.coordinates[0] * 10000) / 10000}`);
  expect(plotted.length).toBe(drawn);
  expect(obscuredCoordinates.some(value => plotted.join(' ').includes(value))).toBe(false);
  await page.locator('#occurrence-layer').uncheck();
  await expect(page.locator('#map svg .occurrence-point')).toHaveCount(0);

  // Known-geometry measurement: a point due north of a straight corridor is measured in EPSG:5070.
  const measured = await page.evaluate(async () => {
    const { gis } = await import('/src/app/main.js');
    const corridor = { type: 'LineString', coordinates: [[-123.05, 45.55], [-122.95, 45.55]] };
    const metresPerDegreeLatitude = 111132;
    const expectedM = 250;
    const point = [-123.0, 45.55 + expectedM / metresPerDegreeLatitude];
    const result = await gis.measureOccurrenceDistances(corridor, [{ id: 'inaturalist:fixture', coordinates: point }]);
    return { expectedM, distanceM: result.distances.get('inaturalist:fixture'), crs: result.crs, measured: result.measured };
  });
  expect(measured.measured).toBe(1);
  expect(measured.crs).toBe('EPSG:5070');
  expect(Math.abs(measured.distanceM - measured.expectedM) / measured.expectedM).toBeLessThan(0.02);
  expect(measured.distanceM).toBeGreaterThan(200);
  expect(measured.distanceM).toBeLessThan(300);
});
