#!/usr/bin/env node
/**
 * Verify the shared analytical geometry boundary. Offline, fast, deterministic, no network.
 *
 *   npm run verify:geometry
 *   npm run verify:geometry -- --json
 *
 * It replays the committed production failures (tests/fixtures/discovery-geometry-failures.json) and a small
 * set of adversarial geometries through the same repair ladder the browser uses, then reports how many
 * corridors needed repair, with which method, and with what measured impact. Nothing is written and no
 * dataset is read: this is a geometry check for reviewers and for future ingestion changes.
 *
 * Exit status: 1 when a corridor that the fixture records as refused by the engine is not repaired, when a
 * repair exceeds the acceptance tolerances, or when a repair would move geometry beyond those tolerances.
 * Otherwise 0, with a per-corridor table of deltas.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ANALYSIS_GEOMETRY_TOLERANCE, UNREPAIRABLE_GEOMETRY_REASON, repairCandidates } from '../src/domain/analytical-geometry.js';
import { lineLengthM, linesOf, symmetricDisplacementM, vertexCount } from '../src/domain/geometry.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const FIXTURE = 'tests/fixtures/discovery-geometry-failures.json';
const asJson = process.argv.includes('--json');
const fixture = JSON.parse(readFileSync(resolve(ROOT, FIXTURE), 'utf8'));

const BASE = [-123, 45.5];
const LON_PER_M = 1 / (111320 * Math.cos(BASE[1] * Math.PI / 180));
const point = (eastM, northM = 0) => [BASE[0] + eastM * LON_PER_M, BASE[1] + northM / 110540];
const line = points => ({ type: 'LineString', coordinates: points });

// Adversarial geometries, each with the behaviour the repair boundary is expected to show.
const adversarial = [
  { name: 'valid line', geometry: line([point(0), point(1000), point(2000)]), expectRungs: 0 },
  { name: 'duplicate vertex', geometry: line([point(0), point(0), point(1000), point(2000)]), expectRungs: 0 },
  { name: 'zero-length segment', geometry: line([point(0), point(1000), point(1000), point(2000)]), expectRungs: 0 },
  { name: 'exact backtrack', geometry: line([point(0), point(1000), point(2000), point(1000)]), expectRungs: 1 },
  { name: 'overlapping repeated segment', geometry: line([point(0), point(2000), point(1000), point(3000)]), expectRungs: 1 },
  { name: 'self-touching line', geometry: line([point(0), point(2000), point(1000), point(1000, 1000)]), expectRungs: 1 },
  { name: 'self-crossing parts', geometry: { type: 'MultiLineString', coordinates: [[point(0, 0), point(2000, 2000)], [point(0, 2000), point(2000, 0)]] }, expectRungs: 1 },
  { name: 'disconnected parts', geometry: { type: 'MultiLineString', coordinates: [[point(0, 0), point(1000, 0)], [point(5000, 0), point(6000, 0)]] }, expectRungs: 0 },
  { name: 'legitimate 246 m gap', geometry: { type: 'MultiLineString', coordinates: [[point(0, 0), point(1000, 0)], [point(1246, 0), point(2000, 0)]] }, expectRungs: 0 },
  { name: 'legitimate hairpin', geometry: line([point(0), point(2000), [point(2000)[0], point(0, 8)[1]], point(0, 4)]), expectRungs: 0 },
  { name: '1 cm near self-intersection', geometry: line([point(0), point(2000), [point(1000)[0], BASE[1] + 1e-6], point(1000, 1000)]), expectRungs: 0 },
];

const errors = [];
const rows = [];

for (const corridor of fixture.corridors) {
  const ladder = repairCandidates(corridor.geometry);
  const rung = ladder[0] ?? null;
  const problems = [];
  if (!rung) problems.push('no repair candidate was offered for a corridor the engine refuses');
  else {
    if (!rung.accepted) problems.push(`the offered repair was rejected: ${rung.rejection}`);
    if (rung.metrics.displacementM > ANALYSIS_GEOMETRY_TOLERANCE.maxDisplacementM) problems.push(`displacement ${rung.metrics.displacementM} m exceeds the limit`);
    if (rung.metrics.boundsDeltaDeg > ANALYSIS_GEOMETRY_TOLERANCE.maxBoundsDeltaDeg) problems.push('the repair changed the corridor extent');
    for (const radius of corridor.failingRadiiM) {
      if (corridor.repairTrials.duplicateSegments.buffers[String(radius)] !== true) problems.push(`the recorded engine trial does not show a working buffer at ${radius} m`);
    }
    const before = lineLengthM(corridor.geometry);
    const after = lineLengthM(rung.geometry);
    if (Math.abs((rung.metrics.lengthDeltaM + rung.repairs.removedLengthM)) > 0.01) problems.push('the length change is larger than the removed duplicated traversal');
    rows.push({ id: corridor.id, name: corridor.name, method: rung.method, accepted: rung.accepted,
      failingRadiiM: corridor.failingRadiiM, removedSegments: rung.repairs.removedSegmentCount,
      removedLengthM: round(rung.repairs.removedLengthM), canonicalLengthM: round(before), analyticalLengthM: round(after),
      lengthDeltaM: round(after - before), displacementM: round(symmetricDisplacementM(corridor.geometry, rung.geometry), 6),
      maximumDisplacementM: round(rung.metrics.displacementM, 6),
      vertices: `${vertexCount(corridor.geometry)} -> ${vertexCount(rung.geometry)}`,
      parts: `${linesOf(corridor.geometry).length} -> ${linesOf(rung.geometry).length}`, problems });
  }
  for (const problem of problems) errors.push(`${corridor.id}: ${problem}`);
}

const adversarialRows = [];
for (const entry of adversarial) {
  const ladder = repairCandidates(entry.geometry);
  const problems = [];
  if (ladder.length !== entry.expectRungs) problems.push(`expected ${entry.expectRungs} rung(s), got ${ladder.length}`);
  for (const rung of ladder) {
    if (!rung.accepted) problems.push(`rung ${rung.method} was rejected: ${rung.rejection}`);
    if (rung.metrics.displacementM > ANALYSIS_GEOMETRY_TOLERANCE.maxDisplacementM) problems.push(`rung ${rung.method} moves geometry by ${rung.metrics.displacementM} m`);
  }
  adversarialRows.push({ name: entry.name, rungs: ladder.map(rung => rung.method), problems });
  for (const problem of problems) errors.push(`${entry.name}: ${problem}`);
}

const repairedMethods = rows.reduce((tally, row) => ({ ...tally, [row.method]: (tally[row.method] ?? 0) + 1 }), {});
const report = { fixture: FIXTURE, tolerance: ANALYSIS_GEOMETRY_TOLERANCE, unrepairedReason: UNREPAIRABLE_GEOMETRY_REASON,
  corridorsTested: rows.length, repairedMethods, failures: errors.length, rows, adversarial: adversarialRows };

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Analytical geometry verification: ${rows.length} production corridors, ${adversarialRows.length} adversarial geometries`);
  console.log(`Acceptance limits: displacement <= ${ANALYSIS_GEOMETRY_TOLERANCE.maxDisplacementM} m, extent change <= ${ANALYSIS_GEOMETRY_TOLERANCE.maxBoundsDeltaDeg} deg, length ratio >= ${ANALYSIS_GEOMETRY_TOLERANCE.minLengthRatio}`);
  for (const row of rows) {
    console.log(`\n${row.id}  (${row.name})`);
    console.log(`  refused at ${row.failingRadiiM.join(', ')} m -> repair ${row.method} (${row.accepted ? 'accepted' : 'REJECTED'})`);
    console.log(`  removed ${row.removedSegments} duplicate segment(s) = ${row.removedLengthM} m of doubled traversal`);
    console.log(`  length ${row.canonicalLengthM} m -> ${row.analyticalLengthM} m (delta ${row.lengthDeltaM} m); displacement ${row.displacementM} m`);
    console.log(`  vertices ${row.vertices}`);
  }
  console.log('\nAdversarial geometries');
  for (const row of adversarialRows) console.log(`  ${row.name}: ${row.rungs.length ? row.rungs.join(', ') : 'used as is'}`);
  console.log(`\n${errors.length ? `FAILED: ${errors.length} problem(s)` : 'OK: every recorded failure is repaired within tolerance, and no adversarial case is over-repaired'}`);
  for (const error of errors) console.log(`  - ${error}`);
}

function round(value, digits = 3) { const factor = 10 ** digits; return Math.round(Number(value) * factor) / factor; }
process.exit(errors.length ? 1 : 0);
