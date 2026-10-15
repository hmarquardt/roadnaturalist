import { expect } from '@playwright/test';

// THE DISCOVERY SURFACE'S WORKFLOW, IN ONE PLACE.
//
// Discovery keeps its answer in front and its machinery behind two disclosures: "Advanced search" (declared areas, exact
// coordinates, the map picker, the radius) and "Explore all results" (the coverage internals, the filters, the sort control
// and the full table). A gate that drives those controls has to open them the way a person does - a real click on the
// summary - so every gate opens them through these helpers, and a gate that needs the table says so out loud instead of
// relying on a CSS override.
//
// This module is not a test file: the runner collects `*.spec.js` (Playwright) and `*.test.js` (node --test).
export const ADVANCED_SEARCH = '#discovery-advanced-search';
export const RESULTS = '#discovery-advanced';

export async function openDisclosure(page, selector) {
  const details = page.locator(selector);
  // THE DISCLOSURE ARRIVES WITH THE ANSWER. A gate may ask for it before a search has run (a helper defined near the top of
  // a spec, a shared setup step), so this waits for the section to exist rather than failing on a panel that has not drawn
  // its results yet - and then opens it the way a person does.
  await details.waitFor({ state: 'attached', timeout: 600000 });
  if (!(await details.evaluate(node => node.open))) {
    await page.locator(`${selector} > summary`).click();
  }
  await expect(details).toHaveAttribute('open', '');
  return details;
}

// The technical half of choosing where to search: declared areas, coordinates, the map picker and the radius.
export const openAdvancedSearch = page => openDisclosure(page, ADVANCED_SEARCH);
// The workbench: coverage internals, filters, sort control and the full result table.
export const openAllResults = page => openDisclosure(page, RESULTS);

// A CENTRE AND A RADIUS, SET THE WAY THE WORKBENCH SETS THEM. The ordinary path (a place name, or this device's location)
// needs no helper at all; a gate that wants an exact coordinate pair opens the disclosure that holds one.
export async function setCenter(page, { lat, lon, radiusMiles = null } = {}) {
  await openAdvancedSearch(page);
  await page.locator('#discovery-center-lat').fill(String(lat));
  await page.locator('#discovery-center-lon').fill(String(lon));
  await page.locator('#discovery-center-apply').click();
  if (radiusMiles != null) await setRadius(page, radiusMiles);
}

export async function setRadius(page, miles) {
  await openAdvancedSearch(page);
  await page.locator('#discovery-radius-input').fill(String(miles));
  await page.locator('#discovery-radius-input').press('Enter');
}

// ONE COMPLETE SEARCH: the centre and radius (when a gate needs them), then the button a person presses.
export async function findRoads(page, { lat = null, lon = null, radiusMiles = null } = {}) {
  if (lat != null && lon != null) await setCenter(page, { lat, lon, radiusMiles });
  await page.locator('#discover-roads').click();
}

// The result table, with the workbench opened first: the rows are behind "Explore all results".
export async function discoveryRows(page) {
  await openAllResults(page);
  return page.locator('#discovery-results tbody tr');
}
