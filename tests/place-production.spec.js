import { test, expect } from '@playwright/test';

// Opt-in verification of the *deployed* place-name search.
//
//   RUN_PLACE_PRODUCTION=1 npm run verify:places:production
//   PRODUCTION_BASE_URL=https://roadnaturalist.pages.dev RUN_PLACE_PRODUCTION=1 npx playwright test tests/place-production.spec.js
//
// It is the check the deployment story requires before (and after) a Pages release: a place typed by name in
// the deployed app must set the search centre, keep the radius, run the published derived corridor metrics,
// report FULL/PARTIAL/NONE honestly, promote a corridor whose raw reconstruction and detailed habitat are
// verified, and reach no external service at all - no geocoder, no occurrence source, no Investigator Worker.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
const EVIDENCE = /api\.inaturalist|api\.ebird|overpass|api\.roadnaturalist\.com|nominatim|mapbox|maps\.googleapis|geocoding\.geo\.census\.gov/;

test.skip(!process.env.RUN_PLACE_PRODUCTION, 'set RUN_PLACE_PRODUCTION=1 to verify the deployed place-name search');

test('deployed place search, the edge, a refusal, promotion and zero external calls', async ({ page }) => {
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
  const report = { base: BASE, searches: [], edge: null, none: null, promotion: null,
    externalRequests: 0, pageErrors: 0 };
  const log = value => console.log('PLACE_PRODUCTION ' + JSON.stringify(value));

  async function choosePlace(query, { keyboard = false } = {}) {
    const input = page.locator('#discovery-place');
    await input.fill(query);
    await expect(page.locator('#discovery-place-results')).toBeVisible({ timeout: 60000 });
    const labels = await page.locator('#discovery-place-results .discovery-place-option').evaluateAll(nodes =>
      nodes.map(node => `${node.querySelector('.discovery-place-name').textContent} · ${node.querySelector('.discovery-place-type').textContent}`));
    if (keyboard) {
      await input.press('ArrowDown');
      await input.press('Enter');
    } else {
      await page.locator('#discovery-place-results .discovery-place-option').first().click();
    }
    await expect(page.locator('#discovery-place-results')).toBeHidden();
    return labels;
  }

  async function setRadius(radius) {
    await page.locator('#discovery-radius-input').fill(String(radius));
    await page.locator('#discovery-radius-input').press('Enter');
  }

  // 1. A real in-region place, searched from its published centre.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  await expect(page.locator('#discovery-place')).toBeVisible({ timeout: 120000 });
  expect(await choosePlace('Hillsboro')).toEqual(['Hillsboro, OR · City']);
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5268');
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL', { timeout: 60000 });
  const before = derivedCells.length;
  const started = Date.now();
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('10-mile radius search', { timeout: 300000 });
  await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 120000 });
  const first = { place: 'Hillsboro, OR', radiusMiles: 10, elapsedMs: Date.now() - started,
    corridors: Number(await page.locator('#discovery-count').innerText()),
    cellsRead: derivedCells.length - before,
    summary: (await page.locator('#discovery-summary').innerText()).replace(/\n+/g, ' · '),
    coverage: /Discovery coverage (FULL|PARTIAL|NONE|UNKNOWN)/.exec(await page.locator('#discovery').innerText())?.[1] ?? null,
    recent: await page.locator('#discovery-recent').innerText() };
  report.searches.push(first);
  log(first);
  expect(first.corridors).toBeGreaterThan(0);
  expect(first.cellsRead).toBeGreaterThan(0);
  expect(first.coverage).toBe('FULL');
  expect(new URL(derivedCells[before]).host).toBe('data.roadnaturalist.com');
  expect(first.recent).toContain('Hillsboro, OR');
  await expect(page.locator('#data-context')).toContainText('U.S. Census Bureau');

  // 2. Promotion of a place-search corridor, from the raw regional partitions.
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

  // 3. A second real place, so this is a lookup and not one hard-coded name.
  const second = await choosePlace('Vernonia');
  expect(second).toContain('Vernonia, OR · City');
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.864');
  await setRadius(25);
  const secondBefore = derivedCells.length;
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('25-mile radius search', { timeout: 300000 });
  const secondEntry = { place: 'Vernonia, OR', radiusMiles: 25,
    corridors: Number(await page.locator('#discovery-count').innerText()), cellsRead: derivedCells.length - secondBefore,
    coverage: /Discovery coverage (FULL|PARTIAL|NONE|UNKNOWN)/.exec(await page.locator('#discovery').innerText())?.[1] ?? null };
  report.searches.push(secondEntry);
  log(secondEntry);
  expect(secondEntry.corridors).toBeGreaterThan(0);
  expect(secondEntry.coverage).toBe('FULL');

  // 4. A duplicate name chosen by keyboard: Toledo, WA sits 1.7 mi north of the published edge, so a 10-mile
  // search must report PARTIAL rather than a silent FULL.
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto(`${BASE}/?lat=45.52&lon=-122.98&r=10`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  const labels = await choosePlace('Toledo', { keyboard: true });
  expect(labels).toEqual(['Toledo, OR · City', 'Toledo, WA · City']);
  await expect(page.locator('#discovery-center-lat')).toHaveValue('46.4447');
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: PARTIAL', { timeout: 60000 });
  const edgeBefore = derivedCells.length;
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery')).toContainText('Discovery coverage PARTIAL', { timeout: 300000 });
  report.edge = { place: 'Toledo, WA', coverage: 'PARTIAL', cellsRead: derivedCells.length - edgeBefore,
    corridors: Number(await page.locator('#discovery-count').innerText()) };
  log(report.edge);
  expect(report.edge.cellsRead).toBeGreaterThan(0);

  // 5. A real place whose radius cannot reach the region: known before the search, refused, nothing read.
  const noneBefore = derivedCells.length;
  await page.locator('#discovery-radius-input').fill('10');
  await page.locator('#discovery-radius-input').press('Enter');
  expect(await choosePlace('Chehalis')).toEqual(['Chehalis, WA · City']);
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: NONE', { timeout: 60000 });
  await expect(page.locator('#discover-roads')).toBeDisabled();
  report.none = { place: 'Chehalis, WA', refused: true, cellsRead: derivedCells.length - noneBefore };
  log(report.none);
  expect(report.none.cellsRead).toBe(0);

  expect(outside, 'a place search must reach no geocoder, occurrence source or Investigator endpoint').toEqual([]);
  expect(failures).toEqual([]);
  report.externalRequests = outside.length;
  report.pageErrors = failures.length;
  log(report);
});
