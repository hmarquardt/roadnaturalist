import { test, expect } from '@playwright/test';

// Candidate storage benchmark (opt-in): what a stored candidate set costs to read, validate, hydrate and render.
//
//   RUN_CANDIDATE_STORAGE_BENCHMARK=1 npx playwright test tests/candidate-storage-benchmark.spec.js --reporter=line --retries=0
//
// It writes a real promoted candidate, replicates it to 0/10/50/100 records under the real key, reloads, and
// reports localStorage bytes, JSON parse, the read (parse + per-record validation) and the boot time until the
// candidate list is on screen. The numbers the documentation quotes come from here.
const CANDIDATES_KEY = 'roadnaturalist.candidates.v1';
const SIZES = [0, 10, 50, 100];

test.skip(!process.env.RUN_CANDIDATE_STORAGE_BENCHMARK,
  'The candidate storage benchmark is opt-in: it reloads the application repeatedly with a synthetic stored set');

test('benchmark storing 0, 10, 50 and 100 candidates', async ({ page }) => {
  test.setTimeout(1800000);
  await page.goto('/');
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  // One real promoted candidate, so the records measured are the records the application writes.
  await page.locator('#discovery-center-lat').fill('45.5400');
  await page.locator('#discovery-center-lon').fill('-123.1700');
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-radius-input').fill('5');
  await page.locator('#discovery-radius-input').press('Enter');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('5-mile radius search', { timeout: 180000 });
  await page.locator('#discovery-results tbody tr').first().locator('.discovery-row').click();
  await page.locator('#discovery-promote').click();
  await expect(page.locator('#candidate-detail #candidate-search-context'), { timeout: 180000 }).toBeVisible();
  const template = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).candidates[0], CANDIDATES_KEY);
  const rows = [];
  for (const count of SIZES) {
    await page.evaluate(({ key, template, count }) => {
      const candidates = Array.from({ length: count }, (_, index) => ({ ...template, id: `benchmark-candidate-${index}` }));
      localStorage.setItem(key, JSON.stringify({ kind: 'roadnaturalist-candidates', version: 1, savedAt: 'benchmark', candidates }));
      localStorage.removeItem('roadnaturalist.discovery.marks.v1');
      localStorage.removeItem('roadnaturalist.discovery.search.v1');
    }, { key: CANDIDATES_KEY, template, count });
    const started = Date.now();
    await page.reload();
    await expect(page.locator('#candidate-list .candidate-card')).toHaveCount(count, { timeout: 120000 });
    const bootMs = Date.now() - started;
    const measured = await page.evaluate(async key => {
      const { readStoredCandidates } = await import('/src/state/candidate-persistence.js');
      const text = localStorage.getItem(key) ?? '';
      const parseStarted = performance.now();
      const parsed = JSON.parse(text);
      const parseMs = performance.now() - parseStarted;
      const readStarted = performance.now();
      const read = readStoredCandidates();
      return { bytes: text.length, records: parsed?.candidates?.length ?? 0, restored: read.candidates.length,
        skipped: read.skipped.length, parseMs: Math.round((performance.now() - readStarted) * 100) / 100,
        totalReadMs: Math.round((performance.now() - parseStarted) * 100) / 100 };
    }, CANDIDATES_KEY);
    const entry = { count, bootMs, ...measured };
    rows.push(entry);
    console.log('CANDIDATE_STORAGE_BENCHMARK ' + JSON.stringify(entry));
  }
  await page.evaluate(key => localStorage.removeItem(key), CANDIDATES_KEY);
  expect(rows.map(row => row.restored)).toEqual(SIZES);
  const budget = rows[rows.length - 1];
  expect(budget.totalReadMs).toBeLessThan(250);
  expect(budget.bootMs).toBeLessThan(5000);
});
