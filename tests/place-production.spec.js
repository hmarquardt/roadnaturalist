import { test, expect } from '@playwright/test';

// Opt-in verification of the *deployed* national place-name search.
//
//   RUN_PLACE_PRODUCTION=1 npm run verify:places:production
//   PRODUCTION_BASE_URL=https://roadnaturalist.pages.dev RUN_PLACE_PRODUCTION=1 npx playwright test tests/place-production.spec.js
//
// It is the check the deployment story requires before (and after) a release: a place typed by name in the
// deployed app must set the search centre at the published interior point, keep the radius the person chose,
// run the published *national* derived corridor metrics from data.roadnaturalist.com, report FULL coverage
// across the conterminous states, and reach no external service at all - no geocoder, no occurrence source,
// no Investigator Worker. Every place the product brief names is resolved, and one discovery search per
// national region is run end to end from a place name.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
const EVIDENCE = /api\.inaturalist|api\.ebird|overpass|api\.roadnaturalist\.com|nominatim|mapbox|maps\.googleapis|geocoding\.geo\.census\.gov/;

// Every place the brief names, with the label the deployed search must produce.
const PLACES = Object.freeze([
  ['princeton in', 'Princeton, IN'], ['evansville in', 'Evansville, IN'], ['nashville tennessee', 'Nashville, TN'],
  ['cookeville tn', 'Cookeville, TN'], ['portland oregon', 'Portland, OR'], ['moab utah', 'Moab, UT'],
  ['duluth mn', 'Duluth, MN'], ['gibson county indiana', 'Gibson County, IN'], ['47715', '47715, IN'],
  ['great smoky mountains', 'Great Smoky Mountains National Park, TN'],
  ['yellowstone', 'Yellowstone National Park, WY'],
]);
// One end-to-end discovery run per national region, driven by a place name rather than a coordinate.
const REGIONS = Object.freeze([
  ['Pacific Northwest', 'portland oregon', 'Portland, OR'],
  ['Northeast', 'boston massachusetts', 'Boston, MA'],
  ['Gulf/Southeast', 'miami florida', 'Miami, FL'],
  ['Midwest/Great Lakes', 'minneapolis minnesota', 'Minneapolis, MN'],
  ['Great Plains', 'omaha nebraska', 'Omaha, NE'],
  ['Southwest', 'phoenix arizona', 'Phoenix, AZ'],
]);

test.skip(!process.env.RUN_PLACE_PRODUCTION, 'set RUN_PLACE_PRODUCTION=1 to verify the deployed place-name search');


test('deployed place search resolves the named places and runs national discovery, with nothing outside', async ({ page }) => {
  test.setTimeout(3600000);
  await page.setViewportSize({ width: 1440, height: 950 });
  const outside = [];
  const derivedCells = [];
  const failures = [];
  page.on('request', request => {
    if (EVIDENCE.test(request.url())) outside.push(request.url());
    if (request.url().includes('/derived/corridor-metrics/')) derivedCells.push(request.url());
  });
  page.on('pageerror', error => failures.push(error.message));
  const report = { base: BASE, places: [], regions: [], externalRequests: 0, pageErrors: 0 };
  const log = value => console.log('PLACE_PRODUCTION ' + JSON.stringify(value));

  async function choosePlace(query) {
    const input = page.locator('#discovery-place');
    await input.fill(query);
    await expect(page.locator('#discovery-place-results')).toBeVisible({ timeout: 120000 });
    const labels = await page.locator('#discovery-place-results .discovery-place-option').evaluateAll(nodes =>
      nodes.map(node => `${node.querySelector('.discovery-place-name').textContent}`
        + ` · ${node.querySelector('.discovery-place-type').textContent}`
        + ` — ${node.querySelector('.discovery-place-detail').textContent.replace(/^ *— */, '')}`));
    await page.locator('#discovery-place-results .discovery-place-option').first().click();
    await expect(page.locator('#discovery-place-results')).toBeHidden();
    return labels;
  }

  async function setRadius(radius) {
    await page.locator('#discovery-radius-input').fill(String(radius));
    await page.locator('#discovery-radius-input').press('Enter');
    await expect(page.locator('#discovery-radius-value')).toHaveText(`${radius} mi`);
  }

  async function boot() {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });
    await expect(page.locator('#discovery-place')).toBeVisible({ timeout: 180000 });
  }

  await boot();

  // 1. Every place the brief names resolves from its name alone, with its county or kind beside it.
  for (const [query, expected] of PLACES) {
    const labels = await choosePlace(query);
    const status = await page.locator('#discovery-search-status').innerText();
    const entry = { query, expected, first: labels[0],
      centre: `${await page.locator('#discovery-center-lat').inputValue()},${await page.locator('#discovery-center-lon').inputValue()}`,
      coverage: /Coverage: (FULL|PARTIAL|NONE|UNKNOWN)/.exec(status)?.[1] ?? null,
      runnable: await page.locator('#discover-roads').isEnabled() };
    report.places.push(entry);
    log(entry);
    expect(labels[0], query).toContain(expected);
    // A place inside the conterminous states is inside the published derived region, so its search is runnable.
    expect(entry.coverage, query).toBe('FULL');
    expect(entry.runnable, query).toBe(true);
    await expect(page.locator('#discovery-center-label')).toContainText(expected);
  }

  // 2. One discovery search per region, from a place name, reading the published national cells.
  for (const [region, query, expected] of REGIONS) {
    await boot();
    expect((await choosePlace(query))[0]).toContain(expected);
    await setRadius(25);
    await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL', { timeout: 120000 });
    const before = derivedCells.length;
    const started = Date.now();
    await page.locator('#discover-roads').click();
    await expect(page.locator('#discovery-summary')).toContainText('25-mile radius search', { timeout: 600000 });
    await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 300000 });
    const row = await page.locator('#discovery-results tbody tr').first().innerText();
    const entry = { region, query, place: expected, elapsedMs: Date.now() - started,
      corridors: Number(await page.locator('#discovery-count').innerText()),
      cellsRead: derivedCells.length - before,
      cellsHost: derivedCells[before] ? new URL(derivedCells[before]).host : null,
      coverage: /Discovery coverage (FULL|PARTIAL|NONE|UNKNOWN)/.exec(await page.locator('#discovery').innerText())?.[1] ?? null,
      recent: await page.locator('#discovery-recent').innerText(),
      summary: (await page.locator('#discovery-summary').innerText()).replace(/\n+/g, ' · '),
      firstRow: row.replace(/\s+/g, ' ').slice(0, 240) };
    report.regions.push(entry);
    log(entry);
    expect(entry.corridors, region).toBeGreaterThan(0);
    expect(entry.cellsRead, region).toBeGreaterThan(0);
    expect(entry.cellsHost, region).toBe('data.roadnaturalist.com');
    expect(entry.coverage, region).toBe('FULL');
    // The corridor row carries the ecology, wetland and hydrography summary the derived plane holds.
    expect(entry.firstRow, region).toMatch(/\d/);
    expect(entry.summary, region).toContain('25-mile radius search');
    expect(entry.recent, region).toContain(expected);
    // The map moved its centre to the chosen place; the key states the radius and the coverage it now has.
    await expect(page.locator('#map .search-center')).toHaveCount(1);
    await expect(page.locator('#map .map-key')).toContainText('25 mi');
    await expect(page.locator('#map .map-key')).toContainText('FULL');
  }

  expect(outside, 'a place search must reach no geocoder, occurrence source or Investigator endpoint').toEqual([]);
  expect(failures).toEqual([]);
  report.externalRequests = outside.length;
  report.pageErrors = failures.length;
  log({ places: report.places.length, regions: report.regions.length, externalRequests: report.externalRequests });
});

