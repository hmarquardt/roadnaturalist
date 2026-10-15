import { test, expect } from '@playwright/test';
import { openAdvancedSearch, openAllResults } from './discovery-ui.js';

// Finding a place by name: a local lookup over the committed national gazetteer that feeds the same search
// definition a map click or a typed coordinate produces. These tests cover the interaction (typing, mouse,
// keyboard, escape, mobile), the honest refusals (nothing found, an address), the disambiguation a national
// name collision needs, and the two things that must not change: the radius stays the user's, and no external
// service is ever asked. The data being national is the point: "Hillsboro oregon" answers in one keystroke
// whether or not a regional pilot ever carried it.
const EXTERNAL_HOSTS = /^https?:\/\/(?:[^/]*\.)?(?:inaturalist\.org|ebird\.org|overpass-api\.de|overpass\.kumi\.systems|openstreetmap\.org|api\.roadnaturalist\.com|nominatim\.openstreetmap\.org|api\.mapbox\.com|maps\.googleapis\.com|geocoding\.geo\.census\.gov)(?::\d+)?\//i;
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
  await openAdvancedSearch(page);
  await page.locator('#discovery-radius-input').fill('25');
  await page.locator('#discovery-radius-input').press('Enter');
  await expect(page.locator('#discovery-radius-value')).toHaveText('25 mi');
  const results = await typePlace(page, 'Hillsboro oregon');
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
  // Nothing is reported about the search itself - no phase, no refusal - and the centre is stated in the ordinary flow.
  await expect(page.locator('#discovery-search-status')).toHaveText('');
  await expect(page.locator('#discovery-center-label')).toHaveText('Hillsboro, OR · 45.5268, -122.9354');
  await expect(page.locator('#discovery-active-search')).toContainText('Coverage: FULL');
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
  // A national name collides often, so what separates the results is the state and the county printed beside
  // each one - and the most populous namesake leads.
  const labels = await optionLabels(page);
  expect(labels[0]).toBe('Toledo, OH · City');
  expect(new Set(labels.map(label => label.split(', ')[1].split(' ')[0])).size).toBeGreaterThan(1);
  await expect(page.locator('#discovery-place-results .discovery-place-detail').first()).toContainText('County');
  // ArrowDown moves the active option and announces it; Enter chooses it and does nothing else.
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', 'discovery-place-option-1');
  await expect(page.locator('#discovery-place-results .discovery-place-option').nth(1))
    .toHaveAttribute('aria-selected', 'true');
  const second = labels[1].split(' · ')[0];
  await input.press('Enter');
  // The chosen result is the one the panel then names, and the URL carries its published centre.
  await expect(page.locator('#discovery-center-label')).toContainText(second);
  const chosen = new URL(page.url());
  expect(Number(chosen.searchParams.get('lat'))).toBeGreaterThan(24);
  expect(Number(chosen.searchParams.get('lat'))).toBeLessThan(50);
  expect(Number(chosen.searchParams.get('lon'))).toBeLessThan(-66);
  await expect(page.locator('#discovery-place-results')).toBeHidden();
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  // Any conterminous place is inside the national derived plane's published region, so the default radius is
  // FULL: the PARTIAL and NONE answers belong to a centre outside the conterminous states.
  await expect(page.locator('#discovery-active-search')).toContainText('Coverage: FULL');
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
  await openAdvancedSearch(page);
  const before = await page.locator('#discovery-center-lat').inputValue();
  await input.fill('hi');
  await expect(page.locator('#discovery-place-status')).toContainText('Type at least 3 characters');
  await expect(page.locator('#discovery-place-results')).toBeHidden();
  for (const query of ['zzzz', 'xqzwv', '123 Main St', '123 Main Street, Hillsboro, OR 97123']) {
    await input.fill(query);
    await expect(page.locator('#discovery-place-status')).toContainText('No place matching');
    await expect(page.locator('#discovery-place-results')).toBeHidden();
  }
  // A query that matches nothing changes nothing at all.
  await expect(page.locator('#discovery-center-lat')).toHaveValue(before);
  await expect(page.locator('#discover-roads')).toBeEnabled();
  expect(external).toEqual([]);
});

test('a conterminous place is covered, and choosing one reads no metric cell', async ({ page }) => {
  const external = await watchExternal(page);
  const derivedRequests = [];
  await page.route('**/derived/corridor-metrics/**', route => { derivedRequests.push(route.request().url()); return route.continue(); });
  await boot(page);
  const input = page.locator('#discovery-place');
  await input.fill('Chehalis');
  await expect(page.locator('#discovery-place-results')).toBeVisible();
  await input.press('Enter');
  await expect(page.locator('#discovery-center-label')).toContainText('Chehalis, WA');
  // A conterminous place lies inside the national derived plane's published region, so its coverage is FULL at
  // the default radius and the search is runnable. The PARTIAL and NONE answers this test used to exercise
  // belong to a centre *outside* the conterminous states, which no published place is.
  await expect(page.locator('#discovery-active-search')).toContainText('Coverage: FULL');
  await expect(page.locator('#discover-roads')).toBeEnabled();
  // A lookup reads no metric cell: the search is the person's next move, never a side effect of choosing a place.
  expect(derivedRequests).toEqual([]);
  expect(external).toEqual([]);
});

test('the place field and its results stay usable at 390px, and choosing does not pan the map', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  const external = await watchExternal(page);
  await boot(page);
  await expect(page.locator('#discovery-place')).toBeVisible();
  await openAdvancedSearch(page);
  await expect(page.locator('#discovery-radius-input')).toBeVisible();
  await expect(page.locator('#discover-roads')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const before = await page.locator('#map svg').getAttribute('viewBox');
  const results = await typePlace(page, 'Hillsboro oregon');
  await expect(results).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.locator('#discovery-place-results .discovery-place-option').first().click();
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5268');
  // Choosing a result must not move the map view: the preview follows the centre, the view does not.
  expect(await page.locator('#map svg').getAttribute('viewBox')).toBe(before);
  await page.locator('#discovery-radius-input').fill('5');
  await page.locator('#discovery-radius-input').press('Enter');
  await expect(page.locator('#discovery-active-search')).toContainText('Coverage: FULL');
  await expect(page.locator('#discover-roads')).toBeVisible();
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('5-mile radius search', { timeout: 180000 });
  await openAllResults(page);
  await page.locator('#discovery-results tbody tr button').first().click();
  await expect(page.locator('#discovery-selected')).toContainText('Selected discovery corridor');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(external).toEqual([]);
});
