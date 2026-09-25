import { COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';
import { corridorGeometry, corridorWkt } from '../domain/geometry.js';
import { ANALYSIS_DISTANCES_M, MEASURE_CRS, bufferSummary, distanceOrNull, summarizeBufferCoverage } from './habitat-result.js';

// Buffered habitat analysis against the bounded wetland and hydrography extracts.
//
// All measurement happens in EPSG:5070 (NAD83 Conus Albers), the metric projection the ecoregion
// layer already uses. Coverage is decided per requested distance by testing whether the buffered
// corridor lies inside the dataset's recorded coverage extent, so an extract that only partly
// covers the analysis region can never report a confident zero.

export const HABITAT_METHOD = 'Corridor buffered in EPSG:5070 and intersected with the bounded habitat extract in DuckDB Spatial; '
  + 'areas and lengths measured in EPSG:5070 meters; coverage tested per requested distance against the dataset coverage extent.';
export const HABITAT_DATASETS = Object.freeze({
  [COVERAGE_DATASET.WETLANDS]: 'nwi-wetlands-or-pilot',
  [COVERAGE_DATASET.HYDROGRAPHY]: 'nhd-hydrography-or-pilot',
});

export function createHabitatQueries({ openDataset, initialize, record }) {
  const round3 = value => Math.round(Number(value) * 1000) / 1000;

  // Both helpers project into EPSG:5070 with an explicit source CRS, because the DuckDB-WASM
  // spatial build tags geometry through ST_Transform only. The WKT itself is generated solely
  // from validated numeric GeoJSON coordinates or manifest bounds.
  function project(source) {
    return `ST_Transform(${source}, 'EPSG:4326', 'EPSG:5070', always_xy := true)`;
  }

  function roadSql(wkt) {
    return project(`ST_GeomFromText('${wkt}')`);
  }

  function windowSql(entry) {
    const [minLon, minLat, maxLon, maxLat] = entry.scope.bbox;
    return project(`ST_GeomFromText('POLYGON((${minLon} ${minLat}, ${maxLon} ${minLat}, ${maxLon} ${maxLat}, ${minLon} ${maxLat}, ${minLon} ${minLat}))')`);
  }

  function distanceValues(distancesM) {
    return distancesM.map(distance => `(${Number(distance)})`).join(', ');
  }

  // Bounding-box prefilter against the extract's stored bounds: only features that could possibly
  // reach the buffered corridor are transformed and measured, which keeps the browser queries
  // bounded by neighbourhood size instead of extract size. The pad is deliberately generous.
  function boundsClause(bounds, distanceM) {
    if (!Array.isArray(bounds) || bounds.length !== 4) return 'TRUE';
    const centre = ((bounds[1] + bounds[3]) / 2) * Math.PI / 180;
    const latPad = (distanceM / 110000) * 1.1;
    const lonPad = (distanceM / (111320 * Math.max(Math.cos(centre), 0.2))) * 1.1;
    return `min_lon <= ${bounds[2] + lonPad} AND max_lon >= ${bounds[0] - lonPad} `
      + `AND min_lat <= ${bounds[3] + latPad} AND max_lat >= ${bounds[1] - latPad}`;
  }

  async function coverageRows(entry, wkt, distancesM, engine) {
    const sql = `WITH road AS (SELECT ${roadSql(wkt)} AS g), extent AS (SELECT ${windowSql(entry)} AS w),
      d(distance_m) AS (VALUES ${distanceValues(distancesM)})
      SELECT d.distance_m, ST_Contains((SELECT w FROM extent), ST_Buffer((SELECT g FROM road), d.distance_m)) AS covered,
             ST_Intersects((SELECT w FROM extent), (SELECT g FROM road)) AS corridor_inside
      FROM d ORDER BY d.distance_m`;
    return (await engine.conn.query(sql)).toArray().map(row => ({
      distanceM: Number(row.distance_m), covered: Boolean(row.covered), corridorInside: Boolean(row.corridor_inside),
    }));
  }

  function provenance(entry) {
    return Object.freeze({
      datasetId: entry.id, dataset: entry.source?.dataset ?? entry.id, datasetVersion: entry.version,
      agency: entry.source?.agency ?? null, vintage: entry.source?.vintage ?? null, publicationDate: entry.source?.publicationDate ?? null,
      referenceUrl: entry.source?.url ?? null, documentationUrl: entry.source?.documentationUrl ?? null, license: entry.source?.license ?? null,
      datasetDigest: entry.sha256, geometryCrs: entry.crs ?? null, sourceCrs: entry.normalization?.sourceCrs ?? null,
      measureCrs: entry.normalization?.measureCrs ?? MEASURE_CRS, pipelineVersion: entry.normalization?.pipelineVersion ?? null,
      method: entry.normalization?.method ?? null, coverageExtent: entry.scope?.bbox ?? null,
      simplifyToleranceM: entry.normalization?.simplifyToleranceM ?? null, productStatus: entry.source?.productStatus ?? null,
      retrievedAt: new Date().toISOString(),
    });
  }

  async function run(datasetId, started, work, unavailable) {
    let entry = null;
    try {
      entry = await openDataset(datasetId);
      const engine = await initialize();
      const result = await work(entry, engine);
      const queryMs = Math.round(performance.now() - started);
      record(datasetId, entry, queryMs);
      return { datasetId, ...result, provenance: provenance(entry),
        diagnostics: { status: 'ready', reason: null, queryMs, datasetBytes: entry.transferredBytes } };
    } catch (error) {
      record(datasetId, entry, null, error.message);
      return { datasetId, coverage: COVERAGE.UNKNOWN, reason: error.message, ...unavailable, provenance: entry ? provenance(entry) : null,
        diagnostics: { status: 'unavailable', reason: error.message, queryMs: null, datasetBytes: entry?.transferredBytes ?? null } };
    }
  }

  async function queryWetlands(corridor, { distancesM = ANALYSIS_DISTANCES_M, includeGeometry = false } = {}) {
    const datasetId = HABITAT_DATASETS[COVERAGE_DATASET.WETLANDS];
    const geometry = corridorGeometry(corridor);
    const wkt = corridorWkt(geometry.geometry);
    const started = performance.now();
    return run(datasetId, started, async (entry, engine) => {
      const road = roadSql(wkt);
      const table = `read_parquet('${entry.registeredName}')`;
      const projected = `ST_Transform(wetland.geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true)`;
      const outer = Math.max(...distancesM);
      const prefilter = boundsClause(geometry.bounds, outer);
      const prefilter250 = boundsClause(geometry.bounds, 250);
      const buffers = (await engine.conn.query(`
        WITH road AS (SELECT ${road} AS g), d(distance_m) AS (VALUES ${distanceValues(distancesM)}),
        hit AS (
          SELECT d.distance_m, wetland.wetland_type AS label, wetland.attribute AS code, wetland.source_feature_id,
                 ST_Area(ST_Intersection(${projected}, ST_Buffer((SELECT g FROM road), d.distance_m))) AS area_m2
          FROM ${table} AS wetland, d
          WHERE ${prefilter} AND ST_Intersects(${projected}, ST_Buffer((SELECT g FROM road), d.distance_m))
        )
        SELECT distance_m, label, code, count(DISTINCT source_feature_id) AS feature_count, sum(area_m2) AS area_m2
        FROM hit WHERE area_m2 > 0 GROUP BY distance_m, label, code ORDER BY distance_m, sum(area_m2) DESC`))
        .toArray().map(row => ({ distanceM: Number(row.distance_m), label: row.label ?? 'Unclassified', code: row.code ?? null,
          featureCount: Number(row.feature_count), areaM2: Number(row.area_m2) }));
      // Nearest mapped wetland: measured over the neighbourhood prefilter first, and only if that
      // finds nothing inside the largest requested distance is the whole extract scanned. Features
      // whose bounds lie outside the padded corridor bounds are provably farther than that pad.
      const proximitySql = filter => `
        WITH road AS (SELECT ${road} AS g)
        SELECT count(*) FILTER (WHERE ST_Intersects(${projected}, (SELECT g FROM road))) AS corridor_features,
               min(ST_Distance(${projected}, (SELECT g FROM road))) AS nearest_m
        FROM ${table} AS wetland WHERE ${filter}`;
      const near = (await engine.conn.query(proximitySql(prefilter))).toArray()[0];
      const proximity = near?.nearest_m != null && Number(near.nearest_m) <= outer
        ? near : (await engine.conn.query(proximitySql('TRUE'))).toArray()[0];
      const coverage = await coverageRows(entry, wkt, distancesM, engine);
      const geometryRows = includeGeometry ? (await engine.conn.query(`
        WITH road AS (SELECT ${road} AS g)
        SELECT wetland.source_feature_id, wetland.attribute, wetland.wetland_type, ST_AsGeoJSON(wetland.geometry) AS geometry_json
        FROM ${table} AS wetland
        WHERE ${prefilter250} AND ST_Intersects(${projected}, ST_Buffer((SELECT g FROM road), 250))
        ORDER BY wetland.source_feature_id LIMIT 400`)).toArray().map(row => ({
        layer: 'wetland', sourceFeatureId: String(row.source_feature_id), label: row.wetland_type, code: row.attribute,
        geometry: JSON.parse(row.geometry_json),
      })) : [];
      const coverageSummary = summarizeBufferCoverage({ distancesM, coverageRows: coverage });
      // Class inventory comes from the widest requested buffer only: nested buffers would otherwise
      // count the same wetland area several times.
      const widest = buffers.filter(row => row.distanceM === outer);
      const classes = [...new Set(widest.map(row => row.label))].map(label => ({
        label, code: widest.find(row => row.label === label)?.code ?? null,
        areaM2: round3(widest.filter(row => row.label === label).reduce((total, row) => total + row.areaM2, 0)),
        featureCount: widest.filter(row => row.label === label).reduce((total, row) => total + row.featureCount, 0),
      })).sort((a, b) => b.areaM2 - a.areaM2 || a.label.localeCompare(b.label));
      return { ...coverageSummary, coverageByDistance: coverageSummary.perDistance,
        nearestDistanceM: distanceOrNull(proximity?.nearest_m), intersectsCorridor: Number(proximity?.corridor_features ?? 0) > 0,
        corridorFeatureCount: Number(proximity?.corridor_features ?? 0), buffers: bufferSummary(buffers, distancesM),
        classes: Object.freeze(classes), classDistanceM: outer, geometryRows };
    }, { buffers: {}, classes: Object.freeze([]), coverageByDistance: {}, nearestDistanceM: null, intersectsCorridor: false, corridorFeatureCount: 0 });
  }

  async function queryHydrography(corridor, { distancesM = ANALYSIS_DISTANCES_M, includeGeometry = false } = {}) {
    const datasetId = HABITAT_DATASETS[COVERAGE_DATASET.HYDROGRAPHY];
    const geometry = corridorGeometry(corridor);
    const wkt = corridorWkt(geometry.geometry);
    const started = performance.now();
    const outer = Math.max(...distancesM);
    return run(datasetId, started, async (entry, engine) => {
      const road = roadSql(wkt);
      const table = `read_parquet('${entry.registeredName}')`;
      const projected = `ST_Transform(feature.geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true)`;
      const prefilter = boundsClause(geometry.bounds, outer);
      const prefilter250 = boundsClause(geometry.bounds, 250);
      const buffers = (await engine.conn.query(`
        WITH road AS (SELECT ${road} AS g), d(distance_m) AS (VALUES ${distanceValues(distancesM)}),
        hit AS (
          SELECT d.distance_m, feature.layer, feature.source_feature_id,
                 ST_Length(ST_Intersection(${projected}, ST_Buffer((SELECT g FROM road), d.distance_m))) AS length_m,
                 ST_Area(ST_Intersection(${projected}, ST_Buffer((SELECT g FROM road), d.distance_m))) AS area_m2
          FROM ${table} AS feature, d
          WHERE ${prefilter} AND ST_Intersects(${projected}, ST_Buffer((SELECT g FROM road), d.distance_m))
        )
        SELECT distance_m, layer AS label, layer AS code, count(DISTINCT source_feature_id) AS feature_count,
               sum(area_m2) AS area_m2, sum(length_m) AS length_m
        FROM hit WHERE length_m > 0 OR area_m2 > 0 GROUP BY distance_m, layer ORDER BY distance_m, layer`))
        .toArray().map(row => ({ distanceM: Number(row.distance_m), label: row.label, code: row.code,
          featureCount: Number(row.feature_count), areaM2: Number(row.area_m2 ?? 0), lengthM: Number(row.length_m ?? 0) }));
      const crossings = (await engine.conn.query(`
        WITH road AS (SELECT ${road} AS g)
        SELECT feature.source_feature_id, feature.name, feature.feature_type_code, feature.feature_type_label, feature.water_class,
               ST_Length(ST_Intersection(${projected}, (SELECT g FROM road))) AS overlap_m
        FROM ${table} AS feature
        WHERE feature.layer = 'flowline' AND ${prefilter} AND ST_Intersects(${projected}, (SELECT g FROM road))
        ORDER BY overlap_m DESC, feature.source_feature_id`))
        .toArray().map(row => ({ sourceFeatureId: String(row.source_feature_id), name: row.name || null,
          featureTypeCode: Number(row.feature_type_code), featureTypeLabel: row.feature_type_label, waterClass: row.water_class,
          overlapM: round3(Number(row.overlap_m ?? 0)) }));
      // Same two-stage proximity: neighbourhood first, full extract scan only when the fast path
      // cannot prove which feature is nearest.
      const proximitySql = filter => `
        WITH road AS (SELECT ${road} AS g)
        SELECT min(ST_Distance(${projected}, (SELECT g FROM road))) FILTER (WHERE feature.water_class = 'flowing') AS nearest_flowing_m,
               min(ST_Distance(${projected}, (SELECT g FROM road))) FILTER (WHERE feature.water_class = 'standing') AS nearest_standing_m,
               count(*) FILTER (WHERE feature.water_class = 'flowing' AND ST_Intersects(${projected}, (SELECT g FROM road))) AS corridor_flowlines
        FROM ${table} AS feature WHERE ${filter}`;
      const near = (await engine.conn.query(proximitySql(prefilter))).toArray()[0];
      const nearestKnown = [near?.nearest_flowing_m, near?.nearest_standing_m]
        .every(value => value != null && Number(value) <= outer);
      const proximity = nearestKnown ? near : (await engine.conn.query(proximitySql('TRUE'))).toArray()[0];
      const types = (await engine.conn.query(`
        WITH road AS (SELECT ${road} AS g)
        SELECT feature.layer, feature.water_class, feature.feature_type_code, feature.feature_type_label, count(*) AS feature_count
        FROM ${table} AS feature
        WHERE ${prefilter} AND ST_Intersects(${projected}, ST_Buffer((SELECT g FROM road), ${outer}))
        GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC`))
        .toArray().map(row => ({ layer: row.layer, waterClass: row.water_class, featureTypeCode: Number(row.feature_type_code),
          featureTypeLabel: row.feature_type_label, featureCount: Number(row.feature_count) }));
      const names = (await engine.conn.query(`
        WITH road AS (SELECT ${road} AS g)
        SELECT DISTINCT feature.name FROM ${table} AS feature
        WHERE feature.name <> '' AND ${prefilter} AND ST_Intersects(${projected}, ST_Buffer((SELECT g FROM road), ${outer}))
        ORDER BY feature.name LIMIT 40`)).toArray().map(row => row.name);
      const coverage = await coverageRows(entry, wkt, distancesM, engine);
      const geometryRows = includeGeometry ? (await engine.conn.query(`
        WITH road AS (SELECT ${road} AS g)
        SELECT feature.source_feature_id, feature.name, feature.feature_type_label, ST_AsGeoJSON(feature.geometry) AS geometry_json
        FROM ${table} AS feature
        WHERE feature.layer = 'flowline' AND ${prefilter250} AND ST_Intersects(${projected}, ST_Buffer((SELECT g FROM road), 250))
        ORDER BY feature.source_feature_id LIMIT 400`)).toArray().map(row => ({
        layer: 'flowline', sourceFeatureId: String(row.source_feature_id), label: row.name || row.feature_type_label, code: null,
        geometry: JSON.parse(row.geometry_json),
      })) : [];
      const coverageSummary = summarizeBufferCoverage({ distancesM, coverageRows: coverage });
      return { ...coverageSummary, coverageByDistance: coverageSummary.perDistance,
        crossings: Object.freeze(crossings), crossingCount: crossings.length,
        nearestFlowingWaterM: distanceOrNull(proximity?.nearest_flowing_m), nearestStandingWaterM: distanceOrNull(proximity?.nearest_standing_m),
        corridorFlowlineCount: Number(proximity?.corridor_flowlines ?? 0), buffers: bufferSummary(buffers, distancesM),
        types: Object.freeze(types), names: Object.freeze(names), geometryRows };
    }, { buffers: {}, crossings: Object.freeze([]), crossingCount: 0, types: Object.freeze([]), names: Object.freeze([]),
      coverageByDistance: {}, nearestFlowingWaterM: null, nearestStandingWaterM: null, corridorFlowlineCount: 0 });
  }

  async function getHabitatContext(corridor, options = {}) {
    const started = performance.now();
    const distancesM = [...(options.distancesM ?? ANALYSIS_DISTANCES_M)];
    // Sequential on purpose: both queries share one DuckDB-WASM connection.
    const wetlands = await queryWetlands(corridor, { ...options, distancesM });
    const hydrography = await queryHydrography(corridor, { ...options, distancesM });
    return {
      analysisDistancesM: distancesM, measuredCrs: MEASURE_CRS, wetlands, hydrography,
      provenance: Object.freeze({ wetlands: wetlands.provenance ?? null, hydrography: hydrography.provenance ?? null, method: HABITAT_METHOD }),
      diagnostics: {
        status: wetlands.diagnostics.status === 'ready' && hydrography.diagnostics.status === 'ready' ? 'ready' : 'partial',
        reason: [wetlands.reason, hydrography.reason].filter(Boolean).join('; ') || null,
        queryMs: Math.round(performance.now() - started),
        wetlandsMs: wetlands.diagnostics.queryMs, hydrographyMs: hydrography.diagnostics.queryMs,
      },
    };
  }

  async function getHabitatOverlay(corridor, { distanceM = 1000 } = {}) {
    const started = performance.now();
    try {
      const geometry = corridorGeometry(corridor);
      const engine = await initialize();
      const outline = (await engine.conn.query(
        `SELECT ST_AsGeoJSON(ST_Transform(ST_Buffer(${roadSql(corridorWkt(geometry.geometry))}, ${Number(distanceM)}), 'EPSG:5070', 'EPSG:4326', always_xy := true)) AS geometry_json`))
        .toArray()[0];
      const wetlands = await queryWetlands(geometry.geometry, { includeGeometry: true });
      const hydrography = await queryHydrography(geometry.geometry, { includeGeometry: true });
      return { distanceM, bufferGeometry: outline?.geometry_json ? JSON.parse(outline.geometry_json) : null,
        features: [...(wetlands.geometryRows ?? []), ...(hydrography.geometryRows ?? [])],
        diagnostics: { status: 'ready', reason: null, queryMs: Math.round(performance.now() - started) } };
    } catch (error) {
      return { distanceM, bufferGeometry: null, features: [], diagnostics: { status: 'unavailable', reason: error.message } };
    }
  }

  return { queryWetlands, queryHydrography, getHabitatContext, getHabitatOverlay, provenance };
}
