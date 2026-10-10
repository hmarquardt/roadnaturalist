// The pieces a bounded national raw publication is made of, kept pure so they can be tested without a network and
// without the build volume: which local artifact each plane's cell lives in, what rectangle a set of cells
// becomes, which cells a corridor box needs, and the two documents the runtime reads (a region catalog in the
// regional partition contract, and the committed index that says which regions exist).
//
// Nothing here publishes anything, and nothing here guesses: a plane's version and every cell's byte count and
// digest come from the committed manifests, so a local artifact either matches the published identity or is
// refused.
import { existsSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

// Where each plane's finalized cells are. Roads were built before the dedicated volume existed and live in the
// repository's work directory; wetlands, hydrography and ecoregions live on the build volume. Each root is
// declared, logged and recorded in provenance - never probed, and never a silent fallback.
export const PLANES = Object.freeze([
  Object.freeze({ id: 'roads', manifest: 'data/national/road-manifest.json', extension: 'parquet',
    build: null, repositoryRoot: 'data/national-work/artifacts/roads' }),
  Object.freeze({ id: 'wetlands', manifest: 'data/national/wetland-manifest.json', extension: 'parquet',
    build: 'work/nwi/artifacts/wetlands', repositoryRoot: null }),
  Object.freeze({ id: 'hydrography', manifest: 'data/national/hydro-manifest.json', extension: 'parquet',
    build: 'work/nhd/artifacts/hydro', repositoryRoot: null }),
]);

export const ECOREGIONS = Object.freeze({ manifest: 'data/national/epa-manifest.json', build: 'cells/epa' });
export const CELL_STEP_DEG = 0.2;
export const RAW_INDEX_PATH = 'data/national/raw-regions.json';

export function paddedBounds(bounds, distanceM) {
  const centre = ((bounds[1] + bounds[3]) / 2) * Math.PI / 180;
  const latPad = (distanceM / 110000) * 1.1;
  const lonPad = (distanceM / (111320 * Math.max(Math.cos(centre), 0.2))) * 1.1;
  return [bounds[0] - lonPad, bounds[1] - latPad, bounds[2] + lonPad, bounds[3] + latPad];
}

export function cellBounds(identifier) {
  const match = /^x(-?\d+)_y(-?\d+)$/.exec(identifier ?? '');
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return [-180 + x * CELL_STEP_DEG, -90 + y * CELL_STEP_DEG,
    -180 + (x + 1) * CELL_STEP_DEG, -90 + (y + 1) * CELL_STEP_DEG];
}

export function cellsForBounds(bounds) {
  const x0 = Math.floor((bounds[0] + 180) / CELL_STEP_DEG + 1e-9);
  const x1 = Math.ceil((bounds[2] + 180) / CELL_STEP_DEG - 1e-9) - 1;
  const y0 = Math.floor((bounds[1] + 90) / CELL_STEP_DEG + 1e-9);
  const y1 = Math.ceil((bounds[3] + 90) / CELL_STEP_DEG - 1e-9) - 1;
  const cells = [];
  for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) cells.push(`x${x}_y${y}`);
  return cells;
}

// The aligned rectangle a set of cells becomes, grown by `marginCells` so that a nearby promotion finds it rather
// than needing a region of its own. A published region is a rectangle because the reader's catalog contract is a
// rectangle: every cell inside it is listed, and a cell nobody published is listed as unpublished.
export function regionRectangle(cellIds, marginCells = 0) {
  if (!Array.isArray(cellIds) || !cellIds.length) throw new TypeError('A raw region needs at least one cell');
  if (cellIds.some(id => !cellBounds(id))) throw new TypeError('A raw region cell id is not a grid cell');
  const xs = cellIds.map(id => Number(/^x(-?\d+)_y/.exec(id)[1]));
  const ys = cellIds.map(id => Number(/_y(-?\d+)$/.exec(id)[1]));
  const x0 = Math.min(...xs) - marginCells;
  const x1 = Math.max(...xs) + marginCells;
  const y0 = Math.min(...ys) - marginCells;
  const y1 = Math.max(...ys) + marginCells;
  const cells = [];
  for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) cells.push(`x${x}_y${y}`);
  return { cells, bounds: [-180 + x0 * CELL_STEP_DEG, -90 + y0 * CELL_STEP_DEG,
    -180 + (x1 + 1) * CELL_STEP_DEG, -90 + (y1 + 1) * CELL_STEP_DEG],
  grid: { kind: 'lonlat-grid', stepLon: CELL_STEP_DEG, stepLat: CELL_STEP_DEG, origin: [-180, -90], crs: 'EPSG:4326' } };
}

export function planePathPrefix(id, version) {
  const directory = { roads: 'roads', wetlands: 'wetlands', hydrography: 'hydro' }[id];
  if (!directory) throw new TypeError(`Unknown raw plane ${id}`);
  return `national/${id === 'hydrography' ? 'hydro' : id}/${version}/${directory}/`;
}

export function loadPlanes(readFile) {
  return PLANES.map(plane => {
    const document = JSON.parse(readFile(`${ROOT}/${plane.manifest}`));
    if (typeof document.version !== 'string' || !Array.isArray(document.cells)) {
      throw new TypeError(`${plane.manifest} is not a national plane manifest`);
    }
    return { ...plane, version: document.version, counts: document.counts ?? null,
      cells: new Map(document.cells.map(cell => [cell.id, cell])),
      pathPrefix: planePathPrefix(plane.id, document.version) };
  });
}

export function ecoregionArtifacts(readFile, buildRoot) {
  const document = JSON.parse(readFile(`${ROOT}/${ECOREGIONS.manifest}`));
  if (typeof document.version !== 'string' || !document.artifacts) {
    throw new TypeError(`${ECOREGIONS.manifest} is not an ecoregion manifest`);
  }
  const declared = {};
  for (const [level, entry] of Object.entries(document.artifacts)) {
    const name = entry.url.split('/').pop();
    // The published URL is the canonical key; the local file is wherever the build finalized it. Both candidates
    // are declared, and the first that exists is used - never a search, and never a guess by filename.
    const candidates = [`${buildRoot}/cells/epa/${name}`, `${buildRoot}/${entry.url}`, `${ROOT}/${entry.url}`];
    declared[`l${level}`] = { level: Number(level), url: entry.url, bytes: entry.bytes, sha256: entry.sha256,
      version: document.version, source: entry.source ?? null, candidates,
      local: candidates.find(path => existsSync(path)) ?? candidates[0] };
  }
  return declared;
}

// The local artifact a plane's cell was finalized into. Each declared root is tried in order and the one that
// answered is returned, so provenance says which root a publication read rather than leaving it to be assumed.
export function localCellPath(plane, cell, buildRoot) {
  const candidates = [plane.build ? `${buildRoot}/${plane.build}` : null,
    plane.repositoryRoot ? `${ROOT}/${plane.repositoryRoot}` : null].filter(Boolean);
  for (const root of candidates) {
    const path = `${root}/${cell.id}.${plane.extension}`;
    if (existsSync(path)) return { path, root };
  }
  return null;
}

export function objectKeyFor(plane, cell) {
  return `${plane.pathPrefix}${cell.id}.${plane.extension}`;
}

// The region catalog: the document the raw reader loads, in the same contract as the regional pilot's catalog,
// because it *is* that contract - three datasets of grid cells on an immutable base URL, read by the same code.
// Every cell of the region's rectangle is listed. A cell this publication put online is `present`, a cell the
// plane measured as empty is `empty`, and everything else in the rectangle is `unpublished` - which the reader
// refuses rather than treating as a zero or as a missing file.
export function regionCatalog({ regionId, version, rectangle, planes, published, components, ecoregions, assetBaseUrl,
  publishedAt, provenance }) {
  const datasets = planes.map(plane => ({
    id: plane.id, version: plane.version, format: 'GeoParquet', schemaVersion: 1, crs: 'EPSG:4326',
    sourceDatasetId: `national-${plane.id}-${plane.version}`,
    source: { agency: plane.counts?.source?.agency ?? 'U.S. Government', dataset: plane.counts?.source?.dataset ?? plane.manifest,
      vintage: plane.version, publicationDate: publishedAt },
    partitions: rectangle.cells.map(id => {
      const manifest = plane.cells.get(id);
      const entry = published[plane.id]?.get(id);
      if (entry) {
        return { id, bounds: cellBounds(id), featureCount: entry.featureCount ?? manifest?.featureCount ?? 0,
          state: 'present', url: objectKeyFor(plane, { id }), bytes: entry.bytes, sha256: entry.sha256 };
      }
      if (manifest?.state === 'empty') {
        return { id, bounds: cellBounds(id), featureCount: 0, state: 'empty' };
      }
      return { id, bounds: cellBounds(id), featureCount: 0, state: 'unpublished' };
    }),
  }));
  const document = {
    schemaVersion: 2, project: 'roadnaturalist', version, kind: 'road-raw-region',
    region: { id: regionId, name: provenance.label ?? regionId, bounds: rectangle.bounds,
      sourceCoverage: provenance.sourceCoverage },
    grid: rectangle.grid, maxAnalysisDistanceM: 1000, assetBaseUrl,
    publication: { kind: 'raw-regions', regionId, publishedAt,
      pathPrefixes: [...planes.map(plane => plane.pathPrefix), `raw/${regionId}/${version}/`],
      ecoregions: ecoregions ?? null,
      note: 'A bounded region of the national raw planes, published for detailed corridor analysis. Every cell '
        + 'of this rectangle is listed: present (published), empty (measured zero) or unpublished (not online).' },
    datasets,
  };
  if (components) {
    document.roadComponentsUrl = `raw/${regionId}/${version}/road-components.json`;
    document.roadComponentsBytes = components.bytes;
    document.roadComponentsSha256 = components.sha256;
  }
  return document;
}

// One region's entry in the committed index the runtime reads: what a browser needs to decide, before fetching
// anything, whether a corridor's raw source is online. The counts separate published, measured-empty and
// not-published cells, because a region's rectangle is a reuse boundary rather than a promise that every cell in
// it exists.
export function indexEntry({ regionId, version, rectangle, planes, verified, ecoregions, bytes, objects, roots, label }) {
  const cells = {};
  const publishedCellIds = {};
  for (const plane of planes) {
    let published = 0;
    let empty = 0;
    publishedCellIds[plane.id] = [...(verified[plane.id] ?? new Map()).entries()]
      .filter(([, entry]) => !entry.empty).map(([id]) => id).sort();
    for (const id of rectangle.cells) {
      const entry = verified[plane.id]?.get(id);
      if (entry && !entry.empty) published += 1;
      else if (entry?.empty || plane.cells?.get(id)?.state === 'empty') empty += 1;
    }
    cells[plane.id] = { published, empty, unpublished: rectangle.cells.length - published - empty,
      version: plane.version, pathPrefix: plane.pathPrefix };
  }
  return { id: regionId, version, bounds: rectangle.bounds, label: label ?? null,
    publishedAt: new Date().toISOString(), cellStepDeg: CELL_STEP_DEG, cells, publishedCellIds,
    catalogUrl: `raw/${regionId}/${version}/manifest.json`,
    componentsUrl: `raw/${regionId}/${version}/road-components.json`,
    objects, bytes, regionCells: rectangle.cells.length,
    ecoregionBytes: ecoregions ? Object.values(ecoregions).reduce((sum, entry) => sum + entry.bytes, 0) : 0,
    sourceRoots: roots,
    note: 'A bounded region of the national raw planes, published for detailed corridor analysis only. Discovery '
      + 'reads the derived plane and never these objects.' };
}

