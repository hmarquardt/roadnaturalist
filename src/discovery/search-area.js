export const SEARCH_AREA_KIND = 'road-discovery-search-areas';

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
    if (!Array.isArray(area.bbox) || area.bbox.length !== 4 || !area.bbox.every(Number.isFinite)) throw new TypeError(`Search area ${area.id} needs finite bounds`);
    if (area.bbox[0] >= area.bbox[2] || area.bbox[1] >= area.bbox[3]) throw new TypeError(`Search area ${area.id} bounds must be ordered min/max`);
    if (!Array.isArray(area.requires) || !area.requires.length) throw new TypeError(`Search area ${area.id} declares no required datasets`);
    for (const datasetId of area.requires) {
      const dataset = datasets.get(datasetId);
      if (!dataset) throw new TypeError(`Search area ${area.id} requires ${datasetId}, which is not in the data manifest`);
      const [minLon, minLat, maxLon, maxLat] = dataset.scope.bbox;
      const inside = area.bbox[0] >= minLon && area.bbox[1] >= minLat && area.bbox[2] <= maxLon && area.bbox[3] <= maxLat;
      if (!inside) throw new TypeError(`Search area ${area.id} extends outside ${datasetId}: a search area must lie inside every dataset it requires`);
    }
  }
  return declaration;
}

export function searchAreaById(declaration, id) {
  const area = declaration?.searchAreas?.find(entry => entry.id === id);
  if (!area) throw new TypeError(`Unknown search area: ${id}`);
  return area;
}

export function defaultSearchArea(declaration) {
  return declaration.searchAreas[0];
}
