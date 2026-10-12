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
//
// The name is kebab-cased on the way out, because these are SVG elements and SVG preserves attribute case: setting
// `corridorId` produces the literal attribute `data-corridorId`, which no `[data-corridor-id]` selector will ever
// match. The DOM contract is the kebab-case name, so the conversion belongs here, in one place.
export function attributeName(name) {
  if (String(name).startsWith('data-')) return String(name);
  return `data-${String(name).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
}

function mark(path, attributes) {
  const element = path?.getElement?.() ?? null;
  if (!element?.setAttribute) return false;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(attributeName(name), String(value));
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

// THE FEATURE TAXONOMY, AND WHAT EACH KIND SAYS ABOUT ITSELF IN THE DOM.
//
// A drawn thing on this map is a *feature* with a kind, and the kind decides its DOM identity: which role it carries,
// and which attribute names its own identity. The taxonomy is declared in full because the overlay families are coming,
// but only what the map renders today is painted through it: corridors, and - untouched, further down - the search
// geometry, whose roles are declared here for the slice that types them.
//
// ONE KIND OWNS data-role="candidate": a corridor, named by data-corridor-id. That is the contract the production gate
// and the click identity rest on, and it is deliberately unchanged.
export const FEATURE_KIND = Object.freeze({
  CORRIDOR: 'corridor', HABITAT: 'habitat', HABITAT_BUFFER: 'habitat-buffer', OCCURRENCE: 'occurrence',
  SEARCH_CONTEXT: 'search-context', SEARCH_REGION: 'search-region', SEARCH_RADIUS: 'search-radius',
  SEARCH_CENTRE: 'search-center',
});

// idAttribute is the attribute this kind's own identity belongs to. A kind with no identity of its own declares none -
// it never borrows another family's.
export const FEATURE_DOM = Object.freeze({
  [FEATURE_KIND.CORRIDOR]: Object.freeze({ role: 'candidate', idAttribute: 'corridorId', idField: 'corridorId',
    interactive: true, clickable: true }),
  [FEATURE_KIND.HABITAT]: Object.freeze({ role: 'habitat', idAttribute: 'habitatId', idField: 'habitatId',
    interactive: false }),
  // The buffer belongs to a corridor's habitat overlay, so the association travels under its own attribute: it is not
  // a candidate and must never be read as one.
  [FEATURE_KIND.HABITAT_BUFFER]: Object.freeze({ role: 'habitat-buffer', idAttribute: 'habitatCorridorId',
    idField: 'corridorId', interactive: false }),
  [FEATURE_KIND.OCCURRENCE]: Object.freeze({ role: 'occurrence', idAttribute: 'occurrenceId', idField: 'occurrenceId',
    interactive: false }),
  [FEATURE_KIND.SEARCH_CONTEXT]: Object.freeze({ role: 'search-context', idAttribute: 'corridorId',
    idField: 'corridorId', interactive: false }),
  [FEATURE_KIND.SEARCH_REGION]: Object.freeze({ role: 'search-region', interactive: false }),
  [FEATURE_KIND.SEARCH_RADIUS]: Object.freeze({ role: 'search-radius', interactive: false }),
  [FEATURE_KIND.SEARCH_CENTRE]: Object.freeze({ role: 'search-center', interactive: true }),
});

// What a feature's element carries: its role, and its identity under the attribute that identity belongs to. A value
// that does not exist is not written, so no element ever says it is something it has no identity for.
export function featureAttributes(feature) {
  const contract = FEATURE_DOM[feature?.kind] ?? null;
  if (!contract) return {};
  const attributes = { role: contract.role };
  const value = contract.idField ? feature?.[contract.idField] : null;
  if (contract.idAttribute && value != null) attributes[contract.idAttribute] = value;
  if (feature?.kind === FEATURE_KIND.CORRIDOR && feature.selected != null) attributes.selected = feature.selected;
  return attributes;
}

// A CORRIDOR, NORMALIZED. Its identity, geometry, style and card come from the corridor descriptor itself; the kind is
// what makes it a corridor rather than a row that merely resembles one.
export function corridorFeature(corridor, { selected = false, style = null } = {}) {
  return Object.freeze({ kind: FEATURE_KIND.CORRIDOR, corridorId: corridor?.id ?? null,
    geometry: corridor?.geometry ?? null, style: style ?? LINE_STYLE.normal, selected: Boolean(selected),
    // The card follows the corridor: a corridor whose distance from the search centre was never measured has nothing to
    // say about it and is drawn without one.
    card: Number.isFinite(corridor?.distanceFromCenterM) ? popupHtml(corridor) : null });
}

// A POLYGON OR A POINT IS NOT A LINE, and the shape of a feature is read from its own geometry rather than assumed.
// Only the line shape is painted by the map today; the others are declared for the overlay families, so the slice that
// paints them starts from a shape reader that is already right.
export function featureShape(geometry) {
  const type = geometry?.type;
  if (type === 'Point') return 'point';
  if (type === 'Polygon' || type === 'MultiPolygon' || type === 'MultiPoint') return 'area';
  if (type === 'LineString' || type === 'MultiLineString') return 'line';
  return null;
}

// Polygon rings as Leaflet wants them: [lat, lon], outer ring first. A ring with fewer than three points is not a
// polygon and is dropped rather than thrown at the renderer.
export function toLatLngRings(geometry) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates : null;
  if (!Array.isArray(polygons) || !polygons.length) return null;
  const rings = [];
  for (const polygon of polygons) {
    for (const ring of polygon ?? []) {
      if (!Array.isArray(ring)) continue;
      const path = ring.filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
        .map(([lon, lat]) => [lat, lon]);
      if (path.length >= 3) rings.push(path);
    }
  }
  return rings.length ? rings : null;
}

// One point as [lat, lon], from either a GeoJSON Point or a bare [lon, lat] pair.
export function toLatLngPoint(coordinates) {
  const pair = coordinates?.type === 'Point' ? coordinates.coordinates : coordinates;
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const [lon, lat] = pair;
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lat, lon] : null;
}

// THE SHAPES ONE FEATURE DRAWS. A feature may be a line, an area or a point; the geometry it carries decides which, and
// a feature with nothing drawable is skipped rather than thrown.
export function drawableShapes(feature) {
  const shape = featureShape(feature?.geometry);
  if (shape === 'point') {
    const point = toLatLngPoint(feature.geometry);
    return point ? [{ point }] : [];
  }
  if (shape === 'area') {
    const rings = toLatLngRings(feature.geometry);
    return rings ? [{ rings }] : [];
  }
  if (shape === 'line') return (toLatLngs(feature.geometry) ?? []).map(line => ({ line }));
  return [];
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
  // THE WRAPPER NAMES THE CORRIDOR THE CARD DESCRIBES, taken from the descriptor itself rather than from its
  // displayed name: the id, the name, the score and the component labels all come from one object, so a card can be
  // attributed without reading the road name back out of it.
  const wrapper = `<div class="map-popup corridor-popup" data-corridor-id="${escape(corridor?.id ?? '')}"`
    + ` data-ranking-version="${escape(corridor?.ranking?.version ?? '')}">`;
  return `${wrapper}<strong>${escape(corridor?.name ?? 'Unnamed corridor')}</strong>${parts.join('')}</div>`;
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
    let movements = 0;
    // THE PATH THAT CARRIES EACH CARD, so the card can be re-opened after a re-draw. Selecting a corridor re-renders the
    // map, and re-rendering clears the layers; a popup Leaflet opened as part of the click is therefore destroyed with
    // the layer it belonged to, and the selection would be left with nothing to read. One corridor, one card.
    const cardedPaths = new Map();
    let cardToOpen = null;
    function showCardFor(id) {
      if (id == null) return;
      const path = cardedPaths.get(id);
      if (!path) return;
      map.closePopup?.();
      path.openPopup?.();
    }
    // Counted rather than inferred: a drag that never reaches Leaflet leaves this at zero.
    map.on('moveend', () => { movements += 1; });

    map.on('click', event => {
      // In pick mode the map is an input surface and nothing else: it hands the coordinate back and does not touch
      // the search definition, which stays the domain layer's business.
      if (pickMode) { onPickCoordinate([event.latlng.lng, event.latlng.lat]); return; }
      // A CLICK A CORRIDOR LINE ALREADY ANSWERED IS NOT RE-ANSWERED BY PROXIMITY. The line knows which corridor it
      // was drawn for, so its event is authoritative; geometric proximity is only for a click on the map itself,
      // where no line spoke. Without this, a neighbouring corridor whose vertex happened to sit nearer the click
      // point would win the selection from the road the person actually clicked.
      if (event?.propagatedFrom?.corridorId) return;
      const hit = hitTest(event.latlng);
      // TEMPORARY (this task): the other half of the direct-click trace - whether the map had to answer by proximity.
      // Silent unless the flag is set.
      if (globalThis.__RN_DEBUG_MAP_CLICK) {
        console.log('MAP_CLICK_FALLBACK ' + JSON.stringify({ corridorId: hit?.id ?? null,
          propagatedFrom: Boolean(event?.propagatedFrom) }));
      }
      if (hit) { cardToOpen = hit.id; onSelect(hit.id); }
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
    // ONE PAINT PATH, AND TODAY IT PAINTS WHAT TODAY DRAWS. A typed feature says what it is - its identity, geometry and
    // style - and the tables above say how it is marked and whether it can be clicked. The habitat and occurrence
    // overlays are still handed over as rows that have not been typed yet, so those rows keep the corridor-shaped
    // handling they have today; typing them is the next slice, and until then their DOM is what it was.
    //
    // Nothing else about today's drawing changes: the same line geometry, the same layer, the same interactive
    // behaviour, the same click handler, the same card, the same marks, the same draw order. Only the line shape is
    // painted - a polygon row is skipped exactly as it is today - and pick mode still keeps precedence.
    function paint(layer, entries) {
      layer.clearLayers();
      // The cards follow the layers: a path that is no longer drawn cannot show a card.
      if (layer === layers.results) cardedPaths.clear();
      let drawn = 0;
      let skipped = 0;
      for (const entry of entries ?? []) {
        const feature = entry?.kind ? entry
          : corridorFeature(entry, { selected: entry?.id === selectedId, style: styleFor(entry) });
        const contract = FEATURE_DOM[feature.kind] ?? null;
        const lines = drawableShapes(feature).filter(shape => shape.line);
        if (!contract || !lines.length) { skipped += 1; continue; }
        for (const { line } of lines) {
          // `interactive` is the kind's own contract: a corridor can be clicked, and a family that cannot be is drawn
          // with that said in the layer itself rather than by hoping the z-order protects it.
          const path = leaflet.polyline(line, { ...feature.style, interactive: contract.interactive });
          // Drawing order is list order, so the map's stacking matches the order the person is reading.
          if (feature.card) {
            cardedPaths.set(feature.corridorId, path);
            path.bindPopup(feature.card);
          }
          // THE METADATA GOES ON AFTER LEAFLET HAS MADE THE ELEMENT. Leaflet creates a path's SVG element only when
          // the path joins the map, so stamping it before `addLayer` stamps nothing: the line is drawn and its
          // identity is nowhere in the DOM. The identification is therefore applied on the map's own `add` event and
          // once immediately after adding, which covers the first insertion and every later re-add.
          // THE LINE IS AUTHORITATIVE FOR ITS OWN CLICK. The path carries the corridor it was drawn for, so a click on
          // it selects exactly that corridor; the map-level handler then leaves the event alone. Pick mode keeps
          // precedence: the line declines the click and lets the map answer with the coordinate.
          //
          // THE CLICK IS NOT SWALLOWED. Stopping propagation here would also stop Leaflet's own layer-click listener,
          // which is what opens the corridor's card, so a selection would silently lose its explanation. Bubbling is
          // left intact instead; the map handler recognises the line's identity on `propagatedFrom` and declines to
          // answer a click that has already been answered.
          path.corridorId = feature.corridorId;
          if (contract.clickable && typeof path.on === 'function') {
            path.on('click', () => {
              if (pickMode) return;
              // TEMPORARY (this task): the direct-click trace, so the click path is measured rather than inferred.
              // Silent unless the flag is set; the gate sets it only with MAP_CLICK_DEBUG=1.
              if (globalThis.__RN_DEBUG_MAP_CLICK) {
                console.log('MAP_CLICK_LAYER ' + JSON.stringify({ corridorId: feature.corridorId }));
              }
              // A click on the line asks for that corridor's card along with the selection, so the card survives the
              // re-draw the selection triggers.
              cardToOpen = feature.corridorId;
              onSelect(feature.corridorId);
            });
          }
          const decorate = () => mark(path, featureAttributes(feature));
          if (typeof path.on === 'function') path.on('add', decorate);
          layer.addLayer(path);
          decorate();
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
        // ONE CARD, FOR THE CORRIDOR THAT WAS JUST ASKED FOR. The map has finished re-drawing, so a card requested by a
        // click is opened against the layer that now carries it - never against the layer the click destroyed.
        if (cardToOpen) { showCardFor(cardToOpen); cardToOpen = null; }
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
      // verify the contract without reaching into Leaflet from the test. Nothing in the application reads these, and
      // they are the whole of what the map exposes: camera, search geometry, and the two counts the gate asserts on.
      camera: () => ({ center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom() }),
      searchGeometry: () => ({ center: activeCentre, radiusM: activeRadiusM }),
      fitCount: () => fitCount,
      movementCount: () => movements,
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

