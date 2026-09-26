import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ANALYSIS_PROFILE_VERSION, DERIVED_SCHEMA_VERSION, analysisFingerprint, canonicalJson, sha256Hex } from '../src/discovery/analysis-fingerprint.js';
import { selectRegionalPartitions, validateRegionalCatalog } from '../src/discovery/regional-catalog.js';
import { validateRoadComponents } from '../src/discovery/components.js';
import { validateManifest } from '../src/services/manifest.js';

// Derived corridor metrics are only trustworthy while they describe the current rules, so the fingerprint is
// the artifact's identity: a material semantic change must invalidate it, and a deployment detail must not.
const catalog = validateRegionalCatalog(JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url))));
const manifest = validateManifest(JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url))));
const components = validateRoadComponents(JSON.parse(readFileSync(new URL(`../data/${catalog.roadComponentsUrl}`, import.meta.url))));
const committed = JSON.parse(readFileSync(new URL('../data/regional/analysis-profile.json', import.meta.url)));

const inputs = () => ({ regionalCatalog: JSON.parse(JSON.stringify(catalog)), manifest: JSON.parse(JSON.stringify(manifest)),
  roadComponents: JSON.parse(JSON.stringify(components)) });
const fingerprintOf = async mutate => {
  const value = inputs();
  if (mutate) mutate(value);
  const { profile, fingerprint } = await analysisFingerprint(value);
  return { fingerprint, profile };
};

test('the committed analysis profile is current and deterministic', async () => {
  const first = await fingerprintOf();
  const second = await fingerprintOf();
  assert.equal(first.fingerprint, second.fingerprint, 'same inputs, same fingerprint');
  assert.equal(first.profile.profileVersion, ANALYSIS_PROFILE_VERSION);
  assert.equal(first.profile.derivedSchemaVersion, DERIVED_SCHEMA_VERSION);
  assert.deepEqual({ ...first.profile, fingerprint: committed.fingerprint }, committed,
    'data/regional/analysis-profile.json describes the shipped code: regenerate it with node scripts/write-analysis-profile.mjs');
});

test('the fingerprint carries no build, deployment or origin data', async () => {
  const { profile } = await fingerprintOf();
  const text = canonicalJson(profile);
  for (const forbidden of ['stagedAt', 'deployedAt', 'deploymentId', 'assetBaseUrl', 'https://', 'timestamp']) {
    assert.equal(text.includes(forbidden), false, `${forbidden} must not be part of the analysis fingerprint`);
  }
  // Options a caller happens to pass are not inputs either.
  const noisy = await analysisFingerprint({ ...inputs(), deployedAt: '2026-01-01T00:00:00Z',
    assetBaseUrl: 'https://data.roadnaturalist.com/', deploymentId: 'deadbeef' });
  const clean = await fingerprintOf();
  assert.equal(noisy.fingerprint, clean.fingerprint);
});

const materialChanges = [
  ['wetland dataset version', value => { value.regionalCatalog.datasets.find(dataset => dataset.id === 'wetlands').version = 'nwi-other-v9'; }],
  ['wetland partition digest', value => { value.regionalCatalog.datasets.find(dataset => dataset.id === 'wetlands').partitions[0].sha256 = 'b'.repeat(64); }],
  ['hydrography dataset version', value => { value.regionalCatalog.datasets.find(dataset => dataset.id === 'hydrography').version = 'nhd-other-v9'; }],
  ['road partition digest', value => { value.regionalCatalog.datasets.find(dataset => dataset.id === 'roads').partitions[0].sha256 = 'c'.repeat(64); }],
  ['road component index digest', value => { value.regionalCatalog.roadComponentsSha256 = 'd'.repeat(64); }],
  ['ecoregion version', value => { value.manifest.datasets.find(dataset => dataset.id === 'epa-ecoregions-or-l3').version = 'epa-other-v9'; }],
  ['ecoregion digest', value => { value.manifest.datasets.find(dataset => dataset.id === 'epa-ecoregions-wa-l4').sha256 = 'e'.repeat(64); }],
  ['region version', value => { value.regionalCatalog.version = 'or-sw-wa-portland-v3'; }],
  ['region bounds', value => { value.regionalCatalog.region.bounds = [-124.05, 44.75, -121.77, 46.5]; }],
];

for (const [label, mutate] of materialChanges) {
  test(`a material change invalidates the fingerprint: ${label}`, async () => {
    const base = await fingerprintOf();
    const changed = await fingerprintOf(mutate);
    assert.notEqual(changed.fingerprint, base.fingerprint);
  });
}

test('segmentation, repair, distances, metric semantics and schema version are all in the fingerprint', async () => {
  const base = await fingerprintOf();
  const mutations = [
    value => { value.regionalCatalog.maxAnalysisDistanceM = 2000; },
  ];
  for (const mutate of mutations) assert.notEqual((await fingerprintOf(mutate)).fingerprint, base.fingerprint);
  // The profile itself is the input for the rest: changing one field of it must change the digest.
  const tweaks = {
    segmentation: profile => { profile.segmentation = { ...profile.segmentation, maxCorridorM: 9000 }; },
    repair: profile => { profile.analyticalGeometry = { ...profile.analyticalGeometry, tolerance: { ...profile.analyticalGeometry.tolerance, maxDisplacementM: 0.1 } }; },
    distances: profile => { profile.analysisDistancesM = [250, 500, 1500]; },
    metrics: profile => { profile.metrics = { ...profile.metrics, wetlandArea: 'spatial-union-v1' }; },
    schema: profile => { profile.derivedSchemaVersion = DERIVED_SCHEMA_VERSION + 1; },
    composition: profile => { profile.composition = { ...profile.composition, toleranceM: 200 }; },
  };
  for (const [label, tweak] of Object.entries(tweaks)) {
    const profile = JSON.parse(JSON.stringify(base.profile));
    tweak(profile);
    assert.notEqual(await sha256Hex(canonicalJson(profile)), base.fingerprint, `${label} must change the fingerprint`);
  }
});

test('canonical JSON is stable under key order and drops nothing', async () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
  assert.equal(await sha256Hex('x'), await sha256Hex('x'));
  assert.notEqual(await sha256Hex('x'), await sha256Hex('y'));
});

test('the partition digest tracks membership, not the asset origin', async () => {
  const first = await fingerprintOf();
  const reordered = await fingerprintOf(value => {
    const dataset = value.regionalCatalog.datasets.find(entry => entry.id === 'roads');
    dataset.partitions = [...dataset.partitions].reverse();
    dataset.partitions.forEach(part => { part.url = `mirror/${part.url}`; });
  });
  assert.equal(reordered.fingerprint, first.fingerprint, 'reordering partitions or moving the origin is not a semantic change');
});

// The selection the derived layer will mirror must keep working while the profile changes.
test('partition selection is unaffected by the profile machinery', () => {
  const selection = selectRegionalPartitions(catalog, [-123.14, 45.48, -122.70, 45.71], { components });
  assert.equal(selection.closure.byComponentIndex, true);
  assert.ok(selection.bytes > 0);
});
