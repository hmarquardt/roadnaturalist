import { test, expect } from '@playwright/test';

// Opt-in verification of the *deployed* saved-roads workflow in a real browser.
//
//   RUN_SAVED_ROADS_PRODUCTION=1 npm run verify:saved-roads:production
//   PRODUCTION_BASE_URL=https://roadnaturalist.pages.dev RUN_SAVED_ROADS_PRODUCTION=1 npx playwright test tests/saved-roads-production.spec.js
//
// The whole promise, against the release: promote two roads, favorite one and write a note about it, reload and
// find both saved roads with their annotation intact, compare them fact by fact without a verdict, remove one and
// find it gone with the other untouched, and prove that opening the saved collection asks the network for
// nothing at all. It also confirms the ordinary discovery path still works beside it.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
const EVIDENCE = /api\.inaturalist|api\.ebird|overpass|api\.roadnaturalist\.com|nominatim|geocod|maps\.googleapis|api\.mapbox/i;
const CENTRE = { lat: 45.54, lon: -123.17 };

function log(label, value) { console.log(`SAVED_ROADS_PRODUCTION ${JSON.stringify({ [label]: value })}`); }

async function boot(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
}

// Progress markers, so a stalled deployed run says which step it stalled in rather than only "1/1".
let step = 0;
function mark(label) { console.log(`SAVED_ROADS_STEP ${++step} ${label}`); }

async function savedCount(page) {
  const text = await page.locator('#saved-counts').innerText().catch(() => 'Saved roads 0');
  return Number(/Saved roads (\d+)/.exec(text)?.[1] ?? 0);
}

test.skip(!process.env.RUN_SAVED_ROADS_PRODUCTION, 'The deployed saved-roads check is opt-in: it promotes real corridors in the production workspace');

test('a deployed saved road keeps its favorite and its note through reload, comparison and removal', async ({ page }) => {
  test.slow();
  page.setDefaultTimeout(240000);
  const outside = [];
  page.on('request', request => { if (EVIDENCE.test(request.url()) && !request.url().startsWith(BASE)) outside.push(request.url()); });
  const partitions = [];
  const derived = [];
  page.on('request', request => {
    if (request.url().includes('/regional/partitions/')) partitions.push(request.url());
    if (request.url().includes('/derived/corridor-metrics/')) derived.push(request.url());
  });
  mark('boot');
  await boot(page);
  mark('booted');

  // 1. ONE ORDINARY SEARCH, TWO PROMOTED ROADS.
  await page.locator('#discovery-center-lat').fill(CENTRE.lat.toFixed(4));
  await page.locator('#discovery-center-lon').fill(CENTRE.lon.toFixed(4));
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-radius-input').fill('10');
  await page.locator('#discovery-radius-input').press('Enter');
  mark('search');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('10-mile radius search', { timeout: 300000 });
  mark('searched');
  log('search', { summary: (await page.locator('#discovery-summary').innerText()).replace(/\s+/g, ' ').slice(0, 200) });
  const promoted = [];
  for (const index of [0, 1]) {
    const before = await savedCount(page);
    const row = page.locator('#discovery-results tbody tr').nth(index);
    const previous = (await page.locator('#discovery-selected h3').count() ? page.locator('#discovery-selected h3').innerText() : '');
    await row.locator('.discovery-row').click();
    await expect.poll(async () => page.locator('#discovery-selected h3').innerText().catch(() => ''), { timeout: 120000 }).not.toBe(previous);
    mark(`promote ${index}`);
    await page.locator('#discovery-promote').click();
    await expect(page.locator('#candidate-user')).toBeVisible({ timeout: 240000 });
    mark(`promoted ${index}`);
    await expect.poll(() => savedCount(page)).toBeGreaterThan(before);
    promoted.push(await page.locator('#candidate-detail .detail-title').innerText());
  }
  log('promoted', promoted);
  expect(new Set(promoted).size).toBe(2);

  // 2. FAVORITE ONE, AND WRITE A NOTE ABOUT IT. The annotation is the person's own, and the panel says so.
  // The annotation belongs to the road that is on screen: the last one promoted. Name it, rather than
  // assuming which half of the pair it is.
  const annotated = await page.locator('#candidate-detail .detail-title').innerText();
  const other = promoted.find(title => title !== annotated);
  expect(other, 'the two promoted roads are different roads').toBeTruthy();
  const note = 'Production check: gate at the north end, culvert after heavy rain.';
  await page.locator('#candidate-favorite').click();
  await expect(page.locator('#candidate-favorite')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#candidate-note').fill(note);
  mark('note');
  await expect(page.locator('#candidate-note-status')).toContainText('Saved on this device', { timeout: 60000 });
  mark('noted');
  await expect(page.locator('#saved-counts')).toContainText('Saved roads 2 · Favorites 1 · Has notes 1');
  log('annotation', { road: annotated, count: await page.locator('#saved-counts').innerText(), note });

  // 3. RELOAD: both saved roads come back with the annotation, and opening them asks for nothing.
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  const derivedBefore = derived.length;
  const partitionsBefore = partitions.length;
  mark('reload 1');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  mark('reloaded 1');
  await expect(page.locator('#saved-counts')).toContainText('Saved roads 2 · Favorites 1 · Has notes 1');
  await expect(page.locator('#saved-list .saved-card')).toHaveCount(2);
  const card = page.locator('#saved-list .saved-card').filter({ hasText: annotated }).first();
  await expect(card).toContainText('Favorite ✓');
  await expect(card).toContainText('Production check: gate at the north end');
  await card.locator('.saved-name').click();
  await expect(page.locator('#candidate-detail .detail-title')).toHaveText(annotated);
  await expect(page.locator('#candidate-note')).toHaveValue(note);
  await expect(page.locator('#candidate-user')).toContainText('It is not evidence');
  log('restore', { derivedReads: derived.length - derivedBefore, partitionReads: partitions.length - partitionsBefore,
    cards: await page.locator('#saved-list .saved-card').count() });
  expect(derived.length - derivedBefore).toBe(0);
  expect(partitions.length - partitionsBefore).toBe(0);

  // 4. COMPARE THE TWO: facts side by side, and no verdict anywhere in the table.
  await page.locator('#saved-list input[data-compare]').nth(0).check();
  await page.locator('#saved-list input[data-compare]').nth(1).check();
  mark('compare');
  const table = page.locator('#saved-compare-table');
  await expect(table).toBeVisible({ timeout: 60000 });
  mark('compared');
  await expect(table).toContainText('From original search centre');
  await expect(table).toContainText('Not measured this session');
  const text = (await table.innerText()).toLowerCase();
  for (const forbidden of ['winner', 'best', 'score', 'recommended', '#1']) expect(text).not.toContain(forbidden);
  log('comparison', { columns: await table.locator('thead th').count(), rows: await table.locator('tbody tr').count() });

  // Put both roads in an outing before removing one. The other road must stay in the plan.
  await page.locator('#saved-list input[data-plan]').nth(0).check();
  await page.locator('#saved-list input[data-plan]').nth(1).check();
  await expect(page.locator('#saved-planning-status')).toContainText('2 roads chosen');
  await page.locator('#saved-create-outing').click();
  await expect(page.locator('#outings-counts')).toContainText('Outings 1');
  await expect(page.locator('#outing-roads li')).toHaveCount(2);
  await expect(page.locator('#outing-roads')).toContainText(annotated);
  await expect(page.locator('#outing-roads')).toContainText(other);
  mark('outing created');

  // 5. REMOVE THE ANNOTATED ROAD: it goes, its favorite and its note go with it, and the other road stays.
  mark('remove');
  await page.locator('#candidate-remove').click();
  await expect(page.locator('#candidate-remove-confirm')).toHaveText('Remove everywhere');
  await page.locator('#candidate-remove-confirm').click();
  mark('removed');
  await expect.poll(() => savedCount(page)).toBe(1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  await expect(page.locator('#saved-counts')).toContainText('Saved roads 1 · Favorites 0 · Has notes 0');
  await expect(page.locator('#saved-list .saved-card')).toHaveCount(1);
  await expect(page.locator('#saved-list .saved-card')).toContainText(other);
  await expect(page.locator('#saved-list')).not.toContainText(annotated);
  await expect(page.locator('#saved-list')).not.toContainText('Production check: gate at the north end');
  await expect(page.locator('#outings-counts')).toContainText('Outings 1');
  await page.locator('.outing-name').first().click();
  await expect(page.locator('#outing-roads li')).toHaveCount(1);
  await expect(page.locator('#outing-roads')).toContainText(other);
  await expect(page.locator('#outing-roads')).not.toContainText(annotated);
  await page.locator('#saved-list .saved-name').click();
  await expect(page.locator('#candidate-detail .detail-title')).toHaveText(other);
  await expect(page.locator('#candidate-note')).toHaveValue('');
  log('removal', { remaining: other, gone: annotated });

  expect(outside, 'a saved-roads workflow must reach no occurrence, Investigator, geocoder or OSM endpoint').toEqual([]);
  log('externalRequests', outside.length);
});
