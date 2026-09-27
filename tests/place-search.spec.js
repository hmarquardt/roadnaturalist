import { test, expect } from '@playwright/test';

// Finding a place by name: a small local lookup over the committed regional gazetteer that feeds the same
// search definition a map click or a typed coordinate produces. These tests cover the interaction (typing,
// mouse, keyboard, escape, mobile), the honest refusals (nothing found, an address, a radius that cannot
// reach), and the two things that must not change: the radius stays the user's, and no external service is
// ever asked.
const EXTERNAL_HOSTS = /^https?:\/\/(?:[^/]*\.)?(?:inaturalist\.org|ebird\.org|overpass-api\.de|overpass\.kumi\.systems|openstreetmap\.org|roadnaturalist\.com|nominatim\.openstreetmap\.org|api\.mapbox\.com|maps\.googleapis\.com|geocoding\.geo\.census\.gov)(?::\d+)?\//i;
const EXTERNAL_PATTERNS = ['https://api.inaturalist.org/**', 'https://api.ebird.org/**', 'https://ebird.org/**',
  'https://overpass-api.de/**', 'https://overpass.kumi.systems/**', 'https://api.roadnaturalist.com/**',
  'https://nominatim.openstreetmap.org/**', 'https://api.mapbox.com/**', 'https://maps.googleapis.com/**',
  'https://geocoding.geo.census.gov/**'];

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
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  await expect(page.locator('#discovery-place')).toBeVisible();
}

async function typePlace(page, query) {
  await page.locator('#discovery-place').fill(query);
  return page.locator('#discovery-place-results');
}

async function optionLabels(page) {
  return page.locator('#discovery-place-results .discovery-place-option').evaluateAll(nodes =>
    nodes.map(node => `${node.querySelector('.discovery-place-name').textContent} · ${node.querySelector('.discovery-place-type').textContent}`));
}

test('typing a place name sets the centre, keeps the radius, and searches the same pipeline', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await boot(page);
  // The radius is the user's decision and the place must not touch it.
  await page.locator('#discovery-radius-input').fill('25');
  await page.locator('#discovery-radius-input').press('Enter');
  await expect(page.locator('#discovery-radius-value')).toHaveText('25 mi');
  const results = await typePlace(page, 'Hillsboro');
  await expect(results).toBeVisible();
  await expect(page.locator('#discovery-place')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#discovery-place')).toHaveAttribute('aria-activedescendant', 'discovery-place-option-0');
  expect(await optionLabels(page)).toEqual(['Hillsboro, OR · City']);
  await expect(page.locator('#discovery-place-status')).toContainText('1 matching place');
  await page.locator('#discovery-place-results .discovery-place-option').first().click();
  // The centre moves to the published interior point, the radius stays, and the panel says what happened.
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5268');
  await expect(page.locator('#discovery-center-lon')).toHaveValue('-122.9354');
  await expect(page.locator('#discovery-radius-input')).toHaveValue('25');
  await expect(page.locator('#discovery-radius-value')).toHaveText('25 mi');
  await expect(page.locator('#discovery-search-status')).toContainText('Hillsboro, OR · 45.5268, -122.9354');
  await expect(page.locator('#discovery-center-label')).toHaveText('Hillsboro, OR · 45.5268, -122.9354');
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL');
  await expect(page.locator('#map .search-center')).toHaveCount(1);
  await expect(page.locator('#map .map-key')).toContainText('Hillsboro, OR');
  const url = new URL(page.url());
  expect(url.searchParams.get('r')).toBe('25');
  expect(Number(url.searchParams.get('lat'))).toBe(45.5268);
  expect(Number(url.searchParams.get('lon'))).toBe(-122.93539);
  // Choosing a place must not run a search by itself.
  await expect(page.locator('#discovery')).not.toContainText('Discovery coverage');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('25-mile radius search', { timeout: 180000 });
  await expect(page.locator('#discovery-summary')).toContainText('45.5268, -122.9354');
  expect(Number(await page.locator('#discovery-count').innerText())).toBeGreaterThan(0);
  // The remembered search shows the place label, and the coverage panel cites the source.
  await expect(page.locator('#discovery-recent')).toContainText('Hillsboro, OR · 25 mi');
  await expect(page.locator('#data-context')).toContainText('Place-name gazetteer');
  await expect(page.locator('#data-context')).toContainText('U.S. Census Bureau');
  expect(external).toEqual([]);
});

test('the whole choice works from the keyboard, and duplicates are told apart', async ({ page }) => {
  const external = await watchExternal(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  const input = page.locator('#discovery-place');
  await input.click();
  await input.type('Toledo');
  await expect(page.locator('#discovery-place-results')).toBeVisible();
  expect(await optionLabels(page)).toEqual(['Toledo, OR · City', 'Toledo, WA · City']);
  // ArrowDown moves the active option and announces it; Enter chooses it and does nothing else.
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', 'discovery-place-option-1');
  await expect(page.locator('#discovery-place-results .discovery-place-option').nth(1))
    .toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  // The fields show the project's four-decimal display convention; the search itself keeps the published
  // five-decimal centre, which is what the URL carries.
  await expect(page.locator('#discovery-center-lat')).toHaveValue('46.4447');
  await expect(page.locator('#discovery-center-lon')).toHaveValue('-122.8522');
  await expect(page.locator('#discovery-search-status')).toContainText('Toledo, WA');
  expect(Number(new URL(page.url()).searchParams.get('lat'))).toBe(46.44472);
  expect(Number(new URL(page.url()).searchParams.get('lon'))).toBe(-122.85223);
  await expect(page.locator('#discovery-place-results')).toBeHidden();
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  // The default radius (10 mi) reaches the published edge from here, so the answer is PARTIAL rather than a
  // silent FULL or NONE.
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: PARTIAL');
  await expect(page.locator('#discover-roads')).toBeEnabled();
  // Escape closes the list and keeps the typed text: no keyboard trap, and no accidental choice.
  await input.click();
  await input.type('Chehalis');
  await expect(page.locator('#discovery-place-results')).toBeVisible();
  await input.press('Escape');
  await expect(page.locator('#discovery-place-results')).toBeHidden();
  await expect(input).toHaveValue('Chehalis');
  await input.press('Tab');
  await expect(page.locator('#discovery-place-results')).toBeHidden();
  expect(external).toEqual([]);
});

test('nothing found, too short and an address are all answered without a guess', async ({ page }) => {
  const external = await watchExternal(page);
  await boot(page);
  const input = page.locator('#discovery-place');
  const before = await page.locator('#discovery-center-lat').inputValue();
  await input.fill('hi');
  await expect(page.locator('#discovery-place-status')).toContainText('Type at least 3 characters');
  await expect(page.locator('#discovery-place-results')).toBeHidden();
  for (const query of ['zzzz', 'xqzwv', '123 Main St', '123 Main Street, Hillsboro, OR 97123']) {
    await input.fill(query);
    await expect(page.locator('#discovery-place-status')).toContainText('No matching place found.');
    await expect(page.locator('#discovery-place-results')).toBeHidden();
  }
  // A query that matches nothing changes nothing at all.
  await expect(page.locator('#discovery-center-lat')).toHaveValue(before);
  await expect(page.locator('#discover-roads')).toBeEnabled();
  expect(external).toEqual([]);
});

test('a place whose radius cannot reach published coverage is refused before any metric cell is read', async ({ page }) => {
  const external = await watchExternal(page);
  const derivedRequests = [];
  await page.route('**/derived/corridor-metrics/**', route => { derivedRequests.push(route.request().url()); return route.continue(); });
  await boot(page);
  const input = page.locator('#discovery-place');
  await input.fill('Chehalis');
  await expect(page.locator('#discovery-place-results')).toBeVisible();
  await input.press('Enter');
  await expect(page.locator('#discovery-search-status')).toContainText('Chehalis, WA');
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: NONE');
  await expect(page.locator('#discovery-search-status')).toContainText('does not overlap the published');
  await expect(page.locator('#discovery')).toContainText('Cannot search');
  await expect(page.locator('#discover-roads')).toBeDisabled();
  // Widening the radius is the user's move, and it makes the same place a usable search.
  await page.locator('#discovery-radius-input').fill('25');
  await page.locator('#discovery-radius-input').press('Enter');
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: PARTIAL');
  await expect(page.locator('#discovery-search-status')).toContainText('Chehalis, WA');
  await expect(page.locator('#discover-roads')).toBeEnabled();
  expect(derivedRequests).toEqual([]);
  expect(external).toEqual([]);
});

test('the place field and its results stay usable at 390px, and choosing does not pan the map', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  const external = await watchExternal(page);
  await boot(page);
  await expect(page.locator('#discovery-place')).toBeVisible();
  await expect(page.locator('#discovery-radius-input')).toBeVisible();
  await expect(page.locator('#discover-roads')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const before = await page.locator('#map svg').getAttribute('viewBox');
  const results = await typePlace(page, 'Hillsboro');
  await expect(results).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.locator('#discovery-place-results .discovery-place-option').first().click();
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5268');
  // Choosing a result must not move the map view: the preview follows the centre, the view does not.
  expect(await page.locator('#map svg').getAttribute('viewBox')).toBe(before);
  await page.locator('#discovery-radius-input').fill('5');
  await page.locator('#discovery-radius-input').press('Enter');
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL');
  await expect(page.locator('#discover-roads')).toBeVisible();
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('5-mile radius search', { timeout: 180000 });
  await page.locator('#discovery-results tbody tr button').first().click();
  await expect(page.locator('#discovery-selected')).toContainText('Selected discovery corridor');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(external).toEqual([]);
});
