import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NATIONAL_CATALOG_KIND, isNationalCatalog, validateNationalDerivedCatalog } from '../src/discovery/national-catalog.js';
import { assertNationalDerivedCompatibility } from '../src/gis/service.js';
import { DERIVED_COLUMNS } from '../src/gis/derived-query.js';
import { ANALYSIS_PROFILE_VERSION, DERIVED_SCHEMA_VERSION } from '../src/discovery/analysis-fingerprint.js';
import { validateSearchAreas } from '../src/discovery/search-area.js';
import { validateRegionalCatalog } from '../src/discovery/regional-catalog.js';

// The national derived discovery catalog: the production discovery pointer.
//
// It is a pointer, not a second truth. These tests hold the two contracts that make it safe to cut production
// discovery over to it: the committed pointer must describe a real immutable plane (its fingerprint, its
// manifest URL, its region), and the runtime must still fail closed on everything it can check even though the
// browser cannot recompute the national fingerprint (which also covers the Python builder).
const catalog = validateNationalDerivedCatalog(JSON.parse(readFileSync(new URL('../data/national/derived-catalog.json', import.meta.url))));
const declaration = JSON.parse(readFileSync(new URL('../data/discovery/search-areas.json', import.meta.url)));
const regional = validateRegionalCatalog(JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url))));

function syntheticManifest(overrides = {}) {
  return { kind: 'road-derived-corridor-metrics', schemaVersion: 1, analysisFingerprint: catalog.derived.analysisFingerprint,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION, profileVersion: ANALYSIS_PROFILE_VERSION,
    region: { id: catalog.region.id, bounds: [...catalog.region.bounds] }, grid: { kind: 'lonlat-grid' },
    schema: [...DERIVED_COLUMNS, 'road_length_m'], cells: [], ...overrides };
}

test('the committed national catalog is a valid derived-first discovery pointer', () => {
  assert.equal(catalog.kind, NATIONAL_CATALOG_KIND);
  assert.equal(isNationalCatalog(catalog), true);
  assert.equal(isNationalCatalog(regional), false);
  assert.equal(catalog.derived.manifestUrl,
    `derived/corridor-metrics/${catalog.derived.analysisFingerprint}/manifest.json`);
  assert.equal(catalog.derived.analysisFingerprint, 'a13a883c16f6d6e897407eab0de325ea355f5edeb292ecfb36b092f9ea959ee9');
  assert.equal(catalog.derived.presentCells, 20862);
  assert.equal(catalog.derived.emptyCells, 1012);
  assert.equal(catalog.derived.bytes, 2674237129);
  assert.equal(catalog.assetBaseUrl, 'https://data.roadnaturalist.com/');
});

test('a malformed pointer is refused, not silently accepted', () => {
  assert.throws(() => validateNationalDerivedCatalog({ ...catalog, kind: 'something-else' }), /Not a national/);
  assert.throws(() => validateNationalDerivedCatalog({ ...catalog, assetBaseUrl: 'http://data.roadnaturalist.com/' }), /asset base URL/);
  const wrongUrl = { ...catalog, derived: { ...catalog.derived, manifestUrl: `derived/corridor-metrics/${'0'.repeat(64)}/manifest.json` } };
  assert.throws(() => validateNationalDerivedCatalog(wrongUrl), /does not match its analysis fingerprint/);
  assert.throws(() => validateNationalDerivedCatalog({ ...catalog, region: { ...catalog.region, bounds: [0, 0, 0, 0] } }), /published region/);
  assert.throws(() => validateNationalDerivedCatalog({ ...catalog, maxAnalysisDistanceM: 500 }), /analysis halo/);
});

test('the declaration classifies a search against the national region while the gazetteer keeps its window', () => {
  const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url)));
  const declared = validateSearchAreas(declaration, manifest);
  // The runtime selects cells against the national catalog's region; the interface classifies against the
  // declaration's discoveryRegion; a release step asserts the two agree (scripts/stage-pages.mjs).
  assert.deepEqual(declared.discoveryRegion.bounds, catalog.region.bounds);
  // The window the raw regional material and the place gazetteer were built for is unchanged.
  assert.deepEqual(declared.publishedRegion.bounds, regional.region.bounds);
  const template = declared.searchAreas.find(area => area.id === declared.interactiveRadiusArea);
  assert.equal(template.catalogUrl, 'national/derived-catalog.json');
  assert.equal(template.derivedOnly, true);
});

test('the runtime fails closed on everything it can still check about the national plane', () => {
  assert.doesNotThrow(() => assertNationalDerivedCompatibility(syntheticManifest(), catalog));
  assert.throws(() => assertNationalDerivedCompatibility(syntheticManifest({ profileVersion: 99 }), catalog), /analysis profile\/schema/);
  assert.throws(() => assertNationalDerivedCompatibility(syntheticManifest({ derivedSchemaVersion: 99 }), catalog), /analysis profile\/schema/);
  assert.throws(() => assertNationalDerivedCompatibility(syntheticManifest({ region: { id: 'x', bounds: [0, 0, 1, 1] } }), catalog),
    /does not cover the region/);
  const missingColumn = syntheticManifest({ schema: DERIVED_COLUMNS.filter(column => column !== 'wetland_area_250_m2') });
  assert.throws(() => assertNationalDerivedCompatibility(missingColumn, catalog), /missing columns.*wetland_area_250_m2/);
});

test('the committed pointer agrees with the finalized plane when that plane is present', () => {
  const build = process.env.ROADNATURALIST_BUILD_VOLUME ?? '/Volumes/Lexar/roadnaturalist';
  const manifestPath = join(build, 'cells/derived/corridor-metrics', catalog.derived.analysisFingerprint, 'manifest.json');
  if (!existsSync(manifestPath)) return; // the plane is build output; it need not be in every checkout
  const bytes = readFileSync(manifestPath);
  assert.equal(bytes.length, catalog.derived.manifestBytes, 'the catalog manifest byte count disagrees with the plane');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), catalog.derived.manifestSha256,
    'the catalog manifest digest disagrees with the plane: regenerate it with scripts/freeze-national-derived-catalog.mjs');
});

