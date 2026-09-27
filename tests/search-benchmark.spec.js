import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Interactive search benchmark: the committed reference radii on the committed centre, measured through the
// *generalized* input an arbitrary search uses (a validated search definition -> an ordinary radius search
// area) rather than through a declared scenario. It measures the parts a person waits for - centre/radius
// parsing, cell selection, transfer and verification, the derived query, the bounded table and the map - so a
// regression in the new input path shows up as a number rather than as a feeling.
//
//   RUN_SEARCH_BENCHMARK=1 npx playwright test tests/search-benchmark.spec.js --reporter=line --retries=0
const SCENARIOS = JSON.parse(readFileSync(new URL('../data/regional/benchmarks.json', import.meta.url))).scenarios;

test.skip(!process.env.RUN_SEARCH_BENCHMARK, 'The interactive benchmark is opt-in: it measures real radius searches in a browser');

test('benchmark interactive searches at the committed reference radii', async ({ page }) => {
  test.setTimeout(2400000);
  const failures = [];
  const external = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => {
    const host = new URL(request.url()).hostname;
    if (/(^|\.)(inaturalist\.org|ebird\.org|workers\.dev)$/.test(host) || host.includes('overpass')) external.push(request.url());
  });
  for (const scenario of SCENARIOS) {
    // One page per scenario, as the committed benchmark does: its cold pass pays the engine initialisation,
    // so the number is comparable with the published baseline.
    await page.goto('/');
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    const entry = await page.evaluate(async scenario => {
      const classify = ms => ms <= 10000 ? 'COMFORTABLE' : ms <= 25000 ? 'USABLE' : ms <= 45000 ? 'SLOW' : 'UNSUITABLE';
      const { gis } = await import('/src/app/main.js');
      const { runDiscovery } = await import('/src/discovery/run.js');
      const { renderDiscovery } = await import('/src/ui/discovery.js');
      const { createCorridorMap } = await import('/src/map/corridor-map.js');
      const { searchDefinitionOf, createInteractiveSearchArea, radiusTemplate, readSearchDefinition } = await import('/src/discovery/search-definition.js');
      const { validateSearchAreas } = await import('/src/discovery/search-area.js');
      const { DEFAULT_FILTERS } = await import('/src/discovery/filter.js');
      const declaration = validateSearchAreas(await (await fetch('data/discovery/search-areas.json')).json(),
        await (await fetch('data/manifest.json')).json());
      const template = radiusTemplate(declaration);
      const passes = [];
      for (const pass of ['cold', 'warm']) {
        // The input path an arbitrary search takes: read a centre and a radius, validate them, then build the
        // ordinary radius search area the run consumes.
        const parseStarted = performance.now();
        const parsed = readSearchDefinition({ lat: scenario.center[1], lon: scenario.center[0], radiusMiles: scenario.radiusMiles },
          { region: declaration.publishedRegion });
        if (!parsed.ok) throw new Error(parsed.problems.map(problem => problem.message).join(' '));
        const definition = searchDefinitionOf(scenario.center, scenario.radiusMiles);
        const searchArea = createInteractiveSearchArea(definition, { template });
        const parseMs = Math.round((performance.now() - parseStarted) * 1000) / 1000;
        const started = performance.now();
        const run = await runDiscovery({ gis, searchArea });
        const discoveryMs = Math.round(performance.now() - started);
        const timing = run.diagnostics.derivedTimingMs ?? {};
        const selection = run.diagnostics.derivedSelection ?? { cells: {}, bytes: 0 };
        const table = document.createElement('div');
        const renderStarted = performance.now();
        renderDiscovery(table, { discovery: { ...run, filters: DEFAULT_FILTERS, sort: 'wetlandArea250', selectedId: null },
          searchAreas: declaration.searchAreas, searchAreaId: searchArea.id,
          search: { areaId: searchArea.id, definition, picking: false, history: [], error: null },
          presets: declaration.searchAreas.filter(area => area.kind === 'radius'), region: declaration.publishedRegion });
        const renderMs = Math.round(performance.now() - renderStarted);
        const mapContainer = document.createElement('div');
        const map = createCorridorMap(mapContainer, {});
        const mapStarted = performance.now();
        map.setSearchPreview({ kind: 'radius', center: definition.center, radiusMiles: definition.radiusMiles,
          bounds: definition.bounds, coverage: run.coverage.coverage, regionBounds: declaration.publishedRegion.bounds,
          label: `${scenario.radiusMiles} mi` });
        map.draw({ corridors: [], selectedId: null, discovery: { corridors: run.results.slice(0, 400).map(result => ({
          id: result.id, name: result.name, geometry: result.geometry })), selectedId: null, promotedIds: [] } });
        const mapMs = Math.round(performance.now() - mapStarted);
        passes.push({ pass, parseMs, manifestMs: timing.manifestMs ?? null, fetchMs: timing.fetchMs ?? null,
          verifyMs: timing.verifyMs ?? null, selectionMs: run.diagnostics.selectionMs ?? null,
          queryMs: run.diagnostics.queryMs ?? null, buildMs: run.diagnostics.buildMs ?? null,
          totalMs: run.diagnostics.totalMs ?? discoveryMs, discoveryMs, renderMs, mapMs,
          cellsSelected: selection.cells?.cells ?? null, cellsPresent: selection.cells?.present ?? null,
          cellsEmpty: selection.cells?.empty ?? null, selectedBytes: selection.bytes ?? 0,
          transferredBytes: timing.downloadedBytes ?? null, cacheHits: timing.cacheHits ?? null,
          corridors: run.results.length, coverage: run.coverage.coverage, classification: classify(discoveryMs) });
      }
      return { id: scenario.id, label: scenario.label, radiusMiles: scenario.radiusMiles, center: scenario.center, passes };
    }, scenario);
    console.log('SEARCH_BENCHMARK ' + JSON.stringify(entry));
    expect(entry.passes[0].corridors).toBeGreaterThan(0);
    expect(entry.passes[0].classification).toBe('COMFORTABLE');
    expect(entry.passes[0].coverage).toBe('FULL');
  }
  expect(external).toEqual([]);
  expect(failures).toEqual([]);
});
