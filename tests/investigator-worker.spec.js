import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The live Worker boundary, stubbed. Every assertion here is about the browser: it sends probe ids, it never reads a
// county site directly, it shows how each source was read, it reports failures and drift instead of hiding them, and
// it keeps the finding and the human review it already had. The stub answers with the same contract the deployed
// Worker returns (worker/README.md), built from the reviewed capture so the evidence stays consistent with it.
const capture = JSON.parse(readFileSync(new URL('../data/investigator/or-pilot-access-evidence.json', import.meta.url)));
const WORKER_BASE = 'http://127.0.0.1:8000/worker-investigator';
const PROBE_LIST = `${WORKER_BASE}/api/investigator/probes`;
const READY = 'No corridor loaded';
const CORRIDOR = 'NW Cornelius Pass Rd';
const CORRIDOR_ID = 'or-roads-cornelius-pass-rd';

function workerFacts(corridorId) {
  const entry = capture.corridors[corridorId];
  return entry.probes.map(probe => ({ probeId: probe.probeId, outcome: probe.outcome, url: probe.searched?.url ?? null,
    facts: (probe.evidence ?? []).map(item => ({ claimType: item.claimType, quote: item.quote, claimValue: item.claimValue ?? null,
      summary: item.summary ?? null, effectiveFrom: item.effectiveFrom ?? null, effectiveUntil: item.effectiveUntil ?? null,
      recurrence: item.recurrence ?? null, corridorPart: item.geographicScope?.corridorPart ?? null, scope: item.geographicScope?.scope ?? null })) }));
}

const PROBE_INDEX = new Map();
for (const corridorId of Object.keys(capture.corridors)) {
  const entry = capture.corridors[corridorId];
  for (const probe of entry.probes) PROBE_INDEX.set(probe.probeId, { corridorId, organization: probe.organization, sourceClass: probe.sourceClass,
    sourceUrl: probe.searched?.url ?? null, title: probe.note ?? probe.probeId, outcome: probe.outcome, facts: workerFacts(corridorId).find(entry => entry.probeId === probe.probeId).facts });
}

// Serve the boundary. `overrides` can replace one probe's answer, fail it, or change its facts.
async function stubWorker(page, { answered = 'all', overrideFacts = {}, failing = [], throttled = [], driftState = 'UNCHANGED', cached = false } = {}) {
  const seen = [];
  await page.route(`${WORKER_BASE}/**`, async route => {
    const url = new URL(route.request().url());
    seen.push(url.pathname);
    if (url.pathname === '/worker-investigator/api/investigator/probes') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ worker: 'roadnaturalist-investigator-worker/1',
        probeCount: PROBE_INDEX.size, probes: [...PROBE_INDEX.keys()].map(probeId => ({ probeId })), sourceHosts: ['www.washingtoncountyor.gov', 'multco.us', 'www.wc-roads.com', 'content.govdelivery.com'],
        cache: { enabled: true }, note: 'declared probes only' }) });
    }
    const probeId = url.pathname.split('/').pop();
    const entry = PROBE_INDEX.get(probeId);
    if (!entry) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNKNOWN_PROBE' } }) });
    const include = answered === 'all' || (Array.isArray(answered) ? answered.includes(probeId) : true);
    const isThrottled = throttled.includes(probeId);
    const isFailing = failing.includes(probeId);
    const facts = isFailing || !include ? [] : (overrideFacts[probeId] ?? entry.facts);
    const status = isFailing ? 'FAILED' : facts.length ? 'EVIDENCE' : 'NO_RELEVANT_EVIDENCE';
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ probeId, status,
      organization: entry.organization, sourceClass: entry.sourceClass, sourceUrl: entry.sourceUrl, title: entry.title,
      stage: 'access-research', kind: 'authority', question: 'stubbed', retrievedAt: '2026-09-26T12:00:00.000Z', publishedAt: null,
      facts, cacheStatus: cached ? 'HIT' : 'MISS',
      diagnostics: isFailing ? [{ code: isThrottled ? 'throttled' : 'http_error', message: isThrottled ? 'the source throttled this request (HTTP 429)' : 'the source answered HTTP 503' }] : [],
      drift: { state: status === 'FAILED' ? 'SOURCE_UNAVAILABLE' : driftState, note: 'stub', added: [], removed: [] },
      meta: { requestId: `req-${probeId}`, probeId, sourceHost: new URL(entry.sourceUrl ?? 'https://x.invalid').hostname, durationMs: 12,
        upstreamDurationMs: 11, upstreamBytes: 45000, cacheStatus: cached ? 'HIT' : 'MISS', answeredAt: '2026-09-26T12:00:00.000Z',
        cachedAt: cached ? '2026-09-26T11:59:00.000Z' : null, extractionStatus: `${facts.length}_facts`, normalizedBytes: 320, worker: 'roadnaturalist-investigator-worker/1' } }) });
  });
  return seen;
}

async function openPilot(page, corridorName) {
  await page.goto('/');
  try {
    await expect(page.locator('#candidate-list')).toContainText(READY, { timeout: 20000 });
  } catch {
    await page.reload();
    await expect(page.locator('#candidate-list')).toContainText(READY, { timeout: 90000 });
  }
  await page.getByRole('button', { name: /Open Oregon road pilot/ }).click();
  await expect(page.locator('.candidate-card')).toHaveCount(3, { timeout: 90000 });
  await page.locator('.candidate-card', { hasText: corridorName }).first().click();
  await expect(page.locator('#candidate-detail')).toContainText(corridorName, { timeout: 90000 });
}

async function runAccess(page, { corridorName = CORRIDOR, button = 'Run access investigation' } = {}) {
  await openPilot(page, corridorName);
  const section = page.locator('.access-section');
  await section.getByRole('button', { name: button }).click();
  await expect(section.locator('.access-finding-label')).toBeVisible({ timeout: 60000 });
  return section;
}

test('a configured Worker boundary is used only when asked, and no county site is contacted by the browser', async ({ page }) => {
  await page.addInitScript(base => { window.ROADNATURALIST_WORKER_URL = base; }, WORKER_BASE);
  const external = [];
  page.on('request', request => { const host = new URL(request.url()).hostname;
    if (/washingtoncountyor|wc-roads|multco\.us|govdelivery/.test(host)) external.push(request.url()); });
  const seen = await stubWorker(page);
  await openPilot(page, CORRIDOR);
  const section = page.locator('.access-section');
  await expect(section).toContainText('a live boundary is configured');
  await expect(section).toContainText('is checked when you run the investigation');
  await expect(section).toContainText('Official sources will be read live through the Worker boundary');
  expect(seen).toEqual([]);
  // Now ask for the investigation: the boundary is checked, then used.
  await section.getByRole('button', { name: 'Run access investigation' }).click();
  await expect(section.locator('.access-finding-label')).toBeVisible({ timeout: 60000 });
  await expect(section).toContainText('live through the Road Naturalist Worker boundary');
  await expect(section).toContainText('Source reads: 6 live');
  await expect(section.locator('.access-finding-label')).toHaveText('RESTRICTED OR CLOSED');
  expect(external, 'the browser must never read an official source directly').toEqual([]);
});

test('a live Worker run reaches FULL coverage and shows live reads per source', async ({ page }) => {
  await page.addInitScript(base => { window.ROADNATURALIST_WORKER_URL = base; }, WORKER_BASE);
  await stubWorker(page);
  const section = await runAccess(page);
  await expect(section).toContainText('Access verification coverageFULL');
  await expect(section).toContainText('Source reads: 6 live');
  const record = page.locator('.investigation-section');
  await expect(record.locator('.source-list')).toContainText('live read (worker boundary)');
  await expect(record.locator('.source-list')).not.toContainText('replayed from the reviewed capture');
  await expect(page.locator('#access-note')).toContainText('6 live');
  await expect(page.locator('#access-note')).toContainText('Coverage FULL');
});

test('a cached boundary answer is labelled as cached rather than fresh', async ({ page }) => {
  await page.addInitScript(base => { window.ROADNATURALIST_WORKER_URL = base; }, WORKER_BASE);
  await stubWorker(page, { cached: true });
  const section = await runAccess(page);
  await expect(section).toContainText('Source reads: 0 live, 6 from the worker cache');
  await expect(page.locator('.investigation-section').locator('.source-list')).toContainText('cache read');
  await expect(page.locator('#access-note')).toContainText('6 from the worker cache');
});

test('a failing source degrades coverage, stays visible, and keeps the earlier finding beside the new run', async ({ page }) => {
  await page.addInitScript(base => { window.ROADNATURALIST_WORKER_URL = base; }, WORKER_BASE);
  const stub = await stubWorker(page);
  const section = await runAccess(page);
  await expect(section).toContainText('Access verification coverageFULL');
  await expect(section.locator('.access-finding-label')).toHaveText('RESTRICTED OR CLOSED');

  // The same boundary now fails two sources, including the one that documents the closure.
  await page.unroute(`${WORKER_BASE}/**`);
  await stubWorker(page, { failing: ['wc-roads-cornelius-advisory', 'wc-cornelius-bridge-project'], throttled: ['wc-roads-cornelius-advisory'],
    overrideFacts: { 'wc-cornelius-closure-news': [] }, answered: ['odot-cornelius-transfer', 'mc-cornelius-rcip', 'wc-mstip-cornelius-roadsafety'] });
  expect(stub.length).toBeGreaterThan(0);
  await section.getByRole('button', { name: 'Re-check access evidence' }).click();
  await expect(section).toContainText('Access verification coveragePARTIAL');
  await expect(section).toContainText('2 source request(s) failed');
  const record = page.locator('.investigation-section');
  await expect(record.locator('.source-list')).toContainText('source failed');
  await expect(record.locator('.source-list')).toContainText('the source throttled this request');
  await expect(section).toContainText('Previous run kept');
  await expect(section).toContainText('RESTRICTED OR CLOSED');
  await expect(section).toContainText('2 source(s) in the new run did not answer');
  await expect(page.locator('#access-note')).toContainText('The previous finding (RESTRICTED OR CLOSED');
});

test('source drift is shown, with the facts involved, and does not rewrite the finding', async ({ page }) => {
  await page.addInitScript(base => { window.ROADNATURALIST_WORKER_URL = base; }, WORKER_BASE);
  const changed = [{ claimType: 'TEMPORARY_CLOSURE', quote: 'Cornelius Pass Road is closed between Germantown Road and Kaiser Road until November 20, 2026',
    claimValue: 'full closure', summary: 'changed window', effectiveFrom: '2026-11-01', effectiveUntil: '2026-11-20', recurrence: null,
    corridorPart: 'between Germantown Road and Kaiser Road', scope: 'CORRIDOR_PART' }];
  await stubWorker(page, { overrideFacts: { 'wc-roads-cornelius-advisory': changed }, driftState: 'EVIDENCE_CHANGED' });
  const section = await runAccess(page);
  await expect(section).toContainText('Source drift');
  await expect(section).toContainText('EVIDENCE_CHANGED');
  await expect(section).toContainText('A changed page is not a changed finding');
  await expect(section.locator('.access-finding-label')).toHaveText('RESTRICTED OR CLOSED');
  await expect(page.locator('.investigation-section').locator('.source-list')).toContainText('drift evidence changed');
});

test('a human review survives a live re-check, and a changed automated finding is surfaced', async ({ page }) => {
  await page.addInitScript(base => { window.ROADNATURALIST_WORKER_URL = base; }, WORKER_BASE);
  await stubWorker(page);
  const section = await runAccess(page);
  const record = page.locator('.investigation-section');
  await record.locator('select.review-select').selectOption('CONFLICTED');
  await record.locator('textarea.review-note').fill('County plan may be stale after the jurisdiction transfer.');
  await record.getByRole('button', { name: 'Record human review' }).click();
  await expect(section).toContainText('County plan may be stale after the jurisdiction transfer.');
  await expect(section.locator('.access-finding-label')).toHaveText('CONFLICTED');

  // Re-check live with no closure any more: the automated finding changes, the annotation does not disappear.
  await page.unroute(`${WORKER_BASE}/**`);
  await stubWorker(page, { overrideFacts: { 'wc-roads-cornelius-advisory': [], 'wc-cornelius-bridge-project': [], 'wc-cornelius-closure-news': [] } });
  await section.getByRole('button', { name: 'Re-check access evidence' }).click();
  // With no closure any more, the same authoritative evidence now reaches the strongest state: the change is
  // surfaced, and the annotation is untouched.
  await expect(section).toContainText('The automated finding has since changed from RESTRICTED OR CLOSED to VERIFIED PUBLIC');
  await expect(section).toContainText('County plan may be stale after the jurisdiction transfer.');
  await expect(section).toContainText('Your annotation is kept; review whether it still applies');
  await expect(page.locator('.investigation-section')).toContainText('Recorded when the automated finding was RESTRICTED OR CLOSED');
});

test('the live boundary view stays readable at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(base => { window.ROADNATURALIST_WORKER_URL = base; }, WORKER_BASE);
  await stubWorker(page);
  const section = await runAccess(page);
  await expect(section).toContainText('RESTRICTED OR CLOSED');
  await expect(section).toContainText('Source reads: 6 live');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});
