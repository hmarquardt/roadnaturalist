import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { declaredArtifactUrl, globalEcoregionPlane, globalPlaneReady, validateRawRegionsIndex }
  from '../src/discovery/raw-catalog.js';

// GLOBAL ECOREGIONS ARE A GLOBAL PLANE.
//
// Roads and ecoregions are published everywhere and declared once by the raw index; wetlands and hydrography stay
// bounded, published where people explore. The two CONUS layers are far too large to ship with the application, so
// the only correct origin for them is the one the declaration names - anything else asks a web server for a file it
// has never served, once per read, and calls the 404 an absence of data.
const index = JSON.parse(readFileSync(new URL('../data/national/raw-regions.json', import.meta.url), 'utf8'));

const READY = Object.freeze({ state: 'READY', version: 'epa-conus-2015-v1', assetBaseUrl: 'https://data.example.test/',
  bytes: 123414678, levels: { l3: { url: 'national/epa-conus-l3.parquet', bytes: 37567531, sha256: 'a'.repeat(64),
    version: 'epa-conus-2015-v1', published: true },
  l4: { url: 'national/epa-conus-l4.parquet', bytes: 85847147, sha256: 'b'.repeat(64), version: 'epa-conus-2015-v1',
    published: true } } });

const withPlane = entry => ({ globalPlanes: { ecoregions: entry } });

test('the published index declares the global ecoregion plane with both CONUS layers on the data origin', () => {
  validateRawRegionsIndex(index);
  const plane = globalEcoregionPlane(index);
  assert.ok(plane, 'the committed index must declare a READY global ecoregions plane');
  assert.equal(plane.version, 'epa-conus-2015-v1');
  assert.match(plane.assetBaseUrl, /^https:\/\/data\.roadnaturalist\.com\/$/);
  assert.equal(declaredArtifactUrl({ ...plane.levels.l3, assetBaseUrl: plane.assetBaseUrl }),
    'https://data.roadnaturalist.com/national/epa-conus-l3.parquet');
  assert.equal(declaredArtifactUrl({ ...plane.levels.l4, assetBaseUrl: plane.assetBaseUrl }),
    'https://data.roadnaturalist.com/national/epa-conus-l4.parquet');
  assert.equal(plane.levels.l3.version, plane.version, 'a level must be the version the plane declares');
  assert.equal(plane.levels.l4.version, plane.version);
});

test('a plane that is not READY is not an availability claim, and a version mismatch is not substituted', () => {
  assert.equal(globalEcoregionPlane({ globalPlanes: { ecoregions: { ...READY, state: 'PARTIAL' } } }), null);
  assert.equal(globalEcoregionPlane({ globalPlanes: {} }), null);
  assert.equal(globalEcoregionPlane(withPlane(READY), 'some-other-version'), null);
  assert.ok(globalEcoregionPlane(withPlane(READY), READY.version));
  assert.equal(globalPlaneReady(index, 'ecoregions').state, 'READY');
});

test('a READY plane with an incomplete declaration fails closed rather than falling back', () => {
  const cases = [
    [{ ...READY, levels: { l3: READY.levels.l3 } }, /does not declare Level l4 completely/],
    [{ ...READY, levels: { ...READY.levels, l3: { ...READY.levels.l3, bytes: 0 } } }, /Level l3 completely/],
    [{ ...READY, levels: { ...READY.levels, l4: { ...READY.levels.l4, sha256: 'nope' } } }, /Level l4 completely/],
    [{ ...READY, levels: { ...READY.levels, l3: { ...READY.levels.l3, url: 'https://elsewhere.test/l3.parquet' } } },
      /Level l3 completely/],
    [{ ...READY, levels: { ...READY.levels, l3: { ...READY.levels.l3, version: 'epa-conus-2014-v1' } } },
      /Level l3 completely/],
  ];
  for (const [entry, pattern] of cases) {
    assert.throws(() => globalEcoregionPlane(withPlane(entry)), pattern);
  }
  // The same refusal at the index boundary, which is where a validator belongs: an index that declares a level it
  // cannot read must not load at all.
  assert.throws(() => validateRawRegionsIndex({ ...index,
    globalPlanes: { ...index.globalPlanes, ecoregions: { ...index.globalPlanes.ecoregions, levels: { l3: READY.levels.l3 } } } }),
  /Level l4 completely/);
});


test('a declared artifact resolves against its own base, so two scopes cannot affect each other', () => {
  const global = { ...READY.levels.l3, assetBaseUrl: 'https://data.example.test/' };
  const local = { url: 'region/oregon/eco_l3_or.parquet' };
  assert.equal(declaredArtifactUrl(global), 'https://data.example.test/national/epa-conus-l3.parquet');
  // A second declaration with a different base resolves to its own origin, and the first is unchanged: nothing here
  // reads a service-wide variable, which is the whole reason the base travels on the declaration.
  assert.equal(declaredArtifactUrl({ ...global, assetBaseUrl: 'https://other.example.test/' }),
    'https://other.example.test/national/epa-conus-l3.parquet');
  assert.equal(declaredArtifactUrl(global), 'https://data.example.test/national/epa-conus-l3.parquet');
  // A declaration that predates carrying a base uses the caller's fallback (a bounded region's own catalog).
  assert.equal(declaredArtifactUrl(local, 'https://data.example.test/regions/pnw/'),
    'https://data.example.test/regions/pnw/region/oregon/eco_l3_or.parquet');
  assert.equal(declaredArtifactUrl(local, 'https://roadnaturalist.com/data/'),
    'https://roadnaturalist.com/data/region/oregon/eco_l3_or.parquet');
});

test('a declaration with no usable base, or no url at all, is refused', () => {
  assert.throws(() => declaredArtifactUrl({ bytes: 1 }), /must name the url/);
  assert.throws(() => declaredArtifactUrl({ url: 'national/epa-conus-l3.parquet' }), /names no usable asset base/);
  assert.throws(() => declaredArtifactUrl({ url: 'national/epa-conus-l3.parquet', assetBaseUrl: 'ftp://x/' }),
    /names no usable asset base/);
  assert.throws(() => declaredArtifactUrl(null, 'http://insecure.test/'), /must name the url/);
});

test('a bounded region is never asked to declare the global layers itself', () => {
  // The plane model, asserted against the committed index rather than restated: the index says which planes are
  // global, and a bounded region catalog only ever carries its own partitioned planes.
  assert.deepEqual(Object.keys(index.globalPlanes).sort(), ['ecoregions', 'roads']);
  assert.equal(index.globalPlanes.roads.state, 'READY');
  assert.equal(index.globalPlanes.ecoregions.state, 'READY');
  const region = index.regions[0];
  assert.ok(region, 'the index must describe at least one bounded region');
  assert.ok(!JSON.stringify(region).includes('epa-conus'), 'a bounded region must not restate the CONUS layers');
});
