import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TILE_PROVIDERS, tileProvider } from '../src/map/basemap.js';
import { basemapFailureNote, boundsOfGeometries, createGeoView, popupHtml, toLatLngs, unavailableView }
  from '../src/map/geo-view.js';

// THE MAP'S CONTRACT, WITHOUT A BROWSER.
//
// Leaflet is injected, so these tests exercise the rules that matter - one selection state, viewport ownership,
// failure containment, malformed geometry - by watching what the adapter asks the library to do. A fake library is
// enough for that, and it keeps the test about behaviour rather than about pixels.

function fakeLeaflet({ failMap = false } = {}) {
  const calls = { tileLayers: [], polylines: [], circles: 0, circleMarkers: 0, rectangles: 0, fits: [], removed: 0 };
  const layer = () => ({ added: [], handlers: {},
    on(event, handler) { this.handlers[event] = handler; return this; },
    addTo(map) { this.added.push(map); return this; },
    addLayer(entry) { this.added.push(entry); return this; },
    clearLayers() { this.added.length = 0; return this; },
    bindPopup(html) { this.popup = html; return this; },
    bindTooltip(text) { this.tooltip = text; return this; } });
  const map = { handlers: {}, layers: [], bounds: [[38.1, -87.9], [38.5, -87.2]],
    on(event, handler) { this.handlers[event] = handler; return this; },
    off() {}, remove() { calls.removed += 1; },
    setView(view) { this.view = view; return this; },
    fitBounds(bounds, options) { calls.fits.push({ bounds, options }); this.bounds = bounds; return this; },
    getBounds() { return this.bounds; },
    addLayer(entry) { this.layers.push(entry); return this; },
    removeLayer(entry) { this.layers = this.layers.filter(item => item !== entry); return this; },
    hasLayer(entry) { return this.layers.includes(entry); } };
  const leaflet = { map() { if (failMap) throw new Error('no WebGL, no canvas, no map'); return map; },
    tileLayer(url, options) { const created = layer(); created.url = url; created.options = options;
      calls.tileLayers.push(created); return created; },
    polyline(latlngs, options) { const created = layer(); created.latlngs = latlngs; created.options = options;
      calls.polylines.push(created); return created; },
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

test('geometry is converted to geographic coordinates, and malformed geometry is refused rather than thrown', () => {

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

  assert.equal(toLatLngs({ type: 'Point', coordinates: [-87, 38] }), null);
  assert.equal(toLatLngs({ type: 'LineString', coordinates: [[-87, 38]] }), null, 'a single point is not a line');
  assert.equal(toLatLngs({ type: 'LineString', coordinates: [['x', 'y'], [-87, 38]] }), null);
  assert.deepEqual(boundsOfGeometries([GEO]), [[38.3, -87.5], [38.31, -87.4]]);
  assert.equal(boundsOfGeometries([{ type: 'Point' }]), null);
});
