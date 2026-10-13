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
  // The radius keeps the tooltip it has today, which is why it stays interactive; what it must never be is a selection
  // target, and a kind becomes one only by declaring itself clickable.
  [FEATURE_KIND.SEARCH_RADIUS]: Object.freeze({ role: 'search-radius', interactive: true }),
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
    // WHICH COLLECTION THIS ROAD WAS DRAWN FROM, carried through unchanged. The map never interprets it and never guesses
    // it from the id: it reports it back with the click, and the application routes the selection.
    selectionDomain: corridor?.selectionDomain ?? null,
    // The card follows the corridor: a corridor whose distance from the search centre was never measured has nothing to
    // say about it and is drawn without one.
    card: Number.isFinite(corridor?.distanceFromCenterM) ? popupHtml(corridor) : null });
}

// A POLYGON OR A POINT IS NOT A LINE, and the shape of a feature is read from its own geometry rather than assumed.
// Only the line shape is painted by the map today; the others are declared for the overlay families, so the slice that
// paints them starts from a shape reader that is already right.
// SEARCH GEOMETRY, TYPED. The request is what is drawn - a centre and its requested radius, or the declared area's
// bounds - and the geometry is generated exactly as the dedicated path generated it: the same [lon, lat] input, the same
// Leaflet coordinates out, the same mile-to-metre radius, the same styles and labels. Nothing about the request is
// recomputed here, and the processing bbox the cell selection happens to use is not search geometry and is not drawn.
const SEARCH_STYLE = Object.freeze({
  centre: Object.freeze({ radius: 4, color: '#111827', weight: 2, fillColor: '#ffffff', fillOpacity: 1 }),
  radius: Object.freeze({ color: '#111827', weight: 1.5, opacity: 0.8, fill: false, dashArray: '6 4' }),
  region: Object.freeze({ color: '#6b7280', weight: 1, opacity: 0.6, dashArray: '4 4', fill: false }),
  // THE LEADER IS ORIENTATION, NOT EVIDENCE. Thin, low-contrast, finely dashed, and never in a road's colour or weight, so
  // it reads as the line between two measured points rather than as a route someone could drive.
  context: Object.freeze({ color: '#94a3b8', weight: 1, opacity: 0.55, dashArray: '2 4', fill: false }),
});

// THE SEARCH-CONTEXT LEADER, TYPED. It connects two points the discovery run already measured - the search centre it was
// measured against, and this corridor's own nearest point - and computes nothing: no nearest point is derived, no
// geometry is fetched, and when either value is missing there is no orientation to draw and no feature is produced. A
// corridor from a collection that never measured this context (the pilot's corridors, for instance) simply has no leader.
export function searchContextFeature(corridor) {
  const centre = toLatLngPoint(corridor?.searchCenter ?? null);
  const nearest = toLatLngPoint(corridor?.nearestCenterPoint ?? null);
  if (!centre || !nearest) return null;
  // A leader that does not go anywhere is not orientation.
  if (centre[0] === nearest[0] && centre[1] === nearest[1]) return null;
  // The corridor is an ASSOCIATION, not this feature's identity: it travels under data-corridor-id so the line can be
  // read against the road it orients, and its own role keeps it out of every candidate selector.
  return Object.freeze({ kind: FEATURE_KIND.SEARCH_CONTEXT, corridorId: corridor?.id ?? null,
    // Both measured points, in that order: the search centre first, the corridor's nearest point second.
    geometry: Object.freeze({ type: 'LineString', coordinates: Object.freeze([Object.freeze([centre[1], centre[0]]),
      Object.freeze([nearest[1], nearest[0]])]) }),
    label: null, style: SEARCH_STYLE.context });
}

export function searchFeatures(search) {
  if (!search) return [];
  if (search.kind === 'radius' && Array.isArray(search.center)) {
    const centre = toLatLngPoint(search.center);
    if (!centre) return [];
    const features = [Object.freeze({ kind: FEATURE_KIND.SEARCH_CENTRE,
      geometry: { type: 'Point', coordinates: [centre[1], centre[0]] }, point: centre, label: 'Search centre',
      style: SEARCH_STYLE.centre })];
    if (Number.isFinite(search.radiusMiles)) {
      features.push(Object.freeze({ kind: FEATURE_KIND.SEARCH_RADIUS,
        geometry: { type: 'Point', coordinates: [centre[1], centre[0]] }, point: centre,
        radiusM: search.radiusMiles * 1609.344, label: 'Requested search radius', style: SEARCH_STYLE.radius }));
    }
    return features;
  }
  // The declared area, when the search definition carries one: the same condition the dedicated path used, so a shape
  // that was not drawn before is not drawn now merely because the feature model can draw it.
  if (search.kind === 'box' && search.bounds) {
    return [Object.freeze({ kind: FEATURE_KIND.SEARCH_REGION, bounds: search.bounds, label: 'Declared search box',
      style: SEARCH_STYLE.region })];
  }
  return [];
}

// THE HABITAT ANALYSIS BUFFER, TYPED. The geometry is the analysis output the product already holds -
// `overlay.bufferGeometry`, straight from the habitat query's own buffer - so nothing here recomputes a distance,
// measures habitat or reads a dataset. It is an *outline*: unfilled, thin, dashed, and drawn under the features and the
// roads it belongs to, because it frames the question a person is reading rather than answering it.
const HABITAT_STYLE = Object.freeze({
  // The style the habitat buffer has always been described by in this project's stylesheet: cool, dashed, subordinate.
  buffer: Object.freeze({ color: '#3f7f8c', weight: 1.4, opacity: 0.75, dashArray: '6 4', fill: false }),
  // A WETLAND IS AN AREA: a translucent green fill with a thin outline, so a wetland reads as ground the road crosses
  // inside the analysis area, rather than as one more line among the roads.
  wetland: Object.freeze({ color: '#2f6f5e', weight: 1, opacity: 0.8, fillColor: '#5da271', fillOpacity: 0.25,
    fill: true }),
  // A FLOWLINE IS A LINE: thin and cool, and deliberately not dashed - the dash already means the analysis outline, and
  // a watercourse is not an outline.
  flowline: Object.freeze({ color: '#0e7490', weight: 1.2, opacity: 0.8, fill: false }),
  // A source row from a layer this build has not seen is still habitat, and is drawn as something plainly subordinate
  // rather than assumed to be a road.
  other: Object.freeze({ color: '#4b5563', weight: 1, opacity: 0.6, fill: false }),
});

export function habitatBufferFeature(overlay) {
  const geometry = overlay?.bufferGeometry ?? null;
  if (!geometry || featureShape(geometry) !== 'area') return null;
  // THE CORRIDOR ID IS AN ASSOCIATION, NOT THIS FEATURE'S OWN IDENTITY: it travels under data-habitat-corridor-id, so
  // no selector looking for a candidate can ever match a buffer.
  return Object.freeze({ kind: FEATURE_KIND.HABITAT_BUFFER, corridorId: overlay?.candidateId ?? null, geometry,
    label: null, style: HABITAT_STYLE.buffer });
}

// HABITAT SOURCE FEATURES, TYPED, WITH THEIR OWN IDENTITY.
//
// The habitat analysis hands over the source rows it measured - wetlands and flowlines - and each one becomes a feature of
// its own kind here. That is the whole point of the type: a source feature can no longer reach the map as a row that
// merely resembles a corridor, which is how these rows were drawn (candidate role, clickable) before the family existed.
//
// IDENTITY COMES FROM THE ROW, NOT FROM THE CORRIDOR: `<layer>:<sourceFeatureId>`, built from the layer the row was read
// from and the source dataset's own feature id. Both fields travel with every row the query returns, and a row missing
// either is reported in `unidentified` rather than given a made-up name - an invented identity would be indistinguishable
// from a real one downstream, and would attribute a wetland to something it is not.
export function habitatIdentity(row) {
  const layer = typeof row?.layer === 'string' && row.layer.length ? row.layer : null;
  const source = row?.sourceFeatureId == null ? null : String(row.sourceFeatureId);
  return layer && source && source.length ? `${layer}:${source}` : null;
}

export function habitatFeatures(overlay) {
  const features = [];
  const unidentified = [];
  for (const row of overlay?.features ?? []) {
    const habitatId = habitatIdentity(row);
    if (!habitatId) { unidentified.push(row); continue; }
    features.push(Object.freeze({ kind: FEATURE_KIND.HABITAT, habitatId, layer: row.layer,
      sourceFeatureId: String(row.sourceFeatureId), label: row.label ?? null, geometry: row.geometry ?? null,
      // The style follows the layer the row came from; an unknown layer is drawn plainly, never as a road.
      style: HABITAT_STYLE[row.layer] ?? HABITAT_STYLE.other }));
  }
  return Object.freeze({ features: Object.freeze(features), unidentified: Object.freeze(unidentified) });
}

const OCCURRENCE_STYLE = Object.freeze({
  // A POINT IS A POINT: a small filled disc with a white edge, which reads as a mapped record rather than as part of the
  // road network, and stays legible over the basemap and over the wetland fills. Violet is not used by any other family
  // on this map - corridors are indigo, the selected corridor amber, the analysis outline teal, wetlands green,
  // flowlines cyan - so a point is never mistaken for one of them.
  point: Object.freeze({ radius: 4, color: '#ffffff', weight: 1, fillColor: '#7c3aed', fillOpacity: 0.9, fill: true }),
});

// OCCURRENCE POINTS, TYPED, WITH THEIR OWN IDENTITY.
//
// The occurrence analysis hands over the precise public observations it measured, under `points` - the domain's own word
// for them (src/occurrence/context.js) - and each becomes a feature of the map's own occurrence kind. Identity is the
// pair the evidence is already keyed by: `<source>:<sourceRecordId>`, which is the key the occurrence service measures
// corridor distances with. The map therefore uses the identity the evidence uses, and invents none.
//
// A row that cannot become a feature - no durable source identity, or no usable point - is reported in `unidentified`
// rather than drawn somewhere approximate or named after something it is not.
export function occurrenceIdentity(row) {
  const source = typeof row?.source === 'string' && row.source.length ? row.source : null;
  const record = row?.sourceRecordId == null ? null : String(row.sourceRecordId);
  return source && record && record.length ? `${source}:${record}` : null;
}

export function occurrenceFeatures(overlay) {
  const features = [];
  const unidentified = [];
  const duplicates = [];
  // ONE POINT PER SOURCE RECORD. The analysis fetches records per search region, and the same public observation is
  // returned by more than one region when it sits near their boundary; identity is the record, so it is plotted once and
  // the repeat is reported rather than drawn twice at the same coordinate.
  const seen = new Set();
  for (const row of overlay?.points ?? []) {
    const occurrenceId = occurrenceIdentity(row);
    const point = toLatLngPoint(row?.location);
    if (!occurrenceId || !point) { unidentified.push(row); continue; }
    if (seen.has(occurrenceId)) { duplicates.push(row); continue; }
    seen.add(occurrenceId);
    features.push(Object.freeze({ kind: FEATURE_KIND.OCCURRENCE, occurrenceId, source: row.source,
      sourceRecordId: String(row.sourceRecordId), label: row.label ?? null, taxonomicGroup: row.taxonomicGroup ?? null,
      distanceToCorridorM: row.distanceToCorridorM ?? null,
      // The geometry is the row's own coordinate, in Leaflet order in `point` and in GeoJSON order in `geometry`.
      geometry: { type: 'Point', coordinates: [point[1], point[0]] }, point, style: OCCURRENCE_STYLE.point }));
  }
  return Object.freeze({ features: Object.freeze(features), unidentified: Object.freeze(unidentified),
    duplicates: Object.freeze(duplicates) });
}

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
    // THE LEADER GETS ITS OWN LAYER, CREATED FIRST SO IT DRAWS UNDER EVERYTHING ELSE: orientation belongs beneath the
    // roads and the overlays it orients, and a layer that is only ever written by selection can be cleared by selection.
    const layers = { context: leaflet.featureGroup(), results: leaflet.featureGroup(), saved: leaflet.featureGroup(),
      search: leaflet.featureGroup(), overlay: leaflet.featureGroup(), occurrence: leaflet.featureGroup(),
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
    // The leader currently drawn, so a diagnostic can read back exactly what is on the map - and nothing else.
    let activeContext = null;
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

    // MARKING A CLICK HANDLED, in Leaflet's own terms: `DomEvent.stopPropagation` sets `_stopped` on the original DOM
    // event, and Leaflet's `_fireDOMEvent` returns as soon as it sees that, so no further layer and not the map itself is
    // asked about the same click. Setting the flag directly keeps this working with an injected stand-in that has no
    // DomEvent, and is what the helper does anyway.
    function stopClick(event) {
      if (!event || typeof event !== 'object') return false;
      if (event.originalEvent) event.originalEvent._stopped = true;
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      return true;
    }
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
      if (hit) { cardToOpen = hit.id; onSelect({ id: hit.id, domain: hit.selectionDomain ?? null }); }
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
    // EVERY ROAD THE MAP DRAWS IS NORMALIZED HERE, ONCE. `paint` takes typed features and nothing else, so the two
    // callers that hold plain corridor descriptors - the results and the saved roads - hand them through this.
    function corridorFeatures(list) {
      return (list ?? []).map(corridor => corridorFeature(corridor,
        { selected: corridor?.id === selectedId, style: styleFor(corridor) }));
    }
    // ONE PAINT PATH, AND IT PAINTS TYPED FEATURES ONLY. Every family the map draws arrives here as a feature with a
    // kind: corridors and saved roads (normalized by `corridorFeatures`), the search geometry, the habitat buffer, the
    // habitat source features and the occurrence points. A row that has no kind is not a feature, so it is skipped and
    // counted: the map draws what a thing is, and nothing by resemblance. That is what stopped a habitat row or an
    // occurrence row from ever being drawn as a candidate-shaped line, and it is why this fallback is gone.
    function paint(layer, entries) {
      layer.clearLayers();
      // The cards follow the layers: a path that is no longer drawn cannot show a card.
      if (layer === layers.results) cardedPaths.clear();
      let drawn = 0;
      let skipped = 0;
      for (const entry of entries ?? []) {
        const contract = FEATURE_DOM[entry?.kind] ?? null;
        // NO KIND, NO IDENTITY, NO DRAWING. An untyped entry carries no role and no identity of its own, and giving it
        // one - as the removed fallback did, by treating it as a corridor - is precisely how a thing that is not a
        // corridor came to be selectable as one.
        if (!contract) { skipped += 1; continue; }
        const shapes = drawableShapes(entry);
        if (!shapes.length) { skipped += 1; continue; }
        for (const shape of shapes) {
          // `interactive` is the kind's own contract: a corridor can be clicked, and a family that cannot be is drawn
          // with that said in the layer itself rather than by hoping the z-order protects it.
          const options = { ...entry.style, interactive: contract.interactive };
          const path = shape.circle ? leaflet.circle(shape.point, { ...options, radius: shape.radiusM })
            : shape.rectangle ? leaflet.rectangle(shape.bounds, options)
              : shape.rings ? leaflet.polygon(shape.rings, options)
                : shape.point ? leaflet.circleMarker(shape.point, options)
                  : shape.line ? leaflet.polyline(shape.line, options) : null;
          if (!path) { skipped += 1; continue; }
          // A label is a tooltip, and a tooltip needs a layer that can be pointed at.
          if (entry.label && contract.interactive) path.bindTooltip?.(entry.label);
          // Drawing order is list order, so the map's stacking matches the order the person is reading.
          if (entry.card) {
            cardedPaths.set(entry.corridorId, path);
            path.bindPopup(entry.card);
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
          // ONLY A KIND THAT CAN BE CLICKED CARRIES A CORRIDOR ON ITS PATH. The map-level handler reads this identity to
          // decide whether a click has already been answered, so a feature with no corridor to name must not appear to
          // name one - not even as `undefined`.
          if (contract.clickable) path.corridorId = entry.corridorId;
          if (contract.clickable && typeof path.on === 'function') {
            path.on('click', event => {
              // PICK MODE KEEPS PRECEDENCE, AND KEEPS THE EVENT: the coordinate is the answer, so nothing here selects and
              // nothing here stops the click from reaching the map, which is what reports the coordinate.
              if (pickMode) return;
              // A click on the line asks for that corridor's card along with the selection, so the card survives the
              // re-draw the selection triggers.
              cardToOpen = entry.corridorId;
              // THE LINE'S ANSWER IS THE ONLY ANSWER FOR THIS CLICK. The click is not swallowed for the layer's own sake -
              // Leaflet's popup binding, which runs before this handler, is what opens the card - but once this handler
              // has answered, the event is marked handled so Leaflet does not also deliver it to the map, where the
              // proximity fallback would look for a corridor a second time. That mark is exactly what Leaflet consults
              // (Renderer/Map _fireDOMEvent returns on originalEvent._stopped), so this is propagation semantics, not
              // timing.
              stopClick(event);
              // The map adapter knows nothing about the store: it reports the identity and the collection it was drawn
              // from, and the application decides what that means.
              onSelect({ id: entry.corridorId, domain: entry.selectionDomain ?? null });
            });
          }
          const decorate = () => mark(path, featureAttributes(entry));
          if (typeof path.on === 'function') path.on('add', decorate);
          layer.addLayer(path);
          decorate();
          drawn += 1;
        }
      }
      return { drawn, skipped };
    }
    // SEARCH GEOMETRY: the request, not the processing extent. A radius search draws its centre and its requested radius;
    // a declared area draws the bounds of the search definition. Neither the processing bbox nor the published region's
    // own bounds are drawn: they are not what was asked for. The geometry itself is generated exactly as before - this is
    // the same input through the typed model, not a new computation - and the values the rest of the view reads back out
    // of it (`searchGeometry()`) are the same values.
    function setSearch(search) {
      layers.search.clearLayers();
      const features = searchFeatures(search);
      paint(layers.search, features);
      const centre = features.find(feature => feature.kind === FEATURE_KIND.SEARCH_CENTRE) ?? null;
      const radius = features.find(feature => feature.kind === FEATURE_KIND.SEARCH_RADIUS) ?? null;
      // Assigned only when the feature is there, exactly as the dedicated path did: a search with no centre leaves the
      // last one in place rather than silently clearing it.
      if (centre) activeCentre = centre.point;
      if (radius) activeRadiusM = radius.radiusM;
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
        const results = paint(layers.results, corridorFeatures(corridors));
        // Saved roads that are *not* in the visible set are drawn from their own descriptors; the same road is never
        // drawn twice simply because it is both a candidate and saved.
        const visible = new Set(corridors.map(corridor => corridor.id));
        paint(layers.saved, corridorFeatures(savedRoads.filter(road => !visible.has(road.id))));
        // THE HABITAT OVERLAY: the analysis buffer first, then the typed source features. The buffer is a typed feature
        // and is drawn under the roads (the results layer is repainted after this, in setSelected), so it can frame the
        // corridor without covering it or its selection styling; the source features are typed for the same reason.
        const buffer = habitatBufferFeature(overlay);
        // THE SOURCE FEATURES NO LONGER ARRIVE AS ROWS. Each is a habitat feature with its own identity, so a wetland
        // cannot be drawn as a candidate-shaped line and cannot be clicked into a selection.
        paint(layers.overlay, [...(buffer ? [buffer] : []), ...habitatFeatures(overlay).features]);
        // THE OCCURRENCE POINTS ARE TYPED TOO: each is a point with its own source identity, drawn above the habitat
        // overlay and, like every overlay family, unable to take a selection.
        paint(layers.occurrence, occurrenceFeatures(occurrenceOverlay).features);
        if (search !== undefined) setSearch(search);
        view.setSelected(selectedId);
        return { drawn: results.drawn, skipped: results.skipped, candidates: corridors.length };
      },
      // Selection changes appearance only. It is called on every list highlight precisely *because* it does not fit.
      setSelected(id) {
        selectedId = id ?? null;
        paint(layers.results, corridorFeatures(corridors));
        // The emphasised copy is drawn into its own layer so it sits above every other corridor regardless of where
        // it falls in the list order. Selection changes appearance only: it is called on every list highlight
        // precisely *because* it never moves the camera.
        layers.selected.clearLayers();
        const selected = corridors.find(corridor => corridor.id === selectedId) ?? null;
        // THE LEADER FOLLOWS THE SELECTION, AND ONLY THE SELECTION. It is normalized from the selected corridor's own
        // measured pair, so selecting another corridor replaces it, clearing the selection removes it, and a redraw that
        // leaves the selection alone leaves the same leader - it is never accumulated and never duplicated.
        activeContext = searchContextFeature(selected);
        layers.context.clearLayers();
        if (activeContext) paint(layers.context, [activeContext]);
        for (const line of toLatLngs(selected?.geometry) ?? []) {
          // THE EMPHASIS IS THE SAME CORRIDOR, SO IT SAYS SO. It is drawn outside `paint` because it is not another
          // feature - it is this corridor's own copy, above everything - but an anonymous path on a map whose whole
          // taxonomy is "a thing says what it is" is the one thing this family of work exists to remove. It stays
          // non-interactive, so it can never take the click the base copy answers.
          const emphasis = leaflet.polyline(line, { ...styleFor(selected), interactive: false }).addTo(layers.selected);
          mark(emphasis, featureAttributes(corridorFeature(selected, { selected: true })));
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
      // The leader currently drawn, as its own geometry: read-only, and the only way a committed test can check the two
      // endpoints it was normalized from without re-deriving them.
      contextGeometry: () => activeContext?.geometry ?? null,
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

