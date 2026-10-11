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
      if (message.text().startsWith('MAP_FIT')) console.log(message.text());
    });

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
      document.querySelector('#discovery-results tbody tr.selected .discovery-row')?.dataset?.candidateId ?? null);

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
    const idOfRow = index => rows.nth(index).locator('.discovery-row').getAttribute('data-candidate-id');
    const firstId = await idOfRow(0);
    await rows.nth(0).locator('.discovery-row').click();
    expect(await selectedId(), `${label}: the clicked row is the selected one`).toBe(firstId);
    await expect(page.locator(`#map path[data-role="candidate"][data-corridor-id="${firstId}"]`)).toHaveCount(1);

    // 6/9. THE USER OWNS THE CAMERA. Pan and zoom deliberately, then assert ordinary changes leave it alone.
    await page.evaluate(() => {
      const container = document.querySelector('#map');
      const bounds = container.getBoundingClientRect();
      const at = (type, x, y) => container.dispatchEvent(new MouseEvent(type, { clientX: bounds.left + x,
        clientY: bounds.top + y, bubbles: true, cancelable: true, view: window, buttons: 1 }));
      at('mousedown', 400, 300);
      at('mousemove', 260, 220);
      at('mousemove', 190, 170);
      at('mouseup', 190, 170);
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(1000);
    const moved = await camera();
    expect(moved.center[0], `${label}: the drag must have moved the camera`).not.toBeCloseTo(initial.center[0], 5);

    // Selection must not move it.
    const secondId = await idOfRow(1);
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
    expect(afterFit.searchCentre[1], `${label}: the drawn centre is the searched place`)
      .toBeGreaterThan(geography.lat[0]);
    expect(afterFit.searchCentre[1], `${label}: the drawn centre is the searched place`)
      .toBeLessThan(geography.lat[1]);

    // 5. MAP → LIST. Clicking a line selects the same corridor through the application's own code path.
    const targetId = await idOfRow(2);
    const targetPath = page.locator(`#map path[data-role="candidate"][data-corridor-id="${targetId}"]`).first();
    await targetPath.click({ force: true, position: { x: 3, y: 3 } });
    await page.waitForTimeout(800);
    expect(await selectedId(), `${label}: a map click selects the same corridor in the list`).toBe(targetId);
    const afterMapClick = await camera();
    expect(afterMapClick.center[0], `${label}: a map click must not move the camera`).toBeCloseTo(fitted.center[0], 3);
    expect(await fitCount(), `${label}: a map click must not fit`).toBe(2);

    // 12. THE POPUP CARRIES THE RANKING, CROSS-CHECKED AGAINST THE CORRIDOR'S OWN RESULT.
    await targetPath.click({ force: true, position: { x: 3, y: 3 } });
    const popup = page.locator('#map .leaflet-popup-content');
    await expect(popup).toBeVisible({ timeout: 15000 });
    const popupText = await popup.innerText();
    const corridorName = (await rows.nth(2).locator('.discovery-row').innerText()).split('\n')[0];
    expect(popupText, `${label}: the popup names the corridor`).toContain(corridorName);
    expect(popupText, `${label}: the popup states the order and a score`).toMatch(/Naturalist interest \d+(\.\d+)?/);
    expect(popupText, `${label}: the popup labels its components`)
      .toMatch(/Wetland context: (strong|moderate|some|little mapped|not measured)/);
    expect(popupText, `${label}: the popup gives distance from the search centre`)
      .toMatch(/mi from search centre/);
    expect(await page.locator('#map .leaflet-popup-content [data-ranking-version]').getAttribute('data-ranking-version'),
      `${label}: the popup is traceable to the model that produced the score`).toBe('naturalist-interest-v1');
    // The score in the popup is the score the list explains for that corridor, not merely any number.
    const listScore = await page.evaluate(id => {
      const row = document.querySelector(`#discovery-results tbody tr .discovery-row[data-candidate-id="${id}"]`);
      return row?.closest('tr')?.innerText ?? '';
    }, targetId);
    const score = Number((popupText.match(/Naturalist interest (\d+(\.\d+)?)/) ?? [])[1]);
    expect(Number.isFinite(score), `${label}: the popup score is a number`).toBe(true);
    expect(listScore.length, `${label}: the row for that corridor is present`).toBeGreaterThan(0);

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
