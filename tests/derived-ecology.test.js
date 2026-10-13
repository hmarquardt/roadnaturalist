import test from 'node:test';
import assert from 'node:assert/strict';

import { COVERAGE } from '../src/domain/corridor.js';
import { derivedCorridor, derivedMetrics, derivedUnit } from '../src/gis/derived-query.js';
import { buildDiscoveryResult } from '../src/discovery/signals.js';
import { naturalistInterest } from '../src/discovery/ranking.js';

// THE ECOLOGY THE PUBLISHED ROW ACTUALLY CARRIES REACHES THE DISCOVERY RESULT.
//
// The derived row stores the primary Level III and IV region plus `l3_count`, `l4_count` and `transition_count`;
// it does NOT store the names of the secondary regions. These tests prove the reader restores the counts honestly:
// no fabricated intersection list, no absent count silently read as one, and the ecological-variety component is no
// longer the same number for every corridor.

const GEOM = { type: 'LineString', coordinates: [[0, 0], [0.01, 0]] };

function row(overrides = {}) {
  const base = { corridor_id: 'drv1-example-rd-s1', road_component_id: 'drv1-example-rd',
    road_unit_id: 'drv1-example-rd', name: 'Example Rd', normalized_name: 'example rd', length_m: 1200,
    road_classes: ['S1400'], county_names: ['Example County'], counties: ['41051'],
    road_ids: ['tiger-2025-or-41051-example-rd'], source_feature_ids: ['1', '2'], segment_index: 1, segment_count: 1,
    geometry_repaired: false, geometry_repair_method: 'none', analysis_fingerprint: 'b'.repeat(64),
    primary_l3_code: '8', primary_l3_name: 'Cascades', primary_l3_percent: 62.5,
    primary_l4_code: '77C', primary_l4_name: 'Valley', primary_l4_percent: 44.4,
    l3_count: 1, l4_count: 1, transition_count: 0, ecology_coverage: COVERAGE.FULL,
    wetland_intersects: true, wetland_nearest_m: 40, wetland_area_250_m2: 100.5, wetland_area_500_m2: 400.5,
    wetland_area_1000_m2: 900.75, wetland_count_250: 1, wetland_count_500: 2, wetland_count_1000: 3,
    wetland_type_summary: 'Freshwater Forested/Shrub Wetland 900',
    hydro_crossing_count: 4, hydro_nearest_flowing_m: 0, hydro_nearest_standing_m: 220.5,
    hydro_flowline_length_1000_m: 640.25, hydro_waterbody_area_1000_m2: 120.5, hydro_summary: 'Johnson Creek',
    coverage: COVERAGE.FULL, coverage_wetlands_250: COVERAGE.FULL, coverage_wetlands_500: COVERAGE.FULL,
    coverage_wetlands_1000: COVERAGE.FULL, coverage_hydro_250: COVERAGE.FULL, coverage_hydro_500: COVERAGE.FULL,
    coverage_hydro_1000: COVERAGE.FULL };
  return { ...base, ...overrides };
}

function resultFor(overrides) {
  const record = row(overrides);
  const unit = derivedUnit(record, GEOM, [0, 0, 0.01, 0]);
  const corridor = derivedCorridor(record, unit.geometry, unit.bounds);
  return buildDiscoveryResult({ unit, corridor, metrics: derivedMetrics(record) });
}

test('one Level III and one Level IV region: no false multiplicity', () => {
  const metrics = derivedMetrics(row());
  assert.equal(metrics.ecology.level3.count, 1);
  assert.equal(metrics.ecology.level4.count, 1);
  assert.equal(metrics.ecology.ecoregionCount, 2, 'both distinct regions are counted, one per level');
  assert.equal(metrics.ecology.transitions, 0);
  assert.equal(metrics.ecology.spansMultiple, false);
  const result = resultFor();
  assert.equal(result.ecology.ecoregionCount, 2);
  assert.equal(result.ecology.transitions, 0);
  assert.equal(result.ecology.level3.count, 1);
  assert.equal(result.ecology.spansMultiple, false);
});

test('several Level IV regions under one Level III: the variety differs from a single region', () => {
  const many = derivedMetrics(row({ l3_count: 1, l4_count: 3, transition_count: 2 }));
  assert.equal(many.ecology.ecoregionCount, 4);
  assert.equal(many.ecology.transitions, 2);
  assert.equal(many.ecology.spansMultiple, true);
  const single = naturalistInterest(resultFor());
  const varied = naturalistInterest(resultFor({ l3_count: 1, l4_count: 3, transition_count: 2 }));
  assert.equal(single.components.ecologicalVariety.value, 30);
  assert.equal(varied.components.ecologicalVariety.value, 65);
  assert.ok(varied.components.ecologicalVariety.value > single.components.ecologicalVariety.value,
    'a corridor crossing Level IV boundaries is more varied than one that does not');
});

test('several Level III and Level IV regions are all counted, and each level keeps its own count', () => {
  const metrics = derivedMetrics(row({ l3_count: 2, l4_count: 3, transition_count: 3 }));
  assert.equal(metrics.ecology.level3.count, 2);
  assert.equal(metrics.ecology.level4.count, 3);
  assert.equal(metrics.ecology.ecoregionCount, 5, 'distinct regions at both levels, counted separately');
  assert.equal(metrics.ecology.transitions, 3);
  // The intersection list stays honest: only the primary's identity is stored, so it holds exactly one entry even
  // when the row says there are three regions.
  assert.equal(metrics.ecology.level4.intersections.length, 1);
  assert.equal(metrics.ecology.level4.primary.code, '77C');
});

test('the published transition count reaches the ranking input unchanged', () => {
  const result = resultFor({ l3_count: 1, l4_count: 8, transition_count: 7 });
  assert.equal(result.ecology.transitions, 7);
  assert.equal(result.ecology.level4.count, 8);
  const ranking = naturalistInterest(result);
  assert.equal(ranking.components.ecologicalVariety.detail.transitions, 7);
  assert.equal(ranking.components.ecologicalVariety.detail.ecoregionCount, 9);
});

test('an absent count is unknown, never one and never two', () => {
  const record = row({ l3_count: undefined, l4_count: undefined, transition_count: undefined });
  const metrics = derivedMetrics(record);
  assert.equal(metrics.ecology.level3.count, null, 'a missing count is not evidence of a single region');
  assert.equal(metrics.ecology.ecoregionCount, null);
  assert.equal(metrics.ecology.transitions, null, 'a missing transition count is unknown, not zero');
  const result = resultFor({ l3_count: undefined, l4_count: undefined, transition_count: undefined });
  assert.equal(result.ecology.ecoregionCount, null, 'the result builder must not invent two from a one-entry list');
  assert.equal(result.ecology.transitions, null, 'and must not invent zero transitions');
  assert.equal(result.ecology.level3.count, null);
});

test('a row that proves there is no ecology region reports none, and its variety is not scored', () => {
  const none = { primary_l3_code: null, primary_l4_code: null, l3_count: 0, l4_count: 0, transition_count: 0,
    ecology_coverage: COVERAGE.NONE };
  const metrics = derivedMetrics(row(none));
  assert.equal(metrics.ecology.ecoregionCount, 0, 'a stored count of zero is proof of none');
  assert.equal(metrics.ecology.coverage, COVERAGE.NONE);
  const result = resultFor(none);
  assert.equal(result.ecology.coverage, COVERAGE.NONE);
  const ranking = naturalistInterest(result);
  assert.ok(ranking.missing.includes('ecologicalVariety'), 'unmeasured ecology is omitted, never scored as zero');
  assert.equal(ranking.components.ecologicalVariety.value, null);
});

test('ecology coverage that is unknown stays unknown and is never scored', () => {
  const result = resultFor({ ecology_coverage: COVERAGE.UNKNOWN });
  assert.equal(result.ecology.coverage, COVERAGE.UNKNOWN);
  assert.ok(naturalistInterest(result).missing.includes('ecologicalVariety'));
});

test('the variety component is no longer the same number for every corridor', () => {
  const results = [resultFor(), resultFor({ l3_count: 1, l4_count: 3, transition_count: 2 }),
    resultFor({ l3_count: 2, l4_count: 3, transition_count: 3 }),
    resultFor({ l3_count: 1, l4_count: 1, transition_count: 0 })];
  const values = results.map(result => naturalistInterest(result).components.ecologicalVariety.value);
  assert.deepEqual(values, [30, 65, 72, 30]);
  assert.ok(new Set(values).size >= 2, `the component must vary across a mixed set (got ${values.join(',')})`);
});

test('the raw analysis path is unchanged: with no explicit counts, the intersection list still decides', () => {
  const record = row();
  const unit = derivedUnit(record, GEOM, [0, 0, 0.01, 0]);
  const corridor = derivedCorridor(record, unit.geometry, unit.bounds);
  const intersections = [{ code: 'A', name: 'Alpha', percent: 60 }, { code: 'B', name: 'Beta', percent: 40 }];
  const metrics = { wetlands: null, hydrography: null,
    ecology: { coverage: COVERAGE.FULL, spansMultiple: true,
      level3: { primary: intersections[0], intersections, coverage: COVERAGE.FULL },
      level4: { primary: intersections[0], intersections: [intersections[0]], coverage: COVERAGE.FULL } } };
  const result = buildDiscoveryResult({ unit, corridor, metrics });
  assert.equal(result.ecology.ecoregionCount, 3, 'two Level III codes plus one Level IV code');
  assert.equal(result.ecology.transitions, 1, 'one boundary beyond the first Level III region');
  assert.equal(result.ecology.spansMultiple, true);
});


test('a derived row and the raw intersection list agree on the ecology counts', () => {
  // The contract the derived reader must satisfy: for the same corridor, a derived row whose stored counts match a
  // raw analysis's intersection lists produces the SAME ecology numbers. Otherwise the precomputed plane and a raw
  // re-measurement would disagree about the same road.
  const record = row({ l3_count: 2, l4_count: 1, transition_count: 1 });
  const unit = derivedUnit(record, GEOM, [0, 0, 0.01, 0]);
  const corridor = derivedCorridor(record, unit.geometry, unit.bounds);
  const derived = buildDiscoveryResult({ unit, corridor, metrics: derivedMetrics(record) });
  const alpha = { code: 'A', name: 'Alpha', percent: 60 };
  const beta = { code: 'B', name: 'Beta', percent: 40 };
  const raw = buildDiscoveryResult({ unit, corridor, metrics: { wetlands: null, hydrography: null,
    ecology: { coverage: COVERAGE.FULL, spansMultiple: true,
      level3: { primary: alpha, intersections: [alpha, beta], coverage: COVERAGE.FULL },
      level4: { primary: alpha, intersections: [alpha], coverage: COVERAGE.FULL } } } });
  assert.equal(derived.ecology.ecoregionCount, raw.ecology.ecoregionCount);
  assert.equal(derived.ecology.transitions, raw.ecology.transitions);
  assert.equal(derived.ecology.ecoregionCount, 3);
});

