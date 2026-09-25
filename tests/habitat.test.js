import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { COVERAGE, COVERAGE_DATASET, createCoverage, setDatasetCoverage } from '../src/domain/corridor.js';
import { ANALYSIS_DISTANCES_M, MEASURE_CRS, bufferSummary, summarizeBufferCoverage } from '../src/gis/habitat-result.js';
import { HABITAT_DATASETS, HABITAT_METHOD, createHabitatQueries } from '../src/gis/habitat-query.js';
import { HABITAT_EVIDENCE_KIND, summarizeHabitat } from '../src/habitat/context.js';
import { createGisService } from '../src/gis/service.js';
import { validateManifest } from '../src/services/manifest.js';
import { formatArea, formatDistance, formatLength } from '../src/ui/render.js';

const manifest = validateManifest(JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url))));
const wetlands = manifest.datasets.find(dataset => dataset.id === 'nwi-wetlands-or-pilot');
const hydrography = manifest.datasets.find(dataset => dataset.id === 'nhd-hydrography-or-pilot');
const expectations = JSON.parse(readFileSync(new URL('./fixtures/habitat-pilot-expectations.json', import.meta.url)));

export function artifactBytes(dataset) {
  return readFileSync(new URL(`../data/${dataset.url}`, import.meta.url));
}
export function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

test('habitat datasets declare pinned federal provenance, digests, and bounded coverage', () => {
  assert.equal(wetlands.type, 'wetlands');
  assert.equal(wetlands.source.agency, 'U.S. Fish and Wildlife Service');
  assert.match(wetlands.source.dataset, /National Wetlands Inventory/);
  assert.match(wetlands.source.url, /^https:\/\/documentst\.ecosphere\.fws\.gov\/wetlands\/data\/State-Downloads\/OR_geopackage_wetlands\.zip$/);
  assert.equal(wetlands.source.sha256.length, 64);
  assert.match(wetlands.source.license, /Public domain/);
  assert.equal(wetlands.normalization.measureCrs, MEASURE_CRS);
  assert.equal(wetlands.normalization.sourceCrs, 'EPSG:5070');
  assert.equal(wetlands.sourceCrs ?? wetlands.normalization.sourceCrs, 'EPSG:5070');
  assert.deepEqual(wetlands.scope.wetlandTypes, ['Freshwater Emergent Wetland', 'Freshwater Forested/Shrub Wetland', 'Freshwater Pond', 'Lake', 'Riverine']);
  assert.ok(wetlands.scope.sourceImageYears.length > 0, 'wetland imagery years must be recorded');
  assert.equal(wetlands.scope.statewideFeatureCount, 674153);

  assert.equal(hydrography.type, 'hydrography');
  assert.equal(hydrography.source.agency, 'U.S. Geological Survey');
  assert.match(hydrography.source.dataset, /National Hydrography Dataset/);
  assert.match(hydrography.source.productStatus, /retired on 2023-10-01/);
  assert.match(hydrography.source.successorProduct, /3D Hydrography Program/);
  assert.equal(Object.keys(hydrography.source.urls).length, 2);
  assert.equal(hydrography.source.sha256['17090010'].length, 64);
  assert.equal(hydrography.layers.flowline.featureCount > 0, true);
  assert.equal(hydrography.layers.waterbody.featureCount > 0, true);
  assert.equal(hydrography.normalization.sourceCrs, 'EPSG:4269');
  assert.ok(Array.isArray(hydrography.scope.sourceFeatureDates) && hydrography.scope.sourceFeatureDates.length > 0);
  // Bounded coverage: both extracts declare the analytical window and how the geometry was treated.
  for (const dataset of [wetlands, hydrography]) {
    assert.equal(dataset.scope.bbox.length, 4);
    assert.equal(dataset.scope.windowMarginM >= 1000, true);
    assert.equal(dataset.scope.geometryTreatment.simplifiedToleranceM > 0, true);
    assert.equal(dataset.scope.geometryTreatment.measuredCrs, MEASURE_CRS);
  }
});

test('committed habitat artifacts match their manifest bytes and digests', () => {
  for (const dataset of [wetlands, hydrography]) {
    const bytes = artifactBytes(dataset);
    assert.equal(bytes.byteLength, dataset.bytes, `${dataset.id} byte length`);
    assert.equal(digest(bytes), dataset.sha256, `${dataset.id} digest`);
    // GeoParquet magic + the b'geo' footer key: proof the browser will read a GeoParquet artifact.
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'PAR1');
    assert.equal(bytes.subarray(-4).toString('latin1'), 'PAR1');
    assert.ok(bytes.includes(Buffer.from('geo')), `${dataset.id} declares GeoParquet metadata`);
  }
});

test('buffer math reports meters and square meters per requested distance', () => {
  // Simple known fixtures: 1 000 m2 at 250 m, 25 000 m2 split across two wetland types at 500 m.
  const rows = [
    { distanceM: 250, label: 'Freshwater Emergent Wetland', code: 'PEM1A', featureCount: 1, areaM2: 1000 },
    { distanceM: 500, label: 'Freshwater Emergent Wetland', code: 'PEM1A', featureCount: 1, areaM2: 5000 },
    { distanceM: 500, label: 'Freshwater Forested/Shrub Wetland', code: 'PFO1A', featureCount: 2, areaM2: 20000 },
    { distanceM: 1000, label: 'Freshwater Emergent Wetland', code: 'PEM1A', featureCount: 1, areaM2: 5000 },
    { distanceM: 1000, label: 'Freshwater Forested/Shrub Wetland', code: 'PFO1A', featureCount: 2, areaM2: 20000 },
  ];
  const buffers = bufferSummary(rows, ANALYSIS_DISTANCES_M);
  assert.deepEqual(Object.keys(buffers), ['250', '500', '1000']);
  assert.equal(buffers[250].areaM2, 1000);
  assert.equal(buffers[250].featureCount, 1);
  assert.equal(buffers[500].areaM2, 25000);
  assert.equal(buffers[500].featureCount, 3);
  assert.deepEqual(buffers[500].breakdown.map(entry => entry.label), ['Freshwater Forested/Shrub Wetland', 'Freshwater Emergent Wetland']);
  assert.equal(buffers[1000].areaM2, 25000);
  // A distance with no rows is zero hectares only because the query covered it and found nothing.
  const empty = bufferSummary([], ANALYSIS_DISTANCES_M);
  assert.equal(empty[250].areaM2, 0);
  assert.equal(empty[1000].lengthM, 0);
});

test('coverage separates full, partial, none, unknown, and a covered zero result', () => {
  const distances = ANALYSIS_DISTANCES_M;
  const full = summarizeBufferCoverage({ distancesM: distances, coverageRows: distances.map(distance => ({ distanceM: distance, covered: true, corridorInside: true })) });
  assert.equal(full.coverage, COVERAGE.FULL);
  assert.equal(full.note, null);
  assert.deepEqual(Object.values(full.perDistance).map(entry => entry.coverage), [COVERAGE.FULL, COVERAGE.FULL, COVERAGE.FULL]);

  const partial = summarizeBufferCoverage({ distancesM: distances, coverageRows: [
    { distanceM: 250, covered: true, corridorInside: true },
    { distanceM: 500, covered: true, corridorInside: true },
    { distanceM: 1000, covered: false, corridorInside: true }] });
  assert.equal(partial.coverage, COVERAGE.PARTIAL);
  assert.equal(partial.perDistance[1000].coverage, COVERAGE.PARTIAL);
  assert.match(partial.note, /does not fully cover the 1000 m/);

  const none = summarizeBufferCoverage({ distancesM: distances, coverageRows: distances.map(distance => ({ distanceM: distance, covered: false, corridorInside: false })) });
  assert.equal(none.coverage, COVERAGE.NONE);
  assert.match(none.note, /unknown here, not zero/);

  const unknown = summarizeBufferCoverage({ distancesM: distances, coverageRows: [], reason: 'wetlands HTTP 503' });
  assert.equal(unknown.coverage, COVERAGE.UNKNOWN);
  assert.equal(unknown.reason, 'wetlands HTTP 503');
  assert.match(unknown.note, /not evidence that no habitat is present/);
  for (const distance of distances) assert.equal(unknown.perDistance[distance].coverage, COVERAGE.UNKNOWN);
});

const CORRIDOR = { type: 'MultiLineString', coordinates: [[[-122.9, 45.56], [-122.89, 45.57]]] };

function habitatEngine({ coverage, fail = null, wetlands = null, hydrography = null }) {
  const queries = [];
  return { queries, factory: async () => ({
    db: { registerFileBuffer: async () => {} },
    conn: { query: async sql => { queries.push(sql);
      if (fail) throw new Error(fail);
      const rows = sql.includes('AS covered') ? coverage
        : sql.includes('corridor_features') ? (wetlands?.proximity ?? [{ corridor_features: 0, nearest_m: 1000 }])
          : sql.includes('corridor_flowlines') ? (hydrography?.proximity ?? [{ nearest_flowing_m: 1000, nearest_standing_m: 1000, corridor_flowlines: 0 }])
            : sql.includes('wetland.wetland_type AS label') ? (wetlands?.buffers ?? [])
              : sql.includes('sum(area_m2) AS area_m2, sum(length_m) AS length_m') ? (hydrography?.buffers ?? [])
                : sql.includes('overlap_m DESC') ? (hydrography?.crossings ?? [])
                  : sql.includes('GROUP BY 1, 2, 3, 4') ? (hydrography?.types ?? [])
                    : sql.includes('DISTINCT feature.name') ? (hydrography?.names ?? [])
                      : (() => { throw new Error(`unexpected habitat SQL: ${sql.slice(0, 90)}`); })();
      return { toArray: () => rows };
    } },
  }) };
}

async function withHabitatFetch(run) {
  const bytes = readFileSync(new URL('../data/gis/nwi-wetlands-pilot.parquet', import.meta.url));
  const hydro = readFileSync(new URL('../data/gis/nhd-hydrography-pilot.parquet', import.meta.url));
  const original = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('wetlands') ? new Response(bytes)
    : String(url).includes('hydrography') ? new Response(hydro) : Promise.reject(new Error(`unexpected fetch ${url}`));
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('wetland and hydrography queries return coverage, metrics, and provenance', async () => {
  // DuckDB-shaped rows: the GIS layer maps snake_case columns into the domain result.
  const coverage = ANALYSIS_DISTANCES_M.map(distance_m => ({ distance_m, covered: true, corridor_inside: true }));
  const engine = habitatEngine({ coverage, wetlands: {
    proximity: [{ corridor_features: 2, nearest_m: 0 }],
    buffers: [{ distance_m: 250, label: 'Freshwater Emergent Wetland', code: 'PEM1A', feature_count: 2, area_m2: 157000 }],
  }, hydrography: {
    proximity: [{ nearest_flowing_m: 0, nearest_standing_m: 381.2, corridor_flowlines: 3 }],
    buffers: [{ distance_m: 250, label: 'flowline', code: 'flowline', feature_count: 4, area_m2: 0, length_m: 24191 }],
    crossings: [{ source_feature_id: '17090010:123', name: 'McKay Creek', feature_type_code: 460, feature_type_label: 'Stream/River', water_class: 'flowing', overlap_m: 12.5 }],
    types: [{ layer: 'flowline', water_class: 'flowing', feature_type_code: 460, feature_type_label: 'Stream/River', feature_count: 4 }],
    names: ['McKay Creek'],
  } });
  const gis = createGisService({ manifest, engineFactory: engine.factory });
  await withHabitatFetch(async () => {
    const habitat = await gis.getHabitatContext(CORRIDOR);
    assert.equal(habitat.measuredCrs, MEASURE_CRS);
    assert.deepEqual(habitat.analysisDistancesM, ANALYSIS_DISTANCES_M);
    assert.equal(habitat.wetlands.coverage, COVERAGE.FULL);
    assert.equal(habitat.wetlands.intersectsCorridor, true);
    assert.equal(habitat.wetlands.buffers[250].areaM2, 157000);
    assert.equal(habitat.wetlands.buffers[250].featureCount, 2);
    assert.equal(habitat.wetlands.buffers[1000].areaM2, 0, 'uncovered distances stay zero only when coverage is FULL');
    assert.equal(habitat.hydrography.coverage, COVERAGE.FULL);
    assert.equal(habitat.hydrography.crossingCount, 1);
    assert.equal(habitat.hydrography.crossings[0].name, 'McKay Creek');
    assert.equal(habitat.hydrography.nearestStandingWaterM, 381.2);
    assert.equal(habitat.hydrography.buffers[250].lengthM, 24191);
    assert.equal(habitat.provenance.wetlands.datasetId, 'nwi-wetlands-or-pilot');
    assert.equal(habitat.provenance.hydrography.datasetId, 'nhd-hydrography-or-pilot');
    assert.equal(habitat.provenance.hydrography.measureCrs, MEASURE_CRS);
    assert.match(habitat.provenance.method, /EPSG:5070/);
    assert.equal(habitat.diagnostics.status, 'ready');
    assert.equal(gis.diagnostics().habitatDatasetBytes['nwi-wetlands-or-pilot'], wetlands.bytes);
    // Set-oriented: buffered coverage, proximity, crossings, and inventory are single queries.
    assert.ok(engine.queries.length <= 16, `expected a small number of queries, saw ${engine.queries.length}`);
  });
});

test('missing habitat data is never reported as a zero measurement', async () => {
  const coverage = ANALYSIS_DISTANCES_M.map(distance_m => ({ distance_m, covered: true, corridor_inside: true }));
  // Query failure: UNKNOWN, no metrics, and the reason is preserved.
  const broken = createGisService({ manifest, engineFactory: habitatEngine({ coverage, fail: 'spatial extension unavailable' }).factory });
  await withHabitatFetch(async () => {
    const failed = await broken.getHabitatContext(CORRIDOR);
    assert.equal(failed.wetlands.coverage, COVERAGE.UNKNOWN);
    assert.match(failed.wetlands.reason, /spatial extension unavailable/);
    assert.deepEqual(failed.wetlands.buffers, {});
    assert.equal(failed.hydrography.coverage, COVERAGE.UNKNOWN);
    assert.equal(failed.diagnostics.status, 'partial');
    assert.equal(await broken.getCoverage(COVERAGE_DATASET.WETLANDS, CORRIDOR).then(result => result.status), COVERAGE.UNKNOWN);
  });

  // A covered query that finds nothing is a real zero with FULL coverage, not an error.
  const empty = createGisService({ manifest, engineFactory: habitatEngine({ coverage, wetlands: { proximity: [{ corridor_features: 0, nearest_m: 4210.5 }] } }).factory });
  await withHabitatFetch(async () => {
    const result = await empty.queryWetlands(CORRIDOR);
    assert.equal(result.coverage, COVERAGE.FULL);
    assert.equal(result.buffers[250].areaM2, 0);
    assert.equal(result.buffers[1000].featureCount, 0);
    assert.equal(result.intersectsCorridor, false);
    assert.equal(result.nearestDistanceM, 4210.5);
    assert.equal(result.classes.length, 0);
  });

  // The extract only covers the inner buffers: outer distances are PARTIAL, not zero.
  const partial = createGisService({ manifest, engineFactory: habitatEngine({ coverage: [
    { distance_m: 250, covered: true, corridor_inside: true },
    { distance_m: 500, covered: false, corridor_inside: true },
    { distance_m: 1000, covered: false, corridor_inside: true }] }).factory });
  await withHabitatFetch(async () => {
    const result = await partial.queryHydrography(CORRIDOR);
    assert.equal(result.coverage, COVERAGE.PARTIAL);
    assert.equal(result.coverageByDistance[250].coverage, COVERAGE.FULL);
    assert.equal(result.coverageByDistance[1000].coverage, COVERAGE.PARTIAL);
    assert.match(result.note, /may under-count/);
  });

  // A dataset that cannot be fetched at all (here: HTTP failure) stays UNKNOWN.
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 503 });
  try {
    const unavailable = createGisService({ manifest, engineFactory: habitatEngine({ coverage }).factory });
    const result = await unavailable.queryWetlands(CORRIDOR);
    assert.equal(result.coverage, COVERAGE.UNKNOWN);
    assert.match(result.reason, /HTTP 503/);
    assert.equal(result.diagnostics.status, 'unavailable');
  } finally { globalThis.fetch = original; }
});

test('habitat results carry physical-evidence framing, units, and per-dataset coverage', () => {
  const habitat = summarizeHabitat({
    analysisDistancesM: ANALYSIS_DISTANCES_M, measuredCrs: MEASURE_CRS,
    wetlands: { coverage: COVERAGE.FULL, coverageByDistance: { 250: { coverage: COVERAGE.FULL }, 500: { coverage: COVERAGE.FULL }, 1000: { coverage: COVERAGE.FULL } },
      intersectsCorridor: true, nearestDistanceM: 0, corridorFeatureCount: 2,
      buffers: { 250: { areaM2: 157000, featureCount: 2, breakdown: [{ label: 'Freshwater Emergent Wetland', code: 'PEM1A', areaM2: 157000, featureCount: 2 }] }, 500: { areaM2: 0, featureCount: 0, breakdown: [] }, 1000: { areaM2: 0, featureCount: 0, breakdown: [] } },
      classes: [{ label: 'Freshwater Emergent Wetland', code: 'PEM1A', areaM2: 157000, featureCount: 2 }] },
    hydrography: { coverage: COVERAGE.FULL, coverageByDistance: {}, nearestFlowingWaterM: 0, nearestStandingWaterM: 381.2,
      crossings: [{ sourceFeatureId: '17090010:123', name: 'McKay Creek', featureTypeLabel: 'Stream/River', waterClass: 'flowing', overlapM: 12.5 }],
      buffers: { 250: { lengthM: 24191, areaM2: 0, breakdown: [{ code: 'flowline', featureCount: 4, lengthM: 24191, areaM2: 0 }] } } },
    provenance: { method: HABITAT_METHOD }, diagnostics: { status: 'ready' },
  });
  assert.equal(habitat.kind, HABITAT_EVIDENCE_KIND);
  assert.equal(habitat.kind, 'PHYSICAL_HABITAT_EVIDENCE');
  assert.deepEqual(habitat.units, { distance: 'm', area: 'm2', length: 'm', measuredCrs: MEASURE_CRS });
  assert.equal(habitat.wetlands.buffers[250].classes[0].label, 'Freshwater Emergent Wetland');
  assert.equal(habitat.hydrography.crossings[0].name, 'McKay Creek');
  assert.equal(habitat.hydrography.crossingCount, 1);
  assert.match(habitat.hydrography.caveat, /does not establish a bridge, a ford, public access, current water presence/);
  assert.match(habitat.interpretation, /Not species occurrence, habitat quality, or access/);
  assert.deepEqual(habitat.coverage, { wetlands: COVERAGE.FULL, hydrography: COVERAGE.FULL });
  // Coverage flows into the candidate's per-dataset coverage record.
  const coverage = setDatasetCoverage(createCoverage(), COVERAGE_DATASET.HYDROGRAPHY, { coverage: COVERAGE.PARTIAL, reason: 'outer buffer outside extract' });
  assert.equal(coverage[COVERAGE_DATASET.HYDROGRAPHY].coverage, COVERAGE.PARTIAL);
  assert.equal(coverage[COVERAGE_DATASET.WETLANDS].coverage, COVERAGE.UNKNOWN);
});

test('pilot expectations fixture covers all three real corridors with plausible metrics', () => {
  assert.deepEqual(expectations.analysisDistancesM, ANALYSIS_DISTANCES_M);
  assert.equal(expectations.measuredCrs, MEASURE_CRS);
  assert.deepEqual(expectations.window, wetlands.scope.bbox);
  const ids = Object.keys(expectations.candidates);
  assert.equal(ids.length, 3);
  for (const id of ids) {
    const metrics = expectations.candidates[id];
    assert.equal(metrics.wetlands.coverage, COVERAGE.FULL, `${id} wetland coverage`);
    assert.equal(metrics.hydrography.coverage, COVERAGE.FULL, `${id} hydrography coverage`);
    let previous = 0;
    for (const distance of ANALYSIS_DISTANCES_M) {
      const wetlands250 = metrics.wetlands.buffers[String(distance)];
      assert.ok(wetlands250.areaM2 >= previous, `${id} wetland area must not shrink at ${distance} m`);
      previous = wetlands250.areaM2;
      const hydro = metrics.hydrography.buffers[String(distance)];
      assert.ok(hydro.flowlineLengthM > 0, `${id} expects mapped flowline within ${distance} m`);
      assert.ok(hydro.flowlineLengthM <= hydrography.scope.flowlineLengthM + 1, `${id} buffer length stays inside the extract`);
    }
    assert.ok(metrics.wetlands.buffers['1000'].areaM2 <= wetlands.scope.totalWetlandAreaM2, `${id} stays inside the extract total`);
    assert.ok(metrics.hydrography.crossingCount >= 0);
    if (metrics.wetlands.intersectsCorridor) assert.equal(metrics.wetlands.nearestDistanceM, 0);
  }
});

test('habitat metrics format as metric distances, hectares, and lengths', () => {
  assert.equal(formatDistance(0, { zero: 'Corridor intersects mapped flowing water' }), 'Corridor intersects mapped flowing water');
  assert.equal(formatDistance(84.2), '84 m');
  assert.equal(formatDistance(4210.5), '4.21 km');
  assert.equal(formatDistance(null), 'Not measured');
  assert.equal(formatArea(32000), '3.20 ha');
  assert.equal(formatArea(4321), '4,321 m²');
  assert.equal(formatLength(24191), '24.2 km');
  assert.equal(formatLength(280), '280 m');
});
