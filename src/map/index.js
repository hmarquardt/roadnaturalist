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
  // One interface, two implementations. The schematic map named two methods differently, and neither implementation
  // offers every method of the documented API - so the difference is absorbed here rather than allowed to reach the
  // application, where a missing method would be a boot failure. Anything genuinely absent becomes a no-op that
  // reports "not available", which is what a caller can act on anyway.
  const aliases = { setSearch: ['setSearchPreview'], setSearchPreview: ['setSearch'], fitResults: ['fit'],
    fitSelected: ['fit'] };
  const missing = [];
  for (const [name, alternatives] of Object.entries(aliases)) {
    if (typeof view[name] === 'function') continue;
    const alternative = alternatives.find(candidate => typeof view[candidate] === 'function');
    if (alternative) view[name] = view[alternative]; else missing.push(name);
  }
  const API = ['draw', 'setSearch', 'setSelected', 'setSavedRoads', 'setOuting', 'setPickMode', 'setBasemap',
    'fitResults', 'fitSelected', 'destroy'];
  for (const name of API) {
    if (typeof view[name] === 'function') continue;
    missing.push(name);
    view[name] = () => false;
  }
  view.missingMethods = Object.freeze([...new Set(missing)]);
  return view;
}
