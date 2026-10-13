import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const inatFixture = JSON.parse(readFileSync(new URL('./fixtures/inaturalist-observations.json', import.meta.url)));

// Deterministic stand-in for api.inaturalist.org: identical request construction to production (the app
// really calls fetch), but answered from the captured fixture so browser tests never depend on a live
// public API. Counts are returned for per_page=0 and record pages for the real record requests.
const SMALL_REGION_SWLAT = '45.5218';
async function stubInaturalist(page, { records = inatFixture.records, regionTotal = 5000, smallRegionTotal = 240, temporalTotal = 120 } = {}) {
  await page.route('https://api.inaturalist.org/**', async route => {
    const url = new URL(route.request().url());
    const perPage = Number(url.searchParams.get('per_page'));
    if (perPage === 0) {
      const total = url.searchParams.get('d1') ? temporalTotal : url.searchParams.get('swlat') === SMALL_REGION_SWLAT ? smallRegionTotal : regionTotal;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total_results: total, results: [] }) });
    }
    const slice = url.searchParams.get('swlat') === SMALL_REGION_SWLAT ? records.slice(0, 8) : records;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total_results: regionTotal, page: 1, per_page: perPage, results: slice }) });
  });
}

test('occurrence evidence loads lazily, stays privacy-safe, and separates its sources', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  const externalCalls = [];
  page.on('request', request => { if (request.url().includes('api.inaturalist.org') || request.url().includes('api.ebird.org')) externalCalls.push(request.url()); });
  await stubInaturalist(page);
  await page.goto('/');
  await page.locator('#load-pilot').click();
  const detail = page.locator('#candidate-detail');
  await expect(detail).toContainText('NW Cornelius Pass Rd', { timeout: 60000 });
  const occurrence = page.locator('.occurrence-section');
  await expect(occurrence).toContainText('SPECIES OCCURRENCE EVIDENCE');
  await expect(occurrence).toContainText('Query the public occurrence sources');
  await expect(occurrence).toContainText('never wait on an external service');
  // Lazy: nothing external was requested just by loading the pilot, and the other panels already work.
  expect(externalCalls).toEqual([]);
  await expect(page.locator('.habitat-section')).toContainText('PHYSICAL HABITAT EVIDENCE');
  await expect(page.locator('.ecology-section')).toContainText('Willamette Valley');

  await occurrence.getByRole('button', { name: 'Query public occurrence sources' }).click();
  await expect(occurrence).toContainText('iNaturalist', { timeout: 60000 });
  await expect(occurrence).toContainText('Reported in region');
  await expect(occurrence).toContainText('source-reported');
  await expect(occurrence).toContainText('Retrieved in detail');
  await expect(occurrence).toContainText('most recent first');
  await expect(occurrence).toContainText('Regional/obscured');
  await expect(occurrence).toContainText('CoveragePARTIAL');
  await expect(occurrence).toContainText('at least, from retrieved records');
  // eBird has no browser credential: UNKNOWN with a reason, never a zero result.
  await expect(occurrence).toContainText('eBird');
  await expect(occurrence).toContainText('personal API key');
  await expect(occurrence).toContainText('not evidence that no species were reported');
  // The interpretation refuses prediction language.
  await expect(occurrence).toContainText('not a prediction that a species is on this road');
  await expect(occurrence).not.toContainText('likely');

  // Taxa detail with lenses, and no obscured coordinate anywhere in the rendered panel.
  const taxa = occurrence.locator('.occurrence-taxa');
  await taxa.locator('summary').first().click();
  await expect(taxa.locator('.taxon-row')).not.toHaveCount(0);
  await expect(taxa).toContainText('observation');
  const obscured = inatFixture.records.filter(record => record.obscured || record.geoprivacy === 'obscured' || record.taxon_geoprivacy === 'obscured');
  const panelText = await occurrence.innerText();
  for (const record of obscured) {
    const [lon, lat] = record.geojson.coordinates;
    expect(panelText.includes(String(lon))).toBe(false);
    expect(panelText.includes(String(lat))).toBe(false);
  }
  await taxa.getByRole('button', { name: 'Birds' }).click();
  await expect(taxa.locator('.lens-button[aria-pressed="true"]')).toHaveText('Birds');

  // Coverage panel keeps source detail.
  const context = page.locator('#data-context');
  await expect(context).toContainText('Occurrence — iNaturalistPARTIAL');
  await expect(context).toContainText('Occurrence — eBirdUNKNOWN');
  await expect(context).toContainText('OccurrencePARTIAL');
});

test('an unavailable occurrence source never blocks the rest of the panel and never reads as zero', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 900 });
  await page.route('https://api.inaturalist.org/**', route => route.abort());
  await page.goto('/');
  await page.locator('#load-pilot').click();
  const detail = page.locator('#candidate-detail');
  await expect(detail).toContainText('NW Cornelius Pass Rd', { timeout: 60000 });
  // Road, ecology, and habitat evidence are unaffected while occurrence sources are unreachable.
  await expect(page.locator('.habitat-section')).toContainText('PHYSICAL HABITAT EVIDENCE');
  await expect(page.locator('.ecology-section')).toContainText('Willamette Valley');
  await expect(detail).toContainText('U.S. Census Bureau TIGER/Line 2025 ROADS');
  const occurrence = page.locator('.occurrence-section');
  await occurrence.getByRole('button', { name: 'Query public occurrence sources' }).click();
  await expect(occurrence).toContainText('Coverage UNKNOWN', { timeout: 60000 });
  await expect(occurrence).toContainText('not evidence that no species were reported');
  await expect(occurrence).not.toContainText('0 observations');
  const context = page.locator('#data-context');
  await expect(context).toContainText('Occurrence — iNaturalistUNKNOWN');
  await expect(context).toContainText('OccurrenceUNKNOWN');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});

test('only precise public observations reach the map, and distances are real projected measurements', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await stubInaturalist(page);
  // The direct-click trace, so the click path below is measured rather than inferred.
  const layers = [];
  const fallbacks = [];
  await page.addInitScript(() => { globalThis.__RN_DEBUG_MAP_CLICK = true; });
  page.on('console', message => {
    if (message.text().startsWith('MAP_CLICK_LAYER')) layers.push(message.text());
    if (message.text().startsWith('MAP_CLICK_FALLBACK')) fallbacks.push(message.text());
  });
  await page.goto('/');
  await page.locator('#load-pilot').click();
  await expect(page.locator('#candidate-detail')).toContainText('NW Cornelius Pass Rd', { timeout: 60000 });
  await page.locator('.occurrence-section').getByRole('button', { name: 'Query public occurrence sources' }).click();
  await expect(page.locator('.occurrence-section')).toContainText('CoveragePARTIAL', { timeout: 60000 });
  // THE POINTS ARE TYPED MAP FEATURES: data-role=occurrence with an identity that is the source record the evidence was
  // keyed by. They are drawn only while the layer is switched on, they are never corridors, and they cannot be clicked.
  await expect(page.locator('#map path[data-role="occurrence"]')).toHaveCount(0);
  await page.locator('#occurrence-layer').check();
  const points = page.locator('#map path[data-role="occurrence"]');
  // WHAT THE LAYER WAS GIVEN AND WHAT THE MAP DID WITH IT, so a failure here says which of the two is empty. This
  // mirrors the application's own path exactly: analyze, summarize into sources, then the map's own normalizer.
  const local = await page.evaluate(async () => {
    const { occurrence, gis } = await import('/src/app/main.js');
    const { summarizeOccurrences } = await import('/src/occurrence/context.js');
    const { occurrenceFeatures } = await import('/src/map/geo-view.js');
    const pilot = await (await fetch('data/roads/or-roads-pilot.json')).json();
    const candidate = pilot.candidates.find(entry => /Cornelius Pass/.test(entry.name ?? ''));
    const roads = await gis.queryRoads({ roadIds: candidate.roadIds });
    const geometry = { type: 'MultiLineString', coordinates: roads.features.map(row => row.geometry.coordinates) };
    const evidence = summarizeOccurrences(await occurrence.analyze(geometry));
    const rows = Object.values(evidence.sources).flatMap(source => source.points ?? []);
    const census = {};
    for (const node of document.querySelectorAll('#map svg path, #map svg circle')) {
      const key = `${node.tagName}:${node.getAttribute('data-role') ?? 'none'}`;
      census[key] = (census[key] ?? 0) + 1;
    }
    return { returned: rows.length, normalized: occurrenceFeatures({ points: rows }).features.length, census,
      sources: Object.fromEntries(Object.entries(evidence.sources).map(([id, source]) => [id,
        { coverage: source.coverage ?? null, points: (source.points ?? []).length,
          precise: source.preciseObservations ?? 0, regionalOnly: source.regionalOnlyObservations ?? 0 }])) };
  });
  console.log(`OCCURRENCE_MAP_LOCAL ${JSON.stringify({ drawn: await points.count(),
    note: (await page.locator('#occurrence-note').innerText()).slice(0, 120), ...local })}`);
  await expect(points.first()).toBeVisible();
  const drawn = await points.count();
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThanOrEqual(300);
  const plotted = await points.evaluateAll(paths => paths.map(path => path.dataset.occurrenceId ?? ''));
  expect(plotted.filter(id => !id), 'every plotted point carries its own identity').toEqual([]);
  expect(plotted.every(id => /^[a-z]+:[^\s]+$/.test(id)), 'an identity is source:sourceRecordId').toBe(true);
  expect(await points.evaluateAll(paths => paths.filter(path => path.dataset.corridorId).length),
    'an occurrence point is never attributed to a corridor').toBe(0);
  expect(await points.evaluateAll(paths =>
    paths.filter(path => path.classList.contains('leaflet-interactive')).length),
  'a point cannot be pointed at, so it cannot take a click').toBe(0);
  // EVERY PLOTTED POINT IS A PRECISE PUBLIC OBSERVATION. The fixture's obscured records are the ones whose public
  // location is not usable; not one of their identities is on the map.
  const obscured = record => record.obscured || record.geoprivacy === 'obscured' || record.taxon_geoprivacy === 'obscured';
  const preciseIdentities = new Set(inatFixture.records.filter(record => !obscured(record))
    .map(record => `inaturalist:${record.id}`));
  expect(plotted.filter(id => !preciseIdentities.has(id)), 'no obscured record is plotted').toEqual([]);

  // A CORRIDOR IS STILL CLICKED EXACTLY WITH THE POINTS ON SCREEN. The probe finds a road whose midpoint really is on top
  // of a corridor path, and the click is a real mouse click at those coordinates.
  await page.locator('#map').scrollIntoViewIfNeeded();
  const probe = await page.evaluate(() => {
    for (const element of [...document.querySelectorAll('#map path[data-role="candidate"][data-corridor-id]')].slice(0, 40)) {
      const length = element.getTotalLength?.() ?? 0;
      if (!length) continue;
      const midpoint = element.getPointAtLength(length / 2);
      const screen = new DOMPoint(midpoint.x, midpoint.y).matrixTransform(element.getScreenCTM());
      const top = document.elementFromPoint(screen.x, screen.y);
      if (top?.dataset?.role === 'candidate' && top.dataset.corridorId) {
        return { x: screen.x, y: screen.y, id: top.dataset.corridorId };
      }
    }
    return null;
  });
  expect(probe, 'a drawn road is visible under a point that can be clicked').toBeTruthy();
  layers.length = 0;
  fallbacks.length = 0;
  await page.mouse.click(probe.x, probe.y);
  await page.waitForTimeout(900);
  expect(layers.length, 'the click reaches the corridor line itself').toBeGreaterThan(0);
  expect(fallbacks, 'and a click the line answered is not answered again by the map').toEqual([]);
  // THE PILOT CORRIDOR CLICKED ON THE MAP IS THE ONE THE APPLICATION SELECTS: the pilot declaration maps the id the click
  // reached to the name the detail panel shows, so the map, the list and the detail agree.
  const landedName = await page.evaluate(async id => {
    const pilot = await (await fetch('data/roads/or-roads-pilot.json')).json();
    return pilot.candidates.find(entry => entry.id === id)?.name ?? null;
  }, probe.id);
  expect(landedName, 'the clicked corridor is one the pilot declares').toBeTruthy();
  await expect(page.locator('#candidate-detail'), 'the corridor under the cursor is the selected one')
    .toContainText(landedName, { timeout: 30000 });
  console.log(`OCCURRENCE_SELECTION ${JSON.stringify({ clicked: probe.id, landedName, layers: layers.length,
    fallbacks: fallbacks.length })}`);
  expect(errors, 'and no click on a pilot corridor raises an error').toEqual([]);
  console.log(`OCCURRENCE_CLICKS ${JSON.stringify({ layers: layers.length, fallbacks: fallbacks.length })}`);

  await page.locator('#occurrence-layer').uncheck();
  await expect(page.locator('#map path[data-role="occurrence"]')).toHaveCount(0);

  // Known-geometry measurement: a point due north of a straight corridor is measured in EPSG:5070.
  const measured = await page.evaluate(async () => {
    const { gis } = await import('/src/app/main.js');
    const corridor = { type: 'LineString', coordinates: [[-123.05, 45.55], [-122.95, 45.55]] };
    const metresPerDegreeLatitude = 111132;
    const expectedM = 250;
    const point = [-123.0, 45.55 + expectedM / metresPerDegreeLatitude];
    const result = await gis.measureOccurrenceDistances(corridor, [{ id: 'inaturalist:fixture', coordinates: point }]);
    return { expectedM, distanceM: result.distances.get('inaturalist:fixture'), crs: result.crs, measured: result.measured };
  });
  expect(measured.measured).toBe(1);
  expect(measured.crs).toBe('EPSG:5070');
  expect(Math.abs(measured.distanceM - measured.expectedM) / measured.expectedM).toBeLessThan(0.02);
  expect(measured.distanceM).toBeGreaterThan(200);
  expect(measured.distanceM).toBeLessThan(300);
});
