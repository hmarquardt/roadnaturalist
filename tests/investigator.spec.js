import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The browser build replays the reviewed operator research capture (data/investigator/or-pilot-access-evidence.json)
// and the OpenStreetMap context recorded in it, so these tests are deterministic and never depend on a county web
// site or an Overpass mirror being reachable. Per-corridor expectations are read from the same capture the app uses,
// so a regenerated capture cannot silently invalidate them: the assertions compare the UI with the data, and the
// vocabulary, provenance, and honesty rules are asserted directly.
const capture = JSON.parse(readFileSync(new URL('../data/investigator/or-pilot-access-evidence.json', import.meta.url)));
// The declared sources are data now: the browser must render exactly the probes this catalog declares for a
// corridor, which also proves the catalog module really loads in a browser.
const catalog = JSON.parse(readFileSync(new URL('../data/investigator/probe-catalog.json', import.meta.url)));
const FINDING_LABEL = { RESTRICTED_OR_CLOSED: 'RESTRICTED OR CLOSED', PROBABLE_PUBLIC: 'PROBABLE PUBLIC', UNVERIFIED: 'UNVERIFIED', CONFLICTED: 'CONFLICTED', VERIFIED_PUBLIC: 'VERIFIED PUBLIC' };
const READY = 'No corridor loaded';

// Opening the workspace is the one step that can be slow here: DuckDB-WASM initialises from a CDN and the suite runs
// Chromium in one process with workers: 1, so a page opened after a heavy spec can take a while to boot. The helper
// therefore waits for the module's own ready signal (the pilot button is disabled until the app has wired its
// listeners) and reloads once if that signal does not arrive, instead of asserting against a half-booted page.
async function openPilot(page, corridorName) {
  await page.goto('/');
  try {
    await expect(page.locator('#candidate-list')).toContainText(READY, { timeout: 20000 });
  } catch {
    await page.reload();
    await expect(page.locator('#candidate-list')).toContainText(READY, { timeout: 90000 });
  }
  await page.getByRole('button', { name: /Open Oregon road pilot/ }).click();
  // Wait for the whole pilot, not just the requested card: the list renders after the road query resolves.
  await expect(page.locator('.candidate-card')).toHaveCount(3, { timeout: 90000 });
  // Opening the pilot selects the first corridor; select the one under test through its candidate card.
  await page.locator('.candidate-card', { hasText: corridorName }).first().click();
  await expect(page.locator('#candidate-detail')).toContainText(corridorName, { timeout: 90000 });
}

async function runAccess(page, corridorName) {
  await openPilot(page, corridorName);
  const section = page.locator('.access-section');
  await section.getByRole('button', { name: 'Run access investigation' }).click();
  await expect(section.locator('.access-finding-label')).toBeVisible({ timeout: 60000 });
  return section;
}

test('access stays unverified and untouched until the reader asks for the investigation', async ({ page }) => {
  // Nothing about access is requested on load: no Overpass mirror, no county or agency page, and not even the local
  // reviewed capture. (Loading the pilot does fetch the pinned DuckDB-WASM bundle, which is unrelated.)
  const accessRequests = [];
  const ACCESS_HOSTS = /overpass|wc-roads|washingtoncountyor|multco\.us|govdelivery|or-pilot-access-evidence/;
  page.on('request', request => { if (ACCESS_HOSTS.test(request.url())) accessRequests.push(request.url()); });
  await openPilot(page, 'NW Cornelius Pass Rd');
  const section = page.locator('.access-section');
  await expect(section).toContainText('ACCESS EVIDENCE');
  await expect(section).toContainText('No access verification has run for this corridor');
  await expect(section).toContainText('not that the public may drive it');
  await expect(page.locator('.investigation-section')).toContainText('has not run for this corridor');
  await expect(page.locator('.investigation-section')).toContainText('Access stays unverified until it does');
  await expect(page.locator('#data-context')).toContainText('Access verification');
  expect(accessRequests).toEqual([]);
  // The road panel keeps saying geometry is not access.
  await expect(page.locator('#candidate-detail')).toContainText('ACCESS UNVERIFIED');
  await expect(page.locator('#candidate-detail')).not.toContainText('VERIFIED PUBLIC');
});

test('a corridor with an active closure shows it as the finding, with provenance, contradictions, and an export', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const section = await runAccess(page, 'NW Cornelius Pass Rd');
  // The declared sources are data now: the investigation record must show exactly the probes this corridor's catalog
  // entry declares — one row each, matched by the declared title — which also proves the catalog module really loads
  // in a browser. Rows are grouped by pipeline stage, so this asserts membership and count, not catalog order.
  const declared = catalog.probes.filter(probe => !probe.corridorIds || probe.corridorIds.includes('or-roads-cornelius-pass-rd'));
  const record = page.locator('.investigation-section');
  await expect(record.locator('.source-list > li')).toHaveCount(declared.length);
  const sourceListText = await record.locator('.source-list').innerText();
  for (const probe of declared) {
    const rows = sourceListText.split(probe.title).length - 1;
    expect(rows, `${probe.id} should appear exactly once in the source list`).toBe(1);
  }
  const expected = capture.corridors['or-roads-cornelius-pass-rd'].finding;
  await expect(section.locator('.access-finding-label')).toHaveText(FINDING_LABEL[expected.finding]);
  await expect(section).toContainText(expected.ruleId);
  await expect(section).toContainText('RESTRICTED OR CLOSED');
  await expect(section).toContainText('temporary closure, permit requirement');
  // The restriction itself, its scope, and its published window are visible — not flattened into "closed".
  await expect(section).toContainText('TEMPORARY_CLOSURE');
  await expect(section).toContainText('Restrictions and closures');
  await expect(section).toContainText('bridge over Rock Creek');
  await expect(section).toContainText('2026-10-07');
  await expect(section).toContainText('between Germantown Road and Kaiser Road');
  // Supporting evidence keeps its source class, its verbatim text, and a link.
  await expect(section).toContainText('Oregon Department of Transportation');
  await expect(section).toContainText('Tier 1 authority');
  await expect(section).toContainText('NW Cornelius Pass Road between U.S. 30 and U.S. 26 is a state highway');
  await expect(section.locator('a', { hasText: 'source' }).first()).toHaveAttribute('href', /^https:\/\//);
  // Contradictions stay prominent and unresolved.
  const contradictions = section.locator('.access-contradictions');
  await expect(contradictions).toContainText('MULTIPLE_AUTHORITY_CLAIMS');
  await expect(contradictions).toContainText('Road Naturalist does not decide which');
  await expect(contradictions).toContainText('never resolved here by preference');
  // A similarly named road is a caution, and unresolved items stay visible.
  await expect(section).toContainText('Old Cornelius Pass Road');
  await expect(section).toContainText('Caution (gates, unmaintained, similar road names)');
  await expect(section).toContainText('Unresolved');
  await expect(section).toContainText('Public road evidence');
  // The export carries the finding, its guardrail, and no credential or observation record.
  const [download] = await Promise.all([page.waitForEvent('download'), record.getByRole('button', { name: /Export evidence bundle/ }).click()]);
  const bundle = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(download.suggestedFilename()).toBe('or-roads-cornelius-pass-rd-evidence-bundle.json');
  expect(bundle.schemaVersion).toBe('roadnaturalist-corridor-evidence/1');
  expect(bundle.corridor.id).toBe('or-roads-cornelius-pass-rd');
  expect(bundle.access.finding).toBe(expected.finding);
  expect(bundle.access.ruleId).toBe(expected.ruleId);
  expect(bundle.access.contradictions.length).toBeGreaterThan(0);
  expect(bundle.access.sources.length).toBe(capture.corridors['or-roads-cornelius-pass-rd'].probes.length);
  expect(bundle.corridor.geometry.included).toBe(false);
  expect(bundle.occurrence).toBeNull();
  expect(JSON.stringify(bundle)).not.toMatch(/api[_-]?key|X-eBirdApiToken|secret|bearer /i);
  await expect(page.locator('#access-note')).toContainText('Exported');
});

test('a partially covered corridor reports probable public access and names the gap', async ({ page }) => {
  const section = await runAccess(page, 'NW Springville Rd');
  const expected = capture.corridors['or-roads-springville-rd'].finding;
  await expect(section.locator('.access-finding-label')).toHaveText(FINDING_LABEL[expected.finding]);
  await expect(section).toContainText(expected.ruleId);
  await expect(section).toContainText('No restriction in force');
  await expect(section).toContainText('CORRIDOR_PART_ONLY');
  await expect(section).toContainText('does not cover the whole corridor');
  await expect(section).toContainText('North Bethany');
  await expect(section).toContainText('City of Portland line to Washington County line');
});

test('a recurring seasonal closure is preserved, and the investigation record shows every stage, source, and check', async ({ page }) => {
  const section = await runAccess(page, 'NW Susbauer Rd');
  const expected = capture.corridors['or-roads-susbauer-rd'].finding;
  await expect(section.locator('.access-finding-label')).toHaveText('RESTRICTED OR CLOSED');
  await expect(section).toContainText(expected.ruleId);
  await expect(section).toContainText('SEASONAL_CLOSURE');
  await expect(section).toContainText('recurs (high-water)');
  await expect(section).toContainText('between Long and Hornecker roads');
  await expect(section).toContainText('GATE_REPORTED');
  await expect(section).toContainText('permanent, manual-locking flood gates');
  await expect(section).toContainText('no independent corroboration');
  // Coverage and the finding are different rows.
  await expect(section).toContainText('Access verification coverage');
  await expect(section).toContainText('Evidence checked');

  const record = page.locator('.investigation-section');
  for (const stage of ['Baseline', 'Road context', 'Authority discovery', 'Access research', 'Contradiction search', 'Adversarial review', 'Finding']) {
    await expect(record.locator('.stage-list')).toContainText(stage);
  }
  await expect(record.locator('.stage-list')).not.toContainText('pending');
  await expect(record).toContainText('Sources checked');
  await expect(record.locator('.source-list')).toContainText('no relevant evidence');
  await expect(record).toContainText('not re-checked in this environment');
  await expect(record).toContainText('OpenStreetMap road context');
  await expect(record).toContainText('Ways matched');
  await expect(record).toContainText('access tag absent');
  await expect(record).toContainText('Provisional finding before the contradiction search');
  const review = record.locator('details', { hasText: 'Adversarial review' });
  await expect(review).toContainText('CONCERN —');
  await expect(review).toContainText('Is a restriction in force today');
  await expect(review).toContainText('rest on one organization');
  await expect(record).toContainText('Human review');
});

test('a human review is recorded beside the automated finding and survives a re-run', async ({ page }) => {
  const section = await runAccess(page, 'NW Susbauer Rd');
  await expect(section.locator('.access-finding-label')).toHaveText('RESTRICTED OR CLOSED');
  const record = page.locator('.investigation-section');
  await record.locator('select.review-select').selectOption('CONFLICTED');
  await record.locator('textarea.review-note').fill('County page and gate notice disagree about current status.');
  await record.getByRole('button', { name: 'Record human review' }).click();
  await expect(section).toContainText('Human review recorded');
  await expect(section).toContainText('County page and gate notice disagree about current status.');
  // The header shows the human finding and still names the automated one.
  await expect(section.locator('.access-finding-label')).toHaveText('CONFLICTED');
  await expect(section).toContainText('Automated finding: RESTRICTED OR CLOSED');
  // Research can be re-requested, and a re-run does not erase the human record or the automated finding.
  await section.getByRole('button', { name: 'Re-check access evidence' }).click();
  await expect(section).toContainText('Human review recorded');
  await expect(section).toContainText('Automated finding: RESTRICTED OR CLOSED');
});

test('the access panels stay readable on a phone-width viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const section = await runAccess(page, 'NW Susbauer Rd');
  await expect(section).toContainText('RESTRICTED OR CLOSED');
  await expect(section).toContainText('Access verification coverage');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  // The actions stack instead of overflowing.
  const buttonBox = await page.locator('.investigation-section').getByRole('button', { name: /Export evidence bundle/ }).boundingBox();
  expect(buttonBox.width).toBeLessThanOrEqual(390);
});
