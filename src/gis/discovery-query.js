import { COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';
import { corridorGeometry } from '../domain/geometry.js';
import { UNREPAIRABLE_GEOMETRY_REASON, describeGeometryForAnalysis } from '../domain/analytical-geometry.js';
import { ANALYSIS_DISTANCES_M, MEASURE_CRS, bufferSummary, distanceOrNull, paddedBounds, summarizeBufferCoverage } from './habitat-result.js';
import { combineCoverage, summarizeLevel } from './ecoregion-result.js';
import { HABITAT_DATASETS } from './habitat-query.js';

// Set-oriented discovery analysis: every discovery corridor in the search area is analysed in one
// batch per dataset instead of one round trip per road. The measurement definitions are the same
// ones the detailed corridor analysis uses (EPSG:5070 measurement, the same neighbourhood pads, the
// same per-distance coverage test, the same ecoregion summary), which is why the per-corridor
// results are assembled with the shared summarizers instead of a second set of formulas.
// See docs/DISCOVERY.md and docs/HABITAT.md.
export const DISCOVERY_METHOD = 'All discovery corridors inserted into one DuckDB temp table, projected once into EPSG:5070, '
  + 'then intersected with the bounded wetland, hydrography, and EPA ecoregion datasets in one query per dataset; '
  + 'areas, lengths, and distances measured in EPSG:5070 meters; coverage tested per corridor and per requested distance '
  + 'against the dataset coverage extent; ecoregion and buffer summaries use the same summarizers as detailed corridor analysis.';
export const ECO_L3_DATASET = 'epa-ecoregions-or-l3';
export const ECO_L4_DATASET = 'epa-ecoregions-or-l4';
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// Reported for a corridor whose geometry the analysis engine cannot buffer and that no accepted
// point-preserving repair rescues: its habitat metrics are unknown, not zero, and the reason travels
// with the corridor. See src/gis/analytical-geometry.js and docs/DISCOVERY.md.
export const BUFFER_FAILURE_REASON = UNREPAIRABLE_GEOMETRY_REASON;
const CORRIDOR_TABLE = 'rn_discovery_corridor';
const ANALYSIS_TABLE = 'rn_discovery_analysis';
// Buffered corridor geometry per requested distance, materialised once for every corridor.
const BUFFER_TABLE = 'rn_discovery_buffer';
// Projected copies of the bounded habitat extracts, created once per batch run.
const WETLAND_TABLE = 'rn_discovery_wetland';
const HYDRO_TABLE = 'rn_discovery_hydro';
const sourceSql = entry => entry.readExpression ?? `read_parquet('${entry.registeredName}')`;

export function createDiscoveryQueries({ openDataset, initialize, record, provenance = () => null, analytical = null }) {
  const project = source => `ST_Transform(${source}, 'EPSG:4326', 'EPSG:5070', always_xy := true)`;
  const distanceValues = distancesM => distancesM.map(distance => `(${Number(distance)})`).join(', ');

  function extentPolygon(entry) {
    const [minLon, minLat, maxLon, maxLat] = entry.scope.bbox;
    return project(`ST_GeomFromText('POLYGON((${minLon} ${minLat}, ${maxLon} ${minLat}, ${maxLon} ${maxLat}, ${minLon} ${maxLat}, ${minLon} ${minLat}))')`);
  }

  // Per-corridor neighbourhood pads, computed once in JavaScript with the shared pad definition and
  // stored as ordinary numeric columns, so the batch SQL applies the same prefilter as a per-corridor
  // query instead of scanning the extract for every corridor.
  function padColumns(bounds, distance) {
    const pad = paddedBounds(bounds, distance);
    return pad ? pad : [bounds[0], bounds[1], bounds[2], bounds[3]];
  }

  // The prefilter is written against the habitat dataset's own alias: wetlands are joined as `w`,
  // hydrography as `f`.
  // The habitat extracts store EPSG:4326 geometry. Transforming them once into a temp table removes a
  // per-feature, per-corridor ST_Transform from every join predicate, which is the difference between
  // a batched regional query and an unusable one on a bounded extract.
  async function prepareWetlands(engine, entry) {
    await engine.conn.query(`CREATE OR REPLACE TEMP TABLE ${WETLAND_TABLE} AS SELECT source_feature_id, attribute, `
      + `wetland_type, min_lon, min_lat, max_lon, max_lat, ${project('geometry')} AS geom `
      + `FROM ${sourceSql(entry)}`);
  }

  async function prepareHydro(engine, entry) {
    await engine.conn.query(`CREATE OR REPLACE TEMP TABLE ${HYDRO_TABLE} AS SELECT layer, source_feature_id, name, `
      + `feature_type_code, feature_type_label, water_class, min_lon, min_lat, max_lon, max_lat, ${project('geometry')} AS geom `
      + `FROM ${sourceSql(entry)}`);
  }

  function padClause(distance, alias = 'w') {
    return `c.pad${distance}_min_lon <= ${alias}.max_lon AND c.pad${distance}_max_lon >= ${alias}.min_lon `
      + `AND c.pad${distance}_min_lat <= ${alias}.max_lat AND c.pad${distance}_max_lat >= ${alias}.min_lat`;
  }

  // A handful of real TIGER centerlines defeat GEOS buffering ("assigned depths do not match") even
  // though ST_IsValid accepts them. The shared analytical-geometry boundary prepares each corridor:
  // canonical geometry first (the fast path, costing exactly what it cost before repair existed), then
  // the point-preserving repair ladder for corridors the engine refuses. Corridors that remain
  // unbufferable are reported with UNKNOWN habitat coverage and a reason instead of failing the batch.
  async function prepareCorridorGeometries(engine, corridors, distancesM) {
    if (!analytical?.prepareAnalyticalGeometries) throw new Error('Discovery requires the shared analytical geometry service');
    const prepared = await analytical.prepareAnalyticalGeometries({ engine, corridors, distancesM,
      probeCanonical: (corridor, id) => analytical.probeStoredGeometry(engine, { table: ANALYSIS_TABLE, id, distancesM }) });
    const outer = Math.max(...distancesM);
    for (const corridor of corridors) {
      const entry = prepared.geometries.get(corridor.id);
      if (!entry?.repaired || !entry.usable) continue;
      // Only the *analytical* representation moves; the canonical corridor the map draws and the road
      // length reported to the user are untouched, and this fact travels in the result provenance.
      const bounds = corridorGeometry(entry.geometry).bounds;
      const assignments = [['min_lon', bounds[0]], ['min_lat', bounds[1]], ['max_lon', bounds[2]], ['max_lat', bounds[3]]];
      for (const distance of [outer, 250]) {
        const pad = padColumns(bounds, distance);
        ['min_lon', 'min_lat', 'max_lon', 'max_lat'].forEach((name, index) => assignments.push([`pad${distance}_${name}`, pad[index]]));
      }
      await engine.conn.query(`UPDATE ${ANALYSIS_TABLE} SET geom = ${project(`ST_GeomFromText('${entry.wkt}')`)}, `
        + `geom_4326 = ST_GeomFromText('${entry.wkt}'), ${assignments.map(([column, value]) => `${column} = ${Number(value)}`).join(', ')} `
        + `WHERE id = '${corridor.id}'`);
    }
    return prepared;
  }

  async function prepareBuffers(engine, distancesM, unbufferable = []) {
    const exclusion = unbufferable.length ? ` WHERE c.id NOT IN (${unbufferable.map(id => `'${id}'`).join(', ')})` : '';
    await engine.conn.query(`CREATE OR REPLACE TEMP TABLE ${BUFFER_TABLE} AS SELECT c.id AS id, d.distance_m AS distance_m, `
      + `ST_Buffer(c.geom, d.distance_m) AS geom FROM ${ANALYSIS_TABLE} AS c, (VALUES ${distanceValues(distancesM)}) AS d(distance_m)`
      + exclusion);
  }

  async function createCorridorTable(engine, corridors, distancesM, phase) {

    const outer = Math.max(...distancesM);
    const columns = distance => ['min_lon', 'min_lat', 'max_lon', 'max_lat'].map(name => `pad${distance}_${name} DOUBLE`).join(', ');
    const rows = corridors.map(corridor => {
      const geometry = corridorGeometry(corridor);
      const pads = [outer, 250].map(distance => padColumns(geometry.bounds, distance).join(', ')).join(', ');
      return `('${corridor.id}', ST_GeomFromText('${wktOf(geometry.geometry)}'), ${geometry.bounds.join(', ')}, ${pads})`;
    });
    await engine.conn.query(`CREATE OR REPLACE TEMP TABLE ${CORRIDOR_TABLE}(id VARCHAR, geom GEOMETRY, `
      + `min_lon DOUBLE, min_lat DOUBLE, max_lon DOUBLE, max_lat DOUBLE, ${columns(outer)}, ${columns(250)})`);
    await engine.conn.query(`INSERT INTO ${CORRIDOR_TABLE} VALUES ${rows.join(', ')}`);
    await engine.conn.query(`CREATE OR REPLACE TEMP TABLE ${ANALYSIS_TABLE} AS SELECT id, `
      + `${project('geom')} AS geom, geom AS geom_4326, min_lon, min_lat, max_lon, max_lat, `
      + [outer, 250].flatMap(distance => ['min_lon', 'min_lat', 'max_lon', 'max_lat'].map(name => `pad${distance}_${name}`)).join(', ')
      + ` FROM ${CORRIDOR_TABLE}`);
    const validateStarted = performance.now();
    const prepared = await prepareCorridorGeometries(engine, corridors, distancesM);
    phase.validate = Math.round(performance.now() - validateStarted);
    const bufferStarted = performance.now();
    await prepareBuffers(engine, distancesM, prepared.unusableIds);
    phase.buffers = Math.round(performance.now() - bufferStarted);
    return { outer, unbufferable: [...prepared.unusableIds], prepared };
  }

  function wktOf(geometry) {
    const lineText = line => `(${line.map(point => point.join(' ')).join(',')})`;
    return geometry.type === 'LineString' ? `LINESTRING${lineText(geometry.coordinates)}`
      : `MULTILINESTRING(${geometry.coordinates.map(lineText).join(',')})`;
  }

  function groupByCorridor(rows) {
    const grouped = new Map();
    for (const row of rows) {
      const id = String(row.id);
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(row);
    }
    return grouped;
  }

  function coverageSql(entry, distancesM) {
    return `
      WITH extent AS (SELECT ${extentPolygon(entry)} AS w)
      SELECT b.id AS id, b.distance_m AS distance_m, ST_Contains((SELECT w FROM extent), b.geom) AS covered,
             ST_Intersects((SELECT w FROM extent), c.geom_4326) AS corridor_inside
      FROM ${BUFFER_TABLE} AS b JOIN ${ANALYSIS_TABLE} AS c ON c.id = b.id ORDER BY b.id, b.distance_m`;
  }

  function round3(value) {
    return Math.round(Number(value) * 1000) / 1000;
  }

  // Wetlands: buffered area and feature counts per requested distance, nearest mapped wetland, the
  // corridor-intersection flag, and the class inventory at the widest distance.
  async function wetlandMetrics(engine, entry, distancesM) {
    const table = WETLAND_TABLE;
    const projected = 'w.geom';
    const outer = Math.max(...distancesM);
    await prepareWetlands(engine, entry);
    const bufferRows = (await engine.conn.query(`
      WITH hit AS (
        SELECT b.id AS id, b.distance_m AS distance_m, w.wetland_type AS label, w.attribute AS code,
               w.source_feature_id AS source_feature_id,
               ST_Area(ST_Intersection(${projected}, b.geom)) AS area_m2
        FROM ${BUFFER_TABLE} AS b JOIN ${ANALYSIS_TABLE} AS c ON c.id = b.id, ${table} AS w
        WHERE ${padClause(outer)} AND ST_Intersects(${projected}, b.geom)
      )
      SELECT id, distance_m, label, code, count(DISTINCT source_feature_id) AS feature_count, sum(area_m2) AS area_m2
      FROM hit WHERE area_m2 > 0 GROUP BY id, distance_m, label, code ORDER BY id, distance_m, sum(area_m2) DESC`))
      .toArray().map(row => ({ id: String(row.id), distanceM: Number(row.distance_m), label: row.label ?? 'Unclassified',
        code: row.code ?? null, featureCount: Number(row.feature_count), areaM2: Number(row.area_m2) }));
    const proximitySql = filter => `
      SELECT c.id AS id, count(*) FILTER (WHERE ST_Intersects(${projected}, c.geom)) AS corridor_features,
             min(ST_Distance(${projected}, c.geom)) AS nearest_m
      FROM ${table} AS w, ${ANALYSIS_TABLE} AS c WHERE ${filter} GROUP BY c.id`;
    const mapProximity = rows => rows.map(row => ({ id: String(row.id), corridorFeatures: Number(row.corridor_features),
      nearestM: row.nearest_m == null ? null : Number(row.nearest_m) }));
    const near = mapProximity((await engine.conn.query(proximitySql(padClause(outer)))).toArray());
    // Same two-stage proximity as the detailed queries: the fast neighbourhood scan answers for most
    // corridors, and only corridors whose nearest feature is farther than the widest requested
    // distance fall back to a full-extract scan for those ids.
    const unresolved = near.filter(row => row.nearestM == null || row.nearestM > outer).map(row => row.id);
    const scanned = unresolved.length && !entry.partitioned
      ? mapProximity((await engine.conn.query(proximitySql(`c.id IN (${unresolved.map(id => `'${id}'`).join(', ')})`))).toArray())
      : [];
    const coverageRows = (await engine.conn.query(coverageSql(entry, distancesM))).toArray()
      .map(row => ({ id: String(row.id), distanceM: Number(row.distance_m), covered: Boolean(row.covered), corridorInside: Boolean(row.corridor_inside) }));
    return { buffers: groupByCorridor(bufferRows), coverageRows: groupByCorridor(coverageRows),
      proximity: new Map([...near, ...scanned].map(row => [row.id, entry.partitioned && row.nearestM > outer
        ? { ...row, nearestM: null } : row])) };
  }



  // Hydrography: buffered flowline length and waterbody area per distance, mapped crossings on the
  // corridor line, the corridor flowline count, nearest flowing and standing water, and names.
  async function hydroMetrics(engine, entry, distancesM) {
    const table = HYDRO_TABLE;
    const projected = 'f.geom';
    const outer = Math.max(...distancesM);
    await prepareHydro(engine, entry);
    const bufferRows = (await engine.conn.query(`
      WITH hit AS (
        SELECT b.id AS id, b.distance_m AS distance_m, f.layer AS layer, f.source_feature_id AS source_feature_id,
               ST_Length(ST_Intersection(${projected}, b.geom)) AS length_m,
               ST_Area(ST_Intersection(${projected}, b.geom)) AS area_m2
        FROM ${BUFFER_TABLE} AS b JOIN ${ANALYSIS_TABLE} AS c ON c.id = b.id, ${table} AS f
        WHERE ${padClause(outer, 'f')} AND ST_Intersects(${projected}, b.geom)
      )
      SELECT id, distance_m, layer, count(DISTINCT source_feature_id) AS feature_count,
             sum(area_m2) AS area_m2, sum(length_m) AS length_m
      FROM hit WHERE length_m > 0 OR area_m2 > 0 GROUP BY id, distance_m, layer ORDER BY id, distance_m, layer`))
      .toArray().map(row => ({ id: String(row.id), distanceM: Number(row.distance_m), label: row.layer, code: row.layer,
        featureCount: Number(row.feature_count), areaM2: Number(row.area_m2 ?? 0), lengthM: Number(row.length_m ?? 0) }));
    const crossings = (await engine.conn.query(`
      SELECT c.id AS id, f.source_feature_id AS source_feature_id, f.name AS name, f.feature_type_label AS feature_type_label,
             ST_Length(ST_Intersection(${projected}, c.geom)) AS overlap_m
      FROM ${table} AS f, ${ANALYSIS_TABLE} AS c
      WHERE f.layer = 'flowline' AND ${padClause(outer, 'f')} AND ST_Intersects(${projected}, c.geom)
      ORDER BY c.id, overlap_m DESC, f.source_feature_id`))
      .toArray().map(row => ({ id: String(row.id), sourceFeatureId: String(row.source_feature_id), name: row.name || null,
        featureTypeLabel: row.feature_type_label, overlapM: round3(Number(row.overlap_m ?? 0)) }));
    const proximitySql = filter => `
      SELECT c.id AS id,
             min(ST_Distance(${projected}, c.geom)) FILTER (WHERE f.water_class = 'flowing') AS nearest_flowing_m,
             min(ST_Distance(${projected}, c.geom)) FILTER (WHERE f.water_class = 'standing') AS nearest_standing_m,
             count(*) FILTER (WHERE f.water_class = 'flowing' AND ST_Intersects(${projected}, c.geom)) AS corridor_flowlines
      FROM ${table} AS f, ${ANALYSIS_TABLE} AS c WHERE ${filter} GROUP BY c.id`;
    const mapProximity = rows => rows.map(row => ({ id: String(row.id),
      nearestFlowingM: row.nearest_flowing_m == null ? null : Number(row.nearest_flowing_m),
      nearestStandingM: row.nearest_standing_m == null ? null : Number(row.nearest_standing_m),
      corridorFlowlines: Number(row.corridor_flowlines) }));
    const near = mapProximity((await engine.conn.query(proximitySql(padClause(outer, 'f')))).toArray());
    const unresolved = near.filter(row => [row.nearestFlowingM, row.nearestStandingM]
      .some(value => value == null || value > outer)).map(row => row.id);
    const scanned = unresolved.length && !entry.partitioned
      ? mapProximity((await engine.conn.query(proximitySql(`c.id IN (${unresolved.map(id => `'${id}'`).join(', ')})`))).toArray())
      : [];
    const names = (await engine.conn.query(`
      SELECT DISTINCT c.id AS id, f.name AS name FROM ${table} AS f, ${BUFFER_TABLE} AS b JOIN ${ANALYSIS_TABLE} AS c ON c.id = b.id
      WHERE b.distance_m = ${outer} AND f.name <> '' AND ${padClause(outer, 'f')} AND ST_Intersects(${projected}, b.geom)
      ORDER BY c.id, f.name`)).toArray().map(row => ({ id: String(row.id), name: row.name }));
    const coverageRows = (await engine.conn.query(coverageSql(entry, distancesM))).toArray()
      .map(row => ({ id: String(row.id), distanceM: Number(row.distance_m), covered: Boolean(row.covered), corridorInside: Boolean(row.corridor_inside) }));
    return { buffers: groupByCorridor(bufferRows), coverageRows: groupByCorridor(coverageRows),
      crossings: groupByCorridor(crossings), names: groupByCorridor(names),
      proximity: new Map([...near, ...scanned].map(row => [row.id, entry.partitioned ? {
        ...row, nearestFlowingM: row.nearestFlowingM > outer ? null : row.nearestFlowingM,
        nearestStandingM: row.nearestStandingM > outer ? null : row.nearestStandingM } : row])) };
  }

  // Water-feature type inventory at the widest requested distance, grouped the same way the detailed
  // hydrography query groups it.
  async function hydroTypeMetrics(engine, entry, distancesM) {
    const table = HYDRO_TABLE;
    const projected = 'f.geom';
    const outer = Math.max(...distancesM);
    return groupByCorridor((await engine.conn.query(`
      SELECT c.id AS id, f.layer AS layer, f.water_class AS water_class, f.feature_type_code AS feature_type_code,
             f.feature_type_label AS feature_type_label, count(*) AS feature_count
      FROM ${table} AS f, ${BUFFER_TABLE} AS b JOIN ${ANALYSIS_TABLE} AS c ON c.id = b.id
      WHERE b.distance_m = ${outer} AND ${padClause(outer, 'f')} AND ST_Intersects(${projected}, b.geom)
      GROUP BY 1, 2, 3, 4, 5 ORDER BY id, feature_count DESC`)).toArray().map(row => ({ id: String(row.id),
      layer: row.layer, waterClass: row.water_class, featureTypeCode: Number(row.feature_type_code),
      featureTypeLabel: row.feature_type_label, featureCount: Number(row.feature_count) })));
  }

  // Ecoregion overlap per corridor: the same intersection and the same summary function the detailed
  // corridor analysis uses, so the primary ecoregion and the percent split are identical.
  async function levelMetrics(engine, entry) {
    const table = sourceSql(entry);
    const projected = project('e.geometry');
    const rows = (await engine.conn.query(`
      WITH pieces AS (
        SELECT c.id AS id, e.code AS code, e.name AS name, ST_Length(ST_Intersection(${projected}, c.geom)) AS overlap_m
        FROM ${table} AS e, ${ANALYSIS_TABLE} AS c
        WHERE c.min_lon <= e.max_lon AND c.max_lon >= e.min_lon
          AND c.min_lat <= e.max_lat AND c.max_lat >= e.min_lat AND ST_Intersects(e.geometry, c.geom_4326)
      )
      SELECT id, code, name, SUM(overlap_m) AS overlap_m FROM pieces
      WHERE overlap_m > 0 GROUP BY id, code, name ORDER BY id, SUM(overlap_m) DESC, code`)).toArray()
      .map(row => ({ id: String(row.id), code: row.code, name: row.name, overlapM: Number(row.overlap_m) }));
    return groupByCorridor(rows);
  }

  async function routeLengths(engine) {
    const rows = (await engine.conn.query(`SELECT id, ST_Length(geom) AS length_m FROM ${ANALYSIS_TABLE}`)).toArray();
    return new Map(rows.map(row => [String(row.id), Number(row.length_m)]));
  }

  function emptyMetrics() {
    return {
      wetlands: { coverage: COVERAGE.UNKNOWN, reason: 'Not analysed', perDistance: {}, coverageByDistance: {}, buffers: {},
        classes: Object.freeze([]), nearestDistanceM: null, intersectsCorridor: false, corridorFeatureCount: 0 },
      hydrography: { coverage: COVERAGE.UNKNOWN, reason: 'Not analysed', perDistance: {}, coverageByDistance: {}, buffers: {},
        crossings: Object.freeze([]), crossingCount: 0, nearestFlowingWaterM: null, nearestStandingWaterM: null,
        corridorFlowlineCount: 0, types: Object.freeze([]), names: Object.freeze([]) },
      ecology: { coverage: COVERAGE.UNKNOWN, spansMultiple: false, level3: null, level4: null },
    };
  }

  // Habitat blocks are only as good as their coverage: `reason` is carried through so a corridor whose
  // buffer leaves the extract is never presented as having zero wetlands or zero crossings.
  function wetlandBlock(entry, distancesM, metrics, provenance, bufferFailed = false) {
    const rows = bufferFailed ? [] : metrics?.buffers ?? [];
    const coverage = summarizeBufferCoverage({ distancesM, coverageRows: metrics?.coverageRows ?? [],
      reason: bufferFailed ? BUFFER_FAILURE_REASON : null });
    const widest = rows.filter(row => row.distanceM === Math.max(...distancesM));
    const classes = [...new Set(widest.map(row => row.label))].map(label => ({
      label, code: widest.find(row => row.label === label)?.code ?? null,
      areaM2: round3(widest.filter(row => row.label === label).reduce((total, row) => total + row.areaM2, 0)),
      featureCount: widest.filter(row => row.label === label).reduce((total, row) => total + row.featureCount, 0),
    })).sort((a, b) => b.areaM2 - a.areaM2 || a.label.localeCompare(b.label));
    return { ...coverage, coverageByDistance: coverage.perDistance, buffers: bufferSummary(rows, distancesM),
      classes: Object.freeze(classes), nearestDistanceM: distanceOrNull(metrics?.proximity?.nearestM),
      intersectsCorridor: Number(metrics?.proximity?.corridorFeatures ?? 0) > 0,
      corridorFeatureCount: Number(metrics?.proximity?.corridorFeatures ?? 0),
      provenance: provenance(entry), diagnostics: { status: 'ready', reason: null } };
  }

  function hydroBlock(entry, distancesM, metrics, provenance, bufferFailed = false) {
    const rows = bufferFailed ? [] : metrics?.buffers ?? [];
    const coverage = summarizeBufferCoverage({ distancesM, coverageRows: metrics?.coverageRows ?? [],
      reason: bufferFailed ? BUFFER_FAILURE_REASON : null });
    const crossings = Object.freeze((metrics?.crossings ?? []).map(row => Object.freeze({ ...row })));
    return { ...coverage, coverageByDistance: coverage.perDistance, buffers: bufferSummary(rows, distancesM),
      crossings, crossingCount: crossings.length,
      nearestFlowingWaterM: distanceOrNull(metrics?.proximity?.nearestFlowingM),
      nearestStandingWaterM: distanceOrNull(metrics?.proximity?.nearestStandingM),
      corridorFlowlineCount: Number(metrics?.proximity?.corridorFlowlines ?? 0),
      types: Object.freeze((metrics?.types ?? []).map(row => Object.freeze({ ...row }))),
      names: Object.freeze((metrics?.names ?? []).slice(0, 40).map(row => row.name)),
      provenance: provenance(entry), diagnostics: { status: 'ready', reason: null } };
  }

  function ecologyBlock(entry3, entry4, lengths, rows3, rows4, provenance) {
    const level3 = summarizeLevel(rows3, lengths);
    const level4 = summarizeLevel(rows4, lengths);
    return { coverage: combineCoverage(level3, level4), spansMultiple: level3.spansMultiple || level4.spansMultiple,
      level3, level4, provenance: { level3: provenance(entry3), level4: provenance(entry4) },
      diagnostics: { status: 'ready', reason: null } };
  }

  function unavailableBlock(kind, reason, entry, provenance, distancesM) {
    const base = { coverage: COVERAGE.UNKNOWN, reason, perDistance: {}, coverageByDistance: {}, buffers: {},
      diagnostics: { status: 'unavailable', reason }, provenance: entry ? provenance(entry) : null };
    if (kind === 'ecology') return { coverage: COVERAGE.UNKNOWN, reason, spansMultiple: false, level3: null, level4: null,
      diagnostics: { status: 'unavailable', reason }, provenance: null };
    return { ...base, ...(kind === 'wetlands'
      ? { classes: Object.freeze([]), nearestDistanceM: null, intersectsCorridor: false, corridorFeatureCount: 0 }
      : { crossings: Object.freeze([]), crossingCount: 0, nearestFlowingWaterM: null, nearestStandingWaterM: null,
        corridorFlowlineCount: 0, types: Object.freeze([]), names: Object.freeze([]) }) };
  }

  async function analyzeDiscoveryCorridors(corridors, { distancesM = ANALYSIS_DISTANCES_M, openDataset: datasetOpener = openDataset } = {}) {
    const started = performance.now();
    const requested = [...(corridors ?? [])].map(corridor => {
      if (!corridor?.id || !ID_PATTERN.test(corridor.id)) throw new TypeError(`Invalid discovery corridor id: ${corridor?.id}`);
      return { id: corridor.id, geometry: corridor.geometry };
    });
    if (!requested.length) return { corridors: Object.freeze({}),
      diagnostics: { status: 'ready', reason: null, corridorCount: 0, queryMs: 0, datasetErrors: Object.freeze([]) } };
    const distances = [...distancesM];
    let engine;
    let unbufferable = [];
    let prepared = null;
    const phase = {};
    try {
      const prepareStarted = performance.now();
      engine = await initialize();
      ({ unbufferable, prepared } = await createCorridorTable(engine, requested, distances, phase));
      phase.prepare = Math.round(performance.now() - prepareStarted);
    } catch (error) {
      const blocks = {};
      for (const corridor of requested) {
        blocks[corridor.id] = { wetlands: unavailableBlock('wetlands', error.message, null, provenance, distances),
          hydrography: unavailableBlock('hydrography', error.message, null, provenance, distances),
          ecology: unavailableBlock('ecology', error.message, null, provenance, distances) };
      }
      record(null, null, null, error.message);
      return { corridors: Object.freeze(blocks), diagnostics: { status: 'unavailable', reason: error.message,
        corridorCount: requested.length, queryMs: Math.round(performance.now() - started), phaseMs: Object.freeze(phase),
        datasetErrors: Object.freeze([error.message]) } };
    }
    const errors = [];
    const attempt = async (datasetId, run) => {
      const queryStarted = performance.now();
      let entry = null;
      try {
        entry = await datasetOpener(datasetId);
        const result = await run(entry);
        record(datasetId, entry, Math.round(performance.now() - queryStarted));
        return { entry, result };
      } catch (error) {
        errors.push(`${datasetId}: ${error.message}`);
        record(datasetId, entry, null, error.message);
        return { entry, result: null, error };
      }
    };
    const timed = async (key, run) => { const at = performance.now(); const value = await run(); phase[key] = Math.round(performance.now() - at); return value; };
    const wetlands = await timed('wetlands', () => attempt(HABITAT_DATASETS[COVERAGE_DATASET.WETLANDS], entry => wetlandMetrics(engine, entry, distances)));
    const hydrography = await timed('hydrography', () => attempt(HABITAT_DATASETS[COVERAGE_DATASET.HYDROGRAPHY], entry => hydroMetrics(engine, entry, distances)));
    const hydroTypes = hydrography.result ? await timed('hydroTypes', () => hydroTypeMetrics(engine, hydrography.entry, distances)) : new Map();
    const level3 = await timed('level3', () => attempt(ECO_L3_DATASET, entry => levelMetrics(engine, entry)));
    const level4 = await timed('level4', () => attempt(ECO_L4_DATASET, entry => levelMetrics(engine, entry)));
    const lengths = level3.result || level4.result ? await timed('routeLengths', () => routeLengths(engine)) : new Map();
    const blocks = {};
    for (const corridor of requested) {
      const id = corridor.id;
      const analyticalEntry = prepared?.geometries?.get(id) ?? null;
      blocks[id] = {
        // Whether the analysis engine needed a repaired analytical geometry, and if so which repair and
        // how far it moved anything. Explicit even when nothing was repaired.
        geometryForAnalysis: analyticalEntry?.geometryForAnalysis ?? describeGeometryForAnalysis({ repaired: false }),
        wetlands: wetlands.result ? wetlandBlock(wetlands.entry, distances, { buffers: wetlands.result.buffers.get(id) ?? [],
          coverageRows: wetlands.result.coverageRows.get(id) ?? [], proximity: wetlands.result.proximity.get(id) }, provenance,
          unbufferable.includes(id))
          : unavailableBlock('wetlands', wetlands.error.message, wetlands.entry, provenance, distances),
        hydrography: hydrography.result ? hydroBlock(hydrography.entry, distances, { buffers: hydrography.result.buffers.get(id) ?? [],
          coverageRows: hydrography.result.coverageRows.get(id) ?? [], crossings: hydrography.result.crossings.get(id) ?? [],
          names: hydrography.result.names.get(id) ?? [], types: hydroTypes.get(id) ?? [],
          proximity: hydrography.result.proximity.get(id) }, provenance, unbufferable.includes(id))
          : unavailableBlock('hydrography', hydrography.error.message, hydrography.entry, provenance, distances),
        ecology: level3.result && level4.result
          ? ecologyBlock(level3.entry, level4.entry, lengths.get(id) ?? 0, level3.result.get(id) ?? [], level4.result.get(id) ?? [], provenance)
          : unavailableBlock('ecology', [level3.error, level4.error].filter(Boolean).map(error => error.message).join('; ')
            || 'Ecoregion data unavailable', level3.entry ?? level4.entry, provenance, distances),
      };
    }
    const diagnostics = { status: errors.length || unbufferable.length ? 'partial' : 'ready',
      reason: [errors.join('; '), unbufferable.length
        ? `${unbufferable.length} corridor(s) could not be prepared for buffering: ${unbufferable.slice(0, 3).join(', ')}` : null]
        .filter(Boolean).join('; ') || null,
      corridorCount: requested.length, queryMs: Math.round(performance.now() - started), phaseMs: Object.freeze(phase),
      unbufferableCorridors: Object.freeze([...unbufferable]),
      repairedCorridors: Object.freeze([...(prepared?.repairedIds ?? [])]),
      analyticalGeometry: prepared?.diagnostics ?? null,
      datasetErrors: Object.freeze([...errors]) };
    return { corridors: Object.freeze(blocks), diagnostics };
  }

  return { analyzeDiscoveryCorridors };
}
