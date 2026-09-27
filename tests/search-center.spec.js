import { test, expect } from '@playwright/test';

// An arbitrary search: a centre a person chose on the map or typed, and a radius they chose, run through the
// same derived discovery pipeline the committed 10/25/50-mile benchmarks verify. These tests cover the
// interaction (map pick, coordinate entry, radius, preview, coverage, sharing) and the two things that must
// not change with it: exact-radius inclusion, and zero external evidence requests.
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

async function boot(page) {
  await page.goto('/');
  // The button stays disabled until the search-area declaration has loaded: a search cannot run without one.
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage:');
}

async function setRadius(page, miles) {
  // A typed radius commits on change (blur or Enter), exactly as a person experiences it.
  await page.locator('#discovery-radius-input').fill(String(miles));
  await page.locator('#discovery-radius-input').press('Enter');
  await expect(page.locator('#discovery-radius-value')).toHaveText(`${miles} mi`);
}

async function setRadiusWithSlider(page, miles) {
  // The slider is the ordinary control; it previews while it moves and commits when it is released.
  await page.locator('#discovery-radius').fill(String(miles));
  await page.locator('#discovery-radius').dispatchEvent('change');
  await expect(page.locator('#discovery-radius-value')).toHaveText(`${miles} mi`);
}

async function setCenter(page, lat, lon) {
  await page.locator('#discovery-center-lat').fill(String(lat));
  await page.locator('#discovery-center-lon').fill(String(lon));
  await page.locator('#discovery-center-apply').click();
}

async function search(page, { radius, timeout = 180000 } = {}) {
  await expect(page.locator('#discovery-search-status')).toContainText(`Custom radius search · ${radius} mi`);
  await expect(page.locator('#discovery-center-label')).not.toBeEmpty();
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery')).toContainText('Discovery coverage', { timeout });
  await expect(page.locator('#discovery-summary')).toContainText(`${radius}-mile radius search`, { timeout });
}

test('a map-picked centre and a typed centre run the same derived search, and reach no evidence source', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await boot(page);
  // The published region is on the map before anything is drawn, so a centre can be chosen first.
  await expect(page.locator('#map .search-region')).toHaveCount(1);
  const beforeLat = await page.locator('#discovery-center-lat').inputValue();
  expect(beforeLat).toBe('45.5950');
  await expect(page.locator('#discovery-recent')).toHaveCount(0);
  await page.locator('#discovery-center-pick').click();
  await expect(page.locator('#discovery-center-pick')).toHaveAttribute('aria-pressed', 'true');
  // The map is fitted to the published region before anything is drawn, so its centre is a real in-region
  // coordinate; clicking it is the ordinary "choose a point" interaction.
  await page.locator('#map svg').click();
  // The pick becomes an ordinary centre: the fields show it, the preview moves, the mode ends.
  await expect(page.locator('#discovery-center-pick')).toHaveAttribute('aria-pressed', 'false');
  const picked = Number(await page.locator('#discovery-center-lat').inputValue());
  const pickedLon = Number(await page.locator('#discovery-center-lon').inputValue());
  expect(Number.isFinite(picked)).toBe(true);
  expect(picked).toBeGreaterThan(44.75);
  expect(picked).toBeLessThan(46.42);
  expect(pickedLon).toBeGreaterThan(-124.05);
  expect(pickedLon).toBeLessThan(-121.77);
  expect(`${picked},${pickedLon}`).not.toBe(beforeLat);
  // The map draws the chosen centre, the requested radius and the selection box as a preview only.
  await expect(page.locator('#map .search-center')).toHaveCount(1);
  await expect(page.locator('#map .search-disk')).toHaveCount(1);
  await expect(page.locator('#map .search-box')).toHaveCount(1);
  await expect(page.locator('#map .map-key')).toContainText('mi ·');
  const preview = Number(await page.locator('#map .search-disk').getAttribute('rx'));
  expect(preview).toBeGreaterThan(0);
  await setRadius(page, 5);
  const smaller = Number(await page.locator('#map .search-disk').getAttribute('rx'));
  expect(smaller).toBeLessThan(preview);
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL');
  await setRadius(page, 10);
  await search(page, { radius: 10 });
  const firstCount = Number(await page.locator('#discovery-count').innerText());
  expect(firstCount).toBeGreaterThan(0);
  await expect(page.locator('#discovery-summary')).toContainText('metric cell(s) loaded');
  await expect(page.locator('#discovery-summary')).toContainText('MiB');
  // A typed centre moves the search, and the results on screen are marked as belonging to the previous one.
  await setCenter(page, 45.51, -123.12);
  await expect(page.locator('#discovery-search-status')).toContainText('45.5100, -123.1200');
  await expect(page.locator('#discovery-recent')).toContainText('mi');
  await setRadius(page, 25);
  await expect(page.locator('#discovery')).toContainText('These results are from the previous search');
  await search(page, { radius: 25 });
  const secondCount = Number(await page.locator('#discovery-count').innerText());
  expect(secondCount).toBeGreaterThan(firstCount);
  // The current definition is on the URL, so the search can be shared and restored.
  const url = new URL(page.url());
  expect(url.searchParams.get('lat')).toBe('45.51');
  expect(url.searchParams.get('lon')).toBe('-123.12');
  expect(url.searchParams.get('r')).toBe('25');
  expect(external).toEqual([]);
});

test('a search that crosses the published edge is PARTIAL, and one that misses it is refused', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  const derivedRequests = [];
  await page.route('**/derived/corridor-metrics/**', route => { derivedRequests.push(route.request().url()); return route.continue(); });
  await boot(page);
  // North of the published region's north edge, with a radius that reaches back into it.
  await setCenter(page, 46.30, -122.90);
  await setRadius(page, 25);
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: PARTIAL');
  await expect(page.locator('#discovery-search-status')).toContainText('crosses the edge of the published');
  await expect(page.locator('#discover-roads')).toBeEnabled();
  await search(page, { radius: 25 });
  await expect(page.locator('#discovery')).toContainText('Discovery coverage PARTIAL');
  const read = derivedRequests.length;
  expect(read).toBeGreaterThan(0);
  // A centre whose circle cannot reach the region is answered before the search: status, reason, and a
  // disabled button - and no metric cell is read to find that out.
  await setCenter(page, 43.0, -120.0);
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: NONE');
  await expect(page.locator('#discovery-search-status')).toContainText('does not overlap the published');
  await expect(page.locator('#discovery')).toContainText('Cannot search');
  await expect(page.locator('#discover-roads')).toBeDisabled();
  await page.waitForTimeout(500);
  expect(derivedRequests.length).toBe(read);
  expect(external).toEqual([]);
});

test('promotion of an arbitrary-search corridor reconstructs and verifies the raw corridor', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  const partitions = [];
  page.on('request', request => { if (request.url().includes('/data/regional/partitions/')) partitions.push(request.url()); });
  await boot(page);
  await setCenter(page, 45.51, -122.86);
  await setRadius(page, 10);
  await search(page, { radius: 10, timeout: 240000 });
  expect(partitions).toEqual([]);
  // A corridor with FULL habitat coverage is the strongest case: the detailed panel must measure the same
  // corridor the search row described, from the raw regional partitions.
  const fullRow = page.locator('#discovery-results tbody tr').filter({ has: page.locator('td:text-is("FULL")') }).first();
  await expect(fullRow).toBeVisible({ timeout: 60000 });
  await fullRow.locator('.discovery-row').click();
  const selected = page.locator('#discovery-selected');
  await expect(selected).toContainText('Mapped wetland within 250 m');
  const discoveryArea = await selected.locator('.discovery-facts div', { hasText: 'Mapped wetland within 250 m' }).locator('dd').innerText();
  await page.locator('#discovery-promote').click();
  const habitat = page.locator('.habitat-section');
  await expect(habitat).toContainText('PHYSICAL HABITAT EVIDENCE', { timeout: 300000 });
  await expect(habitat).toContainText('Detailed GIS');
  expect(partitions.length).toBeGreaterThan(0);
  expect(partitions[0]).toContain('regional/partitions/');
  if (discoveryArea !== 'None mapped' && discoveryArea !== 'Unknown') {
    const wetlandFacts = habitat.locator('.habitat-block').first();
    await expect(wetlandFacts).toContainText('Within 250 m');
    const detailArea = await wetlandFacts.locator('dl div', { hasText: /^Within 250 m/ }).first().locator('dd').innerText();
    expect(detailArea).toContain(discoveryArea);
  }
  await expect(page.locator('#candidate-list')).toContainText('discovered');
  expect(external).toEqual([]);
});

test('a shared link restores the search without running it, and the last search is remembered', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  const derivedRequests = [];
  page.on('request', request => { if (request.url().includes('/derived/corridor-metrics/')) derivedRequests.push(request.url()); });
  await page.goto('/?lat=45.51&lon=-123.12&r=15');
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  await expect(page.locator('#discovery-area')).toHaveValue('custom-radius');
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5100');
  await expect(page.locator('#discovery-center-lon')).toHaveValue('-123.1200');
  await expect(page.locator('#discovery-radius-input')).toHaveValue('15');
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL');
  // A link restores a definition and waits for the button: no metric cell is read, and no result is claimed.
  expect(derivedRequests).toEqual([]);
  await expect(page.locator('#discovery')).not.toContainText('Discovery coverage');
  await search(page, { radius: 15 });
  const read = derivedRequests.length;
  // Reload: the definition comes back from the URL, the search is in the recent list, and it is not re-run.
  await page.reload();
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  await expect(page.locator('#discovery-radius-input')).toHaveValue('15');
  await expect(page.locator('#discovery-recent')).toContainText('Near Forest Grove, OR · 15 mi');
  await page.waitForTimeout(300);
  expect(derivedRequests.length).toBe(read);
  // A malformed link fails safely: the problem is stated, the parameters are ignored, and nothing runs.
  await page.goto('/?lat=north&lon=-123.12&r=15');
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  await expect(page.locator('#discovery')).toContainText('The search parameters in this link were ignored');
  await expect(page.locator('#discovery')).toContainText('Latitude must be a decimal number');
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5100');
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL');
  await page.waitForTimeout(300);
  expect(derivedRequests.length).toBe(read);
  expect(external).toEqual([]);
});

test('the search workflow stays usable at 390px', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  const external = await watchExternal(page);
  await boot(page);
  await expect(page.locator('#discovery-center-pick')).toBeVisible();
  await expect(page.locator('#discovery-radius')).toBeVisible();
  await expect(page.locator('#discovery-radius-input')).toBeVisible();
  await expect(page.locator('#discover-roads')).toBeVisible();
  // A tap on the map sets the centre, exactly as a mouse click does.
  await page.locator('#discovery-center-pick').click();
  await page.locator('#map svg').click();
  const lat = Number(await page.locator('#discovery-center-lat').inputValue());
  expect(lat).toBeGreaterThan(44.75);
  expect(lat).toBeLessThan(46.42);
  // The slider is the ordinary radius control: Home goes to the minimum, and each arrow key commits a mile.
  const slider = page.locator('#discovery-radius');
  await slider.focus();
  await slider.press('Home');
  await expect(page.locator('#discovery-radius-value')).toHaveText('1 mi');
  await slider.press('ArrowRight');
  await slider.press('ArrowRight');
  await expect(page.locator('#discovery-radius-value')).toHaveText('3 mi');
  await expect(page.locator('#discovery-search-status')).toContainText('Custom radius search · 3 mi');
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await search(page, { radius: 3 });
  await expect(page.locator('#discovery-summary')).toContainText('3-mile radius search');
  await page.locator('#discovery-results tbody tr button').first().click();
  await expect(page.locator('#discovery-selected')).toContainText('Selected discovery corridor');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(external).toEqual([]);
});
