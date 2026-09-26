import { test, expect } from '@playwright/test';

// Opt-in verification of the *deployed* regional discovery path in a real browser.
//
//   RUN_REGIONAL_PRODUCTION=1 npm run verify:regional:production
//   PRODUCTION_BASE_URL=https://roadnaturalist.pages.dev RUN_REGIONAL_PRODUCTION=1 npx playwright test tests/regional-production.spec.js
//
// It is the check the deployment story requires before (and after) a Pages release: the deployed app must load
// the published catalog and its partitions from the Road Naturalist R2 origin, compose roads across cells,
// report habitat coverage, promote a corridor whose detailed habitat equals the survey row (the promotion
// identity fix), and reach no external evidence source at all. Raw regional discovery is slow on purpose, so
// the timeouts are generous and the run is opt-in.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
const EVIDENCE = /api\.inaturalist|api\.ebird|overpass|api\.roadnaturalist\.com/;

test.skip(!process.env.RUN_REGIONAL_PRODUCTION, 'set RUN_REGIONAL_PRODUCTION=1 to verify the deployed regional path');

test('deployed regional discovery verifies coverage, promotion identity and zero external evidence', async ({ page }) => {
  test.setTimeout(1800000);
  await page.setViewportSize({ width: 1440, height: 950 });
  const outside = [];
  const partitions = [];
  const failures = [];
  page.on('request', request => {
    if (EVIDENCE.test(request.url())) outside.push(request.url());
    if (request.url().includes('/regional/partitions/')) partitions.push(request.url());
  });
  page.on('pageerror', error => failures.push(error.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  await page.locator('#discovery-area').selectOption('or-portland-west-regional');
  const started = Date.now();
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery')).toContainText('Search data:', { timeout: 900000 });
  const elapsedMs = Date.now() - started;
  await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible();
  const corridorCount = Number(await page.locator('#discovery-count').innerText());
  const banner = await page.locator('#discovery').innerText();
  const selected = page.locator('#discovery-selected');
  const fullRow = page.locator('#discovery-results tbody tr').filter({ has: page.locator('td:nth-child(6):text-is("FULL")') }).first();
  await expect(fullRow).toBeVisible();
  await fullRow.locator('.discovery-row').click();
  await expect(selected).toContainText('Mapped wetland within 250 m');
  const discoveryArea = await selected.locator('.discovery-facts div', { hasText: 'Mapped wetland within 250 m' }).locator('dd').innerText();
  await page.locator('#discovery-promote').click();
  const habitat = page.locator('.habitat-section');
  await expect(habitat).toContainText('PHYSICAL HABITAT EVIDENCE', { timeout: 300000 });
  const wetlandFacts = habitat.locator('.habitat-block').first();
  await expect(wetlandFacts).toContainText('Within 250 m', { timeout: 300000 });
  const detailArea = await wetlandFacts.locator('dl div', { hasText: /^Within 250 m/ }).first().locator('dd').innerText();
  const report = { base: BASE, corridorCount, elapsedMs, partitions: partitions.length,
    r2Host: partitions.length ? new URL(partitions[0]).host : null, discoveryArea, detailArea,
    coverageLine: /Discovery coverage[^\n]*/.exec(banner)?.[0] ?? null,
    externalRequests: outside.length, pageErrors: failures.length };
  console.log('REGIONAL_PRODUCTION ' + JSON.stringify(report));

  expect(corridorCount).toBeGreaterThan(100);
  expect(partitions.length).toBeGreaterThan(3);
  expect(report.r2Host).toBe('data.roadnaturalist.com');
  expect(banner).toContain('FULL');
  // The promotion identity fix: the detailed panel measures the corridor the survey row described.
  if (discoveryArea !== 'None mapped') expect(detailArea).toContain(discoveryArea);
  expect(outside, 'discovery must reach no occurrence, Investigator or Overpass endpoint').toEqual([]);
  expect(failures).toEqual([]);
});
