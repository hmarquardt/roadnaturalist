import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const expectations = JSON.parse(readFileSync(new URL('./fixtures/habitat-pilot-expectations.json', import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url)));

// Offline layout and honest degraded-state coverage. DuckDB-WASM is blocked, so the road dataset
// cannot be read: the UI must report UNKNOWN road-geometry coverage instead of pretending that
// no roads exist, and the layout must stay healthy at desktop and mobile widths.
for (const width of [1440, 390]) {
  test(`road pilot degraded state and layout at ${width}px`, async ({ page }) => {
    await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('#candidate-list')).toContainText('No corridor loaded', { timeout: 30000 });
    await expect(page.locator('#map')).toContainText('No corridor loaded');
    await expect(page.locator('#data-context')).toContainText('Published GIS datasets6');
    await expect(page.locator('#data-context')).toContainText('WetlandsUNKNOWN');
    await page.getByRole('button', { name: /Open Oregon road pilot/ }).click();
    await expect(page.locator('#candidate-list')).toContainText('Road geometry could not be loaded');
    await expect(page.locator('#candidate-list')).toContainText('not evidence that no roads exist');
    await expect(page.locator('#data-context')).toContainText('Road geometry is UNKNOWN because the road dataset query failed');
    await expect(page.locator('#candidate-list')).not.toContainText('No corridor loaded');
    await expect(page.locator('#data-context')).toContainText('DuckDB Spatial initialization failed');
    await expect(page.locator('#map svg .road')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(errors).toEqual([]);
  });
}

test('real Oregon road pilot resolves through DuckDB Spatial into EPA ecology', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto('/');
  await page.getByRole('button', { name: /Open Oregon road pilot/ }).click();
  const list = page.locator('#candidate-list');
  const detail = page.locator('#candidate-detail');
  await expect(list).toContainText('NW Cornelius Pass Rd', { timeout: 60000 });
  await expect(list).toContainText('NW Springville Rd');
  await expect(list).toContainText('NW Susbauer Rd');
  await expect(list).not.toContainText('Road geometry could not be loaded');
  await expect(detail).toContainText('10.5 mi');
  await expect(detail).toContainText('Local road (S1400)');
  await expect(detail).toContainText('U.S. Census Bureau TIGER/Line 2025 ROADS');
  await expect(detail).toContainText('Not provided by this source');
  await expect(detail).toContainText('ACCESS UNVERIFIED');
  await expect(detail).toContainText('not evidence of legal public access');
  await expect(detail).toContainText('GEOMETRY VERIFIED');
  await expect(detail).toContainText('1 reversed duplicate link(s) collapsed');
  const ecology = page.locator('.ecology-section');
  await expect(ecology).toContainText('Willamette Valley (3)', { timeout: 30000 });
  await expect(ecology).toContainText('Also crosses Coast Range');
  await expect(ecology).toContainText('Prairie Terraces (3c)');
  await expect(ecology).toContainText('Coverage: FULL');
  await ecology.locator('summary').click();
  await expect(ecology).toContainText('U.S. Environmental Protection Agency');
  const habitat = page.locator('.habitat-section');
  await expect(habitat).toContainText('PHYSICAL HABITAT EVIDENCE', { timeout: 30000 });
  await expect(habitat).toContainText('Wetlands (NWI)');
  await expect(habitat).toContainText('Corridor intersects a mapped wetland');
  await expect(habitat).toContainText('Freshwater Emergent Wetland');
  await expect(habitat).toContainText('Riverine');
  await expect(habitat).toContainText('Surface water (NHD)');
  await expect(habitat).toContainText('documented geometric crossing');
  await expect(habitat).toContainText('Nearest standing water');
  await expect(habitat).toContainText('Not species occurrence, habitat quality, or access');
  await expect(habitat).toContainText('not a current-condition or jurisdictional determination');
  await habitat.locator('summary').first().click();
  await expect(habitat).toContainText('U.S. Fish and Wildlife Service');
  await expect(habitat).toContainText('U.S. Geological Survey');
  await expect(habitat).toContainText('EPSG:5070');
  await expect(page.locator('#map svg .habitat-wetland')).toHaveCount(0);
  await expect(page.locator('#map svg .habitat-flowline')).toHaveCount(0);
  await page.locator('#habitat-layers').check();
  await expect(page.locator('#map svg .habitat-buffer')).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator('#map svg .habitat-wetland')).not.toHaveCount(0);
  await expect(page.locator('#map svg .habitat-flowline')).not.toHaveCount(0);
  await expect(page.locator('#habitat-layers-note')).toContainText('Wetlands, flowlines, and the 1 km analysis buffer');
  await page.locator('#habitat-layers').uncheck();
  await expect(page.locator('#map svg .habitat-buffer')).toHaveCount(0);
  const context = page.locator('#data-context');
  await expect(context).toContainText('Road geometryFULL');
  await expect(context).toContainText('EPA Level IIIFULL');
  await expect(context).toContainText('EPA Level IVFULL');
  await expect(context).toContainText('WetlandsFULL');
  await expect(context).toContainText('HydrographyFULL');
  await expect(context).toContainText('Access verificationNONE');
  await expect(page.locator('#map svg .road')).toHaveCount(1);
  await expect(page.locator('#map svg .road-faint')).toHaveCount(2);
  await expect(page.locator('#map svg .map-badge')).toContainText('TIGER2025 · GEOMETRY VERIFIED · ACCESS UNVERIFIED');
  await expect(page.locator('#map-caption')).toContainText('U.S. Census Bureau TIGER/Line 2025');
  await page.locator('#map svg').hover({ position: { x: 100, y: 100 } });
  await page.mouse.wheel(0, -500);
  await expect(page.locator('#map svg')).not.toHaveAttribute('viewBox', '0 0 1000 700');
  await page.getByRole('button', { name: 'Fit corridor' }).click();
  await expect(page.locator('#map svg')).toHaveAttribute('viewBox', '0 0 1000 700');
  await list.getByRole('button', { name: /NW Springville Rd/ }).click();
  // Selecting another corridor resolves its own habitat analysis against the same artifacts.
  const springvilleExpectations = expectations.candidates['or-roads-springville-rd'];
  await expect(habitat).toContainText(`${springvilleExpectations.hydrography.crossingCount} documented geometric crossings`, { timeout: 60000 });
  await expect(habitat).toContainText(`${(springvilleExpectations.wetlands.buffers['250'].areaM2 / 10000).toFixed(2)} ha`);
  await expect(page.locator('#map svg .habitat-buffer')).toHaveCount(0);
  await expect(page.locator('#map svg .road')).toHaveCount(1);
  await expect(page.locator('#map svg .road-faint')).toHaveCount(2);
  await expect(detail).toContainText('GEOMETRY PARTIAL');
  await expect(detail).toContainText('unresolved gap between parts — kept visible, not bridged');
  await expect(page.locator('#map-caption')).toContainText('246 m source gap shown, not bridged');
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(detail).toContainText('rejected');
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const api = await page.evaluate(async () => {
    const { gis } = await import('/src/app/main.js');
    const road = await gis.queryRoads({ roadIds: ['tiger-2025-or-41067-nw-susbauer-rd'] });
    const missing = await gis.queryRoads({ roadIds: ['tiger-2025-or-99999-not-a-road'] });
    // NW Springville Rd is one corridor composed of two county road records, exactly as the
    // candidate layer composes it.
    const springville = await gis.queryRoads({ roadIds: ['tiger-2025-or-41067-nw-springville-rd', 'tiger-2025-or-41051-nw-springville-rd'] });
    const geometry = { type: 'MultiLineString', coordinates: springville.features.map(row => row.geometry.coordinates) };
    const ecology = await gis.getEcoregions(geometry);
    const habitat = await gis.getHabitatContext(geometry);
    const outside = await gis.queryWetlands({ type: 'MultiLineString', coordinates: [[[-117.5, 44.0], [-117.4, 44.1]]] });
    const overlay = await gis.getHabitatOverlay(geometry);
    return {
      road: { coverage: road.coverage, features: road.features.length, bytes: road.diagnostics.datasetBytes, queryMs: road.diagnostics.queryMs },
      missing: { coverage: missing.coverage, missing: missing.missingRoadIds, note: missing.note },
      ecology: { coverage: ecology.coverage, l3: ecology.level3.primary, l4: ecology.level4.primary, spansMultiple: ecology.spansMultiple, queryMs: ecology.diagnostics.queryMs },
      habitat: {
        wetlands: { coverage: habitat.wetlands.coverage, nearestDistanceM: habitat.wetlands.nearestDistanceM,
          intersectsCorridor: habitat.wetlands.intersectsCorridor,
          buffers: Object.fromEntries(Object.entries(habitat.wetlands.buffers).map(([distance, entry]) => [distance, { areaM2: entry.areaM2, featureCount: entry.featureCount, classes: entry.breakdown.map(item => item.label) }])),
          digest: habitat.provenance.wetlands.datasetDigest, measureCrs: habitat.provenance.wetlands.measureCrs,
          coverageExtent: habitat.provenance.wetlands.coverageExtent,
          classDistanceM: habitat.wetlands.classDistanceM,
          classes: habitat.wetlands.classes.map(item => ({ label: item.label, code: item.code, areaM2: item.areaM2, featureCount: item.featureCount })) },
        hydrography: { coverage: habitat.hydrography.coverage, crossingCount: habitat.hydrography.crossingCount,
          crossings: habitat.hydrography.crossings.map(crossing => crossing.name),
          nearestFlowingWaterM: habitat.hydrography.nearestFlowingWaterM, nearestStandingWaterM: habitat.hydrography.nearestStandingWaterM,
          buffers: Object.fromEntries(Object.entries(habitat.hydrography.buffers).map(([distance, entry]) => [distance, { flowlineLengthM: entry.lengthM, waterbodyAreaM2: entry.areaM2 }])),
          digest: habitat.provenance.hydrography.datasetDigest, productStatus: habitat.provenance.hydrography.productStatus },
        queryMs: habitat.diagnostics.queryMs,
      },
      outside: { coverage: outside.coverage, reason: outside.reason, note: outside.note, buffers: Object.fromEntries(Object.entries(outside.buffers).map(([distance, entry]) => [distance, entry.areaM2])) },
      overlay: { features: overlay.features.length, hasBuffer: Boolean(overlay.bufferGeometry), layers: [...new Set(overlay.features.map(feature => feature.layer))].sort() },
      diagnostics: gis.diagnostics(),
    };
  });
  expect(api.road.coverage).toBe('FULL');
  expect(api.road.features).toBe(1);
  expect(api.road.bytes).toBe(28918);
  expect(api.missing.coverage).toBe('NONE');
  expect(api.missing.missing).toEqual(['tiger-2025-or-99999-not-a-road']);
  expect(api.missing.note).toContain('not evidence about the road network on the ground');
  expect(api.ecology.coverage).toBe('FULL');
  expect(api.ecology.l3.name).toBe('Willamette Valley');
  expect(api.ecology.spansMultiple).toBe(true);
  expect(api.diagnostics.status).toBe('ready');
  expect(api.diagnostics.spatial).toBe('loaded');
  expect(api.diagnostics.datasets).toContain('or-roads-pilot');
  expect(api.diagnostics.roadDatasetBytes).toBe(28918);
  // Habitat: the browser GIS layer must reproduce the deterministic Python-side expectations.
  const expected = expectations.candidates['or-roads-springville-rd'];
  expect(api.habitat.wetlands.coverage).toBe(expected.wetlands.coverage);
  expect(api.habitat.hydrography.coverage).toBe(expected.hydrography.coverage);
  expect(api.habitat.wetlands.digest).toBe(manifest.datasets.find(dataset => dataset.id === 'nwi-wetlands-or-pilot').sha256);
  expect(api.habitat.hydrography.digest).toBe(manifest.datasets.find(dataset => dataset.id === 'nhd-hydrography-or-pilot').sha256);
  expect(api.habitat.wetlands.measureCrs).toBe('EPSG:5070');
  expect(api.habitat.wetlands.coverageExtent).toEqual(expected.window ?? manifest.datasets.find(dataset => dataset.id === 'nwi-wetlands-or-pilot').scope.bbox);
  expect(api.habitat.wetlands.intersectsCorridor).toBe(expected.wetlands.intersectsCorridor);
  expect(api.habitat.hydrography.crossingCount).toBe(expected.hydrography.crossingCount);
  expect(api.habitat.hydrography.productStatus).toContain('retired on 2023-10-01');
  const close = (actual, target) => expect(Math.abs(actual - target) / Math.max(target, 1)).toBeLessThan(0.005);
  for (const distance of ['250', '500', '1000']) {
    close(api.habitat.wetlands.buffers[distance].areaM2, expected.wetlands.buffers[distance].areaM2);
    expect(api.habitat.wetlands.buffers[distance].featureCount).toBe(expected.wetlands.buffers[distance].featureCount);
    close(api.habitat.hydrography.buffers[distance].flowlineLengthM, expected.hydrography.buffers[distance].flowlineLengthM);
    close(api.habitat.hydrography.buffers[distance].waterbodyAreaM2, expected.hydrography.buffers[distance].waterbodyAreaM2);
  }
  // The class inventory is reported for the widest requested buffer only, so nested buffers cannot
  // count the same wetland twice.
  const springvilleWetlands = expected.wetlands;
  expect(api.habitat.wetlands.classDistanceM).toBe(1000);
  expect(api.habitat.wetlands.classes.map(item => item.label)).toEqual(springvilleWetlands.buffers['1000'].classes.map(item => item.wetlandType));
  const classAreas = api.habitat.wetlands.classes.map(item => item.areaM2);
  const expectedClassAreas = springvilleWetlands.buffers['1000'].classes.map(item => item.areaM2);
  classAreas.forEach((area, index) => expect(Math.abs(area - expectedClassAreas[index]) / expectedClassAreas[index]).toBeLessThan(0.005));
  expect(classAreas.reduce((total, area) => total + area, 0)).toBeLessThan(springvilleWetlands.buffers['1000'].areaM2 * 1.01);
  // A corridor outside the extract is NONE with no zero-filled metrics, never a confident zero.
  expect(api.outside.coverage).toBe('NONE');
  expect(api.outside.note).toContain('unknown here, not zero');
  expect(Object.values(api.outside.buffers).every(area => area === 0)).toBe(true);
  // The habitat overlay is a bounded, toggle-only layer set.
  expect(api.overlay.hasBuffer).toBe(true);
  expect(api.overlay.layers).toEqual(['flowline', 'wetland']);
  expect(api.overlay.features).toBeGreaterThan(0);
  expect(api.overlay.features).toBeLessThanOrEqual(800);
  expect(api.diagnostics.habitatDatasetBytes['nwi-wetlands-or-pilot']).toBe(3385175);
  expect(api.diagnostics.habitatDatasetBytes['nhd-hydrography-or-pilot']).toBe(5187442);
  expect(api.diagnostics.firstHabitatQueryMs).toBeGreaterThan(0);
  console.log('Road pilot GIS performance:', api);
});
