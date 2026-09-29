import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

// Capture the real regional batch-versus-detailed comparison into a committed fixture.
//
//     RUN_REGIONAL_EQUIVALENCE_CAPTURE=1 npx playwright test tests/regional-equivalence.capture.spec.js
//
// The capture runs one real partitioned discovery survey, samples corridors by fixed rules (urban, rural,
// cell-seam crossing, multi-cell named road, analytically repaired, wetland-heavy, wetland-light,
// hydrography-heavy, a FULL corridor nearest the published edge, and a PARTIAL one), and records for every
// sampled corridor: the corridor and its composed unit geometry as they really are, the survey's own metric
// block, the detailed panel's metrics for the corridor geometry, the detailed metrics for the *unit*
// geometry (which is what promotion used to measure, so the original failure stays reproducible), the
// promoted candidate's road geometry, coverage per distance, and per-feature clipped areas for two of them.
const OUT = process.env.EQUIVALENCE_FIXTURE ?? 'tests/fixtures/regional-equivalence.json';
const AREA = { id: 'or-portland-west-regional', name: 'Portland west region (partitioned)',
  catalogUrl: 'regional/manifest.json', bbox: [-123.14, 45.48, -122.70, 45.71] };
// A strip that touches the published window's south-west corner, where TIGER roads really do come within a
// kilometre of the boundary (measured: 248 features near the west edge and 386 near the south edge). A
// corridor there carries a PARTIAL habitat buffer, which the equivalence check must treat as PARTIAL
// coverage rather than as a metric difference.
const EDGE_AREA = { id: 'regional-coast-edge-capture', name: 'Published south-west edge strip (capture only)',
  catalogUrl: 'regional/manifest.json', bbox: [-124.05, 44.75, -123.90, 44.88] };

const AREA_COUNT = JSON.parse(readFileSync(new URL('../data/discovery/search-areas.json', import.meta.url)))
  .searchAreas.find(area => area.id === AREA.id);

test.skip(!process.env.RUN_REGIONAL_EQUIVALENCE_CAPTURE,
  'The regional equivalence capture is opt-in: it runs a real partitioned survey in a browser');

test('capture the regional batch-versus-detailed habitat comparison', async ({ page }) => {
  test.setTimeout(1800000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  const report = await page.evaluate(async ({ area, edgeArea }) => {
    const { gis } = await import('/src/app/main.js');
    const { runDiscovery } = await import('/src/discovery/run.js');
    const { promoteDiscoveryResult } = await import('/src/discovery/lifecycle.js');
    const { HABITAT_METRIC_DEFINITION, clippedAreaExpression, featureCountExpression } = await import('/src/gis/habitat-metrics.js');
    const { corridorGeometry } = await import('/src/domain/geometry.js');
    const searchArea = { ...area, kind: 'bbox', raw: true };
    const run = await runDiscovery({ gis, searchArea });
    const regionalScope = gis.lastRegionalScope;
    // A second survey along the published north edge, so the sample also carries corridors whose 1 km buffer
    // leaves the published window: those report PARTIAL habitat coverage, and PARTIAL must be compared as
    // PARTIAL rather than as a metric difference.
    const edgeRun = await runDiscovery({ gis, searchArea: { ...edgeArea, kind: 'bbox', raw: true } });
    const edgeScope = gis.lastRegionalScope;
    // Every corridor must be measured through the scope whose partition selection contains it: the two
    // surveys selected different cells, and a corridor outside a scope's selection is not covered by it.
    const inRegional = id => run.results.some(item => item.id === id);
    const scopeFor = id => (inRegional(id) ? regionalScope : edgeScope);
    const engine = await gis.initialize();
    const catalog = await (await fetch('data/regional/manifest.json')).json();
    const results = run.results;
    // The PARTIAL rule samples from the edge survey, so both surveys are searched for a corridor id.
    const corridorOf = id => [...run.raw.corridors, ...edgeRun.raw.corridors]
      .find(entry => entry.corridor.id === id)?.corridor;
    const unitOfAny = id => run.raw.units.find(unit => unit.id === id) ?? edgeRun.raw.units.find(unit => unit.id === id);
    const round = value => Math.round(Number(value) * 1e6) / 1e6;
    const roundGeometry = geometry => geometry.type === 'LineString'
      ? { type: 'LineString', coordinates: geometry.coordinates.map(point => [round(point[0]), round(point[1])]) }
      : { type: geometry.type, coordinates: geometry.coordinates.map(line => line.map(point => [round(point[0]), round(point[1])])) };

    // Fixed, deterministic sample rules. Each corridor is recorded once, with the rule that chose it.
    const cellSeam = bounds => Math.floor(bounds[0] / 0.2) !== Math.floor(bounds[2] / 0.2)
      || Math.floor(bounds[1] / 0.2) !== Math.floor(bounds[3] / 0.2);
    const published = regionalScope.selection.publishedBounds;
    const marginDeg = bounds => Math.min(bounds[0] - published[0], bounds[1] - published[1],
      published[2] - bounds[2], published[3] - bounds[3]);
    const full = results.filter(result => result.signals.wetlands.coverage === 'FULL');
    const rules = [
      ['segmented FULL corridor', () => full.find(result => result.road.segmentation.count > 1)],
      ['analytically repaired corridor', () => results.find(result => run.diagnostics.batch.repairedCorridors.includes(result.id))],
      ['single-segment FULL corridor', () => full.find(result => result.road.segmentation.count === 1)],
      ['wetland-heavy FULL corridor', () => [...full].sort((a, b) => b.signals.wetlands.area1000M2 - a.signals.wetlands.area1000M2)[0]],
      ['wetland-light FULL corridor', () => [...full].filter(result => result.signals.wetlands.area1000M2 > 0)
        .sort((a, b) => a.signals.wetlands.area1000M2 - b.signals.wetlands.area1000M2)[0]],
      ['hydrography-heavy FULL corridor', () => [...full].sort((a, b) => b.signals.hydrography.flowlineLength1000M - a.signals.hydrography.flowlineLength1000M)[0]],
      ['cell-seam crossing FULL corridor', () => full.find(result => cellSeam(result.bounds))],
      ['multi-cell named road', () => full.find(result => unitOfAny(result.unitId)?.bounds
        && cellSeam(unitOfAny(result.unitId).bounds))],
      ['FULL corridor nearest the published edge', () => [...full].sort((a, b) => marginDeg(a.bounds) - marginDeg(b.bounds))[0]],
      ['PARTIAL-coverage corridor', () => edgeRun.results.find(result => result.signals.wetlands.coverage === 'PARTIAL')],
    ];
    const picked = new Map();
    for (const [rule, pick] of rules) {
      const result = pick();
      if (result && ![...run.results, ...edgeRun.results].some(item => item.id === result.id)) continue;
      if (!result || picked.has(result.id)) continue;
      picked.set(result.id, { rule, result });
    }

    const metricsOf = block => block ? {
      coverage: block.coverage, coverageByDistance: block.coverageByDistance ?? null,
      nearestM: block.nearestDistanceM ?? null, intersectsCorridor: block.intersectsCorridor ?? null,
      buffers: Object.fromEntries(Object.entries(block.buffers ?? {}).map(([distance, entry]) =>
        [distance, { areaM2: entry.areaM2, featureCount: entry.featureCount }])),
      provenance: { datasetId: block.provenance?.datasetId ?? null, datasetVersion: block.provenance?.datasetVersion ?? null,
        partitions: (block.provenance?.partitions ?? []).length, measureCrs: block.provenance?.measureCrs ?? null },
    } : null;

    // One set-oriented batch for the whole sample: the same code path the survey uses, so the recorded
    // batch block is the batch's own answer for that corridor and not a per-corridor special case.
    const batchBlocks = {};
    for (const [atScope, ids] of [[regionalScope, [...picked.keys()].filter(inRegional)],
      [edgeScope, [...picked.keys()].filter(id => !inRegional(id))]]) {
      if (!ids.length) continue;
      const blocks = (await atScope.analyzeDiscovery(ids.map(id => ({ id, geometry: corridorOf(id).geometry })), {})).corridors;
      Object.assign(batchBlocks, blocks);
    }
    const sample = [];
    for (const [id, { rule, result }] of picked) {
      const corridor = corridorOf(id);
      const unit = unitOfAny(result.unitId);
      const single = batchBlocks[id];
      const detailedCorridor = await scopeFor(id).getHabitatContext(corridor.geometry, { corridorId: id });
      const detailedUnit = await scopeFor(id).getHabitatContext(unit.geometry, { corridorId: `${unit.id}-unit` });
      // Ecology is a separate query family (line/polygon overlap against the ecoregion union), so the capture
      // records its detailed answer beside the batch's for the same corridor geometry.
      const detailedEcology = await gis.getEcoregions(corridor.geometry);
      // The shared analytical-geometry boundary decides the geometry for analysis: the per-feature stage must
      // use the same representation the batch and the detailed panel measured, not the canonical geometry
      // (which the engine may legitimately refuse to buffer, which is what the repair ladder is for).
      const analytical = await gis.prepareAnalyticalGeometry({ id, geometry: corridor.geometry, distancesM: [250, 500, 1000] });
      const analyticalWkt = analytical.wkt ?? null;
      // Promotion needs the source features of the corridor's own survey: the two surveys loaded
      // different road cells, so the features of one cannot promote a corridor from the other.
      const candidate = promoteDiscoveryResult(result,
        { features: (inRegional(id) ? run : edgeRun).raw.features, corridor });
      const road = candidate.roads[0];
      const corridorDigest = JSON.stringify(corridorGeometry(corridor.geometry).geometry);
      const roadDigest = JSON.stringify(corridorGeometry(road.geometry).geometry);
      // Per-feature clipped areas for the two corridors that carry the original failure: the batch's own
      // expressions, grouped by source feature instead of summed, so the per-feature stage is recorded too.
      const perFeature = analyticalWkt && (sample.length < 2 || result.road.segmentation.count > 1) ? await (async () => {
        const entry = (await scopeFor(id).datasetRowCounts()).wetlands;
        const table = entry.readExpression;
        const wkt = () => analyticalWkt;
        const rows = (await engine.conn.query(`
          WITH road AS (SELECT ST_Transform(ST_GeomFromText('${wkt()}'), 'EPSG:4326', 'EPSG:5070', always_xy := true) AS g),
          d(distance_m) AS (VALUES (250), (500), (1000))
          SELECT wetland.source_feature_id AS id, d.distance_m AS distance_m,
                 ${clippedAreaExpression("ST_Transform(wetland.geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true)", 'ST_Buffer((SELECT g FROM road), d.distance_m)')} AS area_m2
          FROM ${table} AS wetland, d
          WHERE ST_Intersects(ST_Transform(wetland.geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true), ST_Buffer((SELECT g FROM road), d.distance_m))
          ORDER BY wetland.source_feature_id, d.distance_m`)).toArray()
          .map(row => ({ id: String(row.id), distanceM: Number(row.distance_m), areaM2: Math.round(Number(row.area_m2) * 1000) / 1000 }));
        const overlaps = (await engine.conn.query(`
          WITH road AS (SELECT ST_Transform(ST_GeomFromText('${wkt()}'), 'EPSG:4326', 'EPSG:5070', always_xy := true) AS g),
          nearby AS (SELECT source_feature_id, ST_Transform(wetland.geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom,
                            min_lon, min_lat, max_lon, max_lat
                     FROM ${table} AS wetland
                     WHERE ST_Intersects(ST_Transform(wetland.geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true), ST_Buffer((SELECT g FROM road), 1000)))
          SELECT count(*) AS pairs FROM nearby a JOIN nearby b
            ON a.source_feature_id < b.source_feature_id
           AND a.min_lon <= b.max_lon AND a.max_lon >= b.min_lon AND a.min_lat <= b.max_lat AND a.max_lat >= b.min_lat
           AND ST_Overlaps(a.geom, b.geom)`)).toArray()[0];
        return { analyticalWkt, rows, overlappingFeaturePairsWithin1000M: Number(overlaps.pairs),
          sums: [250, 500, 1000].map(distance => Math.round(rows.filter(row => row.distanceM === distance)
            .reduce((total, row) => total + row.areaM2, 0) * 1000) / 1000) };
      })() : null;
      sample.push({
        rule, id, name: result.name, unitId: result.unitId, segmentation: result.road.segmentation,
        corridor: { lengthM: result.lengthM, bounds: result.bounds, geometry: roundGeometry(corridor.geometry),
          vertexCount: corridorGeometry(corridor.geometry).geometry.coordinates.flat().length },
        unit: { lengthM: unit.lengthM, bounds: unit.bounds, geometry: roundGeometry(unit.geometry),
          vertexCount: corridorGeometry(unit.geometry).geometry.coordinates.flat().length },
        survey: inRegional(id) ? 'regional area' : 'published edge strip',
        runSignals: { wetlands: { area250M2: result.signals.wetlands.area250M2, area500M2: result.signals.wetlands.area500M2,
          area1000M2: result.signals.wetlands.area1000M2, featureCount250: result.signals.wetlands.featureCount250,
          featureCount1000: result.signals.wetlands.featureCount1000, coverage: result.signals.wetlands.coverage },
        hydrography: { flowlineLength1000M: result.signals.hydrography.flowlineLength1000M,
          waterbodyArea1000M: result.signals.hydrography.waterbodyArea1000M, coverage: result.signals.hydrography.coverage } },
        batch: metricsOf(single.wetlands),
        detailedCorridor: metricsOf(detailedCorridor.wetlands),
        detailedUnit: metricsOf(detailedUnit.wetlands),
        hydrography: { batch: metricsOf(single.hydrography), detailed: metricsOf(detailedCorridor.hydrography) },
        ecology: {
          batch: single.ecology ? { coverage: single.ecology.coverage, level3: single.ecology.level3, level4: single.ecology.level4 } : null,
          detailed: { coverage: detailedEcology.coverage, level3: detailedEcology.level3, level4: detailedEcology.level4 },
        },
        geometryForAnalysis: { batch: single.geometryForAnalysis ?? null, detailed: detailedCorridor.geometryForAnalysis ?? null },
        promoted: { roadLengthM: road.lengthM, roadBounds: road.bounds, matchesCorridorGeometry: roadDigest === corridorDigest,
          corridorSegment: road.evidence.geometry.corridorSegment,
          roadGeometry: roundGeometry(road.geometry), sourceFeatureIds: [...road.sourceFeatureIds] },
        publishedMarginDeg: marginDeg(result.bounds),
        perFeature,
        analytical: { usable: analytical.usable, repaired: analytical.repaired, method: analytical.repairMethod,
          displacementM: analytical.geometryForAnalysis?.displacementM ?? null, wkt: analyticalWkt },
      });
    }
    return { catalogVersion: catalog.version, catalogAssetBaseUrl: catalog.assetBaseUrl,
      searchArea, corridorCount: results.length, runCoverage: run.coverage.coverage,
      publication: { version: catalog.version, region: catalog.region.bounds },
      datasetVersions: Object.fromEntries(catalog.datasets.map(dataset => [dataset.id,
        { version: dataset.version, featureCount: dataset.featureCount, cells: dataset.partitions.length }])),
      partitionsSelected: regionalScope.selection.counts, partitionBytes: regionalScope.selection.bytes,
      edgeSurvey: { bbox: edgeArea.bbox, corridors: edgeRun.results.length, coverage: edgeRun.coverage.coverage,
        partitions: edgeScope.selection.counts, bytes: edgeScope.selection.bytes },
      repairedCorridors: [...run.diagnostics.batch.repairedCorridors], semantics: HABITAT_METRIC_DEFINITION, sample };
  }, { area: { ...AREA, bbox: AREA_COUNT.bbox }, edgeArea: EDGE_AREA });
  expect(pageErrors).toEqual([]);
  writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
  console.log('REGIONAL_EQUIVALENCE_CAPTURE ' + JSON.stringify({ out: OUT, corridors: report.corridorCount,
    sample: report.sample.length, partitions: report.partitionsSelected, bytes: report.partitionBytes }));
});
