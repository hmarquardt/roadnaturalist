import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DERIVED_KIND, PREFIX, nationalDerivedObjectSet, resolvePlane } from '../scripts/national-derived-objects.mjs';

// The publication set is the manifest, in one place.
//
// The version-3 regional road component index was declared, never published, and both the publisher and the
// remote audit reported success because neither enumerated it. The national plane must not have that failure
// mode: whether an object is published is decided by the finalized manifest, never by a hand-written list or a
// directory walk, and the enumeration refuses a manifest that does not describe real, immutable, digestable
// artifacts.
const FINGERPRINT = 'a'.repeat(64);

// A throwaway finalized plane. `stamp: false` leaves the cells exactly as given, so a malformed manifest can be
// constructed deliberately.
function plane(cells, { stamp = true } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rn-national-derived-')));
  const root = join(directory, FINGERPRINT);
  mkdirSync(join(root, 'cells'), { recursive: true });
  for (const cell of cells) {
    if (stamp && cell.state === 'present') {
      const body = Buffer.from(`parquet-${cell.id}`);
      writeFileSync(join(root, 'cells', `${cell.id}.parquet`), body);
      cell.url = `${PREFIX}/${FINGERPRINT}/cells/${cell.id}.parquet`;
      cell.bytes = body.length;
      cell.sha256 = createHash('sha256').update(body).digest('hex');
    }
  }
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, kind: DERIVED_KIND,
    analysisFingerprint: FINGERPRINT, derivedSchemaVersion: 1, profileVersion: 3,
    region: { id: 'conus-2025', bounds: [-125, 24, -66, 50] }, grid: { kind: 'lonlat-grid' },
    counts: { cells: cells.length }, cells }, null, 1)}\n`);
  return directory;
}
const planeDirectory = root => join(root, FINGERPRINT);

test('the publication set is the manifest object plus exactly its present cells', () => {
  const root = plane([
    { id: 'x100_y200', bounds: [-1, 1, 0, 2], state: 'present', rowCount: 5 },
    { id: 'x101_y200', bounds: [0, 1, 1, 2], state: 'empty', rowCount: 0 },
    { id: 'x102_y200', bounds: [1, 1, 2, 2], state: 'present', rowCount: 7 },
  ]);
  const set = nationalDerivedObjectSet(planeDirectory(root));
  assert.equal(set.objects.length, 3, 'two present cells and one manifest');
  assert.equal(set.objects[0].cell, 'manifest');
  assert.equal(set.objects[0].key, `${PREFIX}/${FINGERPRINT}/manifest.json`);
  assert.equal(set.objects[0].type, 'application/json');
  assert.equal(set.objects[0].bytes, readFileSync(join(planeDirectory(root), 'manifest.json')).length);
  assert.equal(set.present, 2);
  assert.equal(set.empty, 1);
  assert.equal(set.declaredCells, 3);
  for (const object of set.objects.slice(1)) {
    assert.equal(object.type, 'application/vnd.apache.parquet');
    assert.match(object.key, new RegExp(`^${PREFIX}/${FINGERPRINT}/cells/x[0-9]+_y[0-9]+\\.parquet$`));
  }
  // A typed-empty cell contributes no object at all: it is declared, and it needs no Parquet file.
  assert.equal(set.objects.some(object => object.cell === 'x101_y200'), false);
  rmSync(root, { recursive: true, force: true });
});

test('a manifest that does not describe a real immutable artifact is refused', () => {
  const cases = [
    [[{ id: 'x1_y1', bounds: [0, 0, 1, 1], state: 'present', rowCount: 1, url: 'derived/corridor-metrics/other/cells/x1_y1.parquet' }], /is not the immutable key/],
    [[{ id: 'x1_y1', bounds: [0, 0, 1, 1], state: 'present', rowCount: 1 }], /is not the immutable key/],
    [[{ id: 'x1_y1', bounds: [0, 0, 1, 1], state: 'empty', rowCount: 3 }], /empty cell must declare no url/],
    [[{ id: 'x1_y1', bounds: [0, 0, 1, 1], state: 'empty', rowCount: 0, url: 'derived/x' }], /empty cell must declare no url/],
    [[{ id: 'x1_y1', bounds: [0, 0, 1, 1], state: 'half', rowCount: 1 }], /unknown state/],
    [[{ id: 'x1_y1', bounds: [0, 0, 1, 1], state: 'present', rowCount: 1 },
      { id: 'x1_y1', bounds: [0, 0, 1, 1], state: 'empty', rowCount: 0 }], /duplicate cell/, true],
  ];
  for (const [cells, expected, stamp] of cases) {
    const root = plane(cells, { stamp: stamp ?? false });
    assert.throws(() => nationalDerivedObjectSet(planeDirectory(root)), expected);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a plane root resolves to its single fingerprint directory', () => {
  const root = plane([{ id: 'x1_y1', bounds: [0, 0, 1, 1], state: 'empty', rowCount: 0 }]);
  assert.equal(resolvePlane(root), planeDirectory(root), 'a root with one fingerprint directory resolves to it');
  assert.equal(resolvePlane(planeDirectory(root)), planeDirectory(root), 'a plane directory resolves to itself');
  rmSync(root, { recursive: true, force: true });
});

