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

// A POLYGON OR A POINT IS NOT A LINE. The map draws three kinds of geometry, so the shape of a feature is read from
// its own geometry rather than assumed: a habitat polygon drawn as a "line" would be invisible, and an occurrence
// point drawn as a closed polygon would be an empty frame.
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

// THE LAYER MODEL: WHAT A FEATURE IS, AND WHAT THE DOM SAYS IT IS.
//
// Every drawable thing on this map is a *feature* with a kind, and the kind decides everything - how it is styled, how
// it is marked in the DOM, whether it can be clicked, and which pane it is drawn into. Nothing is corridor-shaped by
// default: a habitat polygon is not a corridor with a missing id, and an occurrence point is not a corridor at all.
// The application hands over descriptors it already holds (corridors from discovery, a habitat overlay with its
// buffer, occurrence points, the search definition) and the normalizers below turn them into features.
export const FEATURE_KIND = Object.freeze({
  CORRIDOR: 'corridor', HABITAT: 'habitat', HABITAT_BUFFER: 'habitat-buffer', OCCURRENCE: 'occurrence',
  SEARCH_CONTEXT: 'search-context', SEARCH_REGION: 'search-region', SEARCH_RADIUS: 'search-radius',
  SEARCH_CENTRE: 'search-center',
});

// PANES ARE THE Z-ORDER, DECLARED ONCE. Search geometry sits under everything it describes; the habitat buffer sits
// under the habitat features it contains; context lines sit under the roads they explain; occurrences sit above the
// roads so a point is never hidden by a line; the selected corridor sits above every other line. Leaflet's own
// tooltip and popup panes (650 and 700) stay above all of it.
//
// A CORRIDOR IS DRAWN WHERE LEAFLET PUTS INTERACTIVE GEOMETRY. Its pane is deliberately null - Leaflet's own overlay
// pane - because that is the renderer whose click handling is the library's own, proven path; every other family here is
// non-interactive and is the only thing that gets a pane of its own. Ordering is therefore a property of this table,
// and click handling is not something a pane can take away.
export const FEATURE_PANE = Object.freeze({
  [FEATURE_KIND.SEARCH_REGION]: 'rnSearch', [FEATURE_KIND.SEARCH_RADIUS]: 'rnSearch',
  [FEATURE_KIND.SEARCH_CENTRE]: 'rnSearch', [FEATURE_KIND.SEARCH_CONTEXT]: 'rnContext',
  [FEATURE_KIND.HABITAT_BUFFER]: 'rnHabitatBuffer', [FEATURE_KIND.HABITAT]: 'rnHabitat',
  [FEATURE_KIND.CORRIDOR]: null, [FEATURE_KIND.OCCURRENCE]: 'rnOccurrence',
});
const PANES = Object.freeze([['rnSearch', 340], ['rnContext', 360], ['rnHabitatBuffer', 370], ['rnHabitat', 380],
  ['rnOccurrence', 420], ['rnSelected', 430]]);

// THE DOM CONTRACT, ONE ROW PER KIND. `idAttribute` carries that kind's own identity, so a corridor is named by
// data-corridor-id, a habitat feature by data-habitat-id, an occurrence by data-occurrence-id. A kind without an
// identity of its own gets a role and nothing else. The candidate row is the contract the production gate already
// relies on: unchanged, and only a corridor may wear it.
export const FEATURE_DOM = Object.freeze({
  [FEATURE_KIND.CORRIDOR]: Object.freeze({ role: 'candidate', idAttribute: 'corridorId', idField: 'corridorId',
    interactive: true, clickable: true }),
  [FEATURE_KIND.HABITAT]: Object.freeze({ role: 'habitat', idAttribute: 'habitatId', idField: 'habitatId',
    interactive: false }),
  // The buffer belongs to a corridor's habitat overlay, so the association travels under its own attribute: it is not
  // a candidate and must never be mistaken for one by a selector looking for data-corridor-id.
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

// One feature, marked for the document: its role, and its identity under the attribute that identity belongs to.
export function featureAttributes(feature) {
  const contract = FEATURE_DOM[feature?.kind] ?? null;
  if (!contract) return {};
  const attributes = { role: contract.role };
  const value = contract.idField ? feature?.[contract.idField] : null;
  if (contract.idAttribute && value != null) attributes[contract.idAttribute] = value;
  if (feature?.kind === FEATURE_KIND.CORRIDOR && feature.selected != null) attributes.selected = feature.selected;
  return attributes;
}

// FEATURE STYLES, BY KIND. State is still carried by weight, opacity and dash pattern rather than colour alone, and
// each family is visually distinct: habitat fill is cool and translucent, its buffer is a dashed outline, an
// occurrence point is a filled dot, and a context line is a thin brown dotted leader.
const FEATURE_STYLE = Object.freeze({
  habitatWetland: Object.freeze({ color: '#3f7f8c', weight: 1, opacity: 0.85, fillColor: '#8fc4d6', fillOpacity: 0.35 }),
  habitatHydrography: Object.freeze({ color: '#3f8fa8', weight: 1.6, opacity: 0.9, fill: false }),
  habitatBuffer: Object.freeze({ color: '#3f7f8c', weight: 1.4, opacity: 0.75, dashArray: '6 4', fill: false }),
  occurrence: Object.freeze({ radius: 3.5, color: '#5b21b6', weight: 1, fillColor: '#8b5cf6', fillOpacity: 0.9 }),
  context: Object.freeze({ color: '#7a4b12', weight: 1.6, opacity: 0.8, dashArray: '4 5' }),
  region: Object.freeze({ color: '#6b7280', weight: 1, opacity: 0.6, dashArray: '4 4', fill: false }),
});

// FROM THE APPLICATION'S DESCRIPTORS TO FEATURES. Each normalizer is pure and takes the style it should wear, so the
// whole model can be tested without a map.
export function corridorFeature(corridor, { selected = false, style = null } = {}) {
  return Object.freeze({ kind: FEATURE_KIND.CORRIDOR, corridorId: corridor?.id ?? null,
    geometry: corridor?.geometry ?? null, style: style ?? LINE_STYLE.normal, selected: Boolean(selected),
    // The card follows the corridor: a corridor whose distance from the search centre was never measured has nothing
    // to say about it and is drawn without one.
    card: Number.isFinite(corridor?.distanceFromCenterM) ? popupHtml(corridor) : null });
}

export function habitatFeatures(overlay) {
  const features = [];
  for (const row of overlay?.features ?? []) {
    if (!featureShape(row?.geometry)) continue;
    // THE FEATURE'S OWN DOMAIN IDENTITY: the source dataset's feature id within its layer, which is stable for the
    // published extract. A row without one is drawn as an unnamed habitat feature rather than borrowing an id it has
    // not got - least of all a corridor's.
    features.push(Object.freeze({ kind: FEATURE_KIND.HABITAT,
      habitatId: row.sourceFeatureId != null ? `${row.layer ?? 'habitat'}:${row.sourceFeatureId}` : null,
      label: row.label ?? null, layer: row.layer ?? null, geometry: row.geometry,
      style: row.layer === 'hydrography' ? FEATURE_STYLE.habitatHydrography : FEATURE_STYLE.habitatWetland }));
  }
  return features;
}

// THE 1 km ANALYSIS BUFFER: the same analytical geometry the measurements were taken from, drawn as the outline it is
// rather than as a habitat feature. Which corridor it belongs to travels as `corridorId`, marked under
// data-habitat-corridor-id, so it can never be read as a candidate.
export function habitatBufferFeature(overlay) {
  const geometry = overlay?.bufferGeometry ?? null;
  if (!geometry || !featureShape(geometry)) return null;
  return Object.freeze({ kind: FEATURE_KIND.HABITAT_BUFFER, corridorId: overlay?.candidateId ?? null,
    geometry, style: FEATURE_STYLE.habitatBuffer });
}

export function occurrenceFeatures(occurrenceOverlay) {
  const features = [];
  for (const point of occurrenceOverlay?.points ?? []) {
    const at = toLatLngPoint(point?.coordinates);
    if (!at) continue;
    // DISPLAY IDENTITY, NOT SOURCE IDENTITY, and it says so. A source record id is used when the source published one
    // (`<source>:<sourceRecordId>`); without one the id is derived deterministically from the source and the point's
    // own position, so the same observation keeps the same id between draws without claiming to be a source record.
    const occurrenceId = point?.sourceRecordId != null ? `${point.source ?? 'source'}:${point.sourceRecordId}`
      : `${point?.source ?? 'source'}:${at[0].toFixed(5)},${at[1].toFixed(5)}`;
    features.push(Object.freeze({ kind: FEATURE_KIND.OCCURRENCE, occurrenceId, geometry: { type: 'Point',
      coordinates: [at[1], at[0]] }, label: point?.label ?? null, group: point?.group ?? null,
      displayIdentity: point?.sourceRecordId == null, style: FEATURE_STYLE.occurrence }));
  }
  return features;
}

// THE LEADER from where the person searched to the nearest point of the corridor they selected. Both ends must be real
// coordinates: a line to an invented point would be a claim about geography.
export function searchContextFeature({ centre, corridor } = {}) {
  const from = toLatLngPoint(centre);
  const to = toLatLngPoint(corridor?.nearestCenterPoint);
  if (!from || !to || !corridor?.id) return null;
  return Object.freeze({ kind: FEATURE_KIND.SEARCH_CONTEXT, corridorId: corridor.id,
    geometry: { type: 'LineString', coordinates: [[from[1], from[0]], [to[1], to[0]]] }, style: FEATURE_STYLE.context });
}

// SEARCH GEOMETRY IS THE REQUEST, NOT THE PROCESSING EXTENT. A radius search draws its centre and its requested
// radius. A declared area draws the bounds of the search *definition* the person chose - never the processing bbox,
// never a derived-cell extent, and never the published region's own bounds.
export function searchFeatures(search) {
  if (!search) return [];
  if (search.kind === 'radius') {
    const centre = toLatLngPoint(search.center);
    if (!centre) return [];
    const features = [{ kind: FEATURE_KIND.SEARCH_CENTRE, geometry: { type: 'Point',
      coordinates: [centre[1], centre[0]] }, label: 'Search centre',
      style: Object.freeze({ radius: 4, color: '#111827', weight: 2, fillColor: '#ffffff', fillOpacity: 1 }) }];
    if (Number.isFinite(search.radiusMiles)) {
      features.push({ kind: FEATURE_KIND.SEARCH_RADIUS, geometry: { type: 'Point',
        coordinates: [centre[1], centre[0]] }, radiusM: search.radiusMiles * 1609.344, label: 'Requested search radius',
        style: Object.freeze({ color: '#111827', weight: 1.5, opacity: 0.8, fill: false, dashArray: '6 4' }) });
    }
    return features;
  }
  const bounds = search.bounds ?? null;
  if (Array.isArray(bounds) && bounds.length === 4) {
    return [{ kind: FEATURE_KIND.SEARCH_REGION, bounds, label: 'Declared search area', style: FEATURE_STYLE.region }];
  }
  return [];
}

// THE SHAPES ONE FEATURE DRAWS. A feature may be a line, an area, a point, a circle or a rectangle; the geometry it
// carries decides which, and a feature with nothing drawable is skipped rather than thrown.
export function drawableShapes(feature) {
  if (feature?.radiusM != null) {
    const centre = toLatLngPoint(feature.geometry);
    return centre ? [{ circle: true, point: centre, radiusM: feature.radiusM }] : [];
  }
  if (Array.isArray(feature?.bounds) && feature.bounds.length === 4) {
    const [minLon, minLat, maxLon, maxLat] = feature.bounds;
    return [{ rectangle: true, bounds: [[minLat, minLon], [maxLat, maxLon]] }];
  }
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
    // THE PANES, created once, lowest first. A feature is drawn into the pane its kind declares, so ordering is a
    // property of the layer model rather than of the order layers happened to be added in.
    for (const [name, zIndex] of PANES) {
      if (typeof map.createPane !== 'function') break;
      const pane = map.createPane(name);
      if (pane?.style) pane.style.zIndex = String(zIndex);
    }
    const layers = { results: leaflet.featureGroup(), saved: leaflet.featureGroup(), search: leaflet.featureGroup(),
      context: leaflet.featureGroup(), overlay: leaflet.featureGroup(), occurrence: leaflet.featureGroup(),
      selected: leaflet.featureGroup() };
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
      // A DRAWN FEATURE ANSWERS THE CLICK IT RECEIVED. A corridor's own handler has already selected it; any other
      // feature - a habitat polygon, the habitat buffer, a context leader, the search centre - deliberately does not
      // act, and the map must not act on its behalf by selecting whatever corridor happens to be nearest.
      if (event?.propagatedFrom?.rnFeature) return;
      if (event?.propagatedFrom?.corridorId) return;
      const hit = hitTest(event.latlng);
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
    // ONE PAINT PATH, DRIVEN BY THE FEATURE'S KIND. Style, DOM marking, pane and interaction all come from the tables
    // at the top of this module, so a family of features is added by declaring it rather than by growing a switch here.
    // The corridor loop it replaces is the same loop: a corridor's click selects that corridor, and nothing else on the
    // map is clickable as one.
    function paint(layer, features) {
      layer.clearLayers();
      // The cards follow the layers: a path that is no longer drawn cannot show a card.
      if (layer === layers.results) cardedPaths.clear();
      let drawn = 0;
      let skipped = 0;
      for (const feature of features ?? []) {
        const contract = feature ? FEATURE_DOM[feature.kind] : null;
        if (!contract) { skipped += 1; continue; }
        const shapes = drawableShapes(feature);
        if (!shapes.length) { skipped += 1; continue; }
        for (const shape of shapes) {
          const pane = FEATURE_PANE[feature.kind];
          const options = { ...feature.style, interactive: contract.interactive, ...(pane ? { pane } : {}) };
          const path = shape.circle ? leaflet.circle(shape.point, { ...options, radius: shape.radiusM })
            : shape.rectangle ? leaflet.rectangle(shape.bounds, options)
              : shape.point ? leaflet.circleMarker(shape.point, options)
                : shape.rings ? leaflet.polygon(shape.rings, options)
                  : leaflet.polyline(shape.line, options);
          // A label is a tooltip, and a tooltip needs a layer that can be pointed at: a non-interactive overlay must not
          // become hoverable just to carry one.
          if (feature.label && contract.interactive) path.bindTooltip?.(feature.label);
          // WHAT THIS PATH IS. The click handler below uses it, and so does the map-level handler: a click that a drawn
          // feature has already answered - even by declining to act - is not re-answered by proximity testing. Without
          // it, clicking a habitat polygon over a road would select the road underneath, which is not what was clicked.
          path.rnFeature = feature.kind;
          // THE MAP-LEVEL HANDLER'S OWN SIGNAL. The DOM identity of a corridor is stamped from the feature tables above;
          // this is separate and is for the map's click handler, which must be able to see that a line has already
          // answered a click so proximity cannot answer it a second time with a different corridor.
          if (feature.kind === FEATURE_KIND.CORRIDOR) path.corridorId = feature.corridorId;
          if (contract.clickable && typeof path.on === 'function') {
            path.on('click', () => {
              if (pickMode) return;
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
          if (feature.kind === FEATURE_KIND.CORRIDOR && feature.card) {
            cardedPaths.set(feature.corridorId, path);
            path.bindPopup(feature.card);
          }
          drawn += 1;
        }
      }
      return { drawn, skipped };
    }
    // SEARCH GEOMETRY: the request, not the processing extent. A radius search draws its centre and its requested
    // radius; a declared area draws the bounds of the search definition the person chose. Neither the processing bbox
    // nor the published region's own bounds are drawn: they are not what was asked for.
    function setSearch(search) {
      layers.search.clearLayers();
      const features = searchFeatures(search);
      paint(layers.search, features);
      const centre = features.find(feature => feature.kind === FEATURE_KIND.SEARCH_CENTRE) ?? null;
      const radius = features.find(feature => feature.kind === FEATURE_KIND.SEARCH_RADIUS) ?? null;
      activeCentre = centre ? toLatLngPoint(centre.geometry) : null;
      activeRadiusM = radius ? radius.radiusM : null;
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
        const results = paint(layers.results, corridors.map(corridor => corridorFeature(corridor,
          { selected: corridor.id === selectedId, style: styleFor(corridor) })));
        // Saved roads that are *not* in the visible set are drawn from their own descriptors; the same road is never
        // drawn twice simply because it is both a candidate and saved.
        const visible = new Set(corridors.map(corridor => corridor.id));
        paint(layers.saved, savedRoads.filter(road => !visible.has(road.id))
          .map(road => corridorFeature(road, { selected: road.id === selectedId, style: styleFor(road) })));
        // THE HABITAT FAMILY, in its own terms: the analysis buffer first (it is the outline the features sit inside),
        // then the wetland and hydrography features themselves. Neither is a corridor and neither is clickable.
        const buffer = habitatBufferFeature(overlay);
        paint(layers.overlay, [...(buffer ? [buffer] : []), ...habitatFeatures(overlay)]);
        paint(layers.occurrence, occurrenceFeatures(occurrenceOverlay));
        if (search !== undefined) setSearch(search);
        view.setSelected(selectedId);
        return { drawn: results.drawn, skipped: results.skipped, candidates: corridors.length };
      },
      // Selection changes appearance only. It is called on every list highlight precisely *because* it does not fit.
      setSelected(id) {
        selectedId = id ?? null;
        paint(layers.results, corridors.map(corridor => corridorFeature(corridor,
          { selected: corridor.id === selectedId, style: styleFor(corridor) })));
        // The emphasised copy is drawn into its own layer and its own pane, so it sits above every other line
        // regardless of where it falls in the list order. Selection changes appearance only: it is called on every list
        // highlight precisely *because* it never moves the camera.
        layers.selected.clearLayers();
        const selected = corridors.find(corridor => corridor.id === selectedId) ?? null;
        for (const line of toLatLngs(selected?.geometry) ?? []) {
          leaflet.polyline(line, { ...styleFor(selected), pane: 'rnSelected', interactive: false })
            .addTo(layers.selected);
        }
        // THE LEADER, FROM WHERE THE PERSON SEARCHED TO THE ROAD THEY SELECTED. It is a context line and not a road:
        // non-interactive, drawn under the corridors, and present only when both ends are real coordinates.
        layers.context.clearLayers();
        const leader = searchContextFeature({ centre: activeCentre, corridor: selected });
        if (leader) paint(layers.context, [leader]);
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

