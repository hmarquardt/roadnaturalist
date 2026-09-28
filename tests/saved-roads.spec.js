import assert from 'node:assert/strict';
import { test, expect } from '@playwright/test';

// SAVED ROADS IN A BROWSER.
//
// The collection a person keeps: favorite it, write a note about it, keep both across a reload, compare facts
// without a verdict, remove a road and lose its annotation with it, and do all of that at 390 px. Opening the
// saved collection must never ask the network for anything: the roads, their contexts and the notes are all
// already on this device.
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

// A data-file read this application makes (not a module), so a restore can be held to "no R2, no analysis".
function watchDataReads(page) {
  const reads = [];
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/regional/partitions/') || url.includes('/derived/') || url.includes('data.roadnaturalist.com')
      || /\/gis\/[^/]+\.(parquet|json|fgb|geojson)$/.test(new URL(url).pathname)) reads.push(url);
  });
  return reads;
}

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
}

async function quiet(page) {
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
}

async function reloadAndBoot(page) {
  await quiet(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
}

async function search(page, { lat, lon, radius }) {
  await page.locator('#discovery-center-lat').fill(lat.toFixed(4));
  await page.locator('#discovery-center-lon').fill(lon.toFixed(4));
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-radius-input').fill(String(radius));
  await page.locator('#discovery-radius-input').press('Enter');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText(`${radius}-mile radius search`, { timeout: 180000 });
}

async function savedCount(page) {
  const text = await page.locator('#saved-counts').innerText().catch(() => 'Saved roads 0');
  return Number(/Saved roads (\d+)/.exec(text)?.[1] ?? 0);
}

// Promote one corridor, and wait until it is a saved road on this device as well as a candidate. The
// selected-corridor heading names the corridor with its id, so waiting for it to change proves the click selected
// this row and not the one before it - which matters because two rows can share a road name.
async function promote(page, index = 0) {
  const before = await savedCount(page);
  const row = page.locator('#discovery-results tbody tr').nth(index);
  await expect(row).toBeVisible({ timeout: 60000 });
  const previous = (await page.locator('#discovery-selected h3').count() ? page.locator('#discovery-selected h3').innerText() : '');
  await row.locator('.discovery-row').click();
  await expect.poll(async () => page.locator('#discovery-selected h3').innerText().catch(() => ''), { timeout: 60000 }).not.toBe(previous);
  await page.locator('#discovery-promote').click();
  await expect(page.locator('#candidate-detail .detail-title')).toBeVisible({ timeout: 180000 });
  const title = await page.locator('#candidate-detail .detail-title').innerText();
  await expect(page.locator('#candidate-user')).toBeVisible({ timeout: 60000 });
  await expect.poll(() => savedCount(page), { timeout: 60000 }).toBeGreaterThan(before);
  return title;
}

async function favoriteSelected(page) {
  await page.locator('#candidate-favorite').click();
  await expect(page.locator('#candidate-favorite')).toHaveAttribute('aria-pressed', 'true', { timeout: 30000 });
}

async function writeNote(page, note) {
  await page.locator('#candidate-note').fill(note);
  // The app writes on a short debounce; waiting for the honest status line is the same wait a person would see.
  await expect(page.locator('#candidate-note-status')).toContainText('Saved on this device', { timeout: 30000 });
}

// The compare boxes are addressed by the road they belong to, never by position: a re-render must not be able to
// move a test's click onto another road.
async function compareBoxes(page) {
  const ids = await page.locator('#saved-list input[data-compare]').evaluateAll(nodes => nodes.map(node => node.dataset.compare));
  return { ids, box: id => page.locator(`#saved-list input[data-compare="${id}"]`) };
}

function savedCard(page, title) {
  return page.locator('#saved-list .saved-card').filter({ hasText: title }).first();
}

test('a favorite and a note survive a reload, and the note is only ever text', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await boot(page);
  await search(page, { lat: 45.54, lon: -123.17, radius: 10 });
  const title = await promote(page);
  await favoriteSelected(page);
  const note = 'Looks like a good early-morning loop.\nCheck the northern section after heavy rain.';
  await writeNote(page, note);
  await expect(page.locator('#candidate-note-status')).toContainText('Saved ');
  // The saved collection shows it, named as the person's own, and never as evidence.
  await expect(page.locator('#saved-counts')).toContainText('Saved roads 1 · Favorites 1 · Has notes 1');
  const card = savedCard(page, title);
  await expect(card).toContainText('Favorite ✓');
  await expect(card).toContainText('From original search centre:');
  await expect(card).toContainText('Looks like a good early-morning loop.');
  // RELOAD: the road, the favorite and the note come back from this device alone.
  const reads = watchDataReads(page);
  await reloadAndBoot(page);
  await expect(page.locator('#saved-counts')).toContainText('Saved roads 1 · Favorites 1 · Has notes 1');
  await expect(page.locator('#candidate-detail .detail-title')).toHaveText(title);
  await expect(page.locator('#candidate-favorite')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#candidate-note')).toHaveValue(note);
  await expect(page.locator('#candidate-note-status')).toContainText('Saved on this device');
  expect(reads).toEqual([]);
  expect(external).toEqual([]);
});

test('a note is rendered as words, never as markup', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  await search(page, { lat: 45.54, lon: -123.17, radius: 5 });
  const title = await promote(page);
  const hostile = '<img src=x onerror="window.__noteRan=true"> & <b>bold</b>';
  await writeNote(page, hostile);
  const card = savedCard(page, title);
  await expect(card).toContainText('<img src=x onerror="window.__noteRan=true"> & <b>bold</b>');
  expect(await card.locator('img, b, script').count()).toBe(0, 'a note is text: nothing in it becomes an element');
  expect(await page.evaluate(() => globalThis.__noteRan ?? null)).toBe(null);
  await expect(page.locator('#candidate-user')).toContainText('It is not evidence');
});

test('re-promoting the same corridor keeps the favorite and the note', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  await search(page, { lat: 45.54, lon: -123.17, radius: 10 });
  const title = await promote(page);
  await favoriteSelected(page);
  await writeNote(page, 'keep this one');
  const before = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).candidates[0].userMeta, 'roadnaturalist.candidates.v1');
  // The same search, the same corridor, promoted again: one saved road, and the same annotation on it.
  const row = page.locator('#discovery-results tbody tr').first();
  await row.locator('.discovery-row').click();
  await expect(page.locator('#discovery-promote')).toBeVisible({ timeout: 60000 });
  await page.locator('#discovery-promote').click();
  await expect(page.locator('#candidate-user')).toBeVisible({ timeout: 180000 });
  await expect(page.locator('#saved-counts')).toContainText('Saved roads 1 · Favorites 1 · Has notes 1');
  await expect(page.locator('#candidate-favorite')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#candidate-note')).toHaveValue('keep this one');
  const meta = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).candidates[0].userMeta, 'roadnaturalist.candidates.v1');
  assert.equal(meta.favorite, true);
  assert.equal(meta.note, 'keep this one');
  assert.equal(meta.savedAt, before.savedAt, 'the saved date is the one it was first saved with');
  assert.equal(meta.updatedAt, before.updatedAt, 're-promoting the road is not an edit to the annotation');
  await expect(page.locator('#saved-list .saved-card').filter({ hasText: title })).toHaveCount(1);
});

test('two or three saved roads compare fact by fact, and a fourth is refused out loud', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await boot(page);
  await search(page, { lat: 45.54, lon: -123.17, radius: 10 });
  const titles = [await promote(page, 0), await promote(page, 1), await promote(page, 2), await promote(page, 3)];
  await expect(page.locator('#saved-counts')).toContainText('Saved roads 4');
  await expect(page.locator('#saved-compare-status')).toContainText('Select two or three saved roads');
  const { ids, box } = await compareBoxes(page);
  await box(ids[0]).check();
  await expect(page.locator('#saved-compare-status')).toContainText('Select one more saved road');
  await box(ids[1]).check();
  // A real comparison: the facts of each road, side by side, with the origin row naming where each was found.
  const table = page.locator('#saved-compare-table');
  await expect(table).toBeVisible();
  await expect(table.locator('thead th')).toHaveCount(3, { timeout: 30000 });
  await expect(table.locator('tbody tr', { hasText: 'Road' }).first().locator('td')).toHaveCount(2);
  await expect(table).toContainText('From original search centre');
  await expect(table).toContainText('My notes');
  await expect(table).toContainText('Not measured this session');
  await expect(table).toContainText('No note');
  await expect(page.locator('#saved-compare-note')).toContainText('It does not rank the roads, score them, or recommend one');
  const text = (await table.innerText()).toLowerCase();
  for (const forbidden of ['winner', 'best road', 'score', 'recommended', '#1']) {
    expect(text, `the comparison must not say "${forbidden}"`).not.toContain(forbidden);
  }
  // A third column is allowed; a fourth selection is refused with the reason shown, not silently ignored.
  await box(ids[2]).check();
  await expect(table.locator('thead th')).toHaveCount(4);
  await expect(box(ids[3])).toBeDisabled();
  await expect(page.locator('#saved-compare-status')).toContainText('Up to 3 saved roads can be compared at once');
  // Clearing the comparison empties the table and frees every box.
  await page.locator('#saved-compare-clear').click();
  await expect(page.locator('#saved-compare-table')).toHaveCount(0);
  await expect(box(ids[3])).toBeEnabled();
  expect(titles.length).toBe(4);
  expect(external).toEqual([]);
});

test('removing a road being compared drops it from the comparison, and stays removed', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  await search(page, { lat: 45.54, lon: -123.17, radius: 10 });
  const title = await promote(page, 0);
  await favoriteSelected(page);
  await writeNote(page, 'remove me');
  const { ids, box } = await compareBoxes(page);
  await box(ids[0]).check();
  await expect(page.locator('#saved-compare-status')).toContainText('Select one more saved road');
  // Removing the selected road takes its annotation, its comparison slot and its card with it.
  await savedCard(page, title).locator('.saved-name').click();
  await expect(page.locator('#candidate-detail .detail-title')).toHaveText(title);
  await page.locator('#candidate-remove').click();
  await page.locator('#candidate-remove-confirm').click();
  await expect(page.locator('#saved-counts')).toContainText('Saved roads 0');
  await expect(page.locator('#saved-list .saved-card')).toHaveCount(0);
  // With nothing saved there is no comparison to make, and the panel says so instead of showing an empty table.
  await expect(page.locator('#saved-roads')).toContainText('No saved roads yet');
  await expect(page.locator('#saved-compare-table')).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelectorAll('#saved-list input[data-compare]:checked').length)).toBe(0);
  // And a reload keeps it gone, with no orphan annotation left in the entry.
  await reloadAndBoot(page);
  await expect(page.locator('#saved-counts')).toContainText('Saved roads 0');
  await expect(page.locator('#saved-list .saved-card')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('roadnaturalist.candidates.v1'))).toBe(null);
});

test('the saved collection, a note and a comparison stay usable at 390px', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await search(page, { lat: 45.54, lon: -123.17, radius: 10 });
  const first = await promote(page, 0);
  await favoriteSelected(page);
  await writeNote(page, 'A long note for a narrow screen: check the gate at the north end, and the culvert after heavy rain.');
  await promote(page, 1);
  expect(await savedCount(page)).toBe(2);
  // Reading and writing a note on a phone: the field, the status line and the card all stay inside the page.
  await expect(page.locator('#candidate-note')).toBeVisible();
  await expect(page.locator('#saved-counts')).toContainText('Saved roads 2 · Favorites 1 · Has notes 1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  // Comparing on a phone: the table scrolls sideways inside its own container instead of widening the document.
  await page.locator('#saved-list input[data-compare]').nth(0).check();
  await page.locator('#saved-list input[data-compare]').nth(1).check();
  await expect(page.locator('#saved-compare-table')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#saved-compare-table thead')).toContainText(first);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const scroller = await page.locator('.saved-compare-scroll').evaluate(node => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
  expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth, 'the comparison scrolls inside its own box');
  // The favorite and the note are still visible where a person left them.
  await expect(savedCard(page, first)).toContainText('Favorite ✓');
  await expect(savedCard(page, first)).toContainText('check the gate at the north end');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
