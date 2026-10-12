import { corridorGeometry } from '../domain/geometry.js';

// WHICH CORRIDOR THE HABITAT ACTION IS ABOUT, AND WHAT TO SAY ABOUT THE ANALYSIS.
//
// The map draws two kinds of corridor: a promoted candidate, and a discovery result - the rows a search produced. The
// habitat action has to work for whichever one the person is looking at, so the selection is normalized here into the one
// thing the habitat pipeline needs: a real corridor geometry, and the regional catalogue when the descriptor carries one.
// Nothing is invented. A geometry that cannot be read is not a corridor, and a selection without one is no selection.
export function habitatSelection({ candidate = null, discoveryResult = null } = {}) {
  const source = candidate ?? discoveryResult ?? null;
  if (!source) return null;
  try {
    const corridor = corridorGeometry(source.geometry ?? source.corridor?.geometry ?? null);
    return Object.freeze({ id: source.id ?? null, name: source.name ?? null,
      geometry: corridor.geometry, bounds: corridor.bounds, lengthM: corridor.lengthM,
      catalogUrl: source.dataCatalogUrl ?? null, promoted: Boolean(candidate) });
  } catch {
    return null;
  }
}

// WHAT TO SAY ABOUT THE ANALYSIS, FROM THE ANALYSIS. The note describes the result's own diagnostic status, so the panel
// cannot claim a layer that is not on the map, and cannot report an unavailable analysis as an empty one:
//
//   ready          the analysis ran and its sources were there
//   ready, no hits the analysis ran and found nothing - which is a measurement, not an absence of one
//   partial        it ran against some of the sources it needs, and says which are missing
//   unavailable    it could not run here, and says why
export function habitatNote(overlay) {
  if (!overlay) {
    return 'Habitat analysis is unavailable: no corridor with usable geometry is selected.';
  }
  const status = overlay.diagnostics?.status ?? 'unavailable';
  const reason = overlay.diagnostics?.reason ?? null;
  const features = (overlay.features ?? []).length;
  if (status === 'ready') {
    return features > 0
      ? `Habitat analysis loaded for this corridor: ${features} mapped source feature(s) within the analysis area.`
      : 'Habitat analysis completed; no mapped wetland or hydrography features were found within the analysis area.';
  }
  if (status === 'partial') {
    return `Habitat analysis is partial because ${reason ?? 'some required source coverage is unavailable'}. `
      + `${features} mapped source feature(s) were found in the coverage that is published.`;
  }
  return `Habitat analysis is unavailable here because ${reason ?? 'the required raw wetland and hydrography coverage is not published for this area'}.`;
}
