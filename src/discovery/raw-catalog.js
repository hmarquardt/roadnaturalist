import { intersects } from './regional-catalog.js';

// THE RAW REGION INDEX.
//
// Discovery runs on the derived plane and always will: it is small, it is published everywhere, and nothing
// about it depends on what follows. Deep inspection is different. A promoted corridor is rebuilt from the *raw*
// road, wetland and hydrography cells it actually occupies - the same 0.2 degree cells the national planes were
// partitioned into, read through the same regional partition reader, with the same promotion verification - and
// those cells are published only where someone has asked to go deeper. The full raw lake is about 188 GB, of
// which wetlands alone are 156 GB, so publishing it wholesale to answer a question about one road is the wrong
// trade. Measured, a promotion reads a median of five objects and about 17 MB.
//
// This index is the authoritative answer to "which raw cells are online?". It is small, it is committed with the
// application, and it is loaded once: nothing here discovers availability by probing object URLs one at a time.
// A region is a rectangle of the raw grid published together, and each region's own catalog is an immutable,
// region-shaped document on R2 - the document contract the regional reader already validates - so a promotion
// needs no second reader, no second analysis engine and no second spatial scheme.
export const RAW_REGIONS_KIND = 'road-discovery-raw-regions';
export const RAW_REGIONS_SCHEMA_VERSION = 1;
// The raw grid is the national planes' own grid: 0.2 degree cells from (-180, -90).
export const RAW_CELL_STEP_DEG = 0.2;

export function validateRawRegionsIndex(document) {
  if (document?.kind !== RAW_REGIONS_KIND || document.schemaVersion !== RAW_REGIONS_SCHEMA_VERSION) {
    throw new TypeError('Not a raw region index');
  }
  if (!Array.isArray(document.planes) || !document.planes.length) throw new TypeError('The raw region index declares no planes');
  for (const plane of document.planes) {
    if (typeof plane?.id !== 'string' || typeof plane.version !== 'string' || !plane.version
      || plane.cellStepDeg !== RAW_CELL_STEP_DEG || !/^[a-z0-9/._-]+$/.test(plane.pathPrefix ?? '')) {
      throw new TypeError(`Invalid raw plane ${plane?.id ?? 'unknown'}`);
    }
  }
  if (!Array.isArray(document.regions)) throw new TypeError('The raw region index declares no regions');
  const ids = new Set();
  for (const region of document.regions) {
    for (const field of ['id', 'version', 'catalogUrl', 'catalogSha256', 'publishedAt']) {
      if (typeof region?.[field] !== 'string' || !region[field]) throw new TypeError(`Invalid raw region ${region?.id ?? 'unknown'}`);
    }
    if (ids.has(region.id)) throw new TypeError(`Duplicate raw region ${region.id}`);
    ids.add(region.id);
    if (!/^raw\/[a-z0-9._-]+\/[a-z0-9._-]+\/manifest\.json$/.test(region.catalogUrl)) {
      throw new TypeError(`Invalid raw region catalog path ${region.catalogUrl}`);
    }
    if (!/^[a-f0-9]{64}$/.test(region.catalogSha256) || !Number.isSafeInteger(region.catalogBytes)) {
      throw new TypeError(`Invalid raw region catalog digest for ${region.id}`);
    }
    // The origin the region's catalog and cells are served from. A raw catalog is a data-origin document, not an
    // application asset, so the index names where it lives rather than the reader assuming the page's own origin.
    if (!/^https:\/\/[^/]+\/$/.test(region.assetBaseUrl ?? '')) {
      throw new TypeError(`The raw region ${region.id} does not name the origin its catalog is served from`);
    }
    if (!Array.isArray(region.bounds) || region.bounds.length !== 4 || !region.bounds.every(Number.isFinite)
      || region.bounds[0] >= region.bounds[2] || region.bounds[1] >= region.bounds[3]) {
      throw new TypeError(`Invalid raw region bounds for ${region.id}`);
    }
    if (!region.cells || document.planes.some(plane => !Number.isSafeInteger(region.cells[plane.id]?.published))) {
      throw new TypeError(`The raw region ${region.id} does not report its published cells`);
    }
    // The published cell ids are what makes availability answerable from the index alone, before any catalog or
    // object is fetched: a required cell is available exactly when some region lists it. They are ids, not
    // geometry, because the reader derives a cell's bounds from the grid.
    if (!region.publishedCellIds || document.planes.some(plane => !Array.isArray(region.publishedCellIds[plane.id])
      || region.publishedCellIds[plane.id].some(id => !/^x-?\d+_y-?\d+$/.test(id)))) {
      throw new TypeError(`The raw region ${region.id} does not list its published cells`);
    }
  }
  return document;
}

// The region whose published cells cover the most of what a corridor needs, or null. Availability is decided from
// the index alone - the cells each region lists - so the answer costs one small committed document and no probe.
// Regions may overlap: a corridor is served by whichever one actually holds its cells, and the choice is
// deterministic (most cells provided, then the region's own order) rather than a matter of which was published
// last.
export function regionForBounds(index, bounds) {
  validateRawRegionsIndex(index);
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return null;
  return index.regions.find(region => rawRegionContains(region, bounds)) ?? null;
}

export function rawRegionContains(region, bounds) {
  return Boolean(region) && region.bounds[0] <= bounds[0] && region.bounds[1] <= bounds[1]
    && region.bounds[2] >= bounds[2] && region.bounds[3] >= bounds[3];
}

// Which cells a corridor needs from each plane, as the grid itself defines them: pure arithmetic, no fetch, and
// the same identities the planes were partitioned by. `roads` includes one cell of margin, because a road
// component that continues just outside the corridor box is part of the same named road.
export function cellsForBounds(plane, bounds) {
  const step = plane.cellStepDeg;
  const x0 = Math.floor((bounds[0] + 180) / step + 1e-9);
  const x1 = Math.ceil((bounds[2] + 180) / step - 1e-9) - 1;
  const y0 = Math.floor((bounds[1] + 90) / step + 1e-9);
  const y1 = Math.ceil((bounds[3] + 90) / step - 1e-9) - 1;
  const cells = [];
  for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) cells.push(`x${x}_y${y}`);
  return cells;
}

export function rawCellBounds(identifier) {
  const match = /^x(-?\d+)_y(-?\d+)$/.exec(identifier ?? '');
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return [-180 + x * RAW_CELL_STEP_DEG, -90 + y * RAW_CELL_STEP_DEG,
    -180 + (x + 1) * RAW_CELL_STEP_DEG, -90 + (y + 1) * RAW_CELL_STEP_DEG];
}

// What a promotion of this corridor would need, and which published region covers it. Availability is answered
// from the index alone, before a catalog or an object is fetched, so a refusal costs nothing and is never a
// half-downloaded analysis.
//
// The required cells are the ones the index can *know* about: the corridor box for roads, and the box padded by
// the 1 km analysis distance for the habitat planes, exactly as the reader pads it. A road component that
// continues outside the box is deliberately not guessed at here - the region's own component index answers that
// exactly, one small document later, and refuses with the cells rather than this check inventing a margin that
// would refuse a promotion whose road is in fact published.
export function rawAvailability(index, { bounds, planes = null, required = null } = {}) {
  const wanted = required ?? Object.fromEntries(index.planes
    .filter(plane => !planes || planes.includes(plane.id))
    .map(plane => [plane.id, plane.id === 'roads'
      ? cellsForBounds(plane, bounds)
      : cellsForBounds(plane, analysisPaddingDeg(bounds))]));
  let best = null;
  for (const region of index.regions) {
    const missing = {};
    let provided = 0;
    let missingTotal = 0;
    for (const [plane, cells] of Object.entries(wanted)) {
      const listed = new Set(region.publishedCellIds?.[plane] ?? []);
      const absent = cells.filter(id => !listed.has(id));
      if (absent.length) { missing[plane] = absent; missingTotal += absent.length; }
      provided += cells.length - absent.length;
    }
    const candidate = { region, required: wanted, missing, missingTotal, provided, available: missingTotal === 0,
      reason: missingTotal === 0 ? null : 'cells' };
    if (candidate.available) return Object.freeze(candidate);
    if (!best || candidate.provided > best.provided) best = candidate;
  }
  return Object.freeze(best ?? { region: null, required: wanted, missing: null, missingTotal: null,
    provided: 0, available: false, reason: 'region' });
}

// The reader's own padding rule (src/gis/habitat-result.js), mirrored here because a required-cell check that
// disagreed with the selection it predicts would be worse than no check at all.
export function analysisPaddingDeg(bounds, distanceM = 1000) {
  const centre = ((bounds[1] + bounds[3]) / 2) * Math.PI / 180;
  const latPad = (distanceM / 110000) * 1.1;
  const lonPad = (distanceM / (111320 * Math.max(Math.cos(centre), 0.2))) * 1.1;
  return [bounds[0] - lonPad, bounds[1] - latPad, bounds[2] + lonPad, bounds[3] + latPad];
}

// The sentence a person reads when the raw source is not there yet. It says what is missing, how much of it, and
// that discovery itself is unaffected - and it never pretends the corridor was measured.
export function rawAvailabilityMessage(availability, { detail = false } = {}) {
  if (availability?.available) return null;
  if (!availability?.region) {
    return 'Detailed analysis is not yet available for this corridor: its raw road, wetland and hydrography '
      + 'cells have not been published. National discovery is unaffected.';
  }
  const planes = Object.entries(availability.missing ?? {}).filter(([, cells]) => cells.length);
  const cells = planes.flatMap(([, ids]) => ids);
  const message = `Detailed analysis is not yet available for this corridor because ${cells.length} raw source `
    + `cell${cells.length === 1 ? '' : 's'} (${planes.map(([plane, ids]) => `${plane}: ${ids.length}`).join(', ')}) `
    + 'have not been published. National discovery is unaffected.';
  return detail ? `${message} Missing: ${cells.join(', ')}.` : message;
}

export { intersects };

