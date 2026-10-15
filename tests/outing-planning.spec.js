import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openAdvancedSearch, openAllResults } from './discovery-ui.js';

import { OUTINGS_KEY } from '../src/state/outings.js';
import { cameraOf, movementCount } from './map-contract.js';

// AN OUTING, DRIVEN THE WAY A PERSON DRIVES IT.
//
//   RUN_OUTING_PLANNING=1 npx playwright test tests/outing-planning.spec.js
//
// Two real searches, three real corridors kept as saved roads, one plan assembled, reordered, read geographically, fitted
// once, noted, reloaded - and then a road from a second search added to the same plan, which is the whole point of an
// outing not belonging to a search. Distances are read as straight-line planning distances and are never asserted to be
// anything else, because Road Naturalist does not know how these roads connect.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
const RAW_PLANE = /\/(national\/roads|national\/wetlands|national\/hydro)\//;
const DATA_PLANE = /\/(national|regional)\//;

test.skip(!process.env.RUN_OUTING_PLANNING, 'set RUN_OUTING_PLANNING=1 to drive a full outing through a browser');

function region(id) {
  const path = process.env.RANKING_ORDER_ARTIFACT ?? '../data/ranking/exploration-order-v1-evaluation.json';
  const artifact = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  return artifact.regions.find(entry => entry.id === id);
}

test('a plan survives the session that made it, and grows across searches', async ({ page }) => {
  test.setTimeout(1800000);
  const princeton = region('princeton-in');
  const evansville = region('evansville-in');
  await page.setViewportSize({ width: 1440, height: 950 });
  const reads = [];
  const errors = [];
  const rawReads = [];
  const missing = [];
  page.on('response', response => { if (response.status() === 404) missing.push(response.url()); });
  page.on('request', request => {
    const url = request.url();
    if (RAW_PLANE.test(url)) rawReads.push(url);
    if (DATA_PLANE.test(url)) reads.push(url);
  });
  page.on('pageerror', error => errors.push(error.message));
  // The browser's own line for a failed request names no URL, so it is not repeated here: `missing` carries the URLs.
  page.on('console', message => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });

  const rows = () => page.locator('#discovery-results tbody tr');
  const topIds = () => rows().evaluateAll(list => list.slice(0, 3).map(row => row.dataset.candidateId));
  const planIds = () => page.locator('[data-role="outing"]').evaluateAll(paths =>
    [...new Set(paths.map(path => path.getAttribute('data-corridor-id')))]);
  const listed = () => page.locator('#outing-roads li.outing-road').evaluateAll(items =>
    items.map(item => item.dataset.roadId));
  // A CLICK ON THE ROAD ITSELF, not on the bounding box of a bent line: the point is taken from the path's own geometry,
  // in the middle of its length, and converted to viewport coordinates. That is exactly what a person does with a mouse.
  const camera = async () => JSON.stringify(await cameraOf(page));
  // A CAMERA CHANGE IS WAITED FOR, NOT ASSUMED. A fit animates, so a read taken the instant the control is pressed can
  // still describe the previous view; `movementCount` is the map's own count of settled moves, exactly as the map
  // interaction gate uses it.
  async function settled(action) {
    const before = await movementCount(page);
    await action();
    await expect.poll(() => movementCount(page), { timeout: 30000 }).toBeGreaterThan(before);
    return camera();
  }
  // EVERY ROAD IN THE PLAN IS INSIDE THE MAP, measured on the drawn paths themselves.
  async function planIsFramed() {
    return page.evaluate(() => {
      const rect = document.querySelector('#map').getBoundingClientRect();
      const paths = [...document.querySelectorAll('#map path[data-role="outing"][data-corridor-id]')
        .values()].filter(element => getComputedStyle(element).pointerEvents !== 'none');
      if (!paths.length) return { framed: false, reason: 'no plan roads are drawn' };
      const outside = [];
      for (const element of paths) {
        const box = element.getBoundingClientRect();
        if (box.left < rect.left - 2 || box.right > rect.right + 2 || box.top < rect.top - 2 || box.bottom > rect.bottom + 2) {
          outside.push(element.dataset.corridorId);
        }
      }
      return { framed: outside.length === 0, outside, rect: { w: Math.round(rect.width), h: Math.round(rect.height) } };
    });
  }
  // A CLICK ON THE ROAD ITSELF, at a point where the road really is the topmost element. The point is taken from the
  // path's own geometry (not its bounding box, which for a bent line is off the line) and then checked against
  // `elementFromPoint`, so a click that an overlay or another pane would intercept is found before it is made rather
  // than asserted afterwards.
  async function clickOnRoad(candidateId) {
    // The map has to be on screen for a real mouse click: the point is a viewport coordinate, and the plan's own list is
    // further down the page.
    await page.locator('#map').scrollIntoViewIfNeeded();
    const point = await page.evaluate(id => {
      const paths = [...document.querySelectorAll(`#map path[data-role="outing"][data-corridor-id="${id}"]`)];
      for (const element of paths) {
        const length = element.getTotalLength?.() ?? 0;
        if (!length) continue;
        for (const fraction of [0.5, 0.25, 0.75, 0.4, 0.6]) {
          const along = element.getPointAtLength(length * fraction);
          const screen = new DOMPoint(along.x, along.y).matrixTransform(element.getScreenCTM());
          const top = document.elementFromPoint(screen.x, screen.y);
          if (top === element || top?.dataset?.corridorId === id) return { x: screen.x, y: screen.y };
        }
      }
      return null;
    }, candidateId);
    expect(point, `${candidateId}: a point on the road where the road itself is on top`).not.toBe(null);
    await page.mouse.click(point.x, point.y);
  }
  // SELECTION IS NOT A CAMERA ACTION. A corridor's card may nudge the map so it can be seen - Leaflet's own popup
  // auto-pan, which applies to every corridor on this map and is not a fit - so the camera must keep its zoom and stay
  // within a hair of where it was. A fit changes the zoom, which is what this catches.
  const cameraMoved = (before, after) => {
    const from = JSON.parse(before);
    const to = JSON.parse(after);
    return to.zoom !== from.zoom || Math.abs(to.center[0] - from.center[0]) > 0.02
      || Math.abs(to.center[1] - from.center[1]) > 0.02;
  };
  const detail = async () => (await page.locator('#candidate-detail').innerText()).slice(0, 400);
  const nameOf = async id => (await page.locator(`#outing-roads li.outing-road[data-road-id="${id}"] button.outing-road-name`)
    .innerText()).trim();
  const spanMiles = async () => Number((/(\d+\.\d+) mi/.exec(await page.locator('#outing-span').innerText()) ?? [0, 0])[1]);
  async function search(place) {
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });
    await openAdvancedSearch(page);
    await page.locator('#discovery-center-lat').fill(place.center[1].toFixed(4));
    await page.locator('#discovery-center-lon').fill(place.center[0].toFixed(4));
    await page.locator('#discovery-center-apply').click();
    await page.locator('#discovery-radius-input').fill(String(place.radiusMiles));
    await page.locator('#discovery-radius-input').press('Enter');
    await page.locator('#discover-roads').click();
    // THE ROWS ARE BEHIND "Explore all results": the gate opens the workbench after each search, like a person would.
    await openAllResults(page);
    await expect(rows().first()).toBeVisible({ timeout: 600000 });
  }
  // ADDING A DISCOVERED ROAD KEEPS IT FIRST: an outing references saved roads, so the control goes through the same
  // promotion the Promote button uses, then adds the road to the plan the person chose.
  async function addToOuting(candidateId, { create = false } = {}) {
    await page.locator(`#discovery-results tbody tr[data-candidate-id="${candidateId}"] button.discovery-row`).click();
    const select = page.locator('#discovery-add-outing');
    await expect(select).toBeVisible();
    if (create) await select.selectOption('__new__');
    await page.locator('#discovery-add-to-outing').click();
    await expect(page.locator(`#outing-roads li.outing-road[data-road-id="${candidateId}"]`))
      .toBeVisible({ timeout: 120000 });
  }

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await search(princeton);
  const [first, second, third] = await topIds();
  expect([first, second, third].every(Boolean), 'a search proposes at least three roads').toBe(true);
  // A FRESH DEVICE HAS NO PLAN AT ALL: a default is not stored as a choice.
  expect(await page.evaluate(key => globalThis.localStorage.getItem(key), OUTINGS_KEY)).toBe(null);

  // 1-4. THE TOP EXPLORATION-ORDER ROAD, THEN TWO MORE, ALL INTO A NEW OUTING.
  await addToOuting(first, { create: true });
  await addToOuting(second);
  await addToOuting(third);
  expect(await listed()).toEqual([first, second, third]);

  // 5-6. THE PLAN IS OPEN, AND EVERY ROAD IN IT IS ON THE MAP AS A PLAN MEMBER. Adding a road promotes it, and a
  // promotion clears the discovery selection - so from here the plan, not the search, is what the map is showing.
  await expect(page.locator('#outing-detail')).toBeVisible();
  expect(await planIds()).toEqual([first, second, third]);
  expect(await page.locator(`[data-role="candidate"][data-corridor-id="${first}"]`).count(),
    'a plan member is not also drawn as an ordinary candidate').toBe(0);

  // 7. REORDER BY HAND: the map follows, the camera does not.
  const beforeMove = await camera();
  await page.locator(`#outing-roads li.outing-road[data-road-id="${third}"] button[data-move-road][data-direction="up"]`).click();
  expect(await listed()).toEqual([first, third, second]);
  expect(await camera(), 'reordering a plan never moves the camera').toBe(beforeMove);

  // 8. FIT OUTING IS EXPLICIT, AND IT IS THE ONLY THING IN THIS WORKFLOW THAT MOVES THE CAMERA. The person makes a move
  // of their own first (Fit selected, on one road), so what the plan's own control does is unmistakable - and what it
  // must do is frame the whole plan.
  await page.locator(`#outing-roads li.outing-road[data-road-id="${second}"] button.outing-road-name`).click();
  const zoomedToOneRoad = await settled(() => page.locator('#fit-selected').click());
  expect(zoomedToOneRoad, 'the person’s own fit moved the camera').not.toBe(beforeMove);
  await settled(() => page.locator('#outing-fit').click());
  const framing = await planIsFramed();
  expect(framing.framed, `Fit outing frames every road in the plan (outside: ${JSON.stringify(framing.outside)})`).toBe(true);
  expect(await camera(), 'and the plan’s own fit is a different view from the one road').not.toBe(zoomedToOneRoad);

  // 9-10. ONE SELECTION STATE, FROM THE LIST OR FROM THE MAP, AND NEITHER MOVES THE CAMERA.
  const firstName = await nameOf(first);
  const secondName = await nameOf(second);
  await page.locator(`#outing-roads li.outing-road[data-road-id="${first}"] button.outing-road-name`).click();
  await expect.poll(detail, { timeout: 30000 }).toContain(firstName);
  const cameraBeforeSelection = await camera();
  await clickOnRoad(second);
  await expect.poll(detail, { timeout: 30000 }).toContain(secondName);
  expect(cameraMoved(cameraBeforeSelection, await camera()), 'selecting a plan road does not fit the map').toBe(false);

  // 11. A NOTE ON THE PLAN.
  await page.locator('#outing-notes').fill('Start at the Princeton square before light.');
  await page.locator('#outing-notes').blur();

  // THE DISTANCES SAY WHAT THEY ARE, AND THE SUMMARY CLAIMS ONLY MEASURED FACTS AND NO COMBINED SCORE.
  await expect(page.locator('.outing-separation-line').first())
    .toContainText(/straight-line planning distance|not available here/);
  await expect(page.locator('.outing-distance-label')).toContainText('not a driving distance');
  await expect(page.locator('#outing-span')).toContainText('Approximate geographic span');
  await expect(page.locator('#outing-wetland')).toContainText('mapped wetland');
  // NO COMPOSITE SCORE IS PRESENTED, and the summary says so itself: every line is a measurement the roads already
  // made, and there is no element anywhere in the plan that scores the outing as a whole.
  await expect(page.locator('.outing-summary-note')).toContainText('no combined outing score');
  expect(await page.locator('#outing-summary [id*="score"]').count(),
    'a plan has no score of its own').toBe(0);
  expect(await page.locator('#outing-detail .outing-summary-facts li').count()).toBeGreaterThan(3);

  // NOTHING ABOUT MANAGING A PLAN READS A DATASET: order, fit, selection and notes are device state. Everything the
  // searches and the three promotions needed has already been read, so the counters are reset here and must stay empty.
  reads.length = 0;
  rawReads.length = 0;
  expect(rawReads, `no raw plane may be read while managing a plan: ${rawReads.join(', ')}`).toEqual([]);
  expect(reads, `no data plane may be read while managing a plan: ${reads.join(', ')}`).toEqual([]);
  const spanOfOneSearch = await spanMiles();

  // 12-13. A RELOAD KEEPS THE PLAN, ITS ORDER AND ITS NOTE.
  const stored = await page.evaluate(key => JSON.parse(globalThis.localStorage.getItem(key)), OUTINGS_KEY);
  expect(stored.kind).toBe('roadnaturalist-outings');
  expect(stored.outings.length).toBe(1);
  expect(stored.outings[0].roadIds).toEqual([first, third, second]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#outing-list .outing-card')).toHaveCount(1, { timeout: 180000 });
  await page.locator('#outing-list button[data-open-outing]').first().click();
  expect(await listed(), 'the order is the one the person chose').toEqual([first, third, second]);
  await expect(page.locator('#outing-notes')).toHaveValue('Start at the Princeton square before light.');
  await expect(page.locator('#outing-summary')).toBeVisible();

  // 14-15. A SECOND SEARCH, AND A ROAD FROM IT JOINS THE SAME PLAN: an outing belongs to the person, not to a search.
  await search(evansville);
  const [visitor] = await topIds();
  const evansvilleCamera = await camera();
  await addToOuting(visitor);
  expect(await listed()).toEqual([first, third, second, visitor]);
  expect(await planIds()).toEqual([first, third, second, visitor]);
  expect(await camera(), 'adding a road from another search never moves the camera').toBe(evansvilleCamera);
  // The plan now reaches into a second search: its span grew, and its own roads say which search each was found from.
  expect(await spanMiles()).toBeGreaterThan(spanOfOneSearch + 5);
  const roadFacts = await page.locator('#outing-roads li.outing-road .outing-road-facts').allInnerTexts();
  expect(roadFacts.some(text => /Evansville/.test(text)), 'the road from the second search says where it was found').toBe(true);
  expect(roadFacts.some(text => /Princeton/.test(text)), 'and the first search’s roads still say where they were found').toBe(true);
  await settled(() => page.locator('#outing-fit').click());
  const acrossSearches = await planIsFramed();
  expect(acrossSearches.framed,
    `Fit outing frames the plan across both searches (outside: ${JSON.stringify(acrossSearches.outside)})`).toBe(true);
  expect(await camera()).not.toBe(evansvilleCamera);

  // 17. THE PLANNING SANITY METRICS, RECORDED FROM WHAT IS ACTUALLY ON SCREEN.
  const reorderStarted = Date.now();
  await page.locator(`#outing-roads li.outing-road[data-road-id="${second}"] button[data-move-road][data-direction="up"]`).click();
  await expect.poll(listed, { timeout: 10000 }).toEqual([first, second, third, visitor]);
  const reorderMs = Date.now() - reorderStarted;
  const report = {
    roads: await page.locator('#outing-roads li.outing-road').count(),
    mappedRoads: (await planIds()).length,
    coordinates: await page.locator('#outing-coordinates').innerText(),
    span: await page.locator('#outing-span').innerText(),
    interest: await page.locator('#outing-interest').innerText(),
    separations: await page.locator('.outing-separation-line').allInnerTexts(),
    spanOfOneSearch,
    reorderMs,
  };
  console.log(`OUTING_PLANNING ${JSON.stringify(report)}`);
  expect(report.roads).toBe(4);
  expect(report.mappedRoads).toBe(4);
  expect(report.reorderMs, 'reordering a plan is a bounded interface update').toBeLessThan(10000);
  // THE ONLY THING THAT MAY BE MISSING IS A RAW PLANE'S OWN INDEX. The raw planes are served from R2 and a local origin
  // does not publish them; the search runs on the derived plane regardless, and the raw planes have their own gates.
  // Nothing the application itself ships - no module, stylesheet, icon or catalog - may be missing.
  const unexpected = missing.filter(url => !/\/data\/raw\//.test(url));
  expect(unexpected, `nothing the application ships may be missing: ${unexpected.join(', ')}`).toEqual([]);
  expect(errors).toEqual([]);
});
