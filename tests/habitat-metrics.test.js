import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryQueries } from '../src/gis/discovery-query.js';
import { createHabitatQueries } from '../src/gis/habitat-query.js';
import { createAnalyticalGeometryQueries } from '../src/gis/analytical-geometry.js';
import { HABITAT_METRIC_DEFINITION, clippedAreaExpression, clippedLengthExpression, featureCountExpression } from '../src/gis/habitat-metrics.js';
import { buildDiscoveryUnits } from '../src/discovery/units.js';
import { segmentUnit } from '../src/discovery/segment.js';
import { buildDiscoveryResult } from '../src/discovery/signals.js';
import { promoteDiscoveryResult } from '../src/discovery/lifecycle.js';

// The batch survey and the detailed corridor panel must compute the same habitat metrics from the same
// definition. This file guards that with the actual statements both paths issue, so a future edit to one
// path cannot quietly fork the area, count, or coverage semantics.

const PROJECT = "ST_Transform(geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true)";
const CORRIDOR = { id: 'drv1-metrics', geometry: { type: 'LineString', coordinates: [[-122.9, 45.56], [-122.89, 45.57]] } };
function entryFor(id) {
  return { id, registeredName: `${id}.parquet`, transferredBytes: 1024, version: 'v1', sha256: 'a'.repeat(64),
    crs: 'EPSG:4326', scope: { bbox: [-123.07, 45.505, -122.75, 45.67] },
    source: { agency: 'test agency', dataset: id, publicationDate: '2025-01-01', url: 'https://example.test', license: 'x' } };
}

function recordingEngine(rowsFor) {
  const statements = [];
  const engine = { db: { registerFileBuffer: async () => {} },
    conn: { query: async sql => { statements.push(sql); return { toArray: () => rowsFor(sql) }; } } };
  return { statements, engine };
}

async function batchStatements() {
  const { statements, engine } = recordingEngine(sql => {
    if (/AS candidate/.test(sql)) return [{ a: 0 }];
    if (/ST_Buffer\(geom, 250\)/.test(sql)) return [{ a: 0 }];
    return [];
  });
  const queries = createDiscoveryQueries({
    openDataset: async datasetId => entryFor(datasetId), initialize: async () => engine, record: () => {},
    provenance: entry => ({ datasetId: entry.id }),
    analytical: createAnalyticalGeometryQueries({ initialize: async () => engine }) });
  await queries.analyzeDiscoveryCorridors([CORRIDOR]);
  return statements;
}

async function detailedStatements() {
  const { statements, engine } = recordingEngine(sql => (/AS candidate/.test(sql) ? [{ a: 0 }] : []));
  const queries = createHabitatQueries({
    openDataset: async datasetId => entryFor(datasetId), initialize: async () => engine, record: () => {},
    analytical: createAnalyticalGeometryQueries({ initialize: async () => engine }) });
  await queries.queryWetlands(CORRIDOR, { corridorId: CORRIDOR.id });
  await queries.queryHydrography(CORRIDOR, { corridorId: CORRIDOR.id });
  return statements;
}

test('both habitat paths build their metrics from one shared definition', async () => {
  const [batch, detailed] = [await batchStatements(), await detailedStatements()];
  const wetlandBuffers = sql => sql.includes('wetland.wetland_type AS label') || sql.includes('w.geom')
    || (sql.includes('AS label') && sql.includes('sum(area_m2) AS area_m2'));
  const batchBuffer = batch.find(sql => sql.includes('count(DISTINCT source_feature_id)') && sql.includes(' AS w'));
  const detailedBuffer = detailed.find(sql => sql.includes('count(DISTINCT source_feature_id)') && sql.includes('AS label'));
  assert.ok(batchBuffer, 'the batch issues a wetland buffer statement');
  assert.ok(detailedBuffer, 'the detailed path issues a wetland buffer statement');
  // The same builder must have produced both area and count expressions, with each path's own aliases.
  assert.ok(batchBuffer.includes(clippedAreaExpression('w.geom', 'b.geom')), 'batch area expression comes from the shared definition');
  assert.ok(detailedBuffer.includes(clippedAreaExpression(`ST_Transform(wetland.geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true)`,
    'ST_Buffer((SELECT g FROM road), d.distance_m)')), 'detailed area expression comes from the shared definition');
  assert.ok(batchBuffer.includes(`${featureCountExpression()} AS feature_count`), 'batch counts come from the shared definition');
  assert.ok(detailedBuffer.includes(`${featureCountExpression()} AS feature_count`), 'detailed counts come from the shared definition');
  // Coverage: one statement text for the detailed path, one expression pair for the batch, same predicate order.
  const batchCoverage = batch.find(sql => sql.includes('corridor_inside'));
  const detailedCoverage = detailed.find(sql => sql.includes('corridor_inside'));
  assert.ok(batchCoverage.includes('ST_Contains((SELECT w FROM extent), ST_Buffer(c.geom, b.distance_m))'), batchCoverage);
  assert.ok(batchCoverage.includes('ST_Intersects((SELECT w FROM extent), c.geom)'), 'the batch compares the projected corridor');
  assert.ok(detailedCoverage.includes('ST_Contains((SELECT w FROM extent), ST_Buffer((SELECT g FROM road), d.distance_m))'), detailedCoverage);
  assert.ok(detailedCoverage.includes('ST_Intersects((SELECT w FROM extent), (SELECT g FROM road))'), detailedCoverage);
  // The batch must never compare a projected extent with a geographic corridor: that was a real bug.
  assert.ok(!/ST_Intersects\(\(SELECT w FROM extent\), c\.geom_4326\)/.test(batch.join('\n')), 'coverage never mixes CRS');
  assert.ok(batch.some(sql => sql.includes(clippedLengthExpression('f.geom', 'b.geom'))),
    'batch hydrography length comes from the shared definition too');
  assert.ok(detailed.some(sql => sql.includes(clippedLengthExpression("ST_Transform(feature.geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true)",
    'ST_Buffer((SELECT g FROM road), d.distance_m)'))), 'detailed hydrography length comes from the shared definition too');
  assert.ok(wetlandBuffers(detailedBuffer), 'the wetland buffer statement is the one just checked');
});

test('the habitat metric definition is documented as a feature-area sum, not a union', () => {
  assert.match(HABITAT_METRIC_DEFINITION.area, /sum of each mapped feature/);
  assert.match(HABITAT_METRIC_DEFINITION.area, /not a spatial union/);
  assert.deepEqual([...HABITAT_METRIC_DEFINITION.distancesM], [250, 500, 1000]);
  assert.equal(clippedAreaExpression('a', 'b'), 'ST_Area(ST_Intersection(a, b))');
  assert.equal(clippedLengthExpression('a', 'b'), 'ST_Length(ST_Intersection(a, b))');
  assert.equal(featureCountExpression(), 'count(DISTINCT source_feature_id)');
});

// ------------------------------------------- promotion measures the corridor, not the road group

const METRICS = { wetlands: { coverage: 'FULL', buffers: { 250: { areaM2: 0, featureCount: 0 },
    500: { areaM2: 0, featureCount: 0 }, 1000: { areaM2: 0, featureCount: 0 } } },
  hydrography: { coverage: 'FULL', buffers: { 1000: { areaM2: 0, lengthM: 0, featureCount: 0 } } },
  ecology: { coverage: 'FULL', level3: null, level4: null } };

function feature(id, name, roadId, coordinates) {
  return { roadId, name, roadClass: 'S1400', routeType: 'M', sourceFeatureId: id, countyFips: '41067',
    countyName: 'Washington County, Oregon', geometry: { type: 'LineString', coordinates } };
}

function longNamedRoad() {
  // One named road, about 19 km at this latitude, which is long enough that discovery divides it into
  // several corridors - the case that used to be promoted as the whole road group.
  const coordinates = [];
  for (let index = 0; index <= 120; index += 1) coordinates.push([-123.02 + index * 0.002, 45.55]);
  return [feature('a', 'Long Sample Rd', 'tiger-2025-or-41067-long-sample-rd', coordinates)];
}

test('a promoted corridor keeps the corridor geometry instead of the whole road group', () => {
  const features = longNamedRoad();
  const unit = buildDiscoveryUnits(features).units[0];
  const segmented = segmentUnit(unit);
  assert.ok(segmented.corridors.length > 1, 'the fixture road is long enough to be segmented');
  const corridor = segmented.corridors[1];
  const result = buildDiscoveryResult({ unit, corridor, metrics: METRICS });
  const candidate = promoteDiscoveryResult(result, { features, corridor });
  assert.equal(candidate.roads.length, 1);
  assert.deepEqual(candidate.roads[0].geometry, corridor.geometry, 'the candidate measures the corridor it was promoted from');
  assert.equal(candidate.roads[0].lengthM, corridor.lengthM);
  assert.ok(candidate.roads[0].lengthM < unit.lengthM, 'the whole road group is longer, which is what used to be measured');
  assert.deepEqual(candidate.roads[0].evidence.geometry.corridorSegment,
    { index: 2, count: segmented.corridors.length, method: 'contiguous vertices along the composed unit' });
  // Provenance still describes the composed road group the corridor belongs to.
  assert.deepEqual([...candidate.roads[0].sourceFeatureIds], ['a']);
  assert.equal(candidate.roads[0].name, 'Long Sample Rd');
  // A caller that promotes a whole hand-declared road (no corridor) keeps the composed group.
  const whole = promoteDiscoveryResult(result, { features });
  assert.equal(whole.roads[0].lengthM, unit.lengthM);
});

test('a single-segment corridor is promoted unchanged', () => {
  // About 2 km: one corridor, above the minimum corridor length and below the segmentation threshold.
  const features = [feature('a', 'Short Sample Rd', 'tiger-2025-or-41067-short-sample-rd',
    [[-123.02, 45.55], [-122.99, 45.55]])];
  const unit = buildDiscoveryUnits(features).units[0];
  const segmented = segmentUnit(unit);
  assert.equal(segmented.corridors.length, 1);
  const corridor = segmented.corridors[0];
  const result = buildDiscoveryResult({ unit, corridor, metrics: METRICS });
  const candidate = promoteDiscoveryResult(result, { features, corridor });
  assert.equal(candidate.roads[0].lengthM, corridor.lengthM);
  assert.equal(candidate.roads[0].lengthM, unit.lengthM);
  assert.equal(candidate.roads[0].evidence.geometry.corridorSegment.count, 1);
});
