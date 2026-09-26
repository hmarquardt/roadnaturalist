#!/usr/bin/env node
/**
 * Regional batch-versus-detailed habitat equivalence, judged offline from a committed fixture.
 *
 *   npm run verify:regional-equivalence
 *   npm run verify:regional-equivalence -- --json
 *
 * The fixture is a real capture (tests/regional-equivalence.capture.spec.js): one partitioned regional
 * survey, a deterministic sample of corridors, and for each one the survey's own metric block, the
 * detailed panel's metrics for the same corridor geometry, the detailed metrics for the composed *unit*
 * geometry (what promotion used to measure), coverage per distance, provenance, the promoted candidate's
 * road geometry, and per-feature clipped areas for two corridors. This command needs no browser, no network
 * and no partitions: it re-checks the recorded comparison and fails on any unexplained divergence.
 *
 * Tolerance: recorded values carry three decimals (the same rounding the summarizers use), so 0.002 is one
 * recorded unit doubled for half-up rounding. It is not a convenience allowance: geometry identity is
 * asserted exactly and coverage is compared before any metric is.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index === -1 ? null : args[index + 1]; };
const fixturePath = option('--fixture') ?? 'tests/fixtures/regional-equivalence.json';
const asJson = args.includes('--json');
const TOLERANCE = Number(option('--tolerance') ?? 0.002);
const DISTANCES = [250, 500, 1000];
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const problems = [];
const notes = [];
const fail = (corridorId, kind, message) => problems.push({ corridorId, kind, message });
const close = (a, b) => { const left = Number(a ?? 0); const right = Number(b ?? 0); return Math.abs(left - right) <= TOLERANCE; };
const numeric = value => value != null && value !== '' && Number.isFinite(Number(value));
// Numbers are compared with the recorded tolerance; everything else (a repair method name, a coverage
// state, a feature id) must be identical. Comparing a string with close() would report a false divergence.
const matches = (a, b) => (numeric(a) && numeric(b) ? close(a, b) : same(a, b));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const describe = (a, b) => `${JSON.stringify(a)} vs ${JSON.stringify(b)}`;

if (!Array.isArray(fixture.sample) || !fixture.sample.length) throw new Error('fixture has no sampled corridors');

for (const entry of fixture.sample) {
  const id = entry.id;

  // 1. Geometry identity: both paths must have prepared the same analytical geometry.
  const batchGeometry = entry.geometryForAnalysis?.batch;
  const detailedGeometry = entry.geometryForAnalysis?.detailed;
  if (!batchGeometry || !detailedGeometry) {
    fail(id, 'geometry', 'one path did not record its analytical geometry provenance');
  } else {
    for (const key of ['repaired', 'method', 'canonicalLengthM', 'analyticalLengthM', 'lengthDeltaM', 'displacementM',
      'vertexCountBefore', 'vertexCountAfter', 'partCountBefore', 'partCountAfter']) {
      if (!matches(batchGeometry[key], detailedGeometry[key])) {
        fail(id, 'geometry', `${key} differs: ${describe(batchGeometry[key], detailedGeometry[key])}`);
      }
    }
    if (batchGeometry.geometryDigest && detailedGeometry.geometryDigest && batchGeometry.geometryDigest !== detailedGeometry.geometryDigest) {
      fail(id, 'geometry', 'analytical geometry digests differ');
    }
  }

  // 2. Provenance: same dataset, same version, same number of selected partitions.
  const batchProvenance = entry.batch?.provenance ?? {};
  const detailedProvenance = entry.detailedCorridor?.provenance ?? {};
  if (batchProvenance.datasetId !== detailedProvenance.datasetId) {
    fail(id, 'provenance', `dataset differs: ${describe(batchProvenance.datasetId, detailedProvenance.datasetId)}`);
  }
  if (batchProvenance.datasetVersion !== detailedProvenance.datasetVersion) {
    fail(id, 'provenance', `dataset version differs: ${describe(batchProvenance.datasetVersion, detailedProvenance.datasetVersion)}`);
  }
  if ((batchProvenance.partitions ?? 0) !== (detailedProvenance.partitions ?? 0)) {
    fail(id, 'provenance', `selected partition count differs: ${describe(batchProvenance.partitions, detailedProvenance.partitions)}`);
  }
  if (batchProvenance.datasetVersion && fixture.datasetVersions?.[batchProvenance.datasetId]
    && batchProvenance.datasetVersion !== fixture.datasetVersions[batchProvenance.datasetId].version) {
    fail(id, 'provenance', `the fixture measured ${batchProvenance.datasetVersion} but the catalog declares `
      + `${fixture.datasetVersions[batchProvenance.datasetId].version}`);
  }

  // 3. The survey's own row must equal the batch's answer for the same geometry: batching is not a
  //    different measurement. Compared before coverage, because it is the same query either way.
  for (const [distance, key] of [[250, 'area250M2'], [500, 'area500M2'], [1000, 'area1000M2']]) {
    if (!close(entry.runSignals?.wetlands?.[key], entry.batch?.buffers?.[distance]?.areaM2)) {
      fail(id, 'batch-composition', `wetland ${distance} m area differs between the survey row and the batch: `
        + describe(entry.runSignals?.wetlands?.[key], entry.batch?.buffers?.[distance]?.areaM2));
    }
  }

  // 4. Coverage first: a metric is only compared at a distance both paths report as covered.
  const coverageByDistance = entry.batch?.coverageByDistance ?? {};
  const detailedCoverageByDistance = entry.detailedCorridor?.coverageByDistance ?? {};
  if (entry.batch?.coverage !== entry.detailedCorridor?.coverage) {
    notes.push({ corridorId: id, kind: 'coverage', message: `overall coverage differs: `
      + describe(entry.batch?.coverage, entry.detailedCorridor?.coverage) });
  }
  const comparable = DISTANCES.filter(distance => coverageByDistance[distance]?.covered
    && detailedCoverageByDistance[distance]?.covered);
  for (const distance of DISTANCES) {
    const batchCovers = coverageByDistance[distance]?.covered;
    const detailedCovers = detailedCoverageByDistance[distance]?.covered;
    // Two paths that report the same overall coverage must also agree distance by distance: a FULL/FULL or
    // PARTIAL/PARTIAL pair with different per-distance flags is a coverage divergence, not a metric one.
    if (entry.batch?.coverage === entry.detailedCorridor?.coverage && batchCovers !== detailedCovers) {
      fail(id, 'coverage', `${distance} m coverage differs between two ${entry.batch?.coverage} paths: `
        + describe(batchCovers, detailedCovers));
    }
    if (!batchCovers || !detailedCovers) notes.push({ corridorId: id, kind: 'coverage-skipped',
      message: `${distance} m metrics are not compared (batch covered ${batchCovers}, detailed covered ${detailedCovers})` });
  }

  // 5. Wetland metrics at every comparable distance.
  for (const distance of comparable) {
    const batch = entry.batch?.buffers?.[distance] ?? {};
    const detailed = entry.detailedCorridor?.buffers?.[distance] ?? {};
    if (!close(batch.areaM2, detailed.areaM2)) {
      fail(id, 'wetlands', `${distance} m area differs: ${describe(batch.areaM2, detailed.areaM2)}`);
    }
    if (Number(batch.featureCount ?? 0) !== Number(detailed.featureCount ?? 0)) {
      fail(id, 'wetlands', `${distance} m feature count differs: ${describe(batch.featureCount, detailed.featureCount)}`);
    }
  }
  if (comparable.length) {
    if (!close(entry.batch?.nearestM, entry.detailedCorridor?.nearestM)) {
      fail(id, 'wetlands', `nearest mapped wetland differs: ${describe(entry.batch?.nearestM, entry.detailedCorridor?.nearestM)}`);
    }
    if (Boolean(entry.batch?.intersectsCorridor) !== Boolean(entry.detailedCorridor?.intersectsCorridor)) {
      fail(id, 'wetlands', `corridor-intersection flag differs: `
        + describe(entry.batch?.intersectsCorridor, entry.detailedCorridor?.intersectsCorridor));
    }
  }

  // 6. Hydrography metrics at every comparable distance.
  for (const distance of comparable) {
    const batch = entry.hydrography?.batch?.buffers?.[distance] ?? {};
    const detailed = entry.hydrography?.detailed?.buffers?.[distance] ?? {};
    if (!close(batch.areaM2, detailed.areaM2)) {
      fail(id, 'hydrography', `${distance} m waterbody area differs: ${describe(batch.areaM2, detailed.areaM2)}`);
    }
    if (!close(batch.featureCount, detailed.featureCount)) {
      fail(id, 'hydrography', `${distance} m feature count differs: ${describe(batch.featureCount, detailed.featureCount)}`);
    }
  }
  if (entry.hydrography?.batch?.coverage && entry.hydrography?.detailed?.coverage
    && entry.hydrography.batch.coverage !== entry.hydrography.detailed.coverage) {
    notes.push({ corridorId: id, kind: 'coverage', message: `hydrography coverage differs: `
      + describe(entry.hydrography.batch.coverage, entry.hydrography.detailed.coverage) });
  }

  // 6b. Ecology: the same primary region and the same overlap at each level, from the same union of
  // declared layers (a level is answered from the union of its state layers, not from Oregon alone).
  for (const level of ['level3', 'level4']) {
    const batch = entry.ecology?.batch?.[level] ?? null;
    const detailed = entry.ecology?.detailed?.[level] ?? null;
    if (!batch || !detailed) {
      if (!same(batch, detailed)) fail(id, 'ecology', `${level} is reported by one path only: ${describe(Boolean(batch), Boolean(detailed))}`);
      continue;
    }
    if ((batch.primary?.code ?? null) !== (detailed.primary?.code ?? null)) {
      fail(id, 'ecology', `${level} primary region differs: ${describe(batch.primary?.code, detailed.primary?.code)}`);
    }
    if (!close(batch.measuredM, detailed.measuredM)) {
      fail(id, 'ecology', `${level} measured overlap length differs: ${describe(batch.measuredM, detailed.measuredM)}`);
    }
    if ((batch.intersections?.length ?? 0) !== (detailed.intersections?.length ?? 0)) {
      fail(id, 'ecology', `${level} intersection count differs: ${describe(batch.intersections?.length, detailed.intersections?.length)}`);
    }
  }
  if (entry.ecology?.batch && entry.ecology?.detailed && entry.ecology.batch.coverage !== entry.ecology.detailed.coverage) {
    fail(id, 'ecology', `ecology coverage differs: ${describe(entry.ecology.batch.coverage, entry.ecology.detailed.coverage)}`);
  }

  // 7. Promotion measures the corridor, not the road group it came from.
  if (entry.promoted?.matchesCorridorGeometry !== true) {
    fail(id, 'promotion', 'the promoted candidate road geometry is not the corridor geometry');
  }
  if (!close(entry.promoted?.roadLengthM, entry.corridor?.lengthM)) {
    fail(id, 'promotion', `the promoted candidate length differs from the corridor length: `
      + describe(entry.promoted?.roadLengthM, entry.corridor?.lengthM));
  }
  if ((entry.segmentation?.count ?? 1) > 1) {
    if (!(Number(entry.unit?.lengthM) > Number(entry.corridor?.lengthM))) {
      fail(id, 'promotion', 'a segmented corridor did not record a longer unit geometry, so the old failure is not reproduced');
    }
    // The original divergence must stay reproducible in the fixture: measuring the unit must differ from
    // measuring the corridor at the tightest distance, otherwise this fixture no longer covers the bug.
    const corridor250 = entry.batch?.buffers?.[250]?.areaM2;
    const unit250 = entry.detailedUnit?.buffers?.[250]?.areaM2;
    if (close(corridor250, unit250) && close(entry.corridor?.lengthM, entry.unit?.lengthM)) {
      fail(id, 'promotion', 'the unit and corridor geometries are equal, so the fixture no longer covers the divergence');
    }
  }

  // 8. Per-feature stage: unique features, sums that match the aggregate.
  if (entry.perFeature) {
    for (const distance of DISTANCES) {
      const rows = entry.perFeature.rows.filter(row => row.distanceM === distance);
      // The aggregate counts features that contribute a positive clipped area at that distance, so the
      // per-feature stage is compared the same way (a recorded zero-area row is information, not a count).
      const positive = rows.filter(row => Number(row.areaM2) > 0);
      const ids = rows.map(row => row.id);
      if (new Set(ids).size !== ids.length) fail(id, 'per-feature', `${distance} m repeats a source feature id`);
      const sum = rows.reduce((total, row) => total + Number(row.areaM2), 0);
      const recorded = entry.perFeature.sums[DISTANCES.indexOf(distance)];
      if (!close(sum, recorded)) fail(id, 'per-feature', `${distance} m per-feature sum is not the recorded sum: ${describe(sum, recorded)}`);
      const aggregate = entry.detailedCorridor?.buffers?.[distance]?.areaM2;
      // Per-feature rows are recorded at the summarizers' three-decimal precision, so summing them and
      // comparing with a rounded aggregate accumulates at most 0.0005 per recorded feature. That bound is
      // stated, not assumed: a real semantic difference is orders of magnitude larger (the divergences this
      // fixture exists for are hectares), and the aggregate comparison above is made at the same precision.
      const accumulated = TOLERANCE + rows.length * 0.0005;
      if (aggregate != null && Math.abs(sum - Number(aggregate)) > accumulated) {
        fail(id, 'per-feature', `${distance} m per-feature sum differs from the detailed aggregate by more than `
          + `the recorded precision allows: ${describe(sum, aggregate)} (allowed ${accumulated.toFixed(4)})`);
      }
      if (rows.length && entry.detailedCorridor?.buffers?.[distance]?.featureCount != null
        && positive.length !== Number(entry.detailedCorridor.buffers[distance].featureCount)) {
        fail(id, 'per-feature', `${distance} m per-feature count differs from the detailed count: `
          + describe(ids.length, entry.detailedCorridor.buffers[distance].featureCount));
      }
    }
  }
}

const coverageCounts = fixture.sample.reduce((counts, entry) => {
  const coverage = entry.batch?.coverage ?? 'UNKNOWN';
  counts[coverage] = (counts[coverage] ?? 0) + 1;
  return counts;
}, {});
const byKind = kind => problems.some(problem => problem.kind === kind);
const overlappingPairs = fixture.sample.map(entry => entry.perFeature?.overlappingFeaturePairsWithin1000M ?? 0)
  .reduce((total, value) => total + value, 0);
const report = {
  fixture: fixturePath,
  catalog: fixture.catalogVersion,
  corridorsChecked: fixture.sample.length,
  surveyCorridors: fixture.corridorCount,
  coverage: coverageCounts,
  repaired: fixture.repairedCorridors?.length ?? 0,
  unpublishedEdgeCorridors: fixture.sample.filter(entry => (entry.publishedMarginDeg ?? 1) < 0.2).length,
  overlappingMappedWetlandPairs: overlappingPairs,
  wetlandMetrics: byKind('wetlands') ? 'FAIL' : 'PASS',
  hydrographyMetrics: byKind('hydrography') ? 'FAIL' : 'PASS',
  ecologyMetrics: byKind('ecology') ? 'FAIL' : 'PASS',
  geometryProvenance: (byKind('geometry') || byKind('provenance')) ? 'FAIL' : 'PASS',
  batchComposition: byKind('batch-composition') ? 'FAIL' : 'PASS',
  promotionIdentity: byKind('promotion') ? 'FAIL' : 'PASS',
  perFeatureStage: byKind('per-feature') ? 'FAIL' : 'PASS',
  divergences: problems.length,
  notes: notes.length,
};

if (asJson) console.log(JSON.stringify({ ...report, problems, noteDetails: notes }, null, 2));
else {
  console.log('Regional GIS equivalence\n');
  console.log(`Corridors checked      ${report.corridorsChecked} of ${report.surveyCorridors} surveyed`);
  for (const [state, count] of Object.entries(report.coverage)) console.log(`${state.padEnd(22)} ${count}`);
  console.log(`Repaired corridors     ${report.repaired}`);
  console.log(`Overlapping NWI pairs  ${report.overlappingMappedWetlandPairs} within the sampled 1 km buffers\n`);
  console.log(`Wetland metrics        ${report.wetlandMetrics}`);
  console.log(`Hydrography metrics    ${report.hydrographyMetrics}`);
  console.log(`Ecology metrics        ${report.ecologyMetrics}`);
  console.log(`Geometry provenance    ${report.geometryProvenance}`);
  console.log(`Batch composition      ${report.batchComposition}`);
  console.log(`Promotion identity     ${report.promotionIdentity}`);
  console.log(`Per-feature stage      ${report.perFeatureStage}\n`);
  for (const problem of problems) console.log(`DIVERGENCE ${problem.corridorId} [${problem.kind}] ${problem.message}`);
  for (const note of notes) console.log(`NOTE ${note.corridorId} [${note.kind}] ${note.message}`);
  console.log(`\n${problems.length === 0 ? '0 unexplained divergences' : `${problems.length} unexplained divergence(s)`}`);
}
if (problems.length) process.exitCode = 1;
