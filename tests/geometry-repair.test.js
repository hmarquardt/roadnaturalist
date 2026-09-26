import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { insertSelfIntersectionNodes, normalizeLineCoordinates, removeDuplicateSegments, segmentKey, splitRepeatedVertices } from '../src/domain/line-repair.js';
import { ANALYSIS_GEOMETRY_METHOD, ANALYSIS_GEOMETRY_TOLERANCE, UNREPAIRABLE_GEOMETRY_REASON, acceptAnalyticalGeometry,
  canonicalAnalysis, describeGeometryForAnalysis, measureAnalyticalChange, repairCandidates } from '../src/domain/analytical-geometry.js';
import { boundsOf, corridorWkt, haversineM, lineLengthM, symmetricDisplacementM, vertexCount } from '../src/domain/geometry.js';
import { createAnalyticalGeometryQueries } from '../src/gis/analytical-geometry.js';

// Real production geometry that the analysis engine refused to buffer, captured from the discovery survey
// over the Oregon pilot window. This fixture is the regression record for the shared repair boundary.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/discovery-geometry-failures.json', import.meta.url)));
// Synthetic lines sit at the pilot window's latitude, so a distance in metres and a distance in degrees
// mean the same thing in both the assertions and the repair code.
const BASE = [-123, 45.5];
const LON_PER_M = 1 / (111320 * Math.cos(BASE[1] * Math.PI / 180));
const east = distanceM => BASE[0] + distanceM * LON_PER_M;
const north = distanceM => BASE[1] + distanceM / 110540;
const line = points => ({ type: 'LineString', coordinates: points.map(([x, y]) => [x, y]) });
const clone = value => JSON.parse(JSON.stringify(value));
const close = (actual, expected, tolerance = 1e-6) => Math.abs(actual - expected) <= tolerance;
const point = (eastM, northM = 0) => [east(eastM), north(northM)];

// ---------------------------------------------------------------- repair primitives

test('a valid line with no repeated traversal is left exactly as it is', () => {
  const geometry = line([point(0), point(1000), point(2000)]);
  const dedupe = removeDuplicateSegments(geometry);
  assert.equal(dedupe.changed, false);
  assert.equal(dedupe.removedSegmentCount, 0);
  assert.deepEqual(dedupe.geometry, geometry);
  assert.deepEqual(splitRepeatedVertices(geometry).geometry, geometry);
  assert.equal(insertSelfIntersectionNodes(geometry).changed, false);
  assert.equal(repairCandidates(geometry).length, 0, 'a clean line needs no repair candidate at all');
});

test('consecutive duplicate vertices and zero-length segments are removed exactly', () => {
  assert.deepEqual(normalizeLineCoordinates([point(0), point(0), point(1)]), [point(0), point(1)]);
  assert.deepEqual(normalizeLineCoordinates([point(0), ['x', 1], point(1)]), [point(0), point(1)]);
  const geometry = line([point(0), point(1000), point(1000), point(2000)]);
  const dedupe = removeDuplicateSegments(geometry);
  assert.equal(dedupe.removedSegmentCount, 0, 'a repeated vertex is not a repeated segment');
  assert.equal(vertexCount(dedupe.geometry), 3);
  assert.ok(close(lineLengthM(dedupe.geometry), lineLengthM(geometry), 1e-3));
});

test('an exact backtrack is a doubled traversal, so the twin goes and every point stays', () => {
  const geometry = line([point(0), point(1000), point(2000), point(1000)]);
  const dedupe = removeDuplicateSegments(geometry);
  assert.equal(dedupe.removedSegmentCount, 1);
  assert.ok(close(dedupe.removedLengthM, 1000, 2), `removed ${dedupe.removedLengthM} m`);
  assert.equal(vertexCount(dedupe.geometry), 3);
  assert.ok(symmetricDisplacementM(geometry, dedupe.geometry) <= ANALYSIS_GEOMETRY_TOLERANCE.maxDisplacementM,
    'removing a doubled traversal cannot move the point set');
  assert.deepEqual(boundsOf(dedupe.geometry), boundsOf(geometry));
});

test('an overlapping repeated stretch is noded by subdivision, never by deleting pavement', () => {
  const geometry = line([point(0), point(2000), point(1000), point(3000)]);
  assert.equal(removeDuplicateSegments(geometry).changed, false, 'no two segments share both endpoints here');
  const noded = insertSelfIntersectionNodes(geometry);
  assert.equal(noded.changed, true);
  assert.ok(noded.nodeCount >= 1, `expected a node where the traversal rejoins, got ${noded.nodeCount}`);
  assert.ok(symmetricDisplacementM(geometry, noded.geometry) <= ANALYSIS_GEOMETRY_TOLERANCE.maxDisplacementM);
  assert.ok(close(lineLengthM(noded.geometry), lineLengthM(geometry), 1e-3), 'subdivision cannot change length');
});

test('a self-touching and a self-crossing line are subdivided without moving any vertex', () => {
  const touching = line([point(0), point(2000), point(1000), point(1000, 1000)]);
  const touched = insertSelfIntersectionNodes(touching);
  assert.equal(touched.changed, true);
  assert.ok(symmetricDisplacementM(touching, touched.geometry) <= ANALYSIS_GEOMETRY_TOLERANCE.maxDisplacementM);
  assert.ok(close(lineLengthM(touched.geometry), lineLengthM(touching), 1e-3), 'subdivision cannot change length');

  const crossing = { type: 'MultiLineString', coordinates: [[point(0, 0), point(2000, 2000)], [point(0, 2000), point(2000, 0)]] };
  const crossed = insertSelfIntersectionNodes(crossing);
  assert.equal(crossed.changed, true, 'the crossing point becomes a node');
  assert.ok(symmetricDisplacementM(crossing, crossed.geometry) <= ANALYSIS_GEOMETRY_TOLERANCE.maxDisplacementM);
  assert.ok(close(lineLengthM(crossed.geometry), lineLengthM(crossing), 1e-3), 'parts are never joined across a gap');
});

test('a legitimate gap and a legitimate hairpin survive repair untouched', () => {
  const gapM = 246;
  const split = { type: 'MultiLineString', coordinates: [[point(0), point(1000)], [point(1000 + gapM), point(2000)]] };
  assert.equal(repairCandidates(split).length, 0, 'a real gap is not a defect');
  assert.equal(insertSelfIntersectionNodes(split).changed, false);
  const pieces = insertSelfIntersectionNodes({ type: 'MultiLineString', coordinates: [[point(0), point(1000)], [point(1000 + gapM), point(2000)]] }).geometry;
  assert.equal(pieces.coordinates.length, 2, 'the two parts stay two parts');
  assert.ok(close(lineLengthM(split), 1000 + (1000 - gapM), 3), 'the 246 m gap is neither bridged nor counted');
  const [beforeGap, afterGap] = [split.coordinates[0].at(-1), split.coordinates[1][0]];
  assert.ok(close(haversineM(beforeGap, afterGap), gapM, 5), 'the source gap is still the source gap');

  const hairpin = line([point(0), point(2000), [east(2000), north(8)], point(0, 4)]);
  assert.equal(repairCandidates(hairpin).length, 0, 'a tight switchback is real road, not a defect');
  assert.equal(vertexCount(hairpin), 4);
});

test('a near miss is left alone: repair never invents a meeting the source does not have', () => {
  const nearMiss = line([point(0), point(2000), [east(1000), BASE[1] + 1e-6], point(1000, 1000)]);
  assert.equal(insertSelfIntersectionNodes(nearMiss).changed, false);
  assert.equal(repairCandidates(nearMiss).length, 0);
  assert.ok(symmetricDisplacementM(nearMiss, nearMiss) <= 1e-6, 'identical input reports no displacement');
});

test('repair is deterministic and idempotent', () => {
  const geometry = line([point(0), point(2000), point(1000), point(3000)]);
  assert.equal(JSON.stringify(repairCandidates(geometry)), JSON.stringify(repairCandidates(geometry)));
  const repaired = removeDuplicateSegments(geometry).geometry;
  assert.equal(removeDuplicateSegments(repaired).removedSegmentCount, 0);
  assert.equal(segmentKey([0, 0], [1, 1]), segmentKey([1, 1], [0, 0]));
});

// ---------------------------------------------------------------- policy, impact, acceptance

test('repair impact is measured, and a repair that would move the road is rejected', () => {
  const geometry = line([point(0), point(1000), point(2000)]);
  const canonical = canonicalAnalysis(geometry);
  assert.equal(canonical.method, ANALYSIS_GEOMETRY_METHOD.NONE);
  assert.ok(canonical.metrics.displacementM <= 1e-6, 'an unmodified geometry reports no displacement');
  assert.ok(close(canonical.metrics.analyticalLengthM, canonical.metrics.canonicalLengthM, 1e-9));

  const shifted = line([point(0, 11), point(1000, 11), point(2000, 11)]);
  const shiftedVerdict = acceptAnalyticalGeometry(measureAnalyticalChange(geometry, shifted));
  assert.equal(shiftedVerdict.accepted, false, 'an 11 m shift is a different road, not a repair');
  assert.match(shiftedVerdict.reason, /moves corridor geometry by/);
  assert.match(ANALYSIS_GEOMETRY_TOLERANCE.note, /rejected outright/);

  const truncated = line([point(0), point(1000)]);
  assert.equal(acceptAnalyticalGeometry(measureAnalyticalChange(geometry, truncated)).accepted, false);
  assert.equal(acceptAnalyticalGeometry(null).accepted, false, 'an empty candidate fails closed');
});

test('the ladder is ordered, and each rung is only offered when it actually changes something', () => {
  const geometry = line([point(0), point(2000), point(1000), point(3000)]);
  const ladder = repairCandidates(geometry);
  assert.deepEqual(ladder.map(r => r.method), [ANALYSIS_GEOMETRY_METHOD.DUPLICATE_SEGMENTS_SELF_INTERSECTIONS]);
  assert.equal(ladder[0].accepted, true);
  assert.ok(ladder[0].repairs.nodeCount >= 1);
  assert.equal(repairCandidates(line([point(0), point(1000)])).length, 0, 'nothing to offer for a clean line');
});

test('provenance answers whether Road Naturalist altered the geometry before spatial analysis', () => {
  const geometry = line([point(0), point(1000), point(2000), point(1000)]);
  const rung = repairCandidates(geometry)[0];
  const repaired = describeGeometryForAnalysis({ repaired: true, method: rung.method, metrics: rung.metrics, repairs: rung.repairs });
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.method, ANALYSIS_GEOMETRY_METHOD.DUPLICATE_SEGMENTS);
  assert.ok(repaired.lengthDeltaM < 0, 'the removed traversal is reported, not hidden');
  assert.equal(repaired.displacementM, 0, 'and the geometry that remains did not move');
  assert.ok(repaired.removedDuplicateLengthM > 0);
  assert.match(repaired.note, /canonical corridor geometry is unchanged/);
  const untouched = describeGeometryForAnalysis({ repaired: false });
  assert.equal(untouched.repaired, false);
  assert.equal(untouched.method, 'none');
  assert.match(untouched.note, /used directly/);
});

// ---------------------------------------------------------------- real production regression

test('the eight production geometry refusals are reproducible from the fixture', () => {
  assert.equal(fixture.corridors.length, 8, 'the committed fixture holds the real failures');
  for (const corridor of fixture.corridors) {
    assert.equal(corridor.geosValid, true, `${corridor.id}: the engine called the line valid`);
    assert.equal(corridor.geosSimple, false, `${corridor.id}: the line meets itself, which is what buffer refused`);
    assert.ok(corridor.failingRadiiM.length >= 1, `${corridor.id}: at least one requested radius was refused`);
    assert.match(corridor.geosErrors[String(corridor.failingRadiiM[0])], /assigned depths do not match/);
    assert.ok(close(lineLengthM(corridor.geometry), corridor.lengthM, 1), `${corridor.id}: fixture length matches the measurement`);
    assert.equal(boundsOf(corridor.geometry).length, 4);
  }
});

test('every one of those corridors is repaired point-preservingly, and the engine accepts it', () => {
  for (const corridor of fixture.corridors) {
    const before = clone(corridor.geometry);
    const ladder = repairCandidates(corridor.geometry);
    assert.ok(ladder.length >= 1, `${corridor.id}: a repair candidate is offered`);
    const rung = ladder[0];
    assert.equal(rung.method, ANALYSIS_GEOMETRY_METHOD.DUPLICATE_SEGMENTS, corridor.id);
    assert.equal(rung.accepted, true, `${corridor.id}: ${rung.rejection ?? ''}`);
    assert.ok(rung.repairs.removedSegmentCount > 0, `${corridor.id}: the doubled traversal is what made it non-simple`);
    assert.ok(rung.metrics.displacementM <= ANALYSIS_GEOMETRY_TOLERANCE.maxDisplacementM, `${corridor.id}: displacement`);
    assert.equal(rung.metrics.boundsDeltaDeg, 0, `${corridor.id}: the corridor extent is untouched`);
    assert.ok(close(rung.metrics.lengthDeltaM + rung.repairs.removedLengthM, 0, 0.01),
      `${corridor.id}: the only length change is the removed duplicate traversal`);
    assert.ok(rung.metrics.lengthRatio > 0.4, `${corridor.id}: the road is still the road`);
    assert.equal(removeDuplicateSegments(rung.geometry).removedSegmentCount, 0, `${corridor.id}: repairing twice changes nothing`);
    for (const radius of corridor.failingRadiiM) {
      assert.equal(corridor.repairTrials.duplicateSegments.buffers[String(radius)], true,
        `${corridor.id}: the recorded engine trial shows this rung buffers at ${radius} m`);
    }
    assert.deepEqual(corridor.geometry, before, `${corridor.id}: the canonical geometry is never mutated in place`);
    assert.equal(JSON.stringify(repairCandidates(corridor.geometry)), JSON.stringify(ladder), `${corridor.id}: deterministic`);
  }
});

test('the fixture records what was tried and rejected, so the choice of rung is reviewable', () => {
  for (const corridor of fixture.corridors) {
    const trials = corridor.repairTrials;
    // Dissolving the overlap (ST_Node) also fixed buffering, but it changed the corridor length far more
    // than removing a doubled traversal, and it moved covered area: it is recorded as rejected evidence.
    assert.ok(trials.duplicateSegments, `${corridor.id}: the accepted rung is recorded`);
    assert.ok(trials.splitSegments || trials.vertices || trials.jsNode || trials.drop0_1,
      `${corridor.id}: alternative rungs are recorded alongside it`);
  }
  assert.equal(fixture.capturedFrom.corridorsNeedingRepair, 8);
  assert.equal(fixture.capturedFrom.corridorsAnalysed, 127);
});

// ---------------------------------------------------------------- shared GIS boundary

// A corridor that visits itself twice, in the shape the production failures have: the outbound and the
// return leg are digitized as separate segments with the same endpoints.
const RETRACED = line([point(0), point(1000), point(2000), point(1000)]);
const CLEAN = line([point(0, 100), point(1000, 100), point(2000, 100)]);
const TOPOLOGY_REFUSAL = 'Invalid Error: TopologyException: assigned depths do not match at -2069591.5 2798637.7';

// A fake engine that refuses exactly the geometries a test names, so the canonical / repaired
// distinction is explicit instead of guessed from the SQL.
function fakeEngine({ refuseWkts = [] } = {}) {
  const statements = [];
  const engine = { conn: { query: async sql => {
    statements.push(sql);
    if (/ST_Buffer/.test(sql) && refuseWkts.some(wkt => sql.includes(wkt))) throw new Error(TOPOLOGY_REFUSAL);
    return { toArray: () => [] };
  } } };
  return { statements, engine };
}

async function prepare(geometry, options = {}) {
  const { statements, engine } = fakeEngine(options);
  const queries = createAnalyticalGeometryQueries({ initialize: async () => engine });
  const entry = await queries.prepareAnalyticalGeometry({ engine, id: options.id ?? 'drv1-test', geometry });
  return { entry, statements };
}

test('a corridor the engine already buffers is used unchanged, with no repair recorded', async () => {
  const { entry, statements } = await prepare(CLEAN);
  assert.equal(entry.usable, true);
  assert.equal(entry.repaired, false);
  assert.equal(entry.repairMethod, ANALYSIS_GEOMETRY_METHOD.NONE);
  assert.deepEqual(entry.geometry, CLEAN);
  assert.equal(entry.geometryForAnalysis.repaired, false);
  assert.equal(statements.length, 1, 'the fast path costs exactly one probe');
  assert.match(statements[0], /ST_Buffer\(geom, 250\)/);
  assert.match(statements[0], /ST_Buffer\(geom, 1000\)/);
});

test('a corridor the engine refuses is repaired, and the repaired geometry is what gets buffered', async () => {
  const { entry } = await prepare(RETRACED, { refuseWkts: [corridorWkt(RETRACED)] });
  assert.equal(entry.usable, true);
  assert.equal(entry.repaired, true);
  assert.equal(entry.repairMethod, ANALYSIS_GEOMETRY_METHOD.DUPLICATE_SEGMENTS);
  assert.notDeepEqual(entry.geometry, RETRACED, 'the repaired representation is not the canonical one');
  assert.equal(entry.geometryForAnalysis.repaired, true);
  assert.equal(entry.geometryForAnalysis.displacementM, 0);
  assert.equal(entry.diagnostics.attempts.length, 2, 'the canonical probe is recorded before the repair probe');
  assert.equal(entry.diagnostics.attempts[0].usable, false);
  assert.match(entry.diagnostics.attempts[0].reason, /assigned depths/);
  assert.equal(entry.diagnostics.attempts[1].usable, true);
  assert.ok(entry.diagnostics.repairMs >= 0);
  assert.deepEqual(RETRACED, line([point(0), point(1000), point(2000), point(1000)]), 'canonical geometry is untouched');
});

test('a corridor that no candidate rescues stays unavailable, with an honest reason', async () => {
  const repaired = repairCandidates(RETRACED)[0];
  const { entry } = await prepare(RETRACED, { refuseWkts: [corridorWkt(RETRACED), corridorWkt(repaired.geometry)] });
  assert.equal(entry.usable, false);
  assert.equal(entry.repaired, false, 'a repair that does not work is not reported as one');
  assert.equal(entry.reason, UNREPAIRABLE_GEOMETRY_REASON);
  assert.equal(entry.geometry, null);
  assert.match(entry.reason, /no point-preserving repair was accepted/);
  assert.match(entry.reason, /unchanged/);
  assert.equal(entry.diagnostics.attempts.length, 2);
});

test('an engine failure that is not a geometry refusal is loud, never relabelled as geometry', async () => {
  const { engine } = fakeEngine();
  const broken = { conn: { query: async () => { throw new Error('Catalog Error: Scalar Function with name st_buffer does not exist!'); } } };
  const queries = createAnalyticalGeometryQueries({ initialize: async () => engine });
  await assert.rejects(queries.prepareAnalyticalGeometry({ engine: broken, id: 'drv1-test', geometry: CLEAN }), /does not exist/);
  await assert.rejects(queries.prepareAnalyticalGeometry({ engine: broken, id: 'drv1-test', geometry: RETRACED }), /does not exist/);
});

test('one irreparable corridor never aborts the batch, and the others are measured as usual', async () => {
  const retracedB = line([point(0, 300), point(1000, 300), point(2000, 300), point(1000, 300)]);
  const repairedRetracedB = repairCandidates(retracedB)[0].geometry;
  const { engine } = fakeEngine({ refuseWkts: [corridorWkt(RETRACED), corridorWkt(line([point(0, 200), point(1000, 200)])), corridorWkt(retracedB), corridorWkt(repairedRetracedB)] });
  const queries = createAnalyticalGeometryQueries({ initialize: async () => engine });
  const prepared = await queries.prepareAnalyticalGeometries({ engine, corridors: [
    { id: 'clean-a', geometry: CLEAN }, { id: 'clean-b', geometry: line([point(0, 200), point(1000, 200)]) },
    { id: 'retraced-a', geometry: RETRACED }, { id: 'retraced-b', geometry: retracedB },
  ] });
  assert.equal(prepared.diagnostics.corridorCount, 4);
  assert.deepEqual([...prepared.unusableIds], ['clean-b', 'retraced-b']);
  assert.deepEqual([...prepared.repairedIds], ['retraced-a']);
  // An unusable corridor is counted under the method actually used (none) even though rungs were
  // offered and refused: reporting it as "repaired" purely because a candidate existed would be a lie.
  assert.deepEqual(prepared.diagnostics.methods, { none: 3, 'remove-duplicate-segments': 1 });
  assert.equal(prepared.geometries.get('clean-a').usable, true);
  assert.equal(prepared.geometries.get('clean-a').repaired, false);
  assert.equal(prepared.geometries.get('retraced-a').repaired, true);
  assert.equal(prepared.geometries.get('retraced-a').usable, true);
  assert.equal(prepared.geometries.get('clean-b').usable, false);
  assert.equal(prepared.geometries.get('retraced-b').usable, false);
  assert.ok(prepared.diagnostics.probeMs >= 0);
});

// Repaired discovery must agree with repaired detailed analysis for the same corridor: both callers ask
// this one boundary, with the same requested distances, so the decision cannot differ.
test('the same corridor prepared for the survey and for detailed analysis yields the same geometry', async () => {
  const { engine } = fakeEngine({ refuseWkts: [corridorWkt(RETRACED)] });
  const queries = createAnalyticalGeometryQueries({ initialize: async () => engine });
  const survey = await queries.prepareAnalyticalGeometry({ engine, id: 'drv1-test', geometry: RETRACED });
  const detailed = await queries.prepareAnalyticalGeometry({ id: 'drv1-test', geometry: RETRACED });
  assert.equal(survey.wkt, detailed.wkt);
  assert.equal(survey.repairMethod, detailed.repairMethod);
  assert.equal(survey.geometryForAnalysis.displacementM, detailed.geometryForAnalysis.displacementM);
  assert.deepEqual(survey.geometryForAnalysis, detailed.geometryForAnalysis);
});
