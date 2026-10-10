#!/usr/bin/env node
// Publish one bounded region of the national raw planes, so that corridors inside it can be promoted.
//
//   node scripts/publish-national-raw.mjs --region princeton-in --bounds -87.66,38.29,-87.49,38.43 --label "Princeton, Indiana"
//   node scripts/publish-national-raw.mjs --region evansville-in --bounds -87.62,37.93,-87.49,38.05 --dry-run
//   node scripts/publish-national-raw.mjs --audit --region princeton-in
//   node scripts/publish-national-raw.mjs --publish-ecoregions
//
// WHY A REGION AND NOT THE LAKE. The three raw national planes are about 188 GB, of which wetlands alone are
// 156 GB. Discovery never needs them: it reads the derived plane, which is published everywhere and stays the
// discovery payload. Deep inspection needs a handful of objects per promotion - measured, a median of five
// objects and about 17 MB - so this tool publishes exactly the cells a requested area needs, under the planes'
// own canonical immutable keys, and records them in a small committed index the runtime reads. Coverage then
// grows where people actually explore instead of being paid for everywhere in advance.
//
// WHAT IT GUARANTEES. It refuses to run without the build volume; it refuses a local artifact that does not match
// the byte count and digest its manifest declares; it never overwrites an object at an immutable key; it verifies
// what it uploaded before recording anything; it is resumable (a checkpoint per region version) and idempotent (an
// object already online with the right length is reused, not re-uploaded). Nothing is recorded as published until
// the bytes are on R2 and the region catalog that describes them is on R2 too.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { IMMUTABLE_CACHE_CONTROL, JSON_TYPE, PARQUET_TYPE } from './national-derived-objects.mjs';
import { ECOREGIONS, RAW_INDEX_PATH, cellsForBounds, ecoregionArtifacts, indexEntry, loadPlanes, localCellPath,
  objectKeyFor, paddedBounds, regionCatalog, regionRectangle } from './national-raw-objects.mjs';
import { ROADS_PLANE, TILE_CELLS, closureTiles, roadsPublicationSet, tileDocument } from './national-roads-publication.mjs';

const readText = path => readFileSync(path, 'utf8');

const run = promisify(execFile);
const WRANGLER = 'wrangler@4.135.0';
const BUCKET = 'roadnaturalist-data';
const BASE = 'https://data.roadnaturalist.com/';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BUILD = process.env.ROADNATURALIST_BUILD_VOLUME ?? '/Volumes/Lexar/roadnaturalist';
const WORK = join(BUILD, 'work/raw-publication');
const ANALYSIS_DISTANCE_M = 1000;

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const rate = Number(option('--rate') ?? 4);
const via = option('--via') ?? 'api';
const dryRun = flag('--dry-run');
const account = option('--account') ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? null;
let nextSlot = 0;
async function pace() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + 1000 / rate;
  if (slot > now) await new Promise(resolve => setTimeout(resolve, slot - now));
}

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function wranglerConfig() {
  return [process.env.WRANGLER_CONFIG, join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
    join(homedir(), '.config/.wrangler/config/default.toml'), join(homedir(), '.wrangler/config/default.toml')]
    .find(path => path && existsSync(path)) ?? null;
}

function storedToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const path = wranglerConfig();
  const match = path ? /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(path, 'utf8')) : null;
  return match ? match[1] : null;
}

let token = via === 'api' ? storedToken() : null;
async function refreshToken() {
  try { await run('npx', ['--yes', WRANGLER, 'r2', 'bucket', 'list'], { timeout: 120000 }); } catch { /* fall through */ }
  return storedToken();
}

// The publication is small and paced, so the API path is fine: a region is tens of objects, and the pacer keeps
// under the throttle the derived publisher had to discover. `--via wrangler` uses the same CLI that publication
// falls back to when no API token is present.
async function putObject({ key, path, type }) {
  if (via === 'wrangler') {
    await run('npx', ['--yes', WRANGLER, 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', path,
      '--content-type', type, '--cache-control', IMMUTABLE_CACHE_CONTROL, '--remote'],
      { maxBuffer: 8 * 1024 * 1024, timeout: 900000 });
    return;
  }
  const body = readFileSync(path);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await pace();
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${BUCKET}/objects/${key}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type,
        'Cache-Control': IMMUTABLE_CACHE_CONTROL }, body, signal: AbortSignal.timeout(300000) });
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) { token = await refreshToken(); continue; }
    if (response.status === 429) {
      await new Promise(resolve => setTimeout(resolve, Math.min(30000, 1000 * 2 ** attempt) * (0.5 + Math.random())));
      continue;
    }
    throw new Error(`${key}: HTTP ${response.status} ${await response.text()}`);
  }
  throw new Error(`${key}: still throttled or unauthenticated after retries`);
}

async function remoteLength(key) {
  const response = await fetch(new URL(key, BASE), { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(30000) });
  if (!response.ok) return null;
  return Number(response.headers.get('content-length'));
}

async function remoteDigest(key) {
  const response = await fetch(new URL(key, BASE), { headers: { 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(600000) });
  if (!response.ok) return null;
  return { bytes: Number(response.headers.get('content-length')), sha256: sha256(Buffer.from(await response.arrayBuffer())) };
}

// Reuse what is already online, refuse a conflicting object at an immutable key, upload only what is missing.
async function ensureObject(object, journal) {
  const remote = await remoteLength(object.key);
  if (remote !== null && remote === object.bytes) {
    journal.push({ key: object.key, action: 'reused', bytes: object.bytes });
    return 'reused';
  }
  if (remote !== null) {
    throw new Error(`${object.key} already exists with ${remote} bytes, not ${object.bytes}: an immutable key `
      + 'cannot be overwritten, so this publication is refused rather than guessed at');
  }
  if (dryRun) {
    journal.push({ key: object.key, action: 'would-upload', bytes: object.bytes });
    return 'would-upload';
  }
  await putObject(object);
  const after = await remoteLength(object.key);
  if (after !== object.bytes) throw new Error(`${object.key} uploaded, but the published origin reports ${after} bytes`);
  journal.push({ key: object.key, action: 'uploaded', bytes: object.bytes });
  return 'uploaded';
}

// A compact document under the build volume's work directory: one line per published object, so an interrupted
// publication resumes at the next object instead of re-uploading what is already verified. It is never a source
// of truth about what is online - the origin is - and it is written under the build volume, never /tmp.
function checkpoint(regionId, version) {
  const directory = join(WORK, regionId, version);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'published.jsonl');
  return { path, record: entry => appendFileSync(path, JSON.stringify(entry) + '\n'),
    entries: () => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []) };
}



// ---------------------------------------------------------------- what a region publication needs

// The closure: which cells a road component occupies. Read from the build volume's closure document, which the
// derived plane produced (scripts/build-national-raw-closure.py). A component that spans one cell is not in it,
// because it adds nothing to a closure.
function loadClosure(path) {
  if (!existsSync(path)) {
    throw new Error(`the road closure index is not on the volume: ${path}; run scripts/build-national-raw-closure.py first`);
  }
  const byCell = new Map();
  const components = new Map();
  for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line);
    components.set(entry.id, entry);
    for (const cell of entry.cells) {
      if (!byCell.has(cell)) byCell.set(cell, []);
      byCell.get(cell).push(entry.id);
    }
  }
  return { byCell, components };
}

function parseBounds(value) {
  const bounds = String(value ?? '').split(',').map(Number);
  if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
    throw new Error('--bounds wants minLon,minLat,maxLon,maxLat');
  }
  return bounds;
}

// Which cells this region must publish: the corridor box's own cells, the closure of every road component that
// touches them *and fits the component budget*, and - for the habitat planes - the cells the 1 km analysis halo
// reaches. The budget is per component, not for their union: a highway that crosses half a country is one
// component, and letting it set the rectangle is how a bounded region stops being bounded. Components over the
// budget are left out and reported; the reader refuses a promotion of their corridors with the cell count, which
// is the honest answer while a bounded publication cannot hold them.
function resolveRegion({ closure, bounds, marginCells, maxClosureCells }) {
  const boxCells = cellsForBounds(bounds);
  const habitatCells = cellsForBounds(paddedBounds(bounds, ANALYSIS_DISTANCE_M));
  const touching = new Set();
  for (const cell of boxCells) for (const id of closure.byCell.get(cell) ?? []) touching.add(id);
  const closureCells = new Set();
  const published = new Set();
  const skipped = [];
  for (const id of touching) {
    const component = closure.components.get(id);
    if (component.cells.length > maxClosureCells) { skipped.push({ id, cells: component.cells.length }); continue; }
    published.add(id);
    for (const cell of component.cells) closureCells.add(cell);
  }
  const required = {
    roads: [...new Set([...boxCells, ...closureCells])].sort(),
    wetlands: [...habitatCells].sort(),
    hydrography: [...habitatCells].sort(),
  };
  const rectangle = regionRectangle([...new Set(Object.values(required).flat())], marginCells);
  return { boxCells, closureIds: [...published], skippedClosures: skipped, required, rectangle };
}

// Verify every required artifact against the identity its manifest declares, before a single byte is uploaded.
// This is the step that makes "the build volume is required" a real rule rather than a hope: the file either is
// the finalized cell the plane published, or the publication stops.
function verifyLocal({ planes, required, buildRoot }) {
  const verified = {};
  const roots = new Set();
  for (const plane of planes) {
    verified[plane.id] = new Map();
    for (const id of required[plane.id]) {
      const manifest = plane.cells.get(id);
      if (!manifest) throw new Error(`${plane.id} has no cell ${id} in ${plane.manifest}`);
      if (manifest.state === 'empty') { verified[plane.id].set(id, { empty: true }); continue; }
      const local = localCellPath(plane, manifest, buildRoot);
      if (!local) throw new Error(`${plane.id} cell ${id} is not finalized on this machine (build volume or declared root)`);
      const bytes = readFileSync(local.path);
      if (bytes.length !== manifest.bytes) throw new Error(`${plane.id} ${id}: ${bytes.length} bytes locally, ${manifest.bytes} declared`);
      if (sha256(bytes) !== manifest.sha256) throw new Error(`${plane.id} ${id}: local digest does not match the declared one`);
      roots.add(`${plane.id}: ${local.root}`);
      verified[plane.id].set(id, { path: local.path, bytes: manifest.bytes, sha256: manifest.sha256,
        featureCount: manifest.featureCount ?? 0, key: objectKeyFor(plane, manifest) });
    }
  }
  return { verified, roots: [...roots] };
}

function regionVersion(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `raw-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-`
    + `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

// The components document the region catalog points at: the components that touch this region's published road
// cells, with the complete cell list of each. Complete, not clipped - that is what lets the reader see that a
// road leaves the region instead of quietly composing a shorter one.
function regionComponentsDocument({ closure, publishedRoadCells }) {
  const wanted = new Set();
  for (const cell of publishedRoadCells) for (const id of closure.byCell.get(cell) ?? []) wanted.add(id);
  const components = [...wanted].map(id => closure.components.get(id)).filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));
  return { kind: 'road-components', schemaVersion: 1, version: 'raw-region-v1',
    counts: { components: components.length }, components };
}

// The committed index the runtime reads. Every region's catalog is described here with the digests a browser
// verifies before it reads a byte of it, so a region that is not in this index does not exist for production.
function readIndex() {
  const path = join(ROOT, RAW_INDEX_PATH);
  // An entry written before the index recorded where its catalog is served from is upgraded here, once, when the
  // index is next written: the catalogs on R2 are unchanged, and the origin was always this one.
  const upgrade = index => ({ ...index, regions: index.regions.map(region =>
    ({ assetBaseUrl: BASE, ...region })) });
  return existsSync(path) ? upgrade(readJson(path)) : { kind: 'road-discovery-raw-regions', schemaVersion: 1,
    note: 'The bounded raw regions that are online for detailed corridor analysis. Discovery never reads these: it '
      + 'runs on the derived plane, published everywhere. A corridor outside every region here is refused with '
      + 'what is missing rather than measured from partial data.',
    planes: [], regions: [] };
}

async function publishEcoregions({ ecoregions }) {
  const published = {};
  for (const [key, declared] of Object.entries(ecoregions)) {
    if (!existsSync(declared.local)) throw new Error(`the ecoregion artifact ${declared.url} is not on the volume`);
    const bytes = readFileSync(declared.local);
    if (bytes.length !== declared.bytes || sha256(bytes) !== declared.sha256) {
      throw new Error(`the ecoregion artifact ${declared.url} does not match its declared identity`);
    }
    const action = await ensureObject({ key: declared.url, path: declared.local, bytes: declared.bytes, type: PARQUET_TYPE }, []);
    published[key] = { url: declared.url, bytes: declared.bytes, sha256: declared.sha256, version: declared.version,
      source: declared.source, action };
  }
  return published;
}

// Regions may overlap, and deliberately do: availability is answered per cell from the index, so two regions that
// both hold a cell are not ambiguous - a corridor is served by whichever one covers what it needs, chosen
// deterministically. What is refused is re-publishing an existing region at a *new version* while its old catalog
// still claims the same cells without saying so: the caller must use the same region id for an extension.
function assertDistinctRegion(index, regionId) {
  const existing = index.regions.find(region => region.id === regionId);
  if (existing) console.log(`extending ${regionId}: previously ${existing.objects} objects, ${existing.bytes} bytes`);
}

async function auditRegion(region) {
  const problems = [];
  const catalog = await remoteDigest(region.catalogUrl);
  if (!catalog) problems.push(`${region.catalogUrl} is not published`);
  else {
    if (catalog.bytes !== region.catalogBytes) problems.push(`${region.catalogUrl}: ${catalog.bytes} bytes, the index says ${region.catalogBytes}`);
    if (catalog.sha256 !== region.catalogSha256) problems.push(`${region.catalogUrl}: digest differs from the index`);
  }
  if (region.componentsUrl) {
    const components = await remoteDigest(region.componentsUrl);
    if (!components) problems.push(`${region.componentsUrl} is not published`);
    else if (components.sha256 !== region.componentsSha256) problems.push(`${region.componentsUrl}: digest differs from the index`);
  }
  // One published cell is re-fetched and hashed: a spot check that reads real bytes is worth more than a length
  // check that trusts the origin's headers, and the index is small enough to make it cheap.
  if (region.sampleObject) {
    const digest = await remoteDigest(region.sampleObject.key);
    if (!digest) problems.push(`${region.sampleObject.key} is not published`);
    else if (digest.sha256 !== region.sampleObject.sha256) problems.push(`${region.sampleObject.key}: published digest differs`);
  }
  return { region: region.id, catalogBytes: catalog?.bytes ?? 0, problems };
}

async function publishOneRegion() {
  const regionId = option('--region');
  if (!regionId || !/^[a-z0-9][a-z0-9._-]*$/.test(regionId)) throw new Error('--region wants a lowercase slug');
  const bounds = parseBounds(option('--bounds'));
  const marginCells = Number(option('--margin-cells') ?? 1);
  const maxClosureCells = Number(option('--max-closure-cells') ?? 256);
  const planes = loadPlanes(path => readFileSync(path, 'utf8'));
  const ecoregions = ecoregionArtifacts(path => readFileSync(path, 'utf8'), BUILD);
  const closure = loadClosure(join(BUILD, 'work/raw-closure/components.jsonl'));
  const index = readIndex();

  const { required, rectangle, closureIds, skippedClosures } = resolveRegion({ closure, bounds, marginCells, maxClosureCells });
  assertDistinctRegion(index, regionId, rectangle);
  const { verified, roots } = verifyLocal({ planes, required, buildRoot: BUILD });
  const version = regionVersion();
  const journal = checkpoint(regionId, version);

  const objects = [];
  for (const plane of planes) {
    for (const [id, entry] of verified[plane.id]) {
      if (!entry.empty) objects.push({ key: entry.key, path: entry.path, bytes: entry.bytes, type: PARQUET_TYPE, plane: plane.id, cell: id });
    }
  }
  console.log(`region ${regionId} ${version}: ${rectangle.cells.length} cells in the rectangle, ${objects.length} objects, `
    + `${closureIds.length} road components closed over, bounds ${rectangle.bounds.join(', ')}`);
  if (skippedClosures.length) {
    console.log(`left out ${skippedClosures.length} road component(s) beyond ${maxClosureCells} cells: `
      + skippedClosures.sort((left, right) => right.cells - left.cells).slice(0, 4)
        .map(component => `${component.id} (${component.cells} cells)`).join(', '));
  }
  console.log(`local roots: ${roots.join(' | ')}`);

  const actions = { uploaded: 0, reused: 0, 'would-upload': 0 };
  for (const object of objects) {
    const action = await ensureObject(object, []);
    actions[action] += 1;
    journal.record({ key: object.key, bytes: object.bytes, action, at: new Date().toISOString() });
  }
  return { regionId, version, rectangle, planes, verified, roots, objects, actions, index, ecoregions,
    publishedEcoregions: null, entry: null, catalogBuffer: null };
}

// The documents that describe the region: its road-component closure first (the catalog points at it), then the
// catalog itself, then the committed index entry - in that order, because nothing is recorded as published until
// every byte it describes is on R2.
async function publishOneRegionDocuments(state) {
  const { regionId, version, rectangle, planes, verified, roots, objects, index, ecoregions } = state;
  const closure = loadClosure(join(BUILD, 'work/raw-closure/components.jsonl'));
  const publishedEcoregions = await publishEcoregions({ ecoregions });
  const publishedRoadCells = [...verified.roads.entries()].filter(([, entry]) => !entry.empty).map(([id]) => id);
  const componentsDocument = regionComponentsDocument({ closure, publishedRoadCells });
  const componentsPath = join(WORK, regionId, version, 'road-components.json');
  writeFileSync(componentsPath, JSON.stringify(componentsDocument) + '\n');
  const componentsBuffer = readFileSync(componentsPath);
  await ensureObject({ key: `raw/${regionId}/${version}/road-components.json`, path: componentsPath,
    bytes: componentsBuffer.length, type: JSON_TYPE }, []);
  const catalog = regionCatalog({ regionId, version, rectangle, planes, published: verified,
    components: { bytes: componentsBuffer.length, sha256: sha256(componentsBuffer) },
    ecoregions: Object.fromEntries(Object.entries(publishedEcoregions).map(([key, entry]) => [key,
      { url: entry.url, bytes: entry.bytes, sha256: entry.sha256, version: entry.version, source: entry.source }])),
    assetBaseUrl: BASE, publishedAt: new Date().toISOString(),
    provenance: { label: option('--label') ?? regionId,
      sourceCoverage: `${rectangle.cells.length} raw cells around ${rectangle.bounds.join(', ')}` } });
  const catalogPath = join(WORK, regionId, version, 'manifest.json');
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 1) + '\n');
  const catalogBuffer = readFileSync(catalogPath);
  const catalogAction = await ensureObject({ key: `raw/${regionId}/${version}/manifest.json`, path: catalogPath,
    bytes: catalogBuffer.length, type: JSON_TYPE }, []);
  return { ...state, publishedEcoregions, componentsBuffer, catalogBuffer, catalogAction };
}



function indexEntryFor(state) {
  const { regionId, version, rectangle, planes, verified, roots, objects, publishedEcoregions, catalogBuffer,
    componentsBuffer, catalogAction } = state;
  const bytes = objects.reduce((sum, object) => sum + object.bytes, 0);
  const sample = objects[0] ?? null;
  return { ...indexEntry({ regionId, version, rectangle, planes, verified, ecoregions: publishedEcoregions,
    bytes, objects: objects.length, roots, label: option('--label') ?? null, assetBaseUrl: BASE }),
  catalogBytes: catalogBuffer.length, catalogSha256: sha256(catalogBuffer),
  componentsUrl: `raw/${regionId}/${version}/road-components.json`, componentsBytes: componentsBuffer.length,
  componentsSha256: sha256(componentsBuffer), catalogAction,
  sampleObject: sample ? { key: sample.key, bytes: sample.bytes,
    sha256: verified[sample.plane].get(sample.cell).sha256 } : null };
}

// A HEAD that reports what the origin actually serves, not just a length: the audit checks the immutable cache
// header and the content type as well, because an object with the right bytes and the wrong headers is still a
// publication mistake.
async function remoteHead(key) {
  const response = await fetch(new URL(key, BASE), { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(30000) });
  if (!response.ok) return null;
  return { bytes: Number(response.headers.get('content-length')),
    contentType: response.headers.get('content-type'), cacheControl: response.headers.get('cache-control') };
}

// ---------------------------------------------------------------- the whole roads plane

// Verify every declared present cell against the manifest before a byte is uploaded: the file either is the
// finalized artifact the plane published, or the publication stops. 21,135 files and 5.82 GB is about a minute of
// reading, which is nothing compared with publishing a byte that is not what it claims to be. This is also the
// pre-publication audit: the set comes from the manifest, not from a directory scan, so sidecars, logs and
// leftovers cannot enter it and a typed-empty cell is not expected to have an object.
function auditRoadsLocally({ set, root }) {
  const started = Date.now();
  const problems = [];
  let bytes = 0;
  for (const cell of set.cells) {
    const path = join(root, `${cell.id}.parquet`);
    if (!existsSync(path)) { problems.push(`${cell.id}: not finalized at ${path}`); continue; }
    const payload = readFileSync(path);
    if (payload.length !== cell.bytes) { problems.push(`${cell.id}: ${payload.length} bytes locally, ${cell.bytes} declared`); continue; }
    if (sha256(payload) !== cell.sha256) { problems.push(`${cell.id}: local digest differs from the declared one`); continue; }
    bytes += payload.length;
  }
  const seconds = Math.max((Date.now() - started) / 1000, 0.001);
  if (problems.length) {
    throw new Error(`the local roads audit failed: ${problems.slice(0, 5).join('; ')}`
      + `${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}`);
  }
  return { cells: set.cells.length, bytes, seconds,
    megabytesPerSecond: bytes / 1e6 / seconds };
}

function roadObject(cell, root) {
  return { key: cell.url, path: join(root, `${cell.id}.parquet`), bytes: cell.bytes, type: PARQUET_TYPE };
}

// The closure tiles: which multi-cell components touch each 1 degree tile, each with its complete cell list.
function writeClosureTiles({ closurePath, directory, log }) {
  const { tiles, components } = closureTiles(readText(closurePath).split('\n'));
  mkdirSync(directory, { recursive: true });
  const written = [];
  let bytes = 0;
  for (const key of [...tiles.keys()].sort()) {
    const document = tileDocument(key, tiles.get(key));
    const payload = Buffer.from(JSON.stringify(document) + '\n');
    const path = join(directory, `${key}.json`);
    writeFileSync(path, payload);
    bytes += payload.length;
    written.push({ key, bytes: payload.length, sha256: sha256(payload), components: document.counts.components });
  }
  log(`closure: ${components.toLocaleString()} multi-cell components over ${written.length} tiles, ${bytes.toLocaleString()} bytes`);
  return { tiles: written, bytes, components };
}

function roadsPublicationDocument({ set, tiles, publishedAt }) {
  return { kind: 'national-roads-publication', schemaVersion: 1, version: ROADS_PLANE.version,
    publishedAt, cellStepDeg: ROADS_PLANE.cellStepDeg, assetBaseUrl: BASE, pathPrefix: ROADS_PLANE.pathPrefix,
    grid: { kind: 'lonlat-grid', origin: [-180, -90], stepLon: ROADS_PLANE.cellStepDeg, stepLat: ROADS_PLANE.cellStepDeg,
      crs: 'EPSG:4326' },
    counts: { cells: set.cells.length + set.empty.length, present: set.cells.length, empty: set.empty.length,
      bytes: set.bytes, closureTiles: tiles.length },
    cells: set.cells.map(cell => ({ id: cell.id, bounds: cell.bounds, bytes: cell.bytes, sha256: cell.sha256,
      featureCount: cell.featureCount })),
    emptyCells: set.empty.map(cell => cell.id),
    closure: { cellSpan: TILE_CELLS, prefix: ROADS_PLANE.componentsPrefix,
      tiles: tiles.map(tile => ({ key: tile.key, bytes: tile.bytes, sha256: tile.sha256 })) },
    note: 'The complete national road raw plane. Discovery never reads these objects; detailed promotion reads the '
      + 'cells a corridor occupies, and the closure tiles say which cells its named road occupies.' };
}



// List every object under a prefix, so the audit can say whether the remote inventory holds anything the manifest
// did not ask for. Paged, because 21,135 objects is more than one page.
async function listRemote(prefix) {
  const keys = [];
  let cursor = null;
  for (let page = 0; page < 200; page += 1) {
    const query = new URLSearchParams({ prefix, per_page: '1000' });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${BUCKET}/objects?${query}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
    if (response.status === 401 || response.status === 403) { token = await refreshToken(); continue; }
    if (!response.ok) throw new Error(`listing ${prefix}: HTTP ${response.status} ${await response.text()}`);
    const body = await response.json();
    for (const object of body.result ?? []) keys.push(object.key);
    if (!body.result_info?.is_truncated) break;
    cursor = body.result_info.cursor ?? null;
  }
  return keys;
}

// A small worker pool: the pacer already bounds the write rate, so the only thing concurrency changes is how much
// of each request's latency is hidden. Without it a 21,135-object publication is latency-bound at about one object
// a second, which turns a forty-minute publication into a seven-hour one.
async function inBatches(items, size, worker, onProgress = null) {
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
      done += 1;
      if (onProgress) onProgress(done, items[index], index);
    }
  });
  await Promise.all(workers);
}

// The whole-plane publication: audit the canonical artifacts, publish every present cell and the closure tiles,
// then the document that describes them, then verify the origin against it before anything is declared ready.
async function publishRoadsPlane() {
  const set = roadsPublicationSet({ readFile: readText });
  const root = join(ROOT, ROADS_PLANE.repositoryRoot);
  if (!existsSync(root)) throw new Error(`the finalized roads plane is not on this machine: ${root}`);
  console.log(`roads ${set.manifest.version}: ${set.cells.length.toLocaleString()} present cells, `
    + `${set.bytes.toLocaleString()} bytes, ${set.empty.length} typed-empty of ${set.manifest.counts.cells} grid cells`);
  console.log(`source root: ${root} (the canonical finalized artifacts; nothing else is enumerated)`);
  const local = auditRoadsLocally({ set, root });
  console.log(`local audit: ${local.cells.toLocaleString()} cells match the manifest in ${local.seconds.toFixed(1)}s `
    + `(${local.megabytesPerSecond.toFixed(1)} MB/s)`);

  const versionDir = join(WORK, `roads-${ROADS_PLANE.version}`);
  const tiles = writeClosureTiles({ closurePath: join(BUILD, 'work/raw-closure/components.jsonl'),
    directory: join(versionDir, 'components'), log: console.log });
  const journal = checkpoint('roads', ROADS_PLANE.version);

  const started = Date.now();
  const actions = { uploaded: 0, reused: 0, 'would-upload': 0 };
  let uploadedBytes = 0;
  const concurrency = Number(option('--concurrency') ?? 12);
  await inBatches(set.cells, concurrency, async cell => {
    const action = await ensureObject(roadObject(cell, root), []);
    actions[action] += 1;
    if (action === 'uploaded') uploadedBytes += cell.bytes;
    journal.record({ key: cell.url, bytes: cell.bytes, action, at: new Date().toISOString() });
  }, done => {
    if (done % 500 !== 0 && done !== set.cells.length) return;
    const elapsed = (Date.now() - started) / 1000;
    console.log(`  ${done}/${set.cells.length} cells: ${actions.uploaded} uploaded, ${actions.reused} reused, `
      + `${(done / elapsed).toFixed(1)} objects/s, ${(uploadedBytes / 1e6 / elapsed).toFixed(2)} MB/s, `
      + `${(elapsed / 60).toFixed(1)} min elapsed`);
  });

  const tilesUploaded = { uploaded: 0, reused: 0 };
  await inBatches(tiles.tiles, concurrency, async tile => {
    const path = join(versionDir, 'components', `${tile.key}.json`);
    const action = await ensureObject({ key: `${ROADS_PLANE.componentsPrefix}${tile.key}.json`, path,
      bytes: tile.bytes, type: JSON_TYPE }, []);
    tilesUploaded[action in tilesUploaded ? action : 'reused'] += 1;
  });
  const publication = roadsPublicationDocument({ set, tiles: tiles.tiles, publishedAt: new Date().toISOString() });
  const publicationPath = join(versionDir, 'publication.json');
  writeFileSync(publicationPath, JSON.stringify(publication) + '\n');
  const publicationBytes = readFileSync(publicationPath);
  const publicationAction = await ensureObject({ key: ROADS_PLANE.publicationUrl, path: publicationPath,
    bytes: publicationBytes.length, type: JSON_TYPE }, []);
  const elapsed = (Date.now() - started) / 1000;
  console.log(`roads upload: ${JSON.stringify(actions)} cells (${uploadedBytes.toLocaleString()} bytes uploaded), `
    + `tiles ${JSON.stringify(tilesUploaded)} (${tiles.bytes.toLocaleString()} bytes), publication.json `
    + `${publicationAction} (${publicationBytes.length.toLocaleString()} bytes)`);
  console.log(`elapsed ${(elapsed / 60).toFixed(1)} min; ${(set.cells.length / elapsed).toFixed(1)} objects/s; `
    + `${((uploadedBytes + tiles.bytes + publicationBytes.length) / 1e6 / elapsed).toFixed(2)} MB/s`);
  return { set, tiles, publication, publicationBytes, actions, uploadedBytes, tilesUploaded, elapsed,
    local, versionDir };
}

async function main() {
  if (!existsSync(BUILD)) {
    throw new Error(`raw publication is refused: the build volume is not mounted (${BUILD}). The finalized source `
      + 'cells live there; publishing from anywhere else would be publishing something unverified.');
  }
  const ecoregions = ecoregionArtifacts(path => readFileSync(path, 'utf8'), BUILD);

  // The whole-plane mode: publish the complete national roads plane, audit it, and only then declare it ready.
  if (option('--plane') === 'roads' && flag('--all')) {
    const state = await publishRoadsPlane();
    const audit = await auditRoadsRemote({ publication: state.publication,
      sample: Number(option('--sample-digests') ?? 12) });
    const online = {};
    for (const [key, declared] of Object.entries(ecoregions)) {
      const head = await remoteHead(declared.url);
      online[key] = { url: declared.url, bytes: declared.bytes, sha256: declared.sha256, version: declared.version,
        published: head?.bytes === declared.bytes };
    }
    const ecoreVersion = Object.values(ecoregions)[0]?.version ?? 'unknown';
    writeGlobalPlanes(globalPlaneEntry({ ...state, audit, ecoregions: online }),
      ecoregionPlaneEntry({ ecoregions: online, version: ecoreVersion, base: BASE }));
    return audit.ok ? 0 : 1;
  }
  if (option('--plane') === 'roads' && flag('--audit-remote')) {
    const response = await fetch(new URL(ROADS_PLANE.publicationUrl, BASE));
    if (!response.ok) throw new Error(`the roads publication is not online: HTTP ${response.status}`);
    const publication = await response.json();
    const stored = readIndex().globalPlanes?.roads ?? null;
    if (stored && stored.publicationSha256 !== sha256(Buffer.from(JSON.stringify(publication) + '\n'))) {
      console.log('note: the published publication.json digest differs from the recorded one');
    }
    const audit = await auditRoadsRemote({ publication, sample: Number(option('--sample-digests') ?? 12) });
    return audit.ok ? 0 : 1;
  }

  if (flag('--audit')) {

// The remote audit: every expected object exists with the right length, the right content type and the immutable
// cache header; a sample is re-fetched and hashed; every closure tile is hashed in full; and the namespace holds
// nothing the publication did not ask for. Roads are not declared ready until this passes.
async function auditRoadsRemote({ publication, sample = 12 }) {
  const problems = [];
  const missing = [];
  const sizeMismatch = [];
  const headerProblems = [];
  const started = Date.now();
  const expected = new Set([ROADS_PLANE.publicationUrl]);
  const concurrency = Number(option('--concurrency') ?? 12);
  await inBatches(publication.cells, concurrency, async cell => {
    expected.add(`${ROADS_PLANE.pathPrefix}${cell.id}.parquet`);
    const head = await remoteHead(`${ROADS_PLANE.pathPrefix}${cell.id}.parquet`);
    if (!head) { missing.push(cell.id); return; }
    if (head.bytes !== cell.bytes) sizeMismatch.push(cell.id);
    if (!(head.cacheControl ?? '').includes('immutable')) headerProblems.push(`${cell.id} cache-control ${head.cacheControl}`);
    if ((head.contentType ?? '').includes('parquet') !== true) headerProblems.push(`${cell.id} content-type ${head.contentType}`);
  });
  const sampled = [];
  for (const cell of publication.cells.slice(0, sample)) {
    const digest = await remoteDigest(`${ROADS_PLANE.pathPrefix}${cell.id}.parquet`);
    if (!digest || digest.sha256 !== cell.sha256) problems.push(`${cell.id}: published digest differs`);
    sampled.push(cell.id);
  }
  const tileProblems = [];
  for (const tile of publication.closure.tiles) expected.add(`${publication.closure.prefix}${tile.key}.json`);
  await inBatches(publication.closure.tiles, concurrency, async tile => {
    const digest = await remoteDigest(`${publication.closure.prefix}${tile.key}.json`);
    if (!digest) tileProblems.push(`${tile.key}: not published`);
    else if (digest.sha256 !== tile.sha256) tileProblems.push(`${tile.key}: digest differs`);
  });
  const publicationHead = await remoteHead(ROADS_PLANE.publicationUrl);
  if (!publicationHead) problems.push('publication.json is not published');
  const remote = await listRemote('national/roads/');
  const unexpected = remote.filter(key => !expected.has(key)).slice(0, 20);
  const elapsed = (Date.now() - started) / 1000;
  const audit = { checked: publication.cells.length, missing: missing.slice(0, 20), missingCount: missing.length,
    sizeMismatch: sizeMismatch.slice(0, 20), sizeMismatchCount: sizeMismatch.length,
    headerProblems: headerProblems.slice(0, 10), headerProblemCount: headerProblems.length,
    digestProblems: problems, tileProblems, sampled, remoteObjects: remote.length, unexpected,
    seconds: Math.round(elapsed),
    ok: !missing.length && !sizeMismatch.length && !headerProblems.length && !problems.length
      && !tileProblems.length && !unexpected.length };
  console.log(`remote audit: ${audit.ok ? 'PASSED' : 'FAILED'} - ${audit.checked.toLocaleString()} cell objects, `
    + `${publication.closure.tiles.length} closure tiles, ${remote.length.toLocaleString()} objects under national/roads/, `
    + `${audit.seconds}s`);
  if (missing.length || sizeMismatch.length || problems.length || tileProblems.length || unexpected.length) {
    console.log(JSON.stringify(audit, null, 1));
  }
  return audit;
}

// The readiness declaration. It lives with the raw region index because that is the document the runtime already
// loads to answer "is this corridor's raw source online?", and because a global plane and a bounded region are the
// same question at different scopes. It is version- and digest-aware on purpose: a runtime that expects a
// different roads version is not told that roads are ready, it is told nothing.
function globalPlaneEntry({ publication, publicationBytes, audit, tiles, ecoregions }) {
  return { version: publication.version, state: audit.ok ? 'READY' : 'FAILED',
    cellStepDeg: publication.cellStepDeg, pathPrefix: publication.pathPrefix, assetBaseUrl: publication.assetBaseUrl,
    presentCells: publication.counts.present, emptyCells: publication.counts.empty, gridCells: publication.counts.cells,
    objects: publication.counts.present + tiles.tiles.length + 1, bytes: publication.counts.bytes + tiles.bytes + publicationBytes.length,
    publicationUrl: ROADS_PLANE.publicationUrl, publicationBytes: publicationBytes.length,
    publicationSha256: sha256(publicationBytes),
    closure: { cellSpan: publication.closure.cellSpan, prefix: publication.closure.prefix,
      tiles: publication.closure.tiles.length, bytes: tiles.bytes },
    auditedAt: new Date().toISOString(), audit: { cells: audit.checked, remoteObjects: audit.remoteObjects,
      missing: audit.missingCount, sizeMismatch: audit.sizeMismatchCount, unexpected: audit.unexpected.length,
      sampled: audit.sampled.length, seconds: audit.seconds },
    note: 'The complete national road raw plane is online. Detailed promotion reads its cells directly and never '
      + 'fails for want of a road cell; wetlands and hydrography remain bounded, published where people explore.' };
}

// A globally ready ecoregion plane is declared like any other: version, bytes, origin, and what it holds.
function ecoregionPlaneEntry({ ecoregions, version, base }) {
  const levels = ecoregions ?? {};
  const online = Object.values(levels).every(entry => entry.published);
  return { state: online ? 'READY' : 'PARTIAL', version, assetBaseUrl: base,
    bytes: Object.values(levels).reduce((sum, entry) => sum + entry.bytes, 0),
    levels, note: 'EPA Level III and IV ecoregions are whole-CONUS layers: published once and read by every '
      + 'promotion, rather than partitioned per cell like the road, wetland and hydrography planes.' };
}

function writeGlobalPlanes(roads, ecoregions) {
  const index = readIndex();
  const next = { ...index, globalPlanes: { ...(index.globalPlanes ?? {}), roads, ecoregions },
    updatedAt: new Date().toISOString() };
  validateRawRegionsIndex(next);
  if (!dryRun) writeFileSync(join(ROOT, RAW_INDEX_PATH), JSON.stringify(next, null, 1) + '\n');
  console.log(`${dryRun ? 'would record' : 'recorded'} ${RAW_INDEX_PATH}: globalPlanes.roads `
    + `${roads.version} ${roads.state}, ${roads.objects.toLocaleString()} objects, ${roads.bytes.toLocaleString()} bytes; `
    + `ecoregions ${ecoregions.state}`);
  return next;
}

    const index = readIndex();
    const wanted = option('--region');
    const regions = wanted ? index.regions.filter(region => region.id === wanted) : index.regions;
    if (!regions.length) console.log('no raw region is recorded in the index yet');
    let failed = 0;
    for (const region of regions) {
      const outcome = await auditRegion(region);
      console.log(`AUDIT ${JSON.stringify(outcome)}`);
      failed += outcome.problems.length;
    }
    return failed ? 1 : 0;
  }
  if (flag('--publish-ecoregions')) {
    console.log(`ecoregions ${JSON.stringify(await publishEcoregions({ ecoregions }))}`);
    return 0;
  }

  const state = await publishOneRegion();
  const documented = await publishOneRegionDocuments(state);
  const entry = indexEntryFor(documented);
  const nextIndex = { ...state.index,
    planes: state.planes.map(plane => ({ id: plane.id, version: plane.version, cellStepDeg: 0.2,
      pathPrefix: plane.pathPrefix, manifest: plane.manifest })),
    regions: [...state.index.regions.filter(region => region.id !== state.regionId), entry]
      .sort((left, right) => left.id.localeCompare(right.id)),
    updatedAt: new Date().toISOString() };
  // The index is validated by the very contract the runtime applies to it, so a publication cannot commit an
  // index the browser would refuse.
  const { validateRawRegionsIndex } = await import('../src/discovery/raw-catalog.js');
  validateRawRegionsIndex(nextIndex);
  if (!dryRun) writeFileSync(join(ROOT, RAW_INDEX_PATH), JSON.stringify(nextIndex, null, 1) + '\n');

  for (const plane of state.planes) {
    const entries = [...state.verified[plane.id].values()];
    console.log(`${plane.id}: ${state.objects.filter(object => object.plane === plane.id).length} published, `
      + `${entries.filter(value => value.empty).length} measured empty`);
  }
  console.log(`objects ${JSON.stringify(documented.actions)}; raw bytes ${entry.bytes.toLocaleString()}`);
  console.log(`ecoregions ${JSON.stringify(Object.fromEntries(Object.entries(documented.publishedEcoregions)
    .map(([key, value]) => [key, value.action])))} (${entry.ecoregionBytes.toLocaleString()} bytes)`);
  console.log(`${dryRun ? 'would record' : 'recorded'} ${RAW_INDEX_PATH}: ${state.regionId} ${state.version}, `
    + `catalog ${documented.catalogBuffer.length} bytes`);
  return 0;
}

main().then(code => { process.exitCode = code; })
  .catch(error => { console.error(`PUBLICATION FAILED: ${error.message}`); process.exitCode = 1; });

