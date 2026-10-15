import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openAdvancedSearch, openAllResults } from './discovery-ui.js';

import { cameraOf, fitCountOf } from './map-contract.js';

// WHERE AM I, RELATIVE TO THE ROAD I AM WORKING - WITH A MOCKED DEVICE.
//
//   RUN_LIVE_LOCATION=1 npx playwright test tests/live-location.spec.js
//
// No real GPS is involved: the browser's geolocation is a fixed, known position, and the gate counts every call the
// application makes to it. What is under test is the application's behaviour - opt-in, one watch, no persistence, no
// automatic progress, honest refusals, and a camera that only moves when it is asked to.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
const PHONE = { width: 390, height: 844 };
// About 220 m north of the point above: far enough that a distance is worth stating, close enough to be "near".
const OFFSET_LAT = 0.002;

test.skip(!process.env.RUN_LIVE_LOCATION, 'set RUN_LIVE_LOCATION=1 to drive live location on a phone viewport');

function region(id) {
  const path = process.env.RANKING_ORDER_ARTIFACT ?? '../data/ranking/exploration-order-v1-evaluation.json';
  const artifact = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  return artifact.regions.find(entry => entry.id === id);
}

test('a position is asked for, shown, measured, and stopped - and never decides anything', async ({ page, context }) => {
  test.setTimeout(1800000);
  const princeton = region('princeton-in');
  await page.setViewportSize(PHONE);
  await context.addInitScript(() => {
    // A DETERMINISTIC DEVICE. The whole Geolocation API is replaced by a stub the gate drives by hand: every call the
    // application makes is counted, and readings are delivered only when the gate says so. A cleared watch keeps its
    // callbacks here on purpose, so a reading emitted after "Stop" really does reach the application - which must ignore
    // it on its own.
    const calls = { watch: 0, watchOptions: [], clear: 0, request: 0 };
    const watches = new Map();
    const cleared = new Map();
    globalThis.__RN_LOCATION_CALLS = calls;
    globalThis.__RN_LOCATION = Object.freeze({
      emit(position) { for (const entry of [...watches.values(), ...cleared.values()]) entry.success({ coords: position }); },
      fail(code) { for (const entry of [...watches.values(), ...cleared.values()]) entry.error({ code }); },
    });
    const geolocation = {
      getCurrentPosition(success, error, options) { calls.request += 1; },
      watchPosition(success, error, options) {
        calls.watch += 1;
        calls.watchOptions.push(options ?? null);
        watches.set(calls.watch, { success, error });
        return calls.watch;
      },
      clearWatch(id) {
        calls.clear += 1;
        const entry = watches.get(id);
        if (entry) cleared.set(id, entry);
        watches.delete(id);
      },
    };
    Object.defineProperty(globalThis.navigator, 'geolocation', { configurable: true, get: () => geolocation });
  });

  const calls = () => page.evaluate(() => globalThis.__RN_LOCATION_CALLS);
  // A READING, DELIVERED BY THE GATE. Nothing happens on the device's own schedule here.
  const emit = (position) => page.evaluate(fix => globalThis.__RN_LOCATION.emit(fix), position);
  const refuse = (code) => page.evaluate(value => globalThis.__RN_LOCATION.fail(value), code);
  await openAllResults(page);
  const rows = () => page.locator('#discovery-results tbody tr');
  const camera = async () => JSON.stringify(await cameraOf(page));
  const positions = () => page.locator('[data-role="user-location"]');
  const fieldRoads = () => page.locator('#field-road-list li.field-road').evaluateAll(items =>
    items.map(item => ({ roadId: item.dataset.roadId, visited: item.dataset.visited === 'true' })));
  const proximity = async () => (await page.locator('#field-proximity').innerText()).trim();
  async function addToOuting(candidateId, { create = false } = {}) {
    await page.locator(`#discovery-results tbody tr[data-candidate-id="${candidateId}"] button.discovery-row`).click();
    const select = page.locator('#discovery-add-outing');
    await expect(select).toBeVisible();
    if (create) await select.selectOption('__new__');
    await page.locator('#discovery-add-to-outing').click();
    await expect(page.locator(`#outing-roads li.outing-road[data-road-id="${candidateId}"]`))
      .toBeVisible({ timeout: 120000 });
  }
  async function enterFieldMode() {
    await page.locator('#outing-list button[data-open-outing]').first().click();
    await page.locator('#outing-field-mode').click();
    await expect(page.locator('#field-mode')).toBeVisible();
  }
  // The road's representative point, read from the app's own handoff link: the same coordinate a navigation app would
  // be given, and therefore the one a mocked device should stand beside.
  async function currentRoadPoint() {
    const href = await page.locator('#field-navigate-google').getAttribute('href');
    const [lat, lon] = /destination=(-?\d+\.\d+),(-?\d+\.\d+)$/.exec(href).slice(1).map(Number);
    return { latitude: lat, longitude: lon };
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

  // 1-2. A PERSISTED FOUR-ROAD OUTING, OPENED IN FIELD MODE.
  const [first, second, third, fourth] = await rows().evaluateAll(list =>
    list.slice(0, 4).map(row => row.dataset.candidateId));
  await addToOuting(first, { create: true });
  for (const id of [second, third, fourth]) await addToOuting(id);
  await enterFieldMode();

  // 3. NOTHING ASKED FOR A POSITION ON ITS OWN - not on load, not on entering field mode.
  expect(await calls()).toEqual({ watch: 0, watchOptions: [], clear: 0, request: 0 });
  await expect(page.locator('#field-location-status')).toHaveText('Location off');
  await expect(page.locator('#field-location-start')).toHaveText('Use my location');
  await expect(page.locator('#field-location-privacy')).toContainText('not saved with the outing');
  await expect(page.locator('#field-proximity')).toHaveCount(0, { timeout: 5000 });
  expect(await positions().count()).toBe(0);

  // 4-7. ASKED FOR, ONE WATCH, A MARKER, A DISTANCE AND THE DEVICE'S OWN ACCURACY.
  const road = await currentRoadPoint();
  await page.locator('#field-location-start').click();
  await expect(page.locator('#field-location-status')).toHaveText('Location: asking…', { timeout: 30000 });
  const started = await calls();
  expect(started.watch, 'exactly one watch is opened, and only when asked').toBe(1);
  expect(started.request, 'and no one-shot request is made').toBe(0);
  expect(started.watchOptions[0].enableHighAccuracy, 'a live reading asks the device to fix itself').toBe(true);
  await emit({ latitude: road.latitude + OFFSET_LAT, longitude: road.longitude, accuracy: 18 });
  await expect(page.locator('#field-location-status')).toHaveText('Location on', { timeout: 30000 });
  await expect(positions()).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator('[data-role="user-location-accuracy"]')).toHaveCount(1);
  await expect(page.locator('#field-location-accuracy')).toHaveText(/GPS accuracy ≈ \d+ m/);
  const firstProximity = await proximity();
  expect(firstProximity, `a straight-line distance to this road: ${firstProximity}`).toMatch(/About .* from this road$/);
  await expect(page.locator('#field-proximity-note')).toContainText('straight-line proximity to the mapped road');
  const cameraWithLocation = await camera();
  const fitsWithLocation = await fitCountOf(page);

  // 8-9. ANOTHER ROAD, THE SAME READING: the measurement changes and the watch does not.
  await page.locator('#field-next').click();
  await expect.poll(proximity, { timeout: 30000 }).not.toBe(firstProximity);
  expect((await calls()).watch, 'changing the current road does not start another watch').toBe(1);
  // 10. A NEW READING REPLACES THE OLD ONE, and still nothing else happens. The new reading is taken from the CURRENT
  // road's own representative point, so what the distance becomes is unambiguous rather than a rounding accident.
  const secondProximity = await proximity();
  const secondRoad = await currentRoadPoint();
  await emit({ latitude: secondRoad.latitude + 0.02, longitude: secondRoad.longitude, accuracy: 30 });
  await expect(page.locator('#field-location-accuracy')).toHaveText(/GPS accuracy ≈ 30 m/, { timeout: 30000 });
  const updated = await proximity();
  expect(updated, `the distance follows the new reading: ${secondProximity} -> ${updated}`).not.toBe(secondProximity);
  expect(updated, 'about two kilometres from the road, in miles').toMatch(/^About 1\.\d mi from this road$/);
  await expect(positions()).toHaveCount(1, 'one position, replaced by the next');
  expect((await calls()).watch, 'and still one watch').toBe(1);
  // 11-12. THE VIEWPORT BELONGS TO THE PERSON: no reading, and no road change, has moved it.
  expect(await camera(), 'a reading never moves the camera').toBe(cameraWithLocation);
  expect(await fitCountOf(page), 'and never counts as a fit').toBe(fitsWithLocation);

  // 13-14. THE TWO MOVES THAT ARE ASKED FOR, AND ONLY THEY.
  await page.locator('#field-center-on-me').click();
  await expect.poll(camera, { timeout: 20000 }).not.toBe(cameraWithLocation);
  const centred = await camera();
  await page.locator('#field-fit-me-road').click();
  await expect.poll(camera, { timeout: 20000 }).not.toBe(centred);
  expect(await fitCountOf(page), 'Fit me + current road is a fit, and counted as one').toBe(fitsWithLocation + 1);

  // 15-16. BEING NEAR A ROAD MARKS NOTHING. Standing beside it does not visit it; the person does. The reading is taken
  // beside the CURRENT road's own representative point, and the fix is coarse enough that the distance is inside it.
  const nearRoad = await currentRoadPoint();
  await emit({ latitude: nearRoad.latitude + 0.0001, longitude: nearRoad.longitude, accuracy: 20 });
  await expect(page.locator('#field-proximity')).toHaveText('Near this road', { timeout: 30000 });
  await expect(page.locator('#field-proximity')).toHaveAttribute('data-near', 'true');
  await expect(page.locator('#field-visit-button')).toHaveAttribute('data-near', 'true');
  await expect(page.locator('.field-near-note')).toContainText('You appear to be near this road');
  expect((await fieldRoads()).filter(road => road.visited).length,
    'a position never marks a road visited').toBe(0);
  await page.locator('#field-visit-button').click();
  await expect(page.locator('#field-progress')).toHaveText('1 / 4 roads visited · 25%');
  expect((await fieldRoads()).filter(road => road.visited).length, 'the person marked it, and only the person').toBe(1);

  // 17-18. STOPPING: the marker goes, the watch is cleared, and no further reading arrives.
  await page.locator('#field-location-stop').click();
  await expect(page.locator('#field-location-status')).toHaveText('Location off');
  await expect(positions()).toHaveCount(0);
  await expect(page.locator('#field-proximity')).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('#field-location-accuracy')).toHaveCount(0);
  const stopped = await calls();
  expect(stopped.clear, 'the watch is cleared when it is stopped').toBe(1);
  // A READING DELIVERED AFTER STOP REACHES NOTHING: the application has stopped listening, whatever the device does.
  await emit({ latitude: road.latitude + 0.02, longitude: road.longitude, accuracy: 12 });
  await page.waitForTimeout(500);
  expect(await positions().count(), 'a stopped watch draws nothing, however the device moves').toBe(0);
  await expect(page.locator('#field-location-status')).toHaveText('Location off');
  expect((await calls()).watch, 'and starts no new watch on its own').toBe(1);

  // DENIED: the browser refuses, and the plan carries on exactly as it did.
  await page.locator('#field-location-start').click();
  await expect(page.locator('#field-location-status')).toHaveText('Location: asking…', { timeout: 30000 });
  expect((await calls()).watch, 'a retry after a refusal opens a new watch rather than doing nothing').toBe(2);
  await refuse(1);
  await expect(page.locator('#field-location-status')).toHaveText('Location: not granted', { timeout: 30000 });
  await expect(page.locator('#field-location-message')).toContainText('Location permission was not granted');
  await expect(page.locator('#field-location-message')).toContainText('plan still works');
  await expect(page.locator('#field-location-stop'), 'a refused watch leaves nothing to stop').toHaveCount(0);
  expect(await positions().count()).toBe(0);
  await page.locator('#field-next').click();
  await expect(page.locator('#field-stop')).toContainText('3 of 4', { timeout: 30000 });
  await page.locator('#field-visit-button').click();
  await expect(page.locator('#field-progress')).toHaveText('2 / 4 roads visited · 50%');

  // UNAVAILABLE: a device that cannot determine where it is says so, and the plan still carries on.
  await page.locator('#field-location-start').click();
  await expect(page.locator('#field-location-status')).toHaveText('Location: asking…', { timeout: 30000 });
  await refuse(2);
  await expect(page.locator('#field-location-status')).toHaveText('Location: unavailable', { timeout: 30000 });
  await expect(page.locator('#field-location-message')).toContainText('could not determine a location');
  await expect(page.locator('#field-location-message')).toContainText('plan still works');
  expect(await positions().count()).toBe(0);
  await expect(page.locator('#field-progress')).toHaveText('2 / 4 roads visited · 50%', 'and no progress moved');
  // STOPPING FROM A FAILED WATCH IS STILL AVAILABLE, and returns the view to a plain, working plan.
  await page.locator('#field-location-stop').click();
  await expect(page.locator('#field-location-status')).toHaveText('Location off');
  await expect(page.locator('#field-unvisit, #field-visit-button').first(), 'the plan is still workable').toBeVisible();
  // A TIMEOUT IS RECOVERABLE, IN THE SAME WAY.
  await page.locator('#field-location-start').click();
  await refuse(3);
  await expect(page.locator('#field-location-status')).toHaveText('Location: timed out', { timeout: 30000 });
  await expect(page.locator('#field-location-message')).toContainText('try again');
  await page.locator('#field-location-start').click();
  const recovered = await currentRoadPoint();
  await emit({ latitude: recovered.latitude + 0.0001, longitude: recovered.longitude, accuracy: 20 });
  await expect(page.locator('#field-location-status')).toHaveText('Location on', { timeout: 30000 });
  await expect(page.locator('#field-proximity')).toHaveText('Near this road');
  console.log(`LIVE_LOCATION ${JSON.stringify({ first: firstProximity, watchCalls: (await calls()).watch,
    cleared: (await calls()).clear, viewport: PHONE })}`);
});

