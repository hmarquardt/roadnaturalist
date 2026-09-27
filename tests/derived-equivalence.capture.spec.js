import { test, expect } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';

// Capture the real derived-versus-raw comparison into a committed fixture.
//
//     RUN_DERIVED_EQUIVALENCE_CAPTURE=1 npx playwright test tests/derived-equivalence.capture.spec.js
//
// One search box is surveyed twice in the same browser session: once through the precomputed derived cells,
// which is what browsing a regional radius uses, and once through the raw regional partitions, which remain
// authoritative. Every corridor both runs report is compared on geometry, ecology, wetlands, hydrography,
// coverage, and repair provenance. `npm run verify:derived-equivalence` then re-asserts those comparisons
// offline against the fixture, so the chain derived == batch == detailed stays checkable without a browser.
const OUT = process.env.DERIVED_EQUIVALENCE_FIXTURE ?? 'tests/fixtures/derived-equivalence.json';
const AREA = { id: 'derived-equivalence-box', name: 'Derived equivalence box',
  catalogUrl: 'regional/manifest.json', bbox: [-122.80, 45.45, -122.66, 45.60] };

test.skip(!process.env.RUN_DERIVED_EQUIVALENCE_CAPTURE,
  'The derived equivalence capture is opt-in: it runs a real derived and raw survey in a browser');

test('capture the derived-versus-raw corridor comparison', async ({ page }) => {
  test.setTimeout(2400000);
  // Equivalence is a pre-publication gate. Serve the newly built immutable objects from disk at the
  // production data origin so this capture proves the exact bytes that will be uploaded.
  await page.route('https://data.roadnaturalist.com/derived/corridor-metrics/**', route => {
    const key = new URL(route.request().url()).pathname.slice(1);
    if (!/^derived\/corridor-metrics\/[a-f0-9]{64}\/(manifest\.json|cells\/x\d+_y\d+\.parquet)$/.test(key)) {
      return route.fulfill({ status: 404, body: 'unknown derived object' });
    }
    const path = new URL(`../data/${key}`, import.meta.url);
    return existsSync(path) ? route.fulfill({ path, headers: { 'access-control-allow-origin': '*',
      'content-type': key.endsWith('.json') ? 'application/json' : 'application/vnd.apache.parquet' } })
      : route.fulfill({ status: 404, body: 'missing derived object' });
  });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  const report = await page.evaluate(async area => {
    const { gis } = await import('/src/app/main.js');
    const { runDiscovery } = await import('/src/discovery/run.js');
    const { minDistanceToLineM } = await import('/src/domain/geometry.js');
    const { paddedBounds } = await import('/src/gis/habitat-result.js');
    const linesOf = geometry => geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
    const drift = (from, to) => {
      let worst = 0;
      for (const line of linesOf(from)) for (const point of line) worst = Math.max(worst, minDistanceToLineM(point, to));
      return Math.round(worst * 1000) / 1000;
    };
    const signal = result => ({
      id: result.id, name: result.name, lengthM: result.lengthM, bounds: result.bounds, geometry: result.geometry,
      segment: [result.road?.segmentation?.index ?? null, result.road?.segmentation?.count ?? null],
      sourceFeatureCount: result.road?.sourceFeatureCount ?? null,
      // The measured values the interface reads. Reading them here (rather than a `buffers` block that the
      // result builder does not expose) is what makes these comparisons real: a null-versus-null comparison
      // would pass without ever looking at a number.
      wetlands: {
        coverage: result.signals?.wetlands?.coverage ?? null,
        intersectsCorridor: result.signals?.wetlands?.intersectsCorridor ?? null,
        nearestM: result.signals?.wetlands?.nearestM ?? null,
        areas: { 250: result.signals?.wetlands?.area250M2 ?? null, 500: result.signals?.wetlands?.area500M2 ?? null,
          1000: result.signals?.wetlands?.area1000M2 ?? null },
        featureCounts: { 250: result.signals?.wetlands?.featureCount250 ?? null,
          1000: result.signals?.wetlands?.featureCount1000 ?? null },
      },
      hydrography: {
        coverage: result.signals?.hydrography?.coverage ?? null,
        crossingCount: result.signals?.hydrography?.crossingCount ?? null,
        flowlineLength1000M: result.signals?.hydrography?.flowlineLength1000M ?? null,
        waterbodyArea1000M: result.signals?.hydrography?.waterbodyArea1000M ?? null,
        nearestFlowingM: result.signals?.hydrography?.nearestFlowingM ?? null,
        nearestStandingM: result.signals?.hydrography?.nearestStandingM ?? null,
        namedWaters: result.signals?.hydrography?.namedWaters ?? null,
      },
      ecology: {
        coverage: result.ecology?.coverage ?? null,
        l3: result.ecology?.level3?.primary ? { code: result.ecology.level3.primary.code, percent: result.ecology.level3.primary.percent } : null,
        l4: result.ecology?.level4?.primary ? { code: result.ecology.level4.primary.code, percent: result.ecology.level4.primary.percent } : null,
      },
      coverage: Object.fromEntries(Object.entries(result.coverage ?? {}).map(([key, value]) => [key, value?.coverage ?? value])),
      geometryRepaired: result.provenance?.geometryForAnalysis?.repaired ?? null,
      geometryRepairMethod: result.provenance?.geometryForAnalysis?.method ?? null,
    });
    const searchArea = { ...area, kind: 'bbox' };
    const derivedRun = await runDiscovery({ gis, searchArea });
    const derivedDiagnostics = derivedRun.diagnostics;
    const rawRun = await runDiscovery({ gis, searchArea: { ...searchArea, raw: true } });
    const derived = new Map(derivedRun.results.map(result => [result.id, signal(result)]));
    const raw = new Map(rawRun.results.map(result => [result.id, signal(result)]));
    const rawCorridors = new Map(rawRun.raw.corridors.map(entry => [entry.corridor.id, entry.corridor]));
    const habitatCells = rawRun.diagnostics.partitionSelection.partitions;
    const habitatExtent = kind => {
      const cells = habitatCells[kind];
      return [Math.min(...cells.map(cell => cell.bounds[0])), Math.min(...cells.map(cell => cell.bounds[1])),
        Math.max(...cells.map(cell => cell.bounds[2])), Math.max(...cells.map(cell => cell.bounds[3]))];
    };
    const covers = (outer, inner) => outer[0] <= inner[0] && outer[1] <= inner[1]
      && outer[2] >= inner[2] && outer[3] >= inner[3];
    const comparableIds = new Set([...derived.keys()].filter(id => {
      const corridor = rawCorridors.get(id);
      if (!corridor) return false;
      const padded = paddedBounds(corridor.bounds, 1000);
      return covers(habitatExtent('wetlands'), padded) && covers(habitatExtent('hydrography'), padded);
    }));
    const divergences = [];
    const comparisons = [];
    const repairEngineDifferences = [];
    const note = (id, field, derivedValue, rawValue) => divergences.push({ id, field, derived: derivedValue, raw: rawValue });
    const close = (a, b, tolerance) => a == null || b == null ? a === b : Math.abs(a - b) <= tolerance;
    for (const [id, left] of derived) {
      const right = raw.get(id);
      if (!right || !comparableIds.has(id)) continue;
      if (!close(left.lengthM, right.lengthM, 0.5)) note(id, 'lengthM', left.lengthM, right.lengthM);
      if (left.name !== right.name) note(id, 'name', left.name, right.name);
      if (left.sourceFeatureCount !== right.sourceFeatureCount) note(id, 'sourceFeatureCount', left.sourceFeatureCount, right.sourceFeatureCount);
      // Every measured value the result exposes, at every distance it exposes. The tolerance is relative to the
      // value (a floating-point sum of clipped areas) with a one-unit floor.
      for (const distance of [250, 500, 1000]) {
        const area = { left: left.wetlands.areas[distance], right: right.wetlands.areas[distance] };
        if (!close(area.left, area.right, Math.max(1, (area.right ?? 0) * 1e-9))) note(id, `wetlandArea${distance}`, area.left, area.right);
      }
      for (const distance of [250, 1000]) {
        if (left.wetlands.featureCounts[distance] !== right.wetlands.featureCounts[distance]) {
          note(id, `wetlandCount${distance}`, left.wetlands.featureCounts[distance], right.wetlands.featureCounts[distance]);
        }
      }
      if (left.wetlands.coverage !== right.wetlands.coverage) note(id, 'wetlandCoverage', left.wetlands.coverage, right.wetlands.coverage);
      if (left.wetlands.intersectsCorridor !== right.wetlands.intersectsCorridor) note(id, 'wetlandIntersects', left.wetlands.intersectsCorridor, right.wetlands.intersectsCorridor);
      if (!close(left.wetlands.nearestM, right.wetlands.nearestM, 0.5)) note(id, 'wetlandNearest', left.wetlands.nearestM, right.wetlands.nearestM);
      if (left.hydrography.crossingCount !== right.hydrography.crossingCount) note(id, 'hydroCrossings', left.hydrography.crossingCount, right.hydrography.crossingCount);
      if (!close(left.hydrography.flowlineLength1000M, right.hydrography.flowlineLength1000M,
        Math.max(1, (right.hydrography.flowlineLength1000M ?? 0) * 1e-9))) {
        note(id, 'hydroFlowlineLength1000', left.hydrography.flowlineLength1000M, right.hydrography.flowlineLength1000M);
      }
      if (!close(left.hydrography.waterbodyArea1000M, right.hydrography.waterbodyArea1000M,
        Math.max(1, (right.hydrography.waterbodyArea1000M ?? 0) * 1e-9))) {
        note(id, 'hydroWaterbodyArea1000', left.hydrography.waterbodyArea1000M, right.hydrography.waterbodyArea1000M);
      }
      if (left.hydrography.coverage !== right.hydrography.coverage) note(id, 'hydroCoverage', left.hydrography.coverage, right.hydrography.coverage);
      if (!close(left.hydrography.nearestFlowingM, right.hydrography.nearestFlowingM, 0.5)) note(id, 'hydroFlowing', left.hydrography.nearestFlowingM, right.hydrography.nearestFlowingM);
      if (!close(left.hydrography.nearestStandingM, right.hydrography.nearestStandingM, 0.5)) note(id, 'hydroStanding', left.hydrography.nearestStandingM, right.hydrography.nearestStandingM);
      if (JSON.stringify(left.hydrography.namedWaters) !== JSON.stringify(right.hydrography.namedWaters)) {
        note(id, 'hydroNames', left.hydrography.namedWaters, right.hydrography.namedWaters);
      }
      if (left.ecology.coverage !== right.ecology.coverage) note(id, 'ecologyCoverage', left.ecology.coverage, right.ecology.coverage);
      if (left.ecology.l3?.code !== right.ecology.l3?.code) note(id, 'ecologyL3', left.ecology.l3, right.ecology.l3);
      if (left.ecology.l4?.code !== right.ecology.l4?.code) note(id, 'ecologyL4', left.ecology.l4, right.ecology.l4);
      if (!close(left.ecology.l3?.percent, right.ecology.l3?.percent, 0.2)) note(id, 'ecologyL3Percent', left.ecology.l3?.percent, right.ecology.l3?.percent);
      if (JSON.stringify(left.coverage) !== JSON.stringify(right.coverage)) note(id, 'coverage', left.coverage, right.coverage);
      if (left.geometryRepaired === true && right.geometryRepaired !== true) {
        note(id, 'geometryRepaired', left.geometryRepaired, right.geometryRepaired);
      }
      if (left.geometryRepaired === true && right.geometryRepaired === true
        && left.geometryRepairMethod !== right.geometryRepairMethod) {
        note(id, 'geometryRepairMethod', left.geometryRepairMethod, right.geometryRepairMethod);
      }
      // The other direction is recorded, not treated as a divergence: the offline build measures with the
      // native DuckDB Spatial engine and the browser runs DuckDB-WASM, and the WASM build refuses a few
      // geometries the native one buffers (it repairs them instead). The repair ladder is point-preserving, so
      // both readers measure the same line - which is exactly what the metric comparisons in this loop prove.
      if (left.geometryRepaired === false && right.geometryRepaired === true) repairEngineDifferences.push(id);
      const corridor = rawCorridors.get(id);
      if (!corridor) note(id, 'rawReconstruction', false, true);
      else if (corridor.unitId !== undefined && corridor.unitId !== null && corridor.unitId !== id.slice(0, id.lastIndexOf('-s'))) {
        note(id, 'componentIdentity', id.slice(0, id.lastIndexOf('-s')), corridor.unitId);
      }
      comparisons.push({ id, driftM: corridor ? Math.max(drift(left.geometry, corridor.geometry), drift(corridor.geometry, left.geometry)) : null,
        // Geometry equality is recorded as a measured drift. Keeping two full copies of every polyline in
        // the committed fixture would bury the actual metric evidence under megabytes of coordinates.
        derived: { ...left, geometry: undefined }, raw: { ...right, geometry: undefined } });
    }

    // The chain is derived == batch == detailed. The detailed panel measures the raw corridor geometry through
    // the raw regional habitat partitions, so it is a third reader of the same rule set. A sample of the shared
    // corridors is compared per buffer distance, and only where the derived side reports FULL coverage for that
    // distance and dataset: a PARTIAL or UNKNOWN buffer is a coverage difference, not a metric difference.
    const blockOf = block => ({
      coverage: block?.coverage ?? null,
      coverageByDistance: block?.coverageByDistance ?? null,
      buffers: Object.fromEntries(Object.entries(block?.buffers ?? {}).map(([distance, entry]) => [distance,
        { areaM2: entry.areaM2 ?? 0, lengthM: entry.lengthM ?? 0, featureCount: entry.featureCount ?? 0 }])),
    });
    const detailed = [];
    for (const id of [...comparableIds].sort().slice(0, 6)) {
      const entry = rawRun.raw.corridors.find(item => item.corridor.id === id);
      const left = derived.get(id);
      if (!entry || !left) continue;
      const detailedScope = await gis.prepareRegionalSearch({ bbox: entry.corridor.bounds,
        catalogUrl: area.catalogUrl });
      const context = await detailedScope.getHabitatContext(entry.corridor.geometry, { corridorId: id });
      const wetlands = blockOf(context.wetlands);
      const hydrography = blockOf(context.hydrography);
      // Coverage is compared at the granularity the interface reports it: a corridor-level state per dataset.
      // A distance is only compared where both readers say FULL for that dataset, because a PARTIAL or UNKNOWN
      // buffer is a coverage difference rather than a metric difference.
      const wetlandFull = left.coverage?.wetlands === 'FULL' && wetlands.coverage === 'FULL';
      const hydroFull = left.coverage?.hydrography === 'FULL' && hydrography.coverage === 'FULL';
      const comparable = [];
      for (const distance of [250, 500, 1000]) {
        if (wetlandFull) {
          const areaM2 = { derived: left.wetlands.areas[distance] ?? 0, detailed: wetlands.buffers[distance]?.areaM2 ?? 0 };
          if (!close(areaM2.derived, areaM2.detailed, Math.max(1, areaM2.detailed * 1e-9))) note(id, `detailedWetlandArea${distance}`, areaM2.derived, areaM2.detailed);
          comparable.push({ dataset: 'wetlands', distance, areaM2 });
        }
      }
      for (const distance of [250, 1000]) {
        if (wetlandFull) {
          const featureCount = { derived: left.wetlands.featureCounts[distance] ?? 0, detailed: wetlands.buffers[distance]?.featureCount ?? 0 };
          if (featureCount.derived !== featureCount.detailed) note(id, `detailedWetlandCount${distance}`, featureCount.derived, featureCount.detailed);
          comparable.push({ dataset: 'wetlands', distance, featureCount });
        }
      }
      if (hydroFull) {
        const lengthM = { derived: left.hydrography.flowlineLength1000M ?? 0, detailed: hydrography.buffers[1000]?.lengthM ?? 0 };
        if (!close(lengthM.derived, lengthM.detailed, Math.max(1, lengthM.detailed * 1e-9))) note(id, 'detailedHydroLength1000', lengthM.derived, lengthM.detailed);
        comparable.push({ dataset: 'hydrography', distance: 1000, lengthM });
      }
      detailed.push({ id, comparable, wetlands, hydrography,
        geometryForAnalysis: { derived: { repaired: left.geometryRepaired, method: left.geometryRepairMethod },
          detailed: context.geometryForAnalysis ?? null } });
    }
    // Presence. The two paths select corridors differently on purpose, and the difference is recorded rather
    // than asserted away: the derived path keeps a corridor when the corridor itself lies in the search box (and
    // crosses the requested disk), which is the rule the interface states, while the raw path keeps every
    // corridor of a composed unit whose bounds reach the search box. So a derived-only corridor must really lie
    // in the search box, and a raw-only corridor is a corridor of a selected unit that is outside it.
    const derivedOnly = [...derived.keys()].filter(id => !raw.has(id)).sort();
    const rawOnly = [...raw.keys()].filter(id => !derived.has(id)).sort();
    const outsideBox = derivedOnly.filter(id => {
      const bounds = derived.get(id).bounds;
      return !(bounds[0] <= searchArea.bbox[2] && bounds[2] >= searchArea.bbox[0]
        && bounds[1] <= searchArea.bbox[3] && bounds[3] >= searchArea.bbox[1]);
    });
    for (const id of outsideBox) note(id, 'presenceOutsideSearchBox', true, false);
    return {
      area: searchArea, capturedAt: new Date().toISOString(),
      derivedDiagnostics: { analysisFingerprint: derivedDiagnostics?.analysisFingerprint ?? null,
        selection: derivedDiagnostics?.derivedSelection ?? null, timing: derivedDiagnostics?.derivedTimingMs ?? null,
        counts: derivedDiagnostics?.counts ?? null, note: derivedDiagnostics?.note ?? null, totalMs: derivedDiagnostics?.totalMs ?? null },
      rawDiagnostics: { totalMs: rawRun.diagnostics?.totalMs ?? null, counts: rawRun.diagnostics?.counts ?? null,
        selection: rawRun.diagnostics?.partitionSelection ? { bounds: rawRun.diagnostics.partitionSelection.bounds,
          cells: rawRun.diagnostics.partitionSelection.counts, bytes: rawRun.diagnostics.partitionSelection.bytes } : null,
        benchmark: rawRun.benchmark ?? null },
      corridorCounts: { derived: derived.size, raw: raw.size, shared: comparisons.length,
        detailed: detailed.length, detailedComparable: detailed.reduce((total, entry) => total + entry.comparable.length, 0) },
      rawHabitatExtent: { wetlands: habitatExtent('wetlands'), hydrography: habitatExtent('hydrography') },
      presence: { derivedOnly: derivedOnly.length, rawOnly: rawOnly.length,
        derivedOnlyOutsideSearchBox: outsideBox.length, derivedOnlyIds: derivedOnly.slice(0, 20),
        rule: 'derived keeps a corridor inside the search region; raw keeps every corridor of a composed unit '
          + 'whose bounds reach it' },
      repairEngineDifferences, divergences, comparisons, detailed,
    };
  }, AREA);
  writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
  console.log(JSON.stringify({ corridors: report.corridorCounts, divergences: report.divergences.length,
    derivedMs: report.derivedDiagnostics.totalMs, rawMs: report.rawDiagnostics.totalMs }));
  expect(pageErrors).toEqual([]);
  expect(report.corridorCounts.derived).toBeGreaterThan(0);
  expect(report.divergences).toEqual([]);
});
