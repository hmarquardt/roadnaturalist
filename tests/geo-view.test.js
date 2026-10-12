import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TILE_PROVIDERS, tileProvider } from '../src/map/basemap.js';
import { attributeName, basemapFailureNote, boundsOfGeometries, corridorFeature, createGeoView, drawableShapes,
  featureAttributes, featureShape, popupHtml, toLatLngs, unavailableView, FEATURE_DOM, FEATURE_KIND }
  from '../src/map/geo-view.js';
import { createMapView } from '../src/map/index.js';

// THE MAP'S CONTRACT, WITHOUT A BROWSER.
//
// Leaflet is injected, so these tests exercise the rules that matter - one selection state, viewport ownership,
// failure containment, malformed geometry - by watching what the adapter asks the library to do. A fake library is
// enough for that, and it keeps the test about behaviour rather than about pixels.

function fakeLeaflet({ failMap = false } = {}) {
  const calls = { tileLayers: [], polylines: [], polygons: [], opened: [], closed: 0, circles: 0, circleMarkers: 0,
    rectangles: 0, fits: [], removed: 0 };
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
    circle() { calls.circles += 1; return layer(); },
    circleMarker() { calls.circleMarkers += 1; return layer(); },
    rectangle() { calls.rectangles += 1; return layer(); },
    featureGroup() { return layer(); } };
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
  const view = createGeoView({ style: {} }, { leaflet, onSelect: id => selected.push(id) });
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

test('a click on a drawn line selects that corridor, not the nearest vertex', () => {
  const { leaflet, calls } = fakeLeaflet();
  const chosen = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: id => chosen.push(id) });
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
  const view = createGeoView({ style: {} }, { leaflet, onSelect: id => chosen.push(id) });
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
  const view = createGeoView({ style: {} }, { leaflet, onSelect: id => chosen.push(id),
    onPickCoordinate: coordinate => picked.push(coordinate) });
  view.draw({ corridors: [CLICKED] });
  view.setPickMode(true);
  calls.polylines.filter(item => item.corridorId === CLICKED.id).at(-1).emit('click', { latlng: { lat: 38.29, lng: -87.5 } });
  assert.deepEqual(chosen, [], 'pick mode never selects a corridor');
});

test('a click on the map itself still uses proximity, and selects nothing when nothing is near', () => {
  const { leaflet, map } = fakeLeaflet();
  const chosen = [];
  const view = createGeoView({ style: {} }, { leaflet, onSelect: id => chosen.push(id) });
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
    onSelect: id => selected.push(id) });
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
  view = createGeoView({ style: {} }, { leaflet, onSelect: id => {
    selected.push(id);
    view.draw({ corridors: [CLICKED, NEAR], selectedId: id });
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
  view = createGeoView({ style: {} }, { leaflet, onSelect: id => view.draw({ corridors: [CLICKED, NEAR], selectedId: id }) });
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
  const view = createGeoView({ style: {} }, { leaflet, onSelect: id => selected.push(id) });
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
      'fitResults', 'fitSelected', 'destroy']) {
      assert.equal(typeof view[name], 'function', `the application may call ${name}`);
    }
    // The diagnostic is what the committed browser gate reads, and nothing more: a convenience added here would be a
    // second source of truth the application could start consulting.
    assert.deepEqual(Object.keys(globalThis.__RN_MAP).sort(),
      ['available', 'camera', 'fitCount', 'implementation', 'movements', 'note', 'searchGeometry']);
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
    ['corridor', 'habitat', 'habitat-buffer', 'occurrence', 'search-center', 'search-context', 'search-radius',
      'search-region']);
  const roles = Object.values(FEATURE_DOM).map(contract => contract.role);
  assert.equal(roles.filter(role => role === 'candidate').length, 1, 'one kind is the candidate, and it is the corridor');
  assert.equal(FEATURE_DOM[FEATURE_KIND.CORRIDOR].role, 'candidate');
  assert.equal(FEATURE_DOM[FEATURE_KIND.CORRIDOR].interactive, true, 'a corridor is a clickable family');
  assert.equal(FEATURE_DOM[FEATURE_KIND.CORRIDOR].clickable, true, 'and the only one that answers a click by selecting');
  for (const [kind, contract] of Object.entries(FEATURE_DOM)) {
    assert.ok(contract.role, `${kind} declares a role`);
    if (kind === FEATURE_KIND.CORRIDOR) continue;
    assert.notEqual(contract.clickable, true, `${kind} is not a selection target`);
    // The search centre is interactive because it carries a tooltip; nothing else that is not a corridor is.
    if (kind !== FEATURE_KIND.SEARCH_CENTRE) assert.notEqual(contract.interactive, true, `${kind} is not interactive`);
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
  const view = createGeoView({ style: {} }, { leaflet, onSelect: id => selected.push(id) });
  view.draw({ corridors: [CLICKED, NEAR], selectedId: CLICKED.id });
  const path = calls.polylines.filter(item => item.attributes['data-corridor-id'] === CLICKED.id).at(-1);
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

test('a row that has not been typed yet keeps the corridor-shaped handling it has today', () => {
  const { leaflet, calls } = fakeLeaflet();
  const view = createGeoView({ style: {} }, { leaflet });
  // The habitat overlay is handed over as *rows* today. A line among them is drawn exactly as it is now - the candidate
  // role, no corridor id of its own - and a polygon is skipped, because the map paints lines only until the overlay slice
  // types these rows. This test records the interim state so that slice can show what it changed.
  view.draw({ corridors: [CLICKED], overlay: { candidateId: CLICKED.id, features: [
    { layer: 'hydrography', sourceFeatureId: 'H1', label: 'Riverine',
      geometry: { type: 'LineString', coordinates: [[-87.5, 38.3], [-87.45, 38.31]] } },
    { layer: 'wetland', sourceFeatureId: 'W1', label: 'Freshwater Emergent Wetland',
      geometry: { type: 'Polygon', coordinates: [[[-87.55, 38.25], [-87.5, 38.25], [-87.5, 38.3], [-87.55, 38.25]]] } } ] } });
  const untyped = calls.polylines.filter(path => path.attributes['data-role'] === 'candidate'
    && path.attributes['data-corridor-id'] === undefined);
  assert.equal(untyped.length, 1, 'the hydrography line is drawn the way it is today');
  assert.ok(!('data-habitat-id' in untyped[0].attributes), 'and it is not yet a habitat feature');
  assert.equal(calls.polygons.length, 0, 'the wetland polygon is not drawn: the map paints lines only today');
  assert.ok(calls.polylines.some(path => path.attributes['data-corridor-id'] === CLICKED.id),
    'while the corridor beside it is drawn as a corridor');
});

