import { COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';
import { corridorGeometry } from '../domain/geometry.js';
import { loadManifest } from '../services/manifest.js';
import { selectRegionalPartitions, validateRegionalCatalog } from '../discovery/regional-catalog.js';
import { createAnalyticalGeometryQueries } from './analytical-geometry.js';
import { combineCoverage, summarizeLevel } from './ecoregion-result.js';
import { createHabitatQueries, HABITAT_DATASETS } from './habitat-query.js';
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
const MAX_REGIONAL_ROWS = 100000;

function parquetSource(entry) { return entry.readExpression ?? `read_parquet('${entry.registeredName}')`; }

function unknown(reason, datasets = []) {
  return { coverage: COVERAGE.UNKNOWN, level3: null, level4: null, spansMultiple: false,
    provenance: { dataset: 'EPA Level III/IV ecoregions', sources: datasets.map(dataset => dataset.source), method: 'Corridor line/polygon intersection; projected overlap length in EPSG:5070', coverage: COVERAGE.UNKNOWN },
    diagnostics: { status: 'unavailable', reason } };
}


export function createGisService({ manifest = null, regionalCatalog = null, engineFactory = defaultEngineFactory } = {}) {
  let catalog = manifest;
  const regionalCatalogCache = new Map();
  let enginePromise = null;
  const files = new Map();
  const regionalFiles = new Map();
  let lastRegionalScope = null;
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

  async function getRegionalCatalog(url) {
    if (regionalCatalog) return validateRegionalCatalog(regionalCatalog);
    if (regionalCatalogCache.has(url)) return regionalCatalogCache.get(url);
    const response = await fetch(new URL(url, DATA_BASE));
    if (!response.ok) throw new Error(`Regional manifest unavailable: HTTP ${response.status}`);
    let loaded = validateRegionalCatalog(await response.json());
    // Local development reads the same immutable paths from ./data; production changes only
    // the asset origin, not partition selection, verification, or GIS analysis.
    if (['localhost', '127.0.0.1'].includes(globalThis.location?.hostname)) {
      loaded = { ...loaded, assetBaseUrl: null };
    }
    regionalCatalogCache.set(url, loaded);
    return loaded;
  }

  async function openRegionalPartition(part, catalog, metrics) {
    if (part.state === 'empty') return null;
    const key = `${catalog.version}/${part.url}/${part.sha256}`;
    if (regionalFiles.has(key)) { metrics.cacheHits++; return regionalFiles.get(key); }
    const base = catalog.assetBaseUrl ? new URL(catalog.assetBaseUrl) : DATA_BASE;
    const url = new URL(part.url, base);
    const fetchStarted = performance.now();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${part.id} HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    metrics.fetchMs += performance.now() - fetchStarted;
    const verifyStarted = performance.now();
    if (bytes.byteLength !== part.bytes) throw new Error(`${part.id} byte count mismatch`);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== part.sha256) throw new Error(`${part.id} SHA-256 mismatch`);
    metrics.verifyMs += performance.now() - verifyStarted;
    const engine = await initialize();
    const registerStarted = performance.now();
    const name = `regional_${part.sha256.slice(0, 20)}.parquet`;
    await engine.db.registerFileBuffer(name, new Uint8Array(bytes));
    metrics.registerMs += performance.now() - registerStarted;
    metrics.downloadedBytes += part.bytes;
    const opened = { name, bytes: part.bytes };
    regionalFiles.set(key, opened);
    return opened;
  }

  // A selected cell that the catalog declares valid-and-empty contributes no rows but is still covered
  // data: it means the published source has nothing there, which is a measured zero, not a failure. When
  // every selected cell is empty the dataset has no file to read, so the relation is built from the
  // catalog's declared column schema instead of failing. A missing artifact is a different state and
  // still throws, because that is UNKNOWN.
  function emptyRelation(kind, dataset) {
    if (!Array.isArray(dataset.columns) || !dataset.columns.length) {
      throw new TypeError(`${kind}: selected partitions are empty and the catalog declares no column schema`);
    }
    const projection = dataset.columns.map(column => `NULL::${column.type} AS ${column.name}`).join(', ');
    return `(SELECT ${projection} WHERE false)`;
  }

  async function prepareRegionalSearch(searchArea, { onProgress = () => {} } = {}) {
    const started = performance.now();
    const catalog = await getRegionalCatalog(searchArea.catalogUrl);
    const manifestMs = performance.now() - started;
    const selection = selectRegionalPartitions(catalog, searchArea.bbox);
    const selectionMs = performance.now() - started - manifestMs;
    // Only a search that misses the published region entirely is unavailable. A partly covered search
    // runs and reports PARTIAL: refusing to measure what is covered would hide corridors that the data
    // does describe, and pretending the uncovered part is complete is what coverage states prevent.
    if (selection.coverage === COVERAGE.NONE) {
      const error = new Error(selection.reason);
      error.coverage = selection.coverage;
      throw error;
    }
    const opened = new Map();
    const partitionMetrics = { fetchMs: 0, verifyMs: 0, registerMs: 0, downloadedBytes: 0, cacheHits: 0 };
    const loadMs = {};
    const sourceKeys = { roads: 'county_fips, source_feature_id, part', wetlands: 'source_feature_id', hydrography: 'layer, source_feature_id' };
    async function openRegionalDataset(kind) {
      if (opened.has(kind)) return opened.get(kind);
      const dataset = catalog.datasets.find(item => item.id === kind);
      const selected = selection.partitions[kind];
      const loaded = [];
      for (const part of selected) {
        const file = await openRegionalPartition(part, catalog, partitionMetrics);
        if (file) loaded.push(file);
      }
      const emptyCells = selected.filter(part => part.state === 'empty').length;
      const names = loaded.map(file => `'${file.name}'`).join(', ');
      const relation = loaded.length ? `read_parquet([${names}])` : emptyRelation(kind, dataset);
      const readExpression = `(SELECT * EXCLUDE rn FROM (SELECT *, row_number() OVER (PARTITION BY ${sourceKeys[kind]}) AS rn FROM ${relation}) WHERE rn = 1)`;
      const original = (await getManifest()).datasets.find(item => item.id === dataset.sourceDatasetId);
      const entry = { ...dataset, id: `${dataset.id}-${catalog.version}`, scope: { bbox: catalog.region.bounds },
        source: original?.source, normalization: original?.normalization,
        readExpression, partitioned: true, transferredBytes: loaded.reduce((sum, file) => sum + file.bytes, 0),
        selectedCells: selected.length, presentCells: loaded.length, emptyCells,
        partitions: selected.map(part => ({ id: part.id, sha256: part.sha256 ?? null, bytes: part.bytes ?? 0, state: part.state })) };
      opened.set(kind, entry);
      return entry;
    }
    // A regional result is published only after every required partition verifies. Failure in one
    // habitat cell aborts the run instead of producing misleading zero metrics elsewhere.
    for (const [kind, label] of [['roads', 'Loading road data…'], ['wetlands', 'Loading wetlands…'],
      ['hydrography', 'Loading hydrography…']]) {
      onProgress(label);
      const loadStarted = performance.now();
      await openRegionalDataset(kind);
      loadMs[kind] = Math.round(performance.now() - loadStarted);
    }
    const scope = {
      selection,
      timing: Object.freeze({ manifestMs: Math.round(manifestMs), selectionMs: Math.round(selectionMs),
        loadMs: Object.freeze(loadMs), fetchMs: Math.round(partitionMetrics.fetchMs),
        verifyMs: Math.round(partitionMetrics.verifyMs), registerMs: Math.round(partitionMetrics.registerMs),
        downloadedBytes: partitionMetrics.downloadedBytes, cacheHits: partitionMetrics.cacheHits,
        totalPreparationMs: Math.round(performance.now() - started) }),
      // Deduplicated row counts per selected dataset. This is the number the GIS layer actually works on:
      // replicated whole features are collapsed by the source-key window, so the count answers "how many
      // physical features does this search measure", not "how many copies were stored".
      async datasetRowCounts() {
        const engine = await initialize();
        const counts = {};
        for (const kind of opened.keys()) {
          const entry = opened.get(kind);
          const row = (await engine.conn.query(`SELECT count(*) AS rows FROM ${entry.readExpression}`)).toArray()[0];
          counts[kind] = { rows: Number(row.rows), presentCells: entry.presentCells, emptyCells: entry.emptyCells,
            bytes: entry.transferredBytes };
        }
        return counts;
      },
      getHabitatContext(corridor, options = {}) {
        return habitat.getHabitatContext(corridor, { ...options, datasetOpener: id => openRegionalDataset(id === HABITAT_DATASETS[COVERAGE_DATASET.WETLANDS]
          ? 'wetlands' : 'hydrography') });
      },
      getHabitatOverlay(corridor, options = {}) {
        return habitat.getHabitatOverlay(corridor, { ...options, datasetOpener: id => openRegionalDataset(id === HABITAT_DATASETS[COVERAGE_DATASET.WETLANDS]
          ? 'wetlands' : 'hydrography') });
      },
      async queryRoadNetwork({ roadClasses = null, limit = MAX_REGIONAL_ROWS } = {}) {
        const entry = await openRegionalDataset('roads');
        const query = await queryRoads({ roadClasses, limit, datasetId: NETWORK_DATASET_ID, datasetEntry: entry });
        if (query.coverage !== COVERAGE.FULL) return query;
        // No name filter here: the selected cells are complete for every name they contain (a single-cell
        // name needs no closing step, and a name that crosses cells is closed over the catalog index), so
        // every composed unit is whole. Which of those units is *in the search* is decided geometrically
        // after composition, by the search box and, for a radius search, by the disk.
        const features = query.features;
        // A search that reaches the published source window is a different claim from a search well inside
        // it: a named road that continues across the window edge is not published beyond it, so its corridor
        // here is not known to be the whole road. Road coverage says PARTIAL rather than FULL for that case,
        // and each corridor's habitat buffer is already marked when it leaves the window.
        const published = selection.publishedBounds;
        const bounds = selection.bounds;
        const marginDeg = Math.min(bounds[0] - published[0], bounds[1] - published[1],
          published[2] - bounds[2], published[3] - bounds[3]);
        // One published grid step: inside that distance from the edge a road group can leave the window.
        if (marginDeg > 0.2) return { ...query, features, partitionSelection: selection, sourceEdgeMarginDeg: marginDeg };
        return { ...query, features, coverage: COVERAGE.PARTIAL, partitionSelection: selection,
          sourceEdgeMarginDeg: marginDeg, sourceEdge: true,
          reason: 'The search reaches the edge of the published regional source window, so a road group leaving it is '
            + 'not assumed complete; habitat coverage for those corridors is reported separately.' };
      },
      analyzeDiscovery(corridors, options = {}) {
        // Partitioned datasets come from the selected cells; the whole-state ecoregion layers are shared by
        // every regional run and are read through their union entry.
        const kindOf = id => id === HABITAT_DATASETS[COVERAGE_DATASET.WETLANDS] ? 'wetlands'
          : id === HABITAT_DATASETS[COVERAGE_DATASET.HYDROGRAPHY] ? 'hydrography' : null;
        return discovery.analyzeDiscoveryCorridors(corridors, { ...options,
          openDataset: id => (kindOf(id) ? openRegionalDataset(kindOf(id)) : datasetForDiscovery(id)) });
      },
    };
    // The last prepared scope, so a benchmark or a diagnostic panel can ask what was selected and how many
    // deduplicated rows it holds without preparing the search twice.
    lastRegionalScope = scope;
    return scope;
  }

  // Ecoregions are published per state, so a level is answered from the union of every declared layer for
  // that level. A corridor near a state line then finds its ecoregion instead of a state-line gap, and the
  // discovery batch and the detailed panel read the same union.
  async function ecoregionSources(level) {
    const entries = (await getManifest()).datasets.filter(item => item.id.startsWith('epa-ecoregions-')
      && item.id.endsWith(`-l${level}`));
    if (!entries.length) throw new Error(`No EPA Level ${level} ecoregion dataset is declared`);
    const opened = [];
    for (const entry of entries) opened.push(await openDataset(entry.id));
    return { entries, opened };
  }

  // The union entry a level is queried through. The discovery batch asks for a dataset id, so this is the
  // single place that turns "EPA Level III" into every declared Level III layer.
  async function ecoregionUnionEntry(datasetId, level) {
    const { opened } = await ecoregionSources(level);
    return { ...opened[0], id: `${datasetId}-union`, partitioned: false, unionedDatasets: opened.map(entry => entry.id),
      readExpression: `(SELECT * FROM read_parquet([${opened.map(entry => `'${entry.registeredName}'`).join(', ')}]))`,
      transferredBytes: opened.reduce((sum, entry) => sum + (entry.transferredBytes ?? 0), 0) };
  }

  async function datasetForDiscovery(id) {
    const match = /^epa-ecoregions-.+-l(\d)$/.exec(String(id));
    return match ? ecoregionUnionEntry(id, Number(match[1])) : openDataset(id);
  }

  async function queryLevel(level, wkt, bounds) {
    const { opened } = await ecoregionSources(level);
    const engine = await initialize();
    // WKT is generated solely from validated numeric GeoJSON coordinates.
    const road = `ST_GeomFromText('${wkt}')`;
    const projected = geom => `ST_Transform(${geom}, 'EPSG:4326', 'EPSG:5070', always_xy := true)`;
    const routeLengthM = Number((await engine.conn.query(`SELECT ST_Length(${projected(road)}) AS length_m`)).toArray()[0].length_m);
    const relation = `read_parquet([${opened.map(entry => `'${entry.registeredName}'`).join(', ')}])`;
    const sql = `WITH pieces AS (
      SELECT code, name, ST_Length(${projected(`ST_Intersection(geometry, ${road})`)}) AS overlap_m
      FROM ${relation}
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
    insideOnly = false, datasetEntry = null } = {}) {
    const requested = roadIds ? [...new Set(roadIds.map(String))] : [];
    for (const roadId of requested) if (!IDENTIFIER.test(roadId)) throw new TypeError(`Invalid road id: ${roadId}`);
    const classes = roadClasses ? [...new Set(roadClasses.map(String))] : null;
    for (const roadClass of classes ?? []) if (!ROAD_CLASS.test(roadClass)) throw new TypeError(`Invalid road class: ${roadClass}`);
    if (bbox) validateBounds(bbox);
    const limitCap = datasetEntry ? MAX_REGIONAL_ROWS : datasetId === NETWORK_DATASET_ID ? MAX_NETWORK_ROWS : MAX_ROAD_ROWS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > limitCap) throw new TypeError('Road query limit must be a small positive integer');
    let entry = null;
    try {
      entry = datasetEntry ?? await openDataset(datasetId);
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
        `FROM ${parquetSource(entry)}${conditions.length ? `\nWHERE ${conditions.join(' AND ')}` : ''}\n` +
        `ORDER BY road_id, source_feature_id, part LIMIT ${datasetEntry ? limit + 1 : limit}`;
      const started = performance.now();
      const rawRows = (await engine.conn.query(sql)).toArray();
      if (datasetEntry && rawRows.length > limit) throw new Error(`Regional road result exceeds the ${limit} feature limit; narrow the search area.`);
      const rows = rawRows.map(mapRoadRow);
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
    openDataset: datasetForDiscovery, initialize, provenance: habitat.provenance, analytical,
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
    get lastRegionalScope() { return lastRegionalScope; },
    prepareRegionalSearch,
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
    datasetId: entry.id, dataset: entry.source?.dataset ?? entry.id, datasetVersion: entry.version, datasetDigest: entry.sha256 ?? null,
    partitions: entry.partitions ?? null,
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
