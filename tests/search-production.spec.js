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
// The committed benchmark centre, for a like-for-like comparison with the published derived baseline.
const BENCHMARK_CENTER = { lat: 45.595, lon: -122.92 };
// A centre that is not a committed scenario, which is the point of this check.
const ARBITRARY_CENTER = { lat: 45.51, lon: -123.12 };
const SCENARIOS = [{ radius: 10, center: BENCHMARK_CENTER, coverage: 'FULL', label: 'Near North Plains, OR' },
  { radius: 25, center: BENCHMARK_CENTER, coverage: 'FULL', label: 'Near North Plains, OR' },
  { radius: 50, center: BENCHMARK_CENTER, coverage: 'FULL', label: 'Near North Plains, OR' },
  { radius: 25, center: ARBITRARY_CENTER, coverage: 'FULL', label: 'Near Forest Grove, OR' }];

async function setSearch(page, { lat, lon, radius }) {
  await page.locator('#discovery-center-lat').fill(String(lat));
  await page.locator('#discovery-center-lon').fill(String(lon));
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-radius-input').fill(String(radius));
  await page.locator('#discovery-radius-input').press('Enter');
  await expect(page.locator('#discovery-search-status')).toContainText(`Custom radius search · ${radius} mi`);
  // The centre line names the search the way the panel does, and always keeps the coordinates beside it.
  await expect(page.locator('#discovery-center-label')).toContainText(`${lat.toFixed(4)}, ${lon.toFixed(4)}`);
}

async function distanceCells(page) {
  return page.locator('#discovery-results tbody tr')
    .evaluateAll(nodes => nodes.map(node => node.children[2].textContent.trim()));
}

function milesOf(text) {
  return text.startsWith('<') ? 0.05 : Number(text.replace(/[^0-9.]/g, ''));
}

async function checkSearchContext(page, { radius, label }) {
  await expect(page.locator('#discovery-results thead')).toContainText('From center');
  await expect(page.locator('#discovery-summary')).toContainText(label);
  const cells = await distanceCells(page);
  expect(cells.length).toBeGreaterThan(0);
  for (const cell of cells) expect(cell).toMatch(/^(?:<0\.1|\d+\.\d) mi(?: (?:N|NE|E|SE|S|SW|W|NW))?$/);
  for (const cell of cells) expect(milesOf(cell)).toBeLessThanOrEqual(radius + 0.05);
  expect(cells.some(cell => / (?:N|NE|E|SE|S|SW|W|NW)$/.test(cell))).toBe(true);
  // The distance sort is explicit, ascending, and orders by the value the column shows.
  await page.locator('#discovery-sort').selectOption('distanceFromCenter');
  const sorted = (await distanceCells(page)).map(milesOf);
  expect(sorted).toEqual([...sorted].sort((left, right) => left - right));
  await page.locator('#discovery-sort').selectOption('wetlandArea250');
  return { firstCell: cells[0], nearestMi: sorted[0], farthestMi: sorted[sorted.length - 1] };
}

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

  for (const scenario of SCENARIOS) {
    const { radius, center, coverage, label } = scenario;
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
    await setSearch(page, { lat: center.lat, lon: center.lon, radius });
    const cellsBefore = derivedCells.length;
    const started = Date.now();
    await page.locator('#discover-roads').click();
    await expect(page.locator('#discovery')).toContainText('Discovery coverage', { timeout: 300000 });
    await expect(page.locator('#discovery-summary')).toContainText(`${radius}-mile radius search`, { timeout: 300000 });
    await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 120000 });
    const elapsedMs = Date.now() - started;
    const banner = await page.locator('#discovery').innerText();
    // The deployed app labels this centre from the committed gazetteer and measures every corridor it returns.
    await expect(page.locator('#discovery-center-label')).toContainText(label);
    const context = await checkSearchContext(page, { radius, label });
    const entry = { center: [center.lon, center.lat], radiusMiles: radius, elapsedMs, centreLabel: label,
      corridors: Number(await page.locator('#discovery-count').innerText()), cellsRead: derivedCells.length - cellsBefore,
      nearestDistance: context.nearestMi, farthestDistance: context.farthestMi, firstRowDistance: context.firstCell,
      summary: (await page.locator('#discovery-summary').innerText()).replace(/\n+/g, ' · '),
      coverage: /Discovery coverage (FULL|PARTIAL|NONE|UNKNOWN)/.exec(banner)?.[1] ?? null,
      rawPartitionsBeforePromotion: partitions.length };
    report.searches.push(entry);
    log(entry);
    expect(entry.corridors).toBeGreaterThan(0);
    expect(entry.cellsRead).toBeGreaterThan(0);
    expect(new URL(derivedCells[cellsBefore]).host).toBe('data.roadnaturalist.com');
    expect(partitions).toEqual([]);
    expect(entry.coverage).toBe(coverage);
  }

  // PARTIAL: a centre north of the published edge whose circle reaches back into it.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  await setSearch(page, { lat: 46.30, lon: -122.90, radius: 25 });
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

  // A map-picked centre: the deployed app labels it from the same local gazetteer, keeps the coordinate the
  // click landed on, and still runs a search from it.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  await page.locator('#discovery-center-pick').click();
  await page.locator('#map svg').click({ position: { x: 200, y: 200 } });
  await expect(page.locator('#discovery-center-pick')).toHaveAttribute('aria-pressed', 'false');
  const pickedLat = await page.locator('#discovery-center-lat').inputValue();
  const pickedLon = await page.locator('#discovery-center-lon').inputValue();
  const pickedLabel = await page.locator('#discovery-center-label').innerText();
  report.picked = { lat: pickedLat, lon: pickedLon, label: pickedLabel, url: page.url() };
  log(report.picked);
  // The label is an inference about the coordinates or nothing at all, and the coordinates are the search.
  expect(pickedLabel).toMatch(/^(?:Near .+, (?:OR|WA)|Centre: -?\d)/);
  expect(pickedLabel).toContain(`${pickedLat}, ${pickedLon}`);
  const pickedUrl = new URL(page.url());
  expect(Number(pickedUrl.searchParams.get('lat'))).toBeCloseTo(Number(pickedLat), 4);
  expect(Number(pickedUrl.searchParams.get('lon'))).toBeCloseTo(Number(pickedLon), 4);
  expect(pickedUrl.searchParams.get('place')).toBeNull();

  // Promotion of an arbitrary-search corridor: the raw corridor is reconstructed and verified against the
  // precomputed row, and the detailed panel measures it from the raw regional partitions.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  await setSearch(page, { lat: ARBITRARY_CENTER.lat, lon: ARBITRARY_CENTER.lon, radius: 10 });
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('10-mile radius search', { timeout: 300000 });
  const fullRow = page.locator('#discovery-results tbody tr').filter({ has: page.locator('td:text-is("FULL")') }).first();
  await expect(fullRow).toBeVisible({ timeout: 120000 });
  await fullRow.locator('.discovery-row').click();
  const selected = page.locator('#discovery-selected');
  await expect(selected).toContainText('Mapped wetland within 250 m');
  // The promoted corridor keeps its search context: measured distance, direction, and the line on the map that
  // says which part of the road that distance is to.
  await expect(selected).toContainText('From search center');
  await expect(selected).toContainText('Straight-line distance from the search centre to the nearest point on this road');
  await expect(page.locator('#map svg .search-center-line')).toHaveCount(1);
  const selectedDistance = await selected.locator('.discovery-facts div', { hasText: 'From search center' }).locator('dd').innerText();
  const discoveryArea = await selected.locator('.discovery-facts div', { hasText: 'Mapped wetland within 250 m' }).locator('dd').innerText();
  const partitionsBefore = partitions.length;
  await page.locator('#discovery-promote').click();
  const habitat = page.locator('.habitat-section');
  await expect(habitat).toContainText('PHYSICAL HABITAT EVIDENCE', { timeout: 300000 });
  await expect(habitat).toContainText('Detailed GIS', { timeout: 300000 });
  const wetlandFacts = habitat.locator('.habitat-block').first();
  await expect(wetlandFacts).toContainText('Within 250 m', { timeout: 300000 });
  const detailArea = await wetlandFacts.locator('dl div', { hasText: /^Within 250 m/ }).first().locator('dd').innerText();
  // The promoted candidate carries the same orientation the discovery row reported, with the inferred label and
  // the radius the search actually used.
  const candidateContext = page.locator('#candidate-detail #candidate-search-context');
  await expect(candidateContext).toBeVisible({ timeout: 300000 });
  await expect(candidateContext).toContainText('Near Forest Grove, OR');
  await expect(candidateContext).toContainText('10 mi radius search');
  await expect(candidateContext).toContainText(`${selectedDistance.split(' ')[0]} mi`);
  await expect(candidateContext).toContainText('not a driving distance, and not a ranking');
  report.promotion = { discoveryArea, detailArea, selectedDistance, partitionsRead: partitions.length - partitionsBefore,
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
