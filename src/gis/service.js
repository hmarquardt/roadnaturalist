import { COVERAGE } from '../domain/corridor.js';
import { corridorGeometry, corridorWkt } from '../domain/geometry.js';
import { loadManifest } from '../services/manifest.js';
import { combineCoverage, summarizeLevel } from './ecoregion-result.js';

const DUCKDB_VERSION = '1.30.0';
const DUCKDB_ESM = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`;
const DATA_BASE = new URL('../../data/', import.meta.url);

function unknown(reason, datasets = []) {
  return { coverage: COVERAGE.UNKNOWN, level3: null, level4: null, spansMultiple: false,
    provenance: { dataset: 'EPA Level III/IV ecoregions', sources: datasets.map(dataset => dataset.source), method: 'Corridor line/polygon intersection; projected overlap length in EPSG:5070', coverage: COVERAGE.UNKNOWN },
    diagnostics: { status: 'unavailable', reason } };
}

export function createGisService({ manifest = null, engineFactory = defaultEngineFactory } = {}) {
  let catalog = manifest;
  let enginePromise = null;
  const files = new Map();
  const diagnostics = { status: 'idle', duckdbVersion: DUCKDB_VERSION, spatial: 'not-loaded', datasets: [], initMs: null, firstQueryMs: null, lastQueryMs: null, error: null };

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
    if (bytes.byteLength !== entry.bytes) throw new Error(`${datasetId} byte count mismatch`);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== entry.sha256) throw new Error(`${datasetId} SHA-256 mismatch`);
    const name = `${datasetId}.parquet`;
    await engine.db.registerFileBuffer(name, new Uint8Array(bytes));
    const opened = { ...entry, registeredName: name, transferredBytes: bytes.byteLength };
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

  async function getEcoregions(corridor) {
    let datasets = [];
    try {
      const geometry = corridorGeometry(corridor);
      const wkt = corridorWkt(geometry.geometry);
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
        provenance: { dataset: 'EPA Level III/IV ecoregions', sources: datasets.map(dataset => ({ ...dataset.source, id: dataset.id, version: dataset.version, sha256: dataset.sha256 })), method: 'GeoJSON corridor intersected with EPA polygons in DuckDB Spatial; overlap length measured in EPSG:5070', coverage },
        diagnostics: { status: errors.length ? (coverage === COVERAGE.UNKNOWN ? 'unavailable' : 'partial') : 'ready', reason: errors.join('; ') || null, queryMs: diagnostics.lastQueryMs, engineInitMs: diagnostics.initMs } };
    } catch (error) {
      diagnostics.error = error.message;
      return unknown(error.message, datasets);
    }
  }

  return {
    initialize, openDataset, getEcoregions,
    async getCoverage(datasetId, corridor) {
      if (!datasetId.startsWith('epa-ecoregions')) return { status: COVERAGE.UNKNOWN, reason: 'Dataset not connected' };
      const result = await getEcoregions(corridor);
      const level = datasetId.endsWith('-l3') ? result.level3 : datasetId.endsWith('-l4') ? result.level4 : null;
      return { status: level?.coverage ?? result.coverage, provenance: result.provenance, reason: result.diagnostics?.reason ?? null };
    },
    async queryCorridor(_corridor, _options = {}) { return { coverage: COVERAGE.UNKNOWN, features: [], reason: 'General corridor layers are not connected' }; },
    diagnostics: () => ({ ...diagnostics })
  };
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
