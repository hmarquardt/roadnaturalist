import { test, expect } from '@playwright/test';

// Opt-in verification of the deployed production path, end to end in a real browser:
//
//   roadnaturalist.com -> corridor -> Re-check access evidence -> api.roadnaturalist.com -> official sources
//     -> normalized facts -> Investigator stages -> deterministic finding
//
//   npm run verify:production:browser
//   PRODUCTION_BASE_URL=https://roadnaturalist.pages.dev npm run verify:production:browser
//
// Routine `npm run test:e2e` skips it: it talks to the deployed Worker and to real county sites, so it is a
// verification tool rather than a deterministic test. It asserts the *shape* of a healthy live run (a live read, a
// named coverage state, a finding from the published vocabulary, no error) and prints what it saw, because a source
// that throttles today must not turn a verification run into a false failure.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.com';
const CORRIDORS = ['NW Cornelius Pass Rd', 'NW Springville Rd', 'NW Susbauer Rd'];
const FINDING_LABELS = ['VERIFIED PUBLIC', 'PROBABLE PUBLIC', 'UNVERIFIED', 'CONFLICTED', 'RESTRICTED OR CLOSED'];

test.skip(!process.env.RUN_PRODUCTION_LIVE, 'set RUN_PRODUCTION_LIVE=1 to exercise the deployed Worker from a browser');

test('production access research runs live through the deployed Worker for all three pilot corridors', async ({ page }) => {
  test.setTimeout(900000);
  await page.setViewportSize({ width: 1440, height: 950 });
  const direct = [];
  const errors = [];
  page.on('request', request => { const host = new URL(request.url()).hostname;
    if (/(washingtoncountyor|wc-roads|multco\.us|govdelivery)/.test(host)) direct.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));

  const report = [];
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#candidate-list')).toContainText('No corridor loaded', { timeout: 90000 });
  await page.getByRole('button', { name: /Open Oregon road pilot/ }).click();
  await expect(page.locator('.candidate-card')).toHaveCount(3, { timeout: 180000 });

  for (const name of CORRIDORS) {
    await page.locator('.candidate-card', { hasText: name }).first().click();
    const section = page.locator('.access-section');
    await expect(section).toBeVisible({ timeout: 90000 });
    await expect(section).toContainText('live through the Road Naturalist Worker boundary', { timeout: 60000 });

    // First run for this corridor: the sources have not been read by this colo yet.
    await section.getByRole('button', { name: /Run access investigation|Re-check access evidence/ }).click();
    await expect(section.locator('.access-finding-label')).toBeVisible({ timeout: 240000 });

    const read = async () => section.evaluate(node => {
      const text = node.innerText;
      const pick = pattern => new RegExp(pattern).exec(text)?.[1] ?? null;
      return {
        finding: node.querySelector('.access-finding-label')?.textContent?.trim() ?? null,
        coverage: pick('Access verification coverage\\n?([A-Z]+)'),
        reads: pick('(Source reads:[^\\n]+)'),
        boundary: new RegExp('(Official-source research:[^\\n]+)').exec(text)?.[1] ?? null,
        failureLine: new RegExp('(\\d+ source request\\(s\\) failed)').exec(text)?.[1] ?? null,
        liveSources: (node.innerText.match(/live read \\(worker boundary\\)/g) ?? []).length,
        cachedSources: (node.innerText.match(/cache read \\(worker boundary\\)/g) ?? []).length,
        replayedSources: (node.innerText.match(/replayed from the reviewed capture/g) ?? []).length,
        note: document.querySelector('#access-note')?.textContent?.trim() ?? null,
      };
    });

    const first = await read();
    // A second run within the declared TTLs must be served from the Worker's cache without re-reading a source.
    await section.getByRole('button', { name: 'Re-check access evidence' }).click();
    await expect(section.locator('.access-finding-label')).toBeVisible({ timeout: 240000 });
    const second = await read();
    report.push({ corridor: name, first, second });

    expect(second.boundary).toContain('api.roadnaturalist.com');
    expect(FINDING_LABELS).toContain(second.finding);
    expect(second.liveSources + second.cachedSources, `${name}: no source was read through the boundary`).toBeGreaterThan(0);
    expect(second.replayedSources, `${name}: the boundary answered, so nothing should be a capture replay`).toBe(0);
    expect(['FULL', 'PARTIAL']).toContain(second.coverage);
    expect(second.cachedSources, `${name}: the repeat run should have used the Worker cache`).toBeGreaterThan(0);
    if (!second.failureLine) expect(second.coverage, `${name}: every source answered, so coverage should be FULL`).toBe('FULL');
  }

  console.log('PRODUCTION LIVE REPORT');
  console.log(JSON.stringify(report, null, 1));
  expect(direct, 'the browser must never read an official source directly').toEqual([]);
  expect(errors).toEqual([]);
});
