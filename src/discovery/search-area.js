export const SEARCH_AREA_KIND = 'road-discovery-search-areas';

// A radius search area declares a centre and a radius in statute miles. The bounding box is derived here
// with the same constants the offline regional builder uses, so a "25-mile radius" search is the same
// region in the data catalog and in the browser. The box is what selects cells (a cell grid can only be
// intersected by a box); the disk itself is what decides which composed corridors are inside the search
// (see src/discovery/run.js), so the interface never calls an 80 x 80 mile square a 50-mile radius.
export const METRES_PER_MILE = 1609.344;
export const METRES_PER_DEGREE_LAT = 110540;
export const METRES_PER_DEGREE_LON = 111320;

export function radiusBounds(center, radiusMiles) {
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) throw new TypeError('Radius search needs a finite centre');
  if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) throw new TypeError('Radius search needs a positive radius in miles');
  const radiusM = radiusMiles * METRES_PER_MILE;
  const lonScale = METRES_PER_DEGREE_LON * Math.cos(center[1] * Math.PI / 180);
  return [center[0] - radiusM / lonScale, center[1] - radiusM / METRES_PER_DEGREE_LAT,
    center[0] + radiusM / lonScale, center[1] + radiusM / METRES_PER_DEGREE_LAT];
}

// The box a search actually selects cells with, whatever shape it declares.
export function searchAreaBounds(area) {
  if (area?.kind !== 'radius') return area?.bbox ?? null;
  return radiusBounds(area.center, area.radiusMiles);
}

export function isRadiusSearchArea(area) {
  return area?.kind === 'radius';
}

// A search area is a declaration, not a guess: it names the bounded dataset window that discovery is
// allowed to survey. The loader fails closed when a declared area is not backed by the loaded road
// network and habitat extracts, so the interface can never offer a survey the data cannot cover.
export function validateSearchAreas(declaration, manifest) {
  if (!declaration || declaration.kind !== SEARCH_AREA_KIND) throw new TypeError('Not a discovery search-area declaration');
  if (!Number.isSafeInteger(declaration.version) || declaration.version < 1) throw new TypeError('Search-area declaration needs a version');
  if (!Array.isArray(declaration.searchAreas) || !declaration.searchAreas.length) throw new TypeError('No search area is declared');
  const datasets = new Map((manifest?.datasets ?? []).map(dataset => [dataset.id, dataset]));
  for (const area of declaration.searchAreas) {
    if (typeof area.id !== 'string' || !area.id || typeof area.name !== 'string' || !area.name) throw new TypeError('Search area needs an id and a name');
    if (area.kind != null && area.kind !== 'bbox' && area.kind !== 'radius') throw new TypeError(`Search area ${area.id} has an unknown kind`);
    const bounds = searchAreaBounds(area);
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) throw new TypeError(`Search area ${area.id} needs finite bounds`);
    if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new TypeError(`Search area ${area.id} bounds must be ordered min/max`);
    if (area.kind === 'radius' && Array.isArray(area.bbox)) {
      // A declared box for a radius search is allowed, but it must be the box this radius implies: a
      // search must not be able to claim a radius it does not select cells for.
      const derived = radiusBounds(area.center, area.radiusMiles);
      if (derived.some((value, index) => Math.abs(value - area.bbox[index]) > 1e-6)) {
        throw new TypeError(`Search area ${area.id} declares bounds that do not match its ${area.radiusMiles}-mile radius`);
      }
    }
    if (!Array.isArray(area.requires) || !area.requires.length) throw new TypeError(`Search area ${area.id} declares no required datasets`);
    if (area.catalogUrl && !/^regional\/[a-z0-9.-]+\.json$/.test(area.catalogUrl)) throw new TypeError(`Search area ${area.id} has an invalid regional catalog path`);
    // Coverage is a union, not a single file: the ecoregion layers are published per state, so a search
    // that Oregon and Washington together cover is valid even though neither layer alone contains it.
    const groups = new Map();
    for (const datasetId of area.requires) {
      const dataset = datasets.get(datasetId);
      if (!dataset) throw new TypeError(`Search area ${area.id} requires ${datasetId}, which is not in the data manifest`);
      const key = dataset.type === 'ecoregions' && Number.isInteger(dataset.level)
        ? `ecoregions-l${dataset.level}` : `dataset:${datasetId}`;
      const [minLon, minLat, maxLon, maxLat] = dataset.scope.bbox;
      const current = groups.get(key);
      groups.set(key, current ? [Math.min(current[0], minLon), Math.min(current[1], minLat),
        Math.max(current[2], maxLon), Math.max(current[3], maxLat)] : [minLon, minLat, maxLon, maxLat]);
    }
    for (const [key, bbox] of groups) {
      const inside = bounds[0] >= bbox[0] && bounds[1] >= bbox[1] && bounds[2] <= bbox[2] && bounds[3] <= bbox[3];
      if (!inside) throw new TypeError(`Search area ${area.id} extends outside ${key}: a search area must lie inside every dataset it requires`);
    }
  }
  return declaration;
}

// The declaration with its bounds resolved, which is what the run and the interface actually use.
export function resolveSearchArea(area) {
  if (!area) return area;
  return Object.freeze({ ...area, bbox: searchAreaBounds(area), radiusM: area.kind === 'radius' ? area.radiusMiles * METRES_PER_MILE : null });
}

export function searchAreaById(declaration, id) {
  const area = declaration?.searchAreas?.find(entry => entry.id === id);
  if (!area) throw new TypeError(`Unknown search area: ${id}`);
  return area;
}

export function defaultSearchArea(declaration) {
  return declaration.searchAreas[0];
}
