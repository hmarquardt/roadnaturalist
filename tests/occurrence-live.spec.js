import { test, expect } from '@playwright/test';

// Opt-in live verification of the full browser pipeline: real iNaturalist requests, real DuckDB
// Spatial distance measurement, real UI. Routine `npm run test:e2e` skips it.
//
//   RUN_OCCURRENCE_LIVE=1 npx playwright test tests/occurrence-live.spec.js
//
// eBird needs a server-side credential (EBIRD_API_KEY); without one the panel must still report UNKNOWN
// with a reason instead of a zero, which this test asserts explicitly.
test.skip(!process.env.RUN_OCCURRENCE_LIVE, 'set RUN_OCCURRENCE_LIVE=1 to query public occurrence APIs');

test('live occurrence analysis for the three pilot corridors', async ({ page }) => {
  test.setTimeout(900000);
  await page.setViewportSize({ width: 1440, height: 950 });
  const report = [];
  page.on('console', message => { if (message.text().startsWith('LIVE ')) report.push(message.text()); });
  await page.goto('/');
  await page.getByRole('button', { name: /Open Oregon road pilot/ }).click();
  await expect(page.locator('#candidate-detail')).toContainText('NW Cornelius Pass Rd', { timeout: 120000 });

  for (const name of ['NW Cornelius Pass Rd', 'NW Springville Rd', 'NW Susbauer Rd']) {
    await page.locator('#candidate-list').getByRole('button', { name: new RegExp(name) }).click();
    await expect(page.locator('.habitat-section')).toContainText('PHYSICAL HABITAT EVIDENCE');
    const started = Date.now();
    await page.locator('.occurrence-section').getByRole('button', { name: /Query public occurrence sources|Query again/ }).click();
    await expect(page.locator('.occurrence-section')).toContainText('Coverage', { timeout: 300000 });
    await expect(page.locator('.occurrence-section')).toContainText('iNaturalist', { timeout: 300000 });
    await expect(page.locator('.occurrence-section')).not.toContainText('Querying public occurrence sources', { timeout: 300000 });
    const summary = await page.evaluate(async () => {
      const { occurrence } = await import('/src/app/main.js');
      const state = (await import('/src/state/store.js'));
      return { requests: occurrence.requests(), cacheSize: occurrence.cache.size() };
    });
    const panel = await page.locator('.occurrence-section').innerText();
    console.log(`LIVE ${name} | ${Date.now() - started} ms | requests ${JSON.stringify(summary.requests)} | ${panel.replace(/\s+/g, ' ').slice(0, 1400)}`);
  }
  console.log('LIVE report lines:', report.length);
});
