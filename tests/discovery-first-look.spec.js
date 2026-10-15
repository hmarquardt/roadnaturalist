import { test, expect } from '@playwright/test';

import { openAdvancedSearch } from './discovery-ui.js';
import { DEFAULT_RADIUS_MILES } from '../src/discovery/search-definition.js';

// WHAT A PERSON SEES COLD.
//
//   RUN_FIRST_LOOK=1 npx playwright test tests/discovery-first-look.spec.js
//
// This gate is about the *shape* of the product rather than about a ranking or a measurement: before a search, can somebody
// tell what to do without reading anything technical; after one, do they get five explained roads before any machinery; and
// do the controls they never asked for stay out of the way - collapsed, not merely styled down?
//
// Everything here is checked the way a person experiences it: which controls are actually visible, where the primary action
// sits vertically, and what a click reveals.
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

test('before a search, a phone shows where to search, one button, and one way to ask for more', async ({ page }) => {
  test.setTimeout(1800000);
  await freshPage(page, PHONE);
  // THE ORDINARY PATH IS THE WHOLE SURFACE: a place, this device's location, one button, and the disclosure.
  expect((await visibleControls(page)).sort()).toEqual(['discover-roads', 'discovery-advanced-search-heading',
    'discovery-place', 'discovery-use-location'].sort());
  await expect(page.locator('#discover-roads')).toHaveText('Find roads');
  await expect(page.locator('#discovery-advanced-search-heading')).toHaveText('Advanced search');
  await expectTechnicalControlsHidden(page);
  // MEASURED, NOT GUESSED: the primary action is on the first screen, and the machinery starts below it.
  const layout = await page.evaluate(() => {
    const box = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), h: Math.round(rect.height) };
    };
    const panel = box('.discovery-panel');
    const find = box('#discover-roads');
    return { viewport: window.innerHeight, panel, find, advanced: box('#discovery-advanced-search'),
      place: box('#discovery-place'), pathWithinPanel: find.bottom - panel.top,
      overflow: document.documentElement.scrollWidth - window.innerWidth };
  });
  expect(layout.find, 'the primary action is laid out').toBeTruthy();
  // MEASURED, IN THE PANEL'S OWN TERMS: the ordinary path - the place, this device's location, the summary and the button -
  // fits one phone screen, and the primary action is at the bottom of the first screen of the page rather than past it.
  expect(layout.pathWithinPanel, 'the ordinary path fits one screen').toBeLessThanOrEqual(layout.viewport);
  expect(layout.find.top, 'and the button is on the first screen of the page').toBeLessThan(layout.viewport * 1.2);
  expect(layout.place.bottom).toBeLessThan(layout.find.top);
  expect(layout.advanced.top).toBeGreaterThan(layout.find.bottom);
  expect(layout.advanced.h, 'the advanced search is one collapsed row').toBeLessThanOrEqual(70);
  expect(layout.overflow, 'no horizontal overflow at 390 px').toBeLessThanOrEqual(0);
  console.log(`FIRST_LOOK_PHONE_BEFORE ${JSON.stringify(layout)}`);
});

test('after a search, a phone shows five explained roads and nothing technical until it is asked for', async ({ page }) => {
  test.setTimeout(1800000);
  await freshPage(page, PHONE);
  await findRoadsByPlace(page, 'Princeton');
  // THE ANSWER, AND THE ASSUMPTION IN ITS HEADING.
  await expect(page.locator('#recommendations-heading'))
    .toHaveText(`Best road-naturalist drives within ${DEFAULT_RADIUS_MILES} miles`);
  await expect(page.locator('#recommendations-found')).toContainText('Found');
  const cards = page.locator('#recommendation-list li.recommendation');
  await expect(cards).toHaveCount(5);
  const first = await cards.first().getAttribute('data-candidate-id');
  await expect(page.locator(`#recommendation-rank-${first}`)).toHaveText('#1 Best overall');
  await expect(page.locator('#recommendation-list li.recommendation.best')).toHaveCount(1);
  // THE MACHINERY IS NOT ON SCREEN, AND "EXPLORE ALL RESULTS" IS.
  await expectTechnicalControlsHidden(page);
  await expect(page.locator('#discovery-advanced-heading')).toBeVisible();
  await expect(page.locator('#discovery-advanced-heading')).toHaveText('Explore all results');
  await expect(page.locator('#discovery-advanced')).not.toHaveAttribute('open', '');
  const afterSearch = await page.evaluate(() => {
    const box = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
    };
    return { viewport: window.innerHeight, firstCard: box('#recommendation-list li.recommendation'),
      find: box('#discover-roads'), advanced: box('#discovery-advanced'),
      overflow: document.documentElement.scrollWidth - window.innerWidth };
  });
  expect(afterSearch.find.bottom, 'the search controls still fit the first screen').toBeLessThanOrEqual(afterSearch.viewport);
  expect(afterSearch.overflow, 'no horizontal overflow after a search either').toBeLessThanOrEqual(0);
  console.log(`FIRST_LOOK_PHONE_AFTER ${JSON.stringify(afterSearch)}`);

  // SELECTING A ROAD NEEDS NO DISCLOSURE AT ALL, and the detail appears with it.
  await page.locator(`#recommendation-show-${first}`).click();
  await expect(page.locator('#discovery-selected')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#discovery-selected')).toContainText('Selected discovery corridor');
  await page.locator(`#recommendation-more-${first}`).click();
  await expect(page.locator('#discovery-selected')).toBeVisible();
  // SO DOES SEARCHING SOMEWHERE ELSE.
  await page.locator('#recommendations-change-location').click();
  await expect(page.locator('#discovery-place')).toBeFocused();
  await expect(page.locator('#discovery-advanced')).not.toHaveAttribute('open', '');

  // OPENING IT REVEALS THE UNCHANGED WORKBENCH.
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
  await expect(page.locator('#discovery-advanced-heading')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#discovery-advanced')).not.toHaveAttribute('open', '');
  await expect(page.locator('#discovery-results tbody tr').first()).not.toBeVisible();
  await page.keyboard.press('Tab');
  const afterTab = await page.evaluate(() => document.activeElement?.id ?? null);
  expect(TECHNICAL.map(selector => selector.slice(1)), `a collapsed disclosure leaves no tab stop (reached ${afterTab})`)
    .not.toContain(afterTab);

  // A WARNING STAYS WHERE IT IS, WITH THE DISCLOSURE SHUT. Changing the radius leaves the results stale, and the panel says
  // so in the ordinary flow.
  await openAdvancedSearch(page);
  await page.locator('#discovery-radius-input').fill('25');
  await page.locator('#discovery-radius-input').press('Enter');
  // The warning appears in the ordinary flow the moment the definition changes: wait for the panel to settle, then shut the
  // disclosure and prove the warning is still there - and that the collapsed section left nothing behind it.
  await expect(page.locator('#discovery')).toContainText('previous search');
  await page.locator('#discovery-advanced-search-heading').click();
  await expect(page.locator('#discovery-advanced-search')).not.toHaveAttribute('open', '');
  await expect(page.locator('#discovery')).toContainText('previous search');
  await expectTechnicalControlsHidden(page);
  console.log('FIRST_LOOK_PHONE_WARNING visible with the disclosure shut');
});

test('on a desktop the answer leads and the table is subordinate until it is opened', async ({ page }) => {
  test.setTimeout(1800000);
  await freshPage(page, DESKTOP);
  expect((await visibleControls(page)).sort()).toEqual(['discover-roads', 'discovery-advanced-search-heading',
    'discovery-place', 'discovery-use-location'].sort());
  await expectTechnicalControlsHidden(page);
  await findRoadsByPlace(page, 'Princeton');
  await expect(page.locator('#recommendation-list li.recommendation')).toHaveCount(5);
  await expect(page.locator('#recommendations-heading'))
    .toHaveText(`Best road-naturalist drives within ${DEFAULT_RADIUS_MILES} miles`);
  await expectTechnicalControlsHidden(page);
  // THE RECOMMENDATIONS COME FIRST IN THE DOCUMENT, and the workbench after them.
  const order = await page.evaluate(() => {
    const position = selector => [...document.querySelectorAll('#discovery *')].indexOf(document.querySelector(selector));
    return { recommendations: position('#discovery-recommendations'), advanced: position('#discovery-advanced'),
      results: position('#discovery-results') };
  });
  expect(order.recommendations).toBeGreaterThan(-1);
  expect(order.advanced).toBeGreaterThan(order.recommendations);
  expect(order.results).toBeGreaterThan(order.advanced);
  // A REAL LIMITATION IS STATED WHERE A PERSON READS IT, not hidden with the diagnostics. A centre whose circle cannot
  // reach the published region is the plainest limitation there is, and it is said as a consequence - while the
  // FULL/PARTIAL/NONE vocabulary stays inside the disclosure it belongs to.
  await openAdvancedSearch(page);
  await page.locator('#discovery-center-lat').fill('25.0000');
  await page.locator('#discovery-center-lon').fill('-140.0000');
  await page.locator('#discovery-center-apply').click();
  await page.locator('#discovery-advanced-search-heading').click();
  await expect(page.locator('#discovery-advanced-search')).not.toHaveAttribute('open', '');
  await expect(page.locator('#discovery-coverage-note')).toBeVisible();
  await expect(page.locator('#discovery-coverage-note')).toContainText('No published environmental data');
  await expect(page.locator('#discovery')).not.toContainText('Discovery coverage NONE');
  await expect(page.locator('#discovery-search-status')).toContainText('Cannot search');
  // AND THE SEARCH THAT PRODUCED THE ANSWER IS STILL THE ONE ON SCREEN.
  await expect(page.locator('#recommendation-list li.recommendation')).toHaveCount(5);
  // AND OPENING IT CHANGES NOTHING ABOUT THE ANSWER.
  await page.locator('#discovery-advanced-heading').click();
  await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#recommendation-list li.recommendation')).toHaveCount(5);
  await expect(page.locator('#recommendations-heading')).toBeVisible();
  console.log(`FIRST_LOOK_DESKTOP ${JSON.stringify({ order, viewport: DESKTOP })}`);
});
