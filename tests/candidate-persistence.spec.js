import { test, expect } from '@playwright/test';

// CANDIDATES KEPT ON THIS DEVICE.
//
// A promoted corridor should be something a person keeps. These tests drive the whole loop in a browser: promote,
// reload, and find the same corridor with the same identity, the same verified search context and the same
// status - with no discovery run, no analysis and no request to anything outside this origin.
const CANDIDATES_KEY = 'roadnaturalist.candidates.v1';
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

// Every read of a *data file* this app makes (not a module), so a restore can be held to "no R2, no discovery
// plane, no habitat or ecoregion extract".
function watchDataReads(page) {
  const reads = [];
  page.on('request', request => {
    const url = request.url();
    const path = new URL(url).pathname;
    if (url.includes('/regional/partitions/') || url.includes('/derived/') || url.includes('data.roadnaturalist.com')
      || /\/gis\/[^/]+\.(parquet|json|fgb|geojson)$/.test(path)) reads.push(url);
  });
  return reads;
}

// The application fetches many files at once (modules, GeoParquet extracts, regional partitions) and a promotion
// keeps resolving habitat for a moment afterwards. A person would not reload mid-download either, so the tests
// wait for the page to go quiet first - bounded and best effort, so a page that never goes fully idle cannot
// fail the test on its own.
async function waitForQuietNetwork(page, { timeout = 20000 } = {}) {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
}

// A boot is watched for its own failures: if the workspace never becomes interactive, the message carries what
// the page reported (an exception, a failed request) instead of only "element not found".
function watchBoot(page) {
  const problems = [];
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  page.on('requestfailed', request => problems.push(`request failed: ${request.url()} (${request.failure()?.errorText ?? 'no reason'})`));
  return problems;
}

async function expectBooted(page, problems) {
  try {
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  } catch (error) {
    throw new Error(`${error.message.split('\n')[0]} | boot diagnostics: ${problems.join(' | ') || 'nothing reported'}`);
  }
}

async function boot(page) {
  const problems = watchBoot(page);
  await page.goto('/');
  await expectBooted(page, problems);
}

// A reload, waited on the same boot signal the first load uses: the workspace is interactive once the discovery
// button is enabled, so nothing is asserted against a half-booted page.
async function reloadAndBoot(page) {
  const problems = watchBoot(page);
  await waitForQuietNetwork(page);
  await page.reload();
  await expectBooted(page, problems);
}

async function applyCoordinates(page, { lat, lon }, radius) {
  await page.locator('#discovery-center-lat').fill(lat.toFixed(4));
  await page.locator('#discovery-center-lon').fill(lon.toFixed(4));
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-radius-input').fill(String(radius));
  await page.locator('#discovery-radius-input').press('Enter');
  await expect(page.locator('#discovery-radius-value')).toHaveText(`${radius} mi`);
}

async function runSearch(page, radius) {
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText(`${radius}-mile radius search`, { timeout: 180000 });
}

// Promote one row and wait until it is a candidate *and* written to this device, so the next action never races
// the asynchronous promotion (raw reconstruction, verification, and the analysis that follows it).
async function promoteRow(page, index) {
  const row = page.locator('#discovery-results tbody tr').nth(index);
  await expect(row).toBeVisible({ timeout: 60000 });
  const rowDistance = (await row.locator('td').nth(2).innerText()).trim();
  const name = (await row.locator('.discovery-row').innerText()).trim();
  await row.locator('.discovery-row').click();
  await expect(page.locator('#discovery-selected h3')).toContainText(name, { timeout: 60000 });
  await page.locator('#discovery-promote').click();
  const before = (await storedIds(page)).length;
  await expect.poll(async () => (await storedIds(page)).length, { timeout: 180000 }).toBeGreaterThan(before);
  const context = page.locator('#candidate-detail #candidate-search-context');
  await expect(context).toBeVisible({ timeout: 180000 });
  const headline = await context.locator('.search-context-headline').innerText();
  const title = await page.locator('#candidate-detail .detail-title').innerText();
  return { rowDistance, headline, title };
}

// Promote the first corridor the search returned.
async function promoteFirst(page) {
  return promoteRow(page, 0);
}

async function storedCandidates(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), CANDIDATES_KEY);
}

async function storedIds(page) {
  const stored = await storedCandidates(page);
  return (stored?.candidates ?? []).map(candidate => candidate.id);
}

test('a promoted candidate is still there after a reload, with the same corridor and search context', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await boot(page);
  await applyCoordinates(page, { lat: 45.54, lon: -123.17 }, 5);
  await runSearch(page, 5);
  const promoted = await promoteFirst(page);
  expect(promoted.headline).toBe(`${promoted.rowDistance} of Near Forest Grove, OR`);
  const ids = await storedIds(page);
  expect(ids.length).toBe(1);
  await expect(page.locator('#candidate-persistence')).toContainText('Saved on this device');
  await expect(page.locator('#candidate-persistence')).not.toContainText('came back from local storage');
  // A status change is candidate state, so it is written with the candidate.
  await page.getByRole('button', { name: 'Shortlist' }).click();
  await expect(page.locator('#candidate-status')).toHaveText('shortlisted');

  // RELOAD. Restoring a candidate is a local read: no discovery run, no derivation, no analysis, no R2.
  await waitForQuietNetwork(page);
  const reads = watchDataReads(page);
  await page.reload();
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  const title = page.locator('#candidate-detail .detail-title');
  await expect(title).toHaveText(promoted.title, { timeout: 60000 });
  await expect(page.locator('#candidate-status')).toHaveText('shortlisted');
  await expect(page.locator('#candidate-detail #candidate-search-context .search-context-headline')).toHaveText(promoted.headline);
  await expect(page.locator('#candidate-detail #candidate-search-context')).toContainText('Near Forest Grove, OR · 45.5400, -123.1700');
  // The restored candidate says where it came from, and that its detailed analysis is this session's to run.
  await expect(page.locator('#candidate-persistence')).toContainText('came back from local storage');
  await expect(page.locator('#candidate-restored-note, #candidate-persistence')).toContainText('this session has not measured this corridor yet');
  await expect(page.locator('#candidate-run-analysis')).toBeVisible();
  // The map draws the restored corridor and its search centre without fetching anything.
  await expect(page.locator('#map svg .road')).toHaveCount(1);
  await expect(page.locator('#map svg .candidate-context-line')).toHaveCount(1);
  expect(await page.locator('#candidate-list .candidate-card').count()).toBe(1);
  expect(await storedIds(page)).toEqual(ids);
  expect(reads).toEqual([]);
  expect(external).toEqual([]);
});

test('two promoted candidates survive a reload, and removing one stays removed', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await boot(page);
  await applyCoordinates(page, { lat: 45.54, lon: -123.17 }, 5);
  await runSearch(page, 5);
  const first = await promoteFirst(page);
  // RELOAD, then a second promotion: a restored candidate is not lost when another corridor is promoted after it.
  await reloadAndBoot(page);
  await expect(page.locator('#candidate-list .candidate-card')).toHaveCount(1);
  await runSearch(page, 5);
  await promoteRow(page, 1);
  await expect(page.locator('#candidate-list .candidate-card')).toHaveCount(2, { timeout: 180000 });
  const ids = await storedIds(page);
  expect(ids.length).toBe(2);
  // RELOAD: both candidates are restored from this device.
  await reloadAndBoot(page);
  await expect(page.locator('#candidate-list .candidate-card')).toHaveCount(2, { timeout: 60000 });
  expect((await storedIds(page)).sort()).toEqual([...ids].sort());
  // The first restored candidate is the one on screen; the second is one click away.
  await expect(page.locator('#candidate-detail .detail-title')).toHaveText(first.title);
  // REMOVAL: two steps, so a stray click cannot do it.
  const removal = page.locator('#candidate-removal');
  await expect(removal).toContainText('Removing takes this candidate off this device');
  await page.locator('#candidate-remove').click();
  await expect(page.locator('#candidate-remove-confirm')).toBeVisible();
  await page.locator('#candidate-remove-cancel').click();
  await expect(page.locator('#candidate-remove')).toBeVisible();
  await expect(page.locator('#candidate-list .candidate-card')).toHaveCount(2);
  await page.locator('#candidate-remove').click();
  await page.locator('#candidate-remove-confirm').click();
  await expect(page.locator('#candidate-list .candidate-card')).toHaveCount(1, { timeout: 60000 });
  const remaining = await storedIds(page);
  expect(remaining.length).toBe(1);
  expect(remaining).not.toContain(ids[0]);
  await reloadAndBoot(page);
  await expect(page.locator('#candidate-list .candidate-card')).toHaveCount(1, { timeout: 60000 });
  expect(await storedIds(page)).toEqual(remaining);
  await expect(page.locator('#candidate-detail #candidate-search-context')).toBeVisible();
  expect(external).toEqual([]);
});

test('a corrupt stored record is left out without taking the readable ones with it', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await boot(page);
  await applyCoordinates(page, { lat: 45.54, lon: -123.17 }, 5);
  await runSearch(page, 5);
  const promoted = await promoteFirst(page);
  // The promotion's own analysis keeps writing the entry for a moment, and every write rewrites it from the
  // durable set in memory: damage the entry once the page is quiet, so the damage is what the next boot reads.
  await waitForQuietNetwork(page);
  // Damage the entry the way a hand edit, a truncated write or an older build might: one record in the middle
  // that cannot be read, and a future schema version is *not* what this simulates - the version stays ours.
  await page.evaluate(key => {
    const entry = JSON.parse(localStorage.getItem(key));
    entry.candidates.splice(1, 0, { id: 'broken-record', name: 'Broken record', status: 'discovered', roads: [] });
    localStorage.setItem(key, JSON.stringify(entry));
  }, CANDIDATES_KEY);
  await page.reload();
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  await expect(page.locator('#candidate-detail .detail-title')).toHaveText(promoted.title, { timeout: 60000 });
  await expect(page.locator('#candidate-list .candidate-card')).toHaveCount(1);
  const note = page.locator('#candidate-storage-skipped');
  await expect(note).toBeVisible();
  await expect(note).toContainText('1 stored candidate record(s) could not be read and were left out');
  await expect(note).toContainText('broken-record');
  await expect(note).toContainText('no usable road records');
  // The unreadable record is reported, not silently deleted: it is still in the entry.
  const stored = await storedCandidates(page);
  expect(stored.candidates.length).toBe(2);
  expect(stored.candidates.some(candidate => candidate.id === 'broken-record')).toBe(true);
  expect(external).toEqual([]);
});

test('a corridor promoted from the declared window restores with no search context and no invented centre', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await boot(page);
  // The declared pilot window is a box, not a radius: no centre, so no bearing and no distance.
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery')).toContainText('Discovery coverage', { timeout: 300000 });
  const row = page.locator('#discovery-results tbody tr').first();
  await expect(row).toBeVisible({ timeout: 120000 });
  await row.locator('.discovery-row').click();
  await page.locator('#discovery-promote').click();
  const title = page.locator('#candidate-detail .detail-title');
  await expect(title).toBeVisible({ timeout: 300000 });
  const promotedTitle = await title.innerText();
  await expect(page.locator('#candidate-detail #candidate-search-context')).toHaveCount(0);
  const ids = await storedIds(page);
  expect(ids.length).toBe(1);
  await reloadAndBoot(page);
  await expect(title).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#candidate-detail #candidate-search-context')).toHaveCount(0);
  await expect(page.locator('#candidate-persistence')).toContainText('came back from local storage');
  // A bounded window's corridor is kept, and nothing was invented to describe where it was found.
  expect(await storedIds(page)).toEqual(ids);
  expect(await storedCandidates(page).then(stored => stored.candidates[0].searchContext)).toBe(null);
  // The pilot corridors themselves are not written: they come back from their own button, and loading them adds
  // to the list instead of replacing it.
  await page.locator('#load-pilot').click();
  await expect(page.locator('#load-pilot')).toHaveText('Road pilot loaded', { timeout: 300000 });
  await expect.poll(async () => page.locator('#candidate-list .candidate-card').count(), { timeout: 60000 }).toBeGreaterThan(1);
  await expect(page.locator('#candidate-list .candidate-card').first()).toContainText(promotedTitle);
  expect(await storedIds(page)).toEqual(ids);
  expect(external).toEqual([]);
});

test('a restored candidate and its removal stay usable at 390px', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  const external = await watchExternal(page);
  await boot(page);
  await applyCoordinates(page, { lat: 45.54, lon: -123.17 }, 5);
  await runSearch(page, 5);
  const promoted = await promoteFirst(page);
  await reloadAndBoot(page);
  const detail = page.locator('#candidate-detail');
  await expect(detail.locator('.detail-title')).toHaveText(promoted.title, { timeout: 60000 });
  await expect(detail.locator('#candidate-search-context .search-context-headline')).toHaveText(promoted.headline);
  await expect(detail.locator('#candidate-persistence')).toContainText('came back from local storage');
  await expect(page.locator('#candidate-run-analysis')).toBeVisible();
  await expect(page.locator('#candidate-remove')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  // Removal works on a phone-sized layout, and the empty state is honest about there being nothing here.
  await page.locator('#candidate-remove').click();
  await page.locator('#candidate-remove-confirm').click();
  await expect(page.locator('#candidate-list .candidate-card')).toHaveCount(0, { timeout: 60000 });
  await expect(detail).toContainText('Investigation starts with a road');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  // The removed candidate does not come back, and the entry is gone rather than left empty.
  await reloadAndBoot(page);
  await expect(page.locator('#candidate-list .candidate-card')).toHaveCount(0, { timeout: 60000 });
  expect(await page.evaluate(key => localStorage.getItem(key), CANDIDATES_KEY)).toBe(null);
  expect(external).toEqual([]);
});
