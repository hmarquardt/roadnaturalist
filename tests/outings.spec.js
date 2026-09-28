import { test, expect } from '@playwright/test';

// OUTINGS IN A BROWSER: PLANS, NOT ROUTES.
//
// Create an outing from saved roads, name it, date it, write a note, add a checklist item, change the order with
// the buttons, mark it done, and find all of it again after a reload - with the roads still saved and with no
// network read to restore any of it. Nothing here asserts a route, a distance between roads or a travel time,
// because the application does not compute any of those.
async function boot(page) {
  await page.goto('/');
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
}

async function quiet(page) { await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}); }

function watchDataReads(page) {
  const reads = [];
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/regional/partitions/') || url.includes('/derived/') || url.includes('data.roadnaturalist.com')
      || /\/gis\/[^/]+\.(parquet|json|fgb|geojson)$/.test(new URL(url).pathname)) reads.push(url);
  });
  return reads;
}

async function savedCount(page) {
  const text = await page.locator('#saved-counts').innerText({ timeout: 5000 }).catch(() => 'Saved roads 0');
  return Number(/Saved roads (\d+)/.exec(text)?.[1] ?? 0);
}

// Promote `count` corridors from one search, waiting for each to be saved before the next.
async function saveRoads(page, count) {
  await page.locator('#discovery-center-lat').fill('45.5400');
  await page.locator('#discovery-center-lon').fill('-123.1700');
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-radius-input').fill('10');
  await page.locator('#discovery-radius-input').press('Enter');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('10-mile radius search', { timeout: 180000 });
  for (let index = 0; index < count; index += 1) {
    const before = await savedCount(page);
    const row = page.locator('#discovery-results tbody tr').nth(index);
    const previous = await page.locator('#discovery-selected h3').count() ? page.locator('#discovery-selected h3').innerText() : '';
    await row.locator('.discovery-row').click();
    await expect.poll(async () => page.locator('#discovery-selected h3').innerText().catch(() => ''), { timeout: 60000 }).not.toBe(previous);
    await page.locator('#discovery-promote').click();
    await expect(page.locator('#candidate-user')).toBeVisible({ timeout: 180000 });
    await expect.poll(() => savedCount(page), { timeout: 60000 }).toBeGreaterThan(before);
  }
  await expect(page.locator('#saved-counts')).toContainText(`Saved roads ${count}`, { timeout: 60000 });
}

test('an outing is created from saved roads and comes back after a reload', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  await saveRoads(page, 3);
  // Choose two roads for planning (a separate choice from comparing), then create the outing.
  await page.locator('#saved-list input[data-plan]').nth(0).check();
  await page.locator('#saved-list input[data-plan]').nth(1).check();
  await expect(page.locator('#saved-planning-status')).toContainText('2 roads chosen');
  await page.locator('#saved-create-outing').click();
  await expect(page.locator('#outings-counts')).toContainText('Outings 1');
  await expect(page.locator('#outing-roads li')).toHaveCount(2);
  // Name it, date it, write the plan's own words, and add a checklist item.
  await page.locator('#outing-title').fill('Saturday wildlife loop');
  await page.locator('#outing-title').blur();
  await page.locator('#outing-date').fill('2026-10-03');
  await page.locator('#outing-notes').fill('Start shortly after sunrise. Lunch in Vernonia.');
  await page.locator('#outing-notes').blur();
  await page.locator('#outing-new-item').fill('Binoculars');
  await page.locator('#outing-add-item-button').click();
  await expect(page.locator('#outing-checklist li')).toHaveCount(1);
  // The order is the person's: C moves above B, and the ends stay put.
  const before = await page.locator('#outing-roads li').evaluateAll(nodes => nodes.map(node => node.dataset.roadId));
  await page.locator('#outing-roads li').nth(1).locator('[data-direction="up"]').click();
  const after = await page.locator('#outing-roads li').evaluateAll(nodes => nodes.map(node => node.dataset.roadId));
  expect(after).toEqual([before[1], before[0]]);
  await expect(page.locator('#outing-roads li').first().locator('[data-direction="up"]')).toBeDisabled();
  await expect(page.locator('#outing-roads li').last().locator('[data-direction="down"]')).toBeDisabled();
  // RELOAD: the plan, its order, its note and its checklist come back from this device alone.
  await quiet(page);
  const reads = watchDataReads(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  await expect(page.locator('#outings-counts')).toContainText('Outings 1');
  // A reload shows the plan list; opening a plan is a deliberate click, exactly as the workspace intends.
  await page.locator('.outing-name').first().click();
  await expect(page.locator('#outing-title')).toHaveValue('Saturday wildlife loop');
  await expect(page.locator('#outing-date')).toHaveValue('2026-10-03');
  await expect(page.locator('#outing-notes')).toHaveValue('Start shortly after sunrise. Lunch in Vernonia.');
  await expect(page.locator('#outing-checklist li')).toHaveCount(1);
  expect(await page.locator('#outing-roads li').evaluateAll(nodes => nodes.map(node => node.dataset.roadId))).toEqual(after);
  await expect(page.locator('#saved-counts')).toContainText('Saved roads 3', 'the roads are still saved');
  expect(reads).toEqual([]);
});

test('marking an outing complete, and removing it, leaves every road saved', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  await saveRoads(page, 2);
  await page.locator('#saved-list input[data-plan]').nth(0).check();
  await page.locator('#saved-create-outing').click();
  await expect(page.locator('#outing-roads li')).toHaveCount(1);
  await page.locator('[data-outing-status="completed"]').click();
  await expect(page.locator('[data-outing-status="completed"]')).toHaveAttribute('aria-pressed', 'true');
  await quiet(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  await expect(page.locator('#outings-counts')).toContainText('Outings 1 · Planned 0 · Completed 1');
  await page.locator('.outing-name').first().click();
  // Removing the outing removes the plan and nothing else.
  await page.locator('#outing-remove-button').click();
  await page.locator('#outing-remove-confirm').click();
  await expect(page.locator('#outings-counts')).toContainText('Outings 0');
  await expect(page.locator('#saved-counts')).toContainText('Saved roads 2', 'the roads stay saved');
  await expect(page.locator('#outing-list')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('roadnaturalist.outings.v1'))).toBe(null);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('roadnaturalist.candidates.v1')).candidates.length)).toBe(2);
});
