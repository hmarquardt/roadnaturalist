import { contextLabel } from '../discovery/ranking.js';
import { tileProvider } from './basemap.js';


// THE GEOGRAPHIC PLANNING MAP, BEHIND ONE NARROW INTERFACE.
//
// This module owns Leaflet. Nothing outside it touches a Leaflet object: the application hands over *descriptors*
// (corridors with a GeoJSON geometry, a selection id, saved ids, a search definition) and receives callbacks
// (`onSelect`, `onPickCoordinate`). Leaflet objects never enter application state, and the map never reads
// `localStorage` or fetches anything of its own: the geometry it draws is the geometry discovery already holds, so
// ordinary map use costs zero raw reads of any published plane.
//
// Two rules the previous schematic map got wrong and this one is built around:
//
//   * THE VIEWPORT BELONGS TO THE PERSON. Drawing never fits. Fitting happens only on an explicit request -
//     `fitResults()` when a completely new search finishes, `fitResults()`/`fitSelected()` from the buttons, or
//     `fitSelected()` for a corridor a person asked to centre. Selecting, sorting, filtering, toggling a favourite
//     or finishing a source-evidence step must never move the map.
//   * ONE SELECTION STATE. The map highlights what the application says is selected and reports clicks back; it
//     keeps no selection of its own, so the list and the map cannot disagree.
const LINE_STYLE = Object.freeze({
  // State is carried by weight, opacity, dash pattern and draw order - never by colour alone, so the map stays
  // readable over pale and busy basemap alike, and remains legible to someone who cannot separate the hues.
  normal: Object.freeze({ color: '#1d4ed8', weight: 2, opacity: 0.65 }),
  selected: Object.freeze({ color: '#b45309', weight: 6, opacity: 1 }),
  saved: Object.freeze({ color: '#047857', weight: 4, opacity: 0.95, dashArray: '8 5' }),
  dismissed: Object.freeze({ color: '#6b7280', weight: 1.5, opacity: 0.35, dashArray: '2 6' }),
  selectedSaved: Object.freeze({ color: '#b45309', weight: 6, opacity: 1, dashArray: '8 5' }),
});

// Identifying attributes for the shapes that carry meaning: applied when the element exists, skipped in a
// non-browser test double. Nothing in the application depends on them; a click target and an automated check do.
function mark(path, attributes) {
  const element = path?.getElement?.() ?? null;
  if (!element?.setAttribute) return false;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name.startsWith('data-') ? name : `data-${name}`, String(value));
  }
  return true;
}

// A geometry is drawn only if it is a usable line: anything else is skipped and counted, because one malformed row
// must never take the whole map down.
export function toLatLngs(geometry) {
  const lines = geometry?.type === 'LineString' ? [geometry.coordinates]
    : geometry?.type === 'MultiLineString' ? geometry.coordinates : null;
  if (!Array.isArray(lines) || !lines.length) return null;
  const converted = [];
  for (const line of lines) {
    if (!Array.isArray(line) || line.length < 2) continue;
    const path = line.filter(point => Array.isArray(point) && point.length >= 2
      && Number.isFinite(point[0]) && Number.isFinite(point[1]))
      .map(point => [point[1], point[0]]);
    if (path.length >= 2) converted.push(path);
  }
  return converted.length ? converted : null;
}

export function boundsOfGeometries(geometries) {
  let minLon = Infinity; let minLat = Infinity; let maxLon = -Infinity; let maxLat = -Infinity;
  for (const geometry of geometries ?? []) {
    for (const line of toLatLngs(geometry) ?? []) {
      for (const [lat, lon] of line) {
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      }
    }
  }
  return Number.isFinite(minLon) ? [[minLat, minLon], [maxLat, maxLon]] : null;
}

// The compact card a selected or clicked corridor shows: which road, why it surfaced, and how far it is. Component
// wording comes from the ranking model's own labels, so the popup cannot drift from the score in the list.
export function popupHtml(corridor) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const parts = [];
  if (Number.isFinite(corridor?.ranking?.score)) {
    // The version travels with the card: a screenshot of a score is only interpretable beside the model that
    // produced it, and the model is versioned precisely so that stays true.
    parts.push(`<p class="map-popup-score"><strong>Naturalist interest ${corridor.ranking.score}</strong>`
      + `<span class="map-popup-version" data-ranking-version="${escape(corridor.ranking.version ?? '')}"> </span></p>`);
    for (const [key, label] of [['wetland', 'Wetland context'], ['water', 'Water context'],
      ['ecologicalVariety', 'Ecological variety']]) {
      const component = corridor.ranking.components?.[key] ?? null;
      parts.push(`<p>${label}: ${escape(contextLabel(component?.measured ? component.value : NaN))}</p>`);
    }
  } else if (corridor?.ranking) {
    parts.push('<p>Naturalist interest: not measured here</p>');
  }
  if (Number.isFinite(corridor?.distanceFromCenterM)) {
    parts.push(`<p>${(corridor.distanceFromCenterM / 1609.344).toFixed(1)} mi from search centre</p>`);
  }
  return `<div class="map-popup"><strong>${escape(corridor?.name ?? 'Unnamed corridor')}</strong>${parts.join('')}</div>`;
}


// A view that owns nothing: used when Leaflet is unavailable, so the rest of Road Naturalist is untouched by a
// mapping failure. Every method is a no-op that reports failure rather than throwing into the app.
export function unavailableView(reason) {
  return { available: false, reason, draw: () => false, setSelected: () => false, setSearch: () => false,
    setSavedRoads: () => false, setOuting: () => false, setPickMode: () => false, setBasemap: () => false,
    fitResults: () => false, fitSelected: () => false, selectedId: () => null, destroy: () => {},
    camera: () => null, searchGeometry: () => ({ center: null, radiusM: null }), fitCount: () => 0 };
}

// What a tile layer does when a tile cannot be fetched. The provider is a third party: its refusal, its rate limit
// or its absence must not become a discovery failure, so the layer reports itself and the geometry stays.
export function basemapFailureNote(provider) {
  return `The ${provider?.label ?? 'basemap'} tiles could not be loaded, so the background is blank. `
    + 'Corridor geometry, the candidate list and the analysis are unaffected.';
}

// The view itself. `leaflet` is injectable so the interaction rules - selection, viewport ownership, failure
// containment - are testable without a browser.
export function createGeoView(container, { leaflet = globalThis.L ?? null, provider = tileProvider(),
  onSelect = () => {}, onPickCoordinate = () => {}, onNotice = () => {}, onBasemap = () => {} } = {}) {
  if (!container) throw new TypeError('A geographic view needs a container element');
  if (!leaflet?.map) return unavailableView('the mapping library is not available');
  try {
    const map = leaflet.map(container, { zoomControl: true, attributionControl: true, worldCopyJump: true });
    map.setView([39, -96], 4);
    const layers = { results: leaflet.featureGroup(), saved: leaflet.featureGroup(), search: leaflet.featureGroup(),
      overlay: leaflet.featureGroup(), occurrence: leaflet.featureGroup(), selected: leaflet.featureGroup() };
    for (const layer of Object.values(layers)) map.addLayer(layer);
    let basemap = null;
    let basemapStatus = provider ? 'loading' : 'off';
    let tileErrors = 0;
    function attachBasemap() {
      if (!provider) return;
      basemap = leaflet.tileLayer(provider.urlTemplate, { attribution: provider.attribution,
        maxZoom: provider.maxZoom });
      // A tile error is a note, never an exception: geometry over a blank background is still a usable map.
      basemap.on('tileerror', () => {
        tileErrors += 1;
        if (basemapStatus === 'ready') return;
        basemapStatus = 'unavailable';
        onBasemap({ status: basemapStatus, note: basemapFailureNote(provider) });
      });
      basemap.on('load', () => {
        if (basemapStatus === 'ready') return;
        basemapStatus = 'ready';
        onBasemap({ status: basemapStatus, note: null });
      });
      basemap.addTo(map);
    }
    attachBasemap();

    let pickMode = false;
    let selectedId = null;
    let corridors = [];
    let savedRoads = [];
    let outing = null;
    let activeCentre = null;
    let activeRadiusM = null;
    let fitCount = 0;
    map.on('click', event => {
      // In pick mode the map is an input surface and nothing else: it hands the coordinate back and does not touch
      // the search definition, which stays the domain layer's business.
      if (pickMode) { onPickCoordinate([event.latlng.lng, event.latlng.lat]); return; }
      const hit = hitTest(event.latlng);
      if (hit) onSelect(hit.id);
    });
    function hitTest(latlng) {
      let best = null;
      let bestDistance = Infinity;
      for (const corridor of corridors) {
        for (const line of toLatLngs(corridor.geometry) ?? []) {
          for (const [lat, lon] of line) {
            const distance = Math.hypot(lat - latlng.lat, lon - latlng.lng);
            if (distance < bestDistance) { bestDistance = distance; best = corridor; }
          }
        }
      }
      // A click selects only something genuinely close, so a stray click on empty basemap does not jump the list.
      return bestDistance <= 0.01 ? best : null;
    }
    function styleFor(corridor) {
      if (corridor.id === selectedId) return corridor.saved ? LINE_STYLE.selectedSaved : LINE_STYLE.selected;
      if (corridor.dismissed) return LINE_STYLE.dismissed;
      if (corridor.saved) return LINE_STYLE.saved;
      return LINE_STYLE.normal;
    }
    function paint(layer, entries) {
      layer.clearLayers();
      let drawn = 0;
      let skipped = 0;
      for (const corridor of entries) {
        const lines = toLatLngs(corridor.geometry);
        if (!lines) { skipped += 1; continue; }
        for (const line of lines) {
          const path = leaflet.polyline(line, styleFor(corridor));
          // The corridor's own id travels with its line, so a click target is found without guessing at pixels.
          mark(path, { role: 'candidate', corridorId: corridor.id });
          // Drawing order is list order, so the map's stacking matches the order the person is reading.
          if (Number.isFinite(corridor.distanceFromCenterM)) path.bindPopup(popupHtml(corridor));

          layer.addLayer(path);
          drawn += 1;
        }
      }
      return { drawn, skipped };
    }
    // SEARCH GEOMETRY: the request, not the processing extent. A radius search draws its centre and its requested
    // radius; the bbox the cell selection happens to use is an implementation detail and is only ever drawn as a
    // subordinate, explicitly labelled diagnostic.
    function setSearch(search) {
      layers.search.clearLayers();
      if (!search) return true;
      if (search.kind === 'radius' && Array.isArray(search.center)) {
        const center = [search.center[1], search.center[0]];
        activeCentre = center;
        mark(leaflet.circleMarker(center, { radius: 4, color: '#111827', weight: 2, fillColor: '#ffffff',
          fillOpacity: 1 }).bindTooltip('Search centre').addTo(layers.search), { role: 'search-center' });
        if (Number.isFinite(search.radiusMiles)) {
          activeRadiusM = search.radiusMiles * 1609.344;
          mark(leaflet.circle(center, { radius: activeRadiusM, color: '#111827', weight: 1.5, opacity: 0.8,
            fill: false, dashArray: '6 4' }).bindTooltip('Requested search radius').addTo(layers.search),
          { role: 'search-radius' });
        }
        return true;
      }
      if (search.kind === 'box' && search.bounds) {
        const [[minLon, minLat], [maxLon, maxLat]] = [[search.bounds[0], search.bounds[1]], [search.bounds[2], search.bounds[3]]];
        leaflet.rectangle([[minLat, minLon], [maxLat, maxLon]], { color: '#6b7280', weight: 1, opacity: 0.6,
          dashArray: '4 4', fill: false }).bindTooltip('Declared search box').addTo(layers.search);
        return true;
      }
      return true;
    }

    const view = {
      available: true,
      // The whole visible candidate set, in list order, replacing whatever was drawn before - without touching the
      // viewport. `fitResults()` is the only thing that moves the camera, and only when the caller asks.
      draw({ corridors: next = [], selectedId: nextSelected = null, savedIds = [], dismissedIds = [],
        overlay = null, occurrenceOverlay = null, search } = {}) {
        const saved = new Set(savedIds);
        const dismissed = new Set(dismissedIds);
        corridors = next.map(corridor => ({ ...corridor, saved: saved.has(corridor.id),
          dismissed: dismissed.has(corridor.id) }));
        selectedId = nextSelected;
        const results = paint(layers.results, corridors);
        // Saved roads that are *not* in the visible set are drawn from their own descriptors; the same road is never
        // drawn twice simply because it is both a candidate and saved.
        const visible = new Set(corridors.map(corridor => corridor.id));
        paint(layers.saved, savedRoads.filter(road => !visible.has(road.id)));
        paint(layers.overlay, overlay?.features ?? []);
        paint(layers.occurrence, occurrenceOverlay?.features ?? []);
        if (search !== undefined) setSearch(search);
        view.setSelected(selectedId);
        return { drawn: results.drawn, skipped: results.skipped, candidates: corridors.length };
      },
      // Selection changes appearance only. It is called on every list highlight precisely *because* it does not fit.
      setSelected(id) {
        selectedId = id ?? null;
        paint(layers.results, corridors);
        // The emphasised copy is drawn into its own layer so it sits above every other corridor regardless of where
        // it falls in the list order. Selection changes appearance only: it is called on every list highlight
        // precisely *because* it never moves the camera.
        layers.selected.clearLayers();
        const selected = corridors.find(corridor => corridor.id === selectedId) ?? null;
        for (const line of toLatLngs(selected?.geometry) ?? []) {
          leaflet.polyline(line, { ...styleFor(selected), interactive: false }).addTo(layers.selected);
        }
        return Boolean(selected);
      },
      setSearch,
      setSavedRoads(descriptors = []) { savedRoads = [...descriptors]; return true; },
      // An outing is recorded so the API is not designed around exactly one highlighted road; no connectors, no
      // route order and no drive times are computed here.
      setOuting(descriptor = null) { outing = descriptor ? { id: descriptor.id ?? null, roadIds: [...(descriptor.roadIds ?? [])] } : null; return outing; },
      outingRoadIds() { return outing ? [...outing.roadIds] : []; },
      setPickMode(enabled) {
        pickMode = Boolean(enabled);
        if (container.style) container.style.cursor = pickMode ? 'crosshair' : '';
        return pickMode;
      },
      setBasemap(enabled) {
        if (!provider) return false;
        if (enabled) { if (!map.hasLayer(basemap)) attachBasemap(); }
        else if (map.hasLayer(basemap)) map.removeLayer(basemap);
        onBasemap({ status: enabled ? basemapStatus : 'off', note: null });
        return Boolean(enabled);
      },
      basemapStatus: () => basemapStatus,
      tileErrorCount: () => tileErrors,
      // The three explicit camera moves. Nothing else fits.
      fitResults() {
        const bounds = boundsOfGeometries(corridors.map(corridor => corridor.geometry));
        if (!bounds) { onNotice({ kind: 'empty', note: 'No mapped corridor geometry to fit.' }); return false; }
        map.fitBounds(bounds, { padding: [24, 24] });
        fitCount += 1;
        return true;
      },
      fitSelected() {
        const selected = corridors.find(corridor => corridor.id === selectedId) ?? null;
        const bounds = boundsOfGeometries([selected?.geometry]);
        if (!bounds) return false;
        map.fitBounds(bounds, { padding: [24, 24] });
        return true;
      },
      selectedId: () => selectedId,
      // A read-only view of where the camera is and what the search geometry is, so the browser interaction gate can
      // verify the contract without reaching into Leaflet from the test. Nothing in the application reads these.
      camera: () => ({ center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom() }),
      searchGeometry: () => ({ center: activeCentre, radiusM: activeRadiusM }),
      fitCount: () => fitCount,
      // A person's own viewport survives a redraw, and the map remembers it: `bounds()` exists for tests and
      // diagnostics rather than for the application to store.
      bounds: () => map.getBounds?.() ?? null,
      destroy() { map.off?.(); map.remove?.(); },
    };
    return view;
  } catch (error) {
    return unavailableView(error?.message ?? 'the mapping library failed to initialise');
  }
}

