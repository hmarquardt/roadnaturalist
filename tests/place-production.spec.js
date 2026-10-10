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
const PROMOTION_PLACES = Object.freeze([
  ['princeton in', 'Princeton, IN'],
  ['evansville in', 'Evansville, IN'],
  ['nashville tennessee', 'Nashville, TN'],
  ['portland oregon', 'Portland, OR'],
]);

test('deployed promotion reads published raw cells inside a seeded region, and refuses outside one', async ({ page }) => {
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

  async function choosePlace(query) {
    await page.locator('#discovery-place').fill(query);
    await expect(page.locator('#discovery-place-results')).toBeVisible({ timeout: 120000 });
    await page.locator('#discovery-place-results .discovery-place-option').first().click();
    await expect(page.locator('#discovery-place-results')).toBeHidden();
  }

  // Choose the first corridor that promotes. A published region covers the road components it closed over, not
  // every road in it, so a refusal is a legitimate answer for a particular corridor - what the check asserts is
  // that at least one corridor in each seeded area promotes, and that a refusal names what is missing.
  async function promoteOne(limit = 10) {
    const rows = page.locator('#discovery-results tbody tr');
    const count = Math.min(limit, await rows.count());
    let last = null;
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const name = (await row.innerText()).split('\n')[0];
      // The panel may already show the previous region's candidate (candidates persist on this device), so the
      // wait is for a *new* outcome: a title that changed, or a refusal for this attempt.
      const before = await page.locator('#candidate-detail .detail-title').innerText().catch(() => null);
      await row.locator('.discovery-row').click();
      await page.locator('#discovery-promote').click();
      const candidate = page.locator('#candidate-detail .detail-title');
      const refused = page.locator('#discovery-promotion-error');
      try {
        await expect.poll(async () => {
          if (await refused.isVisible().catch(() => false)) return 'refused';
          const title = await candidate.innerText().catch(() => null);
          return title && title !== before ? 'promoted' : null;
        }, { timeout: 300000, message: `${name} must promote or refuse` }).not.toBeNull();
      } catch {
        continue;
      }
      if (await candidate.isVisible().catch(() => false) && await candidate.innerText() !== before) {
        return { promoted: name, refusal: null, detail: (await page.locator('#candidate-detail').innerText()).slice(0, 240) };
      }
      const message = await refused.innerText();
      // A refusal for one corridor is a legitimate answer (its road may reach beyond what is published);
      // the check keeps trying, because what it asserts is that the area can be explored in detail at all.
      last = message;
      if (index === count - 1) return { promoted: null, refusal: last, detail: null };
    }
    return { promoted: null, refusal: 'no corridor in this area could be promoted', detail: null };
  }

  const report = { regions: [], refusal: null };
  for (const [query, label] of PROMOTION_PLACES) {
    await boot();
    await choosePlace(query);
    await page.locator('#discovery-radius-input').fill('25');
    await page.locator('#discovery-radius-input').press('Enter');
    await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL', { timeout: 120000 });
    await page.locator('#discover-roads').click();
    await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 600000 });
    const before = rawCells.length;
    const outcome = await promoteOne();
    const entry = { place: label, promoted: outcome.promoted, refusal: outcome.refusal,
      rawCells: rawCells.length - before,
      rawPlaneHost: rawCells[before] ? new URL(rawCells[before]).host : null, detail: outcome.detail };
    report.regions.push(entry);
    console.log('PROMOTION_PRODUCTION ' + JSON.stringify(entry));
    expect(entry.promoted, `${label} must promote from published raw cells`).not.toBeNull();
    expect(entry.rawCells, `${label} must read raw cells`).toBeGreaterThan(0);
    expect(entry.rawPlaneHost, label).toBe('data.roadnaturalist.com');
    // The detailed panel measured the reconstructed corridor: physical habitat evidence, not precomputed values.
    expect(entry.detail, label).toMatch(/Candidate|corridor/i);
  }

  // Outside every published region: the refusal is precise, and no raw object is fetched to produce it.
  await boot();
  await choosePlace('yellowstone');
  await page.locator('#discovery-radius-input').fill('25');
  await page.locator('#discovery-radius-input').press('Enter');
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 600000 });
  const before = rawCells.length;
  const refusal = await promoteOne(3);
  report.refusal = { message: refusal.refusal, promoted: refusal.promoted, rawCells: rawCells.length - before };
  console.log('PROMOTION_PRODUCTION_REFUSAL ' + JSON.stringify(report.refusal));
  expect(refusal.promoted).toBeNull();
  expect(refusal.refusal).toMatch(/have not been published/);
  expect(report.refusal.rawCells).toBe(0);

  expect(outside, 'a promotion must reach no geocoder, occurrence source or Investigator endpoint').toEqual([]);
  expect(failures).toEqual([]);
});
