import { test, expect } from '@playwright/test';

import { MILES_TO_M, cameraOf, drawnSearchCentre, fitCountOf, mapAvailable, mapImplementation,
  movementCount, searchGeometry } from './map-contract.js';

// THE GEOGRAPHIC MAP, PROVEN BY REAL BROWSER BEHAVIOUR.
//
//   RUN_MAP_PRODUCTION=1 PRODUCTION_BASE_URL=https://roadnaturalist.com npx playwright test tests/map-interaction.spec.js
//
// This gate is the committed contract for the geographic map: it drives the actual application - types a place, runs
// national discovery, clicks list rows and map lines, pans and zooms the real Leaflet camera, and counts every request
// the page makes. Adapter methods are never called from the test except through the narrow read-only diagnostic the
// factory exposes, and never as the primary proof.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.com';
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
      // The runtime's own declared dependencies: DuckDB-WASM from jsDelivr and its spatial/parquet extensions from the
      // DuckDB CDN. The same two hosts are allowed in tests/national-derived-production.spec.js, and they are how
      // ordinary road geometry is read - not a data plane, and not the Investigator. Anything else is unexpected.
      // A request that contacts no host cannot be an unexpected host: blob: and data: URLs have none, so they are not
      // part of the census rather than counted as an empty name.
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') hosts.add(parsed.host);
      if (RAW_PLANE.test(url)) raw.push(url);
      if (DEEP_DATA.test(url)) deep.push(url);
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    // TEMPORARY (this task): the direct-click trace, printed only when MAP_CLICK_DEBUG=1. Silence is the default, so the
    // gate reads the page exactly as ordinary use runs it; with the flag set it reports which element the click reached,
    // whether the corridor's own handler fired, and whether the map had to answer by proximity instead.
    const clickDebug = Boolean(process.env.MAP_CLICK_DEBUG);
    if (clickDebug) {
      await page.addInitScript(() => { globalThis.__RN_DEBUG_MAP_CLICK = true; });
    }
    // A console error is a failure of the page, not a note: the gate reads the page as it is, with no debug flag set
    // and no diagnostic logging switched on, exactly as ordinary use runs it.
    page.on('console', message => {
      if (message.type() === 'error') pageErrors.push(message.text());
      // TEMPORARY (this task): forward the click trace when it is switched on.
      if (clickDebug && message.text().startsWith('MAP_CLICK_')) console.log(message.text());
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });

    // 3. THE RUNNING MAP IS THE GEOGRAPHIC ONE. There is one map implementation, and an unavailable view is reported
    // as such rather than replaced by anything: a fallback renderer would be a different answer to the same question.
    expect(await mapImplementation(page), 'the application must be running the geographic map').toBe('geo');
    expect(await mapAvailable(page), 'the geographic map must have initialised').toBe(true);
    await expect(page.locator('#map.leaflet-container')).toHaveCount(1);

    await runSearch(page, query);
    expect(await mapImplementation(page)).toBe('geo');

    const camera = () => cameraOf(page);
    const fitCount = () => fitCountOf(page);
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
    // ONE CORRIDOR MAY BE MORE THAN ONE SVG PATH. A corridor whose geometry is a MultiLineString is drawn as one
    // <path> per line part, and every part deliberately carries the same data-corridor-id so any visible segment can
    // select the corridor. Requiring exactly one path would assert something about the geometry rather than about
    // selection, so what is required is: the corridor is drawn, and every path drawn for it names that same corridor.
    const pathsFor = id => page.locator(`#map path[data-role="candidate"][data-corridor-id="${id}"]`);
    await expect(pathsFor(firstId), `${label}: the selected corridor is drawn on the map`).not.toHaveCount(0);
    const drawnIdentities = await pathsFor(firstId).evaluateAll(elements =>
      [...new Set(elements.map(element => element.dataset.corridorId))]);
    expect(drawnIdentities, `${label}: every path drawn for that corridor names that corridor`).toEqual([firstId]);

    // 6/9. THE USER OWNS THE CAMERA - AND THE GESTURE HAS TO BE A REAL ONE.
    //
    // A drag synthesised with DOM MouseEvents from inside the page is not necessarily a drag as Leaflet understands it,
    // so the synthetic attempt runs first and is not asserted on: ignoring untrusted synthetic events is legitimate. It
    // is the real Playwright mouse gesture below, which is what a person actually does, that must move the map - and
    // the movement counter must show that Leaflet, not the coordinates, did the moving.
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
    const movementsAfterSynthetic = await movementCount(page);

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
    const movementsAfterMouse = await movementCount(page);
    const movedByMouse = afterMouse.center[0] !== afterSynthetic.center[0] || afterMouse.center[1] !== afterSynthetic.center[1];
    expect(movedByMouse, `${label}: a real mouse drag must move the map`).toBe(true);
    // A gesture that never reaches Leaflet leaves its movement count where it was, so the counter is what distinguishes
    // "the map moved because the person moved it" from "the coordinates happened to differ".
    expect(movementsAfterMouse, `${label}: the drag must be a move Leaflet itself performed`)
      .toBeGreaterThan(movementsAfterSynthetic);
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
    const search = await searchGeometry(page);
    expect(search.radiusM, `${label}: the requested radius is 25 miles in metres`).toBeCloseTo(25 * MILES_TO_M, 0);
    expect(Math.abs(search.radiusM - 25 * MILES_TO_M), `${label}: within a metre of the request`).toBeLessThan(1);
    await expect(page.locator('#map path[data-role="search-radius"]')).toHaveCount(1);
    await expect(drawnSearchCentre(page)).toHaveCount(1);
    // The adapter exposes the drawn centre in Leaflet order - [lat, lon] - so latitude is index 0 and longitude is
    // index 1. Comparing index 1 to latitude bounds asks whether a longitude is north of Indiana.
    expect(search.center[0], `${label}: the drawn centre's latitude is the searched place`)
      .toBeGreaterThan(geography.lat[0]);
    expect(search.center[0], `${label}: the drawn centre's latitude is the searched place`)
      .toBeLessThan(geography.lat[1]);
    expect(search.center[1], `${label}: the drawn centre's longitude is the searched place`)
      .toBeGreaterThan(geography.lon[0]);
    expect(search.center[1], `${label}: the drawn centre's longitude is the searched place`)
      .toBeLessThan(geography.lon[1]);

    // 5. MAP → LIST. Clicking a line selects the same corridor through the application's own code path.
    //
    // THE CLICK MUST LAND ON A LINE, AND THE LINE'S OWN IDENTITY DECIDES THE ANSWER. A `force` click at the corner of a
    // path's bounding box hits empty space for any diagonal road; drawn roads overlap; and one corridor may be several
    // paths. The probe below therefore scans the drawn parts for one whose midpoint really is on top of a corridor
    // path on screen, and that path's id - read from the DOM the application rendered - is the expectation.
    // THE ROAD UNDER A POINT THAT CAN BE CLICKED. The probe scans the drawn parts for one whose midpoint really is on top
    // of a corridor path on screen, and that path's id - read from the DOM the application rendered - is the expectation.
    // It is used wherever the gate clicks a road, including with the habitat overlay drawn over it.
    const clickableCorridorPoint = () => page.evaluate(() => {
      const candidates = [...document.querySelectorAll('#map path[data-role="candidate"][data-corridor-id]')];
      for (const element of candidates.slice(0, 40)) {
        const length = element.getTotalLength?.() ?? 0;
        if (!length) continue;
        const midpoint = element.getPointAtLength(length / 2);
        const screen = new DOMPoint(midpoint.x, midpoint.y).matrixTransform(element.getScreenCTM());
        const top = document.elementFromPoint(screen.x, screen.y);
        if (top?.dataset?.role === 'candidate' && top.dataset.corridorId) {
          return { x: screen.x, y: screen.y, id: top.dataset.corridorId };
        }
      }
      return null;
    });
    const probe = await clickableCorridorPoint();
    expect(probe, `${label}: a drawn road is visible under a point that can be clicked`).toBeTruthy();
    const targetId = probe.id;
    // TEMPORARY (this task): what the document sees the click reach, when the trace is switched on. The listener is
    // installed once and its record is reset before each traced click, so the buffer click below is traced the same way.
    const clickTrace = async () => page.evaluate(() => (globalThis.__RN_CLICK_TARGET ?? []));
    const resetClickTrace = async () => {
      if (!clickDebug) return;
      await page.evaluate(() => {
        globalThis.__RN_CLICK_TARGET = [];
        if (globalThis.__RN_CLICK_LISTENING) return;
        globalThis.__RN_CLICK_LISTENING = true;
        document.addEventListener('click', event => {
          const node = event.target;
          globalThis.__RN_CLICK_TARGET.push({ tag: node?.tagName ?? null, role: node?.dataset?.role ?? null,
            corridorId: node?.dataset?.corridorId ?? null });
        }, true);
      });
    };
    await resetClickTrace();
    await page.mouse.click(probe.x, probe.y);
    await page.waitForTimeout(800);
    if (clickDebug) {
      console.log(`MAP_CLICK_TARGET ${JSON.stringify({ label, expected: targetId,
        targets: await clickTrace(), selected: await selectedId() })}`);
    }
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
    // RAW DOM EVIDENCE: what popup-ish elements exist at all, and how many candidate paths carry the clicked
    // corridor's identity. Asked rather than inferred, because a card that never appears can mean "never bound",
    // "bound but not opened", or "opened outside the container".
    const popupAudit = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#map .corridor-popup')];
      const visible = cards.filter(entry => entry.offsetParent !== null);
      return { cards: cards.length, visible: visible.length, ids: visible.map(entry => entry.dataset.corridorId) };
    });
    await expect(card, `${label}: the clicked corridor's card must be open`).toBeVisible({ timeout: 15000 });
    expect(popupAudit.visible, `${label}: exactly one corridor card is open`).toBe(1);
    expect(popupAudit.ids, `${label}: and it belongs to the clicked corridor`).toEqual([targetId]);
    const popupText = await card.innerText();
    // The card's own text must name the corridor it claims to describe: the row for that same id in the list is the
    // independent witness, so a card can never pass by naming any road at all.
    const targetRow = page.locator(`#discovery-results tr[data-candidate-id="${targetId}"]`);
    const corridorName = (await targetRow.locator('.discovery-row').innerText()).split('\n')[0];
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
    expect(await targetRow.innerText(), `${label}: the row for that corridor is present`).not.toHaveLength(0);

    // 16/17. ORDINARY MAP USE FETCHES NOTHING DEEP, AND REACHES NO UNEXPECTED HOST.
    expect(raw, `${label}: ordinary map use must read no raw plane`).toEqual([]);
    expect(deep, `${label}: ordinary map use must reach no occurrence, access or Investigator source`).toEqual([]);
    const unexpected = [...hosts].filter(host => !/(^|\.)roadnaturalist\.com$/.test(host)
      && !/(^|\.)roadnaturalist\.pages\.dev$/.test(host) && !/(^|\.)tile\.openstreetmap\.org$/.test(host)
      && host !== 'cdn.jsdelivr.net' && host !== 'extensions.duckdb.org');
    expect(unexpected, `${label}: no unexpected host may be contacted`).toEqual([]);
    expect(await page.locator('#map .leaflet-tile-pane img').count(),
      `${label}: the basemap is drawing tiles`).toBeGreaterThan(0);
    expect(pageErrors, `${label}: the page must stay error-free`).toEqual([]);
    // 24. THE HABITAT LAYER AND ITS ANALYSIS BUFFER.
    //
    // The buffer is the habitat analysis the product already holds, drawn as its own kind: role habitat-buffer, the
    // corridor it belongs to under data-habitat-corridor-id, and never a candidate attribute. Two things are asserted
    // here, and both matter: the layer is either attributed or absent (a buffer that cannot be attributed to an analysis
    // is a defect, not a pass), and a road stays exactly as clickable with the habitat layer enabled as it was without.
    const cameraBeforeBuffer = await camera();
    const fitsBeforeBuffer = await fitCount();
    const selectedForBuffer = await selectedId();
    await page.locator('#habitat-layers').check();
    // The application's own note is its completion signal for this action.
    await expect.poll(async () => (await page.locator('#habitat-layers-note').innerText()).length,
      { timeout: 180000, message: `${label}: the habitat action must report when it is done` }).toBeGreaterThan(0);
    const bufferPaths = page.locator('#map path[data-role="habitat-buffer"]');
    const bufferCount = await bufferPaths.count();
    const analysisPaths = await page.locator('#map path[data-role="candidate"]:not([data-corridor-id])').count();
    if (bufferCount === 0) {
      // NO BUFFER IS RECORDED, NOT PASSED OVER. For a corridor whose habitat analysis is unavailable there is no buffer
      // geometry to draw, and this gate says so with its own evidence; what it will not accept is a corridor whose
      // analysis reached the map while its buffer did not.
      expect(analysisPaths, `${label}: no buffer must mean no habitat analysis reached the map at all`).toBe(0);
    } else {
      expect(bufferCount, `${label}: one buffer, for one analysis`).toBe(1);
      await expect(page.locator(`#map path[data-role="habitat-buffer"][data-habitat-corridor-id="${selectedForBuffer}"]`),
        `${label}: the buffer is attributed to the corridor it belongs to`).toHaveCount(1);
      expect(await bufferPaths.evaluateAll(elements => elements.filter(element => element.dataset.corridorId).length),
        `${label}: the buffer never masquerades as a corridor`).toBe(0);
      expect(await bufferPaths.evaluateAll(elements => elements.every(element =>
        !element.classList.contains('leaflet-interactive'))), `${label}: and it is not interactive`).toBe(true);
    }

    // THE PANEL'S WORDS MUST MATCH THE MAP. With no analysis on the map the note may not claim one, and with a buffer
    // drawn it must describe an analysis rather than an absence.
    const overlayNote = await page.locator('#habitat-layers-note').innerText();
    if (bufferCount === 0) {
      expect(overlayNote, `${label}: with nothing analysed the note must not claim a habitat layer`)
        .not.toMatch(/analysis loaded|analysis completed/i);
      expect(overlayNote, `${label}: and it must say the analysis is unavailable here`).toMatch(/unavailable/i);
    } else {
      expect(overlayNote, `${label}: with the buffer drawn the note describes the analysis that produced it`)
        .toMatch(/Habitat analysis/i);
    }

    // A road is clicked with the habitat layer enabled, and the trace must read exactly as it did without it.
    await resetClickTrace();
    const throughBuffer = await clickableCorridorPoint();
    expect(throughBuffer, `${label}: a road is still clickable with the habitat layer enabled`).toBeTruthy();
    await page.mouse.click(throughBuffer.x, throughBuffer.y);
    await page.waitForTimeout(800);
    if (clickDebug) {
      console.log(`MAP_CLICK_TARGET ${JSON.stringify({ label, phase: 'habitat-enabled', expected: throughBuffer.id,
        targets: await clickTrace(), selected: await selectedId() })}`);
    }
    expect(await selectedId(), `${label}: a click with the habitat layer enabled still selects the road under the cursor`)
      .toBe(throughBuffer.id);
    expect(await camera(), `${label}: the habitat layer and that click must not move the camera`).toEqual(cameraBeforeBuffer);
    expect(await fitCount(), `${label}: and must not fit`).toBe(fitsBeforeBuffer);

    // Disabling the habitat layer takes the buffer away and leaves the camera alone too.
    await page.locator('#habitat-layers').uncheck();
    await expect(bufferPaths).toHaveCount(0);
    expect(await camera(), `${label}: removing the habitat layer must not move the camera`).toEqual(cameraBeforeBuffer);

    console.log(`MAP_PRODUCTION ${JSON.stringify({ label, rows: rowCount, zoom: fitted.zoom.toFixed(2),
      radiusM: Math.round(search.radiusM), bufferPaths: bufferCount, habitatFeaturePaths: analysisPaths,
      hosts: [...hosts].sort(), raw: raw.length, deep: deep.length })}`);
  });
}
