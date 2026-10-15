import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openAdvancedSearch, openAllResults, openChangeLocation } from './discovery-ui.js';

import { cameraOf, fitCountOf } from './map-contract.js';

// RECORDING A TRIP ON A PHONE, WITH A MOCKED DEVICE.
//
//   RUN_TRIP_RECORDING=1 npx playwright test tests/trip-recording.spec.js
//   (against the working tree: PRODUCTION_BASE_URL=http://127.0.0.1:8000 RUN_TRIP_RECORDING=1 ...)
//
// No real GPS is involved. The browser's geolocation is a stub the gate drives by hand, and every call the application
// makes to it is counted - which is how the two things this gate exists for are checked: that a recording is only ever
// started by the person, and that live location and recording share ONE browser watch rather than opening two.
//
// What is under test is the whole field record: sampling that refuses noise, a track that grows, notes and sightings with
// their own time and place, roads that are only ever marked by hand, recording that survives the network going away, a
// stop that produces honest numbers, and a reload that still has all of it.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
const PHONE = { width: 390, height: 844 };
// About 220 m north of the road: far enough that a distance is worth stating, close enough to be "near".
const OFFSET_LAT = 0.002;

test.skip(!process.env.RUN_TRIP_RECORDING, 'set RUN_TRIP_RECORDING=1 to record a trip on a phone viewport');

function region(id) {
  const path = process.env.RANKING_ORDER_ARTIFACT ?? '../data/ranking/exploration-order-v1-evaluation.json';
  const artifact = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  return artifact.regions.find(entry => entry.id === id);
}

// THE DETERMINISTIC DEVICE. A cleared watch keeps its callbacks on purpose: a reading delivered after "Stop" really does
// reach the application, which must ignore it on its own.
async function mockDevice(context) {
  await context.addInitScript(() => {
    const calls = { watch: 0, watchOptions: [], clear: 0, request: 0 };
    const watches = new Map();
    const cleared = new Map();
    globalThis.__RN_LOCATION_CALLS = calls;
    globalThis.__RN_LOCATION = Object.freeze({
      emit(position) { for (const entry of [...watches.values(), ...cleared.values()]) entry.success({ coords: position }); },
      fail(code) { for (const entry of [...watches.values(), ...cleared.values()]) entry.error({ code }); },
    });
    const geolocation = {
      getCurrentPosition() { calls.request += 1; },
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
}

test('a trip is recorded only because it was asked for, and live location and recording share one watch', async ({ page, context }) => {
  test.setTimeout(1800000);
  const princeton = region('princeton-in');
  await page.setViewportSize(PHONE);
  await mockDevice(context);

  const calls = () => page.evaluate(() => globalThis.__RN_LOCATION_CALLS);
  const emit = (position) => page.evaluate(fix => globalThis.__RN_LOCATION.emit(fix), position);
  const rows = () => page.locator('#discovery-results tbody tr');
  const track = () => page.locator('#map [data-role="trip-track"]');
  const recordingStatus = () => page.locator('#field-recording-status');
  const summary = async () => page.locator('#field-recording-summary').evaluate(node => ({
    points: Number(node.dataset.points), metres: Number(node.dataset.metres), events: Number(node.dataset.events),
    visited: Number(node.dataset.visited), text: node.textContent }));
  const fieldRoads = () => page.locator('#field-road-list li.field-road').evaluateAll(items =>
    items.map(item => ({ roadId: item.dataset.roadId, visited: item.dataset.visited === 'true' })));
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
  // The road's representative point, read from the app's own handoff link: the same coordinate a navigation app would be
  // given, and therefore the one a mocked device should stand beside.
  async function currentRoadPoint() {
    const href = await page.locator('#field-navigate-google').getAttribute('href');
    const [lat, lon] = /destination=(-?\d+\.\d+),(-?\d+\.\d+)$/.exec(href).slice(1).map(Number);
    return { latitude: lat, longitude: lon };
  }
  // A SEQUENCE OF READINGS NORTH OF A POINT, far enough apart to be movement and not noise.
  const north = (from, metres, seconds) => ({ latitude: from.latitude + metres / 110540, longitude: from.longitude,
    accuracy: 8, at: seconds });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await openChangeLocation(page);
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });
  await openAdvancedSearch(page);
  await page.locator('#discovery-center-lat').fill(princeton.center[1].toFixed(4));
  await page.locator('#discovery-center-lon').fill(princeton.center[0].toFixed(4));
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-radius-input').fill(String(princeton.radiusMiles));
  await page.locator('#discovery-radius-input').press('Enter');
  await openChangeLocation(page);
  await page.locator('#discover-roads').click();
  // THE ROWS ARE BEHIND "Explore all results": the gate opens the workbench after the search, like a person would.
  await openAllResults(page);
  await expect(rows().first()).toBeVisible({ timeout: 600000 });

  // 1-2. A PERSISTED FOUR-ROAD OUTING, OPENED IN FIELD MODE.
  const [first, second, third, fourth] = await rows().evaluateAll(list =>
    list.slice(0, 4).map(row => row.dataset.candidateId));
  await addToOuting(first, { create: true });
  for (const id of [second, third, fourth]) await addToOuting(id);
  await enterFieldMode();

  // 3. NOTHING IS RECORDING, AND NOTHING HAS ASKED THE DEVICE FOR ANYTHING.
  await expect(recordingStatus()).toHaveText('Not recording');
  await expect(page.locator('#field-record-start')).toBeVisible();
  await expect(page.locator('#field-record-stop')).toHaveCount(0);
  expect(await calls()).toEqual({ watch: 0, watchOptions: [], clear: 0, request: 0 });
  await expect(page.locator('#trip-list li.trip')).toHaveCount(0);
  expect(await track().count(), 'and no trace is drawn').toBe(0);

  // 4-5. START RECORDING, AND THE FIRST READING ARRIVES.
  await page.locator('#field-record-start').click();
  await expect(recordingStatus()).toHaveText('Recording');
  await expect(page.locator('#field-record-stop')).toBeVisible();
  const started = await calls();
  expect(started.watch, 'starting a recording opens the one watch').toBe(1);
  expect(started.watchOptions[0], 'and it asks for an accurate, current fix').toEqual({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  await expect(page.locator('#trip-recording-banner')).toBeVisible();
  const road = await currentRoadPoint();
  await emit({ latitude: road.latitude, longitude: road.longitude, accuracy: 9 });
  await expect.poll(async () => (await summary()).points, { timeout: 30000 }).toBe(1);
  await expect(track(), 'one point is not a line yet').toHaveCount(0);

  // 6-7. STATIONARY, NOISY READINGS ARE NOT POINTS. Twenty callbacks two seconds apart, jittering by a few metres.
  for (let index = 0; index < 20; index += 1) {
    await emit({ latitude: road.latitude + (index % 3) * 0.00002, longitude: road.longitude, accuracy: 12 });
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(500);
  const parked = await summary();
  expect(parked.points, 'a parked car records nothing new, however many callbacks arrive').toBe(1);
  expect(parked.metres, 'and the recorded track is still zero').toBe(0);

  // 8-9. MOVEMENT IS RECORDED, AND THE TRACE GROWS. A sequence north of the road, each reading 200 m from the last.
  for (let index = 1; index <= 8; index += 1) {
    await emit(north(road, 200 * index, index * 2));
    await expect.poll(async () => (await summary()).points, { timeout: 30000 }).toBe(index + 1);
  }
  const moving = await summary();
  expect(moving.metres, 'the recorded track measures the movement it recorded').toBeGreaterThan(1400);
  expect(moving.text).toContain('recorded GPS track');
  await expect(track(), 'and the trace is drawn as its own kind of line').toHaveCount(1);
  expect(await track().first().getAttribute('data-role')).toBe('trip-track');
  // THE TRACE TAKES NO CLICK AND CARRIES NO IDENTITY: a road under it is still the thing a click selects. Leaflet marks an
  // interactive path with its own class, and the trace must not carry it.
  expect(await track().first().getAttribute('data-corridor-id')).toBeNull();
  expect(await track().first().evaluate(node => node.classList.contains('leaflet-interactive')),
    'a recorded trace is not an interactive path').toBe(false);
  expect(await page.locator('#map path.leaflet-interactive[data-role=\"trip-track\"]').count()).toBe(0);
  // AND A RECORDED POINT MOVES NOTHING: the camera is exactly where it was.
  const cameraBefore = JSON.stringify(await cameraOf(page));
  const fitsBefore = await fitCountOf(page);
  await emit(north(road, 1800, 20));
  await page.waitForTimeout(300);
  expect(JSON.stringify(await cameraOf(page)), 'a recorded point never moves the camera').toBe(cameraBefore);
  expect(await fitCountOf(page), 'and is never a fit').toBe(fitsBefore);

  // 10. A FIELD NOTE, WITH ITS OWN TIME AND PLACE.
  await page.locator('#field-note-text').fill('Cattle grid open, gate leaning');
  await page.locator('#field-add-note').click();
  await expect(page.locator('#field-events li.field-event')).toHaveCount(1);
  expect((await summary()).events).toBe(1);
  await expect(page.locator('#field-events li.field-event').first()).toHaveAttribute('data-event-type', 'note');

  // 11. A ROAD IS MARKED VISITED BY HAND - the only way it ever happens.
  const beforeMark = await fieldRoads();
  const currentRoadId = await page.locator('#field-road-list li.field-road.current').getAttribute('data-road-id');
  expect(beforeMark.find(entry => entry.roadId === currentRoadId).visited).toBe(false);
  await page.locator('#field-visit-button').click();
  await expect(page.locator('#field-progress')).toContainText('1 / 4');
  expect((await summary()).visited, 'and the recording reports it, because the plan does').toBe(1);

  // 12-13. A POSITION BESIDE ANOTHER ROAD MARKS NOTHING. Marking the first road visited moved the derived position to
  // the next unvisited road, so the road the person is now standing beside is that one - and it stays unvisited.
  await expect(page.locator('#field-stop')).toContainText('2 of 4', { timeout: 30000 });
  const secondRoad = await currentRoadPoint();
  await emit({ latitude: secondRoad.latitude + 0.0001, longitude: secondRoad.longitude, accuracy: 10 });
  await expect(page.locator('#field-location-start'), 'live location is off: recording does not turn it on')
    .toHaveText('Use my location');
  await page.waitForTimeout(300);
  expect((await fieldRoads()).filter(entry => entry.visited).length, 'still exactly one road is visited').toBe(1);
  await expect(page.locator('#field-progress')).toContainText('1 / 4');
  await expect(page.locator('#field-visit-button'), 'and the button is still the person\'s to press').toBeVisible();

  // 14-15. THE CURRENT ROAD CHANGES, AND A SIGHTING IS ADDED AGAINST IT.
  await page.locator('#field-next').click();
  await expect(page.locator('#field-stop')).toContainText('3 of 4', { timeout: 30000 });
  const thirdRoadId = await page.locator('#field-road-list li.field-road.current').getAttribute('data-road-id');
  await page.locator('#field-sighting-text').fill('Two kestrels over the fence line');
  await page.locator('#field-add-sighting').click();
  await expect(page.locator('#field-events li.field-event')).toHaveCount(2);
  await expect(page.locator('#field-events li.field-event').first()).toHaveAttribute('data-event-type', 'sighting');
  expect((await summary()).events).toBe(2);

  // 16-17. THE NETWORK GOES AWAY. The application is already loaded, and recording does not depend on it.
  await context.setOffline(true);
  const beforeOffline = (await summary()).points;
  for (let index = 1; index <= 4; index += 1) {
    await emit(north(secondRoad, 1400 + 200 * index, 30 + index * 2));
    await expect.poll(async () => (await summary()).points, { timeout: 30000 }).toBe(beforeOffline + index);
  }
  const offline = await summary();
  const finalPoints = offline.points;
  expect(finalPoints).toBeGreaterThan(beforeOffline);
  expect(offline.events, 'and the notes taken offline are there too').toBe(2);
  await context.setOffline(false);

  // 18-19. STOPPING PRODUCES AN HONEST RECORD: a duration, a point count and a recorded length.
  await page.locator('#field-record-stop').click();
  await expect(recordingStatus()).toHaveText('Not recording');
  await expect(page.locator('#field-record-start')).toBeVisible();
  await expect(page.locator('#field-recording-summary')).toHaveCount(0, 'the running numbers go with the recording');
  const stopped = await calls();
  expect(stopped.watch, 'and no second watch was ever opened').toBe(1);
  expect(stopped.clear, 'the recording was the only consumer, so stopping it cleared the watch').toBe(1);
  const trip = page.locator('#trip-list li.trip').first();
  const tripId = await trip.getAttribute('data-trip-id');
  await expect(page.locator('#trip-list li.trip')).toHaveCount(1);
  await expect(page.locator('#trip-recording-banner')).toHaveCount(0);
  const facts = await page.locator('#trip-list li.trip .trip-facts').first().innerText();
  expect(facts).toContain('recorded GPS track');
  expect(facts).toContain(`${finalPoints} points`);
  expect(facts).toContain('1 / 4 roads marked visited');
  expect(facts).toContain('2 events');

  // 20-22. THE PAGE RELOADS. The trip is on the device, its track, its events and its visited snapshot with it.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#trips')).toBeVisible({ timeout: 180000 });
  await expect(page.locator('#trip-count')).toHaveText('1', { timeout: 180000 });
  await expect(page.locator('#trip-list li.trip')).toHaveCount(1);
  await expect(page.locator(`#trip-list li.trip[data-trip-id="${tripId}"]`)).toBeVisible();
  await page.locator(`#trip-open-${tripId}`).click();
  await expect(page.locator(`#trip-detail-${tripId}`)).toBeVisible();
  const detail = await page.locator(`#trip-detail-${tripId}`).innerText();
  expect(detail).toContain('Recorded GPS track');
  expect(detail).toContain(`Recorded points: ${finalPoints} kept`);
  expect(detail).toContain('1 / 4 roads in this outing, marked by hand');
  expect(detail).toContain('1 note · 1 sighting');
  await expect(page.locator(`#trip-events-${tripId} li.trip-event`)).toHaveCount(2);
  await expect(page.locator(`#trip-events-${tripId} li.trip-event`).first()).toContainText('Cattle grid open');
  await expect(page.locator(`#trip-events-${tripId} li.trip-event`).last()).toContainText('Two kestrels');
  const snapshot = await page.locator(`#trip-roads-${tripId} li[data-road-id]`).evaluateAll(items =>
    items.map(item => item.dataset.roadId));
  expect(snapshot, 'the road the person marked by hand is in the record').toEqual([currentRoadId]);
  expect(await page.locator(`#trip-roads-${tripId} li[data-road-id="${thirdRoadId}"]`).count(),
    'and the road a sighting was taken on is not, because nobody marked it').toBe(0);
  // THE MAP IS ALIVE AFTER THE RELOAD BEFORE ANYTHING IS SAID ABOUT WHAT IT DRAWS: a session whose map did not
  // initialise is a different failure from a trace that is not drawn, and this gate is about the trace.
  await expect.poll(() => page.evaluate(() => globalThis.__RN_MAP?.available ?? false), { timeout: 60000 }).toBe(true);
  // THE STORED TRACE IS DRAWN AGAIN, AS THE SAME KIND OF LINE. The roles the map is holding are printed with the run, so
  // a failure here says what was drawn rather than only what was missing.
  // eslint-disable-next-line no-console -- the map's own drawing is the evidence this gate reports
  console.log(`TRIP_MAP ${JSON.stringify({ roles: await page.locator('#map [data-role]').evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('data-role'))) })}`);
  await expect(track()).toHaveCount(1, { timeout: 30000 });
  // AND FITTING IT IS THE PERSON'S OWN CONTROL, counted like any other fit.
  const fitsBeforeFit = await fitCountOf(page);
  await page.locator(`#trip-fit-${tripId}`).click();
  await expect.poll(() => fitCountOf(page), { timeout: 30000 }).toBe(fitsBeforeFit + 1);

  // 23. THE EXPORT IS A FILE ON THIS DEVICE, AND NOTHING ELSE HAPPENS.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator(`#trip-export-${tripId}`).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^road-naturalist-trip-\d{4}-\d{2}-\d{2}-trip-.+\.geojson$/);
  const geojson = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(geojson.type).toBe('FeatureCollection');
  expect(geojson.features[0].geometry.type, 'the track is a LineString').toBe('LineString');
  expect(geojson.features[0].properties.pointCount).toBe(finalPoints);
  expect(geojson.features[0].properties.lengthNote).toContain('not a driving distance');
  expect(geojson.features.filter(feature => feature.properties.kind === 'trip-point').length).toBe(finalPoints);
  const exportedEvents = geojson.features.filter(feature => feature.properties.kind === 'trip-event');
  expect(exportedEvents.length).toBe(2);
  expect(exportedEvents.map(feature => feature.properties.eventType)).toEqual(['note', 'sighting']);
  expect(geojson.properties.note).toContain('no route was reconstructed');
  await expect(page.locator('#trips')).toContainText('written to your device and sent nowhere');

  // 24. DELETING THE TRIP DELETES THE TRIP, AND THE PLAN IS UNTOUCHED. It takes the same two explicit answers every
  // destructive control in this project takes: one control that asks, then a confirmation.
  await page.locator(`#trip-delete-${tripId}`).click();
  await expect(page.locator(`#trip-delete-cancel-${tripId}`), 'the question can be answered with "keep"').toBeVisible();
  await page.locator(`#trip-delete-cancel-${tripId}`).click();
  await expect(page.locator('#trip-list li.trip'), 'and keeping it keeps it').toHaveCount(1);
  await page.locator(`#trip-delete-${tripId}`).click();
  await page.locator(`#trip-delete-confirm-${tripId}`).click();
  await expect(page.locator('#trip-list li.trip')).toHaveCount(0);
  await expect(page.locator('#trip-count')).toHaveText('0');
  await expect(page.locator('#outing-list article.outing-card'), 'the plan is still there').toHaveCount(1);
  await page.locator('#outing-list button[data-open-outing]').first().click();
  await page.locator('#outing-field-mode').click();
  await expect(page.locator('#field-progress'), 'with the road the person marked still visited').toContainText('1 / 4');

  console.log(`TRIP_RECORDING ${JSON.stringify({ points: moving.points, metres: Math.round(moving.metres),
    offlinePoints: offline.points, events: offline.events, watchCalls: stopped.watch, cleared: stopped.clear,
    viewport: PHONE })}`);
});

// THE LIFECYCLE OF THE ONE BROWSER WATCH.
//
// Live location and trip recording are separate choices that share one device stream. Each order of turning them on has to
// keep exactly one watch open, stopping one must never stop the other, and turning both off must leave nothing watching.
const lifecycleCalls = page => page.evaluate(() => globalThis.__RN_LOCATION_CALLS);
const lifecycleEmit = (page, fix) => page.evaluate(position => globalThis.__RN_LOCATION.emit(position), fix);

async function fourRoadFieldPlan(page, context) {
  await mockDevice(context);
  const princeton = region('princeton-in');
  await page.setViewportSize(PHONE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await openChangeLocation(page);
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });
  await openAdvancedSearch(page);
  await page.locator('#discovery-center-lat').fill(princeton.center[1].toFixed(4));
  await page.locator('#discovery-center-lon').fill(princeton.center[0].toFixed(4));
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-radius-input').fill(String(princeton.radiusMiles));
  await page.locator('#discovery-radius-input').press('Enter');
  await openChangeLocation(page);
  await page.locator('#discover-roads').click();
  await openAllResults(page);
  const rows = page.locator('#discovery-results tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 600000 });
  const ids = await rows.evaluateAll(list => list.slice(0, 4).map(row => row.dataset.candidateId));
  for (const [index, id] of ids.entries()) {
    await page.locator(`#discovery-results tbody tr[data-candidate-id="${id}"] button.discovery-row`).click();
    const select = page.locator('#discovery-add-outing');
    await expect(select).toBeVisible();
    if (index === 0) await select.selectOption('__new__');
    await page.locator('#discovery-add-to-outing').click();
    await expect(page.locator(`#outing-roads li.outing-road[data-road-id="${id}"]`)).toBeVisible({ timeout: 120000 });
  }
  await page.locator('#outing-list button[data-open-outing]').first().click();
  await page.locator('#outing-field-mode').click();
  await expect(page.locator('#field-mode')).toBeVisible();
}

test('live location and recording share one watch, in both orders, and stopping either leaves the other alone', async ({ page, context }) => {
  test.setTimeout(1800000);
  await fourRoadFieldPlan(page, context);
  const href = await page.locator('#field-navigate-google').getAttribute('href');
  const [lat, lon] = /destination=(-?\d+\.\d+),(-?\d+\.\d+)$/.exec(href).slice(1).map(Number);
  const here = { latitude: lat, longitude: lon, accuracy: 9 };
  const position = () => page.locator('#map [data-role="user-location"]');

  // LIVE LOCATION FIRST, THEN RECORDING: STILL ONE WATCH.
  await page.locator('#field-location-start').click();
  await expect(page.locator('#field-location-status')).toHaveText('Location: asking…', { timeout: 30000 });
  await lifecycleEmit(page, here);
  await expect(page.locator('#field-location-status')).toHaveText('Location on', { timeout: 30000 });
  expect((await lifecycleCalls(page)).watch).toBe(1);
  await page.locator('#field-record-start').click();
  await expect(page.locator('#field-recording-status')).toHaveText('Recording');
  expect((await lifecycleCalls(page)).watch, 'starting a recording opens no second watch').toBe(1);
  await lifecycleEmit(page, here);
  await expect.poll(async () => Number(await page.locator('#field-recording-summary').getAttribute('data-points')), { timeout: 30000 }).toBe(1);
  await expect(position(), 'and the live marker is still the same reading').toHaveCount(1);

  // STOPPING LIVE LOCATION DOES NOT STOP THE RECORDING.
  await page.locator('#field-location-stop').click();
  await expect(page.locator('#field-location-status')).toHaveText('Location off');
  await expect(position()).toHaveCount(0);
  expect((await lifecycleCalls(page)).clear, 'the watch is still open: a recording is listening').toBe(0);
  await lifecycleEmit(page, { latitude: lat + 0.002, longitude: lon, accuracy: 9 });
  await expect.poll(async () => Number(await page.locator('#field-recording-summary').getAttribute('data-points')), { timeout: 30000 }).toBe(2);
  await expect(page.locator('#map [data-role="trip-track"]'), 'and the trace grows without a marker').toHaveCount(1);

  // RECORDING FIRST, THEN LIVE LOCATION: THE LIVE LOCATION JOINS THE WATCH THAT IS ALREADY OPEN.
  await page.locator('#field-location-start').click();
  await expect(page.locator('#field-location-status')).toHaveText('Location: asking…', { timeout: 30000 });
  expect((await lifecycleCalls(page)).watch, 'joining a running recording opens no second watch').toBe(1);
  await lifecycleEmit(page, { latitude: lat + 0.004, longitude: lon, accuracy: 9 });
  await expect(page.locator('#field-location-status')).toHaveText('Location on', { timeout: 30000 });
  await expect(position()).toHaveCount(1);

  // STOPPING THE RECORDING LEAVES LIVE LOCATION RUNNING.
  await page.locator('#field-record-stop').click();
  await expect(page.locator('#field-recording-status')).toHaveText('Not recording');
  await expect(page.locator('#trip-recording-banner')).toHaveCount(0);
  expect((await lifecycleCalls(page)).clear, 'the live marker still has the watch').toBe(0);
  const marker = page.locator('#map [data-role="user-location"]');
  const markerBefore = await marker.getAttribute('d');
  // A MOVEMENT BIG ENOUGH TO BE MANY PIXELS AT ANY ZOOM: this is about the marker still being fed, not about sub-pixel
  // precision.
  await lifecycleEmit(page, { latitude: lat + 0.02, longitude: lon, accuracy: 9 });
  await expect.poll(() => marker.getAttribute('d'), { timeout: 30000 }).not.toBe(markerBefore);
  await expect(page.locator('#field-location-status'), 'and live location is still on').toHaveText('Location on');

  // BOTH OFF: NOTHING IS WATCHING, AND NO READING REACHES ANYTHING.
  await page.locator('#field-location-stop').click();
  await expect(page.locator('#field-location-status')).toHaveText('Location off');
  const finished = await lifecycleCalls(page);
  expect(finished.watch, 'the session opened exactly one browser watch').toBe(1);
  expect(finished.clear, 'and cleared exactly that one').toBe(1);
  await lifecycleEmit(page, { latitude: lat + 0.008, longitude: lon, accuracy: 9 });
  await expect(position()).toHaveCount(0);
  console.log(`TRIP_WATCH_LIFECYCLE ${JSON.stringify({ watchCalls: finished.watch, cleared: finished.clear })}`);
});

test('a recording left running by a closed page comes back interrupted, with every point it had', async ({ page, context }) => {
  test.setTimeout(1800000);
  await fourRoadFieldPlan(page, context);
  const href = await page.locator('#field-navigate-google').getAttribute('href');
  const [lat, lon] = /destination=(-?\d+\.\d+),(-?\d+\.\d+)$/.exec(href).slice(1).map(Number);
  await page.locator('#field-record-start').click();
  await expect(page.locator('#field-recording-status')).toHaveText('Recording');
  await lifecycleEmit(page, { latitude: lat, longitude: lon, accuracy: 9 });
  await lifecycleEmit(page, { latitude: lat + 0.002, longitude: lon, accuracy: 9 });
  await lifecycleEmit(page, { latitude: lat + 0.004, longitude: lon, accuracy: 9 });
  await expect.poll(async () => Number(await page.locator('#field-recording-summary').getAttribute('data-points')), { timeout: 30000 }).toBe(3);
  await page.locator('#field-note-text').fill('Turned around at the washout');
  await page.locator('#field-add-note').click();
  await expect(page.locator('#field-events li.field-event')).toHaveCount(1);

  // THE PAGE IS CLOSED AND REOPENED. Nothing stopped the recording.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#trip-count')).toHaveText('1', { timeout: 180000 });
  const tripId = await page.locator('#trip-list li.trip').first().getAttribute('data-trip-id');
  await expect(page.locator(`#trip-interrupted-${tripId}`)).toContainText('interrupted when this page closed');
  await expect(page.locator(`#trip-interrupted-${tripId}`)).toContainText('3 recorded points are kept');
  await expect(page.locator('#trip-list li.trip .trip-status').first()).toHaveText('Recording interrupted');
  await expect(page.locator('#trip-recording-banner'), 'and nothing is recording now').toHaveCount(0);
  // NOTHING WAS DISCARDED: the points and the note are in the record.
  await page.locator(`#trip-open-${tripId}`).click();
  await expect(page.locator(`#trip-detail-${tripId}`)).toContainText('Recorded points: 3 kept');
  await expect(page.locator(`#trip-events-${tripId} li.trip-event`)).toContainText('Turned around at the washout');
  // FINISHING IT ENDS THE RECORD AT THE LAST POINT THAT WAS ACTUALLY RECORDED.
  await page.locator(`#trip-finish-${tripId}`).click();
  await expect(page.locator('#trip-list li.trip .trip-status')).toHaveCount(0);
  await expect(page.locator(`#trip-detail-${tripId}`)).toContainText('Recorded points: 3 kept');
  await expect(page.locator(`#trip-interrupted-${tripId}`)).toHaveCount(0);
  // AND A RELOAD STILL HAS IT, AS A FINISHED RECORD.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#trip-count')).toHaveText('1', { timeout: 180000 });
  await expect(page.locator('#trip-list li.trip .trip-status')).toHaveCount(0);
  console.log(`TRIP_INTERRUPTED ${JSON.stringify({ tripId })}`);
});
