import { COVERAGE } from '../domain/corridor.js';
import { paddedBounds } from '../gis/habitat-result.js';

export function intersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function contains(outer, inner) {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

export function validateRegionalCatalog(catalog) {
  if (catalog?.schemaVersion !== 2 || catalog.project !== 'roadnaturalist' || !catalog.version
    || !Array.isArray(catalog.region?.bounds) || catalog.region.bounds.length !== 4
    || catalog.grid?.kind !== 'lonlat-grid' || catalog.maxAnalysisDistanceM < 1000
    || !Array.isArray(catalog.datasets) || !catalog.roadNameCells || !catalog.roadNameBounds) throw new TypeError('Invalid regional catalog');
  const region = catalog.region.bounds;
  const { origin, stepLon, stepLat } = catalog.grid;
  if (!region.every(Number.isFinite) || region[0] >= region[2] || region[1] >= region[3]
    || !Array.isArray(origin) || origin.length !== 2 || !origin.every(Number.isFinite)
    || !(stepLon > 0 && stepLat > 0)) throw new TypeError('Invalid regional grid');
  const indices = (min, max, start, step) => [Math.floor((min - start) / step + 1e-9), Math.ceil((max - start) / step - 1e-9)];
  const [x0, x1] = indices(region[0], region[2], origin[0], stepLon);
  const [y0, y1] = indices(region[1], region[3], origin[1], stepLat);
  const expected = new Map();
  for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) expected.set(`x${x}_y${y}`,
    [origin[0] + x * stepLon, origin[1] + y * stepLat, origin[0] + (x + 1) * stepLon, origin[1] + (y + 1) * stepLat]);
  if (catalog.datasets.length !== 3 || new Set(catalog.datasets.map(item => item.id)).size !== 3) throw new TypeError('Regional catalog needs roads, wetlands and hydrography');
  if (catalog.assetBaseUrl != null && !/^https:\/\/[^/]+\/$/.test(catalog.assetBaseUrl)) throw new TypeError('Invalid regional asset base URL');
  for (const dataset of catalog.datasets) {
    if (!['roads', 'wetlands', 'hydrography'].includes(dataset.id) || dataset.format !== 'GeoParquet'
      || dataset.crs !== 'EPSG:4326' || !Array.isArray(dataset.partitions)
      || !dataset.sourceDatasetId || !dataset.source?.agency) throw new TypeError(`Invalid regional dataset ${dataset.id}`);
    const ids = new Set();
    for (const part of dataset.partitions) {
      if (!part.id || ids.has(part.id) || !expected.has(part.id) || part.bounds?.length !== 4 || !part.bounds.every(Number.isFinite)
        || !['present', 'empty'].includes(part.state) || !Number.isSafeInteger(part.featureCount)) throw new TypeError(`Invalid ${dataset.id} partition`);
      if (part.bounds.some((value, index) => Math.abs(value - expected.get(part.id)[index]) > 1e-8)) throw new TypeError(`Incorrect ${dataset.id} cell bounds: ${part.id}`);
      ids.add(part.id);
      if (part.state === 'present' && !(part.url?.startsWith('regional/partitions/') && Number.isSafeInteger(part.bytes)
        && /^[a-f0-9]{64}$/.test(part.sha256) && part.featureCount > 0)) throw new TypeError(`Invalid ${dataset.id} artifact ${part.id}`);
      if (part.state === 'empty' && (part.url || part.featureCount !== 0)) throw new TypeError(`Invalid empty ${dataset.id} cell ${part.id}`);
    }
    if (ids.size !== expected.size) throw new TypeError(`${dataset.id} omits a required regional cell`);
  }
  return catalog;
}

export function selectRegionalPartitions(catalog, bounds) {
  validateRegionalCatalog(catalog);
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
    throw new TypeError('Regional search needs ordered finite bounds');
  }
  const region = catalog.region.bounds;
  const haloBounds = paddedBounds(bounds, catalog.maxAnalysisDistanceM);
  const coverage = !intersects(region, bounds) ? COVERAGE.NONE : contains(region, haloBounds) ? COVERAGE.FULL : COVERAGE.PARTIAL;
  const byId = new Map(catalog.datasets.map(dataset => [dataset.id, dataset]));
  const initialRoads = byId.get('roads').partitions.filter(part => intersects(part.bounds, bounds));
  const initialIds = new Set(initialRoads.map(part => part.id));
  const selectedNames = Object.entries(catalog.roadNameCells).filter(([key, cells]) => cells.some(id => initialIds.has(id))
    && intersects(catalog.roadNameBounds[key], bounds));
  // Road-name closure is bounded by cell adjacency. A name that repeats in unrelated places across a wide
  // window (every town has a Main St) must not pull every cell that shares the name: only cells that touch
  // the already selected ones can hold a piece of the *same* connected road group, because two features
  // closer than the composition tolerance cannot be more than one cell apart. Closing through adjacency
  // therefore loads exactly the cells that can contribute to a unit intersecting the search, and no more.
  const cellPosition = id => {
    const match = /^x(-?\d+)_y(-?\d+)$/.exec(id);
    return match ? [Number(match[1]), Number(match[2])] : null;
  };
  const touching = (first, second) => {
    const a = cellPosition(first), b = cellPosition(second);
    return Boolean(a && b && Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1);
  };
  const roadIds = new Set(initialIds);
  const closureNames = [];
  let skippedCells = 0;
  for (const [key, cells] of selectedNames) {
    const reachable = new Set();
    const stack = cells.filter(id => initialIds.has(id));
    while (stack.length) {
      const id = stack.pop();
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const other of cells) if (!reachable.has(other) && touching(id, other)) stack.push(other);
    }
    const added = [];
    for (const id of reachable) {
      if (!roadIds.has(id)) { roadIds.add(id); added.push(id); }
    }
    skippedCells += cells.length - reachable.size;
    if (added.length) closureNames.push({ key, cells: added });
  }
  const selected = {
    roads: byId.get('roads').partitions.filter(part => roadIds.has(part.id)),
    wetlands: byId.get('wetlands').partitions.filter(part => intersects(part.bounds, haloBounds)),
    hydrography: byId.get('hydrography').partitions.filter(part => intersects(part.bounds, haloBounds)),
  };
  const bytes = Object.values(selected).flat().reduce((sum, part) => sum + (part.bytes ?? 0), 0);
  // Road-name closure overfetch: cells that only exist in the selection because a selected name continues
  // into them. Reported per search so the cost of never truncating a road is visible, not assumed.
  const bytesOf = parts => parts.reduce((sum, part) => sum + (part.bytes ?? 0), 0);
  const closureAdded = byId.get('roads').partitions.filter(part => roadIds.has(part.id) && !initialIds.has(part.id));
  const closure = Object.freeze({
    baseCells: initialIds.size, addedCells: closureAdded.length,
    baseBytes: bytesOf(initialRoads), addedBytes: bytesOf(closureAdded),
    selectedNames: closureNames.length,
    // Name-cell pairs the adjacency bound left alone: cells that share a name with the search but cannot
    // hold part of the same connected road group. This is the overfetch the bound avoids.
    skippedCells,
    byAdjacency: true,
    largest: Object.freeze(closureNames.map(entry => ({ key: entry.key, cells: Object.freeze([...entry.cells]),
      bytes: bytesOf(byId.get('roads').partitions.filter(part => entry.cells.includes(part.id))) }))
      .sort((a, b) => b.bytes - a.bytes).slice(0, 8)),
  });
  return Object.freeze({ coverage, reason: coverage === COVERAGE.FULL ? null : coverage === COVERAGE.NONE
    ? 'Search is outside the published regional dataset.' : 'Search or 1 km habitat halo leaves published regional coverage.',
  bounds, haloBounds, publishedBounds: region, maxAnalysisDistanceM: catalog.maxAnalysisDistanceM,
  partitions: selected, roadNameKeys: selectedNames.map(([key]) => key), bytes, closure,
  counts: Object.fromEntries(Object.entries(selected).map(([kind, parts]) => [kind, parts.filter(part => part.state === 'present').length])),
  emptyCounts: Object.fromEntries(Object.entries(selected).map(([kind, parts]) => [kind, parts.filter(part => part.state === 'empty').length])) });
}
