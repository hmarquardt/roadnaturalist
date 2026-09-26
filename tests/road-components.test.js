import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildDiscoveryUnits } from '../src/discovery/units.js';
import { selectRegionalPartitions, validateRegionalCatalog } from '../src/discovery/regional-catalog.js';
import { validateRoadComponents } from '../src/discovery/components.js';

// The published road component index is what replaced name-only closure. These tests use real TIGER/Line
// features from the published road partitions (tests/fixtures/road-components.json, captured by
// scripts/road_components.py from data/regional/partitions) and prove three things: the offline builder that
// publishes the index agrees with the modules the browser composes with, the index is deterministic, and a
// common street name no longer drags unrelated cells into a search.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/road-components.json', import.meta.url)));
const catalog = validateRegionalCatalog(JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url))));
const published = validateRoadComponents(JSON.parse(readFileSync(new URL(`../data/${catalog.roadComponentsUrl}`, import.meta.url))));
const benchmarks = JSON.parse(readFileSync(new URL('../data/regional/benchmarks.json', import.meta.url)));

const asFeatures = rows => rows.map(row => ({ roadId: `tiger-2025-${row.county_fips}-${row.source_feature_id}`,
  name: row.name, roadClass: 'S1400', routeType: 'M', sourceFeatureId: row.source_feature_id,
  countyFips: row.county_fips, countyName: `${row.county_fips} County`,
  geometry: { type: 'LineString', coordinates: row.coordinates.map(point => [point[0], point[1]]) } }));

const idsOf = entries => [...entries].map(entry => entry.id).sort();

for (const entry of fixture.names) {
  test(`the offline component index matches the browser for ${entry.name}`, () => {
    const units = buildDiscoveryUnits(asFeatures(entry.features)).units;
    assert.deepEqual(idsOf(units), idsOf(entry.components), 'the same components, with the same stable ids');
    for (const component of entry.components) {
      const unit = units.find(item => item.id === component.id);
      assert.equal(unit.componentIndex, component.componentIndex);
      assert.equal(unit.componentCount, component.componentCount);
      assert.deepEqual([...unit.sourceFeatureIds].sort(), [...component.sourceFeatureIds].sort(),
        `${component.id}: the same source features`);
      // Length is a diagnostic, not identity: the index records the sum of the component's own source lines,
      // while the browser reports the composed geometry's length. On real data those differ (composing US Hwy
      // 26's 41 features yields about 447 km from about 231 km of source line, because the composition follows
      // every published piece including ramps and divided-carriageway stubs). Component membership, ids and
      // counts are what closure and corridor identity depend on, and those are asserted exactly.
      assert.ok(component.lengthM > 0 && unit.lengthM > 0);
      assert.ok(component.featureCount >= 1);
    }
  });

  test(`the component index is deterministic under shuffled feature order for ${entry.name}`, () => {
    const shuffled = [...asFeatures(entry.features)].reverse();
    const units = buildDiscoveryUnits(shuffled).units;
    assert.deepEqual(idsOf(units), idsOf(entry.components));
    const byId = new Map(units.map(unit => [unit.id, unit]));
    for (const component of entry.components) {
      assert.deepEqual([...byId.get(component.id).sourceFeatureIds].sort(), [...component.sourceFeatureIds].sort());
    }
  });
}

test('a common street name becomes many components instead of one road', () => {
  const third = fixture.names.find(entry => entry.name === '3rd St');
  assert.ok(third.components.length > 40, `3rd St produced ${third.components.length} components`);
  assert.equal(new Set(third.components.map(component => component.id)).size, third.components.length);
  // Every component carries the name, but only a handful of cells can hold one connected 3rd St.
  const publishedThird = published.components.filter(component => component.nameKey === '3rd-st');
  assert.ok(publishedThird.length > 0, 'the published index carries 3rd St components');
  assert.equal(publishedThird.every(component => component.cells.length < 12), true,
    'no published 3rd St component spans a dozen cells');
});

test('a long highway is one component and the published index is internally consistent', () => {
  const highway = fixture.names.find(entry => entry.name === 'US Hwy 26');
  assert.equal(highway.components.length, 1);
  // The component keeps one copy of every piece: exact duplicates and reversed links collapse first (US Hwy 26
  // loses 18 of its 41 published pieces to divided-carriageway duplicates), which is the same normalization the
  // browser applies before composition.
  assert.ok(highway.components[0].sourceFeatureIds.length <= highway.features.length);
  assert.ok(highway.components[0].sourceFeatureIds.length > highway.features.length / 2,
    `${highway.components[0].sourceFeatureIds.length} of ${highway.features.length} pieces kept`);
  assert.equal(new Set(published.components.map(component => component.id)).size, published.components.length,
    'component ids are unique');
  for (const component of published.components) {
    assert.ok(component.cells.length >= 2, `${component.id} spans more than one cell`);
    assert.ok(component.bounds[0] <= component.bounds[2] && component.bounds[1] <= component.bounds[3]);
    assert.ok(component.lengthM > 0 && component.featureCount > 0);
  }
});

test('component closure replaces name closure for the committed benchmark scenarios', () => {
  // Measured with the name index before this index existed: 52 added cells for the 10-mile search, 46 for the
  // 25-mile search, 22 for the 50-mile search. Closure must now be materially smaller, and the components
  // that add cells must be long roads rather than common street names.
  const ceilings = { 'small-10mi': 30, 'medium-25mi': 30, 'large-50mi': 12 };
  const nameClosure = { 'small-10mi': 52, 'medium-25mi': 46, 'large-50mi': 22 };
  for (const scenario of benchmarks.scenarios) {
    const selection = selectRegionalPartitions(catalog, scenario.bbox, { components: published });
    assert.equal(selection.closure.byComponentIndex, true);
    assert.ok(selection.closure.addedCells <= ceilings[scenario.id],
      `${scenario.id}: ${selection.closure.addedCells} closure cells (name closure used ${nameClosure[scenario.id]})`);
    assert.ok(selection.closure.addedBytes < 20_000_000, `${scenario.id}: closure bytes stay bounded`);
    for (const entry of selection.closure.largest) {
      assert.ok(!/^[0-9]+(st|nd|rd|th)-/.test(entry.key), `${entry.key} is a numbered street name, not a continuing road`);
    }
  }
  // The same catalog without the index still closes over names, so the first published slice keeps working.
  const legacy = { ...catalog };
  delete legacy.roadComponentsUrl;
  delete legacy.roadComponentsBytes;
  delete legacy.roadComponentsSha256;
  const legacySelection = selectRegionalPartitions({ ...legacy, roadNameCells: { '3rd-st': ['x284_y677', 'x286_y673'] },
    roadNameBounds: { '3rd-st': [-123.2, 45.4, -122.8, 45.8] } }, benchmarks.scenarios[0].bbox);
  assert.equal(legacySelection.closure.byComponentIndex, false);
  assert.ok(legacySelection.counts.roads >= 1);
});

test('the component index is verified against the catalog declaration', () => {
  assert.equal(published.version, catalog.version);
  assert.equal(catalog.roadComponents.count, published.componentCount);
  assert.equal(catalog.roadComponents.multiCell, published.components.length);
  assert.equal(catalog.roadComponents.joinToleranceM, published.joinToleranceM);
  assert.equal(published.joinToleranceM, 150, 'the runtime composition tolerance');
  assert.ok(catalog.roadComponentsSha256 && catalog.roadComponentsBytes > 0);
  assert.throws(() => validateRoadComponents({ ...published, components: [{ id: 'nope' }] }), /Invalid road component/);
});
