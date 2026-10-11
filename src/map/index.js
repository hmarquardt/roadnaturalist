import { createCorridorMap } from './corridor-map.js';
import { createGeoView } from './geo-view.js';

// WHICH MAP THE APPLICATION GETS.
//
// The geographic view is the product surface; the original schematic SVG map is kept behind this switch until the
// geographic view has passed its interaction tests, so retiring it is a deliberate step rather than a rewrite that
// lands before its replacement is proven. `globalThis.__RN_SCHEMATIC_MAP` exists only for that comparison and for
// diagnosing a map problem in production without a deploy.
export function createMapView(container, options = {}) {
  const view = globalThis.__RN_SCHEMATIC_MAP
    ? createCorridorMap(container, options) : createGeoView(container, options);
  // One interface, two implementations. The schematic map named two methods differently, so the application only
  // ever sees the deliberate geographic API and the switch cannot leak a naming difference into a crash.
  const aliases = { setSearch: 'setSearchPreview', fitResults: 'fit', fitSelected: 'fit' };
  for (const [name, alternative] of Object.entries(aliases)) {
    if (typeof view[name] !== 'function' && typeof view[alternative] === 'function') view[name] = view[alternative];
  }
  return view;
}
