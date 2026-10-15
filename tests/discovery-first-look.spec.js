import { test, expect } from '@playwright/test';

import { openAdvancedSearch, openChangeLocation } from './discovery-ui.js';
import { DEFAULT_RADIUS_MILES } from '../src/discovery/search-definition.js';
import { cameraOf, fitCountOf } from './map-contract.js';

// WHAT A PERSON SEES COLD, AND WHERE THE ANSWER LANDS.
//
//   RUN_FIRST_LOOK=1 npx playwright test tests/discovery-first-look.spec.js
//
// Two questions, both measured rather than asserted in the abstract: before a search, is the primary action inside the first
// phone viewport, with no disclosure to open; and after one, is "#1 Best overall" in front of the person instead of below a
// search form they have already used? The numbers are logged, so a regression in layout is visible as a number and not only
// as a failed expectation.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 950 };
// The controls that configure *how* the search is bounded. None of them may be visible before somebody asks for them.
const TECHNICAL = ['#discovery-center-lat', '#discovery-center-lon', '#discovery-center-apply', '#discovery-center-pick',
  '#discovery-radius', '#discovery-radius-input', '#discovery-area', '#discovery-presets', '#discovery-sort',
  '#discovery-wetland', '#discovery-min-length', '#discovery-max-length', '#discovery-ecoregion', '#discovery-results'];

test.skip(!process.env.RUN_FIRST_LOOK, 'set RUN_FIRST_LOOK=1 to see the discovery surface as a first-time user does');

// THE CONTROLS THAT ARE ACTUALLY ON SCREEN, by id (or by tag and class where an element has no id). A collapsed <details>
// hides its content, so this list is exactly what a person could press.
const visibleControls = page => page.locator('#discovery').evaluate(node => {
  // `checkVisibility` is what a person's browser actually shows: it accounts for the content of a closed <details>, which
  // modern engines hide with `content-visibility` rather than with `display: none`.
  const shown = element => element.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true,
    visibilityProperty: true });
  return [...node.querySelectorAll('button, input, select, summary')].filter(shown)
    .map(element => element.id || `${element.tagName.toLowerCase()}.${element.className.split(' ')[0]}`);
});

// EVERY POSITION THIS GATE TALKS ABOUT, in one round trip: viewport-relative boxes, the page's own scroll, and whether the
// page overflows sideways. A box is null when the element is not on screen at all, which is itself the answer sometimes.
const layout = (page, selectors) => page.evaluate(list => {
  const box = selector => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), h: Math.round(rect.height) };
  };
  const boxes = {};
  for (const selector of list) boxes[selector] = box(selector);
  return { viewport: window.innerHeight, scrollY: Math.round(window.scrollY),
    overflow: document.documentElement.scrollWidth - window.innerWidth, boxes };
}, selectors);

async function freshPage(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });
}

// THE ORDINARY PATH: type a place, choose it, press the one button. No coordinates, no radius, no disclosure.
async function findRoadsByPlace(page, place) {
  await page.locator('#discovery-place').fill(place);
  await expect(page.locator('#discovery-place-results')).toBeVisible({ timeout: 60000 });
  await page.locator('#discovery-place-results .discovery-place-option').first().click();
  await page.locator('#discover-roads').click();
  await expect(page.locator('#recommendation-list li.recommendation').first()).toBeVisible({ timeout: 600000 });
}

async function expectTechnicalControlsHidden(page) {
  for (const selector of TECHNICAL) {
    await expect(page.locator(selector), `${selector} waits behind a disclosure`).not.toBeVisible();
  }
}

test('before a search, a phone shows where to search, one button, and the primary action is on the first screen', async ({ page }) => {
  test.setTimeout(1800000);
  await freshPage(page, PHONE);
  // THE ORDINARY PATH IS THE WHOLE SURFACE: a place, this device's location, one button, and the disclosure.
  expect((await visibleControls(page)).sort()).toEqual(['discover-roads', 'discovery-advanced-search-heading',
    'discovery-place', 'discovery-use-location'].sort());
  await expect(page.locator('#discover-roads')).toHaveText('Find roads');
  await expect(page.locator('#discovery-advanced-search-heading')).toHaveText('Advanced search');
  await expectTechnicalControlsHidden(page);
  // MEASURED, NOT GUESSED. The intro is a product statement, not a manifesto: the whole ordinary path - the page's own
  // heading, the place, this device's location and the button - fits the first phone viewport with room to spare.
  const fresh = await layout(page, ['.site-header', '.intro', '.discovery-panel', '#discovery-place', '#discover-roads',
    '#discovery-advanced-search']);
  const find = fresh.boxes['#discover-roads'];
  expect(find, 'the primary action is laid out').toBeTruthy();
  expect(find.bottom, 'and its bottom edge is inside the first viewport').toBeLessThanOrEqual(fresh.viewport);
  expect(find.top, 'and its top edge is well inside it').toBeLessThan(fresh.viewport * 0.85);
  expect(fresh.boxes['.intro'].h, 'the intro is a statement, not a manifesto').toBeLessThanOrEqual(280);
  expect(fresh.boxes['#discovery-place'].bottom).toBeLessThan(find.top);
  expect(fresh.boxes['#discovery-advanced-search'].top).toBeGreaterThan(find.bottom);
  expect(fresh.boxes['#discovery-advanced-search'].h, 'the advanced search is one collapsed row').toBeLessThanOrEqual(70);
  expect(fresh.overflow, 'no horizontal overflow at 390 px').toBeLessThanOrEqual(0);
  console.log(`FIRST_LOOK_PHONE_BEFORE ${JSON.stringify(fresh)}`);
});

test('after a search, a phone puts #1 Best overall in the first viewport', async ({ page }) => {
  test.setTimeout(1800000);
  await freshPage(page, PHONE);
  await findRoadsByPlace(page, 'Princeton');
  // THE ANSWER, AND THE ASSUMPTION IN ITS HEADING.
  await expect(page.locator('#recommendations-heading'))
    .toHaveText(`Best road-naturalist drives within ${DEFAULT_RADIUS_MILES} miles`);
  const cards = page.locator('#recommendation-list li.recommendation');
  await expect(cards).toHaveCount(5);
  const first = await cards.first().getAttribute('data-candidate-id');
  await expect(page.locator(`#recommendation-rank-${first}`)).toHaveText('#1 Best overall');
  await expect(page.locator('#recommendation-list li.recommendation.best')).toHaveCount(1);
  // THE SEARCH FORM HAS DONE ITS JOB AND IS GONE: what was searched is one summary line and one Change location control.
  await expect(page.locator('#discovery-place')).not.toBeVisible();
  await expect(page.locator('#discover-roads')).not.toBeVisible();
  await expect(page.locator('#discovery-use-location')).not.toBeVisible();
  await expect(page.locator('#discovery-search-compact')).toBeVisible();
  await expect(page.locator('#discovery-compact-line')).toContainText('Princeton');
  await expect(page.locator('#discovery-summary')).toContainText(`within ${DEFAULT_RADIUS_MILES} mi`);
  await expect(page.locator('#discovery-summary')).toContainText('roads considered');
  await expect(page.locator('#discovery-change-location')).toBeVisible();
  await expectTechnicalControlsHidden(page);
  await expect(page.locator('#discovery-advanced-heading')).toBeVisible();
  await expect(page.locator('#discovery-advanced-heading')).toHaveText('Explore all results');
  // THE POINT OF THE PASS: "#1 Best overall" is inside the first viewport - measured against the position the browser is
  // already in, with no scrolling of our own, and also with the page at the very top.
  const after = await layout(page, ['#discovery-search-compact', '#discovery-summary', '#recommendations-heading',
    `#recommendation-rank-${first}`, '#recommendation-list li.recommendation', '#discovery-advanced-heading',
    '#discovery-change']);
  const rank = after.boxes[`#recommendation-rank-${first}`];
  expect(rank, 'the first card is on screen').toBeTruthy();
  expect(rank.top, 'and #1 Best overall is inside the first viewport').toBeLessThanOrEqual(after.viewport);
  expect(rank.bottom, 'fully, not clipped').toBeLessThanOrEqual(after.viewport);
  expect(after.boxes['#recommendations-heading'].top, 'with the heading above it').toBeLessThan(rank.top);
  expect(after.boxes['#discovery-search-compact'].h, 'the search summary is one compact block').toBeLessThanOrEqual(100);
  expect(after.boxes['#discovery-advanced-heading'].top, 'and the workbench stays below the answer')
    .toBeGreaterThan(rank.bottom);
  expect(after.overflow, 'no horizontal overflow after a search either').toBeLessThanOrEqual(0);
  console.log(`FIRST_LOOK_PHONE_AFTER ${JSON.stringify(after)}`);
  // AND WITH THE PAGE AT THE TOP, with no browser scroll at all: still in the first viewport.
  await page.evaluate(() => window.scrollTo(0, 0));
  const top = await layout(page, [`#recommendation-rank-${first}`, '#recommendations-heading']);
  expect(top.scrollY).toBe(0);
  expect(top.boxes[`#recommendation-rank-${first}`].top,
    'from the top of the page, #1 is still in the first viewport').toBeLessThanOrEqual(top.viewport);
  console.log(`FIRST_LOOK_PHONE_AFTER_TOP ${JSON.stringify(top)}`);
});
test('Change location brings the ordinary controls back, keeps the answer, and stays out of Advanced search', async ({ page }) => {
  test.setTimeout(1800000);
  await freshPage(page, PHONE);
  await findRoadsByPlace(page, 'Princeton');
  const cards = page.locator('#recommendation-list li.recommendation');
  await expect(cards).toHaveCount(5);
  const first = await cards.first().getAttribute('data-candidate-id');

  // SELECTING A ROAD NEEDS NO DISCLOSURE AT ALL, and the detail appears with it.
  await page.locator(`#recommendation-show-${first}`).click();
  await expect(page.locator('#discovery-selected')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#discovery-selected')).toContainText('Selected discovery corridor');
  await page.locator(`#recommendation-more-${first}`).click();
  await expect(page.locator('#discovery-selected')).toBeVisible();

  // CHANGE LOCATION IS THE ORDINARY PATH, NOT ADVANCED SEARCH: the place field takes focus, the technical half stays shut,
  // and the recommendations are still on screen while the next location is being chosen.
  await page.locator('#discovery-change-location').click();
  await expect(page.locator('#discovery-change')).toHaveAttribute('open', '');
  await expect(page.locator('#discovery-place')).toBeFocused();
  await expect(page.locator('#discovery-advanced-search')).not.toHaveAttribute('open', '');
  await expect(page.locator('#discovery-center-lat')).not.toBeVisible();
  await expect(cards).toHaveCount(5, 'editing the next location does not destroy the answer');
  await expect(page.locator('#discovery-selected')).toBeVisible();

  // THE CURRENT DEFINITION IS IN THE SAME CONTROLS - not a second draft: the radius is still the one the search ran with,
  // and the run's own statement of what is active is unchanged.
  await openAdvancedSearch(page);
  await expect(page.locator('#discovery-radius-input')).toHaveValue(String(DEFAULT_RADIUS_MILES));
  await expect(page.locator('#discovery-center-lat')).not.toHaveValue('');
  await expect(page.locator('#discovery-active-search'))
    .toContainText(`Custom radius search · ${DEFAULT_RADIUS_MILES} mi`);
  console.log('FIRST_LOOK_CHANGE_LOCATION restored with the current definition');
});

test('the workbench still opens behind the answer, and a warning still survives it', async ({ page }) => {
  test.setTimeout(1800000);
  await freshPage(page, PHONE);
  await findRoadsByPlace(page, 'Princeton');
  const first = await page.locator('#recommendation-list li.recommendation').first().getAttribute('data-candidate-id');

  // OPENING "Explore all results" REVEALS THE UNCHANGED WORKBENCH, and the answer stays visible behind it.
  await expect(page.locator('#discovery-advanced')).not.toHaveAttribute('open', '');
  await page.locator('#discovery-advanced-heading').click();
  await expect(page.locator('#discovery-advanced')).toHaveAttribute('open', '');
  await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#discovery-sort')).toBeVisible();
  await expect(page.locator('#discovery-sort')).toHaveValue('explorationOrder');
  await expect(page.locator('#discovery-wetland')).toBeVisible();
  await expect(page.locator('#discovery-diagnostics')).toBeVisible();
  await expect(page.locator('#recommendation-list li.recommendation')).toHaveCount(5, 'the answer stays visible');
  // KEYBOARD: the disclosure is a real control - Enter toggles it - and a collapsed section leaves no tab stops behind it.
  await page.locator('#discovery-advanced-heading').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#discovery-advanced')).not.toHaveAttribute('open', '');
  await expect(page.locator('#discovery-results tbody tr').first()).not.toBeVisible();
  await page.keyboard.press('Tab');
  const afterTab = await page.evaluate(() => document.activeElement?.id ?? null);
  expect(TECHNICAL.map(selector => selector.slice(1)), `a collapsed disclosure leaves no tab stop (reached ${afterTab})`)
    .not.toContain(afterTab);

  // A WARNING STAYS IN THE ORDINARY FLOW, with the disclosures shut. Changing the radius leaves the results stale.
  await openChangeLocation(page);
  await openAdvancedSearch(page);
  await page.locator('#discovery-radius-input').fill('25');
  await page.locator('#discovery-radius-input').press('Enter');
  await expect(page.locator('#discovery')).toContainText('previous search');
  await page.locator('#discovery-advanced-search-heading').click();
  await page.locator('#discovery-change-heading').click();
  await expect(page.locator('#discovery-change')).not.toHaveAttribute('open', '');
  await expect(page.locator('#discovery')).toContainText('previous search');
  await expect(page.locator('#recommendation-rank-' + first)).toBeVisible();
  console.log('FIRST_LOOK_PHONE_WARNING visible with every disclosure shut');
});

// THE COLD-HUMAN WORKFLOW, IN ONE RUN: fresh storage, a phone, no internal concepts.
//
// This is the whole product story a stranger needs - identify where, ask for roads, read why, look at one on the map, change
// the place, ask again - and it never opens Advanced search. If this test needs Advanced search to pass, the product has
// stopped being usable by somebody who does not know what a corridor is.
test('a stranger can use the whole product on a phone without ever opening Advanced search', async ({ page }) => {
  test.setTimeout(1800000);
  await page.setViewportSize(PHONE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });

  // 1-3. A fresh visitor can find the location field and the button, and nothing else is in the way.
  await expect(page.locator('#discovery-place')).toBeVisible();
  await expect(page.locator('#discover-roads')).toBeVisible();
  await expect(page.locator('#discovery-advanced-search')).not.toHaveAttribute('open', '');

  // 4-6. A Princeton search, and the first recommendation becomes the dominant content.
  await findRoadsByPlace(page, 'Princeton');
  const first = await page.locator('#recommendation-list li.recommendation').first().getAttribute('data-candidate-id');
  await expect(page.locator(`#recommendation-rank-${first}`)).toHaveText('#1 Best overall');
  const rank = (await layout(page, [`#recommendation-rank-${first}`])).boxes[`#recommendation-rank-${first}`];
  expect(rank.top, 'the answer is the first thing on the screen').toBeLessThanOrEqual(PHONE.height);
  // The reasons are readable without opening anything, and the road can be shown on the map.
  await expect(page.locator(`#recommendation-reasons-${first} li`).first()).toBeVisible();
  // The map's own contract, the one its gates use: a corridor is `data-role="candidate"` and carries `data-selected`.
  const drawn = page.locator('#map [data-role="candidate"]');
  expect(await drawn.count(), 'the map is drawing the search').toBeGreaterThanOrEqual(1);
  await page.locator(`#recommendation-show-${first}`).click();
  await expect(page.locator('#discovery-selected')).toContainText('Selected discovery corridor');
  // ONE SELECTED ROAD, however many paths the map draws for it: the assertion counts distinct corridor ids, not paths.
  await expect.poll(async () => page.locator('#map [data-role="candidate"][data-selected="true"]')
    .evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.corridorId))].length)).toBe(1);

  // 7-10. Change location, search somewhere else, and get new recommendations - still without Advanced search.
  await page.locator('#discovery-change-location').click();
  await expect(page.locator('#discovery-advanced-search')).not.toHaveAttribute('open', '');
  await page.locator('#discovery-place').fill('Portland');
  await expect(page.locator('#discovery-place-results')).toBeVisible({ timeout: 60000 });
  await page.locator('#discovery-place-results .discovery-place-option').first().click();
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-compact-line')).toContainText('Portland', { timeout: 600000 });
  await expect(page.locator('#recommendation-list li.recommendation')).toHaveCount(5, { timeout: 600000 });
  await expect(page.locator('#recommendations-heading')).toContainText('Best road-naturalist drives within');
  const second = await page.locator('#recommendation-list li.recommendation').first().getAttribute('data-candidate-id');
  expect(second, 'the new search answers with its own roads').not.toBe(first);
  // 11. Advanced search was never needed: it is still collapsed, and no coordinate or radius control was ever on screen.
  await expect(page.locator('#discovery-advanced-search')).not.toHaveAttribute('open', '');
  await expectTechnicalControlsHidden(page);
  console.log(`FIRST_LOOK_COLD_HUMAN ${JSON.stringify({ princeton: first, portland: second })}`);
});

test('on a desktop the answer leads, the intro still reads as intentional, and the table waits until it is opened', async ({ page }) => {
  test.setTimeout(1800000);
  await freshPage(page, DESKTOP);
  // The intro is a real heading and a real sentence, not a stripped page.
  const fresh = await layout(page, ['.intro', '#page-title', '.intro-lead', '#discover-roads']);
  expect(fresh.boxes['#page-title'].h, 'the product still says what it is').toBeGreaterThan(24);
  expect(fresh.boxes['.intro-lead'].h, 'and what it does, in one sentence').toBeGreaterThan(10);
  expect(fresh.boxes['#discover-roads'].top, 'the primary action is on the first screen here too')
    .toBeLessThan(fresh.viewport);
  console.log(`FIRST_LOOK_DESKTOP_BEFORE ${JSON.stringify(fresh)}`);

  await findRoadsByPlace(page, 'Princeton');
  await expect(page.locator('#recommendation-list li.recommendation')).toHaveCount(5);
  await expect(page.locator('#recommendations-heading'))
    .toHaveText(`Best road-naturalist drives within ${DEFAULT_RADIUS_MILES} miles`);
  await expectTechnicalControlsHidden(page);
  const after = await layout(page, ['#discovery-search-compact', '#recommendations-heading',
    '#recommendation-list li.recommendation', '#discovery-advanced-heading', '#discovery-advanced']);
  expect(after.boxes['#recommendations-heading'].top, 'the answer is on the first screen').toBeLessThan(after.viewport);
  expect(after.boxes['#discovery-search-compact'], 'and the search form has collapsed').toBeTruthy();
  expect(after.boxes['#discovery-advanced-heading'].h, 'the workbench is one heading')
    .toBeLessThan(after.boxes['#recommendation-list li.recommendation'].h);
  console.log(`FIRST_LOOK_DESKTOP_AFTER ${JSON.stringify(after)}`);

  // THE RECOMMENDATIONS COME FIRST IN THE DOCUMENT, and the workbench after them - and opening it changes nothing about the
  // answer.
  const order = await page.evaluate(() => {
    const position = selector => [...document.querySelectorAll('#discovery *')].indexOf(document.querySelector(selector));
    return { recommendations: position('#discovery-recommendations'), advanced: position('#discovery-advanced'),
      results: position('#discovery-results') };
  });
  expect(order.recommendations).toBeGreaterThan(-1);
  expect(order.advanced).toBeGreaterThan(order.recommendations);
  expect(order.results).toBeGreaterThan(order.advanced);
  await page.locator('#discovery-advanced-heading').click();
  await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#recommendation-list li.recommendation')).toHaveCount(5);
  await expect(page.locator('#recommendations-heading')).toBeVisible();
  console.log(`FIRST_LOOK_DESKTOP_ORDER ${JSON.stringify(order)}`);
});

// SHOW ON MAP HAS TO SHOW THE MAP.
//
// On a phone the map sits about two screens below the answer, so a primary action that only changed a highlight nobody could
// see looked like nothing happened. This workflow proves the promise: the exact corridor is selected, the map is brought into
// view, the camera and the fit count are untouched, and there is a way back that changes nothing at all.
test('Show on map selects the road and brings the map into view, without touching the camera', async ({ page }) => {
  test.setTimeout(1800000);
  await freshPage(page, PHONE);
  await findRoadsByPlace(page, 'Princeton');
  // Data-plane reads, watched from here on: the search reads the derived plane as it must, and this assertion is about what
  // SHOW ON MAP does afterwards - which is nothing at all on the data plane.
  const reads = [];
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/derived/') || url.includes('/regional/partitions/') || url.includes('data.roadnaturalist.com')) reads.push(url);
  });
  const cards = page.locator('#recommendation-list li.recommendation');
  await expect(cards).toHaveCount(5);
  const first = await cards.first().getAttribute('data-candidate-id');
  const fifth = await cards.nth(4).getAttribute('data-candidate-id');
  await expect(page.locator(`#recommendation-rank-${first}`)).toHaveText('#1 Best overall');

  // BEFORE: the map is well below the answer, and the person can see the answer.
  const before = await layout(page, ['#map-panel', '#recommendation-list li.recommendation', '#discovery-recommendations']);
  const cameraBefore = await cameraOf(page);
  const fitsBefore = await fitCountOf(page);
  expect(before.boxes['#map-panel'].top, 'the map starts below the first screen').toBeGreaterThan(before.viewport);
  expect(before.boxes['#recommendation-list li.recommendation'].top).toBeLessThan(before.viewport);

  // TAP SHOW ON MAP: the exact corridor, and the map on screen.
  await page.locator(`#recommendation-show-${first}`).click();
  await expect(page.locator(`#recommendation-show-${first}`)).toBeVisible();
  await expect.poll(async () => (await layout(page, ['#map-panel'])).boxes['#map-panel'].top,
    { timeout: 15000, message: 'the map is brought into view' }).toBeLessThanOrEqual(0);
  const shown = await layout(page, ['#map-panel', '#map']);
  expect(shown.boxes['#map-panel'].top, 'the map region is at the top of the viewport').toBeLessThanOrEqual(4);
  expect(shown.boxes['#map-panel'].bottom, 'and substantially on screen').toBeGreaterThan(shown.viewport * 0.5);
  // THE EXACT CORRIDOR, through the one selection state the whole workspace shares.
  await expect.poll(async () => page.locator('#map [data-role="candidate"][data-selected="true"]')
    .evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.corridorId))])).toEqual([first]);
  // THE MAP SAYS WHICH ROAD ARRIVED WITH THE PERSON, and offers the way back.
  await expect(page.locator('#map-selection')).toBeVisible();
  await expect(page.locator('#map-selection-name')).not.toBeEmpty();
  await expect(page.locator('#map-panel')).toBeFocused();
  // AND THE CAMERA IS EXACTLY WHERE IT WAS: a page scroll is not a fit.
  expect(await cameraOf(page)).toEqual(cameraBefore);
  expect(await fitCountOf(page), 'no fit is asked for').toBe(fitsBefore);
  console.log(`SHOWMAP_PHONE ${JSON.stringify({ before: before.boxes['#map-panel'], after: shown.boxes['#map-panel'],
    camera: cameraBefore, fits: fitsBefore })}`);

  // BACK TO THE ANSWER: the same cards, the same selection, the same search - and no data read to get there.
  await page.locator('#map-back-to-recommendations').click();
  await expect.poll(async () => (await layout(page, ['#discovery-recommendations'])).boxes['#discovery-recommendations'].top,
    { timeout: 15000, message: 'the recommendations are back on screen' }).toBeLessThan(200);
  await expect(cards).toHaveCount(5);
  await expect(page.locator(`#recommendation-rank-${first}`)).toHaveText('#1 Best overall');
  await expect(page.locator(`#recommendation-open-${first}`)).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#recommendations-heading')).toContainText('Best road-naturalist drives within');

  // THE FIFTH CARD BEHAVES LIKE THE FIRST: same map region, its own corridor. The interaction does not depend on card order.
  await page.locator(`#recommendation-show-${fifth}`).click();
  await expect.poll(async () => (await layout(page, ['#map-panel'])).boxes['#map-panel'].top,
    { timeout: 15000, message: 'the fifth card brings the map into view too' }).toBeLessThanOrEqual(0);
  await expect.poll(async () => page.locator('#map [data-role="candidate"][data-selected="true"]')
    .evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.corridorId))])).toEqual([fifth]);
  expect(await cameraOf(page)).toEqual(cameraBefore);
  expect(await fitCountOf(page)).toBe(fitsBefore);
  expect(reads, 'showing a road on the map reads no data plane').toEqual([]);
  console.log(`SHOWMAP_PHONE_FIFTH ${JSON.stringify({ fifth })}`);
});

// THE RULE IS VISIBILITY, NOT WIDTH.
//
// A page that already shows the map must not jump when a card is tapped, and a page that does not must be taken to it. The
// layout decides which case a person is in, so the test sets up the visible case directly: the map on screen, then the card's
// action dispatched without the browser scrolling the button into view (which is exactly what a person whose viewport already
// shows the map would do - they tap a button they can see, and the page stays where it is).
test('Show on map does not move a page that already shows the map, and never moves the camera', async ({ page }) => {
  test.setTimeout(1800000);
  await freshPage(page, DESKTOP);
  await findRoadsByPlace(page, 'Princeton');
  const first = await page.locator('#recommendation-list li.recommendation').first().getAttribute('data-candidate-id');
  const cameraBefore = await cameraOf(page);
  const fitsBefore = await fitCountOf(page);
  // FIRST TAP: the exact corridor, and the map on screen - dispatched without the browser scrolling the button into view,
  // which is what a person whose viewport already shows the map would do.
  await page.evaluate(id => document.getElementById(id).click(), `recommendation-show-${first}`);
  await expect.poll(async () => page.locator('#map [data-role="candidate"][data-selected="true"]')
    .evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.corridorId))])).toEqual([first]);
  await expect.poll(async () => (await layout(page, ['#map-panel'])).boxes['#map-panel'].top,
    { timeout: 15000, message: 'the map is on screen after the tap' }).toBeLessThanOrEqual(4);

  // SECOND TAP, THE CASE THE RULE IS FOR: the road is already selected, so nothing about the layout changes - the page is
  // already showing the map, and it must not move at all.
  await page.locator('#map-panel').evaluate(node => node.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(500);
  const settled = await layout(page, ['#map-panel']);
  expect(settled.boxes['#map-panel'].top).toBeLessThan(settled.viewport);
  const scrollBefore = settled.scrollY;
  await page.evaluate(id => document.getElementById(id).click(), `recommendation-show-${first}`);
  await page.waitForTimeout(1200);
  const after = await layout(page, ['#map-panel']);
  expect(after.scrollY, 'a page that already shows the map does not jump').toBe(scrollBefore);
  expect(after.boxes['#map-panel'].top).toBeLessThan(after.viewport);
  expect(await cameraOf(page)).toEqual(cameraBefore);
  expect(await fitCountOf(page)).toBe(fitsBefore);
  console.log(`SHOWMAP_VISIBLE_NO_JUMP ${JSON.stringify({ scrollBefore, scrollAfter: after.scrollY, mapTop: after.boxes['#map-panel'].top })}`);
});
