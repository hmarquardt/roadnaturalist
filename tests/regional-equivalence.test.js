import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The regional equivalence command is what stands between a derived-metrics build and a silently different
// metric definition, so its own judgement is tested: it must pass the committed real capture, and it must
// fail on each way the capture could go wrong.
const SCRIPT = 'scripts/verify-regional-equivalence.mjs';
const FIXTURE = 'tests/fixtures/regional-equivalence.json';

function runChecker(fixture) {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, '--fixture', fixture, '--json'], { encoding: 'utf8' });
    return { status: 0, report: JSON.parse(output) };
  } catch (error) {
    return { status: error.status ?? 1, report: JSON.parse(error.stdout) };
  }
}

function doctor(mutate) {
  const fixture = JSON.parse(readFileSync(new URL(`../${FIXTURE}`, import.meta.url)));
  mutate(fixture);
  const directory = mkdtempSync(join(tmpdir(), 'rn-equivalence-'));
  const path = join(directory, 'fixture.json');
  writeFileSync(path, JSON.stringify(fixture));
  return path;
}

const kinds = report => report.problems.map(problem => problem.kind);

test('the committed regional capture passes the equivalence check', () => {
  const { status, report } = runChecker(FIXTURE);
  assert.equal(status, 0, JSON.stringify(report.problems?.slice(0, 3) ?? report));
  assert.equal(report.divergences, 0);
  assert.equal(report.wetlandMetrics, 'PASS');
  assert.equal(report.hydrographyMetrics, 'PASS');
  assert.equal(report.ecologyMetrics, 'PASS');
  assert.equal(report.geometryProvenance, 'PASS');
  assert.equal(report.batchComposition, 'PASS');
  assert.equal(report.promotionIdentity, 'PASS');
  assert.equal(report.perFeatureStage, 'PASS');
  assert.ok(report.corridorsChecked >= 6, 'the capture samples several corridors');
  assert.ok(report.coverage.FULL > 0, 'the capture includes FULL-coverage corridors');
});

test('a wetland area difference is reported as a divergence, not smoothed over', () => {
  const path = doctor(fixture => {
    const entry = fixture.sample.find(item => item.batch?.buffers?.[250]);
    entry.batch.buffers[250].areaM2 = Number(entry.batch.buffers[250].areaM2) + 1500000;
  });
  const { status, report } = runChecker(path);
  assert.equal(status, 1);
  assert.ok(kinds(report).includes('wetlands'), JSON.stringify(kinds(report)));
  assert.equal(report.wetlandMetrics, 'FAIL');
});

test('a coverage difference is detected before any metric is compared', () => {
  const path = doctor(fixture => {
    // Pick a corridor whose 1000 m band is currently covered, so doctoring it creates a real mismatch.
    const entry = fixture.sample.find(item => item.batch?.coverageByDistance?.[1000]?.covered === true
      && item.detailedCorridor?.coverageByDistance?.[1000]?.covered === true);
    entry.batch.coverageByDistance[1000].covered = false;
    // A metric difference at that distance must not be reported as a metric problem: it is not comparable.
    entry.batch.buffers[1000].areaM2 = 0;
  });
  const { status, report } = runChecker(path);
  assert.equal(status, 1);
  assert.ok(kinds(report).includes('coverage'), JSON.stringify(kinds(report)));
  assert.ok(!kinds(report).includes('wetlands'), 'the 1000 m metric difference is not compared under unequal coverage');
  assert.ok(report.notes >= 1, 'the skipped comparison is reported as a note');
});

test('a promoted candidate that is not the corridor is a divergence', () => {
  const path = doctor(fixture => {
    const entry = fixture.sample.find(item => item.promoted);
    entry.promoted.matchesCorridorGeometry = false;
  });
  const { status, report } = runChecker(path);
  assert.equal(status, 1);
  assert.ok(kinds(report).includes('promotion'), JSON.stringify(kinds(report)));
  assert.equal(report.promotionIdentity, 'FAIL');
});

test('a survey row that disagrees with the batch is a divergence', () => {
  const path = doctor(fixture => {
    const entry = fixture.sample.find(item => item.runSignals?.wetlands?.area250M2 != null);
    entry.runSignals.wetlands.area250M2 = Number(entry.runSignals.wetlands.area250M2) + 1000;
  });
  const { status, report } = runChecker(path);
  assert.equal(status, 1);
  assert.ok(kinds(report).includes('batch-composition'), JSON.stringify(kinds(report)));
});

test('a dataset version that does not match the catalog is a divergence', () => {
  const path = doctor(fixture => {
    const entry = fixture.sample.find(item => item.batch?.provenance);
    entry.detailedCorridor.provenance.datasetVersion = 'some-other-version';
  });
  const { status, report } = runChecker(path);
  assert.equal(status, 1);
  assert.ok(kinds(report).includes('provenance'), JSON.stringify(kinds(report)));
  assert.equal(report.geometryProvenance, 'FAIL');
});
