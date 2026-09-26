import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const summary = JSON.parse(readFileSync(new URL('./fixtures/or-roads-network.summary.json', import.meta.url)));
// The offline extraction summary counts road units by summing source-feature lengths, while the browser
// measures the composed corridor geometry the application uses everywhere. A unit whose source retraces
// a stretch therefore measures longer in the browser, so a handful of units sitting within metres of the
// 1-mile threshold fall on either side of it. Feature and unit counts must still match exactly.
const CORRIDOR_TOLERANCE = 0.15;
const expectedFeatures = summary.featureCount - summary.classCounts.S1500;
// Discovery must reach no occurrence source, no Investigator Worker, and no live OpenStreetMap. The
// guard matches external hosts only: the application's own occurrence adapter modules live under
// /src/occurrence/ and must load normally.
const EXTERNAL_HOSTS = /^https?:\/\/(?:[^/]*\.)?(?:inaturalist\.org|ebird\.org|overpass-api\.de|overpass\.kumi\.systems|openstreetmap\.org|roadnaturalist\.com)(?::\d+)?\//i;
const EXTERNAL_PATTERNS = ['https://api.inaturalist.org/**', 'https://api.ebird.org/**', 'https://ebird.org/**',
  'https://overpass-api.de/**', 'https://overpass.kumi.systems/**', 'https://api.roadnaturalist.com/**'];

async function watchExternal(page) {
  const seen = [];
  page.on('request', request => { if (EXTERNAL_HOSTS.test(request.url())) seen.push(request.url()); });
  for (const pattern of EXTERNAL_PATTERNS) {
    await page.route(pattern, route => { seen.push(route.request().url()); return route.abort(); });
  }
  return seen;
}

async function runDiscovery(page) {
  // The workspace renders its controls as soon as the app boots; waiting for that keeps a slow module
  // load from looking like a missing button.
  await expect(page.locator('#discover-roads')).toBeVisible({ timeout: 60000 });
  await page.click('#discover-roads');
  await expect(page.locator('#discovery')).toContainText('Discovery coverage', { timeout: 110000 });
}

test.beforeEach(async ({ page }) => {
  // DuckDB-WASM and the bounded extracts are heavy: give every discovery page the same bounded boot.
  await page.goto('/');
  await expect(page.locator('#discover-roads')).toBeVisible({ timeout: 60000 });
});

test('discovery surveys the pilot area with real data, and reaches no external evidence source', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  const started = Date.now();
  await runDiscovery(page);
  expect(Date.now() - started).toBeLessThan(110000);
  const panel = page.locator('#discovery');
  // The browser read exactly the extract the offline summary describes.
  await expect(panel).toContainText(`${expectedFeatures} road features read`);
  await expect(panel).toContainText('corridors analysed in one GIS batch');
  await expect(panel).toContainText('Batch phases:');
  // Units within metres of the 1-mile threshold can fall either side of it when the length is measured
  // on the composed corridor rather than by summing source features, so this count is checked within
  // a small tolerance of the offline number.
  const panelText = await panel.innerText();
  const dropped = Number(/\b(\d+) named road unit\(s\) shorter than the minimum corridor length/.exec(panelText)?.[1] ?? -1);
  expect(dropped).toBeGreaterThan(0);
  expect(Math.abs(dropped - summary.discovery.unitsDroppedAsShort)).toBeLessThanOrEqual(summary.discovery.unitsDroppedAsShort * 0.02);
  await expect(panel).toContainText('Not proposed:');
  const rows = page.locator('#discovery-results tbody tr');
  const corridorCount = Number(await page.locator('#discovery-count').innerText());
  expect(corridorCount).toBeGreaterThanOrEqual(Math.floor(summary.discovery.proposedCorridorCount * (1 - CORRIDOR_TOLERANCE)));
  expect(corridorCount).toBeLessThanOrEqual(Math.ceil(summary.discovery.proposedCorridorCount * (1 + CORRIDOR_TOLERANCE)));
  await expect(rows).toHaveCount(corridorCount);
  // A head-selected pilot road is proposed by discovery too, without any hand-written declaration.
  await expect(page.locator('#discovery-results')).toContainText('NW Cornelius Pass Rd');
  await page.locator('#discovery-wetland').selectOption('intersects');
  const intersectsCount = await rows.count();
  expect(intersectsCount).toBeGreaterThan(0);
  expect(intersectsCount).toBeLessThan(corridorCount);
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(rows).toHaveCount(corridorCount);
  // Explicit sorts reorder the table by one measured value each.
  await page.locator('#discovery-sort').selectOption('length');
  const lengths = await rows.evaluateAll(nodes => nodes.slice(0, 5).map(node => Number(node.children[1].textContent.replace(/[^0-9.]/g, ''))));
  expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  await page.locator('#discovery-sort').selectOption('name');
  const names = await rows.evaluateAll(nodes => nodes.slice(0, 5).map(node => node.querySelector('button').textContent));
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  // Selecting a result highlights it on the map and shows its measured evidence.
  await page.locator('.discovery-row').first().click();
  const selected = page.locator('#discovery-selected');
  await expect(selected).toContainText('Selected discovery corridor');
  await expect(selected).toContainText('Mapped wetland within 250 m');
  await expect(selected).toContainText('Mapped water crossings');
  await expect(selected).toContainText('Access verification: NOT YET RUN / UNVERIFIED');
  await expect(selected).toContainText('Occurrence sources: not queried');
  await expect(page.locator('#map svg .discovery-selected')).toHaveCount(1);
  expect(await page.locator('#map svg .discovery-corridor').count()).toBeGreaterThan(50);
  expect(external).toEqual([]);
});

test('promotion produces an ordinary candidate whose detailed analysis matches the discovery batch', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await runDiscovery(page);
  // The default display order puts the corridors with the most mapped wetland first, so the first row is
  // a corridor whose wetland metrics were measured (a few corridors report UNKNOWN habitat coverage
  // because the geometry engine cannot buffer that source geometry).
  const firstRow = page.locator('.discovery-row').first();
  await expect(firstRow).toBeVisible({ timeout: 30000 });
  const corridorName = (await firstRow.innerText()).trim();
  await firstRow.click();
  const selected = page.locator('#discovery-selected');
  await expect(selected).toContainText('Selected discovery corridor');
  await expect(selected).toContainText(corridorName);
  // The batch measurements are the values the detailed per-corridor analysis reports for the same line.
  const discoveryArea = await selected.locator('.discovery-facts div', { hasText: 'Mapped wetland within 250 m' }).locator('dd').innerText();
  const discoveryCrossings = await selected.locator('.discovery-facts div', { hasText: 'Mapped water crossings' }).locator('dd').innerText();
  expect(discoveryArea).not.toBe('None mapped');
  await page.locator('#discovery-promote').click();
  const list = page.locator('#candidate-list');
  await expect(list).toContainText(corridorName);
  const detail = page.locator('#candidate-detail');
  await expect(detail).toContainText(corridorName);
  await expect(detail).toContainText('discovered');
  const habitat = page.locator('.habitat-section');
  await expect(habitat).toContainText('PHYSICAL HABITAT EVIDENCE', { timeout: 60000 });
  const habitatArea = await habitat.locator('.road-facts div', { hasText: /^Within 250 m/ }).first().locator('dd').innerText();
  expect(habitatArea).toContain(discoveryArea);
  const habitatCrossings = await habitat.locator('.road-facts div', { hasText: 'Mapped crossings' }).first().locator('dd').innerText();
  expect(habitatCrossings).toContain(`${discoveryCrossings} documented`);
  // Access stays unverified for a discovered corridor, and the panel says why: no reviewed source is declared.
  await expect(page.locator('.access-section')).toContainText('No reviewed research sources are declared for this corridor');
  await expect(page.locator('.access-section')).toContainText('UNVERIFIED');
  // Access research on a corridor with no declared probes stays UNVERIFIED and needs no Worker call.
  await page.getByRole('button', { name: /access research|access investigation/i }).first().click();
  await expect(page.locator('.access-section')).toContainText('UNVERIFIED', { timeout: 60000 });
  await expect(page.locator('.access-section')).not.toContainText('ACCESS VERIFIED');
  await expect(detail).toContainText('Evidence trail');
  expect(await page.locator('#map svg .discovery-corridor.promoted').count()).toBe(1);
  expect(external).toEqual([]);
});

test('a discovery run without the GIS engine reports UNKNOWN coverage, never an empty search area', async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: /Discover roads/ }).click();
  const panel = page.locator('#discovery');
  await expect(panel).toContainText('A failed query is not an empty search area', { timeout: 60000 });
  await expect(panel).toContainText('DuckDB Spatial initialization failed');
  await expect(page.locator('#discovery-count')).toHaveText('0');
  await expect(panel).not.toContainText('No discovery corridor was proposed');
  expect(errors).toEqual([]);
});

test('the discovery workspace stays usable at 390px', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#discover-roads')).toBeVisible({ timeout: 30000 });
  await runDiscovery(page);
  await expect(page.locator('#discovery')).toContainText('Discovery coverage');
  await page.locator('#discovery-results tbody tr button').first().click();
  await expect(page.locator('#discovery-selected')).toContainText('Selected discovery corridor');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

