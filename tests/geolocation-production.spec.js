import { test, expect } from '@playwright/test';

// Opt-in verification of the *deployed* location-as-centre path, and of the deployed candidate lifecycle, in a
// real browser.
//
//   RUN_GEOLOCATION_PRODUCTION=1 npm run verify:geolocation:production
//   PRODUCTION_BASE_URL=https://roadnaturalist.pages.dev RUN_GEOLOCATION_PRODUCTION=1 npx playwright test tests/geolocation-production.spec.js
//
// It walks the whole promise end to end against the release: a browser fix becomes the ordinary search centre at
// the radius already chosen, the search is the published derived search, the promoted corridor is kept on the
// device, a reload restores it with no location request and no R2 read, removal is durable, and the deployed app
// reaches no external evidence source or geocoder at any point.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
// Hillsboro's Census interior point: inside the published region, and the nearest published place to itself.
const FIX = { latitude: 45.5229, longitude: -122.9898, accuracy: 120 };
const EVIDENCE = /api\.inaturalist|api\.ebird|overpass|api\.roadnaturalist\.com|nominatim|geocod|maps\.googleapis|api\.mapbox/i;

function log(label, value) { console.log(`GEOLOCATION_PRODUCTION ${JSON.stringify({ [label]: value })}`); }

// Playwright's own geolocation, granted to the context: the same API path a person's browser takes.
async function grantedLocation(page, context) {
  await context.grantPermissions(['geolocation'], { origin: BASE });
  await context.setGeolocation(FIX);
}

async function boot(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
}

test.skip(!process.env.RUN_GEOLOCATION_PRODUCTION, 'The deployed geolocation check is opt-in: it drives a real browser location in production');

test('a deployed location fix becomes a search centre, a candidate, a durable record and a removal', async ({ page, context }) => {
  test.slow();
  page.setDefaultTimeout(180000);
  const outside = [];
  page.on('request', request => { if (EVIDENCE.test(request.url()) && !request.url().startsWith(BASE)) outside.push(request.url()); });
  const partitions = [];
  const derived = [];
  page.on('request', request => {
    if (request.url().includes('/regional/partitions/')) partitions.push(request.url());
    if (request.url().includes('/derived/corridor-metrics/')) derived.push(request.url());
  });
  await grantedLocation(page, context);
  await boot(page);

  // 1. THE FIX IS A CENTRE. The radius is chosen first, so a change to it would be visible.
  await page.locator('#discovery-radius-input').fill('10');
  await page.locator('#discovery-radius-input').press('Enter');
  await expect(page.locator('#discovery-radius-value')).toHaveText('10 mi');
  await page.locator('#discovery-use-location').click();
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5229');
  await expect(page.locator('#discovery-center-lon')).toHaveValue('-122.9898');
  await expect(page.locator('#discovery-radius-value')).toHaveText('10 mi');
  await expect(page.locator('#discovery-center-label')).toContainText('Near Hillsboro, OR');
  await expect(page.locator('#discovery-location-status')).toContainText('Browser location accuracy: about 120 m.');
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL');
  log('centre', { url: new URL(page.url()).search, radius: '10 mi', label: 'Near Hillsboro, OR', coverage: 'FULL',
    accuracyLine: await page.locator('#discovery-location-status').innerText() });
  // No search has run: the location only chose where.
  expect(await page.locator('#discovery-results tbody tr').count()).toBe(0);

  // 2. THE SEARCH IS THE ORDINARY DERIVED SEARCH.
  const derivedBefore = derived.length;
  const partitionsBefore = partitions.length;
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('10-mile radius search', { timeout: 300000 });
  await expect(page.locator('#discovery-summary')).toContainText('Near Hillsboro, OR');
  expect(await page.locator('#discovery-results tbody tr').count()).toBeGreaterThan(0);
  log('search', { derivedCells: derived.length - derivedBefore, rawPartitions: partitions.length - partitionsBefore,
    summary: (await page.locator('#discovery-summary').innerText()).replace(/\s+/g, ' ').slice(0, 240) });

  // 3. PROMOTION CARRIES THE LOCATED CENTRE'S CONTEXT.
  const row = page.locator('#discovery-results tbody tr').first();
  const rowDistance = (await row.locator('td').nth(2).innerText()).trim();
  await row.locator('.discovery-row').click();
  await page.locator('#discovery-promote').click();
  const panel = page.locator('#candidate-detail #candidate-search-context');
  await expect(panel).toBeVisible({ timeout: 300000 });
  const headline = await panel.locator('.search-context-headline').innerText();
  const promotedTitle = await page.locator('#candidate-detail .detail-title').innerText();
  expect(headline).toBe(`${rowDistance} of Near Hillsboro, OR`);
  log('promotion', { headline, title: promotedTitle });

  // 4. RELOAD: the candidate, its corridor and its context come back locally, with no location request.
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  const derivedBeforeReload = derived.length;
  const partitionsBeforeReload = partitions.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#candidate-detail .detail-title')).toHaveText(promotedTitle, { timeout: 120000 });
  await expect(page.locator('#candidate-detail #candidate-search-context .search-context-headline')).toHaveText(headline);
  await expect(page.locator('#candidate-persistence')).toContainText('came back from local storage');
  await expect(page.locator('#discovery-location-status')).not.toContainText('Browser location accuracy');
  log('restore', { headline, derivedReads: derived.length - derivedBeforeReload, partitionReads: partitions.length - partitionsBeforeReload });
  expect(derived.length - derivedBeforeReload).toBe(0);
  expect(partitions.length - partitionsBeforeReload).toBe(0);

  // 5. REMOVAL IS DURABLE, and the post-removal reload is verified.
  await page.locator('#candidate-remove').click();
  await page.locator('#candidate-remove-confirm').click();
  await expect(page.locator('#candidate-list .candidate-card')).toHaveCount(0, { timeout: 180000 });
  log('removal', { removed: promotedTitle, remaining: 0 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  await expect(page.locator('#candidate-list .candidate-card')).toHaveCount(0);
  await expect(page.locator('#candidate-detail')).toContainText('Investigation starts with a road');
  expect(await page.evaluate(() => localStorage.getItem('roadnaturalist.candidates.v1'))).toBe(null);
  log('removalAfterReload', { stillGone: true });

  expect(outside, 'a located search must reach no occurrence, Investigator, geocoder or OSM endpoint').toEqual([]);
  log('externalRequests', outside.length);
});
