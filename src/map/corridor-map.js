const SVG_NS = 'http://www.w3.org/2000/svg';

// Corridor geometry access lives in the domain layer; the map only projects and draws it.
import { linesOf } from '../domain/geometry.js';

// The map is a replaceable view over canonical GeoJSON. It never owns the domain model:
// it receives plain corridor descriptors and draws them on a schematic coordinate grid.
export function createCorridorMap(container, { onSelect } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 1000 700');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Corridor geometry on a schematic coordinate grid');
  container.append(svg);
  const key = document.createElement('div');
  key.className = 'map-key';
  key.textContent = 'Schematic coordinate grid · no basemap';
  container.append(key);
  let corridors = [];
  let selected = null;
  let overlay = null;
  let occurrenceOverlay = null;
  let discovery = null;
  let zoom = 1;
  let pan = { x: 0, y: 0 };
  let dragging = null;
  let projection = null;

  function viewBox() {
    const width = 1000 / zoom;
    const height = 700 / zoom;
    svg.setAttribute('viewBox', `${(1000 - width) / 2 + pan.x} ${(700 - height) / 2 + pan.y} ${width} ${height}`);
  }
  function fit() { zoom = 1; pan = { x: 0, y: 0 }; viewBox(); }

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

  function render() {
    svg.replaceChildren();
    const placeholder = container.querySelector('.map-placeholder');
    const discoveryLines = (discovery?.corridors ?? []).flatMap(entry => linesOf(entry.geometry));
    if (!corridors.length && !discoveryLines.length) {
      if (!placeholder) {
        const empty = document.createElement('div');
        empty.className = 'map-placeholder';
        empty.innerHTML = '<div><strong>No corridor loaded</strong><p>Discover roads in the Oregon pilot area, or open the road pilot, to place real road geometry here.</p></div>';
        container.append(empty);
      }
      return;
    }
    placeholder?.remove();
    projection = createProjection([...corridors.flatMap(corridor => linesOf(corridor.geometry)), ...discoveryLines]);
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
    svg.append(text('map-label', 20, 35, projection.readout()));
    svg.append(text('map-badge', 20, 660, selected?.badge ?? discovery?.badge
      ?? 'OREGON ROAD PILOT · REAL ROAD GEOMETRY · ACCESS UNVERIFIED'));
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
      svg.append(node);
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
        svg.append(circle);
      }
    }
  }

  function line(className, d) { const path = document.createElementNS(SVG_NS, 'path'); path.setAttribute('class', className); path.setAttribute('d', d); svg.append(path); return path; }
  function text(className, x, y, content) { const node = document.createElementNS(SVG_NS, 'text'); node.setAttribute('class', className); node.setAttribute('x', x); node.setAttribute('y', y); node.textContent = content; return node; }
  function pathData(geometry) { return linesOf(geometry).map(coordinates => coordinates.map((point, index) => `${index ? 'L' : 'M'} ${projection.point(point).join(' ')}`).join(' ')).join(' '); }
  function selectable() { return Boolean(selected); }

  svg.addEventListener('wheel', event => { if (!selectable()) return; event.preventDefault(); zoom = Math.max(1, Math.min(4, zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2))); viewBox(); }, { passive: false });
  svg.addEventListener('pointerdown', event => { if (!selectable() || event.target.closest('.road')) return; dragging = { x: event.clientX, y: event.clientY, pan: { ...pan } }; svg.setPointerCapture(event.pointerId); });
  svg.addEventListener('pointermove', event => { if (!dragging) return; const rect = svg.getBoundingClientRect(); pan = { x: dragging.pan.x - (event.clientX - dragging.x) * 1000 / rect.width / zoom, y: dragging.pan.y - (event.clientY - dragging.y) * 700 / rect.height / zoom }; viewBox(); });
  svg.addEventListener('pointerup', () => { dragging = null; });
  draw({ corridors: [], selectedId: null });
  return { draw, fit, getZoom: () => zoom };
}

function createProjection(lines) {
  // Bounded loops, not spread: a discovery result can hold tens of thousands of vertices and spreading
  // them into Math.min would overflow the call stack.
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const line of lines) for (const point of line) {
    if (point[0] < minLon) minLon = point[0];
    if (point[0] > maxLon) maxLon = point[0];
    if (point[1] < minLat) minLat = point[1];
    if (point[1] > maxLat) maxLat = point[1];
  }
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return { point: () => [0, 0], readout: () => 'No geometry' };
  const spanLon = Math.max(maxLon - minLon, 0.01), spanLat = Math.max(maxLat - minLat, 0.007);
  const lonCenter = (minLon + maxLon) / 2, latCenter = (minLat + maxLat) / 2;
  const scale = Math.min(760 / spanLon, 460 / spanLat);
  return {
    point: ([lon, lat]) => [500 + (lon - lonCenter) * scale, 350 - (lat - latCenter) * scale],
    readout: () => `${latCenter.toFixed(4)}° N  ·  ${Math.abs(lonCenter).toFixed(4)}° W  ·  ${(spanLon * 111.32 * Math.cos(latCenter * Math.PI / 180)).toFixed(1)} km across`,
  };
}

