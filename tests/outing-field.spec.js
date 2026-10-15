import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openAdvancedSearch, openAllResults } from './discovery-ui.js';

import { OUTINGS_KEY } from '../src/state/outings.js';
import { CANDIDATES_KEY } from '../src/state/candidate-persistence.js';

// A PLAN, USED ON A PHONE.
//
//   RUN_OUTING_FIELD=1 npx playwright test tests/outing-field.spec.js
//
// One real search, four real corridors kept as saved roads, one plan, and then the field workflow at a phone-sized
// viewport: where am I, what is next, why did I save it, and what coordinate would I hand to my mapping app. The gate
// never opens an external application - it reads the URL that would be opened - and it never requests a position.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
const RAW_PLANE = /\/(national\/roads|national\/wetlands|national\/hydro)\//;
const DATA_PLANE = /\/(national|regional)\//;
const PHONE = { width: 390, height: 844 };

test.skip(!process.env.RUN_OUTING_FIELD, 'set RUN_OUTING_FIELD=1 to drive field mode on a phone viewport');

function region(id) {
  const path = process.env.RANKING_ORDER_ARTIFACT ?? '../data/ranking/exploration-order-v1-evaluation.json';
  const artifact = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  return artifact.regions.find(entry => entry.id === id);
}

test('a plan is worked through on a phone, and survives a reload', async ({ page }) => {
  test.setTimeout(1800000);
  const princeton = region('princeton-in');
  await page.setViewportSize(PHONE);
  const reads = [];
  const rawReads = [];
  const errors = [];
  const missing = [];
  let positionsAsked = 0;
  await page.context().addInitScript(() => {
    // NOTHING HERE ASKS FOR A POSITION. The stub records any attempt so the gate can prove none was made.
    globalThis.__RN_GEO_CALLS = 0;
    const original = globalThis.navigator.geolocation?.getCurrentPosition?.bind(globalThis.navigator.geolocation);
    if (original) {
      globalThis.navigator.geolocation.getCurrentPosition = (...args) => { globalThis.__RN_GEO_CALLS += 1; return original(...args); };
    }
  });
  page.on('response', response => { if (response.status() === 404) missing.push(response.url()); });
  page.on('request', request => {
    const url = request.url();
    if (RAW_PLANE.test(url)) rawReads.push(url);
    if (DATA_PLANE.test(url)) reads.push(url);
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });

  await openAllResults(page);
  const rows = () => page.locator('#discovery-results tbody tr');
  const fieldRoads = () => page.locator('#field-road-list li.field-road').evaluateAll(items =>
    items.map(item => ({ roadId: item.dataset.roadId, visited: item.dataset.visited === 'true',
      current: item.dataset.current === 'true', name: item.innerText.split('\n')[0] })));
  const currentName = async () => (await page.locator('#field-current-name').innerText()).trim();
  const progress = async () => (await page.locator('#field-progress').innerText()).trim();
  // The stop line is uppercased by the stylesheet, so it is compared as the person reads it.
  const stopLabel = async () => (await page.locator('#field-stop').innerText()).trim().toLowerCase();
  async function addToOuting(candidateId, { create = false } = {}) {
    await page.locator(`#discovery-results tbody tr[data-candidate-id="${candidateId}"] button.discovery-row`).click();
    const select = page.locator('#discovery-add-outing');
    await expect(select).toBeVisible();
    if (create) await select.selectOption('__new__');
    await page.locator('#discovery-add-to-outing').click();
    await expect(page.locator(`#outing-roads li.outing-road[data-road-id="${candidateId}"]`)).toBeVisible({ timeout: 120000 });
  }
  async function enterFieldMode() {
    await page.locator('#outing-list button[data-open-outing]').first().click();
    await page.locator('#outing-field-mode').click();
    await expect(page.locator('#field-mode')).toBeVisible();
  }

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });
  await openAdvancedSearch(page);
  await page.locator('#discovery-center-lat').fill(princeton.center[1].toFixed(4));
  await page.locator('#discovery-center-lon').fill(princeton.center[0].toFixed(4));
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-radius-input').fill(String(princeton.radiusMiles));
  await page.locator('#discovery-radius-input').press('Enter');
  await page.locator('#discover-roads').click();
  await expect(rows().first()).toBeVisible({ timeout: 600000 });

  // 1. AN OUTING WITH FOUR ROADS, built from the search the way a person builds one.
  const [first, second, third, fourth] = await rows().evaluateAll(list =>
    list.slice(0, 4).map(row => row.dataset.candidateId));
  expect([first, second, third, fourth].every(Boolean), 'the search proposes at least four roads').toBe(true);
  await addToOuting(first, { create: true });
  for (const id of [second, third, fourth]) await addToOuting(id);
  const order = [first, second, third, fourth];

  // 2-3. FIELD MODE OPENS ON THE OPEN PLAN, AND THE FIRST ROAD IS CURRENT.
  await enterFieldMode();
  const listed = await fieldRoads();
  expect(listed.map(road => road.roadId)).toEqual(order, 'the field view holds the plan, in the person’s order');
  expect(listed.map(road => road.visited)).toEqual([false, false, false, false]);
  expect(listed.map(road => road.current)).toEqual([true, false, false, false]);
  expect(await progress()).toBe('0 / 4 roads visited · 0%');
  const firstName = await currentName();
  // The field view's own list is the plan in the person's order, so the names it shows are the expectation for every
  // step through it.
  const fieldNames = await page.locator('#field-road-list li.field-road button.field-road-name')
    .evaluateAll(items => items.map(item => item.innerText.trim().replace(/^\d+\.\s*/, '')));
  expect(fieldNames[0]).toBe(firstName);
  expect(await stopLabel()).toContain('road 1 of 4');
  // ON A PHONE THE FIELD VIEW IS THE FIRST THING ON THE PAGE, because it is the thing being used.
  const fieldTop = (await page.locator('#field-mode').boundingBox()).y;
  const discoveryTop = (await page.locator('#discovery').boundingBox()).y;
  expect(fieldTop, 'the field view comes before the search workspace on a phone').toBeLessThan(discoveryTop);
  expect(await page.locator('#field-previous').isDisabled(), 'there is nothing before the first road').toBe(true);

  // 4. MARK VISITED. The plan records it, and because the person had not chosen a road explicitly, the derived position
  // advances to the next road they have not visited - which is what "what's next" means.
  await page.locator('#field-visit-button').click();
  await expect(page.locator('#field-progress')).toHaveText('1 / 4 roads visited · 25%');
  expect((await fieldRoads()).map(road => road.visited)).toEqual([true, false, false, false]);
  expect(await currentName()).toBe(fieldNames[1]);
  // AN EXPLICIT CHOICE STAYS PUT, and the road it is on offers to undo the mark it can see.
  await page.locator(`#field-road-list li.field-road[data-road-id="${first}"] button.field-road-name`).click();
  expect(await currentName()).toBe(fieldNames[0]);
  await expect(page.locator('#field-unvisit')).toBeVisible();
  await page.locator('#field-unvisit').click();
  await expect(page.locator('#field-progress')).toHaveText('0 / 4 roads visited · 0%');
  expect((await fieldRoads()).map(road => road.visited)).toEqual([false, false, false, false]);
  await page.locator('#field-visit-button').click();
  await expect(page.locator('#field-progress')).toHaveText('1 / 4 roads visited · 25%');
  expect(await currentName(), 'the road the person chose is still the road they are on').toBe(fieldNames[0]);

  // 5. NEXT WALKS THE PERSON'S OWN ORDER.
  await page.locator('#field-next').click();
  expect(await currentName()).toBe(fieldNames[1]);
  expect(await stopLabel()).toContain('road 2 of 4');
  expect((await fieldRoads()).map(road => road.current)).toEqual([false, true, false, false]);
  expect(await page.locator('#field-previous').isEnabled(), 'and now there is a road before this one').toBe(true);

  // 6. THE ROAD'S OWN NOTE, read and written from the field.
  const note = 'Gate at the north end; park before the cattle guard.';
  await page.locator('#field-road-note').fill(note);
  await page.locator('#field-road-note').blur();
  await expect.poll(() => page.evaluate(([key, id]) => {
    const stored = JSON.parse(globalThis.localStorage.getItem(key));
    return stored.candidates.find(candidate => candidate.id === id)?.userMeta?.note ?? null;
  }, [CANDIDATES_KEY, second])).toBe(note);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await enterFieldMode();
  await page.locator(`#field-road-list li.field-road[data-road-id="${second}"] button.field-road-name`).click();
  await expect(page.locator('#field-road-note')).toHaveValue(note, { timeout: 30000 });

  // 7. THE PLAN'S OWN CHECKLIST, added and ticked without leaving the field view.
  await page.locator('#field-new-item').fill('Water');
  await page.locator('#field-add-item').click();
  const item = page.locator('#field-checklist input[data-field-item]').first();
  await expect(item).toBeVisible();
  await expect(item).not.toBeChecked();
  await item.check();
  await expect(item).toBeChecked();
  await expect.poll(() => page.evaluate(key => JSON.parse(globalThis.localStorage.getItem(key)).outings[0].checklist[0].checked,
    OUTINGS_KEY)).toBe(true);

  // 8. THE HANDOFF: an ordinary URL to the person's own app, built from this road's representative point.
  const google = await page.locator('#field-navigate-google').getAttribute('href');
  const apple = await page.locator('#field-navigate-apple').getAttribute('href');
  expect(google).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=-?\d+\.\d{5},-?\d+\.\d{5}$/);
  expect(apple).toMatch(/^https:\/\/maps\.apple\.com\/\?daddr=-?\d+\.\d{5},-?\d+\.\d{5}$/);
  const coordinate = /destination=(-?\d+\.\d+),(-?\d+\.\d+)$/.exec(google).slice(1).map(Number);
  expect(apple).toContain(`${coordinate[0]},${coordinate[1]}`, 'both apps are handed the same point');
  expect(Math.abs(coordinate[0] - princeton.center[1])).toBeLessThan(0.5, 'the point is inside the search area');
  expect(Math.abs(coordinate[1] - princeton.center[0])).toBeLessThan(0.5);
  await expect(page.locator('#field-navigate-google')).toHaveAttribute('target', '_blank');
  await expect(page.locator('#field-navigate-google')).toHaveAttribute('rel', /noopener/);
  await expect(page.locator('.field-navigate-note').first()).toContainText('representative point on the road');
  // NOTHING WAS OPENED: the gate reads the URL rather than launching a mapping application.
  expect(page.context().pages().length, 'no external application was opened').toBe(1);

  // NOTHING ABOUT USING A PLAN IN THE FIELD READS A DATASET.
  reads.length = 0;
  rawReads.length = 0;
  await page.locator('#field-next').click();
  await page.locator('#field-visit-button').click();
  await page.locator('#field-show-on-map').click();
  expect(rawReads, `no raw plane may be read in field mode: ${rawReads.join(', ')}`).toEqual([]);
  expect(reads, `no data plane may be read in field mode: ${reads.join(', ')}`).toEqual([]);

  // 9-11. A RELOAD KEEPS THE PROGRESS, AND THE VIEW STILL KNOWS WHERE THE PERSON IS.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await enterFieldMode();
  expect(await progress()).toBe('2 / 4 roads visited · 50%');
  expect((await fieldRoads()).map(road => road.visited)).toEqual([true, false, true, false]);
  // The current road is the first one not visited: the plan, not the last click, decides where the view stands.
  expect(await currentName()).toBe(fieldNames[1]);
  expect(await stopLabel()).toContain('road 2 of 4');

  // 12. TRAVERSE THE WHOLE PLAN, IN THE PERSON'S ORDER, TO ITS END.
  await page.locator('#field-next').click();
  expect(await currentName()).toBe(fieldNames[2]);
  await page.locator('#field-next').click();
  expect(await currentName()).toBe(fieldNames[3]);
  await expect(page.locator('#field-next')).toBeDisabled();
  expect(await stopLabel()).toContain('road 4 of 4');
  for (const step of [1, 2, 3]) { void step; await page.locator('#field-previous').click(); }
  expect(await currentName()).toBe(firstName);
  await expect(page.locator('#field-previous')).toBeDisabled();

  // 13. AN UNRESOLVED MEMBER BEHAVES HONESTLY. The fixture is a road that is no longer saved on this device: its record
  // is taken out of the saved collection while the plan keeps the reference.
  const orphaned = fourth;
  await page.evaluate(([key, id]) => {
    const stored = JSON.parse(globalThis.localStorage.getItem(key));
    stored.candidates = stored.candidates.filter(candidate => candidate.id !== id);
    globalThis.localStorage.setItem(key, JSON.stringify(stored));
  }, [CANDIDATES_KEY, orphaned]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await enterFieldMode();
  expect(await progress()).toBe('2 / 4 roads visited · 50%', 'the plan still holds four roads');
  await page.locator(`#field-road-list li.field-road[data-road-id="${orphaned}"] button.field-road-name`).click();
  await expect(page.locator('#field-unavailable')).toHaveText('Road details unavailable');
  await expect(page.locator('#field-navigate')).toHaveCount(0, { timeout: 5000 });
  expect(await page.locator('#field-navigate-google').count(), 'nothing to navigate to').toBe(0);
  expect(await page.locator('#field-current-facts li').count(), 'and no fact is invented for it').toBe(0);
  // It keeps its place, Previous and Next still walk past it, and it can still be marked visited.
  expect(await stopLabel()).toContain('road 4 of 4');
  await expect(page.locator('#field-previous')).toBeEnabled();
  await page.locator('#field-visit-button').click();
  await expect(page.locator('#field-progress')).toHaveText('3 / 4 roads visited · 75%');
  await page.locator('#field-previous').click();
  expect(await currentName()).toBe(fieldNames[2], 'and the road before it is still there');
  expect(await page.locator('#field-previous').isDisabled(), 'the road that is gone is the last one').toBe(false);

  // 16. DEGRADED. With the network gone, the plan still works: everything the field view reads - the outing, its
  // progress, its notes and checklist, and the saved roads with their kept measurements - is already on this device.
  // Only the basemap tiles and the external mapping application need a network, and neither is required to work a plan.
  await page.context().setOffline(true);
  await page.locator('#field-previous').click();
  expect(await currentName()).toBe(fieldNames[1]);
  await page.locator('#field-visit-button').click();
  await expect(page.locator('#field-progress')).toHaveText('4 / 4 roads visited · 100%');
  await page.locator('#field-checklist input[data-field-item]').first().uncheck();
  await expect(page.locator('#field-checklist input[data-field-item]').first()).not.toBeChecked();
  await page.locator('#field-outing-notes').fill('Worked through with no signal at all.');
  await page.locator('#field-outing-notes').blur();
  await expect.poll(() => page.evaluate(key => JSON.parse(globalThis.localStorage.getItem(key)).outings[0].notes,
    OUTINGS_KEY)).toBe('Worked through with no signal at all.');
  await page.context().setOffline(false);

  // NOTHING IN THIS WORKFLOW ASKED FOR A POSITION, AND NOTHING THE APPLICATION SHIPS IS MISSING.
  positionsAsked = await page.evaluate(() => globalThis.__RN_GEO_CALLS ?? 0);
  expect(positionsAsked, 'field mode never asks the device where it is').toBe(0);
  const unexpected = missing.filter(url => !/\/data\/raw\//.test(url));
  expect(unexpected, `nothing the application ships may be missing: ${unexpected.join(', ')}`).toEqual([]);
  expect(errors).toEqual([]);
  console.log(`OUTING_FIELD ${JSON.stringify({ roads: order.length, progress: await progress(),
    navigate: google, offlineProgress: '4 / 4', viewport: PHONE })}`);
});
