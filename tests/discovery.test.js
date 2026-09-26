import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { classifyFeature, DISCOVERY_DISPOSITION, ELIGIBILITY_SOURCE, ROAD_CLASS_ELIGIBILITY, eligibleClasses, eligibilitySummary } from '../src/discovery/eligibility.js';
import { buildDiscoveryUnits, normalizeRoadName } from '../src/discovery/units.js';
import { segmentationCount, segmentUnit } from '../src/discovery/segment.js';
import { MIN_CORRIDOR_M, TARGET_CORRIDOR_M, MAX_CORRIDOR_M, MAX_RESULT_ROWS, JOIN_TOLERANCE_M } from '../src/discovery/constants.js';
import { endpointGapM } from '../src/roads/normalize.js';
import { DEFAULT_SORT, DEFAULT_SORT_NOTE, coverageFlag, filterResults, sortResults, SORT_OPTIONS } from '../src/discovery/filter.js';
import { combineDiscoveryCoverage, summarizeDiscoveryCoverage } from '../src/discovery/coverage.js';
import { buildDiscoveryResult } from '../src/discovery/signals.js';
import { DISCOVERY_STATUS, NO_DECLARED_SOURCES, applyMarks, markDiscovery, normalizeMarks, promoteDiscoveryResult, statusFor } from '../src/discovery/lifecycle.js';
import { DISCOVERY_MARKS_KEY, readDiscoveryMarks, writeDiscoveryMarks } from '../src/discovery/persistence.js';
import { validateSearchAreas } from '../src/discovery/search-area.js';
import { PILOT_PROBES_BY_CORRIDOR, PROBE_CATALOG } from '../src/investigator/sources.js';
import { runDiscovery } from '../src/discovery/run.js';
import { corridorGeometry } from '../src/domain/geometry.js';
import { createDiscoveryQueries } from '../src/gis/discovery-query.js';
import { createAnalyticalGeometryQueries } from '../src/gis/analytical-geometry.js';
import { validateManifest } from '../src/services/manifest.js';
import { COVERAGE, COVERAGE_DATASET } from '../src/domain/corridor.js';

const manifest = validateManifest(JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url))));
const network = manifest.datasets.find(dataset => dataset.id === 'or-roads-network-pilot');
const summary = JSON.parse(readFileSync(new URL('./fixtures/or-roads-network.summary.json', import.meta.url)));
const searchAreas = JSON.parse(readFileSync(new URL('../data/discovery/search-areas.json', import.meta.url)));
const MI = 1609.344;
// One degree of longitude at 45.5 N, the pilot window's latitude: enough to build synthetic corridors
// of a known length without leaving the domain's valid coordinate range.
const LON_PER_M = 1 / (111320 * Math.cos(45.5 * Math.PI / 180));

function line(distanceM, { lon = -123, lat = 45.5, segments = 10 } = {}) {
  return Array.from({ length: segments + 1 }, (_, index) => [lon + distanceM * index / segments * LON_PER_M, lat]);
}

function feature(overrides = {}) {
  return { roadId: 'tiger-2025-or-41067-example-rd', name: 'NW Example Rd', roadClass: 'S1400', routeType: 'M',
    countyFips: '41067', countyName: 'Washington County, Oregon', sourceFeatureId: 'f1',
    geometry: { type: 'LineString', coordinates: line(1000) }, ...overrides };
}

// ---------------------------------------------------------------- road eligibility

test('road eligibility is an explicit, sourced TIGER class decision, not an access claim', () => {
  assert.equal(eligibleClasses().join(','), 'S1200,S1400');
  assert.equal(ELIGIBILITY_SOURCE.organization, 'U.S. Census Bureau');
  assert.match(ELIGIBILITY_SOURCE.document, /MTFCC/);
  for (const code of ['S1100', 'S1200', 'S1400', 'S1500', 'S1630', 'S1640', 'S1710', 'S1720', 'S1730', 'S1740', 'S1750', 'S1780', 'S1810', 'S1820', 'S1830']) {
    const rule = ROAD_CLASS_ELIGIBILITY[code];
    assert.ok(rule, `${code} is missing from the eligibility table`);
    assert.ok(rule.definition.length > 20, `${code} needs the published definition`);
    assert.ok(rule.reason.length > 10, `${code} needs a reviewable reason`);
  }
  assert.equal(ROAD_CLASS_ELIGIBILITY.S1100.disposition, DISCOVERY_DISPOSITION.EXCLUDED);
  assert.equal(ROAD_CLASS_ELIGIBILITY.S1500.disposition, DISCOVERY_DISPOSITION.SEPARATE);
  const classification = classifyFeature(feature());
  assert.equal(classification.eligibleForDiscovery, true);
  assert.match(classification.eligibilityReason, /eligible local road \(S1400\)/);
  assert.equal(classification.classLabel, 'Local road');
  assert.equal(classifyFeature(feature({ roadClass: 'S1100' })).eligibleForDiscovery, false);
  assert.match(classifyFeature(feature({ roadClass: 'S1100' })).eligibilityReason, /limited-access/);
  assert.equal(classifyFeature(feature({ roadClass: 'S1500', name: '' })).disposition, DISCOVERY_DISPOSITION.SEPARATE);
  assert.equal(classifyFeature(feature({ roadClass: 'S9999' })).eligibleForDiscovery, false);
  assert.match(classifyFeature(feature({ roadClass: 'S9999' })).eligibilityReason, /unrecognized TIGER road class/);
  assert.equal(classifyFeature(feature({ roadClass: '' })).eligibleForDiscovery, false);
  assert.equal(classifyFeature(feature({ name: '' })).eligibleForDiscovery, false);
  assert.match(classifyFeature(feature({ name: '' })).eligibilityReason, /no source road name/);
  // Eligibility never claims anything about access.
  assert.doesNotMatch(JSON.stringify(ROAD_CLASS_ELIGIBILITY), /public access|may drive/i);
});

test('an eligibility summary counts what was proposed and what was not', () => {
  const summary = eligibilitySummary([feature(), feature({ sourceFeatureId: 'f2', roadClass: 'S1630' }),
    feature({ sourceFeatureId: 'f3', roadClass: 'S1400', name: '' })]);
  const keys = summary.map(entry => entry.key);
  assert.ok(keys.includes('ELIGIBLE'));
  assert.ok(keys.some(key => key.startsWith('EXCLUDED: S1630')));
  assert.equal(summary.reduce((total, entry) => total + entry.count, 0), 3);
});

// ---------------------------------------------------------------- discovery road units

test('source features become deterministic named-road units', () => {
  const features = [
    feature({ sourceFeatureId: 'a', geometry: { type: 'LineString', coordinates: line(1000, { lon: -123 }) } }),
    feature({ sourceFeatureId: 'b', geometry: { type: 'LineString', coordinates: line(1000, { lon: -123 + 1000 * LON_PER_M }) } }),
    feature({ sourceFeatureId: 'c', roadClass: 'S1630', geometry: { type: 'LineString', coordinates: line(500) } }),
    feature({ sourceFeatureId: 'd', name: '', geometry: { type: 'LineString', coordinates: line(500) } }),
  ];
  const built = buildDiscoveryUnits(features);
  assert.equal(built.units.length, 1);
  const [unit] = built.units;
  assert.equal(unit.id, 'drv1-nw-example-rd');
  assert.deepEqual([...unit.sourceFeatureIds].sort(), ['a', 'b']);
  assert.equal(unit.composition.usedFeatureCount, 2);
  assert.equal(unit.composition.maxUnresolvedGapM, null, 'touching features are one contiguous unit');
  assert.ok(Math.abs(unit.lengthM - 2000) < 5, `unit length ${unit.lengthM}`);
  assert.equal(built.blocked.length, 2);
  assert.ok(built.blocked.some(entry => /Ramps are interchange connectors/.test(entry.reason)));
  assert.ok(built.blocked.some(entry => /no source road name/.test(entry.reason)));
});

test('exact and reversed duplicate features collapse, and the count is reported', () => {
  const first = feature({ sourceFeatureId: 'a', geometry: { type: 'LineString', coordinates: line(1000) } });
  const duplicate = feature({ sourceFeatureId: 'b', geometry: { type: 'LineString', coordinates: line(1000) } });
  const reversed = feature({ sourceFeatureId: 'c', geometry: { type: 'LineString', coordinates: [...line(1000)].reverse() } });
  const built = buildDiscoveryUnits([first, duplicate, reversed, feature({ sourceFeatureId: 'd',
    geometry: { type: 'LineString', coordinates: line(1000, { lon: -123 + 1000 * LON_PER_M }) } })]);
  assert.equal(built.units.length, 1);
  assert.equal(built.units[0].composition.usedFeatureCount, 2);
  // The reversed copy is an exact reversed duplicate, so it is removed as a duplicate rather than as a
  // nearly-reversed junction link.
  assert.equal(built.units[0].composition.duplicatesRemoved, 2);
  assert.equal(built.units[0].composition.collapsedReversedLinks, 0);
});

test('two features digitizing one junction link in opposite directions collapse to the longer one', () => {
  const long = feature({ sourceFeatureId: 'a', geometry: { type: 'LineString', coordinates: line(1000) } });
  // A reversed copy that is slightly shorter and slightly offset: the same stretch of road twice.
  const nearly = feature({ sourceFeatureId: 'b', geometry: { type: 'LineString',
    coordinates: [...line(950)].reverse().map(([lon, lat]) => [lon + 5 * LON_PER_M, lat]) } });
  const built = buildDiscoveryUnits([long, nearly, feature({ sourceFeatureId: 'c',
    geometry: { type: 'LineString', coordinates: line(1000, { lon: -123 + 1000 * LON_PER_M }) } })]);
  assert.equal(built.units.length, 1);
  assert.equal(built.units[0].composition.collapsedReversedLinks, 1);
  assert.equal(built.units[0].sourceFeatureIds.length, 2);
});

test('same-name roads that do not touch become separate units with stable ids', () => {
  const built = buildDiscoveryUnits([
    feature({ sourceFeatureId: 'a', geometry: { type: 'LineString', coordinates: line(2000, { lon: -123 }) } }),
    feature({ sourceFeatureId: 'b', roadId: 'tiger-2025-or-41051-example-rd', countyFips: '41051',
      countyName: 'Multnomah County, Oregon', geometry: { type: 'LineString', coordinates: line(2000, { lon: -122.8 }) } }),
  ]);
  assert.equal(built.units.length, 2);
  assert.deepEqual(built.units.map(unit => unit.id), ['drv1-nw-example-rd-c1', 'drv1-nw-example-rd-c2']);
  assert.equal(built.units[0].composition.maxUnresolvedGapM, null);
  // Rebuilding from a shuffled feature list yields identical ids and geometry.
  const shuffled = buildDiscoveryUnits([feature({ sourceFeatureId: 'b', roadId: 'tiger-2025-or-41051-example-rd',
    countyFips: '41051', countyName: 'Multnomah County, Oregon', geometry: { type: 'LineString', coordinates: line(2000, { lon: -122.8 }) } }),
    feature({ sourceFeatureId: 'a', geometry: { type: 'LineString', coordinates: line(2000, { lon: -123 }) } })]);
  assert.deepEqual(shuffled.units.map(unit => unit.id), built.units.map(unit => unit.id));
  assert.deepEqual(shuffled.units.map(unit => unit.geometry), built.units.map(unit => unit.geometry));
});

test('a road that crosses the county line becomes one unit holding both counties', () => {
  const built = buildDiscoveryUnits([
    feature({ sourceFeatureId: 'a', roadId: 'tiger-2025-or-41067-nw-example-rd', countyFips: '41067',
      geometry: { type: 'LineString', coordinates: line(1000, { lon: -123 }) } }),
    feature({ sourceFeatureId: 'b', roadId: 'tiger-2025-or-41051-nw-example-rd', countyFips: '41051',
      countyName: 'Multnomah County, Oregon', geometry: { type: 'LineString', coordinates: line(1000, { lon: -123 + 1000 * LON_PER_M }) } }),
  ]);
  assert.equal(built.units.length, 1);
  assert.deepEqual([...built.units[0].countyFips], ['41051', '41067']);
  assert.equal(built.units[0].roadIds.length, 2);
  assert.equal(built.units[0].componentCount, 1);
});

test('road names normalize to one key without inventing equality', () => {
  assert.equal(normalizeRoadName('NW Cornelius Pass Rd'), 'nw-cornelius-pass-rd');
  assert.equal(normalizeRoadName('nw  cornelius pass rd '), 'nw-cornelius-pass-rd');
  assert.equal(normalizeRoadName('NW 1st Ave'), 'nw-1st-ave');
  assert.notEqual(normalizeRoadName('NW 1st Ave'), normalizeRoadName('NW 1 St Ave'));
  const built = buildDiscoveryUnits([feature({ name: 'NW CORNELIUS PASS RD' }), feature({ sourceFeatureId: 'b',
    name: 'NW Cornelius Pass Rd', geometry: { type: 'LineString', coordinates: line(1000, { lon: -123 + 1000 * LON_PER_M }) } })]);
  assert.equal(built.units.length, 1);
  // Exactly one spelling each: the tie breaks byte-wise, so the choice is stable and documented.
  assert.equal(built.units[0].name, 'NW CORNELIUS PASS RD');
});

test('an unnamed or unrecognized road is never silently dropped', () => {
  const built = buildDiscoveryUnits([feature({ name: '' }), feature({ sourceFeatureId: 'b', roadClass: 'S9999' })]);
  assert.equal(built.units.length, 0);
  assert.equal(built.blocked.reduce((total, entry) => total + entry.count, 0), 2);
  assert.equal(built.eligibleFeatureCount, 0);
});

test('a non-line geometry is rejected instead of guessed', () => {
  assert.throws(() => buildDiscoveryUnits([feature({ geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] } })]),
    /must be GeoJSON LineStrings/);
});


test('the most frequent published spelling wins, not the first one seen', () => {
  const built = buildDiscoveryUnits([
    feature({ sourceFeatureId: 'a', name: 'NW Cornelius Pass RD' }),
    feature({ sourceFeatureId: 'b', name: 'NW Cornelius Pass Rd', geometry: { type: 'LineString', coordinates: line(1000, { lon: -123 + 1000 * LON_PER_M }) } }),
    feature({ sourceFeatureId: 'c', name: 'NW Cornelius Pass Rd', geometry: { type: 'LineString', coordinates: line(1000, { lon: -123 + 2000 * LON_PER_M }) } }),
  ]);
  assert.equal(built.units.length, 1);
  assert.equal(built.units[0].name, 'NW Cornelius Pass Rd');
});

// ---------------------------------------------------------------- segmentation

test('a long named road is divided into contiguous analysis corridors', () => {
  const unit = { id: 'drv1-long-rd', name: 'Long Rd', geometry: { type: 'LineString', coordinates: line(20 * MI, { segments: 200 }) } };
  const { corridors, segmentation } = segmentUnit(unit);
  assert.equal(segmentation.count, 5);
  assert.equal(corridors.length, 5);
  assert.deepEqual(corridors.map(corridor => corridor.id),
    ['drv1-long-rd-s1', 'drv1-long-rd-s2', 'drv1-long-rd-s3', 'drv1-long-rd-s4', 'drv1-long-rd-s5']);
  const total = corridors.reduce((sum, corridor) => sum + corridor.lengthM, 0);
  // The segments tile the composed unit: measured total equals the unit's measured length.
  const measuredUnitM = corridorGeometry(unit.geometry).lengthM;
  assert.ok(Math.abs(total - measuredUnitM) < 1, `segments tile the unit (${total} vs ${measuredUnitM})`);
  for (const corridor of corridors) {
    assert.ok(corridor.lengthM <= MAX_CORRIDOR_M, `segment ${corridor.id} stays under the maximum`);
    assert.ok(corridor.lengthM >= MIN_CORRIDOR_M, `segment ${corridor.id} stays above the minimum`);
  }
  // Contiguous: each corridor starts where the previous one ended, with no gap and no overlap.
  for (let index = 1; index < corridors.length; index++) {
    const previous = corridors[index - 1].geometry.coordinates.at(-1);
    const current = corridors[index].geometry.coordinates[0];
    assert.deepEqual(current, previous);
  }
  // Rebuilding produces the same cuts.
  const again = segmentUnit(unit);
  assert.deepEqual(again.corridors.map(corridor => corridor.geometry), corridors.map(corridor => corridor.geometry));
});

test('segmentation counts follow the documented thresholds', () => {
  assert.equal(segmentationCount(5 * MI), 1);
  assert.equal(segmentationCount(MAX_CORRIDOR_M), 1);
  assert.equal(segmentationCount(MAX_CORRIDOR_M + 1), 2);
  assert.equal(segmentationCount(20 * MI), 5);
  assert.equal(segmentationCount(40 * MI), 10);
  assert.equal(segmentationCount(9 * MI), 2);
  assert.throws(() => segmentationCount(0), /positive corridor length/);
  assert.ok(MIN_CORRIDOR_M < TARGET_CORRIDOR_M && TARGET_CORRIDOR_M < MAX_CORRIDOR_M);
});

test('a road shorter than the minimum corridor is not proposed, and says why', () => {
  const { corridors, dropped } = segmentUnit({ id: 'drv1-short-rd', name: 'Short Rd',
    geometry: { type: 'LineString', coordinates: line(MIN_CORRIDOR_M / 2) } });
  assert.equal(corridors.length, 0);
  assert.match(dropped.reason, /shorter than the minimum discovery corridor/);
  assert.equal(dropped.minCorridorM, MIN_CORRIDOR_M);
});

test('a multi-part unit keeps its reported gap instead of bridging it', () => {
  const unit = { id: 'drv1-gap-rd', name: 'Gap Rd', geometry: { type: 'MultiLineString', coordinates: [
    line(4 * MI, { lon: -123 }), line(4 * MI, { lon: -123 + 9000 * LON_PER_M }),
  ] } };
  const { corridors } = segmentUnit(unit);
  assert.equal(corridors.length, 1);
  assert.equal(corridors[0].geometry.type, 'MultiLineString');
  assert.equal(corridors[0].parts, 2);
  assert.ok(corridors[0].lengthM < 8 * MI, 'the gap contributes no length');
});


// ---------------------------------------------------------------- discovery result model

// The batch layer's per-corridor block shape, as the GIS service returns it for one corridor.
function batchMetrics(overrides = {}) {
  const wetlands = {
    coverage: COVERAGE.FULL, reason: null, note: null,
    perDistance: { 250: { covered: true, corridorInside: true, coverage: COVERAGE.FULL },
      500: { covered: true, corridorInside: true, coverage: COVERAGE.FULL },
      1000: { covered: true, corridorInside: true, coverage: COVERAGE.FULL } },
    coverageByDistance: {}, buffers: { 250: { areaM2: 12000, lengthM: 0, featureCount: 3, breakdown: [] },
      500: { areaM2: 40000, lengthM: 0, featureCount: 5, breakdown: [] }, 1000: { areaM2: 90000, lengthM: 0, featureCount: 9, breakdown: [] } },
    classes: [{ label: 'Freshwater Emergent Wetland', code: 'PEM', areaM2: 90000, featureCount: 9 }],
    nearestDistanceM: 42, intersectsCorridor: true, corridorFeatureCount: 2, ...overrides.wetlands };
  const hydrography = {
    coverage: COVERAGE.FULL, reason: null, note: null, perDistance: {}, coverageByDistance: {},
    buffers: { 1000: { areaM2: 5000, lengthM: 3200, featureCount: 4, breakdown: [] } },
    crossings: [{ sourceFeatureId: 'n1', name: 'Johnson Creek', featureTypeLabel: 'Stream/River', overlapM: 12 }],
    crossingCount: 1, nearestFlowingWaterM: 15, nearestStandingWaterM: 260, corridorFlowlineCount: 2,
    types: [{ layer: 'flowline', waterClass: 'flowing', featureTypeCode: 460, featureTypeLabel: 'Stream/River', featureCount: 4 }],
    names: ['Johnson Creek'], ...overrides.hydrography };
  const ecology = {
    coverage: COVERAGE.FULL, spansMultiple: true,
    level3: { coverage: COVERAGE.FULL, primary: { code: '3', name: 'Willamette Valley', overlapM: 8000, percent: 80 },
      intersections: [{ code: '3', name: 'Willamette Valley', overlapM: 8000, percent: 80 },
        { code: '1', name: 'Coast Range', overlapM: 2000, percent: 20 }] },
    level4: { coverage: COVERAGE.FULL, primary: { code: '3c', name: 'Prairie Terraces', overlapM: 8000, percent: 80 },
      intersections: [{ code: '3c', name: 'Prairie Terraces', overlapM: 8000, percent: 80 }] },
    ...overrides.ecology };
  return { wetlands, hydrography, ecology };
}

function discoveryResult(overrides = {}) {
  const built = buildDiscoveryUnits([feature({ sourceFeatureId: 'a', geometry: { type: 'LineString', coordinates: line(3000) } })]);
  const [unit] = built.units;
  const corridor = segmentUnit(unit).corridors[0];
  return buildDiscoveryResult({ unit, corridor, metrics: batchMetrics(overrides.metrics),
    roadState: overrides.roadState ?? COVERAGE.FULL, provenance: { datasetId: 'or-roads-network-pilot' },
    analysisDistancesM: [250, 500, 1000] });
}

test('a discovery result carries raw measured signals, coverage, and provenance', () => {
  const result = discoveryResult();
  assert.equal(result.id, 'drv1-nw-example-rd-s1');
  assert.equal(result.status, undefined, 'status is applied by the lifecycle, not baked into the result');
  assert.equal(result.road.class, 'S1400');
  assert.deepEqual([...result.road.counties], ['Washington County, Oregon']);
  assert.equal(result.road.sourceFeatureCount, 1);
  assert.equal(result.signals.wetlands.nearestM, 42);
  assert.equal(result.signals.wetlands.area250M2, 12000);
  assert.equal(result.signals.wetlands.area1000M2, 90000);
  assert.equal(result.signals.wetlands.intersectsCorridor, true);
  assert.equal(result.signals.hydrography.crossingCount, 1);
  assert.equal(result.signals.hydrography.flowlineLength1000M, 3200);
  assert.deepEqual([...result.signals.hydrography.namedWaters], ['Johnson Creek']);
  assert.equal(result.ecology.level3.primary.name, 'Willamette Valley');
  assert.equal(result.ecology.ecoregionCount, 3, 'distinct Level III and IV codes are counted separately');
  assert.equal(result.ecology.transitions, 1, 'one Level III boundary is crossed');
  assert.equal(coverageFlag(result), COVERAGE.FULL);
  assert.match(result.provenance.occurrence, /Not queried during discovery/);
  assert.match(result.provenance.access, /not access evidence/);
  // No score, no likelihood, no recommendation anywhere in the result.
  assert.doesNotMatch(JSON.stringify(result), /score|likelihood|probability|best road/i);
});

test('missing measurements stay visible as unknown instead of becoming zero', () => {
  const result = discoveryResult({ metrics: { wetlands: { coverage: COVERAGE.PARTIAL, reason: 'outer buffer outside extract',
    perDistance: { 250: { covered: true }, 500: { covered: true }, 1000: { covered: false } }, coverageByDistance: {},
    buffers: { 250: { areaM2: 10, lengthM: 0, featureCount: 1, breakdown: [] } }, classes: [], nearestDistanceM: null,
    intersectsCorridor: false, corridorFeatureCount: 0 },
  hydrography: { coverage: COVERAGE.UNKNOWN, reason: 'hydrography unavailable', perDistance: {}, coverageByDistance: {},
    buffers: {}, crossings: [], crossingCount: 0, nearestFlowingWaterM: null, nearestStandingWaterM: null,
    corridorFlowlineCount: 0, types: [], names: [] } } });
  assert.equal(result.signals.wetlands.nearestM, null);
  assert.equal(result.signals.wetlands.area1000M2, 0, 'a buffer with no measured row reports zero area, with PARTIAL coverage beside it');
  assert.equal(result.coverage[COVERAGE_DATASET.WETLANDS].coverage, COVERAGE.PARTIAL);
  assert.match(result.coverage[COVERAGE_DATASET.WETLANDS].reason, /outside extract/);
  assert.equal(result.coverage[COVERAGE_DATASET.HYDROGRAPHY].coverage, COVERAGE.UNKNOWN);
  assert.equal(coverageFlag(result), COVERAGE.UNKNOWN);
  assert.equal(result.signals.hydrography.crossingCount, 0);
});


// ---------------------------------------------------------------- filters and sorts

function sortableResults() {
  const base = discoveryResult();
  const clone = (id, name, lengthM, { area250 = 0, crossings = 0, nearest = null, level3 = 'Willamette Valley' } = {}) => Object.freeze({
    ...base, id, name, lengthM,
    signals: Object.freeze({ ...base.signals,
      wetlands: Object.freeze({ ...base.signals.wetlands, area250M2: area250, nearestM: nearest, intersectsCorridor: nearest != null }),
      hydrography: Object.freeze({ ...base.signals.hydrography, crossingCount: crossings }) }),
    ecology: Object.freeze({ ...base.ecology, transitions: crossings > 1 ? 1 : 0,
      level3: Object.freeze({ ...base.ecology.level3, primary: { code: '3', name: level3, overlapM: 1, percent: 100 } }) }),
  });
  return [clone('drv1-a', 'Alpha Rd', 3000, { area250: 100, crossings: 1, nearest: 30 }),
    clone('drv1-b', 'Beta Rd', 5000, { area250: 3000, crossings: 5, nearest: 120 }),
    clone('drv1-c', 'Creek Rd', 2000, { area250: 0, crossings: 0, nearest: null, level3: 'Coast Range' })];
}

test('filters are deterministic and never invent a match for missing data', () => {
  const results = sortableResults();
  // 3000 m is 1.86 mi and 2000 m is 1.24 mi: both fall inside the 0.5–2 mi window, 5000 m does not.
  assert.equal(filterResults(results, { minLengthMi: 0.5, maxLengthMi: 2 }).map(r => r.id).join(','), 'drv1-a,drv1-c');
  assert.equal(filterResults(results, { minLengthMi: 2 }).map(r => r.id).join(','), 'drv1-b');
  assert.equal(filterResults(results, { minCrossings: 1 }).map(r => r.id).join(','), 'drv1-a,drv1-b');
  assert.equal(filterResults(results, { wetland: 'intersects' }).map(r => r.id).join(','), 'drv1-a,drv1-b');
  assert.equal(filterResults(results, { wetland: 'none-nearby' }).map(r => r.id).join(','), 'drv1-c');
  assert.equal(filterResults(results, { maxNearestWetlandM: 100 }).map(r => r.id).join(','), 'drv1-a',
    'a corridor with no measured nearest wetland cannot satisfy a maximum distance');
  assert.equal(filterResults(results, { ecoregion: '3c' }).length, 3, 'Level IV codes are matched too');
  assert.equal(filterResults(results, { roadClasses: ['S1200'] }).length, 0, 'the class filter uses the source class');
  assert.equal(filterResults(results, { roadClasses: ['S1400'] }).length, 3);
  assert.equal(filterResults(results, {}).length, results.length);
});

test('sorts are explicit measured dimensions, and unknown values sort last', () => {
  const results = sortableResults();
  assert.equal(sortResults(results, 'wetlandArea250').map(r => r.id).join(','), 'drv1-b,drv1-a,drv1-c');
  assert.equal(sortResults(results, 'name').map(r => r.id).join(','), 'drv1-a,drv1-b,drv1-c');
  assert.equal(sortResults(results, 'length').map(r => r.id).join(','), 'drv1-b,drv1-a,drv1-c');
  assert.equal(sortResults(results, 'nearestWetland').map(r => r.id).join(','), 'drv1-a,drv1-b,drv1-c');
  assert.equal(sortResults(results, 'crossings').map(r => r.id).join(','), 'drv1-b,drv1-a,drv1-c');
  const keys = SORT_OPTIONS.map(option => option.key);
  assert.ok(keys.includes(DEFAULT_SORT));
  for (const option of SORT_OPTIONS) assert.doesNotMatch(option.label, /best|score/i);
  // Every sort is a statement about one measured value, and the option names its unit.
  for (const option of SORT_OPTIONS.filter(entry => entry.unit)) assert.ok(option.unit.length > 0);
});

test('the default ordering is a display default, not a recommendation', () => {
  const results = sortableResults();
  assert.equal(sortResults(results).map(result => result.id).join(','), sortResults(results, DEFAULT_SORT).map(result => result.id).join(','));
  assert.match(DEFAULT_SORT_NOTE, /Display default only/);
  assert.match(DEFAULT_SORT_NOTE, /not a ranking/);
});


// ---------------------------------------------------------------- discovery coverage

test('discovery coverage is FULL only when every required dataset covers the search area', () => {
  const area = { id: 'or-pilot-window', name: 'Oregon pilot area', bbox: [-123.07, 45.505, -122.75, 45.67] };
  const roadQuery = { coverage: COVERAGE.FULL, reason: null, note: null };
  const full = discoveryResult();
  const partial = discoveryResult({ metrics: { wetlands: { coverage: COVERAGE.PARTIAL, reason: 'outer buffer outside extract',
    perDistance: {}, coverageByDistance: {}, buffers: {}, classes: [], nearestDistanceM: null, intersectsCorridor: false, corridorFeatureCount: 0 } } });
  assert.equal(summarizeDiscoveryCoverage({ roadQuery, searchArea: area, results: [full] }).coverage, COVERAGE.FULL);
  const partialRun = summarizeDiscoveryCoverage({ roadQuery, searchArea: area, results: [full, partial] });
  assert.equal(partialRun.coverage, COVERAGE.PARTIAL);
  assert.match(partialRun.reason, /outer buffer outside extract/);
  assert.match(partialRun.note, /cannot be compared with fully covered ones as though the missing habitat were zero/);
  assert.equal(partialRun.counts.corridors, 2);
  assert.equal(partialRun.counts.fullHabitat, 1);
  // Road data full while hydrography is unknown: the run is UNKNOWN, never an empty candidate list.
  const unknown = summarizeDiscoveryCoverage({ roadQuery, searchArea: area,
    results: [discoveryResult({ metrics: { hydrography: { coverage: COVERAGE.UNKNOWN, reason: 'hydrography unavailable',
      perDistance: {}, coverageByDistance: {}, buffers: {}, crossings: [], crossingCount: 0, nearestFlowingWaterM: null,
      nearestStandingWaterM: null, corridorFlowlineCount: 0, types: [], names: [] } } })] });
  assert.equal(unknown.coverage, COVERAGE.UNKNOWN);
  assert.equal(unknown.dimensions[COVERAGE_DATASET.ROAD_NETWORK].coverage, COVERAGE.FULL);
  assert.equal(unknown.dimensions[COVERAGE_DATASET.HYDROGRAPHY].coverage, COVERAGE.UNKNOWN);
});

test('a search area outside the road extract is NONE with a reason, not an empty discovery', () => {
  const area = { id: 'outside', name: 'Outside', bbox: [-124, 44, -123.9, 44.1] };
  const coverage = summarizeDiscoveryCoverage({ roadQuery: { coverage: COVERAGE.NONE, reason: null,
    note: 'The requested roads are absent from this bounded pilot extract; they are not evidence about the road network on the ground.' },
    searchArea: area, results: [] });
  assert.equal(coverage.coverage, COVERAGE.NONE);
  assert.equal(coverage.dimensions[COVERAGE_DATASET.ROAD_NETWORK].coverage, COVERAGE.NONE);
  assert.match(coverage.dimensions[COVERAGE_DATASET.ROAD_NETWORK].reason, /bounded pilot extract/);
  const failed = summarizeDiscoveryCoverage({ roadQuery: { coverage: COVERAGE.UNKNOWN, reason: 'DuckDB Spatial initialization failed' },
    searchArea: area, results: [] });
  assert.equal(failed.coverage, COVERAGE.UNKNOWN);
  assert.match(failed.reason, /DuckDB Spatial initialization failed/);
});

test('discovery coverage combines worst-first', () => {
  assert.equal(combineDiscoveryCoverage([COVERAGE.FULL, COVERAGE.FULL]), COVERAGE.FULL);
  assert.equal(combineDiscoveryCoverage([COVERAGE.FULL, COVERAGE.PARTIAL]), COVERAGE.PARTIAL);
  assert.equal(combineDiscoveryCoverage([COVERAGE.PARTIAL, COVERAGE.NONE]), COVERAGE.NONE);
  assert.equal(combineDiscoveryCoverage([COVERAGE.NONE, COVERAGE.UNKNOWN]), COVERAGE.UNKNOWN);
  assert.equal(combineDiscoveryCoverage([]), COVERAGE.UNKNOWN);
});


// ---------------------------------------------------------------- lifecycle and promotion

test('discovery lifecycle marks corridors without touching the automated result', () => {
  const result = { ...discoveryResult() };
  let marks = {};
  assert.equal(statusFor(marks, result.id), DISCOVERY_STATUS.DISCOVERED);
  marks = markDiscovery(marks, result.id, DISCOVERY_STATUS.PROMOTED);
  assert.equal(marks[result.id], DISCOVERY_STATUS.PROMOTED);
  assert.equal(applyMarks([result], marks)[0].status, DISCOVERY_STATUS.PROMOTED);
  marks = markDiscovery(marks, result.id, DISCOVERY_STATUS.DISMISSED);
  assert.equal(marks[result.id], DISCOVERY_STATUS.DISMISSED);
  assert.deepEqual(markDiscovery(marks, result.id, DISCOVERY_STATUS.DISCOVERED), {});
  const normalized = normalizeMarks({ 'drv1-x': 'MAYBE', 'drv1-y': 'PROMOTED' });
  assert.equal(normalized['drv1-x'], undefined);
  assert.equal(normalized['drv1-y'], 'PROMOTED');
});

test('promotion builds a normal candidate through the ordinary road and candidate builders', () => {
  const result = discoveryResult();
  const features = [feature({ sourceFeatureId: 'a', geometry: { type: 'LineString', coordinates: line(3000) } })];
  const candidate = promoteDiscoveryResult(result, { features, provenance: { agency: 'U.S. Census Bureau' } });
  assert.equal(candidate.id, result.id);
  assert.equal(candidate.status, 'discovered');
  assert.equal(candidate.corridor.roadCount, 1);
  assert.equal(candidate.roads[0].sourceFeatureIds.length, 1);
  assert.equal(candidate.roads[0].provenance.organization, 'U.S. Census Bureau');
  assert.ok(['LineString', 'MultiLineString'].includes(candidate.geometry.type));
  assert.ok(candidate.corridor.lengthM > 0);
  assert.equal(candidate.coverage[COVERAGE_DATASET.DISCOVERY].coverage, COVERAGE.FULL);
  assert.equal(candidate.coverage[COVERAGE_DATASET.ACCESS_VERIFICATION].coverage, COVERAGE.NONE);
  assert.equal(candidate.evidence.length, 2);
  assert.ok(candidate.evidence.every(entry => entry.coverage === COVERAGE.FULL));
  assert.match(candidate.evidence[0].statement, /TIGER\/Line 2025 road feature/);
  assert.match(candidate.evidence[1].statement, /not a finding about habitat quality/);
  // No Investigator probe entry was needed, and nothing claims access.
  assert.equal(candidate.access.status, 'UNVERIFIED');
  assert.match(candidate.access.note, /has not established public, legal, or practical access/);
  assert.equal(PILOT_PROBES_BY_CORRIDOR[candidate.id], undefined);
  assert.match(NO_DECLARED_SOURCES, /No reviewed research sources are declared/);
  assert.throws(() => promoteDiscoveryResult(result, { features: [] }), /needs the source features/);
});

test('discovery marks persist in one small versioned entry and never trust broken storage', () => {
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  const marks = writeDiscoveryMarks({ 'drv1-a': DISCOVERY_STATUS.PROMOTED }, storage);
  assert.deepEqual(marks, { 'drv1-a': DISCOVERY_STATUS.PROMOTED });
  assert.ok(store.has(DISCOVERY_MARKS_KEY));
  assert.deepEqual(readDiscoveryMarks(storage), { 'drv1-a': DISCOVERY_STATUS.PROMOTED });
  store.set(DISCOVERY_MARKS_KEY, '{not json');
  assert.deepEqual(readDiscoveryMarks(storage), {});
  store.set(DISCOVERY_MARKS_KEY, JSON.stringify({ kind: 'something-else', marks: { 'drv1-a': 'PROMOTED' } }));
  assert.deepEqual(readDiscoveryMarks(storage), {});
  // No storage at all is a missing convenience, not a failure.
  assert.deepEqual(readDiscoveryMarks(null), {});
  assert.deepEqual(writeDiscoveryMarks({ 'drv1-a': DISCOVERY_STATUS.PROMOTED }, null), { 'drv1-a': DISCOVERY_STATUS.PROMOTED });
  assert.doesNotThrow(() => writeDiscoveryMarks({ 'drv1-a': DISCOVERY_STATUS.PROMOTED },
    { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} }));
});


// ---------------------------------------------------------------- set-oriented batch GIS

// A fake DuckDB engine that records every statement and answers with synthetic rows. This is how the
// batch layer is verified offline: the SQL shape (one temp table, one pad per corridor, one pass per
// dataset) and the row -> block mapping are both asserted without a browser. The analytical geometry
// service is the real one: it is pure JavaScript plus probes, so a fake engine can exercise the shared
// repair boundary exactly as production does.
function fakeGisEngine({ rowsFor, failDatasets = [] }) {
  const statements = [];
  const engine = { db: { registerFileBuffer: async () => {} },
    // Rows are produced when the statement runs, the way DuckDB behaves: a probe that throws must throw
    // from `query`, not when a caller later reads rows from it.
    conn: { query: async sql => { statements.push(sql); const rows = rowsFor(sql); return { toArray: () => rows }; } } };
  const queries = createDiscoveryQueries({
    openDataset: async datasetId => {
      if (failDatasets.includes(datasetId)) throw new Error(`${datasetId} byte count mismatch`);
      return { id: datasetId, registeredName: `${datasetId}.parquet`, transferredBytes: 1024, version: 'v1',
        sha256: 'a'.repeat(64), crs: 'EPSG:4326', scope: { bbox: [-123.07, 45.505, -122.75, 45.67] },
        source: { agency: 'test', dataset: datasetId, publicationDate: '2025-01-01', url: 'https://example.test', license: 'x' } };
    },
    initialize: async () => engine,
    record: () => {},
    provenance: entry => ({ datasetId: entry.id }),
    analytical: createAnalyticalGeometryQueries({ initialize: async () => engine }),
  });
  return { queries, statements, engine };
}

const WETLAND_ROWS = [
  { id: 'drv1-a', distance_m: 250, label: 'Freshwater Emergent Wetland', code: 'PEM', feature_count: 3, area_m2: 12000 },
  { id: 'drv1-a', distance_m: 1000, label: 'Freshwater Emergent Wetland', code: 'PEM', feature_count: 9, area_m2: 90000 },
  { id: 'drv1-b', distance_m: 250, label: 'Riverine', code: 'R2UBH', feature_count: 1, area_m2: 400 },
];
const WETLAND_PROXIMITY = [{ id: 'drv1-a', corridor_features: 2, nearest_m: 42 },
  { id: 'drv1-b', corridor_features: 0, nearest_m: 900 }];
const HYDRO_BUFFER_ROWS = [
  { id: 'drv1-a', distance_m: 1000, layer: 'flowline', feature_count: 4, area_m2: 0, length_m: 3200 },
  { id: 'drv1-a', distance_m: 1000, layer: 'waterbody', feature_count: 1, area_m2: 5000, length_m: 0 },
];
const HYDRO_PROXIMITY = [{ id: 'drv1-a', nearest_flowing_m: 15, nearest_standing_m: 260, corridor_flowlines: 2 }];
const CROSSINGS = [{ id: 'drv1-a', source_feature_id: 'n1', name: 'Johnson Creek', feature_type_label: 'Stream/River', overlap_m: 12.5 }];
const NAMES = [{ id: 'drv1-a', name: 'Johnson Creek' }];
const TYPES = [{ id: 'drv1-a', layer: 'flowline', water_class: 'flowing', feature_type_code: 460,
  feature_type_label: 'Stream/River', feature_count: 4 }];
// Overlap sum equals the synthetic corridor length, so the ecoregion levels report FULL coverage.
const ECO3 = [{ id: 'drv1-a', code: '3', name: 'Willamette Valley', overlap_m: 10000 }];
const ECO4 = [{ id: 'drv1-a', code: '3c', name: 'Prairie Terraces', overlap_m: 10000 }];

function batchRows(sql) {
  if (/ST_Length\(geom\) AS length_m/.test(sql)) return [{ id: 'drv1-a', length_m: 10000 }];
  if (/e\.code AS code/.test(sql)) return /-l3\.parquet/.test(sql) ? ECO3 : ECO4;
  if (/feature_type_label, count\(\*\)/.test(sql)) return TYPES;
  if (/f\.layer = 'flowline' AND/.test(sql)) return CROSSINGS;
  if (/f\.name <> ''/.test(sql)) return NAMES;
  if (/ST_Contains\(\(SELECT w FROM extent\), b\.geom\)/.test(sql)) return [250, 500, 1000]
    .map(distance => ({ id: 'drv1-a', distance_m: distance, covered: distance < 1000, corridor_inside: true }));
  if (/min\(ST_Distance/.test(sql)) return /AS w/.test(sql) ? WETLAND_PROXIMITY : HYDRO_PROXIMITY;
  if (/count\(DISTINCT source_feature_id\)/.test(sql)) return /AS w/.test(sql) ? WETLAND_ROWS : HYDRO_BUFFER_ROWS;
  return [];
}


test('the batch analysis creates one corridor table and one pass per dataset', async () => {
  const { queries, statements } = fakeGisEngine({ rowsFor: batchRows });
  const result = await queries.analyzeDiscoveryCorridors([
    { id: 'drv1-a', geometry: { type: 'LineString', coordinates: line(3000) } },
    { id: 'drv1-b', geometry: { type: 'LineString', coordinates: line(2000, { lon: -122.9 }) } },
  ]);
  assert.equal(result.diagnostics.status, 'ready');
  assert.equal(result.diagnostics.corridorCount, 2);
  const insert = statements.find(sql => /INSERT INTO rn_discovery_corridor/.test(sql));
  assert.ok(insert, 'corridors are inserted into one temp table');
  assert.match(insert, /'drv1-a', ST_GeomFromText\('LINESTRING\(/);
  assert.match(insert, /'drv1-b'/);
  assert.ok(statements.some(sql => /CREATE OR REPLACE TEMP TABLE rn_discovery_analysis AS SELECT id, ST_Transform\(geom/.test(sql)),
    'the corridor table is projected once into EPSG:5070');
  // One pass per dataset dimension instead of one round trip per corridor: the statement count is
  // bounded by datasets, not by corridors x datasets.
  const datasetIds = ['nwi-wetlands-or-pilot', 'nhd-hydrography-or-pilot', 'epa-ecoregions-or-l3', 'epa-ecoregions-or-l4'];
  for (const datasetId of datasetIds) {
    const hits = statements.filter(sql => sql.includes(datasetId)).length;
    // Wetlands and hydrography need their buffered metrics, proximity, feature inventory, and coverage
    // passes; ecoregions need one overlap pass per level.
    assert.ok(hits <= 6, `${datasetId} is read by ${hits} statements`);
  }
  assert.ok(statements.length <= 20, `batch statement count was ${statements.length}`);
  const wetlandBuffer = statements.find(sql => /count\(DISTINCT source_feature_id\)/.test(sql) && /AS w/.test(sql));
  assert.match(wetlandBuffer, /pad1000_min_lon <= w\.max_lon/, 'the per-corridor neighbourhood prefilter is used');
  assert.ok(statements.some(sql => /CREATE OR REPLACE TEMP TABLE rn_discovery_wetland AS SELECT source_feature_id/.test(sql)),
    'the wetland extract is projected once per batch run');
  assert.match(wetlandBuffer, /FROM rn_discovery_buffer AS b JOIN rn_discovery_analysis AS c ON c\.id = b\.id, rn_discovery_wetland AS w/,
    'buffered corridors are materialised once and joined, never recomputed per candidate feature');
  assert.match(wetlandBuffer, /GROUP BY id, distance_m, label, code/);
  assert.ok(statements.some(sql => /CREATE OR REPLACE TEMP TABLE rn_discovery_buffer AS SELECT c\.id AS id, d\.distance_m AS distance_m, ST_Buffer\(c\.geom, d\.distance_m\)/.test(sql)),
    'one buffer per corridor per requested distance');
  const eco = statements.find(sql => /e\.code AS code/.test(sql));
  assert.match(eco, /AND ST_Intersects\(e\.geometry, c\.geom_4326\)/,
    'the ecoregion pass tests the intersection in 4326 and measures the overlap in 5070');
  assert.match(eco, /ST_Length\(ST_Intersection\(ST_Transform\(e\.geometry, 'EPSG:4326', 'EPSG:5070'/);
  const a = result.corridors['drv1-a'];
  assert.equal(a.wetlands.buffers[250].areaM2, 12000);
  assert.equal(a.wetlands.buffers[1000].areaM2, 90000);
  assert.equal(a.wetlands.nearestDistanceM, 42);
  assert.equal(a.wetlands.intersectsCorridor, true);
  assert.equal(a.wetlands.classes.length, 1);
  assert.equal(a.wetlands.coverage, COVERAGE.PARTIAL, 'the 1 km buffer left the extract');
  assert.equal(a.hydrography.crossingCount, 1);
  assert.equal(a.hydrography.crossings[0].name, 'Johnson Creek');
  assert.equal(a.hydrography.buffers[1000].lengthM, 3200);
  assert.equal(a.hydrography.nearestFlowingWaterM, 15);
  assert.deepEqual([...a.hydrography.names], ['Johnson Creek']);
  assert.equal(a.hydrography.types[0].featureTypeLabel, 'Stream/River');
  assert.equal(a.ecology.level3.primary.name, 'Willamette Valley');
  assert.equal(a.ecology.level3.primary.percent, 100);
  assert.equal(a.ecology.coverage, COVERAGE.FULL);
  assert.ok(a.wetlands.provenance.datasetId, 'each block carries its dataset provenance');
  const b = result.corridors['drv1-b'];
  assert.equal(b.wetlands.buffers[250].areaM2, 400);
  assert.equal(b.hydrography.crossingCount, 0);
  assert.equal(b.hydrography.coverage, COVERAGE.NONE, 'a dataset with no covered buffer is NONE, not FULL');
});

test('a dataset failure leaves that dimension UNKNOWN with a reason and the others measured', async () => {
  const { queries } = fakeGisEngine({ rowsFor: batchRows, failDatasets: ['nwi-wetlands-or-pilot'] });
  const result = await queries.analyzeDiscoveryCorridors([{ id: 'drv1-a', geometry: { type: 'LineString', coordinates: line(3000) } }]);
  assert.equal(result.diagnostics.status, 'partial');
  assert.match(result.diagnostics.reason, /nwi-wetlands-or-pilot: nwi-wetlands-or-pilot byte count mismatch/);
  const block = result.corridors['drv1-a'];
  assert.equal(block.wetlands.coverage, COVERAGE.UNKNOWN);
  assert.match(block.wetlands.reason, /byte count mismatch/);
  assert.equal(block.wetlands.buffers[250], undefined);
  assert.notEqual(block.hydrography.coverage, COVERAGE.UNKNOWN, 'hydrography is still measured');
});

test('the batch analysis refuses an invalid corridor id and copes with an empty list', async () => {
  const { queries } = fakeGisEngine({ rowsFor: batchRows });
  await assert.rejects(() => queries.analyzeDiscoveryCorridors([{ id: 'DROP TABLE x',
    geometry: { type: 'LineString', coordinates: line(100) } }]), /Invalid discovery corridor id/);
  const empty = await queries.analyzeDiscoveryCorridors([]);
  assert.deepEqual(Object.keys(empty.corridors), []);
  assert.equal(empty.diagnostics.status, 'ready');
});


// ---------------------------------------------------------------- the discovery run

// A stub GIS service that records what discovery asked for. Discovery must only ever ask for the road
// network and the batched habitat/ecoregion analysis: no occurrence source and no Investigator Worker.
function stubGis({ features, metricsFor = () => batchMetrics() } = {}) {
  const calls = [];
  return {
    calls,
    service: {
      async queryRoadNetwork(options) {
        calls.push({ method: 'queryRoadNetwork', options });
        return { coverage: COVERAGE.FULL, reason: null, note: null, features, bounded: true,
          provenance: { datasetId: 'or-roads-network-pilot', agency: 'U.S. Census Bureau' },
          diagnostics: { status: 'ready' } };
      },
      async analyzeDiscovery(corridors) {
        calls.push({ method: 'analyzeDiscovery', corridorCount: corridors.length });
        const blocks = {};
        for (const corridor of corridors) blocks[corridor.id] = metricsFor(corridor);
        return { corridors: blocks, diagnostics: { status: 'ready', reason: null, corridorCount: corridors.length, queryMs: 1, datasetErrors: [] } };
      },
    },
  };
}

const SEARCH_AREA = { id: 'or-pilot-window', name: 'Oregon pilot area', bbox: [-123.07, 45.505, -122.75, 45.67] };
const NETWORK_FEATURES = [
  feature({ sourceFeatureId: 'a', geometry: { type: 'LineString', coordinates: line(3000, { lon: -123 }) } }),
  feature({ sourceFeatureId: 'b', geometry: { type: 'LineString', coordinates: line(3000, { lon: -123 + 3000 * LON_PER_M }) } }),
  feature({ sourceFeatureId: 'c', name: 'NW Short Ln', geometry: { type: 'LineString', coordinates: line(200, { lon: -122.9 }) } }),
  feature({ sourceFeatureId: 'd', roadClass: 'S1630', name: '', geometry: { type: 'LineString', coordinates: line(300, { lon: -122.8 }) } }),
];

test('one discovery run composes, segments, measures, and reports, and asks for nothing else', async () => {
  const { service, calls } = stubGis({ features: NETWORK_FEATURES });
  const run = await runDiscovery({ gis: service, searchArea: SEARCH_AREA });
  assert.equal(run.status, 'ready');
  assert.deepEqual(calls.map(call => call.method), ['queryRoadNetwork', 'analyzeDiscovery']);
  assert.deepEqual(calls[0].options.roadClasses, ['S1200', 'S1400'],
    'only the eligible TIGER classes are requested');
  assert.deepEqual(calls[0].options.bbox, SEARCH_AREA.bbox);
  assert.equal(run.results.length, 1, 'the 200 m lane is below the minimum corridor');
  assert.equal(run.results[0].id, 'drv1-nw-example-rd-s1');
  assert.equal(run.diagnostics.counts.features, 4);
  assert.equal(run.diagnostics.counts.corridors, 1);
  assert.equal(run.diagnostics.counts.droppedShortUnits, 1);
  assert.equal(run.coverage.coverage, COVERAGE.FULL);
  assert.ok(Number.isFinite(run.diagnostics.totalMs));
  assert.ok(run.eligibility.some(entry => /S1630/.test(entry.key)));
  assert.equal(run.raw.features.length, 4, 'the source features are kept for promotion');
  assert.match(run.diagnostics.note, /once per dataset/);
});

test('a failed or empty road-network read is unavailable, never an empty search area', async () => {
  for (const [coverage, reason] of [[COVERAGE.UNKNOWN, 'DuckDB Spatial initialization failed'], [COVERAGE.NONE, null]]) {
    const run = await runDiscovery({ gis: { async queryRoadNetwork() {
      return { coverage, reason, note: reason ? null : 'The requested roads are absent from this bounded pilot extract; they are not evidence about the road network on the ground.',
        features: [], diagnostics: { reason } };
    }, async analyzeDiscovery() { throw new Error('must not be called'); } }, searchArea: SEARCH_AREA });
    assert.equal(run.status, 'unavailable');
    assert.deepEqual(run.results, []);
    assert.equal(run.coverage.coverage, coverage);
    assert.notEqual(run.status, 'ready');
  }
});

test('run diagnostics say which measurement failed without turning it into a zero', async () => {
  const { service } = stubGis({ features: NETWORK_FEATURES, metricsFor: () => batchMetrics({ wetlands: { coverage: COVERAGE.PARTIAL,
    reason: 'outer buffer outside extract', perDistance: {}, coverageByDistance: {}, buffers: {}, classes: [],
    nearestDistanceM: null, intersectsCorridor: false, corridorFeatureCount: 0 } }) });
  const run = await runDiscovery({ gis: service, searchArea: SEARCH_AREA });
  assert.equal(run.coverage.coverage, COVERAGE.PARTIAL);
  assert.match(run.coverage.reason, /outer buffer outside extract/);
  assert.equal(run.results[0].signals.wetlands.nearestM, null);
});

// ---------------------------------------------------------------- discovery stays offline

test('discovery never calls an occurrence source or the Investigator, by construction', () => {
  const directory = new URL('../src/discovery/', import.meta.url);
  const forbidden = /inaturalist|ebird|overpass|api\.roadnaturalist|investigator|worker-transport|probes\//i;
  const files = readdirSync(directory).filter(name => name.endsWith('.js'));
  assert.ok(files.length >= 8, `discovery modules: ${files.join(', ')}`);
  for (const name of files) {
    const source = readFileSync(new URL(name, directory), 'utf8');
    const lines = source.split('\n');
    for (const line of lines) {
      // Comments may explain why those sources are deferred; imports and code may not reach them.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (forbidden.test(line) && !/No reviewed research sources|no reviewed research sources|not queried during discovery|Not researched during discovery|not an occurrence API/i.test(line)) {
        assert.fail(`${name} references an external evidence source: ${line.trim()}`);
      }
    }
  }
});


// ---------------------------------------------------------------- the committed road-network extract

test('the discovery network is declared, digested, and bounded inside the habitat window', () => {
  assert.ok(network, 'or-roads-network-pilot is declared in the manifest');
  assert.equal(network.type, 'road-centerlines-network');
  assert.equal(network.sha256, summary.sha256);
  assert.equal(network.featureCount, summary.featureCount);
  assert.equal(network.roadCount, summary.roadCount);
  assert.equal(network.pointCount, summary.pointCount);
  assert.deepEqual(network.scope.bbox, summary.bbox);
  assert.deepEqual(network.scope.classes, summary.classCounts);
  assert.deepEqual(network.scope.excludedClasses, summary.excludedClassCounts);
  assert.equal(network.normalization.measureCrs, 'EPSG:5070');
  assert.deepEqual(network.normalization.windowBbox, network.scope.bbox);
  assert.deepEqual(network.normalization.extractClasses, ['S1200', 'S1400', 'S1500']);
  assert.equal(network.scope.outsideWindowFeatureCount, summary.outsideWindowFeatureCount);
  const artifact = readFileSync(new URL(`../data/${network.url}`, import.meta.url));
  assert.equal(artifact.length, network.bytes, 'the staged byte count matches the artifact');
  // The same pinned TIGER archives back the pilot and the network: one source, two bounded extracts.
  const pilot = manifest.datasets.find(dataset => dataset.id === 'or-roads-pilot');
  assert.deepEqual(network.source.urls, pilot.source.urls);
  assert.deepEqual(network.source.sha256, pilot.source.sha256);
  assert.equal(network.source.publicationDate, pilot.source.publicationDate);
});

test('the discovery window is exactly the bounded habitat window', () => {
  const wetlands = manifest.datasets.find(dataset => dataset.id === 'nwi-wetlands-or-pilot');
  const hydrography = manifest.datasets.find(dataset => dataset.id === 'nhd-hydrography-or-pilot');
  assert.deepEqual(network.scope.bbox, wetlands.scope.bbox);
  assert.deepEqual(network.scope.bbox, hydrography.scope.bbox);
  // Road coverage and habitat coverage therefore describe the same area: discovery can be FULL.
  const declared = validateSearchAreas(searchAreas, manifest);
  assert.deepEqual(declared.searchAreas[0].bbox, network.scope.bbox);
});

test('the corridor thresholds the offline pipeline used are the ones the browser uses', () => {
  assert.equal(summary.discovery.minCorridorM, MIN_CORRIDOR_M);
  assert.equal(summary.discovery.targetCorridorM, TARGET_CORRIDOR_M);
  assert.equal(summary.discovery.maxCorridorM, MAX_CORRIDOR_M);
  assert.ok(summary.discovery.proposedCorridorCount >= summary.discovery.unitsAtLeastMinCorridor,
    'segmenting a long unit adds corridors rather than removing any');
  assert.equal(summary.discovery.unitsSegmented, 3);
  for (const road of summary.pilotRoads) {
    assert.equal(road.segments, road.primaryUnitLengthM >= MIN_CORRIDOR_M ? segmentationCount(road.primaryUnitLengthM) : 0,
      `${road.name} segmentation must follow the shared rule`);
  }
});

test('the three hand-selected pilot roads are inside the discovery extract', () => {
  const snapshot = JSON.parse(readFileSync(new URL('./fixtures/or-roads-pilot.snapshot.json', import.meta.url)));
  const [minLon, minLat, maxLon, maxLat] = network.scope.bbox;
  for (const road of snapshot.roads) {
    for (const feature of road.features) {
      for (const [lon, lat] of feature.coordinates) {
        assert.ok(lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat,
          `${road.roadId} feature ${feature.sourceFeatureId} leaves the discovery window`);
      }
    }
  }
  const byName = new Map(summary.pilotRoads.map(entry => [entry.name, entry]));
  for (const name of ['NW Cornelius Pass Rd', 'NW Springville Rd', 'NW Susbauer Rd']) {
    const entry = byName.get(name);
    assert.ok(entry, `${name} is measured in the extraction summary`);
    assert.ok(entry.unitCount >= 1, `${name} composes into at least one discovery unit`);
    assert.ok(entry.primaryUnitLengthM > MIN_CORRIDOR_M, `${name} is a proposable corridor`);
    assert.ok(entry.segments >= 1);
  }
  // Cornelius Pass Rd is one connected named road across the county line, and 10.55 mi is long enough
  // that discovery divides it into contiguous corridors rather than proposing one 10-mile candidate.
  assert.equal(byName.get('NW Cornelius Pass Rd').unitCount, 1);
  assert.equal(byName.get('NW Cornelius Pass Rd').segments, 3);
  // NW Springville Rd is the documented counter-example: the hand-authored pilot candidate composes the
  // two county records by declaration, while discovery only joins features whose endpoints are within
  // the composition tolerance, so the same name becomes two discovery corridors with a reported gap.
  assert.equal(byName.get('NW Springville Rd').unitCount, 2);
  const springville = snapshot.roads.filter(road => road.name === 'NW Springville Rd');
  const units = buildDiscoveryUnits(springville.flatMap(road => road.features.map(feature => ({ roadId: road.roadId,
    name: road.name, roadClass: road.roadClass, routeType: road.routeType, countyFips: road.countyFips,
    countyName: road.countyName, sourceFeatureId: feature.sourceFeatureId,
    geometry: { type: 'LineString', coordinates: feature.coordinates } }))));
  assert.equal(units.units.length, 2);
  const [first, second] = units.units;
  assert.equal(first.id, 'drv1-nw-springville-rd-c1');
  assert.equal(second.id, 'drv1-nw-springville-rd-c2');
  // The gap between the two county records is real and is never bridged with invented geometry: it is
  // larger than the composition tolerance, which is exactly why discovery keeps two units.
  const linesOfUnit = unit => {
    const geometry = unit.geometry;
    return geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
  };
  const separation = Math.min(...linesOfUnit(first).flatMap(left => linesOfUnit(second)
    .map(right => endpointGapM(left, right))));
  assert.ok(separation > JOIN_TOLERANCE_M, `the county-line gap is ${Math.round(separation)} m`);
  assert.equal(units.units.every(unit => unit.composition.maxUnresolvedGapM === null), true,
    'a unit never reports a gap it invented');
  assert.ok(summary.discovery.proposedCorridorCount > 50 && summary.discovery.proposedCorridorCount < 500,
    `the pilot window proposes a bounded number of corridors (${summary.discovery.proposedCorridorCount})`);
  assert.ok(summary.namedUnitCount > summary.discovery.unitsAtLeastMinCorridor, 'most named units are short residential blocks');
  assert.ok(summary.discovery.unitsDroppedAsShort > 0);
});

test('a search area must lie inside every dataset it requires', () => {
  const valid = validateSearchAreas(searchAreas, manifest);
  assert.equal(valid.searchAreas.length, 1);
  assert.deepEqual(valid.searchAreas[0].requires[0], 'or-roads-network-pilot');
  const outside = JSON.parse(JSON.stringify(searchAreas));
  outside.searchAreas[0].bbox = [-124.5, 45.0, -124.4, 45.1];
  assert.throws(() => validateSearchAreas(outside, manifest), /extends outside or-roads-network-pilot/);
  const missing = JSON.parse(JSON.stringify(searchAreas));
  missing.searchAreas[0].requires = ['not-a-dataset'];
  assert.throws(() => validateSearchAreas(missing, manifest), /which is not in the data manifest/);
  const unordered = JSON.parse(JSON.stringify(searchAreas));
  unordered.searchAreas[0].bbox = [-122.75, 45.505, -123.07, 45.67];
  assert.throws(() => validateSearchAreas(unordered, manifest), /ordered min\/max/);
});


// ------------------------------------------- analytical geometry repair inside the batch survey

// A retraced corridor: the last leg is digitized back over the previous one, which is the shape real
// TIGER composition produces and the shape GEOS refuses to buffer.
function retracedLine() {
  const points = line(3000);
  return { type: 'LineString', coordinates: [...points, points.at(-2)] };
}
const GEOS_REFUSAL = 'Invalid Error: TopologyException: assigned depths do not match at -2069591.5 2798637.7';

// The batch probes each corridor against its own analysis-table row, so the canonical probe is the one
// statement that carries both ST_Buffer(geom, ...) and the corridor id.
const isCanonicalProbe = sql => /SELECT ST_Buffer\(geom, 250\)/.test(sql) && /id = '/.test(sql);
const isCandidateProbe = sql => /AS candidate/.test(sql);

test('a corridor the engine refuses is repaired in the batch, and the repair travels in provenance', async () => {
  const { queries, statements } = fakeGisEngine({ rowsFor: sql => {
    if (isCanonicalProbe(sql) && /id = 'drv1-b'/.test(sql)) throw new Error(GEOS_REFUSAL);
    return batchRows(sql);
  } });
  const result = await queries.analyzeDiscoveryCorridors([
    { id: 'drv1-a', geometry: { type: 'LineString', coordinates: line(3000) } },
    { id: 'drv1-b', geometry: retracedLine() },
  ]);
  assert.deepEqual([...result.diagnostics.unbufferableCorridors], [], 'no corridor is left unbufferable');
  assert.deepEqual([...result.diagnostics.repairedCorridors], ['drv1-b'], 'the refused corridor was repaired');
  assert.equal(result.diagnostics.analyticalGeometry.repairedCount, 1);
  assert.deepEqual(result.diagnostics.analyticalGeometry.methods, { none: 1, 'remove-duplicate-segments': 1 });
  const repaired = result.corridors['drv1-b'].geometryForAnalysis;
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.method, 'remove-duplicate-segments');
  assert.equal(repaired.displacementM, 0, 'the repair moved nothing');
  assert.ok(repaired.removedDuplicateLengthM > 0);
  assert.ok(repaired.lengthDeltaM < 0, 'the removed doubled traversal is reported');
  const untouched = result.corridors['drv1-a'].geometryForAnalysis;
  assert.equal(untouched.repaired, false);
  assert.equal(untouched.method, 'none');
  // The analysis table is rewritten for that corridor only, pads included, and the canonical corridor
  // geometry the map draws is never touched.
  const update = statements.find(sql => /^UPDATE rn_discovery_analysis SET geom = ST_Transform\(ST_GeomFromText/.test(sql));
  assert.ok(update, 'the repaired analytical geometry replaces the analysed geometry for that corridor');
  assert.match(update, /WHERE id = 'drv1-b'/);
  assert.match(update, /pad1000_min_lon = /);
  assert.ok(!/drv1-a/.test(update), 'corridors that needed no repair are not rewritten');
  // And the corridor is measured normally instead of being reported as UNKNOWN.
  assert.notEqual(result.corridors['drv1-b'].wetlands.coverage, COVERAGE.UNKNOWN);
  assert.equal(result.corridors['drv1-b'].wetlands.buffers[250].areaM2, 400);
  assert.equal(result.diagnostics.status, 'ready');
});

test('a corridor no repair rescues stays UNKNOWN while the rest of the survey is measured', async () => {
  const { queries } = fakeGisEngine({ rowsFor: sql => {
    if (isCandidateProbe(sql)) throw new Error(GEOS_REFUSAL);
    if (isCanonicalProbe(sql) && /id = 'drv1-b'/.test(sql)) throw new Error(GEOS_REFUSAL);
    return batchRows(sql);
  } });
  const result = await queries.analyzeDiscoveryCorridors([
    { id: 'drv1-a', geometry: { type: 'LineString', coordinates: line(3000) } },
    { id: 'drv1-b', geometry: retracedLine() },
  ]);
  assert.deepEqual([...result.diagnostics.unbufferableCorridors], ['drv1-b']);
  assert.deepEqual([...result.diagnostics.repairedCorridors], [], 'nothing is claimed as repaired');
  const failed = result.corridors['drv1-b'];
  assert.equal(failed.geometryForAnalysis.repaired, false);
  assert.equal(failed.wetlands.coverage, COVERAGE.UNKNOWN);
  assert.equal(failed.hydrography.coverage, COVERAGE.UNKNOWN);
  assert.match(failed.wetlands.reason, /no point-preserving repair was accepted/);
  // The buffer summary is present but every distance is UNKNOWN, so a missing measurement can never be
  // read as "no wetlands here".
  assert.equal(failed.wetlands.coverageByDistance[250].coverage, COVERAGE.UNKNOWN);
  assert.equal(failed.wetlands.coverageByDistance[1000].coverage, COVERAGE.UNKNOWN);
  assert.equal(result.diagnostics.status, 'partial');
  // The unrelated corridor is still measured: one bad geometry never aborts the survey.
  assert.equal(result.corridors['drv1-a'].wetlands.buffers[250].areaM2, 12000);
  assert.equal(result.corridors['drv1-a'].hydrography.crossingCount, 1);
  assert.notEqual(result.corridors['drv1-a'].wetlands.coverage, COVERAGE.UNKNOWN);
});

test('a survey reports the repair decision for every corridor, repaired or not', async () => {
  const { queries } = fakeGisEngine({ rowsFor: batchRows });
  const result = await queries.analyzeDiscoveryCorridors([{ id: 'drv1-a', geometry: { type: 'LineString', coordinates: line(3000) } }]);
  const facts = result.corridors['drv1-a'].geometryForAnalysis;
  assert.equal(facts.repaired, false);
  assert.equal(facts.method, 'none');
  assert.match(facts.note, /used directly/);
  assert.ok(facts.canonicalLengthM > 0);
  assert.equal(facts.displacementM, 0);
  assert.equal(result.diagnostics.repairedCorridors.length, 0);
  assert.equal(result.diagnostics.analyticalGeometry.unusableCount, 0);
});
