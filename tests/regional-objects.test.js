import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSON_TYPE, PARQUET_TYPE, regionalObjectSet } from '../scripts/regional-objects.mjs';

// EVERY OBJECT THE CATALOG DECLARES IS AN OBJECT SOMETHING MUST PUBLISH AND AUDIT.
//
// The version-3 road component index was declared with its bytes and SHA-256, the browser refused to search
// without it, and it was never uploaded: publishing and auditing both enumerated only the dataset partitions
// and the derived plane, so both reported success while regional promotion failed in production. These tests
// hold the enumeration to the catalog, and to the files the repository actually carries.
const catalog = JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url)));
const root = new URL('..', import.meta.url).pathname;
const local = path => readFileSync(`${root}${path}`);

test('the published object set covers every declared partition and the component index', () => {
  const objects = regionalObjectSet(catalog);
  const partitions = catalog.datasets.flatMap(dataset => dataset.partitions.filter(part => part.state !== 'empty'));
  assert.equal(objects.filter(object => object.plane === 'regional' && object.dataset !== 'road-components').length,
    partitions.length);
  const components = objects.filter(object => object.dataset === 'road-components');
  assert.equal(components.length, 1, 'the declared road component index is part of the object set');
  assert.equal(components[0].key, catalog.roadComponentsUrl);
  assert.equal(components[0].bytes, catalog.roadComponentsBytes);
  assert.equal(components[0].sha256, catalog.roadComponentsSha256);
  assert.equal(components[0].type, JSON_TYPE);
  assert.equal(components[0].plane, 'regional');
});

test('the declared component index is the file the repository carries', () => {
  const [entry] = regionalObjectSet(catalog).filter(object => object.dataset === 'road-components');
  const bytes = local(entry.local);
  assert.equal(bytes.length, catalog.roadComponentsBytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), catalog.roadComponentsSha256);
  const document = JSON.parse(bytes);
  // The file states the window's whole component population and carries only the components that span more
  // than one cell; the catalog declares both numbers, so the two documents have to agree on both.
  assert.equal(document.version, catalog.version);
  assert.equal(document.joinToleranceM, catalog.roadComponents.joinToleranceM);
  assert.equal(document.componentCount, catalog.roadComponents.count);
  assert.equal(document.components.length, catalog.roadComponents.multiCell);
  assert.equal(document.components.filter(component => component.cells.length > 1).length,
    catalog.roadComponents.multiCell);
});

test('the derived plane contributes its manifest and exactly its present cells', () => {
  const objects = regionalObjectSet(catalog);
  const derived = objects.filter(object => object.plane === 'derived');
  const manifestPath = `data/${catalog.derived.localPath}`;
  const manifestBytes = local(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(derived.length, manifest.cells.filter(cell => cell.state !== 'empty').length + 1);
  const entry = derived[0];
  assert.equal(entry.key, catalog.derived.manifestUrl);
  assert.equal(entry.type, JSON_TYPE);
  assert.equal(entry.bytes, manifestBytes.length);
  assert.equal(entry.sha256, createHash('sha256').update(manifestBytes).digest('hex'));
  assert.equal(entry.sha256, catalog.derived.manifestSha256);
  for (const object of derived.slice(1)) {
    assert.equal(object.type, PARQUET_TYPE);
    assert.match(object.key, new RegExp(`^derived/corridor-metrics/${catalog.derived.analysisFingerprint}/cells/`));
  }
  assert.equal(objects.filter(object => object.type === PARQUET_TYPE).length,
    objects.filter(object => object.plane === 'regional' && object.dataset !== 'road-components').length
    + derived.length - 1);
});

test('a derived-only run publishes the derived plane and nothing else', () => {
  const objects = regionalObjectSet(catalog, { derivedOnly: true });
  assert.equal(objects.every(object => object.plane === 'derived'), true);
  assert.equal(objects.some(object => object.dataset === 'road-components'), false);
  assert.equal(objects.length, regionalObjectSet(catalog).filter(object => object.plane === 'derived').length);
});
