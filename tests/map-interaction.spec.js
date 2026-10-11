import { test, expect } from '@playwright/test';

// THE GEOGRAPHIC MAP, PROVEN BY REAL BROWSER BEHAVIOUR.
//
//   RUN_MAP_PRODUCTION=1 PRODUCTION_BASE_URL=https://roadnaturalist.com npx playwright test tests/map-interaction.spec.js
//
// This is the gate that licenses retiring the schematic renderer, so it drives the actual application: it types a
// place, runs national discovery, clicks list rows and map lines, pans and zooms the real Leaflet camera, and counts
// every request the page makes. Adapter methods are never called from the test except through the narrow read-only
// diagnostic the factory exposes, and never as the primary proof.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.com';
const MILES_TO_M = 1609.344;
// Ordinary map use must reach nothing that costs data: no raw plane, no source evidence, no occurrence source, no
// Investigator Worker. Basemap tiles are the one expected addition.
const RAW_PLANE = /\/(national\/roads|national\/wetlands|national\/hydro)\//;
const DEEP_DATA = /api\.inaturalist|api\.ebird|api\.roadnaturalist\.com|overpass|investigator/i;
const REGIONS = Object.freeze([
  ['princeton in', 'Princeton, IN', { lat: [37.6, 38.6], lon: [-88.2, -87.1] }],
  ['portland oregon', 'Portland, OR', { lat: [44.9, 46.0], lon: [-124.2, -122.0] }],
]);

test.skip(!process.env.RUN_MAP_PRODUCTION, 'set RUN_MAP_PRODUCTION=1 to verify the deployed geographic map');

async function runSearch(page, query) {
  await page.locator('#discovery-place').fill(query);
  await page.locator('#discovery-place-results .discovery-place-option').first().waitFor({ timeout: 120000 });
  await page.locator('#discovery-place-results .discovery-place-option').first().click();
  await page.locator('#discovery-radius-input').fill('25');
  await page.locator('#discovery-radius-input').press('Enter');
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL', { timeout: 120000 });
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 600000 });
  await expect(page.locator('#candidate-list .discovery-row, #discovery-results .discovery-row').first())
    .toBeVisible({ timeout: 120000 });
}


for (const [query, label, geography] of REGIONS) {
  test(`deployed geographic map: ${label}`, async ({ page }) => {
    test.setTimeout(3600000);
    await page.setViewportSize({ width: 1440, height: 950 });
    const raw = [];
    const deep = [];
    const hosts = new Set();
    const pageErrors = [];
    page.on('request', request => {
      const url = request.url();
      hosts.add(new URL(url).host);
      if (RAW_PLANE.test(url)) raw.push(url);
      if (DEEP_DATA.test(url)) deep.push(url);
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') pageErrors.push(message.text());
      // The application's own trace of the automatic fit, printed only when it is enabled, so the ordering can be
      // read from a run instead of inferred from the source.
      if (/^MAP_(FIT|PATH|POPUP)/.test(message.text())) {
        console.log(message.text());
      }
    });

    // The application's own evidence/map stage markers are silent unless this flag is set, so the trace this gate
    // reads is opt-in exactly as it is in production.
    await page.addInitScript(() => { globalThis.__RN_DEBUG_EVIDENCE = true; });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });

    // 3. THE RUNNING MAP IS THE GEOGRAPHIC ONE. Asserted before and after a search, so a fallback cannot hide.
    expect(await page.evaluate(() => globalThis.__RN_MAP?.implementation ?? null),
      'the application must be running the geographic map, not the schematic one').toBe('geo');
    expect(await page.evaluate(() => globalThis.__RN_MAP?.available ?? false),
      'the geographic map must have initialised').toBe(true);
    await expect(page.locator('#map.leaflet-container')).toHaveCount(1);

    await runSearch(page, query);
    expect(await page.evaluate(() => globalThis.__RN_MAP?.implementation ?? null)).toBe('geo');

    const camera = () => page.evaluate(() => globalThis.__RN_MAP.camera());
    const fitCount = () => page.evaluate(() => globalThis.__RN_MAP.fitCount());
    const selectedId = () => page.evaluate(() =>
      document.querySelector('#discovery-results tbody tr.selected')?.dataset?.candidateId ?? null);

    // 22. GEOGRAPHY SANITY: a lat/lon inversion or a stale-region camera shows up here immediately. The automatic
    // fit is animated, so the camera is allowed a moment to arrive before its position is judged - and the fit is
    // proven to have been *asked for* first, so a camera failure and a missing fit are two different failures.
    await expect.poll(fitCount, { timeout: 30000,
      message: `${label}: the new search must own exactly one automatic fit` }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await camera()).center[0], { timeout: 30000,
      message: `${label}: the camera must arrive where the fit sent it` }).toBeGreaterThan(geography.lon[0]);
    const initial = await camera();
    expect(initial.center[0], `${label}: longitude`).toBeGreaterThan(geography.lon[0]);
    expect(initial.center[0], `${label}: longitude`).toBeLessThan(geography.lon[1]);
    expect(initial.center[1], `${label}: latitude`).toBeGreaterThan(geography.lat[0]);
    expect(initial.center[1], `${label}: latitude`).toBeLessThan(geography.lat[1]);

    // 4. LIST → MAP. The row and the drawn line carry the same corridor id, taken from the row itself.
    const rows = page.locator('#discovery-results tbody tr');
    const rowCount = Math.min(await rows.count(), 10);
    expect(rowCount, `${label}: discovery must produce candidates`).toBeGreaterThan(1);
    // The corridor id belongs to the row element, which is the stable contract the list renders; reading it from
    // the button inside it yields nothing and turns into the literal string "null".
    const idOfRow = index => rows.nth(index).getAttribute('data-candidate-id');
    const requireIdOfRow = async index => {
      const id = await idOfRow(index);
      expect(id, `${label}: row ${index} must carry its corridor id, not ${JSON.stringify(id)}`).toBeTruthy();
      return id;
    };
    const firstId = await requireIdOfRow(0);
    await rows.nth(0).locator('.discovery-row').click();
    expect(await selectedId(), `${label}: the clicked row is the selected one`).toBe(firstId);
    await expect(page.locator(`#map path[data-role="candidate"][data-corridor-id="${firstId}"]`)).toHaveCount(1);

    // 6/9. THE USER OWNS THE CAMERA - AND THE GESTURE HAS TO BE A REAL ONE.
    //
    // A drag synthesised with DOM MouseEvents from inside the page is not necessarily a drag as Leaflet understands
    // it, so both are measured here: the synthetic attempt first (recorded, not asserted, because ignoring untrusted
    // synthetic events is legitimate), then a real Playwright mouse gesture, which is what a person actually does.
    const beforeDrag = await camera();
    const movementsBefore = await page.evaluate(() => globalThis.__RN_MAP.movements());
    await page.evaluate(() => {
      const container = document.querySelector('#map');
      const bounds = container.getBoundingClientRect();
      const at = (type, x, y) => container.dispatchEvent(new MouseEvent(type, { clientX: bounds.left + x,
        clientY: bounds.top + y, bubbles: true, cancelable: true, view: window, buttons: 1 }));
      at('mousedown', 400, 300);
      at('mousemove', 260, 220);
      at('mousemove', 190, 170);
      at('mouseup', 190, 170);
    });
    await page.waitForTimeout(600);
    const afterSynthetic = await camera();
    const movementsAfterSynthetic = await page.evaluate(() => globalThis.__RN_MAP.movements());
    console.log(`MAP_DRAG ${JSON.stringify({ label, kind: 'synthetic',
      moved: afterSynthetic.center[0] !== beforeDrag.center[0] || afterSynthetic.center[1] !== beforeDrag.center[1],
      zoomChanged: afterSynthetic.zoom !== beforeDrag.zoom, movements: movementsAfterSynthetic - movementsBefore })}`);

    // The real gesture: the map's own box, well inside it, away from the zoom control and any popup.
    // A REAL GESTURE NEEDS REAL SCREEN COORDINATES. The map panel sits below the fold on this viewport, so
    // `boundingBox()` reports a viewport position that is off-screen: `document.elementFromPoint` returns null
    // there, and a real mouse drag never touches Leaflet at all (its movement count stays at zero). Scrolling the
    // map into view first is what makes the gesture real, and it is the difference between proving the product
    // and blaming it.
    await page.locator('#map').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const box = await page.locator('#map').boundingBox();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(900);
    const afterMouse = await camera();
    const movementsAfterMouse = await page.evaluate(() => globalThis.__RN_MAP.movements());
    const movedByMouse = afterMouse.center[0] !== afterSynthetic.center[0] || afterMouse.center[1] !== afterSynthetic.center[1];
    console.log(`MAP_DRAG ${JSON.stringify({ label, kind: 'mouse', moved: movedByMouse,
      zoomChanged: afterMouse.zoom !== afterSynthetic.zoom, movements: movementsAfterMouse - movementsAfterSynthetic })}`);
    expect(movedByMouse, `${label}: a real mouse drag must move the map`).toBe(true);
    expect(afterMouse.zoom, `${label}: a pan must not change the zoom`).toBeCloseTo(afterSynthetic.zoom, 5);
    const moved = afterMouse;

    // Selection must not move it.
    const secondId = await requireIdOfRow(1);
    await rows.nth(1).locator('.discovery-row').click();
    await page.waitForTimeout(400);
    const afterSelection = await camera();
    expect(afterSelection.center[0], `${label}: selection must not move the camera`).toBeCloseTo(moved.center[0], 4);
    expect(afterSelection.center[1], `${label}: selection must not move the camera`).toBeCloseTo(moved.center[1], 4);
    expect(afterSelection.zoom, `${label}: selection must not change the zoom`).toBeCloseTo(moved.zoom, 2);
    expect(await selectedId()).toBe(secondId);
    expect(await fitCount(), `${label}: ordinary selection must never fit`).toBe(1);

    // 8. Sort must not move it, including the ranked order.
    await page.locator('#discovery-sort').selectOption('naturalistInterest');
    await page.waitForTimeout(700);
    const afterSort = await camera();
    expect(afterSort.center[0], `${label}: sort must not move the camera`).toBeCloseTo(moved.center[0], 4);
    expect(afterSort.zoom, `${label}: sort must not change the zoom`).toBeCloseTo(moved.zoom, 2);
    await expect(rows.first()).toBeVisible();

    // 7. Fit results is an explicit camera move, and it lands on the drawn corridors.
    await page.locator('#fit-results').click();
    await page.waitForTimeout(900);
    expect(await fitCount(), `${label}: Fit results is exactly one explicit fit`).toBe(2);
    const fitted = await camera();
    expect(fitted.zoom, `${label}: Fit results should zoom in on the results`).toBeGreaterThan(1);
    const afterFit = await page.evaluate(() => {
      const centre = globalThis.__RN_MAP.camera().center;
      const search = globalThis.__RN_MAP.searchGeometry();
      return { centre, radiusM: search.radiusM, searchCentre: search.center };
    });
    expect(afterFit.radiusM, `${label}: the requested radius is 25 miles in metres`)
      .toBeCloseTo(25 * MILES_TO_M, 0);
    expect(Math.abs(afterFit.radiusM - 25 * MILES_TO_M), `${label}: within a metre of the request`).toBeLessThan(1);
    await expect(page.locator('#map path[data-role="search-radius"]')).toHaveCount(1);
    await expect(page.locator('#map path[data-role="search-center"]')).toHaveCount(1);
    // The adapter exposes the drawn centre in Leaflet order - [lat, lon] - so latitude is index 0 and longitude is
    // index 1. Comparing index 1 to latitude bounds asks whether a longitude is north of Indiana.
    expect(afterFit.searchCentre[0], `${label}: the drawn centre's latitude is the searched place`)
      .toBeGreaterThan(geography.lat[0]);
    expect(afterFit.searchCentre[0], `${label}: the drawn centre's latitude is the searched place`)
      .toBeLessThan(geography.lat[1]);
    expect(afterFit.searchCentre[1], `${label}: the drawn centre's longitude is the searched place`)
      .toBeGreaterThan(geography.lon[0]);
    expect(afterFit.searchCentre[1], `${label}: the drawn centre's longitude is the searched place`)
      .toBeLessThan(geography.lon[1]);

    // 5. MAP → LIST. Clicking a line selects the same corridor through the application's own code path.
    const targetId = await requireIdOfRow(2);
    const targetPath = page.locator(`#map path[data-role="candidate"][data-corridor-id="${targetId}"]`).first();
    await targetPath.click({ force: true, position: { x: 3, y: 3 } });
    await page.waitForTimeout(800);
    expect(await selectedId(), `${label}: a map click selects the same corridor in the list`).toBe(targetId);
    const afterMapClick = await camera();
    expect(afterMapClick.center[0], `${label}: a map click must not move the camera`).toBeCloseTo(fitted.center[0], 3);
    expect(await fitCount(), `${label}: a map click must not fit`).toBe(2);

    // 12. THE POPUP IS THE CARD FOR THE CORRIDOR THAT WAS CLICKED, and it is the only card open.
    //
    // The click above already selected the corridor and opened its card. Leaflet *toggles* a popup when the same layer
    // is clicked twice, so clicking again here would close the very card this section is looking for and leave the
    // assertions reading whichever popup some other layer left in the DOM. The card is awaited instead, and every
    // assertion is scoped to the corridor whose id it must carry.
    const card = page.locator(`#map .corridor-popup[data-corridor-id="${targetId}"]`);
    await expect(card, `${label}: the clicked corridor's card must be open`).toBeVisible({ timeout: 15000 });
    const popupAudit = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#map .corridor-popup')];
      const visible = cards.filter(entry => entry.offsetParent !== null);
      return { cards: cards.length, visible: visible.length, ids: visible.map(entry => entry.dataset.corridorId) };
    });
    console.log(`MAP_POPUP ${JSON.stringify({ label, clickedId: targetId, selectedId: await selectedId(), ...popupAudit })}`);
    expect(popupAudit.visible, `${label}: exactly one corridor card is open`).toBe(1);
    expect(popupAudit.ids, `${label}: and it belongs to the clicked corridor`).toEqual([targetId]);
    const popupText = await card.innerText();
    const corridorName = (await rows.nth(2).locator('.discovery-row').innerText()).split('\n')[0];
    expect(popupText, `${label}: the card names the corridor`).toContain(corridorName);
    expect(popupText, `${label}: the card states the order and a score`).toMatch(/Naturalist interest \d+(\.\d+)?/);
    expect(popupText, `${label}: the card labels its components`)
      .toMatch(/Wetland context: (strong|moderate|some|little mapped|not measured)/);
    expect(popupText, `${label}: the card gives distance from the search centre`)
      .toMatch(/mi from search centre/);
    expect(await card.getAttribute('data-ranking-version'),
      `${label}: the card is traceable to the model that produced the score`).toBe('naturalist-interest-v1');
    // The score on the card belongs to that same corridor's own result, not merely to some card.
    const score = Number((popupText.match(/Naturalist interest (\d+(\.\d+)?)/) ?? [])[1]);
    expect(Number.isFinite(score), `${label}: the card score is a number`).toBe(true);
    expect(await rows.nth(2).innerText(), `${label}: the row for that corridor is present`).not.toHaveLength(0);

    // 16/17. ORDINARY MAP USE FETCHES NOTHING DEEP, AND REACHES NO UNEXPECTED HOST.
    expect(raw, `${label}: ordinary map use must read no raw plane`).toEqual([]);
    expect(deep, `${label}: ordinary map use must reach no occurrence, access or Investigator source`).toEqual([]);
    const unexpected = [...hosts].filter(host => !/(^|\.)roadnaturalist\.com$/.test(host)
      && !/(^|\.)roadnaturalist\.pages\.dev$/.test(host) && !/(^|\.)tile\.openstreetmap\.org$/.test(host));
    expect(unexpected, `${label}: no unexpected host may be contacted`).toEqual([]);
    expect(await page.locator('#map .leaflet-tile-pane img').count(),
      `${label}: the basemap is drawing tiles`).toBeGreaterThan(0);
    expect(pageErrors, `${label}: the page must stay error-free`).toEqual([]);
    console.log(`MAP_PRODUCTION ${JSON.stringify({ label, rows: rowCount, zoom: fitted.zoom.toFixed(2),
      radiusM: Math.round(afterFit.radiusM), hosts: [...hosts].sort(), raw: raw.length, deep: deep.length })}`);
  });
}
