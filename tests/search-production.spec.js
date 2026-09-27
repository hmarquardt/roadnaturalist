import { test, expect } from '@playwright/test';

// Opt-in verification of the *deployed* arbitrary-search path in a real browser.
//
//   RUN_SEARCH_PRODUCTION=1 npm run verify:search:production
//   PRODUCTION_BASE_URL=https://roadnaturalist.pages.dev RUN_SEARCH_PRODUCTION=1 npx playwright test tests/search-production.spec.js
//
// It is the check the deployment story requires before (and after) a Pages release: a centre a person chooses
// in the deployed app must run the published derived corridor metrics for that centre at 10, 25 and 50 miles,
// report FULL/PARTIAL/NONE honestly, promote a corridor whose raw reconstruction and detailed habitat are
// verified against the precomputed row, and reach no external evidence source at all.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
const EVIDENCE = /api\.inaturalist|api\.ebird|overpass|api\.roadnaturalist\.com/;
const CENTER = { lat: 45.51, lon: -123.12 };
const SCENARIOS = [10, 25, 50];

test.skip(!process.env.RUN_SEARCH_PRODUCTION, 'set RUN_SEARCH_PRODUCTION=1 to verify the deployed arbitrary-search path');

test('deployed arbitrary-radius searches, a PARTIAL edge search, promotion and zero external evidence', async ({ page }) => {
  test.setTimeout(3600000);
  await page.setViewportSize({ width: 1440, height: 950 });
  const outside = [];
  const derivedCells = [];
  const partitions = [];
  const failures = [];
  page.on('request', request => {
    if (EVIDENCE.test(request.url())) outside.push(request.url());
    if (request.url().includes('/derived/corridor-metrics/')) derivedCells.push(request.url());
    if (request.url().includes('/regional/partitions/')) partitions.push(request.url());
  });
  page.on('pageerror', error => failures.push(error.message));
  const report = { base: BASE, searches: [], edge: null, promotion: null, externalRequests: 0, pageErrors: 0 };
  const log = value => console.log('SEARCH_PRODUCTION ' + JSON.stringify(value));

  for (const radius of SCENARIOS) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
    await page.locator('#discovery-center-lat').fill(String(CENTER.lat));
    await page.locator('#discovery-center-lon').fill(String(CENTER.lon));
    await page.locator('#discovery-center-apply').click();
    await page.locator('#discovery-radius-input').fill(String(radius));
    await page.locator('#discovery-radius-input').press('Enter');
    const cellsBefore = derivedCells.length;
    const started = Date.now();
    await page.locator('#discover-roads').click();
    await expect(page.locator('#discovery')).toContainText('Discovery coverage', { timeout: 300000 });
    await expect(page.locator('#discovery-summary')).toContainText(`${radius}-mile radius search`, { timeout: 300000 });
    await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 120000 });
    const elapsedMs = Date.now() - started;
    const banner = await page.locator('#discovery').innerText();
    const entry = { radiusMiles: radius, elapsedMs, corridors: Number(await page.locator('#discovery-count').innerText()),
      cellsRead: derivedCells.length - cellsBefore, summary: (await page.locator('#discovery-summary').innerText()).replace(/\n+/g, ' · '),
      coverage: /Discovery coverage (FULL|PARTIAL|NONE|UNKNOWN)/.exec(banner)?.[1] ?? null,
      rawPartitionsBeforePromotion: partitions.length };
    report.searches.push(entry);
    log(entry);
    expect(entry.corridors).toBeGreaterThan(0);
    expect(entry.cellsRead).toBeGreaterThan(0);
    expect(new URL(derivedCells[cellsBefore]).host).toBe('data.roadnaturalist.com');
    expect(partitions).toEqual([]);
    expect(entry.coverage).toBe('FULL');
  }

  // PARTIAL: a centre north of the published edge whose circle reaches back into it.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  await page.locator('#discovery-center-lat').fill('46.30');
  await page.locator('#discovery-center-lon').fill('-122.90');
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-radius-input').fill('25');
  await page.locator('#discovery-radius-input').press('Enter');
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: PARTIAL', { timeout: 60000 });
  const edgeBefore = derivedCells.length;
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery')).toContainText('Discovery coverage PARTIAL', { timeout: 300000 });
  report.edge = { coverage: 'PARTIAL', cellsRead: derivedCells.length - edgeBefore,
    corridors: Number(await page.locator('#discovery-count').innerText()) };
  log(report.edge);
  expect(report.edge.cellsRead).toBeGreaterThan(0);
  // A centre that cannot reach the published region at all: known before the search, refused, nothing read.
  const beforeNone = derivedCells.length;
  await page.locator('#discovery-center-lat').fill('43');
  await page.locator('#discovery-center-lon').fill('-120');
  await page.locator('#discovery-center-apply').click();
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: NONE', { timeout: 60000 });
  await expect(page.locator('#discover-roads')).toBeDisabled();
  report.none = { refused: true, cellsRead: derivedCells.length - beforeNone };
  log(report.none);
  expect(report.none.cellsRead).toBe(0);

  // Promotion of an arbitrary-search corridor: the raw corridor is reconstructed and verified against the
  // precomputed row, and the detailed panel measures it from the raw regional partitions.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  await page.locator('#discovery-center-lat').fill(String(CENTER.lat));
  await page.locator('#discovery-center-lon').fill(String(CENTER.lon));
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-radius-input').fill('10');
  await page.locator('#discovery-radius-input').press('Enter');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('10-mile radius search', { timeout: 300000 });
  const fullRow = page.locator('#discovery-results tbody tr').filter({ has: page.locator('td:nth-child(6):text-is("FULL")') }).first();
  await expect(fullRow).toBeVisible({ timeout: 120000 });
  await fullRow.locator('.discovery-row').click();
  const selected = page.locator('#discovery-selected');
  await expect(selected).toContainText('Mapped wetland within 250 m');
  const discoveryArea = await selected.locator('.discovery-facts div', { hasText: 'Mapped wetland within 250 m' }).locator('dd').innerText();
  const partitionsBefore = partitions.length;
  await page.locator('#discovery-promote').click();
  const habitat = page.locator('.habitat-section');
  await expect(habitat).toContainText('PHYSICAL HABITAT EVIDENCE', { timeout: 300000 });
  await expect(habitat).toContainText('Detailed GIS', { timeout: 300000 });
  const wetlandFacts = habitat.locator('.habitat-block').first();
  await expect(wetlandFacts).toContainText('Within 250 m', { timeout: 300000 });
  const detailArea = await wetlandFacts.locator('dl div', { hasText: /^Within 250 m/ }).first().locator('dd').innerText();
  report.promotion = { discoveryArea, detailArea, partitionsRead: partitions.length - partitionsBefore,
    r2Host: partitions.length ? new URL(partitions[0]).host : null };
  log(report.promotion);
  expect(report.promotion.partitionsRead).toBeGreaterThan(0);
  expect(report.promotion.r2Host).toBe('data.roadnaturalist.com');
  if (discoveryArea !== 'None mapped' && discoveryArea !== 'Unknown') expect(detailArea).toContain(discoveryArea);
  expect(outside, 'a search must reach no occurrence, Investigator or Overpass endpoint').toEqual([]);
  expect(failures).toEqual([]);
  report.externalRequests = outside.length;
  report.pageErrors = failures.length;
  log(report);
});
