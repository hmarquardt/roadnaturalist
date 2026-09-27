import { test, expect } from '@playwright/test';

// USE MY LOCATION.
//
// The browser's position is another way to answer *where*, and these tests drive the whole loop in a browser: a
// granted location becomes the ordinary search centre, the radius stays the person's, no search runs by itself,
// the URL stays coordinates, every refusal is a sentence rather than a dead panel, a late fix cannot overwrite a
// newer choice, and a reload never asks the browser for a location again.
const HILLSBORO = { latitude: 45.5229, longitude: -122.9898, accuracy: 120 };
const EXTERNAL_HOSTS = /^https?:\/\/(?:[^/]*\.)?(?:inaturalist\.org|ebird\.org|overpass-api\.de|overpass\.kumi\.systems|openstreetmap\.org|roadnaturalist\.com|nominatim\.openstreetmap\.org|api\.mapbox\.com|maps\.googleapis\.com|geocoding\.geo\.census\.gov)(?::\d+)?\//i;
const EXTERNAL_PATTERNS = ['https://api.inaturalist.org/**', 'https://api.ebird.org/**', 'https://ebird.org/**',
  'https://overpass-api.de/**', 'https://overpass.kumi.systems/**', 'https://api.roadnaturalist.com/**',
  'https://nominatim.openstreetmap.org/**', 'https://api.mapbox.com/**', 'https://maps.googleapis.com/**',
  'https://geocoding.geo.census.gov/**'];

async function watchExternal(page) {
  const seen = [];
  page.on('request', request => { if (EXTERNAL_HOSTS.test(request.url())) seen.push(request.url()); });
  for (const pattern of EXTERNAL_PATTERNS) {
    await page.route(pattern, route => { seen.push(route.request().url()); return route.abort(); });
  }
  return seen;
}

// A data-file read this application makes (not a module), so a restore can be held to "no R2, no analysis".
function watchDataReads(page) {
  const reads = [];
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/regional/partitions/') || url.includes('/derived/') || url.includes('data.roadnaturalist.com')
      || /\/gis\/[^/]+\.(parquet|json|fgb|geojson)$/.test(new URL(url).pathname)) reads.push(url);
  });
  return reads;
}

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
}

// A geolocation API that answers what a test needs, without a device or a permission prompt: the same boundary
// the application uses, replaced for the page.
async function mockGeolocation(page, { position = HILLSBORO, errorCode = null, delayMs = 0 } = {}) {
  await page.addInitScript(({ position, errorCode, delayMs }) => {
    window.__locationCalls = 0;
    window.__watchCalls = 0;
    const answer = (success, failure) => { if (errorCode) failure({ code: errorCode, message: 'mock' }); else success({ coords: position }); };
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(success, failure, options) {
        window.__locationCalls += 1;
        window.__locationOptions = options;
        if (delayMs > 0) setTimeout(() => answer(success, failure), delayMs); else answer(success, failure);
      },
      watchPosition() { window.__watchCalls += 1; return 1; },
      clearWatch() {},
    } });
  }, { position, errorCode, delayMs });
}

const locationStatus = page => page.locator('#discovery-location-status');

async function setRadius(page, radius) {
  await page.locator('#discovery-radius-input').fill(String(radius));
  await page.locator('#discovery-radius-input').press('Enter');
  await expect(page.locator('#discovery-radius-value')).toHaveText(`${radius} mi`);
}

test('a granted location becomes the search centre: no search, the same radius, the ordinary URL', async ({ page, context }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(HILLSBORO);
  await boot(page);
  await setRadius(page, 25);
  const untouched = await page.evaluate(() => document.querySelector('#discovery-summary')?.textContent ?? null);
  expect(untouched).toBe(null);
  await page.locator('#discovery-use-location').click();
  // The centre is the browser's position, to the same five decimals every other centre uses.
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5229', { timeout: 30000 });
  await expect(page.locator('#discovery-center-lon')).toHaveValue('-122.9898');
  // Labelled by the local gazetteer, not by a reverse geocoder and not snapped to the place.
  await expect(page.locator('#discovery-center-label')).toContainText('Near Hillsboro, OR');
  await expect(page.locator('#discovery-center-label')).toContainText('45.5229, -122.9898');
  // The accuracy is stated, and it is stated as the browser's fix.
  await expect(locationStatus(page)).toContainText('Search centre set from this device');
  await expect(locationStatus(page)).toContainText('Browser location accuracy: about 120 m.');
  // The radius is untouched, the coverage is the ordinary preview, and the URL stays coordinates.
  await expect(page.locator('#discovery-radius-value')).toHaveText('25 mi');
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL');
  await expect(page.locator('#discovery-use-location')).toHaveText('Use my location');
  expect(new URL(page.url()).search).toBe('?lat=45.5229&lon=-122.9898&r=25');
  // Nothing ran, and nothing outside this origin was asked.
  expect(await page.evaluate(() => document.querySelector('#discovery-summary')?.textContent ?? null)).toBe(null);
  await expect(page.locator('#discovery-results tbody tr')).toHaveCount(0);
  expect(external).toEqual([]);
});

test('the located centre runs the ordinary derived search, and reaches no evidence source', async ({ page, context }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(HILLSBORO);
  await boot(page);
  await setRadius(page, 10);
  await page.locator('#discovery-use-location').click();
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5229', { timeout: 30000 });
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('10-mile radius search', { timeout: 180000 });
  await expect(page.locator('#discovery-summary')).toContainText('Near Hillsboro, OR');
  expect(await page.locator('#discovery-results tbody tr').count()).toBeGreaterThan(0);
  await expect(page.locator('#discovery-search-status')).toContainText('Coverage: FULL');
  // The centre stayed the browser's position: a search never moves it to the nearest place.
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5229');
  expect(new URL(page.url()).search).toBe('?lat=45.5229&lon=-122.9898&r=10');
  expect(external, 'a located search must reach no occurrence, Investigator or Overpass endpoint').toEqual([]);
});

test('permission refused: one restrained sentence, and every other way of choosing a centre still works', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  // No permission is granted for this context, which is the state a person sees when they decline the prompt.
  await boot(page);
  await page.locator('#discovery-use-location').click();
  await expect(locationStatus(page)).toContainText('Location permission was not granted', { timeout: 30000 });
  await expect(locationStatus(page)).toContainText('place, click the map, or enter coordinates');
  // The button comes back, so the answer can be tried again, and nothing else is disabled.
  await expect(page.locator('#discovery-use-location')).toBeEnabled();
  await expect(page.locator('#discovery-place')).toBeEnabled();
  await expect(page.locator('#discovery-center-lat')).toBeEnabled();
  // The other inputs still set the centre, exactly as before.
  await page.locator('#discovery-center-lat').fill('45.5400');
  await page.locator('#discovery-center-lon').fill('-123.1700');
  await page.locator('#discovery-center-apply').click();
  await expect(page.locator('#discovery-center-label')).toContainText('45.5400, -123.1700');
  expect(new URL(page.url()).search).toBe('?lat=45.54&lon=-123.17&r=10');
  expect(external).toEqual([]);
});

test('a device that cannot answer, and a request that times out, each say so - and a retry is one click', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockGeolocation(page, { errorCode: 2 });
  await boot(page);
  await page.locator('#discovery-use-location').click();
  await expect(locationStatus(page)).toContainText('Your device could not determine a location', { timeout: 30000 });
  await expect(page.locator('#discovery-use-location')).toHaveText('Use my location');
  // A second attempt is another click, and this time the browser times out instead.
  await page.evaluate(() => { navigator.geolocation.getCurrentPosition = (success, failure) => failure({ code: 3, message: 'timeout' }); });
  await page.locator('#discovery-use-location').click();
  await expect(locationStatus(page)).toContainText('did not report a location in time', { timeout: 30000 });
  await expect(page.locator('#discovery-use-location')).toBeEnabled();
  // Nothing was set and nothing broke: the centre controls still carry the search.
  expect(new URL(page.url()).search).toBe('');
});

test('a late fix cannot overwrite a centre the person chose while the browser was looking', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockGeolocation(page, { position: HILLSBORO, delayMs: 1500 });
  await boot(page);
  await page.locator('#discovery-use-location').click();
  await expect(locationStatus(page)).toContainText('Asking this browser for its location', { timeout: 30000 });
  // While the browser is still looking, the person types a centre and presses Set centre.
  await page.locator('#discovery-center-lat').fill('45.5400');
  await page.locator('#discovery-center-lon').fill('-123.1700');
  await page.locator('#discovery-center-apply').click();
  await expect(page.locator('#discovery-center-label')).toContainText('45.5400, -123.1700');
  // The fix arrives afterwards. It is discarded: the newer, explicit choice stands.
  await page.waitForTimeout(2500);
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5400');
  await expect(page.locator('#discovery-center-lon')).toHaveValue('-123.1700');
  await expect(page.locator('#discovery-center-label')).toContainText('45.5400, -123.1700');
  expect(new URL(page.url()).search).toBe('?lat=45.54&lon=-123.17&r=10');
  // And it did not turn into a location success message after the fact.
  await expect(locationStatus(page)).not.toContainText('Browser location accuracy');
});

test('a reload restores the located centre without asking the browser for a location again', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await mockGeolocation(page);
  await boot(page);
  await setRadius(page, 25);
  await page.locator('#discovery-use-location').click();
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5229', { timeout: 30000 });
  expect(await page.evaluate(() => window.__locationCalls)).toBe(1);
  expect(await page.evaluate(() => window.__watchCalls)).toBe(0);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.reload();
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  // The centre, the radius and the label come back from this device, not from the device's position.
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5229');
  await expect(page.locator('#discovery-center-lon')).toHaveValue('-122.9898');
  await expect(page.locator('#discovery-radius-value')).toHaveText('25 mi');
  await expect(page.locator('#discovery-center-label')).toContainText('Near Hillsboro, OR');
  // A shared link is enough: the URL stays ordinary coordinates and radius, with nothing about where they came
  // from, and reloading it does not ask the browser for anything.
  expect(new URL(page.url()).search).toBe('?lat=45.5229&lon=-122.9898&r=25');
  // A reload never asks for a location, and never claims the remembered centre is where the device is now.
  expect(await page.evaluate(() => window.__locationCalls)).toBe(0);
  await expect(locationStatus(page)).not.toContainText('Browser location accuracy');
  await expect(locationStatus(page)).not.toContainText('Search centre set from this device');
  expect(external).toEqual([]);
});

test('a candidate found from a located centre is kept on this device, with no location request on restore', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await mockGeolocation(page);
  await boot(page);
  await setRadius(page, 10);
  await page.locator('#discovery-use-location').click();
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5229', { timeout: 30000 });
  await page.locator('#discover-roads').click();
  await expect(page.locator('#discovery-summary')).toContainText('10-mile radius search', { timeout: 180000 });
  const row = page.locator('#discovery-results tbody tr').first();
  await row.locator('.discovery-row').click();
  await page.locator('#discovery-promote').click();
  const context = page.locator('#candidate-detail #candidate-search-context');
  await expect(context).toBeVisible({ timeout: 180000 });
  const headline = await context.locator('.search-context-headline').innerText();
  expect(headline).toMatch(/of Near Hillsboro, OR$/);
  const promotedTitle = await page.locator('#candidate-detail .detail-title').innerText();
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  // RELOAD: the candidate, its corridor and its search context come back from local storage alone.
  const reads = watchDataReads(page);
  await page.reload();
  await expect(page.locator('#candidate-detail .detail-title')).toHaveText(promotedTitle, { timeout: 60000 });
  await expect(page.locator('#candidate-detail #candidate-search-context .search-context-headline')).toHaveText(headline);
  await expect(page.locator('#candidate-persistence')).toContainText('came back from local storage');
  expect(await page.evaluate(() => window.__locationCalls)).toBe(0);
  expect(reads).toEqual([]);
  expect(external).toEqual([]);
});

test('the location control stays reachable among the centre controls at 390px', async ({ page, context }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(HILLSBORO);
  await boot(page);
  await expect(page.locator('#discovery-use-location')).toBeVisible();
  await expect(page.locator('#discovery-place')).toBeVisible();
  await expect(page.locator('#discovery-center-lat')).toBeVisible();
  await expect(page.locator('#discovery-radius-input')).toBeVisible();
  await expect(page.locator('#discover-roads')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.locator('#discovery-use-location').click();
  await expect(page.locator('#discovery-center-lat')).toHaveValue('45.5229', { timeout: 30000 });
  await expect(locationStatus(page)).toContainText('Browser location accuracy: about 120 m.');
  await expect(page.locator('#discovery-radius-value')).toHaveText('10 mi');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('a browser that cannot report a location says so and leaves every other method in place', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => { Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined }); });
  await boot(page);
  await expect(locationStatus(page)).toContainText('This browser does not offer a location');
  await expect(page.locator('#discovery-use-location')).toHaveCount(0);
  await expect(page.locator('#discovery-place')).toBeEnabled();
  await page.locator('#discovery-center-lat').fill('45.4000');
  await page.locator('#discovery-center-lon').fill('-122.8000');
  await page.locator('#discovery-center-apply').click();
  await expect(page.locator('#discovery-center-label')).toContainText('45.4000, -122.8000');
  await expect(page.locator('#discover-roads')).toBeEnabled();
});

test('benchmark: what a location fix costs this application once the browser answers', async ({ page }) => {
  test.slow();
  test.skip(!process.env.RUN_GEOLOCATION_BENCHMARK, 'opt-in: measures validation, labelling and URL writing only');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  const measured = await page.evaluate(async () => {
    const { locationSearchDefinition, positionFromBrowser, accuracyLabel } = await import('/src/discovery/geolocation.js');
    const { serializeSearchQuery } = await import('/src/discovery/search-definition.js');
    const { nearestPlace } = await import('/src/discovery/place-gazetteer.js');
    const gazetteer = await (await fetch('data/places/or-sw-wa-portland-places.json')).json().catch(() => null);
    const region = await (await fetch('data/regional/manifest.json')).json().catch(() => null);
    const fix = positionFromBrowser({ coords: { latitude: 45.5229, longitude: -122.9898, accuracy: 120 } });
    const iterations = 2000;
    const started = performance.now();
    let definition = null;
    for (let index = 0; index < iterations; index += 1) {
      const result = locationSearchDefinition(fix, { radiusMiles: 25, region: region?.publishedRegion ?? region?.region ?? null });
      definition = result.definition;
      nearestPlace(definition.center, gazetteer);
      serializeSearchQuery(definition);
      accuracyLabel(fix.accuracyM);
    }
    const totalMs = performance.now() - started;
    return { iterations, totalMs: Math.round(totalMs * 100) / 100, perCallMs: Math.round(totalMs / iterations * 1000) / 1000,
      gazetteer: Boolean(gazetteer), region: Boolean(region), label: accuracyLabel(fix.accuracyM) };
  });
  console.log('GEOLOCATION_BENCHMARK ' + JSON.stringify(measured));
  expect(measured.perCallMs).toBeLessThan(5);
});
