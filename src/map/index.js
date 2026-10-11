import { createCorridorMap } from './corridor-map.js';
import { createGeoView } from './geo-view.js';

// WHICH MAP THE APPLICATION GETS.
//
// The geographic view is the product surface; the original schematic SVG map is kept behind this switch until the
// geographic view has passed its interaction tests, so retiring it is a deliberate step rather than a rewrite that
// lands before its replacement is proven. `globalThis.__RN_SCHEMATIC_MAP` exists only for that comparison and for
// diagnosing a map problem in production without a deploy.
export function createMapView(container, options = {}) {
  return globalThis.__RN_SCHEMATIC_MAP ? createCorridorMap(container, options) : createGeoView(container, options);
}
