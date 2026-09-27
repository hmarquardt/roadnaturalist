import { test, expect } from '@playwright/test';

// SEARCH CONTEXT in the browser: the label a centre gets (a chosen place, the nearest published place, or the
// coordinates), and the measured distance and direction every discovered corridor reports from that centre.
//
// Three things must hold at every step: the centre is never moved to a place, the label never becomes part of
// the search, and nothing outside this origin is ever asked for a name or a coordinate.
const EXTERNAL_HOSTS = /^https?:\/\/(?:[^/]*\.)?(?:inaturalist\.org|ebird\.org|overpass-api\.de|overpass\.kumi\.systems|openstreetmap\.org|roadnaturalist\.com|nominatim\.openstreetmap\.org|api\.mapbox\.com|maps\.googleapis\.com|geocoding\.geo\.census\.gov)(?::\d+)?\//i;
const EXTERNAL_PATTERNS = ['https://api.inaturalist.org/**', 'https://api.ebird.org/**', 'https://ebird.org/**',
  'https://overpass-api.de/**', 'https://overpass.kumi.systems/**', 'https://api.roadnaturalist.com/**',
  'https://nominatim.openstreetmap.org/**', 'https://api.mapbox.com/**', 'https://maps.googleapis.com/**',
  'https://geocoding.geo.census.gov/**'];

// Published Census centre points used to drive the interface from outside the implementation: Vernonia, OR and
// Forest Grove, OR, plus a point in the published region whose nearest place is ~25 miles away.
const VERNONIA = { lat: 45.86403, lon: -123.18362 };
const FOREST_GROVE = { lat: 45.52478, lon: -123.10991 };
const FAR_POINT = { lat: 46.28, lon: -121.88 };

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
  await expect(page.locator('#discovery-center-label')).toBeVisible();
}

async function applyCoordinates(page, { lat, lon }, radius = null) {
  if (radius != null) {
    await page.locator('#discovery-radius-input').fill(String(radius));
    await page.locator('#discovery-radius-input').press('Enter');
    await expect(page.locator('#discovery-radius-value')).toHaveText(`${radius} mi`);
  }
  await page.locator('#discovery-center-lat').fill(lat.toFixed(4));
  await page.locator('#discovery-center-lon').fill(lon.toFixed(4));
  await page.locator('#discovery-center-apply').click();
  return { lat: Number(await page.locator('#discovery-center-lat').inputValue()),
    lon: Number(await page.locator('#discovery-center-lon').inputValue()) };
}

// A map pick is driven the way a person drives it: arm the pick, press the map. The projection is a plain
// equirectangular fit, so two probe picks are enough to solve where a chosen coordinate sits on screen — the
// test aims at a known place instead of guessing a pixel.
async function pickAtCoordinate(page, target) {
  const svg = page.locator('#map svg');
  const box = await svg.boundingBox();
  const probe = async (x, y) => {
    await page.locator('#discovery-center-pick').click();
    await svg.click({ position: { x, y } });
    await expect(page.locator('#discovery-center-pick')).toHaveAttribute('aria-pressed', 'false');
    return { lat: Number(await page.locator('#discovery-center-lat').inputValue()),
      lon: Number(await page.locator('#discovery-center-lon').inputValue()) };
  };
  const first = await probe(box.width * 0.3, box.height * 0.3);
  const eastward = await probe(box.width * 0.3 + 120, box.height * 0.3);
  const southward = await probe(box.width * 0.3, box.height * 0.3 + 120);
  const lonPerPx = (eastward.lon - first.lon) / 120;
  const latPerPx = (southward.lat - first.lat) / 120;
  const x = box.width * 0.3 + (target.lon - first.lon) / lonPerPx;
  const y = box.height * 0.3 + (target.lat - first.lat) / latPerPx;
  const picked = await probe(x, y);
  return { ...picked, clicks: { x, y } };
}

test('a map-picked centre near a place is labelled from the local gazetteer and the point itself is kept', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await boot(page);
  // Half a mile east of the published Vernonia centre point: near enough to be labelled by it, and far enough
  // from it that "the centre was not snapped to the place" is a real assertion.
  const target = { lat: VERNONIA.lat, lon: VERNONIA.lon + 0.0104 };
  const picked = await pickAtCoordinate(page, target);
  expect(Math.abs(picked.lat - target.lat)).toBeLessThan(0.01);
  expect(Math.abs(picked.lon - target.lon)).toBeLessThan(0.02);
  const label = page.locator('#discovery-center-label');
  await expect(label).toContainText('Near Vernonia, OR');
  await expect(label).toContainText('45.8640, -123.1732');
  // The picked point is the search: it is still the coordinate the click produced, half a mile from the place.
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.8640');
  await expect(page.locator('#discovery-center-lon')).toHaveValue('-123.1732');
  expect(Math.abs(picked.lon - VERNONIA.lon)).toBeGreaterThan(0.005);
  // The label is presentation only: the URL stays coordinates and radius, with no place parameter.
  const url = new URL(page.url());
  expect(url.searchParams.get('place')).toBeNull();
  expect(Number(url.searchParams.get('lat'))).toBeCloseTo(picked.lat, 4);
  expect(Number(url.searchParams.get('lon'))).toBeCloseTo(picked.lon, 4);
  expect(Number(url.searchParams.get('r'))).toBe(10);
  // A pick never runs a search by itself.
  await expect(page.locator('#discovery')).not.toContainText('Discovery coverage');
  expect(external).toEqual([]);
});

test('typed coordinates are labelled by the nearest published place and never snapped to it', async ({ page }) => {
  const external = await watchExternal(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  const typed = { lat: 45.54, lon: -123.17 };
  const applied = await applyCoordinates(page, typed, 10);
  expect(applied).toEqual(typed);
  const label = page.locator('#discovery-center-label');
  // Three miles from Forest Grove: the nearest place labels the search, and says how far away it is.
  await expect(label).toContainText('Near Forest Grove, OR');
  await expect(label).toContainText('45.5400, -123.1700');
  await expect(label).toContainText('mi away');
  expect((await label.innerText()).startsWith('Near ')).toBe(true);
  // The coordinates are still the typed ones, not the place centre five miles away.
  expect(Math.abs(typed.lon - FOREST_GROVE.lon)).toBeGreaterThan(0.05);
  await expect(page.locator('#discovery-center-lon')).toHaveValue('-123.1700');
  // The remembered search says the same thing, regenerated from the gazetteer.
  await expect(page.locator('#discovery-recent')).toContainText('Near Forest Grove, OR · 10 mi');
  expect(external).toEqual([]);
});

test('a centre no published place is near keeps its coordinates, and a chosen place keeps its own name', async ({ page }) => {
  const external = await watchExternal(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  await applyCoordinates(page, FAR_POINT, 25);
  const label = page.locator('#discovery-center-label');
  // The nearest published place is 25 miles away, which is not "near". Coordinates it is.
  await expect(label).toHaveText('Centre: 46.2800, -121.8800');
  await expect(label).not.toContainText('Near');
  await expect(page.locator('#discovery-recent')).toContainText('46.2800, -121.8800 · 25 mi');
  // An explicit choice outranks an inferred label: Hillsboro is named, not "near" Hillsboro.
  await page.locator('#discovery-place').fill('Hillsboro');
  await expect(page.locator('#discovery-place-results')).toBeVisible();
  await page.locator('#discovery-place-results .discovery-place-option').first().click();
  await expect(label).toHaveText('Hillsboro, OR · 45.5268, -122.9354');
  await expect(label).not.toContainText('Near');
  await expect(page.locator('#map .map-key')).toContainText('Hillsboro, OR');
  await expect(page.locator('#discovery-recent')).toContainText('Hillsboro, OR · 25 mi');
  expect(external).toEqual([]);
});

const DISTANCE_CELL = /^(?:<0\.1|\d+\.\d) mi(?: (?:N|NE|E|SE|S|SW|W|NW))?$/;

async function distanceCells(page) {
  return page.locator('#discovery-results tbody tr').evaluateAll(nodes => nodes.map(node => node.children[2].textContent.trim()));
}

function milesOf(text) {
  return text.startsWith('<') ? 0.05 : Number(text.replace(/[^0-9.]/g, ''));
}

test('every discovered corridor reports its distance and direction from the search centre', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await boot(page);
  await page.locator('#discovery-place').fill('Hillsboro');
  await expect(page.locator('#discovery-place-results')).toBeVisible();
  await page.locator('#discovery-place-results .discovery-place-option').first().click();
  await page.locator('#discovery-radius-input').fill('5');
  await page.locator('#discovery-radius-input').press('Enter');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('5-mile radius search', { timeout: 180000 });
  // The summary names the place and keeps the coordinates as the search's own state.
  await expect(page.locator('#discovery-summary')).toContainText('Hillsboro, OR');
  await expect(page.locator('#discovery-summary')).toContainText('centre 45.5268, -122.9354');
  await expect(page.locator('#discovery-results thead')).toContainText('From center');
  const cells = await distanceCells(page);
  expect(cells.length).toBeGreaterThan(10);
  expect(cells[0]).toMatch(DISTANCE_CELL);
  for (const cell of cells) expect(cell).toMatch(DISTANCE_CELL);
  // Every displayed distance agrees with the radius that selected it, to within the display rounding.
  for (const cell of cells) expect(milesOf(cell)).toBeLessThanOrEqual(5.05);
  expect(cells.some(cell => / (?:N|NE|E|SE|S|SW|W|NW)$/.test(cell))).toBe(true);
  // The selected corridor repeats the measured fact, named as a straight line rather than a drive.
  await page.locator('#discovery-results tbody tr button').first().click();
  const selected = page.locator('#discovery-selected');
  await expect(selected).toContainText('From search center');
  await expect(selected).toContainText('Straight-line distance from the search centre to the nearest point on this road');
  await expect(selected).toContainText('not a driving distance, and not a ranking');
  // One line from the centre to the nearest point of the selected road, and nothing else.
  await expect(page.locator('#map svg .search-center-line')).toHaveCount(1);
  await expect(page.locator('#map svg .search-center-point')).toHaveCount(1);
  expect(external).toEqual([]);
});

test('sorting by distance from the center is explicit, deterministic and off by default', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await boot(page);
  await applyCoordinates(page, { lat: 45.54, lon: -123.17 }, 10);
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('10-mile radius search', { timeout: 180000 });
  await expect(page.locator('#discovery-sort option[value="distanceFromCenter"]')).toHaveText('Distance from center (m)');
  expect(await page.locator('#discovery-sort').inputValue()).not.toBe('distanceFromCenter');
  expect(await page.locator('#discovery-sort').inputValue()).toBe('wetlandArea250');
  await page.locator('#discovery-sort').selectOption('distanceFromCenter');
  const cells = await distanceCells(page);
  const miles = cells.map(milesOf);
  expect(miles).toEqual([...miles].sort((left, right) => left - right));
  expect(await distanceCells(page)).toEqual(cells);
  expect(external).toEqual([]);
});

test('at 390px the context stays readable without widening the page', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  const external = await watchExternal(page);
  await boot(page);
  await applyCoordinates(page, { lat: 45.54, lon: -123.17 }, 5);
  await expect(page.locator('#discovery-center-label')).toContainText('Near Forest Grove, OR');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('5-mile radius search', { timeout: 180000 });
  await expect(page.locator('#discovery-summary')).toContainText('Near Forest Grove, OR');
  const header = page.locator('#discovery-results thead');
  await expect(header).toContainText('From center');
  // The distance column survives at 390px; the ecoregion column is the one that collapses (CSS), and the
  // corridor name still carries its class and segment as secondary metadata.
  const firstRow = page.locator('#discovery-results tbody tr').first();
  await expect(firstRow.locator('td').nth(2)).toHaveText(DISTANCE_CELL);
  expect(await firstRow.locator('td').nth(5).isVisible()).toBe(false);
  await page.locator('#discovery-results tbody tr button').first().click();
  await expect(page.locator('#discovery-selected')).toContainText('From search center');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(external).toEqual([]);
});

test('a promoted corridor keeps the search context from the row through to the candidate', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await boot(page);
  // A typed centre near Forest Grove: an inferred label, a real measured relationship, and a short search.
  await applyCoordinates(page, { lat: 45.54, lon: -123.17 }, 5);
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('5-mile radius search', { timeout: 180000 });
  const rowCell = (await distanceCells(page))[0];
  expect(rowCell).toMatch(DISTANCE_CELL);
  await page.locator('#discovery-results tbody tr button').first().click();
  const panelFact = await page.locator('#discovery-selected .discovery-facts div', { hasText: 'From search center' }).locator('dd').innerText();
  expect(panelFact).toContain(rowCell.split(' ')[0]);
  await page.locator('#discovery-promote').click();
  const detail = page.locator('#candidate-detail');
  const context = detail.locator('#candidate-search-context');
  await expect(context).toBeVisible({ timeout: 180000 });
  // The promoted candidate states the same relationship the row and the panel stated, in the same words.
  await expect(context).toContainText('Where this corridor was found');
  await expect(context.locator('.search-context-headline')).toHaveText(`${rowCell} of Near Forest Grove, OR`);
  await expect(context).toContainText('45.5400, -123.1700');
  await expect(context).toContainText('5 mi radius search');
  await expect(context).toContainText('° true');
  await expect(context).toContainText('Straight-line distance from the search centre to the nearest point of this corridor');
  await expect(context).toContainText('not a driving distance, and not a ranking');
  await expect(context).not.toContainText('travel distance');
  // The map draws the search centre and the nearest point of the selected corridor (and only that corridor).
  await expect(page.locator('#map svg .candidate-context-line')).toHaveCount(1);
  await expect(page.locator('#map svg .candidate-context-center')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  // A candidate created by a search keeps the mark that promotion recorded, and a promoted corridor is kept on
  // this device: the reload restores the candidate *with* the context it was promoted with, and invents nothing.
  const marks = await page.evaluate(() => JSON.parse(localStorage.getItem('roadnaturalist.discovery.marks.v1') ?? '{}'));
  expect(Object.values(marks.marks ?? {}).filter(status => status === 'PROMOTED').length).toBe(1);
  await page.reload();
  await expect(page.locator('#candidate-detail')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#candidate-detail #candidate-search-context')).toHaveCount(1);
  await expect(page.locator('#candidate-detail #candidate-search-context .search-context-headline')).toHaveText(`${rowCell} of Near Forest Grove, OR`);
  await expect(page.locator('#discovery')).not.toContainText('promotion verification failed');
  expect(external).toEqual([]);
});

test('a corridor promoted from a chosen place keeps the place name, not an inference about it', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await boot(page);
  await page.locator('#discovery-place').fill('Hillsboro');
  await expect(page.locator('#discovery-place-results')).toBeVisible();
  await page.locator('#discovery-place-results .discovery-place-option').first().click();
  await page.locator('#discovery-radius-input').fill('5');
  await page.locator('#discovery-radius-input').press('Enter');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('5-mile radius search', { timeout: 180000 });
  const rowCell = (await distanceCells(page))[0];
  await page.locator('#discovery-results tbody tr button').first().click();
  await page.locator('#discovery-promote').click();
  const context = page.locator('#candidate-detail #candidate-search-context');
  await expect(context).toBeVisible({ timeout: 180000 });
  // The explicit place stays explicit: the candidate says where the search was, not what the nearest place was.
  await expect(context.locator('.search-context-headline')).toHaveText(`${rowCell} of Hillsboro, OR`);
  await expect(context).toContainText('Hillsboro, OR · 45.5268, -122.9354');
  await expect(context).not.toContainText('Near Hillsboro');
  expect(external).toEqual([]);
});
