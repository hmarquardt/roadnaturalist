// THE BASEMAP, DECLARED ONCE.
//
// A raster tile provider is a *citation as well as a service*: the imagery is somebody else's, the attribution is
// mandatory, and the choice may change. So it lives here, as data, and the map adapter reads it - the tile URL is
// never scattered through the application.
//
// Failure is expected and harmless. Tiles are decoration over measured geometry: if the provider is unreachable,
// blocked or rate-limited, corridors, the candidate list, the search radius, selection, ranking and the analysis all
// keep working over a blank background, and the adapter says so in one modest note. Basemap trouble is a
// visualization problem and never a discovery failure.
export const TILE_PROVIDERS = Object.freeze({
  osm: Object.freeze({
    id: 'osm',
    label: 'OpenStreetMap',
    urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    // The provider's published tile usage policy asks for an identifying application and no bulk downloading; the
    // application requests only the tiles a person actually looks at, and never prefetches.
    note: 'Tiles are requested only for the area on screen, one viewport at a time.',
  }),
});

export const DEFAULT_TILE_PROVIDER = 'osm';

export function tileProvider(id = DEFAULT_TILE_PROVIDER) {
  const provider = TILE_PROVIDERS[id] ?? null;
  if (!provider) throw new TypeError(`Unknown tile provider: ${String(id)}`);
  // Both fields are load-bearing: a provider without a template draws nothing, and one without attribution cannot
  // legally be used, so an incomplete declaration is refused rather than silently degraded.
  if (typeof provider.urlTemplate !== 'string' || !provider.urlTemplate.includes('{z}')) {
    throw new TypeError(`The ${id} tile provider declares no usable url template`);
  }
  if (typeof provider.attribution !== 'string' || !provider.attribution.trim()) {
    throw new TypeError(`The ${id} tile provider declares no attribution`);
  }
  return provider;
}
