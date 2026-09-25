const SVG_NS = 'http://www.w3.org/2000/svg';

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

  function draw({ corridors: next = [], selectedId = null } = {}) {
    corridors = Array.isArray(next) ? next : [];
    selected = corridors.find(corridor => corridor.id === selectedId) ?? null;
    fit();
    render();
  }

  function render() {
    svg.replaceChildren();
    const placeholder = container.querySelector('.map-placeholder');
    if (!corridors.length) {
      if (!placeholder) {
        const empty = document.createElement('div');
        empty.className = 'map-placeholder';
        empty.innerHTML = '<div><strong>No corridor loaded</strong><p>Open the Oregon road pilot to place real road geometry here.</p></div>';
        container.append(empty);
      }
      return;
    }
    placeholder?.remove();
    projection = createProjection(corridors.flatMap(corridor => linesOf(corridor.geometry)));
    for (let x = 0; x <= 1000; x += 100) line('grid-line', `M ${x} 0 L ${x} 700`);
    for (let y = 0; y <= 700; y += 100) line('grid-line', `M 0 ${y} L 1000 ${y}`);
    line('contour', 'M0 180 Q180 70 360 180 T700 170 T1000 130');
    line('contour', 'M0 260 Q180 150 360 260 T700 250 T1000 210');
    line('contour', 'M0 560 Q180 450 360 560 T700 550 T1000 510');
    for (const corridor of corridors) {
      if (corridor.id === selected?.id) continue;
      const faint = line('road-faint', pathData(corridor.geometry));
      faint.setAttribute('aria-hidden', 'true');
    }
    if (selected) drawSelected(selected);
    svg.append(text('map-label', 20, 35, projection.readout()));
    svg.append(text('map-badge', 20, 660, selected?.badge ?? 'OREGON ROAD PILOT · REAL ROAD GEOMETRY · ACCESS UNVERIFIED'));
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

export function linesOf(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

function createProjection(lines) {
  const points = lines.flat();
  const longitudes = points.map(point => point[0]);
  const latitudes = points.map(point => point[1]);
  const minLon = Math.min(...longitudes), maxLon = Math.max(...longitudes);
  const minLat = Math.min(...latitudes), maxLat = Math.max(...latitudes);
  const spanLon = Math.max(maxLon - minLon, 0.01), spanLat = Math.max(maxLat - minLat, 0.007);
  const lonCenter = (minLon + maxLon) / 2, latCenter = (minLat + maxLat) / 2;
  const scale = Math.min(760 / spanLon, 460 / spanLat);
  return {
    point: ([lon, lat]) => [500 + (lon - lonCenter) * scale, 350 - (lat - latCenter) * scale],
    readout: () => `${latCenter.toFixed(4)}° N  ·  ${Math.abs(lonCenter).toFixed(4)}° W  ·  ${(spanLon * 111.32 * Math.cos(latCenter * Math.PI / 180)).toFixed(1)} km across`,
  };
}

