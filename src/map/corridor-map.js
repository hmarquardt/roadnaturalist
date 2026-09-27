const SVG_NS = 'http://www.w3.org/2000/svg';

// Corridor geometry access lives in the domain layer; the map only projects and draws it.
import { linesOf } from '../domain/geometry.js';

// The map is a replaceable view over canonical GeoJSON. It never owns the domain model:
// it receives plain corridor descriptors and draws them on a schematic coordinate grid.
export function createCorridorMap(container, { onSelect, onPickCoordinate } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 1000 700');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Corridor geometry on a schematic coordinate grid');
  container.append(svg);
  // Two groups inside the one map: the drawn corridor content, and the search layer that shows the chosen
  // centre, the requested radius, and the published coverage. They share the map's coordinate system, so the
  // preview sits where the geometry really is, and only the search layer is rebuilt while a radius changes.
  const content = document.createElementNS(SVG_NS, 'g');
  content.setAttribute('class', 'map-content');
  const searchLayer = document.createElementNS(SVG_NS, 'g');
  searchLayer.setAttribute('class', 'search-layer');
  searchLayer.setAttribute('aria-hidden', 'true');
  svg.append(content, searchLayer);
  const key = document.createElement('div');
  key.className = 'map-key';
  key.textContent = 'Schematic coordinate grid · no basemap';
  container.append(key);
  let corridors = [];
  let selected = null;
  let overlay = null;
  let occurrenceOverlay = null;
  let discovery = null;
  let search = null;
  let picking = false;
  let zoom = 1;
  let pan = { x: 0, y: 0 };
  let dragging = null;
  let press = null;
  let projection = null;

  function viewBox() {
    const width = 1000 / zoom;
    const height = 700 / zoom;
    svg.setAttribute('viewBox', `${(1000 - width) / 2 + pan.x} ${(700 - height) / 2 + pan.y} ${width} ${height}`);
  }
  function fit() { zoom = 1; pan = { x: 0, y: 0 }; viewBox(); }

  // The projection is fitted to the geometry on the map, and to the published region when there is none yet:
  // a search centre can be chosen before anything is drawn, so the map must still know where the region is.
  // The centre itself never changes the fit - dragging a radius must not rescale the map under the pointer.
  function project() {
    const lines = [...corridors.flatMap(corridor => linesOf(corridor.geometry)),
      ...(discovery?.corridors ?? []).flatMap(entry => linesOf(entry.geometry))];
    projection = createProjection(lines, search?.regionBounds ?? null);
    return projection;
  }

  function draw({ corridors: next = [], selectedId = null, overlay: nextOverlay = null, occurrenceOverlay: nextOccurrence = null,
    discovery: nextDiscovery = null } = {}) {
    corridors = Array.isArray(next) ? next : [];
    selected = corridors.find(corridor => corridor.id === selectedId) ?? null;
    overlay = nextOverlay ?? null;
    occurrenceOverlay = nextOccurrence ?? null;
    discovery = nextDiscovery ?? null;
    fit();
    render();
  }

  function ensurePlaceholder() {
    if (container.querySelector('.map-placeholder')) return;
    const empty = document.createElement('div');
    empty.className = 'map-placeholder';
    empty.innerHTML = '<div><strong>No corridor loaded</strong><p>Discover roads in the Oregon pilot area, or open the road pilot, to place real road geometry here. A search centre can be chosen on this map or typed in the discovery panel.</p></div>';
    container.append(empty);
  }

  function render() {
    content.replaceChildren();
    const placeholder = container.querySelector('.map-placeholder');
    const discoveryLines = (discovery?.corridors ?? []).flatMap(entry => linesOf(entry.geometry));
    const hasGeometry = Boolean(corridors.length || discoveryLines.length);
    if (!hasGeometry) ensurePlaceholder();
    else placeholder?.remove();
    project();
    if (hasGeometry) {
      for (let x = 0; x <= 1000; x += 100) line('grid-line', `M ${x} 0 L ${x} 700`);
      for (let y = 0; y <= 700; y += 100) line('grid-line', `M 0 ${y} L 1000 ${y}`);
      line('contour', 'M0 180 Q180 70 360 180 T700 170 T1000 130');
      line('contour', 'M0 260 Q180 150 360 260 T700 250 T1000 210');
      line('contour', 'M0 560 Q180 450 360 560 T700 550 T1000 510');
      drawDiscovery();
      for (const corridor of corridors) {
        if (corridor.id === selected?.id) continue;
        const faint = line('road-faint', pathData(corridor.geometry));
        faint.setAttribute('aria-hidden', 'true');
      }
      drawOverlay();
      drawOccurrenceOverlay();
      if (selected) drawSelected(selected);
      content.append(text('map-label', 20, 35, projection.readout()));
      content.append(text('map-badge', 20, 660, selected?.badge ?? discovery?.badge
        ?? 'OREGON ROAD PILOT · REAL ROAD GEOMETRY · ACCESS UNVERIFIED'));
    }
    viewBox();
    drawSearchLayer();
  }

  // The search preview: the published coverage outline, the disk the radius describes, the bounding box the
  // cells are actually selected with, and the chosen centre. It is a visual aid for choosing a search - the
  // run keeps its own exact geographic inclusion and never reads this geometry as an analysis input.
  function drawSearchLayer() {
    searchLayer.replaceChildren();
    key.textContent = search?.label
      ? `Schematic coordinate grid · no basemap · ${search.label}` : 'Schematic coordinate grid · no basemap';
    if (!search?.bounds || !projection) return;
    if (search.regionBounds) rectangle(search.regionBounds, 'search-region');
    if (search.kind !== 'radius' || !search.center) {
      rectangle(search.bounds, 'search-area');
      const [x, y] = projection.point([search.bounds[0], search.bounds[3]]);
      searchLayer.append(text('search-label', x + 6, Math.max(16, y - 8), search.label ?? 'Declared search area'));
      return;
    }
    rectangle(search.bounds, 'search-box');
    const [cx, cy] = projection.point(search.center);
    const [ex, ey] = projection.point([search.bounds[2], search.bounds[3]]);
    // The disk is drawn from the same bounds the radius implies, so the ellipse and the selection box agree:
    // the box is the extent cells are chosen with, the ellipse is the requested radius itself.
    const ellipse = document.createElementNS(SVG_NS, 'ellipse');
    ellipse.setAttribute('class', 'search-disk');
    ellipse.setAttribute('cx', cx.toFixed(2));
    ellipse.setAttribute('cy', cy.toFixed(2));
    ellipse.setAttribute('rx', Math.max(Math.abs(ex - cx), 0.5).toFixed(2));
    ellipse.setAttribute('ry', Math.max(Math.abs(ey - cy), 0.5).toFixed(2));
    searchLayer.append(ellipse);
    // The centre marker: a ring and a cross, so it is distinguishable from a mapped point and never a fill.
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('class', 'search-center');
    ring.setAttribute('cx', cx.toFixed(2));
    ring.setAttribute('cy', cy.toFixed(2));
    ring.setAttribute('r', '7');
    searchLayer.append(ring);
    for (const d of [`M ${(cx - 10).toFixed(2)} ${cy.toFixed(2)} L ${(cx + 10).toFixed(2)} ${cy.toFixed(2)}`,
      `M ${cx.toFixed(2)} ${(cy - 10).toFixed(2)} L ${cx.toFixed(2)} ${(cy + 10).toFixed(2)}`]) {
      const cross = document.createElementNS(SVG_NS, 'path');
      cross.setAttribute('class', 'search-center-cross');
      cross.setAttribute('d', d);
      searchLayer.append(cross);
    }
    searchLayer.append(text('search-label', cx + 12, Math.max(16, cy - 12), search.label ?? ''));
  }

  function rectangle(bounds, className) {
    const [x1, y1] = projection.point([bounds[0], bounds[3]]);
    const [x2, y2] = projection.point([bounds[2], bounds[1]]);
    const node = document.createElementNS(SVG_NS, 'rect');
    node.setAttribute('class', className);
    node.setAttribute('x', Math.min(x1, x2).toFixed(2));
    node.setAttribute('y', Math.min(y1, y2).toFixed(2));
    node.setAttribute('width', Math.abs(x2 - x1).toFixed(2));
    node.setAttribute('height', Math.abs(y2 - y1).toFixed(2));
    searchLayer.append(node);
    return node;
  }

  // Discovery corridors are drawn as light polylines: one path per corridor, no labels and no anchors,
  // so a bounded search result stays a bounded number of map nodes. The selected and promoted corridors
  // are the only ones emphasised (see MAX_DISCOVERY_PATHS in src/discovery/constants.js).
  function drawDiscovery() {
    if (!discovery) return;
    for (const entry of discovery.corridors ?? []) {
      const isSelected = entry.id === discovery.selectedId;
      const isPromoted = (discovery.promotedIds ?? []).includes(entry.id);
      if (isSelected || isPromoted) continue;
      const path = line('discovery-corridor', pathData(entry.geometry));
      path.setAttribute('aria-hidden', 'true');
    }
    for (const entry of discovery.corridors ?? []) {
      if (!(discovery.promotedIds ?? []).includes(entry.id) || entry.id === discovery.selectedId) continue;
      const path = line('discovery-corridor promoted', pathData(entry.geometry));
      path.setAttribute('aria-hidden', 'true');
    }
    const selectedEntry = (discovery.corridors ?? []).find(entry => entry.id === discovery.selectedId);
    if (selectedEntry) {
      line('discovery-shadow', pathData(selectedEntry.geometry));
      const path = line('discovery-selected', pathData(selectedEntry.geometry));
      path.setAttribute('role', 'button');
      path.setAttribute('tabindex', '0');
      path.setAttribute('aria-label', `Selected discovery corridor ${selectedEntry.name}`);
    }
  }

  // Occurrence points are precise public observations only, already privacy-filtered by the
  // occurrence layer; obscured, approximate, and unavailable locations never reach this function.
  function drawOccurrenceOverlay() {
    if (!occurrenceOverlay) return;
    for (const point of occurrenceOverlay.points ?? []) {
      const [x, y] = projection.point(point.coordinates).map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      node.setAttribute('class', `occurrence-point occurrence-${point.source}`);
      node.setAttribute('cx', x.toFixed(1));
      node.setAttribute('cy', y.toFixed(1));
      node.setAttribute('r', '4');
      node.setAttribute('aria-hidden', 'true');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${point.label ?? 'Observation'}${point.distanceToCorridorM != null ? ` · ${Math.round(point.distanceToCorridorM)} m from the corridor` : ''}`;
      node.append(title);
      content.append(node);
    }
  }

  // Habitat layers stay off by default: the road corridor remains the readable top layer, and the
  // overlay is requested only when the user asks for it.
  function drawOverlay() {
    if (!overlay) return;
    if (overlay.bufferGeometry) line('habitat-buffer', pathData(overlay.bufferGeometry));
    for (const feature of overlay.features ?? []) {
      const className = feature.layer === 'wetland' ? 'habitat-wetland' : 'habitat-flowline';
      const node = line(className, pathData(feature.geometry));
      node.setAttribute('aria-hidden', 'true');
      if (feature.label) node.setAttribute('data-label', `${feature.label}${feature.code ? ` (${feature.code})` : ''}`);
    }
  }

  function drawSelected(corridor) {
    const d = pathData(corridor.geometry);
    line('road-shadow', d);
    const road = line('road', d);
    road.setAttribute('tabindex', '0');
    road.setAttribute('role', 'button');
    road.setAttribute('aria-label', `Select ${corridor.name}`);
    road.addEventListener('click', () => onSelect?.(corridor.id));
    road.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(corridor.id); } });
    for (const coordinates of linesOf(corridor.geometry)) {
      for (const point of [coordinates[0], coordinates.at(-1)]) {
        const [cx, cy] = projection.point(point);
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('class', 'anchor');
        circle.setAttribute('cx', cx);
        circle.setAttribute('cy', cy);
        circle.setAttribute('r', 8);
        content.append(circle);
      }
    }
  }

  function line(className, d) { const path = document.createElementNS(SVG_NS, 'path'); path.setAttribute('class', className); path.setAttribute('d', d); content.append(path); return path; }
  function text(className, x, y, content_) { const node = document.createElementNS(SVG_NS, 'text'); node.setAttribute('class', className); node.setAttribute('x', x); node.setAttribute('y', y); node.textContent = content_; return node; }
  function pathData(geometry) { return linesOf(geometry).map(coordinates => coordinates.map((point, index) => `${index ? 'L' : 'M'} ${projection.point(point).join(' ')}`).join(' ')).join(' '); }
  function selectable() { return Boolean(selected); }

  // A press on the map is a pan, and a press that does not move is a pick. The distinction is what lets
  // ordinary dragging keep working while the map is in centre-picking mode.
  function invertClient(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const view = svg.viewBox.baseVal;
    if (!rect.width || !rect.height || !projection?.invert) return [null, null];
    return projection.invert([view.x + (clientX - rect.left) * view.width / rect.width,
      view.y + (clientY - rect.top) * view.height / rect.height]);
  }

  function pickAt(clientX, clientY) {
    const [lon, lat] = invertClient(clientX, clientY);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    onPickCoordinate?.([lon, lat]);
    return true;
  }

  function setSearchPreview(next) {
    search = next ?? null;
    project();
    viewBox();
    drawSearchLayer();
  }

  // Centre picking. The map is one way to choose a centre, never the only way: the discovery panel carries
  // labelled latitude and longitude fields, and Enter places the centre in the middle of the current view, so
  // a keyboard user never has to point at a pixel.
  function setPickMode(on) {
    picking = Boolean(on);
    svg.classList.toggle('picking', picking);
    if (picking) {
      svg.setAttribute('tabindex', '0');
      svg.setAttribute('aria-label', 'Search centre picker: press Enter to place the search centre at the middle of the view, or use the latitude and longitude fields in the discovery panel');
    } else {
      svg.removeAttribute('tabindex');
      svg.setAttribute('aria-label', 'Corridor geometry on a schematic coordinate grid');
    }
  }

  svg.addEventListener('wheel', event => { if (!selectable()) return; event.preventDefault(); zoom = Math.max(1, Math.min(4, zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2))); viewBox(); }, { passive: false });
  svg.addEventListener('pointerdown', event => {
    press = { x: event.clientX, y: event.clientY, moved: false };
    if (!selectable() || event.target.closest?.('.road')) return;
    dragging = { x: event.clientX, y: event.clientY, pan: { ...pan } };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', event => {
    if (press && Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y) > 6) press.moved = true;
    if (!dragging) return;
    const rect = svg.getBoundingClientRect();
    pan = { x: dragging.pan.x - (event.clientX - dragging.x) * 1000 / rect.width / zoom, y: dragging.pan.y - (event.clientY - dragging.y) * 700 / rect.height / zoom };
    viewBox();
  });
  svg.addEventListener('pointerup', event => {
    const released = press;
    press = null;
    dragging = null;
    if (!picking || !released || released.moved) return;
    if (event.target.closest?.('.road')) return; // a road click stays a road click
    pickAt(event.clientX, event.clientY);
  });
  svg.addEventListener('pointercancel', () => { press = null; dragging = null; });
  svg.addEventListener('keydown', event => {
    if (!picking || event.target !== svg) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    const view = svg.viewBox.baseVal;
    pickAt(view.x + view.width / 2, view.y + view.height / 2);
  });
  draw({ corridors: [], selectedId: null });
  return { draw, fit, setSearchPreview, setPickMode, getZoom: () => zoom,
    // Exposed so a browser test can ask the same projection what a map click means, without a click.
    toCoordinate: ([x, y]) => projection.invert([x, y]) };
}

// The projection is a plain equirectangular fit with one scale for both axes, so it inverts exactly: the map
// can answer "which coordinate did that press land on?" with the same numbers it drew with. `fallbackBounds`
// is the published region, used only when there is no geometry to fit yet.
function createProjection(lines, fallbackBounds = null) {
  // Bounded loops, not spread: a discovery result can hold tens of thousands of vertices and spreading
  // them into Math.min would overflow the call stack.
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const line of lines) for (const point of line) {
    if (point[0] < minLon) minLon = point[0];
    if (point[0] > maxLon) maxLon = point[0];
    if (point[1] < minLat) minLat = point[1];
    if (point[1] > maxLat) maxLat = point[1];
  }
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) {
    if (!Array.isArray(fallbackBounds) || fallbackBounds.length !== 4) {
      return { point: () => [0, 0], invert: () => [null, null], readout: () => 'No geometry' };
    }
    [minLon, minLat, maxLon, maxLat] = fallbackBounds;
  }
  const spanLon = Math.max(maxLon - minLon, 0.01), spanLat = Math.max(maxLat - minLat, 0.007);
  const lonCenter = (minLon + maxLon) / 2, latCenter = (minLat + maxLat) / 2;
  const scale = Math.min(760 / spanLon, 460 / spanLat);
  return {
    scale, lonCenter, latCenter,
    point: ([lon, lat]) => [500 + (lon - lonCenter) * scale, 350 - (lat - latCenter) * scale],
    invert: ([x, y]) => [lonCenter + (x - 500) / scale, latCenter - (y - 350) / scale],
    readout: () => `${latCenter.toFixed(4)}° N  ·  ${Math.abs(lonCenter).toFixed(4)}° W  ·  ${(spanLon * 111.32 * Math.cos(latCenter * Math.PI / 180)).toFixed(1)} km across`,
  };
}

