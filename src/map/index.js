import { createGeoView } from './geo-view.js';

// ONE MAP ARCHITECTURE.
//
// The geographic Leaflet view is the product surface, and it is the only one: there is no second renderer behind a
// switch and nothing to fall back to. If Leaflet cannot initialise, the view reports itself unavailable and draws
// nothing - a map that cannot be drawn is said so, not replaced by a different kind of picture.
export function createMapView(container, options = {}) {
  const view = createGeoView(container, options);
  // The geoview offers every method of the documented API; a method that ever goes missing becomes a no-op that
  // reports "not available" rather than a boot failure in the application. The record of what was missing stays on the
  // view itself for a developer reading it, and is not part of the diagnostic surface below.
  const API = ['draw', 'setSearch', 'setSelected', 'setSavedRoads', 'setOuting', 'setPickMode', 'setBasemap',
    'fitResults', 'fitSelected', 'destroy'];
  const missing = [];
  for (const name of API) {
    if (typeof view[name] === 'function') continue;
    missing.push(name);
    view[name] = () => false;
  }
  view.missingMethods = Object.freeze([...new Set(missing)]);
  // THE SMALLEST READ-ONLY SURFACE THE COMMITTED GATE NEEDS: which view is running, whether it is available, where the
  // camera is, what search geometry is drawn, and how many fits and movements it has made. The application never reads
  // this, so it cannot become a second source of truth, and it grows only when a committed test needs it.
  globalThis.__RN_MAP = Object.freeze({
    implementation: view.available === false ? 'unavailable' : 'geo',
    available: view.available !== false,
    camera: () => view.camera?.() ?? null,
    searchGeometry: () => view.searchGeometry?.() ?? { center: null, radiusM: null },
    fitCount: () => view.fitCount?.() ?? 0,
    movements: () => view.movementCount?.() ?? 0,
    note: 'Diagnostic surface for the map interaction gate. Read-only; the application never consults it.',
  });
  return view;
}
