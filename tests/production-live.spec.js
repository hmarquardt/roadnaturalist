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
    // Production resolves the boundary from the deployed origin with no manual global (src/app/config.js), so the
    // panel names the real API host before anything runs. The wording differs between the first corridor (the
    // boundary has not been checked yet) and later ones (it already has), so assert the host, not the phrasing.
    await expect(section).toContainText('api.roadnaturalist.com', { timeout: 60000 });

    // First run for this corridor: the sources have not been read by this colo yet.
    await section.getByRole('button', { name: /Run access investigation|Re-check access evidence/ }).click();
    await expect(section.locator('.access-finding-label')).toBeVisible({ timeout: 240000 });
    await expect(section).toContainText('live through the Road Naturalist Worker boundary', { timeout: 60000 });

    const read = async () => section.evaluate(node => {
      const text = node.innerText;
      const pick = pattern => new RegExp(pattern, "i").exec(text)?.[1] ?? null;
      // The panel's own retrieval-mode counters describe the declared research probes (OpenStreetMap is not one of
      // them), which is the app's statement about how each source was read.
      const reads = /(\d+) live, (\d+) from the worker cache, (\d+) replayed from the reviewed capture, (\d+) not run/.exec(text);
      return {
        finding: node.querySelector('.access-finding-label')?.textContent?.trim() ?? null,
        // The label is uppercased by CSS, so match the coverage vocabulary case-insensitively; requiring one of the
        // four values keeps the coverage *reason* sentence from matching this label.
        coverage: pick('access verification coverage\\s*(FULL|PARTIAL|UNKNOWN|NONE)'),
        readsLine: reads ? reads[0] : null,
        live: reads ? Number(reads[1]) : null,
        cached: reads ? Number(reads[2]) : null,
        replayed: reads ? Number(reads[3]) : null,
        notRun: reads ? Number(reads[4]) : null,
        boundary: pick('(Official-source research:[^\\n]+)'),
        failureLine: pick('(\\d+ source request\\(s\\) failed)'),
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
    expect(second.live + second.cached, `${name}: no source was read through the boundary`).toBeGreaterThan(0);
    expect(second.replayed, `${name}: the boundary answered, so nothing should be a capture replay`).toBe(0);
    expect(second.notRun, `${name}: every declared source should have been read`).toBe(0);
    expect(['FULL', 'PARTIAL']).toContain(second.coverage);
    expect(second.cached, `${name}: the repeat run should have used the Worker cache`).toBeGreaterThan(0);
    if (!second.failureLine) expect(second.coverage, `${name}: every source answered, so coverage should be FULL`).toBe('FULL');
  }

  console.log('PRODUCTION LIVE REPORT');
  console.log(JSON.stringify(report, null, 1));
  expect(direct, 'the browser must never read an official source directly').toEqual([]);
  expect(errors).toEqual([]);
});
