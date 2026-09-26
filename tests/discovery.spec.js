import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const summary = JSON.parse(readFileSync(new URL('./fixtures/or-roads-network.summary.json', import.meta.url)));
// The offline extraction summary counts road units by summing source-feature lengths, while the browser
// measures the composed corridor geometry the application uses everywhere. A unit whose source retraces
// a stretch therefore measures longer in the browser, so a handful of units sitting within metres of the
// 1-mile threshold fall on either side of it. Feature and unit counts must still match exactly.
const CORRIDOR_TOLERANCE = 0.15;
const expectedFeatures = summary.featureCount - summary.classCounts.S1500;
// Discovery must reach no occurrence source, no Investigator Worker, and no live OpenStreetMap. The
// guard matches external hosts only: the application's own occurrence adapter modules live under
// /src/occurrence/ and must load normally.
const EXTERNAL_HOSTS = /^https?:\/\/(?:[^/]*\.)?(?:inaturalist\.org|ebird\.org|overpass-api\.de|overpass\.kumi\.systems|openstreetmap\.org|roadnaturalist\.com)(?::\d+)?\//i;
const EXTERNAL_PATTERNS = ['https://api.inaturalist.org/**', 'https://api.ebird.org/**', 'https://ebird.org/**',
  'https://overpass-api.de/**', 'https://overpass.kumi.systems/**', 'https://api.roadnaturalist.com/**'];

// The eight real corridors whose geometry the buffering engine refuses. They are captured in
// tests/fixtures/discovery-geometry-failures.json and repaired there and here by the shared
// analytical-geometry boundary. They are named explicitly so a regression cannot hide inside a count.
const REPAIRED_CORRIDORS = ['drv1-nw-158th-ave-c2-s1', 'drv1-nw-cornelius-pass-rd-s1', 'drv1-nw-jacobson-rd-s1',
  'drv1-nw-oakhills-dr-s1', 'drv1-sw-brookwood-ave-s1', 'drv1-sw-butner-rd-s1', 'drv1-sw-murray-blvd-s1',
  'drv1-sw-washington-st-c1-s1'].sort();

async function watchExternal(page) {
  const seen = [];
  page.on('request', request => { if (EXTERNAL_HOSTS.test(request.url())) seen.push(request.url()); });
  for (const pattern of EXTERNAL_PATTERNS) {
    await page.route(pattern, route => { seen.push(route.request().url()); return route.abort(); });
  }
  return seen;
}

async function runDiscovery(page) {
  // The workspace renders its controls as soon as the app boots; waiting for that keeps a slow module
  // load from looking like a missing button.
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  await page.click('#discover-roads');
  await expect(page.locator('#discovery')).toContainText('Discovery coverage', { timeout: 110000 });
}

test.beforeEach(async ({ page }) => {
  // DuckDB-WASM and the bounded extracts are heavy: give every discovery page the same bounded boot.
  await page.goto('/');
  // The button stays disabled until the search-area declaration has loaded: a survey cannot run without one.
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
});

test('discovery surveys the pilot area with real data, and reaches no external evidence source', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  const started = Date.now();
  await runDiscovery(page);
  expect(Date.now() - started).toBeLessThan(110000);
  const panel = page.locator('#discovery');
  // The browser read exactly the extract the offline summary describes.
  await expect(panel).toContainText(`${expectedFeatures} road features read`);
  await expect(panel).toContainText('corridors analysed in one GIS batch');
  await expect(panel).toContainText('Batch phases:');
  // Units within metres of the 1-mile threshold can fall either side of it when the length is measured
  // on the composed corridor rather than by summing source features, so this count is checked within
  // a small tolerance of the offline number.
  const panelText = await panel.innerText();
  const dropped = Number(/\b(\d+) named road unit\(s\) shorter than the minimum corridor length/.exec(panelText)?.[1] ?? -1);
  expect(dropped).toBeGreaterThan(0);
  expect(Math.abs(dropped - summary.discovery.unitsDroppedAsShort)).toBeLessThanOrEqual(summary.discovery.unitsDroppedAsShort * 0.02);
  await expect(panel).toContainText('Not proposed:');
  const rows = page.locator('#discovery-results tbody tr');
  const corridorCount = Number(await page.locator('#discovery-count').innerText());
  expect(corridorCount).toBeGreaterThanOrEqual(Math.floor(summary.discovery.proposedCorridorCount * (1 - CORRIDOR_TOLERANCE)));
  expect(corridorCount).toBeLessThanOrEqual(Math.ceil(summary.discovery.proposedCorridorCount * (1 + CORRIDOR_TOLERANCE)));
  await expect(rows).toHaveCount(corridorCount);
  // A head-selected pilot road is proposed by discovery too, without any hand-written declaration.
  await expect(page.locator('#discovery-results')).toContainText('NW Cornelius Pass Rd');
  await page.locator('#discovery-wetland').selectOption('intersects');
  const intersectsCount = await rows.count();
  expect(intersectsCount).toBeGreaterThan(0);
  expect(intersectsCount).toBeLessThan(corridorCount);
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(rows).toHaveCount(corridorCount);
  // Explicit sorts reorder the table by one measured value each.
  await page.locator('#discovery-sort').selectOption('length');
  const lengths = await rows.evaluateAll(nodes => nodes.slice(0, 5).map(node => Number(node.children[1].textContent.replace(/[^0-9.]/g, ''))));
  expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  await page.locator('#discovery-sort').selectOption('name');
  const names = await rows.evaluateAll(nodes => nodes.slice(0, 5).map(node => node.querySelector('button').textContent));
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  // Selecting a result highlights it on the map and shows its measured evidence.
  await page.locator('.discovery-row').first().click();
  const selected = page.locator('#discovery-selected');
  await expect(selected).toContainText('Selected discovery corridor');
  await expect(selected).toContainText('Mapped wetland within 250 m');
  await expect(selected).toContainText('Mapped water crossings');
  await expect(selected).toContainText('Access verification: NOT YET RUN / UNVERIFIED');
  await expect(selected).toContainText('Occurrence sources: not queried');
  await expect(page.locator('#map svg .discovery-selected')).toHaveCount(1);
  expect(await page.locator('#map svg .discovery-corridor').count()).toBeGreaterThan(50);
  expect(external).toEqual([]);
});

test('promotion produces an ordinary candidate whose detailed analysis matches the discovery batch', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await runDiscovery(page);
  // The default display order puts the corridors with the most mapped wetland first, so the first row is
  // a corridor whose wetland metrics were measured. Corridors the buffering engine refuses are repaired
  // by the shared analytical-geometry boundary before this point, so UNKNOWN habitat coverage now only
  // means the habitat extract itself does not reach that corridor.
  const firstRow = page.locator('.discovery-row').first();
  await expect(firstRow).toBeVisible({ timeout: 30000 });
  const corridorName = (await firstRow.innerText()).trim();
  await firstRow.click();
  const selected = page.locator('#discovery-selected');
  await expect(selected).toContainText('Selected discovery corridor');
  await expect(selected).toContainText(corridorName);
  // The batch measurements are the values the detailed per-corridor analysis reports for the same line.
  const discoveryArea = await selected.locator('.discovery-facts div', { hasText: 'Mapped wetland within 250 m' }).locator('dd').innerText();
  const discoveryCrossings = await selected.locator('.discovery-facts div', { hasText: 'Mapped water crossings' }).locator('dd').innerText();
  expect(discoveryArea).not.toBe('None mapped');
  await page.locator('#discovery-promote').click();
  const list = page.locator('#candidate-list');
  await expect(list).toContainText(corridorName);
  const detail = page.locator('#candidate-detail');
  await expect(detail).toContainText(corridorName);
  await expect(detail).toContainText('discovered');
  const habitat = page.locator('.habitat-section');
  await expect(habitat).toContainText('PHYSICAL HABITAT EVIDENCE', { timeout: 60000 });
  const habitatArea = await habitat.locator('.road-facts div', { hasText: /^Within 250 m/ }).first().locator('dd').innerText();
  expect(habitatArea).toContain(discoveryArea);
  const habitatCrossings = await habitat.locator('.road-facts div', { hasText: 'Mapped crossings' }).first().locator('dd').innerText();
  expect(habitatCrossings).toContain(`${discoveryCrossings} documented`);
  // Access stays unverified for a discovered corridor, and the panel says why: no reviewed source is declared.
  await expect(page.locator('.access-section')).toContainText('No reviewed research sources are declared for this corridor');
  await expect(page.locator('.access-section')).toContainText('UNVERIFIED');
  // Access research on a corridor with no declared probes stays UNVERIFIED and needs no Worker call.
  await page.getByRole('button', { name: /access research|access investigation/i }).first().click();
  await expect(page.locator('.access-section')).toContainText('UNVERIFIED', { timeout: 60000 });
  await expect(page.locator('.access-section')).not.toContainText('ACCESS VERIFIED');
  await expect(detail).toContainText('Evidence trail');
  expect(await page.locator('#map svg .discovery-corridor.promoted').count()).toBe(1);
  expect(external).toEqual([]);
});

test('a discovery run without the GIS engine reports UNKNOWN coverage, never an empty search area', async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: /Discover roads/ }).click();
  const panel = page.locator('#discovery');
  await expect(panel).toContainText('A failed query is not an empty search area', { timeout: 60000 });
  await expect(panel).toContainText('DuckDB Spatial initialization failed');
  await expect(page.locator('#discovery-count')).toHaveText('0');
  await expect(panel).not.toContainText('No discovery corridor was proposed');
  expect(errors).toEqual([]);
});

test('the discovery workspace stays usable at 390px', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 30000 });
  await runDiscovery(page);
  await expect(page.locator('#discovery')).toContainText('Discovery coverage');
  await page.locator('#discovery-results tbody tr button').first().click();
  await expect(page.locator('#discovery-selected')).toContainText('Selected discovery corridor');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});


test('the survey repairs the corridors the engine refuses, and promotion measures the same geometry', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await watchExternal(page);
  await runDiscovery(page);
  const panel = page.locator('#discovery');
  // No corridor is left with UNKNOWN habitat coverage because of its own geometry.
  await expect(panel).not.toContainText('have UNKNOWN habitat coverage');
  // The eight corridors that the engine refused are the committed regression fixture; the survey must
  // repair all of them, and report zero unusable geometry.
  const batch = await page.evaluate(async () => {
    const { createGisService } = await import('/src/gis/service.js');
    const { buildDiscoveryUnits } = await import('/src/discovery/units.js');
    const { segmentUnit } = await import('/src/discovery/segment.js');
    const { eligibleClasses } = await import('/src/discovery/eligibility.js');
    const { ANALYSIS_DISTANCES_M } = await import('/src/gis/habitat-result.js');
    const gis = createGisService();
    const road = await gis.queryRoadNetwork({ bbox: [-123.07, 45.505, -122.75, 45.67], roadClasses: eligibleClasses(), limit: 20000 });
    const corridors = [];
    for (const unit of buildDiscoveryUnits(road.features).units) for (const corridor of segmentUnit(unit).corridors) corridors.push(corridor);
    const analysis = await gis.analyzeDiscovery(corridors.map(corridor => ({ id: corridor.id, geometry: corridor.geometry })), { distancesM: ANALYSIS_DISTANCES_M });
    const facts = Object.fromEntries(Object.entries(analysis.corridors).map(([id, block]) => [id, block.geometryForAnalysis]));
    const coverage = {};
    for (const block of Object.values(analysis.corridors)) {
      const state = block.wetlands.coverage;
      coverage[state] = (coverage[state] ?? 0) + 1;
    }
    return { corridors: corridors.length, unbufferable: [...analysis.diagnostics.unbufferableCorridors],
      repaired: [...analysis.diagnostics.repairedCorridors], methods: analysis.diagnostics.analyticalGeometry.methods,
      repairedCount: analysis.diagnostics.analyticalGeometry.repairedCount,
      maxDisplacement: Math.max(...Object.values(facts).map(fact => fact.displacementM ?? 0)),
      wetlandCoverage: coverage, facts };
  });
  expect(batch.unbufferable).toEqual([]);
  expect(batch.repaired.sort()).toEqual(REPAIRED_CORRIDORS);
  expect(batch.methods['remove-duplicate-segments']).toBe(8);
  expect(batch.maxDisplacement).toBe(0);
  expect(batch.wetlandCoverage.UNKNOWN ?? 0).toBe(0);
  for (const id of REPAIRED_CORRIDORS) {
    expect(batch.facts[id].repaired).toBe(true);
    expect(batch.facts[id].note).toContain('canonical corridor geometry is unchanged');
    expect(batch.facts[id].removedDuplicateLengthM).toBeGreaterThan(0);
  }
  // Selecting and promoting a repaired corridor shows the repair in the interface, and the detailed
  // analysis of the promoted corridor measures the same geometry the survey did.
  const row = page.locator('.discovery-row', { hasText: 'SW Washington St' }).first();
  await row.click();
  const selected = page.locator('#discovery-selected');
  await expect(selected).toContainText('Analytical geometry');
  await expect(selected).toContainText('Minor topology repair applied (remove-duplicate-segments)');
  const discoveryArea = await selected.locator('.discovery-facts div', { hasText: 'Mapped wetland within 250 m' }).locator('dd').innerText();
  expect(discoveryArea).not.toBe('None mapped');
  await page.locator('#discovery-promote').click();
  const habitat = page.locator('.habitat-section');
  await expect(habitat).toContainText('PHYSICAL HABITAT EVIDENCE', { timeout: 60000 });
  const habitatArea = await habitat.locator('.road-facts div', { hasText: /^Within 250 m/ }).first().locator('dd').innerText();
  expect(habitatArea).toContain(discoveryArea);
  await expect(habitat).toContainText('Analytical geometry: minor topology repair applied');
  await expect(habitat).toContainText('canonical road geometry preserved');
  expect(external).toEqual([]);
});
