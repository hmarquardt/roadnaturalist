import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createGisService } from '../src/gis/service.js';
import { validateManifest } from '../src/services/manifest.js';
import { readRoadSourceEvidence } from '../src/discovery/road-source-evidence.js';
import { buildDiscoveryUnits } from '../src/discovery/units.js';
import { segmentUnit } from '../src/discovery/segment.js';

// THE ROAD STAGE READS ONE ROAD, NOT EVERY ROAD IN THE BOX.
//
// Reconstructing a corridor used to read the whole raw road network inside its bounding box - 32 498 features for one
// corridor in the observed case, which took 21 s warm and over 142 s cold and once timed out at 90 s. The derived row
// already names the exact source features the corridor was composed from, so the read can ask for those by id. What
// follows proves that the filter reaches SQL, that verification still decides what is allowed to reconstruct, and that
// a corridor which needs a wider read still gets one rather than failing.

// A ROAD, ITS DERIVED ROW, AND A READER THAT HONOURS THE FILTER IT IS GIVEN.
const manifest = validateManifest(JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url))));
const LON_PER_M = 1 / (111320 * Math.cos((45.5 * Math.PI) / 180));
function line(lengthM, { lon = -123, lat = 45.5, segments = 10 } = {}) {
  return Array.from({ length: segments + 1 }, (_, index) => [lon + lengthM * index / segments * LON_PER_M, lat]);
}
function feature(overrides = {}) {
  return { roadId: 'tiger-2025-or-41067-example-rd', name: 'NW Example Rd', roadClass: 'S1400', routeType: 'M',
    countyFips: '41067', countyName: 'Washington County, Oregon', sourceFeatureId: 'f1',
    geometry: { type: 'LineString', coordinates: line(3000) }, ...overrides };
}
// The row a build would have recorded: identity is the source feature set plus the segment position, and the id is the
// build's own - which is deliberately not the id the composition gives the same road.
function derivedRow(features, { segmentIndex = 1, id = 'drv1-example-rd-c226-s1' } = {}) {
  const unit = buildDiscoveryUnits(features).units[0];
  const segmentation = segmentUnit(unit);
  const corridor = segmentation.corridors[segmentIndex - 1];
  assert.ok(corridor, `the fixture must compose segment ${segmentIndex}`);
  return { id, name: corridor.name, geometry: corridor.geometry, sourceFeatureIds: [...unit.sourceFeatureIds],
    segmentIndex, segmentCount: segmentation.corridors.length };
}
function reading(reads, features) {
  return async options => {
    reads.push(options);
    const wanted = options.sourceFeatureIds ? new Set(options.sourceFeatureIds.map(String)) : null;
    return { coverage: 'FULL', features: wanted ? features.filter(row => wanted.has(String(row.sourceFeatureId))) : features };
  };
}

test('the road stage reads the corridor own source features, and verifies what comes back', async () => {
  const features = [feature()];
  const derived = derivedRow(features);
  const reads = [];
  const debug = [];
  const result = await readRoadSourceEvidence({ readNetwork: reading(reads, features), derived,
    bbox: [-124, 45, -122, 46], roadClasses: ['S1400'], limit: 100000,
    debug: (name, detail) => debug.push({ name, ...detail }) });

  assert.equal(reads.length, 1, 'one read, and it is the narrow one');
  assert.deepEqual(reads[0].sourceFeatureIds, derived.sourceFeatureIds.map(String),
    'the filter is the row own source features - the exact identity verification uses');
  assert.equal(result.narrowed, true, 'and the stage reports that it narrowed');
  assert.equal(result.widened, false, 'without widening');
  assert.equal(result.road.features.length, derived.sourceFeatureIds.length, 'the read returned the corridor, not the box');
  // IDENTITY IS NOT THE ID. The build's id differs from the id the same composition gives the road, and the verification
  // is about the source feature set, the segment and the geometry - so this is a success, exactly as it is in production.
  assert.equal(result.verified.derivedId, derived.id);
  assert.notEqual(result.verified.corridor.id, derived.id);
  assert.ok(result.verified.driftM <= 1, 'and the geometry drift is inside the metre');
  assert.deepEqual(debug.map(entry => entry.name), ['narrow']);
  assert.equal(debug[0].wanted, derived.sourceFeatureIds.length);

  // UNRELATED ROWS DO NOT CHANGE WHAT IS ACCEPTED. A reader that also hands back other roads of the same network still
  // composes the corridor the row names, because the verifier matches the exact source feature set.
  const noisy = [feature(), feature({ sourceFeatureId: 'other-1', roadId: 'tiger-2025-or-41067-other-rd', name: 'NW Other Rd' })];
  const noisyResult = await readRoadSourceEvidence({ readNetwork: reading([], noisy), derived, bbox: [-124, 45, -122, 46],
    roadClasses: ['S1400'], limit: 100000 });
  assert.equal(noisyResult.verified.corridor.id, result.verified.corridor.id, 'the same corridor is accepted either way');
});


function fakeEngine({ onQuery }) {
  return async () => ({ db: { registerFileBuffer: async () => {} },
    conn: { query: async sql => ({ toArray: () => onQuery(sql) }) } });
}
async function withRoadFetch(run) {
  const bytes = readFileSync(new URL('../data/gis/or-roads-pilot-2025.parquet', import.meta.url));
  const original = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('or-roads-pilot') ? new Response(bytes)
    : Promise.reject(new Error(`unexpected fetch ${url}`));
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('the road read filters on the exact source feature ids, in SQL, before the limit', async () => {
  const queries = [];
  await withRoadFetch(async () => {
    const gis = createGisService({ manifest, engineFactory: fakeEngine({ onQuery: sql => { queries.push(sql); return []; } }) });
    // The rows are irrelevant here: what matters is the statement the reader is given.
    await gis.queryRoads({ sourceFeatureIds: ['142395210', '142395211'], limit: 50 });
    const narrowed = queries.at(-1);
    assert.match(narrowed, /source_feature_id IN \('142395210', '142395211'\)/,
      'the corridor named source features are the filter, not a post-read comparison');
    assert.ok(narrowed.indexOf('source_feature_id IN') < narrowed.indexOf('LIMIT'),
      'and the filter is part of the query the reader runs, not a narrowing applied afterwards');
    // The old read is unchanged: with no ids there is no source-feature filter at all.
    await gis.queryRoads({ bbox: [-123.1, 45.4, -122.8, 45.7], limit: 50 });
    const broad = queries.at(-1);
    assert.ok(!/source_feature_id IN/.test(broad), 'a read with no identity filter still reads as it did');
    // A filter that is not a set of source feature ids is refused rather than interpolated.
    await assert.rejects(() => gis.queryRoads({ sourceFeatureIds: ["12' OR '1'='1"], limit: 10 }),
      /Invalid road source feature id/, 'a value that could escape the SQL literal is refused');
    await assert.rejects(() => gis.queryRoads({ sourceFeatureIds: Array.from({ length: 501 }, (_, index) => `f${index}`), limit: 10 }),
      /bounded to 500 ids/, 'and a filter larger than a corridor could ever name is refused');
  });
});

test('an identity the narrow read cannot reproduce widens once, and then fails closed', async () => {
  const features = [feature()];
  const reads = [];
  const debug = [];
  // The row names source features that the network does not contain under that identity: the narrow read returns the
  // corridor's rows by the reader's own filter, the composition cannot match the exact set, and the stage does what it
  // always did - a full network read - before refusing.
  const derived = { ...derivedRow(features), sourceFeatureIds: ['f-nope-1', 'f-nope-2'] };
  await assert.rejects(() => readRoadSourceEvidence({ readNetwork: reading(reads, features), derived,
    bbox: [-124, 45, -122, 46], roadClasses: ['S1400'], limit: 100000,
    debug: (name, detail) => debug.push({ name, ...detail }) }),
  /source feature/i, 'the exact mismatch is refused, exactly as it was before the narrowing');
  assert.equal(reads.length, 2, 'the narrow read first, then the full one');
  assert.deepEqual(reads[0].sourceFeatureIds, ['f-nope-1', 'f-nope-2'], 'the first read asked for what the row named');
  assert.equal(reads[1].sourceFeatureIds, undefined, 'and the second read is the read this stage always made');
  assert.deepEqual(debug.map(entry => entry.name), ['narrow', 'narrow-unverified'],
    'the stage records that the narrow read was not enough, so a regression here is visible');
});

test('a row with no recorded source identity cannot narrow, and still fails closed', async () => {
  const features = [feature()];
  const reads = [];
  // There is no identity to filter by, so the read is the full one this stage has always made - and the verifier then
  // refuses the row for the reason it always has, because a corridor cannot be accepted without a source identity.
  await assert.rejects(() => readRoadSourceEvidence({ readNetwork: reading(reads, features),
    derived: { id: 'drv1-no-identity', name: 'NW Example Rd', geometry: features[0].geometry, sourceFeatureIds: [] },
    bbox: [-124, 45, -122, 46], roadClasses: ['S1400'], limit: 100000 }),
  /no source feature identity/, 'a corridor with no source identity is never accepted on geometry alone');
  assert.equal(reads.length, 1, 'one read');
  assert.equal(reads[0].sourceFeatureIds, undefined, 'the full one: there is no identity to narrow by');
});

test('a multi-segment corridor verifies with its own segment, from the narrowed read', async () => {
  // ONE ROAD THAT THE COMPOSITION DIVIDES: two features of the same name, meeting end to end (the fixture the segment
  // rule already uses), so the row's segment index and count are meaningful.
  // 15 km of one road, delivered as two pieces that meet: longer than the 8-mile maximum, so the composition divides it.
  const west = feature({ sourceFeatureId: 'w1', geometry: { type: 'LineString', coordinates: line(7500, { lon: -122.96 }) } });
  const east = feature({ sourceFeatureId: 'e1', roadId: 'tiger-2025-or-41067-example-rd-2',
    geometry: { type: 'LineString', coordinates: line(7500, { lon: -122.96 + 7500 * LON_PER_M }) } });
  const features = [west, east];
  const derived = derivedRow(features, { segmentIndex: 2, id: 'drv1-example-rd-c226-s2' });
  assert.equal(derived.segmentCount, 2, 'the fixture composes a two-segment road');
  const reads = [];
  const result = await readRoadSourceEvidence({ readNetwork: reading(reads, features), derived,
    bbox: [-124, 45, -122, 46], roadClasses: ['S1400'], limit: 100000 });
  assert.deepEqual(reads[0].sourceFeatureIds.sort(), ['e1', 'w1'], 'both segments source features are asked for');
  assert.equal(result.narrowed, true);
  assert.equal(result.verified.corridor.segmentIndex, 2, 'the second segment is the one verified');
  assert.equal(result.verified.derivedId, derived.id);
});

test('a read that could not be made is a failure, never a narrower corridor', async () => {
  const features = [feature()];
  const derived = derivedRow(features);
  await assert.rejects(() => readRoadSourceEvidence({ readNetwork: async options => ({ coverage: 'NONE',
    features: [], reason: 'no cells' }), derived, bbox: [-124, 45, -122, 46], roadClasses: ['S1400'], limit: 100000 }),
  /could not be read back/, 'a read with no usable coverage is refused rather than treated as an empty road');
  await assert.rejects(() => readRoadSourceEvidence({ readNetwork: null, derived }), /needs a network reader/);
});

