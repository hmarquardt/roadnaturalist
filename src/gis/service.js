import { COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';
import { corridorGeometry } from '../domain/geometry.js';
import { loadManifest } from '../services/manifest.js';
import { selectRegionalPartitions } from '../discovery/regional-catalog.js';
import { DISCOVERY_CATALOG_TYPE, validateDiscoveryCatalog } from '../discovery/discovery-catalog.js';
import { areaCatalogType } from '../discovery/search-area.js';
import { cellsForBounds, closureTileKeys, rawCellBounds } from '../discovery/raw-catalog.js';
import { validateRoadComponents } from '../discovery/components.js';
import { derivedAvailability, selectDerivedCells, validateDerivedManifest } from '../discovery/derived-catalog.js';
import { DERIVED_COLUMNS, derivedMetrics, derivedUnit, derivedCorridor, queryDerivedCorridors } from './derived-query.js';
import { ANALYSIS_PROFILE_VERSION, DERIVED_SCHEMA_VERSION, analysisFingerprint } from '../discovery/analysis-fingerprint.js';
import { createAnalyticalGeometryQueries } from './analytical-geometry.js';
import { combineCoverage, summarizeLevel } from './ecoregion-result.js';
import { createHabitatQueries, HABITAT_DATASETS } from './habitat-query.js';
import { createDiscoveryQueries } from './discovery-query.js';
import { createOccurrenceQueries } from './occurrence-query.js';
import { summarizeRoadQuery } from './road-result.js';

const DUCKDB_VERSION = '1.30.0';
const DUCKDB_ESM = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`;
const DATA_BASE = new URL('../../data/', import.meta.url);

// A box grown by one cell: a road component that continues just outside the corridor's box is part of the same
// named road, and one cell is the most it can be away for the composition tolerance to join it.
function growBox(bounds, degrees) {
  return [bounds[0] - degrees, bounds[1] - degrees, bounds[2] + degrees, bounds[3] + degrees];
}
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


export function createGisService({ manifest = null, regionalCatalog = null, regionalCatalogType = DISCOVERY_CATALOG_TYPE.REGIONAL,
  engineFactory = defaultEngineFactory } = {}) {
  let catalog = manifest;
  const regionalCatalogCache = new Map();
  const roadComponentCache = new Map();
  let enginePromise = null;
  const files = new Map();
  const regionalFiles = new Map();
  let lastRegionalScope = null;
  let lastDerivedScope = null;
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
    // A whole-CONUS layer is published on the data origin alongside the partitions of the publication, and is far
    // too large to ship with the application: it is declared under `national/`. Asking the page's own origin for it
    // is a request for a file the application has never served - a 404 on every read that needs it. The scope's own
    // catalogue carries the publication's asset base, so that is where a national layer resolves; everything else
    // (the per-state layers published with the application) keeps resolving exactly as it always has.
    const url = new URL(entry.url, String(entry.url ?? '').startsWith('national/') && catalog?.assetBaseUrl
      ? new URL(catalog.assetBaseUrl) : DATA_BASE);
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

  // The discovery catalog a search declared, validated by the type the search declared - never by sniffing the
  // fetched document. A regional catalog is validated as a regional catalog; a national derived catalog is
  // validated as a national derived catalog. A document that does not satisfy the declared contract is refused
  // with that fact, rather than falling back to the other schema or being coerced into it.
  async function getDiscoveryCatalog(url, catalogType) {
    if (!Object.values(DISCOVERY_CATALOG_TYPE).includes(catalogType)) {
      throw new TypeError(`Unknown discovery catalog type: ${String(catalogType)}`);
    }
    // An injected catalog is a caller's explicit choice of *both* catalog and type, so it is validated against
    // the declared type too: a test (or a probe) that hands the service a national catalog cannot have it read
    // as a regional one.
    if (regionalCatalog) return validateDiscoveryCatalog(regionalCatalog, catalogType);
    const key = `${catalogType}:${url}`;
    if (regionalCatalogCache.has(key)) return regionalCatalogCache.get(key);
    const response = await fetch(new URL(url, DATA_BASE));
    if (!response.ok) throw new Error(`Discovery catalog unavailable: HTTP ${response.status}`);
    const document = await response.json();
    let loaded;
    try {
      loaded = validateDiscoveryCatalog(document, catalogType);
    } catch (error) {
      throw new Error(`The ${catalogType} discovery catalog ${url} is not a valid ${catalogType} catalog: ${error.message}`,
        { cause: error });
    }
    // Local development reads the same immutable *regional* paths from ./data. The national derived cells are not
    // in the repository (only the small pointer is), so a national catalog keeps its R2 origin even on a local
    // origin - which is exactly what lets a browser test exercise the production objects.
    if (catalogType === DISCOVERY_CATALOG_TYPE.REGIONAL && ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname)) {
      loaded = { ...loaded, assetBaseUrl: null };
    }
    regionalCatalogCache.set(key, loaded);
    return loaded;
  }

  // The road component index closes raw road-cell selection over connected components instead of names. It is
  // part of the published catalog (bytes and SHA-256 declared there), so a tampered or stale index is a
  // failure rather than a quietly different selection. Catalogs without one (the first slice) fall back to
  // the name index they were published with.
  async function getRoadComponents(catalog) {
    if (!catalog.roadComponentsUrl) return null;
    if (roadComponentCache.has(catalog.version)) return roadComponentCache.get(catalog.version);
    const base = catalog.assetBaseUrl ? new URL(catalog.assetBaseUrl) : DATA_BASE;
    const response = await fetch(new URL(catalog.roadComponentsUrl, base));
    if (!response.ok) throw new Error(`Road component index unavailable: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (catalog.roadComponentsBytes != null && bytes.byteLength !== catalog.roadComponentsBytes) {
      throw new Error(`Road component index byte count mismatch (${bytes.byteLength} vs ${catalog.roadComponentsBytes})`);
    }
    if (catalog.roadComponentsSha256) {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== catalog.roadComponentsSha256) throw new Error('Road component index SHA-256 mismatch');
    }
    const loaded = validateRoadComponents(JSON.parse(new TextDecoder().decode(bytes)));
    roadComponentCache.set(catalog.version, loaded);
    return loaded;
  }

  async function openRegionalPartition(part, catalog, metrics) {
    if (part.state === 'empty') return null;
    const key = `${catalog.version}/${part.url}/${part.sha256}`;
    if (regionalFiles.has(key)) { metrics.cacheHits++; return regionalFiles.get(key); }
    // A partition may name its own origin: the global roads plane lives at the same data origin as the bounded
    // regions today, but the reader should not depend on that, and an override that silently used the wrong base
    // would fetch a different object than the one that was verified.
    const base = part.base ? new URL(part.base) : catalog.assetBaseUrl ? new URL(catalog.assetBaseUrl) : DATA_BASE;
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

  // ---------------------------------------------------------------- derived corridor metrics
  // The derived layer is an acceleration path for browsing a regional radius: compact precomputed
  // deterministic metrics, verified on load, keyed by an analysis fingerprint that must match the semantics
  // this build implements. It never replaces the raw partitions, which remain what promotion reconstructs and
  // what the detailed analysis reads.
  const derivedManifestCache = new Map();
  const derivedFiles = new Map();

  async function getDerivedManifest(catalog) {
    if (!catalog.derived?.manifestUrl) return null;
    if (derivedManifestCache.has(catalog.version)) return derivedManifestCache.get(catalog.version);
    const base = catalog.assetBaseUrl ? new URL(catalog.assetBaseUrl) : DATA_BASE;
    const response = await fetch(new URL(catalog.derived.manifestUrl, base));
    if (!response.ok) throw new Error(`Derived corridor metrics are unavailable: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (catalog.derived.manifestSha256) {
      const digest = await sha256Hex(bytes);
      if (digest !== catalog.derived.manifestSha256) throw new Error('Derived manifest SHA-256 mismatch');
    }
    const manifest = validateDerivedManifest(JSON.parse(new TextDecoder().decode(bytes)));
    derivedManifestCache.set(catalog.version, manifest);
    return manifest;
  }

  async function currentAnalysisFingerprint(catalog) {
    try {
      const { fingerprint } = await analysisFingerprint({ regionalCatalog: catalog, manifest: await getManifest() });
      return fingerprint;
    } catch (error) {
      return { error: error.message };
    }
  }

  async function openDerivedCell(cell, catalog, metrics) {
    const key = `${catalog.version}/${cell.url}/${cell.sha256}`;
    if (derivedFiles.has(key)) { metrics.cacheHits += 1; return derivedFiles.get(key); }
    const base = catalog.assetBaseUrl ? new URL(catalog.assetBaseUrl) : DATA_BASE;
    const started = performance.now();
    const response = await fetch(new URL(cell.url, base));
    if (!response.ok) throw new Error(`${cell.id} HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    metrics.fetchMs += performance.now() - started;
    const verifyStarted = performance.now();
    if (bytes.byteLength !== cell.bytes) throw new Error(`${cell.id} byte count mismatch`);
    const digest = await sha256Hex(bytes);
    if (digest !== cell.sha256) throw new Error(`${cell.id} SHA-256 mismatch`);
    metrics.verifyMs += performance.now() - verifyStarted;
    const engine = await initialize();
    const registerStarted = performance.now();
    const name = `derived_${cell.sha256.slice(0, 20)}.parquet`;
    await engine.db.registerFileBuffer(name, new Uint8Array(bytes));
    metrics.registerMs += performance.now() - registerStarted;
    metrics.downloadedBytes += cell.bytes;
    const opened = { name, bytes: cell.bytes };
    derivedFiles.set(key, opened);
    return opened;
  }

  async function prepareDerivedSearch(searchArea, { onProgress = () => {} } = {}) {
    const started = performance.now();
    // The catalog type the search declares decides the contract it is validated against. A national search is
    // never validated as a regional catalog, and a regional search is never validated as a national one.
    const catalogType = areaCatalogType(searchArea);
    const catalog = await getDiscoveryCatalog(searchArea.catalogUrl, catalogType);
    const manifestMs = performance.now() - started;
    // A region that never published a derived plane is not a failure: it keeps the raw regional path it always
    // had. A region that publishes one and then cannot be trusted (fingerprint, digest, missing artifact) is a
    // failure, and is reported as itself rather than quietly costing the search 90 seconds.
    if (!catalog.derived) return null;
    const national = catalogType === DISCOVERY_CATALOG_TYPE.NATIONAL;
    // A regional plane is gated on the fingerprint the running code recomputes from the catalog it loaded. A
    // national plane's fingerprint also covers the Python builder and its pipeline digest, which a browser cannot
    // hash, so the reviewed catalog pins the expected fingerprint and the runtime fails closed on everything it
    // *can* check (see assertNationalDerivedCompatibility below).
    const fingerprint = national ? catalog.derived.analysisFingerprint : await currentAnalysisFingerprint(catalog);
    const manifest = await getDerivedManifest(catalog);
    const availability = derivedAvailability(manifest, fingerprint);
    if (!availability.available) {
      const error = new Error(availability.reason);
      error.derivedUnavailable = true;
      error.expected = availability.expected ?? null;
      error.published = availability.published ?? null;
      throw error;
    }
    if (national) assertNationalDerivedCompatibility(manifest, catalog);
    const selection = selectDerivedCells(manifest, searchArea.bbox);
    const selectionMs = performance.now() - started - manifestMs;
    if (selection.coverage === COVERAGE.NONE) {
      const error = new Error(selection.reason);
      error.coverage = selection.coverage;
      throw error;
    }
    onProgress('Loading precomputed discovery metrics…');
    const metrics = { fetchMs: 0, verifyMs: 0, registerMs: 0, downloadedBytes: 0, cacheHits: 0 };
    const loaded = [];
    for (const cell of selection.present) {
      const file = await openDerivedCell(cell, catalog, metrics);
      if (file) loaded.push(file);
    }
    const scope = {
      derived: true, selection, fingerprint: manifest.analysisFingerprint,
      manifest: { cells: manifest.cells.length, present: selection.counts.present, empty: selection.counts.empty,
        counts: manifest.counts ?? null, region: manifest.region, semantics: manifest.semantics ?? null },
      timing: Object.freeze({ manifestMs: Math.round(manifestMs), selectionMs: Math.round(selectionMs),
        totalPreparationMs: Math.round(performance.now() - started), fetchMs: Math.round(metrics.fetchMs),
        verifyMs: Math.round(metrics.verifyMs), registerMs: Math.round(metrics.registerMs),
        downloadedBytes: metrics.downloadedBytes, cacheHits: metrics.cacheHits,
        registeredCells: loaded.length }),
      provenance: Object.freeze({ source: 'Precomputed from verified regional GIS', analysisFingerprint: manifest.analysisFingerprint,
        regionVersion: catalog.version, derivedSchemaVersion: manifest.derivedSchemaVersion,
        method: 'Deterministic discovery metrics computed offline from the published regional partitions',
        note: 'Promotion reconstructs this corridor from the raw regional partitions and verifies it before any detailed analysis.' }),
      async queryDerivedCorridors() {
        const engine = await initialize();
        return queryDerivedCorridors(engine, loaded.map(file => file.name));
      },
    };
    lastDerivedScope = scope;
    return scope;
  }

  // ---------------------------------------------------------------- global roads
  //
  // The national road plane is online in full. A promotion therefore does not need a bounded region to hold its
  // roads: it reads the plane's own immutable namespace, for the cells the corridor needs and for every cell its
  // named road component occupies. That is what removes the closure-budget refusal class - there is no budget any
  // more, only the road's own cells - and it is why the bounded regions now exist for wetlands and hydrography.
  //
  // Nothing here weakens a check. The document that describes the plane is digest-pinned by the committed index,
  // every closure tile is digest-pinned by that document, and every cell is verified against the byte count and
  // digest the document declares. A plane whose version is not the version the region's own roads dataset was
  // published at is refused rather than substituted.
  const globalRoadsCache = new Map();

  async function openGlobalRoadsDocument(entry) {
    if (globalRoadsCache.has(entry.version)) return globalRoadsCache.get(entry.version);
    const base = new URL(entry.assetBaseUrl);
    const response = await fetch(new URL(entry.publicationUrl, base));
    if (!response.ok) throw new Error(`the published national roads plane is unavailable: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== entry.publicationBytes) throw new Error('the roads publication is not the declared byte count');
    const digest = await sha256Hex(bytes);
    if (digest !== entry.publicationSha256) throw new Error('the roads publication SHA-256 does not match the index');
    const publication = JSON.parse(new TextDecoder().decode(bytes));
    if (publication.version !== entry.version || publication.kind !== 'national-roads-publication') {
      throw new Error(`the roads publication is not ${entry.version}`);
    }
    const opened = { publication, base, present: new Map(publication.cells.map(cell => [cell.id, cell])),
      empty: new Set(publication.emptyCells ?? []), tiles: new Map(publication.closure.tiles.map(tile => [tile.key, tile])) };
    globalRoadsCache.set(entry.version, opened);
    return opened;
  }

  async function openClosureTiles({ document, entry, cells, metrics }) {
    // The tiles the corridor's own cells fall in, not one tile at the box's centre: a corridor longer than a tile
    // registers its component under any tile its cells touch, and reading only the middle one would miss the road.
    const keys = closureTileKeys(cells, entry.closure.cellSpan).filter(key => document.tiles.has(key));
    const components = [];
    for (const key of keys) {
      const declared = document.tiles.get(key);
      const cacheKey = `${entry.version}/tile/${declared.sha256}`;
      if (regionalFiles.has(cacheKey)) { metrics.cacheHits += 1; components.push(...regionalFiles.get(cacheKey)); continue; }
      const url = new URL(`${entry.closure.prefix}${key}.json`, document.base);
      const started = performance.now();
      const response = await fetch(url);
      if (!response.ok) throw new Error(`closure tile ${key}: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      metrics.fetchMs += performance.now() - started;
      if (bytes.byteLength !== declared.bytes) throw new Error(`closure tile ${key}: byte count mismatch`);
      if (await sha256Hex(bytes) !== declared.sha256) throw new Error(`closure tile ${key}: SHA-256 mismatch`);
      metrics.downloadedBytes += declared.bytes;
      const opened = validateRoadComponents(JSON.parse(new TextDecoder().decode(bytes))).components;
      regionalFiles.set(cacheKey, opened);
      components.push(...opened);
    }
    return components;
  }

  // A selected cell that the catalog declares valid-and-empty contributes no rows but is still covered data: it
  // means the published source has nothing there, which is a measured zero, not a failure. When every selected
  // cell is empty the dataset has no file to read, so the relation is built from the catalog's declared column
  // schema instead of failing. A missing artifact is a different state and still throws, because that is UNKNOWN.
  function emptyRelation(kind, dataset) {
    if (!Array.isArray(dataset.columns) || !dataset.columns.length) {
      throw new TypeError(`${kind}: selected partitions are empty and the catalog declares no column schema`);
    }
    const projection = dataset.columns.map(column => `NULL::${column.type} AS ${column.name}`).join(', ');
    return `(SELECT ${projection} WHERE false)`;
  }

  // The global road plane's cells for a corridor: the cells its box needs, plus every cell the road component it
  // belongs to occupies. The component closure is unchanged as *logic* - a corridor id was composed over the whole
  // national road network, so rebuilding it needs the whole road - but it no longer comes from a bounded
  // publication, which is what removes the closure budget as a reason promotion can fail.
  async function globalRoadsSelection({ entry, searchArea, metrics }) {
    const document = await openGlobalRoadsDocument(entry);
    const plane = { id: 'roads', cellStepDeg: entry.cellStepDeg };
    const base = cellsForBounds(plane, searchArea.bbox);
    const components = await openClosureTiles({ document, entry, cells: base,
      metrics });
    // Every component that touches the corridor's own cells is closed over, not only the one named by the row.
    // A discovery unit is composed from features and can span several components, and the corridor id the row
    // carries was composed over the whole national road network: restricting the closure to the named component
    // reproduces a shorter road and the promotion verification refuses it. Roads are published nationally, so the
    // wider closure costs a handful of cheap cells and nothing else.
    const wanted = new Set(base);
    let closed = 0;
    for (const component of components) {
      if (!component.cells.some(id => base.includes(id))) continue;
      closed += 1;
      for (const id of component.cells) wanted.add(id);
    }
    const partitions = [];
    for (const id of [...wanted].sort()) {
      const present = document.present.get(id);
      if (present) {
        partitions.push({ id, bounds: present.bounds, state: 'present', featureCount: present.featureCount,
          url: `${entry.pathPrefix}${id}.parquet`, bytes: present.bytes, sha256: present.sha256, base: entry.assetBaseUrl });
        continue;
      }
      if (document.empty.has(id)) { partitions.push({ id, bounds: rawCellBounds(id), state: 'empty', featureCount: 0 }); continue; }
      throw new Error(`the published national roads plane does not cover cell ${id}`);
    }
    return { partitions, components: closed, cells: partitions.filter(part => part.state === 'present').length };
  }

  // One selection path for both raw contracts. A published raw region and the regional pilot differ in where their
  // cells live and how many of them are online, not in how a search box becomes a set of cells: the same grid, the
  // same road-component closure, the same 1 km habitat halo, the same three planes.
  async function selectRawOrRegionalPartitions(catalog, searchArea, declaredType, globalRoadsEntry = null) {
    if (declaredType !== DISCOVERY_CATALOG_TYPE.RAW) {
      const components = await getRoadComponents(catalog);
      return selectRegionalPartitions(catalog, searchArea.bbox, { components });
    }
    const metrics = { fetchMs: 0, verifyMs: 0, registerMs: 0, downloadedBytes: 0, cacheHits: 0 };
    if (!globalRoadsEntry) {
      // No nationally published roads plane: the bounded region has to hold the roads as well, exactly as before.
      const components = await getRoadComponents(catalog);
      const selection = selectRegionalPartitions(catalog, searchArea.bbox, { components,
        componentIds: searchArea.roadComponentIds ?? null });
      return Object.freeze({ ...selection, raw: true, catalogVersion: catalog.version,
        publication: catalog.publication ?? null, globalRoads: false, globalRoadsMetrics: metrics });
    }
    // The region's own roads dataset records the road plane version it was published from. A global plane at a
    // different version is a different road network, and substituting it would rebuild a corridor from data the
    // derived row never described.
    const regionRoadsVersion = catalog.datasets.find(dataset => dataset.id === 'roads')?.version ?? null;
    if (regionRoadsVersion !== globalRoadsEntry.version) {
      throw new Error(`this corridor's roads were published as ${regionRoadsVersion}, but the national roads plane `
        + `online is ${globalRoadsEntry.version}`);
    }
    // The bounded selection still decides wetlands and hydrography; roads are replaced by the global plane. The
    // region's own component document is deliberately not consulted: with roads available nationally, a component
    // that reaches outside a bounded region is no longer a reason to refuse.
    const bounded = selectRegionalPartitions(catalog, searchArea.bbox, { components: null });
    const roads = await globalRoadsSelection({ entry: globalRoadsEntry, searchArea, metrics });
    const unpublished = Object.fromEntries(Object.entries(bounded.unpublished ?? {})
      .filter(([plane]) => plane !== 'roads'));
    const unpublishedCount = Object.values(unpublished).reduce((sum, ids) => sum + ids.length, 0);
    return Object.freeze({ ...bounded, raw: true, catalogVersion: catalog.version,
      publication: catalog.publication ?? null, globalRoads: true, globalRoadsMetrics: metrics,
      globalRoadsComponents: roads.components, globalRoadsCells: roads.cells,
      partitions: { ...bounded.partitions, roads: roads.partitions },
      unpublished, unpublishedCount, closureOutside: [],
      sourceReady: unpublishedCount === 0 });
  }

  // The sentence for a corridor whose raw source is not published yet. It names how many cells are missing and
  // which planes - the operator's next action - without pretending the corridor was measured.
  function rawSourceRefusal(selection) {
    const unpublished = Object.entries(selection.unpublished ?? {}).filter(([, ids]) => ids.length);
    const outside = selection.closureOutside ?? [];
    const parts = [];
    if (unpublished.length) {
      parts.push(`raw source cell${unpublished.reduce((sum, [, ids]) => sum + ids.length, 0) === 1 ? '' : 's'} `
        + `(${unpublished.map(([plane, ids]) => `${plane}: ${ids.length}`).join(', ')}) have not been published`);
    }
    if (outside.length) {
      parts.push(`the road component this corridor belongs to continues into ${outside.length} cell`
        + `${outside.length === 1 ? '' : 's'} outside the published region`);
    }
    return `Detailed analysis is not yet available for this corridor because ${parts.join(', and ')}. `
      + 'National discovery is unaffected.';
  }

  async function prepareRegionalSearch(searchArea, { onProgress = () => {} } = {}) {
    const started = performance.now();
    // Raw discovery reads raw partitions, and only a catalog that declares them. A search that declares the
    // national *derived* plane has no raw cells of its own: the app resolves the corridor's published raw region
    // first (src/discovery/raw-catalog.js) and hands that catalog in, so reaching this refusal means a caller
    // skipped that step. It is refused rather than loaded as something it never claimed to be.
    const declaredType = areaCatalogType(searchArea);
    if (declaredType === DISCOVERY_CATALOG_TYPE.NATIONAL) {
      const error = new Error('This search reads the national derived corridor-metrics plane. The raw road, '
        + 'wetland and hydrography partitions behind it live in bounded published regions, which the promotion '
        + 'path resolves before it asks for raw detail.');
      error.derivedUnavailable = true;
      throw error;
    }
    const catalog = await getDiscoveryCatalog(searchArea.catalogUrl, declaredType);
    const manifestMs = performance.now() - started;
    if (declaredType === DISCOVERY_CATALOG_TYPE.RAW) activeRawPublication = catalog.publication ?? null;
    const selection = await selectRawOrRegionalPartitions(catalog, searchArea, declaredType,
      searchArea.globalRoads ?? null);
    const selectionMs = performance.now() - started - manifestMs;
    // A published region need not be a published *whole*: a cell inside a region's rectangle can be explicitly
    // not published yet, and a corridor's road component can reach outside the rectangle altogether. Either way
    // the raw source for this corridor is not here, and saying so now - before a single object is fetched - is
    // the difference between a useful refusal and a road composed from half its length.
    if (declaredType === DISCOVERY_CATALOG_TYPE.RAW && !selection.sourceReady) {
      const error = new Error(rawSourceRefusal(selection));
      error.rawUnavailable = true;
      error.unpublishedCells = Object.values(selection.unpublished ?? {}).flat();
      error.closureOutsideCells = selection.closureOutside ?? [];
      throw error;
    }
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
            bytes: entry.transferredBytes, readExpression: entry.readExpression };
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
  // The raw publication the current *detail* scope was prepared from. Detail is one explicit action on one
  // candidate, and this is how its CONUS ecoregion artifacts travel with it; discovery never sets it, so a
  // discovery batch keeps reading the layers the manifest declares. Ecoregions are the one detail input that is
  // not partitioned per cell: EPA publishes them as whole-CONUS layers, so they are published once and shared.
  let activeRawPublication = null;

  async function openDeclaredArtifact(id, declared) {
    const key = `raw:${id}`;
    if (files.has(key)) return files.get(key);
    const engine = await initialize();
    const base = catalog?.assetBaseUrl ? new URL(catalog.assetBaseUrl) : DATA_BASE;
    const response = await fetch(new URL(declared.url, base));
    if (!response.ok) throw new Error(`${id} HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const byteLength = bytes.byteLength;
    if (byteLength !== declared.bytes) throw new Error(`${id} byte count mismatch`);
    if (declared.sha256) {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== declared.sha256) throw new Error(`${id} SHA-256 mismatch`);
    }
    const name = `${id}-${key}.parquet`;
    await engine.db.registerFileBuffer(name, new Uint8Array(bytes));
    const opened = { id, version: declared.version ?? null, source: declared.source ?? null, sha256: declared.sha256,
      registeredName: name, url: declared.url, transferredBytes: byteLength };
    files.set(key, opened);
    return opened;
  }

  async function ecoregionSources(level) {
    const declared = activeRawPublication?.ecoregions?.[`l${level}`] ?? null;
    if (declared) {
      const opened = await openDeclaredArtifact(`epa-ecoregions-conus-l${level}`, declared);
      return { entries: [{ id: opened.id, source: opened.source, version: opened.version }], opened: [opened] };
    }
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
      // Every declared layer of the level is part of the answer (a level is answered from their union), so
      // provenance lists them all rather than only the Oregon files.
      datasets = (await getManifest()).datasets.filter(item => item.id.startsWith('epa-ecoregions-'));
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
    get lastDerivedScope() { return lastDerivedScope; },
    prepareRegionalSearch,
    prepareDerivedSearch,
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

// The compatibility gate for the national derived plane.
//
// The full national fingerprint covers a Python pipeline (`scripts/build-national-derived.py`) and its source
// digest, which a browser cannot recompute, so the reviewed national catalog pins the *expected* fingerprint and
// `derivedAvailability` proves the manifest carries it. Everything the runtime *can* verify still fails closed
// here: the manifest must be the profile and schema version this build implements, it must cover exactly the
// region the catalog declares, and it must still carry every column the derived reader selects. A drifted build
// therefore reports a named incompatibility instead of reading columns that are not there.
export function assertNationalDerivedCompatibility(manifest, catalog) {
  if (manifest.profileVersion !== ANALYSIS_PROFILE_VERSION || manifest.derivedSchemaVersion !== DERIVED_SCHEMA_VERSION) {
    throw new Error('The published national derived plane was built for analysis profile/schema '
      + `${manifest.profileVersion}/${manifest.derivedSchemaVersion}, but this build implements `
      + `${ANALYSIS_PROFILE_VERSION}/${DERIVED_SCHEMA_VERSION}.`);
  }
  const bounds = manifest.region?.bounds ?? [];
  if (bounds.length !== 4 || bounds.some((value, index) => Math.abs(value - catalog.region.bounds[index]) > 1e-9)) {
    throw new Error('The published national derived plane does not cover the region the national catalog declares.');
  }
  const missing = DERIVED_COLUMNS.filter(column => !(manifest.schema ?? []).includes(column));
  if (missing.length) {
    throw new Error(`The published national derived plane is missing columns this build reads: ${missing.slice(0, 6).join(', ')}.`);
  }
}

function validateBounds(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) throw new TypeError('Road query bounds must be four finite numbers');
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new TypeError('Road query bounds must be ordered min/max');
}

function sha256Hex(buffer) {
  return crypto.subtle.digest('SHA-256', buffer).then(digest =>
    Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join(''));
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
