import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

import { EXPLORATION_ORDER_VERSION } from '../src/discovery/exploration-order.js';
import { RANKING_VERSION } from '../src/discovery/ranking.js';
import { cameraOf, fitCountOf } from './map-contract.js';

// RECOMMENDATIONS FIRST, THE WORKBENCH SECOND - IN A REAL BROWSER.
//
//   RUN_RECOMMENDATIONS=1 npx playwright test tests/recommendation-first.spec.js
//
// The gate drives the deployed application the way a new user would: type a centre, choose a radius, press Discover, and
// read the five cards that come back. It checks the three claims this surface makes:
//
//   * the top five ARE the top five of the committed exploration-order evaluation, over the same centre and radius;
//   * every sentence on a card is backed by a measurement the run made - checked by comparing each card's own data
//     attributes with the words it shows, in a wet region and a dry one;
//   * the cards reuse the one selection state, move no camera, and leave every advanced control where it was.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 950 };
// The regions the published evaluation measured. `southwest-dry` is the Phoenix case: a dry-region search whose roads
// still carry mapped water, which is exactly why the gate checks the copy against the numbers instead of assuming words.
const REGIONS = ['princeton-in', 'portland-or', 'southwest-dry'];
// Words no card may ever contain: none of them is measured by anything in this application.
const FABRICATION = /wildlife|birding|bird-watch|deer|guaranteed|scenic|abundance|habitat quality|best chance/i;

test.skip(!process.env.RUN_RECOMMENDATIONS, 'set RUN_RECOMMENDATIONS=1 to drive the recommendation-first surface');

function orderArtifact() {
  const path = process.env.RANKING_ORDER_ARTIFACT ?? '../data/ranking/exploration-order-v1-evaluation.json';
  const evaluation = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  expect(evaluation.orderVersion).toBe(EXPLORATION_ORDER_VERSION);
  expect(evaluation.interestVersion).toBe(RANKING_VERSION);
  return evaluation;
}

async function searchRegion(page, region) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });
  const [lon, lat] = region.center;
  await page.locator('#discovery-center-lat').fill(lat.toFixed(4));
  await page.locator('#discovery-center-lon').fill(lon.toFixed(4));
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-radius-input').fill(String(region.radiusMiles));
  await page.locator('#discovery-radius-input').press('Enter');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#recommendation-list li.recommendation').first()).toBeVisible({ timeout: 600000 });
}

// ONE CARD, READ AS THE PAGE DRAWS IT. The measurements travel as data attributes on the card, so a sentence can be
// checked against the number behind it without reaching into the application's state.
const readCards = page => page.locator('#recommendation-list li.recommendation').evaluateAll(nodes => nodes.map(node => ({
  id: node.dataset.candidateId,
  rank: Number(node.dataset.rank),
  best: node.dataset.best === 'true',
  label: node.dataset.label,
  score: node.dataset.score === '' ? null : Number(node.dataset.score),
  wetland: node.dataset.wetland === '' ? null : Number(node.dataset.wetland),
  water: node.dataset.water === '' ? null : Number(node.dataset.water),
  variety: node.dataset.variety === '' ? null : Number(node.dataset.variety),
  distanceM: node.dataset.distanceM === '' ? null : Number(node.dataset.distanceM),
  rankText: node.querySelector('.recommendation-rank')?.textContent ?? '',
  name: node.querySelector('.recommendation-name')?.textContent ?? '',
  reasons: [...node.querySelectorAll('.recommendation-reasons li')].map(item =>
    ({ key: item.dataset.reason, text: item.textContent })),
  facts: node.querySelector('.recommendation-facts')?.textContent ?? '',
  note: node.querySelector('.recommendation-note')?.textContent ?? null,
  caution: node.querySelector('.recommendation-caution')?.textContent ?? null,
  text: node.innerText,
})));

// THE COPY MUST MATCH THE NUMBERS, CARD BY CARD. This is the whole honesty claim of the surface, so it is checked as an
// invariant rather than as a snapshot: a reason exists only for a component that was measured, and a label that names a
// signal is only used when that signal is in the band the label describes.
function expectCopyMatchesEvidence(cards, regionId) {
  for (const card of cards) {
    expect(card.label, `${regionId}: every card has a verdict`).toBeTruthy();
    expect(card.rankText).toContain(`#${card.rank}`);
    for (const reason of card.reasons) {
      const measured = { wetland: card.wetland, water: card.water, ecologicalVariety: card.variety }[reason.key];
      expect(measured, `${regionId}: "${reason.text}" exists only for a measured component`).not.toBeNull();
      expect(reason.text.length).toBeGreaterThan(10);
    }
    if (card.reasons.length) expect(card.reasons.length).toBeLessThanOrEqual(3);
    if (/wetland and water corridor/i.test(card.label)) {
      expect(card.wetland, `${regionId}: ${card.label} needs strong wetland`).toBeGreaterThanOrEqual(60);
      expect(card.water, `${regionId}: ${card.label} needs strong water`).toBeGreaterThanOrEqual(60);
    } else if (/wetland-rich/i.test(card.label)) {
      expect(card.wetland, `${regionId}: ${card.label} needs strong wetland`).toBeGreaterThanOrEqual(60);
    } else if (/^water and crossings/i.test(card.label)) {
      expect(card.water, `${regionId}: ${card.label} needs strong water`).toBeGreaterThanOrEqual(60);
    } else if (/habitat transition/i.test(card.label)) {
      expect(card.variety, `${regionId}: ${card.label} needs strong ecological variety`).toBeGreaterThanOrEqual(60);
    } else if (/not measured/i.test(card.label)) {
      expect(card.wetland == null && card.water == null && card.variety == null,
        `${regionId}: "not measured" is only said when nothing was measured`).toBe(true);
    }
    // AND NOTHING IS EVER CLAIMED THAT NOTHING MEASURED.
    expect(FABRICATION.test(card.text), `${regionId}: a card claims something unmeasured`).toBe(false);
  }
}

for (const id of REGIONS) {
  test(`recommendations are the top five of the evaluated order: ${id}`, async ({ page }) => {
    test.setTimeout(1800000);
    await page.setViewportSize(DESKTOP);
    const evaluation = orderArtifact();
    const region = evaluation.regions.find(entry => entry.id === id);
    const expected = region.selected.order.map(entry => entry.corridorId);
    await searchRegion(page, region);

    // EXACTLY FIVE CARDS, IN THE COMMITTED ORDER, WITH THE FIRST MARKED BEST OVERALL.
    const cards = await readCards(page);
    expect(cards.length).toBe(5);
    expect(cards.map(card => card.id)).toEqual(expected.slice(0, 5));
    expect(cards.map(card => card.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(cards[0].best).toBe(true);
    expect(cards[0].rankText).toBe('#1 Best overall');
    expect(cards.slice(1).every(card => card.best === false)).toBe(true);
    expect(cards[0].name.length).toBeGreaterThan(0);
    // EVERY CARD EXPLAINS ITSELF, AND THE EXPLANATION MATCHES THE MEASUREMENTS.
    expect(cards.every(card => card.reasons.length >= 1)).toBe(true);
    expectCopyMatchesEvidence(cards, id);
    // The distance is stated for a centred search, and the corridor length with it.
    expect(cards[0].facts).toMatch(/mi from the search center/);
    expect(cards[0].facts).toMatch(/mi of road/);
    // THE HEADING SPEAKS TO A PERSON, AND THE MACHINERY IS NOT ON A CARD.
    await expect(page.locator('#recommendations-heading')).toHaveText('Best road-naturalist drives near this search');
    await expect(page.locator('#discovery-recommendations .eyebrow')).toHaveText('Recommended');
    for (const card of cards) {
      expect(/exploration order|naturalist interest|\bscore\b/i.test(card.text), `no machinery on a card: ${card.text}`).toBe(false);
    }
    console.log(`RECOMMENDATIONS_TOP ${id} ${JSON.stringify(cards.map(card => ({ rank: card.rank, id: card.id,
      label: card.label, reasons: card.reasons.map(reason => reason.text) })))}`);
  });
}

test('the recommendation order is not the interest-only order, and the cards differ where the data differs', async ({ page }) => {
  test.setTimeout(1800000);
  await page.setViewportSize(DESKTOP);
  const evaluation = orderArtifact();
  // PORTLAND, the region where the bounded distance preference changes which road leads.
  const region = evaluation.regions.find(entry => entry.id === 'portland-or');
  const interestOnly = region.interestTop.map(entry => entry.corridorId);
  const order = region.selected.order.map(entry => entry.corridorId);
  expect(order.slice(0, 5)).not.toEqual(interestOnly.slice(0, 5),
    'the committed evaluation itself must differ, or this test proves nothing');
  await searchRegion(page, region);
  const cards = await readCards(page);
  expect(cards.map(card => card.id)).toEqual(order.slice(0, 5));
  expect(cards.map(card => card.id)).not.toEqual(interestOnly.slice(0, 5));
  expectCopyMatchesEvidence(cards, 'portland-or');
  // EXPLANATIONS DIFFER WHERE THE DATA DIFFERS: five cards, and not five copies of one sentence.
  const reasonTexts = cards.map(card => card.reasons.map(reason => reason.text).join(' | '));
  expect(new Set(reasonTexts).size, 'at least three of the five cards explain themselves differently')
    .toBeGreaterThanOrEqual(3);
  console.log(`RECOMMENDATIONS_PORTLAND ${JSON.stringify({ order: cards.map(card => card.id),
    interestTop: interestOnly.slice(0, 5) })}`);
});

test('a card selects the corridor the table and the map already select, and moves no camera', async ({ page }) => {
  test.setTimeout(1800000);
  await page.setViewportSize(DESKTOP);
  const region = orderArtifact().regions.find(entry => entry.id === 'princeton-in');
  await searchRegion(page, region);
  const cards = await readCards(page);
  const third = cards[2];
  const cameraBefore = JSON.stringify(await cameraOf(page));
  const fitsBefore = await fitCountOf(page);

  // SELECTING THE THIRD CARD SELECTS THE THIRD CORRIDOR - the same selection the table row and a map click make.
  // The map draws the selected corridor in its own emphasis layer as well as in the results layer, so the claim is about
  // which corridor is emphasised - exactly one - not about how many paths its geometry needs.
  const emphasised = () => page.locator('#map path[data-role="candidate"][data-selected="true"]')
    .evaluateAll(paths => [...new Set(paths.map(path => path.getAttribute('data-corridor-id')))]);
  await page.locator(`#recommendation-open-${third.id}`).click();
  await expect(page.locator('#discovery-selected h3')).toContainText(third.name, { timeout: 60000 });
  const selectedRow = page.locator(`#discovery-results tbody tr[data-candidate-id="${third.id}"]`);
  await expect(selectedRow).toHaveClass(/selected/, { timeout: 60000 });
  await expect.poll(async () => (await emphasised()).join(','), { timeout: 60000 }).toBe(third.id);
  // NO CAMERA MOVE, AND NO FIT: the person asked to see it, not to be taken to it.
  expect(JSON.stringify(await cameraOf(page)), 'selecting a recommendation never moves the camera').toBe(cameraBefore);
  expect(await fitCountOf(page), 'and is never a fit').toBe(fitsBefore);
  // SHOW ON MAP IS THE SAME SELECTION, and it says so by selecting the same corridor.
  const second = cards[3];
  await page.locator(`#recommendation-show-${second.id}`).click();
  await expect.poll(async () => (await emphasised()).join(','), { timeout: 60000 }).toBe(second.id);
  expect(JSON.stringify(await cameraOf(page)), 'and it moves nothing either').toBe(cameraBefore);
  // SAVE IS THE ORDINARY PROMOTION: the road becomes a saved road, and the card says so instead of offering it twice.
  await page.locator(`#recommendation-save-${second.id}`).click();
  await expect(page.locator(`#recommendation-save-${second.id}`)).toHaveText('Saved', { timeout: 120000 });
  await expect(page.locator(`#saved-roads [data-candidate-id="${second.id}"]`)).toBeVisible({ timeout: 120000 });
  // THE ADVANCED WORKBENCH IS STILL THERE, UNDER ITS OWN HEADING, WITH ITS SORT CONTROL WORKING.
  await expect(page.locator('#discovery-advanced-heading')).toHaveText('Explore all results');
  await expect(page.locator('#discovery-sort')).toHaveValue('explorationOrder');
  await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible();
  const beforeSort = await page.locator('#discovery-results tbody tr').first().getAttribute('data-candidate-id');
  await page.locator('#discovery-sort').selectOption('name');
  await expect(page.locator('#recommendations-sort-note'), 'the two orders disagree out loud').toBeVisible();
  const afterSort = await page.locator('#discovery-results tbody tr').first().getAttribute('data-candidate-id');
  expect(afterSort).not.toBe(beforeSort);
  const stillCards = await readCards(page);
  expect(stillCards.map(card => card.id), 'and the recommendations keep the recommendation order').toEqual(cards.map(card => card.id));
  await page.locator('#discovery-sort').selectOption('explorationOrder');
  await expect(page.locator('#recommendations-sort-note')).toHaveCount(0);
});

test('the cards work on a phone, with no overflow and tappable actions', async ({ page }) => {
  test.setTimeout(1800000);
  await page.setViewportSize(PHONE);
  const region = orderArtifact().regions.find(entry => entry.id === 'princeton-in');
  await searchRegion(page, region);
  // THE CARDS ARE THE FIRST THING AFTER THE COVERAGE BANNER, ABOVE THE TABLE, and one column wide.
  const order = await page.evaluate(() => {
    const recommendations = document.getElementById('discovery-recommendations');
    const advanced = document.getElementById('discovery-advanced');
    const table = document.getElementById('discovery-results');
    const position = node => [...document.querySelectorAll('#discovery *')].indexOf(node);
    return { recommendations: position(recommendations), advanced: position(advanced), table: position(table),
      overflow: document.documentElement.scrollWidth - window.innerWidth };
  });
  expect(order.recommendations).toBeGreaterThan(-1);
  expect(order.recommendations).toBeLessThan(order.advanced);
  expect(order.advanced).toBeLessThan(order.table);
  expect(order.overflow, 'no horizontal overflow at 390 px').toBeLessThanOrEqual(0);
  const cards = await readCards(page);
  expect(cards.length).toBe(5);
  expectCopyMatchesEvidence(cards, 'princeton-in (mobile)');
  // EVERY CARD FITS, AND ITS ACTIONS ARE TAPPABLE AT A THUMB'S SIZE.
  for (const card of cards) {
    const box = await page.locator(`#recommendation-${card.id}`).boundingBox();
    expect(box.width).toBeLessThanOrEqual(PHONE.width);
    for (const id of [`#recommendation-open-${card.id}`, `#recommendation-show-${card.id}`, `#recommendation-save-${card.id}`]) {
      const control = await page.locator(id).boundingBox();
      expect(control, `${id} is laid out`).toBeTruthy();
      expect(control.height, `${id} is at least a thumb tall`).toBeGreaterThanOrEqual(24);
    }
  }
  // AND SELECTING FROM A CARD STILL WORKS ON A PHONE.
  await page.locator(`#recommendation-open-${cards[2].id}`).click();
  await expect(page.locator('#discovery-selected h3')).toContainText(cards[2].name, { timeout: 60000 });
  await expect(page.locator('#discovery-advanced-heading')).toBeVisible();
  console.log(`RECOMMENDATIONS_MOBILE ${JSON.stringify({ cards: cards.length, overflow: order.overflow, viewport: PHONE })}`);
});

test('a declared area search has no centre, so no distance is invented and the heading says where it is', async ({ page }) => {
  test.setTimeout(1800000);
  await page.setViewportSize(DESKTOP);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });
  // A DECLARED AREA, NOT A CENTRE AND RADIUS: the search itself defines no distance from anywhere.
  await page.locator('#discovery-area').selectOption('or-pilot-window');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#recommendation-list li.recommendation').first()).toBeVisible({ timeout: 600000 });
  const cards = await readCards(page);
  expect(cards.length).toBeGreaterThan(0);
  await expect(page.locator('#recommendations-heading')).toHaveText('Top roads in this search area');
  for (const card of cards) {
    expect(card.distanceM, 'no distance is measured from a centre that does not exist').toBeNull();
    expect(card.facts, 'so no distance is shown').not.toMatch(/from the search center/);
    expect(card.facts).toMatch(/mi of road/);
  }
  expectCopyMatchesEvidence(cards, 'or-pilot-window');
  console.log(`RECOMMENDATIONS_AREA ${JSON.stringify({ cards: cards.length, facts: cards[0].facts })}`);
});
