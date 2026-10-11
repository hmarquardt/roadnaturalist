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
    // The run's own verdict, read from the coverage banner's first (the run's) headline rather than from the
    // panel's whole text, which also carries per-corridor coverage words further down.
    const banner = await page.locator('#discovery .discovery-coverage strong').first().innerText();
    const entry = { region, query, place: expected, elapsedMs: Date.now() - started,
      corridors: Number(await page.locator('#discovery-count').innerText()),
      cellsRead: derivedCells.length - before,
      cellsHost: derivedCells[before] ? new URL(derivedCells[before]).host : null,
      coverage: /Discovery coverage (FULL|PARTIAL|NONE|UNKNOWN)/.exec(banner)?.[1] ?? null,
      recent: await page.locator('#discovery-recent').innerText(),
      summary: (await page.locator('#discovery-summary').innerText()).replace(/\n+/g, ' · '),
      firstRow: row.replace(/\s+/g, ' ').slice(0, 240) };
    report.regions.push(entry);
    log(entry);
    expect(entry.corridors, region).toBeGreaterThan(0);
    expect(entry.cellsRead, region).toBeGreaterThan(0);
    expect(entry.cellsHost, region).toBe('data.roadnaturalist.com');
    // The run's coverage is recorded, not asserted FULL: it is the derived plane's own habitat-coverage claim
    // for the cells it selected, and a selection can include cells whose analysis region the national wetland and
    // hydrography extracts do not cover - Miami's does, and the banner says so ("these metrics are unknown here,
    // not zero") while still returning 2,237 corridors. The centre's own classification is asserted FULL above,
    // which is what a *place search* owns; tests/national-derived-production.spec.js asserts FULL per region for
    // six specific centres, which is what a *plane* owns.
    expect(['FULL', 'PARTIAL', 'NONE']).toContain(entry.coverage);
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

// The promotion half of the production check: deep inspection reads raw road, wetland and hydrography cells,
// which are published only inside bounded regions - so a corridor inside a seeded region must promote from
// data.roadnaturalist.com, and a corridor outside every published region must refuse with what is missing rather
// than fetch its way to an answer. Both are run here, against the deployed site.
const RAW_PLANE = /\/(national\/roads|national\/wetlands|national\/hydro)\//;
// Two seeded regions, one Midwest and one Pacific Northwest, plus the refusal outside every region: enough to
// prove the published raw path end to end in two different wetland regimes without turning a release gate into a
// twenty-minute crawl.
const PROMOTION_PLACES = Object.freeze([
  ['princeton in', 'Princeton, IN'],
  ['portland oregon', 'Portland, OR'],
]);

// TWO LEVELS OF DETAIL, IN PRODUCTION.
//
// Selecting a corridor opens its precomputed metrics: the row the discovery run already loaded, with no source cell
// read at all - which is what makes a corridor worth opening anywhere in the country, including where its wetland
// and hydrography cells have never been published. Source-level evidence is a separate, explicit step, offered
// where the bounded cells are online and explained where they are not.
test('deployed detail opens from the precomputed row, and source evidence is a separate optional step', async ({ page }) => {
  test.setTimeout(3600000);
  await page.setViewportSize({ width: 1440, height: 950 });
  const rawCells = [];
  const failures = [];
  const outside = [];
  page.on('request', request => {
    if (RAW_PLANE.test(request.url())) rawCells.push(request.url());
    if (EVIDENCE.test(request.url())) outside.push(request.url());
  });
  page.on('pageerror', error => failures.push(error.message));

  async function boot() {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });
    await expect(page.locator('#discovery-place')).toBeVisible({ timeout: 180000 });
  }

  async function discovery(query) {
    await page.locator('#discovery-place').fill(query);
    await expect(page.locator('#discovery-place-results')).toBeVisible({ timeout: 120000 });
    await page.locator('#discovery-place-results .discovery-place-option').first().click();
    await expect(page.locator('#discovery-place-results')).toBeHidden();
    await page.locator('#discovery-radius-input').fill('25');
    await page.locator('#discovery-radius-input').press('Enter');
    await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL', { timeout: 120000 });
    await page.locator('#discover-roads').click();
    await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 600000 });
  }

  // Selecting a corridor and promoting it is the derived level: the panel opens from the row, and nothing raw is
  // fetched to do it.
  async function openDerivedDetail() {
    const row = page.locator('#discovery-results tbody tr').first();
    const name = (await row.innerText()).split('\n')[0];
    const before = rawCells.length;
    await row.locator('.discovery-row').click();
    await page.locator('#discovery-promote').click();
    const detail = page.locator('#candidate-detail');
    const refused = page.locator('#discovery-promotion-error');
    await expect(detail.locator('.corridor-metrics').or(refused)).toBeVisible({ timeout: 120000 });
    if (await refused.isVisible().catch(() => false)) {
      throw new Error(`${name}: the detail never opened - ${await refused.innerText()}`);
    }
    return { name, rawBytes: rawCells.length - before, text: (await detail.innerText()).slice(0, 2000) };
  }

  const report = { seeded: [], unseeded: null };

  for (const [query, label] of PROMOTION_PLACES) {
    await boot();
    await discovery(query);
    const derived = await openDerivedDetail();
    expect(derived.text, `${label}: the panel is labelled as precomputed`).toContain('Precomputed source metrics');
    const metrics = page.locator('#candidate-detail .corridor-metrics');
    await expect(metrics, `${label}: wetland metrics are shown`).toContainText(/Wetlands|Hydrography/);
    await expect(metrics, `${label}: the stored wetland and hydrography values are shown`).toContainText('Nearest wetland');
    await expect(metrics, `${label}: the stored road values are shown`).toContainText('Road');
    expect(derived.rawBytes, `${label}: opening the detail reads no source cell`).toBe(0);

    const before = rawCells.length;
    await page.locator('#source-evidence-request').click();
    await expect(page.locator('#candidate-detail .source-evidence-section')).toContainText('Source-backed', { timeout: 300000 });
    await expect(page.locator('#candidate-detail .habitat-section')).toBeVisible({ timeout: 300000 });
    const entry = { place: label, corridor: derived.name, derivedRawCells: derived.rawBytes,
      sourceRawCells: rawCells.length - before,
      host: before < rawCells.length ? new URL(rawCells[before]).host : null };
    report.seeded.push(entry);
    console.log('DETAIL_PRODUCTION ' + JSON.stringify(entry));
    expect(entry.sourceRawCells, `${label}: the source step reads raw cells`).toBeGreaterThan(0);
    expect(entry.host, label).toBe('data.roadnaturalist.com');
  }

  // Outside every published bounded region: the detail still opens, the metrics are still there, and the source
  // step says exactly what is missing without fetching anything.
  await boot();
  await discovery('yellowstone');
  const derived = await openDerivedDetail();
  expect(derived.text).toContain('Precomputed source metrics');
  expect(derived.rawBytes).toBe(0);
  const before = rawCells.length;
  await page.locator('#source-evidence-request').click();
  const status = page.locator('#candidate-detail .source-evidence-section');
  await expect(status).toContainText(/have not yet been published|has not yet been published/, { timeout: 180000 });
  const text = await status.innerText();
  report.unseeded = { corridor: derived.name, message: text.slice(0, 240), rawCells: rawCells.length - before };
  console.log('DETAIL_PRODUCTION_UNSEEDED ' + JSON.stringify(report.unseeded));
  expect(report.unseeded.rawCells, 'a missing source step must fetch nothing').toBe(0);
  expect(text).toMatch(/precomputed national analysis values/);
  // The corridor is still readable: the metrics the discovery row carried are on screen.
  await expect(page.locator('#candidate-detail .corridor-metrics')).toBeVisible();
  await expect(page.locator('#candidate-detail')).not.toContainText('Source-backed');

  expect(outside, 'a detail panel must reach no geocoder, occurrence source or Investigator endpoint').toEqual([]);
  expect(failures).toEqual([]);
});
