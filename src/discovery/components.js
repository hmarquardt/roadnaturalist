import { intersects } from './regional-catalog.js';

// The published road connected-component index.
//
// The browser composes one discovery unit per named road *in one place*: source features are deduplicated,
// joined by endpoint proximity (150 m) and split into connected components, so two unrelated roads that
// share a name never become one candidate. Selecting cells by name alone could not express that, and pulling
// every cell that shares a common name (3rd St, NE 5th Ave) was the measured overfetch: a 10-mile search
// selected 58 road cells where 6 were needed. This index is keyed by the component, so closure adds only the
// cells that can hold a piece of a component that touches the search.
//
// The index is built by scripts/build-regional.py from the same composition rules (scripts/road_components.py
// mirrors src/discovery/units.js; tests/road-components.test.js cross-checks the mirror against the real
// modules on real source features).
export const ROAD_COMPONENT_KIND = 'road-components';

export function validateRoadComponents(document) {
  if (document?.kind !== ROAD_COMPONENT_KIND || document.schemaVersion !== 1 || !document.version
    || !Array.isArray(document.components)) throw new TypeError('Invalid road component index');
  for (const component of document.components) {
    if (typeof component.id !== 'string' || !/^drv1-[a-z0-9-]+$/.test(component.id)
      || typeof component.nameKey !== 'string' || !component.nameKey
      || !Array.isArray(component.cells) || component.cells.length < 2
      || !Array.isArray(component.bounds) || component.bounds.length !== 4
      || !component.bounds.every(Number.isFinite) || !component.cells.every(cell => typeof cell === 'string')) {
      throw new TypeError(`Invalid road component entry ${component?.id ?? 'unknown'}`);
    }
  }
  return document;
}

// Cells a component contributes, or null when the component cannot have a piece inside the search.
export function componentCellsForSearch(component, initialIds, bounds) {
  if (!intersects(component.bounds, bounds)) return null;
  if (!component.cells.some(id => initialIds.has(id))) return null;
  return component.cells;
}

// The closure measurement the interface and the benchmark report: which cells exist in the selection only
// because a road component continues into them.
export function componentClosureComponents(document, initialIds, bounds) {
  const added = [];
  for (const component of document?.components ?? []) {
    const cells = componentCellsForSearch(component, initialIds, bounds);
    if (!cells) continue;
    const extra = cells.filter(id => !initialIds.has(id));
    if (extra.length) added.push({ key: component.nameKey, id: component.id, cells: extra, lengthM: component.lengthM ?? null });
  }
  return added;
}
