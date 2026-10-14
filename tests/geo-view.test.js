import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TILE_PROVIDERS, tileProvider } from '../src/map/basemap.js';
import { attributeName, basemapFailureNote, boundsOfGeometries, corridorFeature, createGeoView, drawableShapes,
  featureAttributes, featureShape, habitatBufferFeature, habitatFeatures, habitatIdentity, occurrenceFeatures,
  occurrenceIdentity, popupHtml, searchContextFeature, searchFeatures, toLatLngs, unavailableView, FEATURE_DOM,
  FEATURE_KIND }
  from '../src/map/geo-view.js';
import { createMapView } from '../src/map/index.js';

// THE MAP'S CONTRACT, WITHOUT A BROWSER.
//
// Leaflet is injected, so these tests exercise the rules that matter - one selection state, viewport ownership,
// failure containment, malformed geometry - by watching what the adapter asks the library to do. A fake library is
// enough for that, and it keeps the test about behaviour rather than about pixels.

function fakeLeaflet({ failMap = false } = {}) {
  const calls = { tileLayers: [], polylines: [], polygons: [], groups: [], markerLayers: [], circleLayers: [],
    rectangleLayers: [], opened: [], closed: 0, circles: 0, circleMarkers: 0, rectangles: 0, fits: [], removed: 0 };
  // The fake models the lifecycle that caused the real bug: a path has no DOM element until it is added, so a test
  // can tell the difference between stamping metadata before and after Leaflet has created the element.
  const layer = ({ createElementOnAdd = false } = {}) => ({ added: [], handlers: {}, element: null, attributes: {},
    getElement() { return this.element; },
    setAttribute(name, value) { this.attributes[name] = value; return this; },
    on(event, handler) { this.handlers[event] = handler; return this; },
    emit(event, payload) { this.handlers[event]?.(payload ?? {}); return this; },
    addTo(map) { this.added.push(map); this.element = { setAttribute: (n, v) => { this.attributes[n] = v; } };
      this.handlers.add?.(); return this; },
    addLayer(entry) { this.added.push(entry);
      if (entry && typeof entry === 'object' && !entry.element && (entry.handlers || entry.bindPopup)) {
        entry.element = { setAttribute: (name, value) => { entry.attributes[name] = value; } };
        entry.handlers.add?.();
      }
      return this; },
    clearLayers() { this.added.length = 0; return this; },
    bindPopup(html) { this.popup = html; return this; },
    openPopup() { calls.opened.push(this); return this; },
    bindTooltip(text) { this.tooltip = text; return this; } });
  const map = { handlers: {}, layers: [], bounds: [[38.1, -87.9], [38.5, -87.2]],
    on(event, handler) { this.handlers[event] = handler; return this; },
    off() {}, remove() { calls.removed += 1; },
    closePopup() { calls.closed += 1; return this; },
    setView(view) { this.view = view; return this; },
    // The camera, so a test can assert that a redraw left it exactly where it was.
    getCenter() { return { lat: (this.view?.[0] ?? 39), lng: (this.view?.[1] ?? -96) }; },
    getZoom() { return this.zoom ?? 4; },
    fitBounds(bounds, options) { calls.fits.push({ bounds, options }); this.bounds = bounds; return this; },
    getBounds() { return this.bounds; },
    addLayer(entry) { this.layers.push(entry); return this; },
    removeLayer(entry) { this.layers = this.layers.filter(item => item !== entry); return this; },
    hasLayer(entry) { return this.layers.includes(entry); } };
  const leaflet = { map() { if (failMap) throw new Error('no WebGL, no canvas, no map'); return map; },
    tileLayer(url, options) { const created = layer(); created.url = url; created.options = options;
      calls.tileLayers.push(created); return created; },
    // A path is created WITHOUT an element, exactly as Leaflet does.
    polyline(latlngs, options) { const created = layer({ createElementOnAdd: true }); created.latlngs = latlngs;
      created.options = options; calls.polylines.push(created); return created; },
    // A POLYGON IS RECORDED TOO, so a test can prove that today's map draws lines only: the fake must be able to say
    // "no polygon was created", which it cannot do if it has no polygon at all.
    polygon(latlngs, options) { const created = layer({ createElementOnAdd: true }); created.latlngs = latlngs;
      created.options = options; calls.polygons.push(created); return created; },
    circle(latlngs, options) { calls.circles += 1; const created = layer({ createElementOnAdd: true });
      created.latlngs = latlngs; created.options = options; calls.circleLayers.push(created); return created; },
    circleMarker(latlngs, options) { calls.circleMarkers += 1; const created = layer({ createElementOnAdd: true });
      created.latlngs = latlngs; created.options = options; calls.markerLayers.push(created); return created; },
    rectangle(latlngs, options) { calls.rectangles += 1; const created = layer({ createElementOnAdd: true });
      created.latlngs = latlngs; created.options = options; calls.rectangleLayers.push(created); return created; },
    featureGroup() { const created = layer(); calls.groups.push(created); return created; } };
  return { leaflet, map, calls };
}

const GEO = { type: 'LineString', coordinates: [[-87.5, 38.3], [-87.4, 38.31]] };
const corridor = (id, overrides = {}) => ({ id, name: `Road ${id}`, geometry: GEO, distanceFromCenterM: 5200,
  ranking: { score: 72.4, components: { wetland: { value: 74.7, measured: true }, water: { value: 40, measured: true },
    ecologicalVariety: { value: null, measured: false } } }, ...overrides });

test('the identifying attributes are named the way SVG keeps them', () => {
  // SVG preserves attribute case, so a camelCase key would produce data-corridorId and match no selector.
  assert.equal(attributeName('role'), 'data-role');
  assert.equal(attributeName('corridorId'), 'data-corridor-id');
  assert.equal(attributeName('selected'), 'data-selected');
  assert.equal(attributeName('data-spatial-extent'), 'data-spatial-extent');
});

test('geometry is converted to geographic coordinates, and malformed geometry is refused rather than thrown', () => {
  assert.deepEqual(toLatLngs(GEO), [[[38.3, -87.5], [38.31, -87.4]]], 'GeoJSON order in, Leaflet order out');
  assert.equal(toLatLngs({ type: 'Point', coordinates: [-87, 38] }), null);
  assert.equal(toLatLngs({ type: 'LineString', coordinates: [[-87, 38]] }), null, 'a single point is not a line');
  assert.equal(toLatLngs({ type: 'LineString', coordinates: [['x', 'y'], [-87, 38]] }), null);
  assert.deepEqual(boundsOfGeometries([GEO]), [[38.3, -87.5], [38.31, -87.4]]);
  assert.equal(boundsOfGeometries([{ type: 'Point' }]), null);
  assert.equal(attributeName('corridorId'), 'data-corridor-id', 'kebab-case, because SVG preserves attribute case');
});

test('one selection state: the list selects on the map, and the map reports clicks back', () => {
  const { leaflet, map } = fakeLeaflet();
  const selected = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => selected.push(selection?.id ?? null) });
  view.draw({ corridors: [corridor('a'), corridor('b')] });
  assert.equal(view.selectedId(), null);
  // The list's selection is applied to the map, and it does not move the camera.
  assert.equal(view.setSelected('b'), true);
  assert.equal(view.selectedId(), 'b');
  // A click on a corridor calls the application's selection callback with that corridor's id.
  map.handlers.click({ latlng: { lat: 38.3, lng: -87.5 } });
  assert.deepEqual(selected, ['a'], 'the nearest corridor is reported');
  assert.equal(view.selectedId(), 'b', 'the map never becomes a second source of truth');
});

// TWO CORRIDORS, ONE CLICK: the defect this guards against was a neighbouring road whose vertex sat nearer the
// click point winning the selection from the road that was actually clicked.
const NEAR = { id: 'corridor-near', name: 'Near Rd', distanceFromCenterM: 900,
  geometry: { type: 'LineString', coordinates: [[-87.5, 38.3], [-87.4, 38.31]] } };
const CLICKED = { id: 'corridor-clicked', name: 'Clicked Rd', distanceFromCenterM: 1609,
  geometry: { type: 'LineString', coordinates: [[-87.5201, 38.2801], [-87.42, 38.29]] } };
// THE TWO COLLECTIONS THE MAP DRAWS BESIDE EACH OTHER. A discovery result and a pilot/candidate corridor are drawn the
// same way and selected differently, so each descriptor says which one it came from; the id itself never does.
const DISCOVERY_ROAD = { id: 'drv1-river-rd-c455-s1', name: 'River Rd', selectionDomain: 'discovery',
  geometry: { type: 'LineString', coordinates: [[-87.53, 38.27], [-87.44, 38.30]] } };
// A CORRIDOR IN SEVERAL PARTS: one corridor, several paths, one identity and one collection.
const MULTI_PARTS = { id: 'corridor-multi', name: 'Multi Rd', distanceFromCenterM: 1200,
  geometry: { type: 'MultiLineString', coordinates: [[[-87.52, 38.28], [-87.44, 38.29]],
    [[-87.44, 38.29], [-87.4, 38.31]]] } };
// A DISCOVERY CORRIDOR WITH ITS OWN MEASURED CONTEXT: the centre the search was measured against and this corridor's
// own nearest point, exactly as the discovery result carries them.
const CONTEXT_ROAD = { id: 'drv1-near-rd-c1-s1', name: 'Near Rd', selectionDomain: 'discovery',
  searchCenter: [-87.60, 38.20], nearestCenterPoint: [-87.50, 38.30],
  geometry: { type: 'LineString', coordinates: [[-87.50, 38.30], [-87.44, 38.31]] } };
const PILOT_ROAD = { id: 'or-roads-cornelius-pass-rd', name: 'NW Cornelius Pass Rd', selectionDomain: 'candidate',
  geometry: { type: 'LineString', coordinates: [[-87.51, 38.26], [-87.45, 38.31]] } };

// A BUFFER THAT COVERS THE ROAD. The buffer fixture is deliberately a polygon around the corridor it belongs to, so the
// tests below exercise the case that matters: a road drawn inside a visible overlay must stay exactly as clickable as it
// was before the overlay existed.
const BUFFER_OVERLAY = Object.freeze({ candidateId: CLICKED.id, distanceM: 1000,
  bufferGeometry: { type: 'Polygon', coordinates: [[[-87.60, 38.20], [-87.30, 38.20], [-87.30, 38.40],
    [-87.60, 38.40], [-87.60, 38.20]]] } });

// THE HABITAT SOURCE ROWS, AS THE ANALYSIS HANDS THEM OVER: the fields the query returns and the geometry types it
// actually produces (wetlands are polygons and multipolygons, NHD flowlines are multilinestrings). The last row has no
// source feature id, which is the case that must be reported rather than named.
const HABITAT_OVERLAY = Object.freeze({ candidateId: CLICKED.id, distanceM: 1000,
  bufferGeometry: BUFFER_OVERLAY.bufferGeometry,
  features: [
    { layer: 'wetland', sourceFeatureId: 'W1', label: 'Freshwater Emergent Wetland', code: 'PEM1C',
      geometry: { type: 'Polygon', coordinates: [[[-87.53, 38.27], [-87.51, 38.27], [-87.51, 38.29], [-87.53, 38.27]]] } },
    { layer: 'flowline', sourceFeatureId: 'H1', label: 'Stream/River', code: null,
      geometry: { type: 'MultiLineString', coordinates: [[[-87.55, 38.25], [-87.52, 38.26]],
        [[-87.52, 38.26], [-87.5, 38.28]]] } },
    { layer: 'wetland', sourceFeatureId: 'W2', label: 'Freshwater Pond', code: 'PUBF',
      geometry: { type: 'MultiPolygon', coordinates: [[[[-87.48, 38.31], [-87.46, 38.31], [-87.46, 38.33], [-87.48, 38.31]]],
        [[[-87.45, 38.35], [-87.44, 38.35], [-87.44, 38.36], [-87.45, 38.35]]]] } },
    { layer: 'flowline', sourceFeatureId: null, label: 'Stream/River', code: null,
      geometry: { type: 'MultiLineString', coordinates: [[[-87.6, 38.2], [-87.59, 38.21]]] } },
  ] });

// THE OCCURRENCE POINTS, AS THE OCCURRENCE ANALYSIS HANDS THEM OVER: the domain's own `points` rows, with the fields
// src/occurrence/context.js produces. The third row has no source record id, which is the case that is reported rather
// than named, and the first two are the two sources the product queries.
const OCCURRENCE_OVERLAY = Object.freeze({ candidateId: CLICKED.id, excluded: 2,
  points: [
    { source: 'inaturalist', sourceRecordId: 'obs-1', label: 'Red-tailed Hawk', taxonomicGroup: 'birds',
      location: [-87.51, 38.285], distanceToCorridorM: 38.2 },
    { source: 'ebird', sourceRecordId: 'S12345', label: 'Red-tailed Hawk', taxonomicGroup: 'birds',
      location: [-87.44, 38.295], distanceToCorridorM: 121 },
    { source: 'inaturalist', sourceRecordId: null, label: 'Red-tailed Hawk', location: [-87.5, 38.28] },
  ] });

test('a click on a drawn line selects that corridor, not the nearest vertex', () => {
  const { leaflet, calls } = fakeLeaflet();
  const chosen = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => chosen.push(selection?.id ?? null) });
  view.draw({ corridors: [CLICKED, NEAR] });
  const pathOf = id => calls.polylines.filter(path => path.corridorId === id).at(-1);
  // The click point is a hair from NEAR's vertex and nowhere near CLICKED's, yet the person clicked CLICKED's line.
  const event = { latlng: { lat: 38.3001, lng: -87.4999 }, propagatedFrom: pathOf(CLICKED.id) };
  pathOf(CLICKED.id).emit('click', event);
  assert.deepEqual(chosen, [CLICKED.id], 'the line the person clicked is the corridor they get');
});

test('a line click is answered once, and the proximity fallback does not override it', () => {
  const { leaflet, map, calls } = fakeLeaflet();
  const chosen = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => chosen.push(selection?.id ?? null) });
  view.draw({ corridors: [CLICKED, NEAR] });
  const path = calls.polylines.filter(item => item.corridorId === CLICKED.id).at(-1);
  const event = { latlng: { lat: 38.3001, lng: -87.4999 }, propagatedFrom: path };
  path.emit('click', event);
  // Leaflet bubbles the same click to the map; the map must recognise that a line already answered it.
  map.handlers.click(event);
  assert.deepEqual(chosen, [CLICKED.id], 'one click selects one corridor, once');
});

test('pick mode keeps precedence: a line click does not select the corridor', () => {
  const { leaflet, calls } = fakeLeaflet();
  const chosen = [];
  const picked = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => chosen.push(selection?.id ?? null),
    onPickCoordinate: coordinate => picked.push(coordinate) });
  view.draw({ corridors: [CLICKED] });
  view.setPickMode(true);
  calls.polylines.filter(item => item.corridorId === CLICKED.id).at(-1).emit('click', { latlng: { lat: 38.29, lng: -87.5 } });
  assert.deepEqual(chosen, [], 'pick mode never selects a corridor');
});

test('a click on the map itself still uses proximity, and selects nothing when nothing is near', () => {
  const { leaflet, map } = fakeLeaflet();
  const chosen = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => chosen.push(selection?.id ?? null) });
  view.draw({ corridors: [NEAR] });
  map.handlers.click({ latlng: { lat: 38.3001, lng: -87.4999 } });
  assert.deepEqual(chosen, [NEAR.id], 'a click just off the line resolves the nearest corridor');
  map.handlers.click({ latlng: { lat: 12.34, lng: 56.78 } });
  assert.deepEqual(chosen, [NEAR.id], 'and a click far from everything selects nothing new');
});

test('a direct line click does not move the viewport', () => {
  const { leaflet, calls, map } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet, onSelect: () => {} });
  view.draw({ corridors: [CLICKED] });
  const path = calls.polylines.filter(item => item.corridorId === CLICKED.id).at(-1);
  const before = { center: map.bounds, count: view.fitCount() };
  path.emit('click', { latlng: { lat: 38.28, lng: -87.5 }, propagatedFrom: path });
  assert.equal(view.fitCount(), before.count, 'a selection is not a camera move');
  assert.deepEqual(map.bounds, before.center);
});

test('the viewport belongs to the person: drawing and selecting never fit', () => {
  const { leaflet, calls } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  view.draw({ corridors: [corridor('a')] });
  view.setSelected('a');
  view.draw({ corridors: [corridor('a'), corridor('b')] });
  view.setSelected('b');
  view.setSavedRoads([corridor('saved')]);
  view.setOuting({ id: 'o1', roadIds: ['a'] });
  assert.equal(calls.fits.length, 0, 'nothing fits until it is asked to');
  assert.equal(view.fitResults(), true);
  assert.equal(view.fitSelected(), true);
  assert.equal(calls.fits.length, 2);
  assert.deepEqual(calls.fits[1].bounds, [[38.3, -87.5], [38.31, -87.4]], 'Fit selected fits the selected corridor');
});

test('fit controls refuse honestly when there is nothing to fit', () => {
  const { leaflet, calls } = fakeLeaflet();
  const notices = [];
  const view = createGeoView({ style: {} }, { leaflet, onNotice: notice => notices.push(notice) });
  view.draw({ corridors: [{ id: 'broken', name: 'Broken', geometry: { type: 'Point', coordinates: [0, 0] } }] });
  assert.equal(view.fitResults(), false);
  assert.equal(view.fitSelected(), false);
  assert.equal(calls.fits.length, 0);
  assert.equal(notices[0].kind, 'empty');
});

test('drawing reports what it drew and what it skipped, and never crashes on bad geometry', () => {
  const { leaflet } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  const outcome = view.draw({ corridors: [corridor('a'), { id: 'bad', geometry: null }, corridor('c')],
    savedIds: ['c'], dismissedIds: [] });
  assert.deepEqual(outcome, { drawn: 2, skipped: 1, candidates: 3 });
});

test('basemap failure is a note, not a discovery failure', () => {
  const { leaflet, calls } = fakeLeaflet();
  const notices = [];
  const view = createGeoView({ style: {} }, { leaflet, onBasemap: notice => notices.push(notice) });
  view.draw({ corridors: [corridor('a')] });
  const tiles = calls.tileLayers[0];
  assert.equal(tiles.added.length, 1, 'the provider is installed as a tile layer on the map');
  assert.match(tiles.url, /^https:\/\/tile\.openstreetmap\.org\//);
  assert.match(tiles.options.attribution, /OpenStreetMap/, 'attribution is mandatory and visible');
  tiles.handlers.tileerror();
  assert.equal(view.basemapStatus(), 'unavailable');
  assert.match(notices.at(-1).note, /tiles could not be loaded/);
  assert.equal(view.draw({ corridors: [corridor('a')] }).drawn, 1, 'the geometry is unaffected');
});

  assert.deepEqual(toLatLngs(GEO), [[[38.3, -87.5], [38.31, -87.4]]]);

test('a mapping library that cannot initialise leaves the rest of the application untouched', () => {
  const view = createGeoView({ style: {} }, { leaflet: fakeLeaflet({ failMap: true }).leaflet });
  assert.equal(view.available, false);
  assert.match(view.reason, /no WebGL/);
  for (const method of ['draw', 'setSelected', 'setSearch', 'fitResults', 'fitSelected', 'setSavedRoads',
    'setOuting', 'setPickMode', 'setBasemap']) {
    assert.equal(typeof view[method], 'function', `${method} must exist so callers need no special case`);
    assert.equal(view[method](), false, `${method} reports failure instead of throwing`);
  }
  assert.equal(unavailableView('no library').draw(), false);
});

test('the search request is drawn as a centre and a requested radius, never as the processing box', () => {
  const { leaflet, calls } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  view.setSearch({ kind: 'radius', center: [-87.5, 38.3], radiusMiles: 25 });
  assert.equal(calls.circleMarkers, 1);
  assert.equal(calls.circles, 1);
  assert.equal(calls.rectangles, 0, 'a radius search must not be drawn as a box');
  view.setSearch({ kind: 'box', bounds: [-88, 38, -87, 39] });
  assert.equal(calls.rectangles, 1, 'a declared box search is drawn as the box it is');
});

test('pick mode hands a coordinate back and does not touch the search definition', () => {
  const { leaflet, map } = fakeLeaflet();
  const picked = [];
  const selected = [];
  const view = createGeoView({ style: {} }, { leaflet, onPickCoordinate: coordinate => picked.push(coordinate),
    onSelect: selection => selected.push(selection?.id ?? null) });
  view.draw({ corridors: [corridor('a')] });
  view.setPickMode(true);
  map.handlers.click({ latlng: { lat: 38.3, lng: -87.5 } });
  assert.deepEqual(picked, [[-87.5, 38.3]], 'the map is an input surface, not the search definition');
  assert.deepEqual(selected, [], 'a pick does not select a corridor');
  view.setPickMode(false);
  map.handlers.click({ latlng: { lat: 38.3, lng: -87.5 } });
  assert.deepEqual(selected, ['a']);
});

test('the card on the map names the corridor it describes, from that corridor alone', () => {
  // IDENTITY IS A FIELD OF THE DESCRIPTOR, never something read back out of the road name: the id, the name, the model
  // version and the score on one card all have to come from the same object.
  const mine = { id: 'corridor-mine', name: 'Mine Rd', ranking: { version: 'naturalist-interest-v1', score: 61.5 },
    geometry: { type: 'LineString', coordinates: [[-87.5, 38.3], [-87.4, 38.31]] },
    distanceFromCenterM: 1609.344, components: { wetland: 'strong' } };
  const html = popupHtml(mine);
  assert.match(html, /data-corridor-id="corridor-mine"/, 'the card carries the descriptor id');
  assert.match(html, /data-ranking-version="naturalist-interest-v1"/, 'and the model that scored it');
  assert.match(html, /Mine Rd/);
  assert.match(html, /Naturalist interest 61\.5/);
  // A card built from another corridor cannot inherit either the id or the name of this one.
  const other = popupHtml({ id: 'corridor-other', name: 'Other Rd', ranking: { version: 'v9' } });
  assert.match(other, /data-corridor-id="corridor-other"/);
  assert.ok(!/corridor-mine/.test(other), 'one card never claims another corridor identity');
  assert.ok(!/Mine Rd/.test(other), 'nor another corridor name');
});

test('each drawn path carries the card for its own corridor', () => {
  const { leaflet, calls } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  view.draw({ corridors: [CLICKED, NEAR] });
  const cards = calls.polylines.filter(path => path.popup).map(path => path.popup);
  assert.ok(cards.length >= 2, 'both corridors explain themselves on the map');
  // A corridor may be drawn in more than one layer (a casing under the carriageway), so what matters is that the set of
  // identities on the map is exactly the set of corridors drawn, and that no card borrows another corridor's name.
  const identities = new Set(cards.map(html => (html.match(/data-corridor-id="([^"]*)"/) ?? [])[1]));
  assert.deepEqual([...identities].sort(), [CLICKED.id, NEAR.id].sort(), 'the map names exactly the corridors drawn');
  const of = id => cards.find(html => html.includes(`data-corridor-id="${id}"`));
  assert.ok(of(CLICKED.id).includes('Clicked Rd') && !of(CLICKED.id).includes('Near Rd'),
    'a corridor card names only its own road');
  assert.ok(of(NEAR.id).includes('Near Rd') && !of(NEAR.id).includes('Clicked Rd'),
    'and the neighbour names only its own');
});

test('a click on a line opens that corridor card, after the re-draw the selection causes', () => {
  // THE CARD MUST SURVIVE THE RE-DRAW. Selecting a corridor makes the application re-render the map, which clears every
  // layer: any card Leaflet opened as part of the click dies with its layer. The card is therefore opened against the
  // layer that exists *after* the re-draw, and it is the clicked corridor's card.
  const { leaflet, calls } = fakeLeaflet();
  const selected = [];
  let view = null;
  view = createGeoView({ style: {} }, { leaflet, onSelect: selection => {
    selected.push(selection?.id ?? null);
    view.draw({ corridors: [CLICKED, NEAR], selectedId: selection?.id ?? null });
  } });
  view.draw({ corridors: [CLICKED, NEAR] });
  const path = calls.polylines.filter(item => item.corridorId === CLICKED.id).at(-1);
  path.emit('click', { latlng: { lat: 38.29, lng: -87.5 }, propagatedFrom: path });
  assert.deepEqual(selected, [CLICKED.id], 'the line click selected its own corridor once');
  assert.equal(calls.opened.length, 1, 'exactly one card is opened, not none and not several');
  assert.match(calls.opened[0].popup, new RegExp(`data-corridor-id="${CLICKED.id}"`),
    'and the card opened is the clicked corridor card');
  assert.equal(calls.closed, 1, 'any previous card is closed first, so only one is ever open');
});

test('clicking a second corridor leaves the second corridor as the active card', () => {
  const { leaflet, calls } = fakeLeaflet();
  let view = null;
  view = createGeoView({ style: {} }, { leaflet, onSelect: selection => view.draw({ corridors: [CLICKED, NEAR], selectedId: selection?.id ?? null }) });
  view.draw({ corridors: [CLICKED, NEAR] });
  const pathOf = id => calls.polylines.filter(item => item.corridorId === id).at(-1);
  pathOf(CLICKED.id).emit('click', { latlng: { lat: 38.29, lng: -87.5 }, propagatedFrom: pathOf(CLICKED.id) });
  pathOf(NEAR.id).emit('click', { latlng: { lat: 38.3, lng: -87.5 }, propagatedFrom: pathOf(NEAR.id) });
  const last = calls.opened.at(-1).popup;
  assert.match(last, new RegExp(`data-corridor-id="${NEAR.id}"`), 'the corridor clicked last owns the active card');
  assert.ok(!last.includes(`data-corridor-id="${CLICKED.id}"`), 'and the earlier corridor card is not the active one');
});

test('a multi-part corridor is drawn as several paths, each naming that same corridor, each clickable', () => {
  // MULTILINESTRING GEOMETRY IS NOT FLATTENED. A corridor whose geometry arrives in several parts is drawn as one
  // path per part, and every part carries the corridor's identity: any visible segment must select the corridor the
  // person can see, which is the same contract the browser gate clicks through at Portland.
  const MULTI = { id: 'corridor-multi', name: 'Multi Rd', distanceFromCenterM: 1200,
    geometry: { type: 'MultiLineString', coordinates: [
      [[-87.50, 38.30], [-87.40, 38.31]],
      [[-87.39, 38.32], [-87.30, 38.33]]] } };
  const { leaflet, calls } = fakeLeaflet();
  const selected = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => selected.push(selection?.id ?? null) });
  view.draw({ corridors: [MULTI] });
  // One paint: a draw paints the results layer and then repaints it to mark the selection, so the paths under test are
  // the ones a single paint creates. (calls.polylines is the creation log; the layer holds the latest paint.)
  const before = calls.polylines.length;
  view.setSelected(MULTI.id);
  const parts = calls.polylines.slice(before).filter(path => path.corridorId === MULTI.id);
  assert.equal(parts.length, 2, 'both parts of the corridor are drawn, not merged into one');
  for (const part of parts) {
    assert.equal(part.attributes['data-corridor-id'], MULTI.id, 'every part names the corridor it belongs to');
    assert.equal(part.attributes['data-role'], 'candidate', 'and is a clickable candidate segment');
    assert.match(part.popup, new RegExp(`data-corridor-id="${MULTI.id}"`), 'and offers that corridor card');
    part.emit('click', { latlng: { lat: 38.3, lng: -87.45 }, propagatedFrom: part });
  }
  assert.deepEqual(selected, [MULTI.id, MULTI.id], 'either part selects that corridor, and only that corridor');
});

test('the map factory has one implementation: the geographic view', () => {
  // THERE IS NO SECOND RENDERER AND NO FALLBACK SWITCH. The factory hands back the geographic view, or a view that says
  // it is unavailable - never a different kind of map. The diagnostic it exposes is read-only and deliberately small.
  const { leaflet } = fakeLeaflet();
  const container = { style: {} };
  try {
    const view = createMapView(container, { leaflet });
    assert.equal(globalThis.__RN_MAP.implementation, 'geo');
    assert.equal(globalThis.__RN_MAP.available, true);
    assert.deepEqual(view.missingMethods, [], 'the geographic view offers every documented method');
    for (const name of ['draw', 'setSearch', 'setSelected', 'setSavedRoads', 'setOuting', 'setPickMode', 'setBasemap',
      'fitResults', 'fitSelected', 'destroy', 'contextGeometry']) {
      assert.equal(typeof view[name], 'function', `the application may call ${name}`);
    }
    // The diagnostic is what the committed browser gate reads, and nothing more: a convenience added here would be a
    // second source of truth the application could start consulting.
    assert.deepEqual(Object.keys(globalThis.__RN_MAP).sort(),
      ['available', 'camera', 'contextGeometry', 'fitCount', 'implementation', 'movements', 'note', 'searchGeometry']);
  } finally { delete globalThis.__RN_MAP; }
});

test('a map that cannot initialise says so instead of becoming another renderer', () => {
  const broken = { map() { throw new Error('no WebGL, no canvas, no map'); } };
  const container = { style: {} };
  try {
    const view = createMapView(container, { leaflet: broken });
    assert.equal(view.available, false, 'the view reports that it is unavailable');
    assert.equal(globalThis.__RN_MAP.available, false);
    assert.equal(globalThis.__RN_MAP.implementation, 'unavailable', 'and says which view is running');
    assert.equal(view.draw({ corridors: [] }), false, 'drawing reports failure rather than throwing');
    assert.equal(view.fitResults(), false);
    assert.equal(globalThis.__RN_MAP.fitCount(), 0, 'and no camera was ever created to move');
    assert.equal(globalThis.__RN_MAP.camera(), null);
  } finally { delete globalThis.__RN_MAP; }
});

test('the map never reads storage, and the popup explains without a second evidence panel', () => {
  const source = readFileSync(new URL('../src/map/geo-view.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  assert.ok(!/localStorage|sessionStorage/.test(source), 'the state layer owns saved roads, not the map');
  assert.ok(!/fetch\(|XMLHttpRequest/.test(source), 'the map requests no data of its own');
  const html = popupHtml(corridor('a'));
  assert.match(html, /Naturalist interest 72\.4/);
  assert.match(html, /Wetland context: strong/);
  assert.match(html, /Water context: moderate/);
  assert.match(html, /Ecological variety: not measured/);
  assert.match(html, /3\.2 mi from search centre/);
  assert.match(popupHtml({ name: '<script>x</script>' }), /&lt;script&gt;/, 'popup text is escaped');
});

test('the tile provider is declared once, completely, and is replaceable', () => {
  const provider = tileProvider();
  assert.equal(provider.id, 'osm');
  assert.ok(Object.keys(TILE_PROVIDERS).length >= 1);
  assert.throws(() => tileProvider('not-a-provider'), /Unknown tile provider/);
  assert.equal(typeof basemapFailureNote(provider), 'string');
  const { leaflet, calls } = fakeLeaflet();
  const replacement = { id: 'test', label: 'Test', urlTemplate: 'https://tiles.example.test/{z}/{x}/{y}.png',
    attribution: 'Test tiles', maxZoom: 12 };
  createGeoView({ style: {} }, { leaflet, provider: replacement });
  assert.match(calls.tileLayers[0].url, /tiles\.example\.test/);
  assert.equal(calls.tileLayers[0].options.attribution, 'Test tiles');
  createGeoView({ style: {} }, { leaflet, provider: null });
  assert.equal(calls.tileLayers.length, 1, 'no provider means no tile layer, and geometry still draws');
});


// THE FEATURE TAXONOMY AND THE DOM IDENTITY TABLE.
//
// This slice introduces the abstraction and nothing else: the map paints what it painted before, and these tests pin the
// two things the overlay slices will depend on - the declared families, and the rule that a kind's identity is its own.
test('the taxonomy declares every family, and only a corridor is a candidate', () => {
  assert.deepEqual(Object.values(FEATURE_KIND).sort(),
    ['corridor', 'habitat', 'habitat-buffer', 'occurrence', 'outing', 'search-center', 'search-context',
      'search-radius', 'search-region']);
  const roles = Object.values(FEATURE_DOM).map(contract => contract.role);
  assert.equal(roles.filter(role => role === 'candidate').length, 1, 'one kind is the candidate, and it is the corridor');
  assert.equal(FEATURE_DOM[FEATURE_KIND.CORRIDOR].role, 'candidate');
  assert.equal(FEATURE_DOM[FEATURE_KIND.CORRIDOR].interactive, true, 'a corridor is a clickable family');
  // TWO KINDS ARE ROADS, AND ONLY TWO. A road can be drawn as a discovery candidate or as a member of the person's own
  // plan, and both answer a click by selecting exactly the road they were drawn for; every overlay family stays
  // unselectable, so a wetland or a species point can never take a selection. The outing role is deliberately NOT
  // 'candidate': a plan member is not a discovery result, and nothing reading the DOM may confuse the two.
  const ROAD_KINDS = [FEATURE_KIND.CORRIDOR, FEATURE_KIND.OUTING];
  for (const kind of ROAD_KINDS) {
    assert.equal(FEATURE_DOM[kind].clickable, true, `${kind} answers a click by selecting its own road`);
    assert.equal(FEATURE_DOM[kind].idAttribute, 'corridorId', `${kind} names its road under the corridor attribute`);
  }
  assert.notEqual(FEATURE_DOM[FEATURE_KIND.OUTING].role, FEATURE_DOM[FEATURE_KIND.CORRIDOR].role,
    'a plan member is not drawn as a discovery candidate');
  for (const [kind, contract] of Object.entries(FEATURE_DOM)) {
    assert.ok(contract.role, `${kind} declares a role`);
    if (ROAD_KINDS.includes(kind)) continue;
    assert.notEqual(contract.clickable, true, `${kind} is not a selection target`);
    // The search centre and its radius are interactive because they carry tooltips, exactly as they do today:
    // interactivity is how a tooltip can be pointed at, and it is not the same thing as being clickable.
    if (kind !== FEATURE_KIND.SEARCH_CENTRE && kind !== FEATURE_KIND.SEARCH_RADIUS) {
      assert.notEqual(contract.interactive, true, `${kind} is not interactive`);
    }
  }
});

test('the identity table gives each kind its own attribute, and a kind without an identity writes none', () => {
  assert.deepEqual(featureAttributes({ kind: FEATURE_KIND.CORRIDOR, corridorId: 'corridor-a', selected: true }),
    { role: 'candidate', corridorId: 'corridor-a', selected: true }, 'the corridor contract, unchanged');
  assert.deepEqual(featureAttributes({ kind: FEATURE_KIND.HABITAT, habitatId: 'wetland:W1' }),
    { role: 'habitat', habitatId: 'wetland:W1' });
  assert.deepEqual(featureAttributes({ kind: FEATURE_KIND.HABITAT_BUFFER, corridorId: 'corridor-a' }),
    { role: 'habitat-buffer', habitatCorridorId: 'corridor-a' },
    'the buffer names its corridor under its own attribute, so no candidate selector can match it');
  assert.deepEqual(featureAttributes({ kind: FEATURE_KIND.OCCURRENCE, occurrenceId: 'inaturalist:obs-1' }),
    { role: 'occurrence', occurrenceId: 'inaturalist:obs-1' });
  assert.deepEqual(featureAttributes({ kind: FEATURE_KIND.SEARCH_CONTEXT, corridorId: 'corridor-a' }),
    { role: 'search-context', corridorId: 'corridor-a' });
  assert.deepEqual(featureAttributes({ kind: FEATURE_KIND.SEARCH_REGION }), { role: 'search-region' });
  // A feature with no identity of its own is not given one, and habitat is never handed a corridor id.
  assert.deepEqual(featureAttributes({ kind: FEATURE_KIND.HABITAT, habitatId: null }), { role: 'habitat' });
  assert.deepEqual(featureAttributes({ kind: 'not-a-kind' }), {});
});

test('a corridor descriptor is normalized into the corridor feature, and the card follows the descriptor', () => {
  const feature = corridorFeature({ ...CLICKED, ranking: { version: 'naturalist-interest-v1', score: 61.5 } },
    { selected: true, style: { color: '#b45309', weight: 6, opacity: 1 } });
  assert.equal(feature.kind, FEATURE_KIND.CORRIDOR);
  assert.equal(feature.corridorId, CLICKED.id);
  assert.equal(feature.geometry, CLICKED.geometry, 'the geometry is the descriptor own, not a copy of it');
  assert.deepEqual(feature.style, { color: '#b45309', weight: 6, opacity: 1 });
  assert.equal(feature.selected, true);
  assert.match(feature.card, new RegExp(`data-corridor-id="${CLICKED.id}"`), 'and it carries the corridor card');
  const uncarded = corridorFeature({ id: 'no-distance', name: 'No distance', geometry: CLICKED.geometry });
  assert.equal(uncarded.card, null, 'a corridor with no measured distance from the centre shows no card');
  assert.deepEqual(uncarded.style, corridorFeature({ id: 'x', geometry: CLICKED.geometry }).style,
    'and wears the normal line style by default');
});

test('search geometry is typed: the same centre, the same radius, the same roles, the same non-interaction', () => {
  const { leaflet, calls } = fakeLeaflet();
  const selected = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => selected.push(selection?.id ?? null) });
  const search = { kind: 'radius', center: [-87.5, 38.3], radiusMiles: 25, bounds: [-88, 37, -87, 39],
    regionBounds: [-124, 42, -116, 46] };
  view.setSearch(search);

  // The descriptors: the request, in Leaflet order, with the radius the request asked for.
  const features = searchFeatures(search);
  assert.deepEqual(features.map(feature => feature.kind), ['search-center', 'search-radius']);
  assert.deepEqual(features[0].point, [38.3, -87.5], 'the centre is the searched place, [lat, lon] for Leaflet');
  assert.deepEqual(features[0].geometry.coordinates, [-87.5, 38.3], 'and it is a point in GeoJSON order internally');
  assert.equal(features[1].radiusM, 25 * 1609.344, 'the radius is the request, converted once and not recomputed');
  assert.equal(features[0].label, 'Search centre');
  assert.equal(features[1].label, 'Requested search radius');

  // What reached the map: a centre marker and a radius circle, each with its own role and no corridor identity.
  assert.equal(calls.circleMarkers, 1, 'the centre is a marker');
  assert.equal(calls.circles, 1, 'the radius is a circle');
  assert.equal(calls.rectangles, 0, 'and the bounds the radius happens to span are never drawn as a box');
  assert.equal(calls.markerLayers[0].attributes['data-role'], 'search-center');
  assert.equal(calls.circleLayers[0].attributes['data-role'], 'search-radius');
  for (const path of [...calls.markerLayers, ...calls.circleLayers]) {
    assert.ok(!('data-corridor-id' in path.attributes), 'search geometry never carries a corridor identity');
    assert.ok(!('data-habitat-id' in path.attributes));
  }
  // The centre and the radius keep the tooltips they have today, so they stay interactive; neither is a selection
  // target, and a click on either invokes no selection even though it bubbles.
  assert.equal(calls.markerLayers[0].options.interactive, true);
  assert.equal(calls.circleLayers[0].options.interactive, true);
  assert.equal(calls.markerLayers[0].tooltip, 'Search centre');
  assert.equal(calls.circleLayers[0].tooltip, 'Requested search radius');
  assert.notEqual(FEATURE_DOM[FEATURE_KIND.SEARCH_CENTRE].clickable, true);
  assert.notEqual(FEATURE_DOM[FEATURE_KIND.SEARCH_RADIUS].clickable, true);
  calls.markerLayers[0].emit('click', { latlng: { lat: 38.29, lng: -87.5 } });
  calls.circleLayers[0].emit('click', { latlng: { lat: 38.29, lng: -87.5 } });
  assert.deepEqual(selected, [], 'search geometry cannot select a corridor');

  // The values the rest of the view reads back are the same values the dedicated path produced.
  assert.deepEqual(view.searchGeometry(), { center: [38.3, -87.5], radiusM: 25 * 1609.344 });
});

test('a declared search area is typed without inventing geometry, and processing bounds are never search geometry', () => {
  // The declared box is drawn only when the search definition carries one - the same condition as before - and the
  // bounds the app uses internally for a radius search are not it.
  assert.deepEqual(searchFeatures({ kind: 'radius', center: [-87.5, 38.3], radiusMiles: 25, bounds: [-88, 37, -87, 39] })
    .map(feature => feature.kind), ['search-center', 'search-radius']);
  assert.deepEqual(searchFeatures({ kind: 'bbox', center: null, radiusMiles: null, bounds: [-88, 37, -87, 39],
    regionBounds: [-124, 42, -116, 46] }), [], 'the app bbox preview is not drawn as the user search geometry');
  const declared = searchFeatures({ kind: 'box', bounds: [-88, 37, -87, 39] });
  assert.deepEqual(declared.map(feature => feature.kind), ['search-region']);
  assert.deepEqual(featureAttributes(declared[0]), { role: 'search-region' });
  assert.deepEqual(drawableShapes(declared[0]), [{ rectangle: true, bounds: [[37, -88], [39, -87]] }],
    'the declared extent, [minLon, minLat, maxLon, maxLat] in and corners out');
  assert.equal(FEATURE_DOM[FEATURE_KIND.SEARCH_REGION].interactive, false, 'and it is not interactive');
  assert.deepEqual(searchFeatures(null), []);
});

test('the shape reader knows lines, areas and points, and refuses anything else', () => {
  assert.equal(featureShape({ type: 'LineString' }), 'line');
  assert.equal(featureShape({ type: 'MultiLineString' }), 'line');
  assert.equal(featureShape({ type: 'Polygon' }), 'area');
  assert.equal(featureShape({ type: 'MultiPolygon' }), 'area');
  assert.equal(featureShape({ type: 'Point' }), 'point');
  assert.equal(featureShape({ type: 'GeometryCollection' }), null);
  assert.deepEqual(drawableShapes({ geometry: { type: 'LineString', coordinates: [[-87.5, 38.3], [-87.4, 38.31]] } }),
    [{ line: [[38.3, -87.5], [38.31, -87.4]] }], 'GeoJSON order in, Leaflet order out');
  assert.deepEqual(drawableShapes({ geometry: { type: 'Point', coordinates: [-87.5, 38.3] } }),
    [{ point: [38.3, -87.5] }]);
  assert.deepEqual(drawableShapes({ geometry: { type: 'Polygon',
    coordinates: [[[-87.5, 38.3], [-87.4, 38.3], [-87.4, 38.4]]] } }),
  [{ rings: [[[38.3, -87.5], [38.3, -87.4], [38.4, -87.4]]] }]);
  assert.deepEqual(drawableShapes({ geometry: { type: 'Polygon', coordinates: [[[-87.5, 38.3], [-87.4, 38.3]]] } }), [],
    'a ring with two points is not a polygon');
  assert.deepEqual(drawableShapes({ geometry: null }), []);
});

test('the corridor DOM contract is unchanged by the typed path, and one click still selects one corridor', () => {
  const { leaflet, calls, map } = fakeLeaflet();
  const selected = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => selected.push(selection?.id ?? null) });
  view.draw({ corridors: [CLICKED, NEAR], selectedId: CLICKED.id });
  // The clickable copy is the base one; the emphasis drawn above it is stamped with the same corridor but is not
  // interactive, so it can never be what a click reaches.
  const path = calls.polylines.filter(item => item.attributes['data-corridor-id'] === CLICKED.id
    && item.options.interactive).at(-1);
  assert.equal(path.attributes['data-role'], 'candidate', 'the role the gate selects on');
  assert.equal(path.attributes['data-corridor-id'], CLICKED.id);
  assert.equal(path.attributes['data-selected'], 'true');
  assert.equal(path.options.interactive, true, 'a corridor is clickable, as it was');
  assert.equal(path.corridorId, CLICKED.id, 'and the map-level handler still sees which line answered');
  assert.match(path.popup, new RegExp(`data-corridor-id="${CLICKED.id}"`), 'the card is bound the same way');
  path.emit('click', { latlng: { lat: 38.29, lng: -87.5 }, propagatedFrom: path });
  assert.deepEqual(selected, [CLICKED.id], 'the line selects its own corridor');
  // A click a line has answered is not answered again by proximity: the guard reads the same identity off the path.
  map.handlers.click({ latlng: { lat: 38.285, lng: -87.52 }, propagatedFrom: path });
  assert.deepEqual(selected, [CLICKED.id], 'one click, one corridor');
});

test('habitat source rows normalize into their own typed family, with identity from the row', () => {
  const { features, unidentified } = habitatFeatures(HABITAT_OVERLAY);
  assert.equal(features.length, 3, 'every source row with an identity becomes a feature');
  const [wetland, flowline, pond] = features;
  assert.equal(wetland.kind, FEATURE_KIND.HABITAT);
  assert.equal(wetland.habitatId, 'wetland:W1', 'the layer and the source dataset\'s own feature id');
  assert.equal(flowline.habitatId, 'flowline:H1');
  assert.equal(pond.habitatId, 'wetland:W2');
  assert.equal(wetland.layer, 'wetland');
  assert.equal(wetland.sourceFeatureId, 'W1');
  assert.equal(wetland.label, 'Freshwater Emergent Wetland');
  assert.equal(wetland.geometry, HABITAT_OVERLAY.features[0].geometry, 'the row\'s own geometry, not a copy of it');
  // A wetland is an area and a flowline is a line: the two are told apart by their own geometry and styled apart.
  assert.equal(wetland.style.fill, true, 'a wetland is drawn as ground');
  assert.equal(flowline.style.fill, false, 'a flowline is drawn as a line');
  assert.notEqual(wetland.style.fillColor, flowline.style.color, 'and the families are not the same colour');
  assert.equal(wetland.style.dashArray, undefined, 'neither borrows the analysis outline\'s dash');
  assert.equal(flowline.style.dashArray, undefined);
  // A row from a layer this build has not seen is still habitat, and is never styled as a road.
  const [unknown] = habitatFeatures({ features: [{ layer: 'spring', sourceFeatureId: 'S1',
    geometry: { type: 'Point', coordinates: [-87.5, 38.3] } }] }).features;
  assert.equal(unknown.style.color, '#4b5563');
  assert.notEqual(unknown.style.color, '#1d4ed8', 'and not the corridor blue');
  // A ROW WITHOUT A DURABLE IDENTITY IS REPORTED, NOT NAMED. Nothing is invented: no id built from the corridor, the
  // list position or the label.
  assert.deepEqual(unidentified, [HABITAT_OVERLAY.features[3]], 'the row with no source feature id is reported');
  const missing = habitatFeatures({ features: [{ layer: null, sourceFeatureId: 'W9', geometry: null },
    { layer: 'wetland', sourceFeatureId: null, geometry: null }, { layer: 'wetland', sourceFeatureId: '', geometry: null }] });
  assert.equal(missing.features.length, 0, 'an identity needs both halves of it');
  assert.equal(missing.unidentified.length, 3);
  assert.equal(habitatIdentity({ layer: 'wetland', sourceFeatureId: 101390 }), 'wetland:101390',
    'a numeric source id is used as it is, not discarded');
  assert.equal(habitatIdentity({ layer: 'flowline' }), null);
  assert.equal(habitatIdentity(null), null);
  // No corridor anywhere in the descriptors: this family has no corridor identity to give away.
  for (const feature of features) {
    assert.equal(feature.corridorId, undefined, 'no corridor identity on a habitat feature');
    assert.deepEqual(Object.keys(featureAttributes(feature)).sort(), ['habitatId', 'role']);
    assert.deepEqual(featureAttributes(feature), { role: 'habitat', habitatId: feature.habitatId });
  }
  assert.equal(FEATURE_DOM[FEATURE_KIND.HABITAT].clickable, undefined, 'a habitat feature is never a selection target');
  assert.equal(featureAttributes(features[0]).corridorId, undefined);
});

test('habitat source features draw as their own family, never as corridors', () => {
  const { leaflet, calls, map } = fakeLeaflet();
  const selected = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => selected.push(selection?.id ?? null) });
  view.draw({ corridors: [CLICKED], selectedId: CLICKED.id, overlay: HABITAT_OVERLAY });

  // The observed geometry types, drawn as themselves: two wetlands as areas (one of them a multipolygon) and two
  // multilinestring flowlines, one path per line.
  const habitatAreas = calls.polygons.filter(path => path.attributes['data-role'] === 'habitat');
  const habitatLines = calls.polylines.filter(path => path.attributes['data-role'] === 'habitat');
  assert.equal(habitatAreas.length, 2, 'the Polygon and the MultiPolygon are both drawn as areas');
  assert.equal(habitatLines.length, 2, 'a MultiLineString is one path per line');
  assert.deepEqual(habitatAreas.map(path => path.attributes['data-habitat-id']).sort(),
    ['wetland:W1', 'wetland:W2'], 'each area carries its own source identity');
  assert.deepEqual(habitatLines.map(path => path.attributes['data-habitat-id']).sort(),
    ['flowline:H1', 'flowline:H1'], 'both lines of the multipart flowline are the same feature');
  // A multipolygon keeps its own rings, in Leaflet order.
  const pond = habitatAreas.find(path => path.attributes['data-habitat-id'] === 'wetland:W2');
  assert.equal(pond.latlngs.length, 2, 'both polygons of the multipolygon are drawn');
  assert.deepEqual(pond.latlngs[0][0], [38.31, -87.48], 'GeoJSON [lon, lat] in, Leaflet [lat, lon] out');
  // The row with no source feature id is not on the map at all, and nothing else took its place.
  assert.equal([...habitatAreas, ...habitatLines].length, 4, 'no path was invented for the row without an identity');

  // NO HABITAT PATH IS A CANDIDATE, and none carries a corridor.
  for (const path of [...habitatAreas, ...habitatLines]) {
    assert.ok(!('data-corridor-id' in path.attributes), 'a habitat feature is never attributed to a corridor');
    assert.ok(!('data-selected' in path.attributes), 'and it is not a selection');
    assert.equal(path.attributes['data-habitat-id'], path.attributes['data-habitat-id']);
    assert.equal(path.options.interactive, false, 'a habitat feature cannot be pointed at, so it cannot take a click');
    assert.equal(path.corridorId, undefined, 'and the map-level handler has no corridor to read from it');
    assert.equal(path.popup, undefined, 'no card is bound to a habitat feature');
  }
  // It cannot select, and it cannot make the map answer by proximity either: a habitat feature has no handler at all.
  habitatAreas[0].emit('click', { latlng: { lat: 38.28, lng: -87.52 }, propagatedFrom: habitatAreas[0] });
  habitatLines[0].emit('click', { latlng: { lat: 38.28, lng: -87.52 }, propagatedFrom: habitatLines[0] });
  assert.deepEqual(selected, [], 'clicking a habitat feature selects nothing');

  // THE ROAD INSIDE A VISIBLE WETLAND STAYS EXACTLY AS CLICKABLE AS IT WAS.
  // The clickable base copy, not the non-interactive emphasis drawn above it.
  const corridor = calls.polylines.filter(path => path.attributes['data-corridor-id'] === CLICKED.id
    && path.options.interactive).at(-1);
  assert.ok(corridor, 'the road is drawn through the habitat features');
  assert.equal(corridor.options.interactive, true);
  corridor.emit('click', { latlng: { lat: 38.28, lng: -87.5 }, propagatedFrom: corridor });
  assert.deepEqual(selected, [CLICKED.id], 'the road under the wetland is the corridor that gets selected');
  // And the buffer beside them is still its own third thing.
  const buffers = calls.polygons.filter(path => path.attributes['data-role'] === 'habitat-buffer');
  assert.equal(buffers.length, 1);
  assert.equal(buffers[0].attributes['data-habitat-corridor-id'], CLICKED.id);
  assert.ok(!('data-habitat-id' in buffers[0].attributes), 'buffer and source features are separate families');
  map.handlers.click({ latlng: { lat: 38.28, lng: -87.5 }, propagatedFrom: corridor });
  assert.deepEqual(selected, [CLICKED.id], 'and one click still selects one corridor');
});

test('habitat features join the overlay without moving the viewport', () => {
  const { leaflet, calls } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  view.draw({ corridors: [CLICKED], selectedId: CLICKED.id });
  const cameraBefore = view.camera();
  const fitsBefore = view.fitCount();
  const before = calls.polylines.length + calls.polygons.length;
  // The habitat toggle arriving with an analysis: the buffer, the source features, and nothing else.
  view.draw({ corridors: [CLICKED], selectedId: CLICKED.id, overlay: HABITAT_OVERLAY });
  assert.ok(calls.polylines.length + calls.polygons.length > before, 'the habitat features are drawn');
  assert.deepEqual(view.camera(), cameraBefore, 'turning the habitat layer on must not move the camera');
  assert.equal(view.fitCount(), fitsBefore, 'and must not fit');
  // Turning it off leaves the camera alone too, and takes the habitat geometry away with it.
  view.draw({ corridors: [CLICKED], selectedId: CLICKED.id });
  assert.deepEqual(view.camera(), cameraBefore, 'turning it off must not move the camera either');
  assert.equal(calls.polygons.filter(path => path.attributes['data-role'] === 'habitat-buffer').length, 1,
    'and the buffer from the earlier draw is not drawn again');
});

test('occurrence rows normalize into points, with the identity the evidence is keyed by', () => {
  const { features, unidentified } = occurrenceFeatures(OCCURRENCE_OVERLAY);
  assert.equal(features.length, 2, 'every usable point becomes a feature');
  assert.deepEqual(features.map(feature => feature.occurrenceId), ['inaturalist:obs-1', 'ebird:S12345'],
    "the source, and that source own record id - the pair the occurrence service measures distances by");
  assert.equal(features[0].kind, FEATURE_KIND.OCCURRENCE);
  assert.deepEqual(features[0].point, [38.285, -87.51], 'the row is [lon, lat]; the map point is [lat, lon]');
  assert.deepEqual(features[0].geometry, { type: 'Point', coordinates: [-87.51, 38.285] }, "the row own coordinate");
  assert.equal(features[0].source, 'inaturalist');
  assert.equal(features[0].sourceRecordId, 'obs-1');
  assert.equal(features[0].label, 'Red-tailed Hawk');
  assert.equal(features[0].taxonomicGroup, 'birds');
  assert.equal(features[0].distanceToCorridorM, 38.2);
  assert.equal(features[0].style.radius, 4, 'a point is a small disc, not an image marker');
  assert.equal(unidentified.length, 1, 'the row with no source record id is reported rather than named');
  // The same public record returned by two search regions is one point, plotted once, with the repeat reported.
  const repeated = occurrenceFeatures({ points: [OCCURRENCE_OVERLAY.points[0], OCCURRENCE_OVERLAY.points[0]] });
  assert.equal(repeated.features.length, 1, 'one point per source record');
  assert.equal(repeated.duplicates.length, 1, 'and the repeat is reported rather than drawn twice at the same place');
  // Its own role and its own identity attribute, and no other family identity.
  assert.deepEqual(featureAttributes(features[0]), { role: 'occurrence', occurrenceId: 'inaturalist:obs-1' });
  assert.deepEqual(Object.keys(featureAttributes(features[0])).sort(), ['occurrenceId', 'role']);
  assert.equal(featureAttributes(features[0]).corridorId, undefined);
  assert.equal(featureAttributes(features[0]).habitatId, undefined);
  assert.equal(FEATURE_DOM[FEATURE_KIND.OCCURRENCE].clickable, undefined, 'a point is never a selection target');
  // Identity needs both halves; a point needs a location inside the world.
  assert.equal(occurrenceIdentity({ source: 'inaturalist', sourceRecordId: 42 }), 'inaturalist:42',
    'a numeric record id is used as it is');
  assert.equal(occurrenceIdentity({ source: 'inaturalist' }), null);
  assert.equal(occurrenceIdentity({ sourceRecordId: 'x' }), null);
  assert.equal(occurrenceIdentity(null), null);
  // A row with no usable coordinate is reported too. (Range validation belongs to the domain, which refuses a location
  // outside the world before it can reach the map: src/occurrence/model.js.)
  const unplottable = occurrenceFeatures({ points: [
    { source: 'ebird', sourceRecordId: 'S1', location: null },
    { source: 'ebird', sourceRecordId: 'S2', location: ['not', 'a', 'point'] }] });
  assert.equal(unplottable.features.length, 0, 'a row with no usable coordinate is not a point');
  assert.equal(unplottable.unidentified.length, 2);
  assert.equal(occurrenceFeatures(null).features.length, 0);
  // THE HABITAT FIELD IS NOT THE OCCURRENCE FIELD: the occurrence overlay carries `points`, and reading the wrong name
  // is how this family came to draw nothing at all.
  assert.equal(occurrenceFeatures({ features: OCCURRENCE_OVERLAY.points }).features.length, 0);
});

test('occurrence points draw as their own family, and cannot be selected', () => {
  const { leaflet, calls, map } = fakeLeaflet();
  const selected = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => selected.push(selection?.id ?? null) });
  view.draw({ corridors: [CLICKED], selectedId: CLICKED.id, occurrenceOverlay: OCCURRENCE_OVERLAY });

  const points = calls.markerLayers.filter(path => path.attributes['data-role'] === 'occurrence');
  assert.equal(points.length, 2, 'one point per usable row');
  assert.deepEqual(points.map(point => point.attributes['data-occurrence-id']).sort(),
    ['ebird:S12345', 'inaturalist:obs-1']);
  assert.equal(calls.circleMarkers, 2, 'a point is a circle marker');
  assert.deepEqual(points.map(point => point.latlngs), [[38.285, -87.51], [38.295, -87.44]],
    'drawn where the row said, in Leaflet order');
  for (const point of points) {
    assert.ok(!('data-corridor-id' in point.attributes), 'a point is never attributed to a corridor');
    assert.ok(!('data-habitat-id' in point.attributes), 'and it is not a habitat feature');
    assert.ok(!('data-selected' in point.attributes), 'and it is not a selection');
    assert.equal(point.options.interactive, false, 'a point cannot be pointed at, so it cannot take a click');
    assert.equal(point.corridorId, undefined, 'and the map-level handler has no corridor to read from it');
    assert.equal(point.popup, undefined, 'no corridor card is bound to a point');
  }
  // A point selects nothing, and does not make the map answer by proximity either: it has no handler at all.
  points[0].emit('click', { latlng: { lat: 38.285, lng: -87.51 }, propagatedFrom: points[0] });
  assert.deepEqual(selected, [], 'clicking a point does not select a corridor');
  // THE ROAD AMONG THE POINTS IS STILL EXACTLY AS CLICKABLE AS IT WAS.
  // The clickable base copy, not the non-interactive emphasis drawn above it.
  const corridor = calls.polylines.filter(path => path.attributes['data-corridor-id'] === CLICKED.id
    && path.options.interactive).at(-1);
  assert.ok(corridor, 'the road is drawn with the points');
  corridor.emit('click', { latlng: { lat: 38.28, lng: -87.5 }, propagatedFrom: corridor });
  assert.deepEqual(selected, [CLICKED.id], 'a road click among the points selects that road');
  map.handlers.click({ latlng: { lat: 38.28, lng: -87.5 }, propagatedFrom: corridor });
  assert.deepEqual(selected, [CLICKED.id], 'and the map does not answer it a second time');
});

test('the occurrence layer is a visibility toggle: it draws what is loaded, and moves nothing', () => {
  const { leaflet, calls } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  view.draw({ corridors: [CLICKED], selectedId: CLICKED.id });
  // The groups in construction order are context, results, saved, outing, search, overlay, occurrence, selected.
  const occurrenceLayer = calls.groups[6];
  assert.equal(occurrenceLayer.added.length, 0, 'nothing is on the map until the layer is switched on');
  const cameraBefore = view.camera();
  const fitsBefore = view.fitCount();
  // Switching it on draws the points the evidence already holds - the map fetches nothing.
  view.draw({ corridors: [CLICKED], selectedId: CLICKED.id, occurrenceOverlay: OCCURRENCE_OVERLAY });
  assert.equal(occurrenceLayer.added.length, 2, 'switching it on shows the loaded points');
  assert.deepEqual(view.camera(), cameraBefore, 'showing points must not move the camera');
  assert.equal(view.fitCount(), fitsBefore, 'and must not fit');
  // Switching it off takes them away again, and still moves nothing.
  view.draw({ corridors: [CLICKED], selectedId: CLICKED.id });
  assert.equal(occurrenceLayer.added.length, 0, 'switching it off hides them');
  assert.deepEqual(view.camera(), cameraBefore, 'and must not move the camera either');
  assert.equal(view.fitCount(), fitsBefore);
});

test("every path the map draws is one typed family with exactly that family identity", () => {
  const { leaflet, calls } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  // Every family at once, from the public API only. There is no untyped row path left: the fallback that used to draw an
  // unknown row as a corridor-shaped line is gone, so a row that is not a feature cannot reach the map at all.
  view.draw({ corridors: [CLICKED, NEAR], selectedId: CLICKED.id, overlay: HABITAT_OVERLAY,
    occurrenceOverlay: OCCURRENCE_OVERLAY, search: { kind: 'radius', center: [-87.5, 38.3], radiusMiles: 25 } });
  const paths = [...calls.polylines, ...calls.polygons, ...calls.markerLayers, ...calls.circleLayers];
  assert.ok(paths.length > 8, 'the families are all drawn');
  const identities = ['data-corridor-id', 'data-habitat-id', 'data-habitat-corridor-id', 'data-occurrence-id'];
  const ownIdentity = { candidate: 'data-corridor-id', habitat: 'data-habitat-id',
    'habitat-buffer': 'data-habitat-corridor-id', occurrence: 'data-occurrence-id' };
  for (const path of paths) {
    const role = path.attributes['data-role'];
    assert.ok(role, 'every drawn path says what it is');
    const carried = identities.filter(name => name in path.attributes);
    if (ownIdentity[role]) {
      assert.deepEqual(carried, [ownIdentity[role]], `${role} carries its own identity and no other`);
    } else {
      assert.deepEqual(carried, [], `${role} has no identity of its own to carry`);
    }
  }
  // And an untyped row among the inputs is drawn as nothing at all: it has no role to be drawn under.
  const before = paths.length;
  view.draw({ corridors: [CLICKED], savedIds: [], savedRoads: [], overlay: { candidateId: CLICKED.id, features: [
    { layer: 'wetland', sourceFeatureId: null, geometry: { type: 'Polygon', coordinates: [[[-87.5, 38.3], [-87.4, 38.3], [-87.4, 38.4], [-87.5, 38.3]]] } }] },
    occurrenceOverlay: { candidateId: CLICKED.id, points: [{ source: null, sourceRecordId: null, location: [-87.5, 38.3] }] } });
  const after = [...calls.polylines, ...calls.polygons, ...calls.markerLayers, ...calls.circleLayers]
    .filter(path => !path.attributes['data-role']);
  assert.equal(after.length, 0, 'no path is drawn without saying what it is');
  assert.ok(before > 0);
});

test('a drawn road carries the collection it came from, and reports it with the click', () => {
  // THE DOMAIN IS CARRIED, NOT DERIVED. The map never reads an id's shape: it is told which collection a road belongs to
  // and reports that back with the click, so the application can route the selection to the path that owns it.
  const discovery = corridorFeature(DISCOVERY_ROAD);
  const pilot = corridorFeature(PILOT_ROAD);
  assert.equal(discovery.selectionDomain, 'discovery');
  assert.equal(pilot.selectionDomain, 'candidate');
  assert.equal(corridorFeature(CLICKED).selectionDomain, null, 'a descriptor without one carries none');
  // It is not DOM identity: the element says what it is, and the collection is the application's business.
  assert.deepEqual(featureAttributes(discovery), { role: 'candidate', corridorId: DISCOVERY_ROAD.id, selected: false });
  assert.equal('selectionDomain' in featureAttributes(discovery), false);

  const { leaflet, calls, map } = fakeLeaflet();
  const selections = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => selections.push(selection) });
  view.draw({ corridors: [DISCOVERY_ROAD, PILOT_ROAD], selectedId: DISCOVERY_ROAD.id });
  const pathOf = id => calls.polylines.filter(item => item.attributes['data-corridor-id'] === id
    && item.options.interactive).at(-1);

  // A discovery road reports the discovery collection, once.
  const discoveryEvent = { latlng: { lat: 38.29, lng: -87.5 }, originalEvent: {} };
  pathOf(DISCOVERY_ROAD.id).emit('click', { ...discoveryEvent, propagatedFrom: pathOf(DISCOVERY_ROAD.id) });
  assert.deepEqual(selections, [{ id: DISCOVERY_ROAD.id, domain: 'discovery' }]);
  // A pilot corridor reports the candidate collection - never the discovery one.
  const pilotEvent = { latlng: { lat: 38.29, lng: -87.5 }, originalEvent: {} };
  pathOf(PILOT_ROAD.id).emit('click', { ...pilotEvent, propagatedFrom: pathOf(PILOT_ROAD.id) });
  assert.deepEqual(selections, [{ id: DISCOVERY_ROAD.id, domain: 'discovery' },
    { id: PILOT_ROAD.id, domain: 'candidate' }], 'exactly one selection per click, in the right collection');

  // ONE DIRECT CLICK IS ANSWERED ONCE. The layer marks the click handled - what Leaflet consults before it would offer the
  // click to the map as well - so the proximity fallback is never given the same event.
  assert.equal(pilotEvent.originalEvent._stopped, true, 'the handled click is marked handled, for Leaflet to see');
  map.handlers.click({ ...pilotEvent, propagatedFrom: pathOf(PILOT_ROAD.id) });
  assert.equal(selections.length, 2, 'the map does not answer a click a corridor line already answered');

  // THE BACKGROUND FALLBACK STILL EXISTS, AND CARRIES THE DOMAIN. A click on the map itself, near a corridor, resolves
  // that corridor through the same domain it was drawn with - so it can never produce an unknown-corridor selection.
  const beforeFallback = selections.length;
  map.handlers.click({ latlng: { lat: 38.2701, lng: -87.5299 } });
  assert.equal(selections.length, beforeFallback + 1, 'a background click near a road resolves it');
  assert.deepEqual(selections.at(-1), { id: DISCOVERY_ROAD.id, domain: 'discovery' },
    'and resolves it in the collection it was drawn from');
  // Far from everything, the background click selects nothing.
  const before = selections.length;
  map.handlers.click({ latlng: { lat: 38.9, lng: -87.9 } });
  assert.equal(selections.length, before, 'a click on empty map selects nothing');
});

test('every part of a multi-part corridor carries that corridor and its collection', () => {
  const multi = { ...MULTI_PARTS, selectionDomain: 'candidate' };
  const { leaflet, calls } = fakeLeaflet();
  const selections = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => selections.push(selection) });
  view.draw({ corridors: [multi], selectedId: null });
  const parts = calls.polylines.filter(item => item.attributes['data-corridor-id'] === multi.id);
  assert.ok(parts.length > 1, 'a MultiLineString is drawn as several paths');
  for (const part of parts) {
    assert.equal(part.corridorId, multi.id);
    assert.equal(part.options.interactive, true);
  }
  parts[0].emit('click', { latlng: { lat: 38.3, lng: -87.5 }, originalEvent: {}, propagatedFrom: parts[0] });
  parts[1].emit('click', { latlng: { lat: 38.3, lng: -87.5 }, originalEvent: {}, propagatedFrom: parts[1] });
  assert.deepEqual(selections, [{ id: multi.id, domain: 'candidate' }, { id: multi.id, domain: 'candidate' }],
    'either part selects that corridor, in the same collection');
});

test('pick mode suppresses both selection paths, for either collection', () => {
  const { leaflet, calls, map } = fakeLeaflet();
  const selections = [];
  const picks = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => selections.push(selection),
    onPickCoordinate: coordinate => picks.push(coordinate) });
  view.draw({ corridors: [DISCOVERY_ROAD, PILOT_ROAD], selectedId: null });
  for (const road of [DISCOVERY_ROAD, PILOT_ROAD]) {
    view.setPickMode(true);
    const path = calls.polylines.filter(item => item.attributes['data-corridor-id'] === road.id
      && item.options.interactive).at(-1);
    const event = { latlng: { lat: 38.29, lng: -87.5 }, originalEvent: {} };
    path.emit('click', { ...event, propagatedFrom: path });
    map.handlers.click({ ...event, propagatedFrom: path });
  }
  assert.deepEqual(selections, [], 'pick mode selects no corridor, whatever collection it came from');
  assert.equal(picks.length, 2, 'and the coordinate is the answer, twice');
  assert.deepEqual(picks[0], [-87.5, 38.29], 'as [longitude, latitude]');
  view.setPickMode(false);
  assert.equal(calls.polylines.length > 0, true);
});


// THE SEARCH-CONTEXT LEADER: ORIENTATION FROM TWO MEASURED POINTS, AND NOTHING ELSE.
test('the leader normalizes from the corridor own measured centre and nearest point', () => {
  const feature = searchContextFeature(CONTEXT_ROAD);
  assert.equal(feature.kind, FEATURE_KIND.SEARCH_CONTEXT);
  assert.equal(feature.corridorId, CONTEXT_ROAD.id, 'the corridor is an association, not this feature identity');
  assert.deepEqual(feature.geometry, { type: 'LineString',
    coordinates: [[-87.60, 38.20], [-87.50, 38.30]] }, 'centre first, nearest point second, in GeoJSON order');
  assert.deepEqual(drawableShapes(feature), [{ line: [[38.20, -87.60], [38.30, -87.50]] }],
    'and drawn as one line, in Leaflet order');
  assert.equal(feature.label, null, 'orientation has no tooltip text to invent');
  assert.equal(feature.style.weight, 1, 'thin');
  assert.ok(feature.style.opacity < 0.6, 'and quiet');
  assert.equal(feature.style.fill, false);
  assert.notEqual(feature.style.color, '#1d4ed8', 'never the road blue');
  // Its own role, carrying the corridor, and never a candidate.
  assert.deepEqual(featureAttributes(feature), { role: 'search-context', corridorId: CONTEXT_ROAD.id });
  assert.equal('selected' in featureAttributes(feature), false);
  assert.equal(FEATURE_DOM[FEATURE_KIND.SEARCH_CONTEXT].interactive, false);
  assert.equal(FEATURE_DOM[FEATURE_KIND.SEARCH_CONTEXT].clickable, undefined, 'never a selection target');

  // NO MEASUREMENT, NO LEADER. Nothing is derived from the road's geometry to fill a gap.
  assert.equal(searchContextFeature({ ...CONTEXT_ROAD, nearestCenterPoint: null }), null);
  assert.equal(searchContextFeature({ ...CONTEXT_ROAD, searchCenter: null }), null);
  // Range validation belongs to the domain that measured these points (src/discovery/search-context.js); the map refuses
  // what is not a usable coordinate at all.
  assert.equal(searchContextFeature({ ...CONTEXT_ROAD, nearestCenterPoint: ['a', 'b'] }), null);
  assert.equal(searchContextFeature(PILOT_ROAD), null, 'a corridor with no measured context has no leader');
  assert.equal(searchContextFeature({ id: 'x' }), null);
  assert.equal(searchContextFeature(null), null);
  // A leader that goes nowhere is not orientation.
  assert.equal(searchContextFeature({ ...CONTEXT_ROAD, nearestCenterPoint: [-87.60, 38.20] }), null);
});

test('the leader follows the selection, and is never a candidate', () => {
  const { leaflet, calls, map } = fakeLeaflet();
  const selected = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => selected.push(selection) });
  // The leader is what the context layer holds: that layer is created first, so it draws under everything else.
  const contextLayer = calls.groups[0];
  const drawnLeaders = () => contextLayer.added.filter(path => path.attributes['data-role'] === 'search-context');

  // SELECT A: one leader, associated with A.
  view.draw({ corridors: [CONTEXT_ROAD, PILOT_ROAD], selectedId: CONTEXT_ROAD.id });
  assert.equal(drawnLeaders().length, 1, 'selecting a corridor draws exactly one leader');
  assert.equal(drawnLeaders()[0].attributes['data-corridor-id'], CONTEXT_ROAD.id);
  assert.equal(drawnLeaders()[0].options.interactive, false, 'it cannot be pointed at, so it cannot take a click');
  assert.equal(drawnLeaders()[0].popup, undefined, 'and no card is bound to it');
  assert.equal(drawnLeaders()[0].corridorId, undefined, 'the map-level click handler has no corridor to read from it');
  assert.equal(calls.polylines.some(path => path.attributes['data-role'] === 'search-context'
    && 'data-selected' in path.attributes), false, 'and it is never a selection');

  // SELECT B: A's leader is gone, B's is there - and a pilot corridor, which measured no context, has none at all.
  view.draw({ corridors: [CONTEXT_ROAD, PILOT_ROAD], selectedId: PILOT_ROAD.id });
  assert.deepEqual(drawnLeaders(), [], 'a corridor with no measured context draws no leader, and A leader is gone');
  // A redraw that leaves the selection alone draws the same single leader, never an accumulation.
  view.draw({ corridors: [CONTEXT_ROAD, PILOT_ROAD], selectedId: CONTEXT_ROAD.id });
  view.draw({ corridors: [CONTEXT_ROAD, PILOT_ROAD], selectedId: CONTEXT_ROAD.id });
  assert.equal(drawnLeaders().length, 1, 'no duplicate leaders accumulate');
  // CLEARING THE SELECTION REMOVES IT.
  view.draw({ corridors: [CONTEXT_ROAD, PILOT_ROAD], selectedId: null });
  assert.deepEqual(drawnLeaders(), [], 'no corridor selected, no leader drawn');

  // A LEADER ON SCREEN DOES NOT INTERFERE WITH SELECTING A ROAD.
  view.draw({ corridors: [CONTEXT_ROAD, PILOT_ROAD], selectedId: CONTEXT_ROAD.id });
  const corridor = calls.polylines.filter(path => path.attributes['data-corridor-id'] === PILOT_ROAD.id
    && path.options.interactive).at(-1);
  corridor.emit('click', { latlng: { lat: 38.29, lng: -87.5 }, originalEvent: {}, propagatedFrom: corridor });
  assert.deepEqual(selected, [{ id: PILOT_ROAD.id, domain: 'candidate' }],
    'the road under the cursor is still the corridor that gets selected');
  // And a click on the map itself resolves the nearest corridor, never the leader.
  map.handlers.click({ latlng: { lat: 38.3001, lng: -87.4999 } });
  assert.deepEqual(selected.at(-1), { id: CONTEXT_ROAD.id, domain: 'discovery' },
    'the nearest corridor is resolved through its own collection');
});

test('the leader belongs to the selection, and the selection still owns no camera', () => {
  const { leaflet } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  view.draw({ corridors: [CONTEXT_ROAD, PILOT_ROAD], selectedId: null });
  const cameraBefore = view.camera();
  const fitsBefore = view.fitCount();
  assert.equal(view.contextGeometry(), null, 'no selection, no leader');
  view.setSelected(CONTEXT_ROAD.id);
  assert.deepEqual(view.contextGeometry(), { type: 'LineString', coordinates: [[-87.60, 38.20], [-87.50, 38.30]] },
    'the leader is readable exactly as it was normalized');
  assert.deepEqual(view.camera(), cameraBefore, 'drawing the leader must not move the camera');
  assert.equal(view.fitCount(), fitsBefore, 'and must not fit');
  view.setSelected(PILOT_ROAD.id);
  assert.equal(view.contextGeometry(), null, 'a selection with no measured context has no leader');
  assert.deepEqual(view.camera(), cameraBefore);
  assert.equal(view.fitCount(), fitsBefore);
  view.setSelected(null);
  assert.equal(view.contextGeometry(), null);
  assert.deepEqual(view.camera(), cameraBefore, 'clearing the selection moves nothing either');
});

// THE 1 km HABITAT BUFFER: A TYPED OVERLAY WITH ITS OWN IDENTITY, DRAWN UNDER THE ROAD IT BELONGS TO.
test('the habitat buffer normalizes from the analysis output the product already holds', () => {
  const buffer = habitatBufferFeature(BUFFER_OVERLAY);
  assert.equal(buffer.kind, FEATURE_KIND.HABITAT_BUFFER);
  assert.equal(buffer.corridorId, CLICKED.id, 'the corridor it belongs to travels as an association');
  assert.equal(buffer.geometry, BUFFER_OVERLAY.bufferGeometry, 'the analysis geometry itself, not a recomputed one');
  assert.deepEqual(featureAttributes(buffer), { role: 'habitat-buffer', habitatCorridorId: CLICKED.id },
    'its own role, and the association under its own attribute');
  assert.equal(featureAttributes(buffer).corridorId, undefined, 'and never a candidate id');
  assert.equal(buffer.style.fill, false, 'an outline: it frames the corridor rather than covering it');
  assert.equal(buffer.style.dashArray, '6 4');
  // No geometry, or geometry that is not an area, draws nothing.
  assert.equal(habitatBufferFeature({ candidateId: CLICKED.id }), null);
  assert.equal(habitatBufferFeature({ candidateId: CLICKED.id, bufferGeometry: { type: 'LineString',
    coordinates: [[-87.5, 38.3], [-87.4, 38.31]] } }), null, 'a buffer is a polygon or it is not a buffer');
  assert.equal(habitatBufferFeature(null), null);
});

test('the buffer draws as a polygon under the road, and the road inside it stays clickable', () => {
  const { leaflet, calls, map } = fakeLeaflet();
  const selected = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: selection => selected.push(selection?.id ?? null) });
  view.draw({ corridors: [CLICKED, NEAR], selectedId: CLICKED.id, overlay: BUFFER_OVERLAY });

  const buffers = calls.polygons.filter(path => path.attributes['data-role'] === 'habitat-buffer');
  assert.equal(buffers.length, 1, 'one buffer for the analysis it belongs to');
  assert.equal(buffers[0].attributes['data-habitat-corridor-id'], CLICKED.id);
  assert.ok(!('data-corridor-id' in buffers[0].attributes), 'a buffer never masquerades as a corridor');
  assert.ok(!('data-habitat-id' in buffers[0].attributes), 'and it is not one of the source features either');
  assert.equal(buffers[0].options.interactive, false, 'a buffer cannot be pointed at, so it cannot take a click');
  assert.notEqual(FEATURE_DOM[FEATURE_KIND.HABITAT_BUFFER].clickable, true, 'and it is never a selection target');
  assert.deepEqual(buffers[0].latlngs, [[[38.2, -87.6], [38.2, -87.3], [38.4, -87.3], [38.4, -87.6], [38.2, -87.6]]],
    'the polygon as Leaflet rings: GeoJSON order in, Leaflet order out');

  // The road inside the covering buffer is still drawn as a corridor and still selects itself.
  // The clickable base copy, not the non-interactive emphasis drawn above it.
  const corridor = calls.polylines.filter(path => path.attributes['data-corridor-id'] === CLICKED.id
    && path.options.interactive).at(-1);
  assert.ok(corridor, 'the road is drawn inside the buffer');
  corridor.emit('click', { latlng: { lat: 38.28, lng: -87.5 }, propagatedFrom: corridor });
  assert.deepEqual(selected, [CLICKED.id], 'a corridor click inside the buffer selects that corridor');
  // The buffer's own event cannot select anything: it has no handler and is not clickable.
  buffers[0].emit('click', { latlng: { lat: 38.28, lng: -87.5 }, propagatedFrom: buffers[0] });
  assert.deepEqual(selected, [CLICKED.id], 'the buffer invokes no selection of its own');
});

test('the habitat toggle adds and removes the buffer without moving the viewport', () => {
  const { leaflet, calls } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  view.draw({ corridors: [CLICKED], selectedId: CLICKED.id });
  const cameraBefore = view.camera();
  const fitsBefore = view.fitCount();
  // The groups in construction order are context, results, saved, outing, search, overlay, occurrence, selected.
  const overlayLayer = calls.groups[5];
  const bufferCount = () => overlayLayer.added.filter(path => path.attributes['data-role'] === 'habitat-buffer').length;
  assert.equal(bufferCount(), 0, 'no habitat overlay, no buffer');

  view.draw({ corridors: [CLICKED], selectedId: CLICKED.id, overlay: BUFFER_OVERLAY });
  assert.equal(bufferCount(), 1, 'enabling the habitat layer draws the buffer');
  assert.ok(calls.polylines.some(path => path.attributes['data-corridor-id'] === CLICKED.id),
    'and the road it belongs to is still drawn');

  view.draw({ corridors: [CLICKED], selectedId: CLICKED.id });
  assert.equal(bufferCount(), 0, 'disabling the habitat layer takes the buffer away again');
  assert.deepEqual(view.camera(), cameraBefore, 'and none of it moved the camera');
  assert.equal(view.fitCount(), fitsBefore, 'or asked for a fit');
});

// ------------------------------------------------------------------ the person's plan, drawn as a plan

// THE MAP DRAWS A PLAN WITHOUT KNOWING ANYTHING ABOUT IT. It gets geometry, a stop number and the collection a click
// routes to; it derives no order, draws no connector, and moves the camera only when the person asks.
const PLAN_ROADS = [
  { id: 'PLAN-A', name: 'Road A', geometry: GEO, stop: 1, of: 3, selectionDomain: 'candidate' },
  { id: 'PLAN-B', name: 'Road B', geometry: { type: 'LineString', coordinates: [[-87.45, 38.32], [-87.35, 38.33]] },
    stop: 2, of: 3, selectionDomain: 'candidate' },
];
const PLAN = { id: 'outing-1', roads: PLAN_ROADS };

test('a plan’s roads are drawn as plan members, not as discovery candidates', () => {
  const { leaflet, calls } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  view.draw({ corridors: [CLICKED], selectedId: null, outing: PLAN });
  // The plan layer is the third collection group created (context, results, saved, outing, ...), and what it holds NOW
  // is what the map is drawing.
  const planned = calls.groups[3].added;
  // The plan has its own role, so nothing reading the DOM can mistake a plan member for a discovery candidate.
  assert.deepEqual(planned.map(path => path.attributes['data-corridor-id']), ['PLAN-A', 'PLAN-B']);
  assert.deepEqual(planned.map(path => path.attributes['data-role']), ['outing', 'outing']);
  assert.equal(planned.every(path => path.options.interactive), true, 'a plan road can be clicked');
  // THE CARD NAMES THE STOP, which is how the person's order is read on the map without drawing anything between roads.
  assert.match(planned[0].popup, /Road 1 of 3 in this outing/);
  assert.match(planned[1].popup, /Road 2 of 3/);
  // NO CONNECTOR, NO ROUTE LINE: the plan adds only the roads themselves, and nothing is drawn as an area.
  assert.equal(planned.length, PLAN_ROADS.length);
  assert.equal(calls.polygons.length, 0);
  assert.equal(view.outingRoadIds().length, 2);
});

test('a road that is both a visible candidate and a plan member is drawn once, as a member', () => {
  const { leaflet, calls } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  // PLAN-A is also a visible discovery result and a saved road: it must appear exactly once, in the plan's own style.
  view.setSavedRoads([{ id: 'PLAN-A', name: 'Road A', geometry: GEO, selectionDomain: 'candidate' }]);
  view.draw({ corridors: [corridor('PLAN-A'), corridor('OTHER')], selectedId: null,
    savedIds: ['PLAN-A'], outing: PLAN });
  const drawn = [...calls.groups[1].added, ...calls.groups[2].added, ...calls.groups[3].added];
  const forA = drawn.filter(path => path.attributes['data-corridor-id'] === 'PLAN-A');
  assert.equal(forA.length, 1, 'one geometry for one road, however many collections it belongs to');
  assert.equal(forA[0].attributes['data-role'], 'outing');
  // The other candidate is still drawn as a candidate, and the plan's second road is drawn with the plan.
  assert.deepEqual(drawn.filter(path => path.attributes['data-corridor-id'] === 'OTHER')
    .map(path => path.attributes['data-role']), ['candidate']);
  assert.deepEqual(drawn.filter(path => path.attributes['data-corridor-id'] === 'PLAN-B')
    .map(path => path.attributes['data-role']), ['outing']);
});

test('fitting a plan is an explicit move: the control fits, ordinary plan edits never do', () => {
  const { leaflet, calls } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  const fitsBefore = view.fitCount();
  view.draw({ corridors: [], selectedId: null, outing: PLAN });
  assert.equal(view.fitCount(), fitsBefore, 'drawing a plan does not fit it');
  // ADDING A ROAD, REORDERING AND REMOVING ARE ALL JUST DRAWS.
  const three = { id: 'outing-1', roads: [...PLAN_ROADS,
    { id: 'PLAN-C', name: 'Road C', geometry: GEO, stop: 3, of: 3 }] };
  view.draw({ corridors: [], selectedId: null, outing: three });
  view.draw({ corridors: [], selectedId: null,
    outing: { id: 'outing-1', roads: [PLAN_ROADS[1], PLAN_ROADS[0], three.roads[2]] } });
  view.draw({ corridors: [], selectedId: null, outing: { id: 'outing-1', roads: [PLAN_ROADS[0]] } });
  assert.equal(view.fitCount(), fitsBefore, 'editing a plan never moves the camera');
  // THE CONTROL, HOWEVER, IS AN EXPLICIT CAMERA ACTION, and it fits the plan's own roads.
  assert.equal(view.fitOuting(), true);
  assert.equal(view.fitCount(), fitsBefore + 1);
  assert.deepEqual(calls.fits.at(-1).bounds, [[38.3, -87.5], [38.31, -87.4]], 'the one remaining road’s extent');
  view.draw({ corridors: [], selectedId: null, outing: PLAN });
  assert.equal(view.fitOuting(), true);
  assert.deepEqual(calls.fits.at(-1).bounds, [[38.3, -87.5], [38.33, -87.35]], 'the plan’s own extent');
  // A plan with nothing mapped says so rather than moving the camera to nowhere, and a plan of unresolved roads is not
  // an error either: it simply has nothing to fit.
  const notices = [];
  const empty = createGeoView({ style: {} }, { leaflet, onNotice: notice => notices.push(notice) });
  assert.equal(empty.fitOuting(), false);
  assert.equal(notices.length, 1);
  assert.match(notices[0].note, /no mapped road geometry/);
  const noMap = unavailableView('leaflet is unavailable');
  assert.equal(noMap.fitOuting(), false, 'a map that cannot initialise refuses the fit instead of throwing');
});

test('a plan road carries its own facts into its card', () => {
  const { leaflet, calls } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  view.draw({ corridors: [], selectedId: null, outing: { id: 'outing-1', roads: [{ id: 'PLAN-A', name: 'Road A',
    geometry: GEO, stop: 1, of: 1, selectionDomain: 'candidate', distanceFromCenterM: 5200,
    searchCenter: [-87.55, 38.25], nearestCenterPoint: [-87.5, 38.3],
    ranking: { score: 72.4, version: 'naturalist-interest-v2', components: { wetland: { value: 74.7, measured: true } } },
    exploration: { score: 61.2 } }] } });
  const path = calls.groups[3].added.at(-1);
  assert.equal(path.attributes['data-corridor-id'], 'PLAN-A');
  assert.match(path.popup, /Road 1 of 1 in this outing/);
  assert.match(path.popup, /Naturalist interest 72\.4/);
  assert.match(path.popup, /3\.2 mi from search centre/);
  assert.match(path.popup, /Exploration order <strong>61\.2<\/strong>/);
  // THE LEADER IS STILL ORIENTATION, NOT A ROUTE: the plan's selected road draws the measured pair it already had.
  view.setSelected('PLAN-A');
  const leader = calls.groups[0].added;
  assert.equal(leader.length, 1);
  assert.equal(leader[0].attributes['data-role'], 'search-context');
  assert.equal(leader[0].attributes['data-corridor-id'], 'PLAN-A');
  // The emphasised copy is the plan's own road, under the plan's own role, and it cannot take the click. The emphasis is
  // drawn straight into its own layer rather than through `paint`, so it is found among the paths the map created.
  const emphasis = calls.polylines.filter(entry => entry.attributes['data-role'] === 'outing'
    && entry.options?.interactive === false);
  assert.equal(emphasis.length, 1);
  assert.equal(emphasis[0].attributes['data-role'], 'outing');
  assert.equal(emphasis[0].attributes['data-selected'], 'true', 'the attribute is written as the DOM writes it');
});

test('a plan road keeps one selection state, and selecting one never moves the camera', () => {
  const { leaflet } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  view.draw({ corridors: [], selectedId: null, outing: PLAN });
  const cameraBefore = view.camera();
  const fitsBefore = view.fitCount();
  view.setSelected('PLAN-B');
  assert.equal(view.selectedId(), 'PLAN-B');
  assert.deepEqual(view.camera(), cameraBefore, 'selecting a plan road never moves the camera');
  assert.equal(view.fitCount(), fitsBefore, 'and never asks for a fit');
  view.setSelected(null);
  assert.equal(view.selectedId(), null);
});

test('clearing a plan takes its own drawing away and puts the candidate collection back', () => {
  const { leaflet, calls } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  view.draw({ corridors: [corridor('PLAN-A')], selectedId: null, outing: PLAN });
  assert.equal(calls.polylines.filter(path => path.attributes['data-corridor-id'] === 'PLAN-A')
    .map(path => path.attributes['data-role']).at(-1), 'outing');
  view.draw({ corridors: [corridor('PLAN-A')], selectedId: null, outing: null });
  assert.equal(calls.polylines.filter(path => path.attributes['data-corridor-id'] === 'PLAN-A')
    .map(path => path.attributes['data-role']).at(-1), 'candidate',
  'with no plan, the road is drawn as the candidate it is');
  assert.deepEqual(view.outingRoadIds(), []);
});

