import { test, expect } from '@playwright/test';

// TEMPORARY production promotion probe (deleted before the final tree check).
const BASE = process.env.PROBE_BASE ?? 'https://roadnaturalist.pages.dev';

test('probe: deployed promotion diagnosis', async ({ page }) => {
  test.setTimeout(900000);
  const events = [];
  page.on('console', message => events.push(`console.${message.type()}: ${message.text().slice(0, 200)}`));
  page.on('pageerror', error => events.push(`pageerror: ${error.message.slice(0, 300)}`));
  page.on('requestfailed', request => events.push(`requestfailed: ${request.url().slice(0, 160)} ${request.failure()?.errorText}`));
  page.on('response', response => { if (response.status() >= 400) events.push(`http${response.status()}: ${response.url().slice(0, 160)}`); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 120000 });
  await page.locator('#discovery-area').selectOption('or-portland-west-regional');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery')).toContainText('metric cell(s) selected', { timeout: 300000 });
  await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 120000 });
  const fullRow = page.locator('#discovery-results tbody tr').filter({ has: page.locator('td:text-is("FULL")') }).first();
  await fullRow.locator('.discovery-row').click();
  await expect(page.locator('#discovery-selected')).toContainText('Mapped wetland within 250 m');
  let resourcesBefore = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).length);
  console.log('PROBE resources before promote=' + resourcesBefore);
  await page.locator('#discovery-promote').click();
  const started = Date.now();
  for (let tick = 1; tick <= 18; tick += 1) {
    await page.waitForTimeout(10000);
    const state = await page.evaluate(() => ({
      candidates: document.querySelector('#candidate-count')?.textContent ?? null,
      habitat: Boolean(document.querySelector('.habitat-section')),
      detail: document.querySelector('#candidate-detail .detail-title')?.textContent ?? null,
      resources: performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.includes('roadnaturalist') || name.includes('jsdelivr')),
    }));
    const fresh = state.resources.slice(resourcesBefore);
    resourcesBefore = state.resources.length;
    console.log(`PROBE t+${Math.round((Date.now() - started) / 1000)}s candidates=${state.candidates} habitat=${state.habitat} detail=${JSON.stringify(state.detail)}`);
    console.log(`PROBE fetched t+${Math.round((Date.now() - started) / 1000)}s ${JSON.stringify(fresh.map(url => url.replace('https://data.roadnaturalist.com/', 'r2:').replace('https://roadnaturalist.pages.dev/', 'pages:').slice(0, 110)))}`);
    if (state.habitat) break;
  }
  console.log('PROBE events:\n' + events.join('\n'));
});
