// Whole-plane publication for the national roads raw plane, and the two documents that make it usable nationally.
//
// Roads are the one raw plane whose *complete* publication is cheap: 5.82 GB for 21,135 cells, about 2% of the
// 188.9 GB lake, and a promotion reads a median of 1.8 MB of it. Publishing all of it removes the one refusal
// class the bounded model could not avoid - a corridor whose named road component spans more cells than a bounded
// publication closed over - and it leaves wetlands (156.4 GB) and hydrography (26.6 GB) as the only planes that
// are published where people actually go.
//
// Two documents travel with it, and both are immutable and digest-pinned by the committed index:
//
//   national/roads/<version>/publication.json   every cell's bytes and digest, the typed-empty cells, and a
//                                               directory of the closure tiles (about 5 MB, fetched once per
//                                               promotion, never during discovery)
//   national/roads/<version>/components/<tile>.json   the component closure for one 1 degree tile: which cells
//                                               each named road component occupies, so a corridor can be rebuilt
//                                               over the whole road it belongs to
//
// The closure is *logic*, not publication bookkeeping: a corridor id was composed over the whole national road
// network, so rebuilding it needs every cell its component occupies. What changes here is only where that
// relationship comes from - a global, always-available tile rather than a bounded region's own document.
import { existsSync, readFileSync } from 'node:fs';

export const ROADS_PLANE = Object.freeze({
  id: 'roads', manifest: 'data/national/road-manifest.json', version: 'tiger2025-county-v1',
  pathPrefix: 'national/roads/tiger2025-county-v1/roads/',
  publicationUrl: 'national/roads/tiger2025-county-v1/publication.json',
  componentsPrefix: 'national/roads/tiger2025-county-v1/components/',
  cellStepDeg: 0.2,
  repositoryRoot: 'data/national-work/artifacts/roads',
});

// 1 degree of tiles: small enough that a promotion fetches tens of kilobytes of closure, large enough that the
// directory stays a few hundred objects rather than thousands.
export const TILE_CELLS = 5;

export function tileKey(cellId) {
  const match = /^x(-?\d+)_y(-?\d+)$/.exec(cellId ?? '');
  if (!match) throw new TypeError(`Not a grid cell: ${String(cellId)}`);
  return `${Math.floor(Number(match[1]) / TILE_CELLS)}_${Math.floor(Number(match[2]) / TILE_CELLS)}`;
}

export function tileKeyForBounds(bounds) {
  const lon = Math.min(Math.max((bounds[0] + bounds[2]) / 2, -179.999), 179.999);
  const lat = Math.min(Math.max((bounds[1] + bounds[3]) / 2, -89.999), 89.999);
  const x = Math.floor((lon + 180) / ROADS_PLANE.cellStepDeg);
  const y = Math.floor((lat + 90) / ROADS_PLANE.cellStepDeg);
  return `${Math.floor(x / TILE_CELLS)}_${Math.floor(y / TILE_CELLS)}`;
}

// The authoritative publication set: every cell the manifest declares present, with the identity the manifest
// itself gives it. A directory walk is not the set - it can hold sidecars, logs and leftovers, and it cannot know
// which cells are typed empty.
export function roadsPublicationSet({ readFile }) {
  const manifest = JSON.parse(readFile(ROADS_PLANE.manifest));
  if (manifest.version !== ROADS_PLANE.version || manifest.kind !== 'national-roads') {
    throw new TypeError(`${ROADS_PLANE.manifest} is not the ${ROADS_PLANE.version} roads plane`);
  }
  const cells = manifest.cells.filter(cell => cell.state === 'present');
  const empty = manifest.cells.filter(cell => cell.state === 'empty');
  if (cells.length !== manifest.counts.present || empty.length !== manifest.counts.empty) {
    throw new Error(`the roads manifest disagrees with its own counts: ${cells.length} present, ${empty.length} empty`);
  }
  for (const cell of cells) {
    if (!Number.isSafeInteger(cell.bytes) || !/^[a-f0-9]{64}$/.test(cell.sha256) || !Number.isSafeInteger(cell.featureCount)
      || !cell.url.startsWith(ROADS_PLANE.pathPrefix) || !Array.isArray(cell.bounds) || cell.bounds.length !== 4) {
      throw new Error(`roads cell ${cell.id} does not carry the metadata a publication needs`);
    }
  }
  return Object.freeze({ manifest, cells, empty, bytes: cells.reduce((sum, cell) => sum + cell.bytes, 0),
    grid: manifest.partitionScheme, schema: manifest.schema });
}

// The closure tiles: which multi-cell components touch each 1 degree tile, with the *complete* cell list of each
// component. Complete, not clipped to the tile - that is what lets the reader fetch the rest of the road.
export function closureTiles(readClosureLine) {
  const tiles = new Map();
  let components = 0;
  for (const line of readClosureLine) {
    if (!line.trim()) continue;
    const component = JSON.parse(line);
    components += 1;
    const keys = new Set(component.cells.map(tileKey));
    for (const key of keys) {
      if (!tiles.has(key)) tiles.set(key, []);
      tiles.get(key).push(component);
    }
  }
  return { tiles, components };
}

export function tileDocument(key, components) {
  const cells = [...new Set(components.flatMap(component => component.cells))].sort();
  return { kind: 'road-components', schemaVersion: 1, version: `tile-${key}`,
    tile: { key, cells }, counts: { components: components.length },
    components: components.map(component => ({ id: component.id, nameKey: component.nameKey,
      cells: component.cells, bounds: component.bounds })) };
}

export function exists(path) {
  return existsSync(path);
}

export function readText(path) {
  return readFileSync(path, 'utf8');
}
