import { ANALYSIS_DISTANCES_M, bufferSummary, summarizeBufferCoverage } from './habitat-result.js';
import { combineCoverage } from './ecoregion-result.js';
import { COVERAGE } from '../domain/corridor.js';

// Reading the derived corridor-metrics partitions.
//
// One row is one discovery corridor, replicated into every 0.2 degree cell its geometry intersects, so the
// query deduplicates by corridor id exactly as the raw regional reader deduplicates replicated source
// features. The geometry comes back as GeoJSON because that is what the map, the exact-radius test, and
// promotion all work with.
const DERIVED_COLUMNS = [
  'corridor_id', 'road_component_id', 'road_unit_id', 'name', 'normalized_name', 'length_m', 'tiger_class',
  'county_names', 'counties', 'road_ids', 'road_classes', 'source_feature_ids', 'segment_index', 'segment_count',
  'geometry_repaired', 'geometry_repair_method', 'analysis_fingerprint',
  'primary_l3_code', 'primary_l3_name', 'primary_l3_percent', 'primary_l4_code', 'primary_l4_name', 'primary_l4_percent',
  'l3_count', 'l4_count', 'transition_count', 'ecology_coverage',
  'wetland_intersects', 'wetland_nearest_m', 'wetland_area_250_m2', 'wetland_area_500_m2', 'wetland_area_1000_m2',
  'wetland_count_250', 'wetland_count_500', 'wetland_count_1000', 'wetland_type_summary',
  'hydro_crossing_count', 'hydro_nearest_flowing_m', 'hydro_nearest_standing_m', 'hydro_flowline_length_1000_m',
  'hydro_waterbody_area_1000_m2', 'hydro_summary',
  'coverage', 'coverage_wetlands_250', 'coverage_wetlands_500', 'coverage_wetlands_1000',
  'coverage_hydro_250', 'coverage_hydro_500', 'coverage_hydro_1000',
];

export function derivedRelation(registeredNames) {
  return `read_parquet([${registeredNames.map(name => `'${name}'`).join(', ')}])`;
}

export async function queryDerivedCorridors(engine, registeredNames, { limit = 200000 } = {}) {
  if (!registeredNames.length) return { rows: [], replicatedRows: 0, rowCount: 0 };
  const relation = derivedRelation(registeredNames);
  const sql = `SELECT ${DERIVED_COLUMNS.join(', ')},
      ST_XMin(geometry) AS min_lon, ST_YMin(geometry) AS min_lat, ST_XMax(geometry) AS max_lon, ST_YMax(geometry) AS max_lat,
      ST_AsGeoJSON(geometry) AS geometry_json
    FROM (SELECT *, row_number() OVER (PARTITION BY corridor_id) AS rn FROM ${relation}) AS derived
    WHERE rn = 1 ORDER BY corridor_id LIMIT ${Number(limit) + 1}`;
  const started = performance.now();
  const raw = (await engine.conn.query(sql)).toArray();
  if (raw.length > limit) throw new Error(`Derived result exceeds the ${limit} corridor limit; narrow the search area.`);
  const rows = raw.map(row => ({ ...row, geometry: JSON.parse(row.geometry_json),
    counties: [...(row.counties ?? [])], county_names: [...(row.county_names ?? [])],
    road_ids: [...(row.road_ids ?? [])], road_classes: [...(row.road_classes ?? [])],
    source_feature_ids: [...(row.source_feature_ids ?? [])] }));
  return { rows, rowCount: rows.length, queryMs: Math.round(performance.now() - started) };
}

function coverageStates(row) {
  const wetlands = Object.fromEntries(ANALYSIS_DISTANCES_M.map(distance => [distance, row[`coverage_wetlands_${distance}`] ?? COVERAGE.UNKNOWN]));
  const hydrography = Object.fromEntries(ANALYSIS_DISTANCES_M.map(distance => [distance, row[`coverage_hydro_${distance}`] ?? COVERAGE.UNKNOWN]));
  return { wetlands, hydrography };
}

function levelEntry(row, level) {
  const code = row[`primary_l${level}_code`];
  const name = row[`primary_l${level}_name`];
  const percent = row[`primary_l${level}_percent`];
  const count = Number(row[`l${level}_count`] ?? 0);
  if (code == null) return { primary: null, intersections: [], spansMultiple: false, measuredM: null, coverage: COVERAGE.NONE };
  const primary = Object.freeze({ code: String(code), name: String(name), percent: Number(percent ?? 0) });
  return { primary, intersections: [primary], spansMultiple: count > 1, measuredM: null,
    intersectionCount: count, coverage: row.ecology_coverage };
}

// The metric blocks the shared result builder and the interface already understand, rebuilt from the stored
// row: same shapes, same coverage vocabulary, same distances.
export function derivedMetrics(row) {
  const states = coverageStates(row);
  const wetlandBuffers = Object.fromEntries(ANALYSIS_DISTANCES_M.map(distance => [distance, {
    areaM2: Number(row[`wetland_area_${distance}_m2`] ?? 0), lengthM: 0,
    featureCount: Number(row[`wetland_count_${distance}`] ?? 0), breakdown: [] }]));
  const hydroBuffers = Object.fromEntries(ANALYSIS_DISTANCES_M.map(distance => [distance, {
    areaM2: distance === 1000 ? Number(row.hydro_waterbody_area_1000_m2 ?? 0) : 0,
    lengthM: distance === 1000 ? Number(row.hydro_flowline_length_1000_m ?? 0) : 0,
    featureCount: Number(row.hydro_crossing_count ?? 0), breakdown: [] }]));
  const wetlandCoverage = summarizeBufferCoverage({ distancesM: ANALYSIS_DISTANCES_M,
    coverageRows: ANALYSIS_DISTANCES_M.map(distance => ({ distanceM: distance,
      covered: states.wetlands[distance] === COVERAGE.FULL, corridorInside: Boolean(row.wetland_intersects) })) });
  const hydroCoverage = summarizeBufferCoverage({ distancesM: ANALYSIS_DISTANCES_M,
    coverageRows: ANALYSIS_DISTANCES_M.map(distance => ({ distanceM: distance,
      covered: states.hydrography[distance] === COVERAGE.FULL, corridorInside: Number(row.hydro_crossing_count ?? 0) > 0 })) });
  const level3 = levelEntry(row, 3);
  const level4 = levelEntry(row, 4);
  const ecologyCoverage = combineCoverage({ coverage: level3.coverage }, { coverage: level4.coverage });
  return {
    wetlands: { ...wetlandCoverage, coverageByDistance: wetlandCoverage.perDistance,
      intersectsCorridor: Boolean(row.wetland_intersects),
      nearestDistanceM: row.wetland_nearest_m == null ? null : Number(row.wetland_nearest_m),
      corridorFeatureCount: Number(row.wetland_count_1000 ?? 0),
      buffers: bufferSummary(Object.entries(wetlandBuffers).map(([distance, entry]) => ({ distanceM: Number(distance),
        areaM2: entry.areaM2, featureCount: entry.featureCount, label: null })), ANALYSIS_DISTANCES_M),
      classes: row.wetland_type_summary ? [{ label: String(row.wetland_type_summary), code: null, areaM2: Number(row.wetland_area_1000_m2 ?? 0),
        featureCount: Number(row.wetland_count_1000 ?? 0) }] : [] },
    hydrography: { ...hydroCoverage, coverageByDistance: hydroCoverage.perDistance,
      crossingCount: Number(row.hydro_crossing_count ?? 0), crossings: [],
      nearestFlowingWaterM: row.hydro_nearest_flowing_m == null ? null : Number(row.hydro_nearest_flowing_m),
      nearestStandingWaterM: row.hydro_nearest_standing_m == null ? null : Number(row.hydro_nearest_standing_m),
      corridorFlowlineCount: Number(row.hydro_crossing_count ?? 0),
      buffers: bufferSummary(Object.entries(hydroBuffers).map(([distance, entry]) => ({ distanceM: Number(distance),
        areaM2: entry.areaM2, lengthM: entry.lengthM, featureCount: entry.featureCount, label: null })), ANALYSIS_DISTANCES_M),
      names: row.hydro_summary ? String(row.hydro_summary).split(' | ') : [], types: [] },
    ecology: { coverage: ecologyCoverage, spansMultiple: Boolean(level3.spansMultiple || level4.spansMultiple),
      level3, level4, provenance: null },
    // Repair provenance is part of what the row stores, so the result's own "was this geometry altered for
    // analysis?" answer comes from the row rather than from a default that would always say no.
    geometryForAnalysis: Object.freeze({ repaired: Boolean(row.geometry_repaired),
      method: row.geometry_repair_method ?? 'none',
      note: 'Precomputed from verified regional GIS; the raw corridor is reconstructed and verified on promotion.' }),
  };
}

export function derivedUnit(row, geometry, bounds) {
  return { id: String(row.road_unit_id), name: row.name, geometry, bounds, lengthM: Number(row.length_m),
    roadClasses: [...(row.road_classes ?? [])].sort(), countyNames: [...(row.county_names ?? [])],
    countyFips: [...(row.counties ?? [])].sort(), sourceFeatureIds: [...(row.source_feature_ids ?? [])],
    roadIds: [...(row.road_ids ?? [])].sort(),
    composition: { usedFeatureCount: (row.source_feature_ids ?? []).length, partCount: null, maxUnresolvedGapM: null },
    componentId: String(row.road_component_id), derived: true };
}

export function derivedCorridor(row, geometry, bounds) {
  return { id: String(row.corridor_id), name: row.name, geometry, bounds, lengthM: Number(row.length_m),
    unitId: String(row.road_unit_id), segmentIndex: Number(row.segment_index), segmentCount: Number(row.segment_count),
    geometryForAnalysis: { repaired: Boolean(row.geometry_repaired), method: row.geometry_repair_method,
      note: 'Precomputed from verified regional GIS; the raw corridor is reconstructed and verified on promotion.' } };
}
