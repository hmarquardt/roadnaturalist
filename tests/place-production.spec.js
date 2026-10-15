import { test, expect } from '@playwright/test';
import { openAdvancedSearch, openAllResults, openChangeLocation } from './discovery-ui.js';

import { REPRESENTATIVE_IDENTITY } from '../src/discovery/identity-evidence.js';
import { MILES_TO_M, drawnSearchCentre, searchGeometry } from './map-contract.js';

// Opt-in verification of the *deployed* national place-name search.
//
//   RUN_PLACE_PRODUCTION=1 EVIDENCE_DEBUG=1 npm run verify:places:production
//   PRODUCTION_BASE_URL=https://roadnaturalist.pages.dev RUN_PLACE_PRODUCTION=1 EVIDENCE_DEBUG=1 npx playwright test tests/place-production.spec.js
//
// EVIDENCE_DEBUG=1 is required, not optional: the application prints its evidence stages only when
// `__RN_DEBUG_EVIDENCE` is set, and the identity record of the representative corridor (see
// src/discovery/identity-evidence.js) is one of those stages. The spec asserts that precondition at the checkpoint
// rather than letting a missing observation look like a missing verification.
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
    await openChangeLocation(page);
    await expect(page.locator('#discovery-place-results')).toBeVisible({ timeout: 120000 });
    const labels = await page.locator('#discovery-place-results .discovery-place-option').evaluateAll(nodes =>
      nodes.map(node => `${node.querySelector('.discovery-place-name').textContent}`
        + ` · ${node.querySelector('.discovery-place-type').textContent}`
        + ` — ${node.querySelector('.discovery-place-detail').textContent.replace(/^ *— */, '')}`));
    await openChangeLocation(page);
    await page.locator('#discovery-place-results .discovery-place-option').first().click();
    await openChangeLocation(page);
    await expect(page.locator('#discovery-place-results')).toBeHidden();
    return labels;
  }

  async function setRadius(radius) {
    await openAdvancedSearch(page);
    await page.locator('#discovery-radius-input').fill(String(radius));
    await page.locator('#discovery-radius-input').press('Enter');
    await expect(page.locator('#discovery-radius-value')).toHaveText(`${radius} mi`);
  }

  async function boot() {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await openChangeLocation(page);
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });
    await openChangeLocation(page);
    await expect(page.locator('#discovery-place')).toBeVisible({ timeout: 180000 });
  }

  await boot();

  // 1. Every place the brief names resolves from its name alone, with its county or kind beside it.
  for (const [query, expected] of PLACES) {
    const labels = await choosePlace(query);
    await openAdvancedSearch(page);
    const status = await page.locator('#discovery-active-search').innerText();
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
    await openChangeLocation(page);
    await expect(page.locator('#discovery-center-label')).toContainText(expected);
  }

  // 2. One discovery search per region, from a place name, reading the published national cells.
  for (const [region, query, expected] of REGIONS) {
    await boot();
    expect((await choosePlace(query))[0]).toContain(expected);
    await setRadius(25);
    await expect(page.locator('#discovery-active-search')).toContainText('Coverage: FULL', { timeout: 120000 });
    const before = derivedCells.length;
    const started = Date.now();
    await openChangeLocation(page);
    await page.locator('#discover-roads').click();
    await expect(page.locator('#discovery-summary')).toContainText('within 25 mi', { timeout: 600000 });
    await openAllResults(page);
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
    expect(entry.summary, region).toContain('within 25 mi');
    expect(entry.recent, region).toContain(expected);
    // The map moved to the chosen place, stated in the geographic map's own contract instead of the retired schematic's
    // DOM: a search centre is drawn, and the search geometry the map holds is the requested radius around the chosen
    // place. The two facts the schematic's key carried are asserted where the product states them now - the chosen
    // radius is the search control's own value, and the coverage is the search status line, asserted above.
    await expect(drawnSearchCentre(page)).toHaveCount(1);
    await expect(page.locator('#discovery-radius-input')).toHaveValue('25');
    const drawn = await searchGeometry(page);
    expect(drawn.center, region).not.toBeNull();
    expect(Math.abs(drawn.radiusM - 25 * MILES_TO_M), `${region}: the drawn radius is the requested 25 mi`)
      .toBeLessThan(MILES_TO_M);
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
// The global ecoregion plane: two whole-CONUS layers, published once on the data origin. They must never be
// asked of the application's own origin, which serves no such file - the 404 that made this gate red.
const ECOLOGY_PLANE = /national\/epa-conus-l[34]\.parquet$/;
const ECOLOGY_ORIGIN = 'https://data.roadnaturalist.com/';
// The global roads plane: published once on the data origin, like the CONUS ecology layers. An attempt against the
// application's own origin is a request for a partition it has never served.
const GLOBAL_ROADS = /\/national\/roads\//;
const GLOBAL_PLANE_ORIGIN = 'https://data.roadnaturalist.com/';
const APP_ORIGIN = /^https:\/\/(www\.)?roadnaturalist\.com\/|^https:\/\/[a-z0-9-]+\.roadnaturalist\.pages\.dev\/|^https?:\/\/localhost/;
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
  // Where the CONUS ecology layers were actually *read*. A request may be redirected by the origin (production
  // does exactly that for `/data/...`), so what proves the plane model is the response that carried the bytes, and
  // separately that no origin ever answered an ecology request with a 404.
  const ecologyReads = [];
  const ecologyMisses = [];
  const roadReads = [];
  const pageOriginGlobalPlane = [];
  page.on('request', request => {
    const url = request.url();
    if (RAW_PLANE.test(url)) rawCells.push(url);
    if (EVIDENCE.test(url)) outside.push(url);
    // A global plane must never be asked of the application's own origin. Both global planes are checked here -
    // roads as well as ecoregions - because they share one mechanism and only one of them used to be guarded.
    if ((GLOBAL_ROADS.test(url) || ECOLOGY_PLANE.test(url)) && !url.startsWith(GLOBAL_PLANE_ORIGIN) && APP_ORIGIN.test(url)) {
      pageOriginGlobalPlane.push(url);
    }
  });
  page.on('response', response => {
    if (GLOBAL_ROADS.test(response.url()) && response.status() < 400) roadReads.push(response.url());
    if (!ECOLOGY_PLANE.test(response.url())) return;
    if (response.status() >= 400) ecologyMisses.push(`${response.status()} ${response.url()}`);
    else ecologyReads.push(response.url());
  });
  page.on('pageerror', error => failures.push(error.message));
  // Evidence stages, printed only when EVIDENCE_DEBUG is set: the app gates its own markers the same way.
  const stages = [];
  page.on('console', message => {
    const text = message.text();
    if (text.startsWith('sourceEvidence:')) { stages.push(text); console.log('STAGE ' + text); }
    if (message.type() === 'error') failures.push(text);
  });

  async function boot() {
    await page.addInitScript(({ debug, timeoutMs }) => {
      if (debug) { globalThis.__RN_DEBUG_EVIDENCE = true; globalThis.__RN_SOURCE_TIMEOUT_MS = timeoutMs; }
    }, { debug: Boolean(process.env.EVIDENCE_DEBUG), timeoutMs: Number(process.env.EVIDENCE_TIMEOUT_MS ?? 90000) });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await openChangeLocation(page);
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });
    await openChangeLocation(page);
    await expect(page.locator('#discovery-place')).toBeVisible({ timeout: 180000 });
  }

  async function discovery(query) {
    await openChangeLocation(page);
    await page.locator('#discovery-place').fill(query);
    await openChangeLocation(page);
    await expect(page.locator('#discovery-place-results')).toBeVisible({ timeout: 120000 });
    await openChangeLocation(page);
    await page.locator('#discovery-place-results .discovery-place-option').first().click();
    await openChangeLocation(page);
    await expect(page.locator('#discovery-place-results')).toBeHidden();
    await openAdvancedSearch(page);
    await page.locator('#discovery-radius-input').fill('25');
    await page.locator('#discovery-radius-input').press('Enter');
    await expect(page.locator('#discovery-active-search')).toContainText('Coverage: FULL', { timeout: 120000 });
    await openChangeLocation(page);
    await page.locator('#discover-roads').click();
    await openAllResults(page);
    await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 600000 });
  }

  // The identity evidence of one corridor, as the promotion path emitted it: the build id the row carries, and the
  // id the windowed reconstruction gave the same road. Read from the run's own console, never restated.
  function identityEvidenceFor(corridor) {
    const marker = 'sourceEvidence:identity ';
    for (const text of stages) {
      const at = text.indexOf(marker);
      if (at < 0) continue;
      try {
        const entry = JSON.parse(text.slice(at + marker.length));
        if (entry?.corridorName === corridor) return entry;
      } catch { /* a stage line that is not readable is not evidence */ }
    }
    return null;
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

    const started = Date.now();
    const before = rawCells.length;
    await page.locator('#source-evidence-request').click();
    const section = page.locator('#candidate-detail .source-evidence-section');
    await expect(section).toContainText('Source-backed', { timeout: 300000 }).catch(async error => {
      console.log(`SOURCE_STUCK ${label} after ${Math.round((Date.now() - started) / 1000)} s`);
      console.log(`SOURCE_SECTION ${(await section.innerText()).replace(/\n/g, ' | ').slice(0, 400)}`);
      console.log(`SOURCE_STAGES ${JSON.stringify(stages.slice(-12))}`);
      throw error;
    });
    console.log(`SOURCE_SECONDS ${label} ${((Date.now() - started) / 1000).toFixed(1)}`);
    // The representative corridor is the one the ordinal mismatch was measured on. This run must show, in its own
    // words, that the build id and the reconstructed id differ and that the corridor was promoted anyway because
    // exact source-feature identity, segmentation and geometry all matched. That is the contract, and it is the
    // line the release artefact keeps.
    if (derived.name === REPRESENTATIVE_IDENTITY.corridor) {
      // THE RECORD HAS TO BE SWITCHED ON TO BE READ. The application emits its evidence stages only when
      // `__RN_DEBUG_EVIDENCE` is set, and this spec sets that flag from EVIDENCE_DEBUG. With the flag off there is no
      // record to find, and the wait below would report a product failure for what is a missing observation; the
      // precondition is therefore named here, first. The identity requirement itself is unchanged: with the record in
      // hand, every field below must be present and exact.
      expect(process.env.EVIDENCE_DEBUG, `${label}: run with EVIDENCE_DEBUG=1 - the identity record is one of the `
        + 'application evidence stages this spec only observes when that flag enables them').toBeTruthy();
      await expect.poll(() => identityEvidenceFor(derived.name), { timeout: 30000,
        message: `${label}: ${derived.name} must record identity evidence, not only reach Source-backed` }).not.toBeNull();
      const identity = identityEvidenceFor(derived.name);
      console.log('IDENTITY_PRODUCTION ' + JSON.stringify(identity));
      expect(identity.derivedId, label).toBe(REPRESENTATIVE_IDENTITY.derivedId);
      expect(identity.reconstructedId, `${label}: the reconstruction must name itself`).toBeTruthy();
      expect(identity.idsDiffer, `${label}: this run exists to show that a diverging id is still verified`).toBe(true);
      expect(identity.identityBasis, label).toBe('source_feature_ids_exact');
      expect(identity.sourceFeatureCount, label).toBeGreaterThan(0);
      expect(identity.sourceFeatureMatch, label).toBe('exact');
      expect(identity.segmentIndex, label).toBeGreaterThanOrEqual(1);
      expect(identity.segmentCount, label).toBeGreaterThanOrEqual(identity.segmentIndex);
      expect(identity.geometryDriftM.derivedToSource, label).toBeLessThanOrEqual(1);
      expect(identity.geometryDriftM.sourceToDerived, label).toBeLessThanOrEqual(1);
      expect(identity.sourceEvidence, label).toBe('Source-backed');
    }
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
  // GLOBAL ECOREGIONS ARE READ FROM THEIR OWN DECLARED ORIGIN.
  // Roads and ecoregions are global planes; wetlands and hydrography stay bounded. A CONUS layer asked of the
  // application's own origin is a request for a file it has never served, and it is the exact failure this gate
  // caught. Both the request list and the absence of console 404s are asserted, because either alone could pass.
  expect(ecologyMisses, 'no origin may answer an ecology request with an error').toEqual([]);
  // GLOBAL ROADS GET THE SAME PROTECTION AS GLOBAL ECOREGIONS.
  expect(pageOriginGlobalPlane, 'a global plane may never be requested from the application origin').toEqual([]);
  expect(roadReads.length, 'the source step must read the global roads plane').toBeGreaterThan(0);
  expect([...new Set(roadReads)].filter(url => !url.startsWith(GLOBAL_PLANE_ORIGIN)),
    'every global road read must come from the declared data origin').toEqual([]);
  console.log('GLOBAL_READS ' + JSON.stringify({ roads: [...new Set(roadReads)].slice(0, 3),
    roadsFrom: roadReads.length, ecology: [...new Set(ecologyReads)] }));
  expect(ecologyReads.length, 'the seeded promotions must read the declared CONUS layers').toBeGreaterThan(0);
  expect([...new Set(ecologyReads)].filter(url => !url.startsWith(ECOLOGY_ORIGIN)),
    'every CONUS ecology layer must be read from its declared data origin').toEqual([]);
  const declared = new Set(['national/epa-conus-l3.parquet', 'national/epa-conus-l4.parquet']);
  for (const url of new Set(ecologyReads)) {
    expect(declared.has(url.replace(ECOLOGY_ORIGIN, '')), `${url} is not a declared CONUS ecology layer`).toBe(true);
  }
  console.log('ECOLOGY_PLANE_READS ' + JSON.stringify([...new Set(ecologyReads)]));
  expect(failures).toEqual([]);
});
