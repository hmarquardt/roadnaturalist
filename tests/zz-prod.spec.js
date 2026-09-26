import { test, expect } from '@playwright/test';
const BASE = 'https://roadnaturalist.pages.dev';
const EXTERNAL_HOSTS = /^https?:\/\/(?:[^/]*\.)?(?:inaturalist\.org|ebird\.org|overpass-api\.de|overpass\.kumi\.systems|openstreetmap\.org|roadnaturalist\.com)(?::\d+)?\//i;
test('deployed discovery workspace surveys the pilot area', async ({ page }) => {
  test.setTimeout(300000);
  const external = [];
  page.on('request', request => { if (EXTERNAL_HOSTS.test(request.url())) external.push(request.url()); });
  await page.goto(BASE);
  await expect(page.locator('#discover-roads')).toBeVisible({ timeout: 60000 });
  const started = Date.now();
  await page.click('#discover-roads');
  await expect(page.locator('#discovery')).toContainText('Discovery coverage', { timeout: 180000 });
  console.log('RUN_MS ' + (Date.now() - started));
  console.log('COVERAGE ' + (await page.locator('#discovery').innerText()).split('\n').slice(0, 12).join(' | '));
  console.log('COUNT ' + await page.locator('#discovery-count').innerText());
  const named = ['NW Cornelius Pass Rd', 'NW Springville Rd', 'NW Susbauer Rd'];
  for (const name of named) {
    const row = page.locator('.discovery-row', { hasText: name }).first();
    const present = await row.count();
    let detail = 'not proposed';
    if (present) {
      await row.click();
      detail = (await page.locator('#discovery-selected').innerText()).replace(/\n/g, ' | ').slice(0, 260);
    }
    console.log(`ROAD ${name} :: ${present ? 'proposed' : 'absent'} :: ${detail}`);
  }
  console.log('EXTERNAL ' + JSON.stringify(external));
});
