import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';

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
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 60000 });
  const report = await page.evaluate(async area => {
    const { gis } = await import('/src/app/main.js');
    const { runDiscovery } = await import('/src/discovery/run.js');
    const { minDistanceToLineM } = await import('/src/domain/geometry.js');
    const linesOf = geometry => geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
    const drift = (from, to) => {
      let worst = 0;
      for (const line of linesOf(from)) for (const point of line) worst = Math.max(worst, minDistanceToLineM(point, to));
      return Math.round(worst * 1000) / 1000;
    };
    const signal = result => ({
      id: result.id, name: result.name, lengthM: result.lengthM, bounds: result.bounds, geometry: result.geometry,
      segment: [result.road?.segmentation?.index ?? null, result.road?.segmentation?.count ?? null],
      wetlands: {
        coverage: result.signals?.wetlands?.coverage ?? null,
        coverageByDistance: result.signals?.wetlands?.coverageByDistance ?? null,
        intersectsCorridor: result.signals?.wetlands?.intersectsCorridor ?? null,
        nearestDistanceM: result.signals?.wetlands?.nearestDistanceM ?? null,
        corridorFeatureCount: result.signals?.wetlands?.corridorFeatureCount ?? null,
        buffers: Object.fromEntries(Object.entries(result.signals?.wetlands?.buffers ?? {}).map(([distance, entry]) => [distance,
          { areaM2: entry.areaM2 ?? 0, featureCount: entry.featureCount ?? 0 }])),
      },
      hydrography: {
        coverage: result.signals?.hydrography?.coverage ?? null,
        coverageByDistance: result.signals?.hydrography?.coverageByDistance ?? null,
        crossingCount: result.signals?.hydrography?.crossingCount ?? 0,
        nearestFlowingWaterM: result.signals?.hydrography?.nearestFlowingWaterM ?? null,
        nearestStandingWaterM: result.signals?.hydrography?.nearestStandingWaterM ?? null,
        buffers: Object.fromEntries(Object.entries(result.signals?.hydrography?.buffers ?? {}).map(([distance, entry]) => [distance,
          { lengthM: entry.lengthM ?? 0, areaM2: entry.areaM2 ?? 0, featureCount: entry.featureCount ?? 0 }])),
      },
      ecology: {
        coverage: result.ecology?.coverage ?? null,
        l3: result.ecology?.level3?.primary ? { code: result.ecology.level3.primary.code, percent: result.ecology.level3.primary.percent } : null,
        l4: result.ecology?.level4?.primary ? { code: result.ecology.level4.primary.code, percent: result.ecology.level4.primary.percent } : null,
      },
      coverage: Object.fromEntries(Object.entries(result.coverage ?? {}).map(([key, value]) => [key, value?.coverage ?? value])),
    });
    const searchArea = { ...area, kind: 'bbox' };
    const derivedRun = await runDiscovery({ gis, searchArea });
    const derivedDiagnostics = derivedRun.diagnostics;
    const rawRun = await runDiscovery({ gis, searchArea: { ...searchArea, raw: true } });
    const derived = new Map(derivedRun.results.map(result => [result.id, signal(result)]));
    const raw = new Map(rawRun.results.map(result => [result.id, signal(result)]));
    const rawCorridors = new Map(rawRun.raw.corridors.map(entry => [entry.corridor.id, entry.corridor]));
    const divergences = [];
    const comparisons = [];
    const note = (id, field, derivedValue, rawValue) => divergences.push({ id, field, derived: derivedValue, raw: rawValue });
    const close = (a, b, tolerance) => a == null || b == null ? a === b : Math.abs(a - b) <= tolerance;
    for (const [id, left] of derived) {
      const right = raw.get(id);
      if (!right) { note(id, 'presence', true, false); continue; }
      if (!close(left.lengthM, right.lengthM, 0.5)) note(id, 'lengthM', left.lengthM, right.lengthM);
      if (left.name !== right.name) note(id, 'name', left.name, right.name);
      for (const distance of [250, 500, 1000]) {
        if (!close(left.wetlands.buffers[distance]?.areaM2, right.wetlands.buffers[distance]?.areaM2, Math.max(1, right.wetlands.buffers[distance]?.areaM2 * 1e-9))) {
          note(id, `wetlandArea${distance}`, left.wetlands.buffers[distance]?.areaM2, right.wetlands.buffers[distance]?.areaM2);
        }
        if (left.wetlands.buffers[distance]?.featureCount !== right.wetlands.buffers[distance]?.featureCount) {
          note(id, `wetlandCount${distance}`, left.wetlands.buffers[distance]?.featureCount, right.wetlands.buffers[distance]?.featureCount);
        }
        if (!close(left.hydrography.buffers[distance]?.lengthM, right.hydrography.buffers[distance]?.lengthM, Math.max(1, right.hydrography.buffers[distance]?.lengthM * 1e-9))) {
          note(id, `hydroLength${distance}`, left.hydrography.buffers[distance]?.lengthM, right.hydrography.buffers[distance]?.lengthM);
        }
        if (left.wetlands.coverageByDistance?.[distance] !== right.wetlands.coverageByDistance?.[distance]) {
          note(id, `wetlandCoverage${distance}`, left.wetlands.coverageByDistance?.[distance], right.wetlands.coverageByDistance?.[distance]);
        }
      }
      if (left.wetlands.coverage !== right.wetlands.coverage) note(id, 'wetlandCoverage', left.wetlands.coverage, right.wetlands.coverage);
      if (left.wetlands.intersectsCorridor !== right.wetlands.intersectsCorridor) note(id, 'wetlandIntersects', left.wetlands.intersectsCorridor, right.wetlands.intersectsCorridor);
      if (!close(left.wetlands.nearestDistanceM, right.wetlands.nearestDistanceM, 0.5)) note(id, 'wetlandNearest', left.wetlands.nearestDistanceM, right.wetlands.nearestDistanceM);
      if (left.hydrography.crossingCount !== right.hydrography.crossingCount) note(id, 'hydroCrossings', left.hydrography.crossingCount, right.hydrography.crossingCount);
      if (!close(left.hydrography.nearestFlowingWaterM, right.hydrography.nearestFlowingWaterM, 0.5)) note(id, 'hydroFlowing', left.hydrography.nearestFlowingWaterM, right.hydrography.nearestFlowingWaterM);
      if (!close(left.hydrography.nearestStandingWaterM, right.hydrography.nearestStandingWaterM, 0.5)) note(id, 'hydroStanding', left.hydrography.nearestStandingWaterM, right.hydrography.nearestStandingWaterM);
      if (left.ecology.coverage !== right.ecology.coverage) note(id, 'ecologyCoverage', left.ecology.coverage, right.ecology.coverage);
      if (left.ecology.l3?.code !== right.ecology.l3?.code) note(id, 'ecologyL3', left.ecology.l3, right.ecology.l3);
      if (left.ecology.l4?.code !== right.ecology.l4?.code) note(id, 'ecologyL4', left.ecology.l4, right.ecology.l4);
      if (!close(left.ecology.l3?.percent, right.ecology.l3?.percent, 0.2)) note(id, 'ecologyL3Percent', left.ecology.l3?.percent, right.ecology.l3?.percent);
      if (JSON.stringify(left.coverage) !== JSON.stringify(right.coverage)) note(id, 'coverage', left.coverage, right.coverage);
      const corridor = rawCorridors.get(id);
      if (!corridor) note(id, 'rawReconstruction', false, true);
      else if (corridor.unitId !== undefined && corridor.unitId !== null && corridor.unitId !== id.slice(0, id.lastIndexOf('-s'))) {
        note(id, 'componentIdentity', id.slice(0, id.lastIndexOf('-s')), corridor.unitId);
      }
      comparisons.push({ id, driftM: corridor ? Math.max(drift(left.geometry, corridor.geometry), drift(corridor.geometry, left.geometry)) : null,
        derived: left, raw: right });
    }
    return {
      area: searchArea, capturedAt: new Date().toISOString(),
      derivedDiagnostics: { analysisFingerprint: derivedDiagnostics?.analysisFingerprint ?? null,
        selection: derivedDiagnostics?.derivedSelection ?? null, timing: derivedDiagnostics?.derivedTimingMs ?? null,
        counts: derivedDiagnostics?.counts ?? null, note: derivedDiagnostics?.note ?? null, totalMs: derivedDiagnostics?.totalMs ?? null },
      rawDiagnostics: { totalMs: rawRun.diagnostics?.totalMs ?? null, counts: rawRun.diagnostics?.counts ?? null,
        selection: rawRun.diagnostics?.partitionSelection ? { bounds: rawRun.diagnostics.partitionSelection.bounds,
          cells: rawRun.diagnostics.partitionSelection.counts, bytes: rawRun.diagnostics.partitionSelection.bytes } : null,
        benchmark: rawRun.benchmark ?? null },
      corridorCounts: { derived: derived.size, raw: raw.size, shared: comparisons.length },
      divergences, comparisons,
    };
  }, AREA);
  writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
  console.log(JSON.stringify({ corridors: report.corridorCounts, divergences: report.divergences.length,
    derivedMs: report.derivedDiagnostics.totalMs, rawMs: report.rawDiagnostics.totalMs }));
  expect(pageErrors).toEqual([]);
  expect(report.corridorCounts.derived).toBeGreaterThan(0);
  expect(report.divergences).toEqual([]);
});
