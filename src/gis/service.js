import { COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';
import { corridorGeometry } from '../domain/geometry.js';
import { loadManifest } from '../services/manifest.js';
import { createAnalyticalGeometryQueries } from './analytical-geometry.js';
import { combineCoverage, summarizeLevel } from './ecoregion-result.js';
import { createHabitatQueries } from './habitat-query.js';
import { createDiscoveryQueries } from './discovery-query.js';
import { createOccurrenceQueries } from './occurrence-query.js';
import { summarizeRoadQuery } from './road-result.js';

const DUCKDB_VERSION = '1.30.0';
const DUCKDB_ESM = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`;
const DATA_BASE = new URL('../../data/', import.meta.url);
const ROAD_DATASET_ID = 'or-roads-pilot';
// The bounded discovery network extract: all road features of the discovery-relevant TIGER classes
// inside the habitat analysis window. See scripts/build-road-network.py and docs/DISCOVERY.md.
const NETWORK_DATASET_ID = 'or-roads-network-pilot';
const ROAD_COLUMNS = 'road_id, name, road_class, route_type, county_fips, county_name, source_feature_id, part, ' +
  'length_m, source_agency, source_dataset, source_vintage, source_publication_date, source_url, ' +
  'source_archive_sha256, source_crs, crs, pipeline_version, normalization';
const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const ROAD_CLASS = /^[A-Z][0-9]{4}$/;
const MAX_ROAD_ROWS = 2000;
const MAX_NETWORK_ROWS = 20000;

function unknown(reason, datasets = []) {
  return { coverage: COVERAGE.UNKNOWN, level3: null, level4: null, spansMultiple: false,
    provenance: { dataset: 'EPA Level III/IV ecoregions', sources: datasets.map(dataset => dataset.source), method: 'Corridor line/polygon intersection; projected overlap length in EPSG:5070', coverage: COVERAGE.UNKNOWN },
    diagnostics: { status: 'unavailable', reason } };
}


export function createGisService({ manifest = null, engineFactory = defaultEngineFactory } = {}) {
  let catalog = manifest;
  let enginePromise = null;
  const files = new Map();
  const diagnostics = { status: 'idle', duckdbVersion: DUCKDB_VERSION, spatial: 'not-loaded', datasets: [], initMs: null, firstQueryMs: null, lastQueryMs: null, firstRoadQueryMs: null, lastRoadQueryMs: null, roadDatasetBytes: null, firstNetworkQueryMs: null, lastNetworkQueryMs: null, networkDatasetBytes: null, firstHabitatQueryMs: null, lastHabitatQueryMs: null, habitatDatasetBytes: {}, firstDiscoveryQueryMs: null, lastDiscoveryQueryMs: null, discoveryCorridorCount: null, error: null };

  async function getManifest() { if (!catalog) catalog = await loadManifest(); return catalog; }

  async function initialize() {
    if (enginePromise) return enginePromise;
    diagnostics.status = 'initializing';
    const started = performance.now();
    enginePromise = engineFactory().then(engine => {
      diagnostics.status = 'ready'; diagnostics.spatial = 'loaded'; diagnostics.initMs = Math.round(performance.now() - started);
      return engine;
    }).catch(error => {
      diagnostics.status = 'failed'; diagnostics.spatial = 'failed'; diagnostics.error = error.message;
      enginePromise = null;
      throw new Error(`DuckDB Spatial initialization failed: ${error.message}`, { cause: error });
    });
    return enginePromise;
  }

  async function openDataset(datasetId) {
    if (files.has(datasetId)) return files.get(datasetId);
    const entry = (await getManifest()).datasets.find(dataset => dataset.id === datasetId);
    if (!entry) throw new Error(`Dataset not declared: ${datasetId}`);
    const engine = await initialize();
    const url = new URL(entry.url, DATA_BASE);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${datasetId} HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const byteLength = bytes.byteLength; // registerFileBuffer transfers the buffer, detaching it
    if (byteLength !== entry.bytes) throw new Error(`${datasetId} byte count mismatch`);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== entry.sha256) throw new Error(`${datasetId} SHA-256 mismatch`);
    const name = `${datasetId}.parquet`;
    await engine.db.registerFileBuffer(name, new Uint8Array(bytes));
    const opened = { ...entry, registeredName: name, transferredBytes: byteLength };
    files.set(datasetId, opened);
    diagnostics.datasets = [...files.keys()];
    return opened;
  }

  async function queryLevel(level, wkt, bounds) {
    const dataset = await openDataset(`epa-ecoregions-or-l${level}`);
    const engine = await initialize();
    // WKT is generated solely from validated numeric GeoJSON coordinates.
    const road = `ST_GeomFromText('${wkt}')`;
    const projected = geom => `ST_Transform(${geom}, 'EPSG:4326', 'EPSG:5070', always_xy := true)`;
    const routeLengthM = Number((await engine.conn.query(`SELECT ST_Length(${projected(road)}) AS length_m`)).toArray()[0].length_m);
    const sql = `WITH pieces AS (
      SELECT code, name, ST_Length(${projected(`ST_Intersection(geometry, ${road})`)}) AS overlap_m
      FROM read_parquet('${dataset.registeredName}')
      WHERE min_lon <= ${bounds[2]} AND max_lon >= ${bounds[0]}
        AND min_lat <= ${bounds[3]} AND max_lat >= ${bounds[1]}
        AND ST_Intersects(geometry, ${road})
    ) SELECT code, name, SUM(overlap_m) AS overlap_m FROM pieces
      WHERE overlap_m > 0 GROUP BY code, name ORDER BY overlap_m DESC, code`;
    const rows = (await engine.conn.query(sql)).toArray().map(row => ({ code: row.code, name: row.name, overlapM: Number(row.overlap_m) }));
    return summarizeLevel(rows, routeLengthM);
  }

  // Road source features are returned as plain data rows plus dataset provenance. Turning them
  // into normalized roads/corridors happens in src/roads; DuckDB and SQL stay in this layer.
  async function queryRoads({ roadIds = null, bbox = null, limit = MAX_ROAD_ROWS, datasetId = ROAD_DATASET_ID, roadClasses = null,
    insideOnly = false } = {}) {
    const requested = roadIds ? [...new Set(roadIds.map(String))] : [];
    for (const roadId of requested) if (!IDENTIFIER.test(roadId)) throw new TypeError(`Invalid road id: ${roadId}`);
    const classes = roadClasses ? [...new Set(roadClasses.map(String))] : null;
    for (const roadClass of classes ?? []) if (!ROAD_CLASS.test(roadClass)) throw new TypeError(`Invalid road class: ${roadClass}`);
    if (bbox) validateBounds(bbox);
    const limitCap = datasetId === NETWORK_DATASET_ID ? MAX_NETWORK_ROWS : MAX_ROAD_ROWS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > limitCap) throw new TypeError('Road query limit must be a small positive integer');
    let entry = null;
    try {
      entry = await openDataset(datasetId);
      const engine = await initialize();
      const conditions = [];
      if (requested.length) conditions.push(`road_id IN (${requested.map(roadId => `'${roadId}'`).join(', ')})`);
      if (classes?.length) conditions.push(`road_class IN (${classes.map(roadClass => `'${roadClass}'`).join(', ')})`);
      // Discovery reads the bounded extract exactly as it was built: every vertex inside the window, so a
      // corridor is never half outside the area its coverage claims describe. The pilot path keeps the
      // overlap semantics it was audited with.
      if (bbox && insideOnly) conditions.push(`min_lon >= ${bbox[0]} AND max_lon <= ${bbox[2]} AND min_lat >= ${bbox[1]} AND max_lat <= ${bbox[3]}`);
      else if (bbox) conditions.push(`min_lon <= ${bbox[2]} AND max_lon >= ${bbox[0]} AND min_lat <= ${bbox[3]} AND max_lat >= ${bbox[1]}`);
      const sql = `SELECT ${ROAD_COLUMNS}, ST_AsGeoJSON(geometry) AS geometry_json\n` +
        `FROM read_parquet('${entry.registeredName}')${conditions.length ? `\nWHERE ${conditions.join(' AND ')}` : ''}\n` +
        `ORDER BY road_id, source_feature_id, part LIMIT ${limit}`;
      const started = performance.now();
      const rows = (await engine.conn.query(sql)).toArray().map(mapRoadRow);
      const queryMs = Math.round(performance.now() - started);
      if (datasetId === NETWORK_DATASET_ID) {
        diagnostics.lastNetworkQueryMs = queryMs;
        diagnostics.firstNetworkQueryMs ??= queryMs;
        diagnostics.networkDatasetBytes = entry.transferredBytes;
      } else {
        diagnostics.lastRoadQueryMs = queryMs;
        diagnostics.firstRoadQueryMs ??= queryMs;
        diagnostics.roadDatasetBytes = entry.transferredBytes;
      }
      diagnostics.error = null;
      const foundRoadIds = [...new Set(rows.map(row => row.roadId))];
      const coverage = summarizeRoadQuery({ requestedRoadIds: requested, foundRoadIds, featureCount: rows.length, bounded: true });
      return {
        ...coverage, features: rows, bounded: true, datasetId,
        provenance: roadDatasetProvenance(entry, rows),
        diagnostics: { status: 'ready', reason: null, queryMs, engineInitMs: diagnostics.initMs, datasetBytes: entry.transferredBytes },
      };
    } catch (error) {
      diagnostics.error = error.message;
      const coverage = summarizeRoadQuery({ requestedRoadIds: requested, reason: error.message });
      return { ...coverage, features: [], bounded: true, datasetId, provenance: entry ? roadDatasetProvenance(entry, []) : null,
        diagnostics: { status: 'unavailable', reason: error.message, queryMs: null, datasetBytes: entry?.transferredBytes ?? null } };
    }
  }

  async function getRoad(roadId) {
    const result = await queryRoads({ roadIds: [String(roadId)] });
    return { ...result, roadId: String(roadId), roadFeatures: result.features.filter(feature => feature.roadId === String(roadId)) };
  }

  // Candidate discovery reads the bounded network extract through the same road reader, filtered to
  // the TIGER classes the discovery eligibility rules allow. The whole artifact is never transferred
  // into JavaScript when a narrower question is being asked.
  async function queryRoadNetwork({ bbox = null, roadClasses = null, limit = MAX_NETWORK_ROWS } = {}) {
    return queryRoads({ bbox, roadClasses, limit, datasetId: NETWORK_DATASET_ID, insideOnly: true });
  }

  // One shared instance of the analytical geometry boundary for the whole service: discovery, detailed
  // habitat analysis, and ecoregion overlap all ask the same object, so they cannot disagree about
  // whether a corridor needed repair. See src/gis/analytical-geometry.js.
  const analytical = createAnalyticalGeometryQueries({ initialize });

  async function getEcoregions(corridor) {
    let datasets = [];
    try {
      // Ecoregion overlap is a line/polygon intersection, but it is measured against the same analytical
      // geometry the buffered analysis used, so a repaired corridor reports consistent ecology too.
      const prepared = await analytical.prepareAnalyticalGeometry({ id: 'corridor',
        geometry: corridorGeometry(corridor).geometry });
      if (!prepared.usable) {
        return unknown(prepared.reason, []);
      }
      const geometry = corridorGeometry(prepared.geometry);
      const wkt = prepared.wkt;
      datasets = (await getManifest()).datasets.filter(item => item.id.startsWith('epa-ecoregions-or-l'));
      const started = performance.now();
      const errors = [];
      const attempt = async level => {
        try { return await queryLevel(level, wkt, geometry.bounds); }
        catch (error) { errors.push(`Level ${level}: ${error.message}`); return { coverage: COVERAGE.UNKNOWN, primary: null, intersections: [], spansMultiple: false, measuredM: null, routeLengthM: null }; }
      };
      const level3 = await attempt(3);
      const level4 = await attempt(4);
      const coverage = combineCoverage(level3, level4);
      diagnostics.lastQueryMs = Math.round(performance.now() - started);
      diagnostics.firstQueryMs ??= diagnostics.lastQueryMs;
      diagnostics.error = errors.length ? errors.join('; ') : null;
      return { coverage, level3, level4, spansMultiple: level3.spansMultiple || level4.spansMultiple,
        geometryForAnalysis: prepared.geometryForAnalysis,
        provenance: { dataset: 'EPA Level III/IV ecoregions', sources: datasets.map(dataset => ({ ...dataset.source, id: dataset.id, version: dataset.version, sha256: dataset.sha256 })), method: 'GeoJSON corridor intersected with EPA polygons in DuckDB Spatial; overlap length measured in EPSG:5070', geometryForAnalysis: prepared.geometryForAnalysis, coverage },
        diagnostics: { status: errors.length ? (coverage === COVERAGE.UNKNOWN ? 'unavailable' : 'partial') : 'ready', reason: errors.join('; ') || null, queryMs: diagnostics.lastQueryMs, engineInitMs: diagnostics.initMs,
          geometryRepairMethod: prepared.repairMethod, geometryRepairMs: prepared.diagnostics.repairMs ?? null } };
    } catch (error) {
      diagnostics.error = error.message;
      return unknown(error.message, datasets);
    }
  }

  // Habitat analysis lives in src/gis/habitat-query.js; this service owns only the DuckDB
  // lifecycle, dataset registry, and diagnostics.
  const habitat = createHabitatQueries({
    openDataset, initialize, analytical,
    record: (datasetId, entry, queryMs, error) => {
      if (error) { diagnostics.error = error; return; }
      diagnostics.firstHabitatQueryMs ??= queryMs;
      diagnostics.lastHabitatQueryMs = queryMs;
      if (entry) diagnostics.habitatDatasetBytes = { ...diagnostics.habitatDatasetBytes, [datasetId]: entry.transferredBytes };
    },
  });

  // Discovery analysis is the set-oriented counterpart of the habitat queries: one batch per dataset
  // for every discovered corridor at once, using the same measurement definitions.
  const discovery = createDiscoveryQueries({
    openDataset, initialize, provenance: habitat.provenance, analytical,
    record: (datasetId, entry, queryMs, error) => {
      if (error) { diagnostics.error = error; return; }
      diagnostics.firstDiscoveryQueryMs ??= queryMs;
      diagnostics.lastDiscoveryQueryMs = queryMs;
      if (entry) diagnostics.habitatDatasetBytes = { ...diagnostics.habitatDatasetBytes, [datasetId]: entry.transferredBytes };
    },
  });

  // Occurrence distance measurement reuses the same DuckDB engine and EPSG:5070 measurement path;
  // the occurrence layer owns the source adapters and the privacy rules.
  const occurrenceQueries = createOccurrenceQueries({ initialize });

  return {
    initialize, openDataset, getEcoregions, queryRoads, getRoad, queryRoadNetwork,
    ...habitat,
    // Exposed so the browser regression test can ask the same shared boundary what geometry it would use
    // for a corridor, without duplicating the ladder.
    prepareAnalyticalGeometry: analytical.prepareAnalyticalGeometry,
    prepareAnalyticalGeometries: analytical.prepareAnalyticalGeometries,
    async analyzeDiscovery(corridors, options = {}) {
      const result = await discovery.analyzeDiscoveryCorridors(corridors, options);
      diagnostics.discoveryCorridorCount = Object.keys(result.corridors).length;
      return result;
    },
    measureOccurrenceDistances: occurrenceQueries.measureCorridorDistances,
    async getCoverage(datasetId, target) {
      if (datasetId === ROAD_DATASET_ID) {
        const roadIds = target?.roadIds ?? (target?.roadId ? [target.roadId] : null);
        if (!roadIds) return { status: COVERAGE.UNKNOWN, reason: 'Road coverage needs declared road ids, not raw geometry', provenance: null };
        const result = await queryRoads({ roadIds });
        return { status: result.coverage, provenance: result.provenance, reason: result.reason ?? result.note ?? null, missingRoadIds: result.missingRoadIds };
      }
      if (datasetId === COVERAGE_DATASET.WETLANDS || datasetId === COVERAGE_DATASET.HYDROGRAPHY) {
        const result = datasetId === COVERAGE_DATASET.WETLANDS ? await habitat.queryWetlands(target) : await habitat.queryHydrography(target);
        return { status: result.coverage, provenance: result.provenance, reason: result.reason ?? result.note ?? null, coverageByDistance: result.coverageByDistance ?? {} };
      }
      if (!datasetId.startsWith('epa-ecoregions')) return { status: COVERAGE.UNKNOWN, reason: 'Dataset not connected', provenance: null };
      const result = await getEcoregions(target);
      const level = datasetId.endsWith('-l3') ? result.level3 : datasetId.endsWith('-l4') ? result.level4 : null;
      return { status: level?.coverage ?? result.coverage, provenance: result.provenance, reason: result.diagnostics?.reason ?? null };
    },
    async queryCorridor(_corridor, _options = {}) { return { coverage: COVERAGE.UNKNOWN, features: [], reason: 'General corridor layers are not connected' }; },
    diagnostics: () => ({ ...diagnostics, habitatDatasetBytes: { ...diagnostics.habitatDatasetBytes } })
  };
}

function validateBounds(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) throw new TypeError('Road query bounds must be four finite numbers');
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new TypeError('Road query bounds must be ordered min/max');
}

function mapRoadRow(row) {
  return Object.freeze({
    roadId: String(row.road_id), name: row.name ?? null, roadClass: row.road_class ?? null, routeType: row.route_type ?? null,
    countyFips: row.county_fips ?? null, countyName: row.county_name ?? null,
    sourceFeatureId: String(row.source_feature_id), part: Number(row.part), sourceLengthM: Number(row.length_m),
    geometry: JSON.parse(row.geometry_json),
    source: Object.freeze({ agency: row.source_agency ?? null, dataset: row.source_dataset ?? null, vintage: row.source_vintage ?? null,
      publicationDate: row.source_publication_date ?? null, url: row.source_url ?? null, archiveSha256: row.source_archive_sha256 ?? null,
      crs: row.crs ?? null, sourceCrs: row.source_crs ?? null, pipelineVersion: row.pipeline_version ?? null,
      normalization: row.normalization ?? null }),
  });
}

function roadDatasetProvenance(entry, rows) {
  const counties = Object.entries(entry.source?.urls ?? {}).map(([fips, url]) => Object.freeze({
    fips, url, sha256: entry.source?.sha256?.[fips] ?? null, countyName: entry.scope?.roads?.find(road => road.countyFips === fips)?.countyName ?? null,
  }));
  return Object.freeze({
    datasetId: entry.id, dataset: entry.source?.dataset ?? entry.id, datasetVersion: entry.version, datasetDigest: entry.sha256,
    agency: entry.source?.agency ?? rows[0]?.source?.agency ?? null,
    vintage: entry.source?.vintage ?? null, publicationDate: entry.source?.publicationDate ?? null,
    referenceUrl: entry.source?.url ?? rows[0]?.source?.url ?? null, documentationUrl: entry.source?.documentationUrl ?? null,
    license: entry.source?.license ?? null, geometryCrs: entry.crs ?? null, sourceCrs: entry.normalization?.sourceCrs ?? rows[0]?.source?.sourceCrs ?? null,
    pipelineVersion: entry.normalization?.pipelineVersion ?? null, method: entry.normalization?.method ?? null,
    sources: Object.freeze(counties), retrievedAt: new Date().toISOString(),
  });
}

async function defaultEngineFactory() {
  const duckdb = await import(DUCKDB_ESM);
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([`importScripts('${bundle.mainWorker}');`], { type: 'text/javascript' }));
  let worker;
  let db;
  try {
    worker = new Worker(workerUrl);
    db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();
    await conn.query('INSTALL spatial; LOAD spatial;');
    return { db, conn };
  } catch (error) {
    if (db) await db.terminate().catch(() => {});
    else worker?.terminate();
    throw error;
  } finally { URL.revokeObjectURL(workerUrl); }
}
