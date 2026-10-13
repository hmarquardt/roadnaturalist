import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

import { DEFAULT_SORT } from '../src/discovery/filter.js';
import { DISCOVERY_SEARCH_KEY } from '../src/discovery/persistence.js';

// A DELIBERATE SORT CHOICE SURVIVES A RELOAD; A DEFAULT DOES NOT BECOME ONE.
//
//   RUN_SORT_PERSISTENCE=1 npx playwright test tests/sort-preference-map.spec.js
//
// One real region, driven the way a person drives it: run a search, choose an ordering, reload, run again and see
// which ordering came back. The stored preference is the only thing under test; the rankings themselves are
// covered by tests/ranking-map.spec.js and the committed artifacts.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
const RAW_PLANE = /\/(national\/roads|national\/wetlands|national\/hydro)\//;

test.skip(!process.env.RUN_SORT_PERSISTENCE, 'set RUN_SORT_PERSISTENCE=1 to verify the sort survives a reload');

function region() {
  const path = process.env.RANKING_ORDER_ARTIFACT ?? '../data/ranking/exploration-order-v1-evaluation.json';
  const artifact = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  return artifact.regions.find(entry => entry.id === 'princeton-in');
}

function interestArtifact() {
  const path = process.env.RANKING_EVAL_ARTIFACT ?? '../data/ranking/naturalist-interest-v2-evaluation.json';
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

test('a chosen sort comes back after a reload, and a default never becomes a choice', async ({ page }) => {
  test.setTimeout(1800000);
  const place = region();
  const interest = interestArtifact().regions.find(entry => entry.id === 'princeton-in');
  await page.setViewportSize({ width: 1440, height: 950 });
  const rawReads = [];
  const errors = [];
  page.on('request', request => { if (RAW_PLANE.test(request.url())) rawReads.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

  const sortSelect = () => page.locator('#discovery-sort');
  const topIds = () => page.locator('#discovery-results tbody tr').evaluateAll(rows =>
    rows.slice(0, 10).map(row => row.dataset.candidateId));
  const storedSort = () => page.evaluate(key => {
    const raw = globalThis.localStorage.getItem(key);
    return raw ? (JSON.parse(raw).preferredSort ?? null) : null;
  }, DISCOVERY_SEARCH_KEY);
  async function runSearch() {
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });
    await page.locator('#discover-roads').click();
    await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 600000 });
  }

  // A FRESH BROWSER: no preference stored, and the app starts on the product default without writing one.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('#discovery-center-lat').fill(place.center[1].toFixed(4));
  await page.locator('#discovery-center-lon').fill(place.center[0].toFixed(4));
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-radius-input').fill(String(place.radiusMiles));
  await page.locator('#discovery-radius-input').press('Enter');
  await runSearch();
  expect(await storedSort(), 'a fresh session stores no sort preference').toBe(null);
  await expect(sortSelect()).toHaveValue(DEFAULT_SORT);
  expect((await topIds())).toEqual(place.selected.order.map(entry => entry.corridorId).slice(0, 10));

  // AN EXPLICIT CHOICE IS REMEMBERED. Naturalist interest, then a reload, then the same search again.
  await sortSelect().selectOption('naturalistInterest');
  expect((await topIds())).toEqual(interest.comparison.interest.map(entry => entry.corridorId).slice(0, 10));
  expect(await storedSort()).toBe('naturalistInterest');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await runSearch();
  await expect(sortSelect()).toHaveValue('naturalistInterest');
  expect((await topIds()), 'the restored order is the one that was chosen').toEqual(
    interest.comparison.interest.map(entry => entry.corridorId).slice(0, 10));

  // A FACTUAL SORT IS REMEMBERED THE SAME WAY.
  await sortSelect().selectOption('wetlandArea250');
  expect(await storedSort()).toBe('wetlandArea250');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await runSearch();
  await expect(sortSelect()).toHaveValue('wetlandArea250');

  // AND SO IS CHOOSING THE DEFAULT EXPLICITLY: it is a decision, not the absence of one.
  await sortSelect().selectOption(DEFAULT_SORT);
  expect(await storedSort()).toBe(DEFAULT_SORT);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await runSearch();
  await expect(sortSelect()).toHaveValue(DEFAULT_SORT);
  expect((await topIds())).toEqual(place.selected.order.map(entry => entry.corridorId).slice(0, 10));

  // AN OBSOLETE OR HAND-EDITED VALUE IS IGNORED, and discovery still works.
  await page.evaluate(key => {
    const raw = JSON.parse(globalThis.localStorage.getItem(key));
    globalThis.localStorage.setItem(key, JSON.stringify({ ...raw, preferredSort: 'not-a-sort' }));
  }, DISCOVERY_SEARCH_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await runSearch();
  await expect(sortSelect()).toHaveValue(DEFAULT_SORT);
  expect((await topIds()), 'the table still orders normally').toEqual(
    place.selected.order.map(entry => entry.corridorId).slice(0, 10));

  // Choosing an ordering and reloading must never cost a data read: the preference is device state, not a plane.
  expect(rawReads, `no raw plane may be read: ${rawReads.join(', ')}`).toEqual([]);
  expect(errors).toEqual([]);
});
