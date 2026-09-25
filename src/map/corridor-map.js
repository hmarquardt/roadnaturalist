const SVG_NS = 'http://www.w3.org/2000/svg';

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
  let selected = null;
  let zoom = 1;
  let pan = { x: 0, y: 0 };
  let dragging = null;

  function viewBox() {
    const width = 1000 / zoom;
    const height = 700 / zoom;
    svg.setAttribute('viewBox', `${(1000 - width) / 2 + pan.x} ${(700 - height) / 2 + pan.y} ${width} ${height}`);
  }
  function fit() { zoom = 1; pan = { x: 0, y: 0 }; viewBox(); }
  function draw(candidate) {
    selected = candidate;
    fit();
    svg.replaceChildren();
    if (!candidate) {
      const empty = document.createElement('div');
      empty.className = 'map-placeholder';
      empty.innerHTML = '<div><strong>No corridor selected</strong><p>Load a sample to inspect the map boundary.</p></div>';
      container.querySelector('.map-placeholder')?.remove();
      container.append(empty);
      return;
    }
    container.querySelector('.map-placeholder')?.remove();
    const lines = candidate.geometry.type === 'LineString' ? [candidate.geometry.coordinates] : candidate.geometry.coordinates;
    const coords = lines.flat();
    const longitudes = coords.map(p => p[0]);
    const latitudes = coords.map(p => p[1]);
    const minLon = Math.min(...longitudes), maxLon = Math.max(...longitudes);
    const minLat = Math.min(...latitudes), maxLat = Math.max(...latitudes);
    const spanLon = Math.max(maxLon - minLon, .01), spanLat = Math.max(maxLat - minLat, .007);
    const lonCenter = (minLon + maxLon) / 2, latCenter = (minLat + maxLat) / 2;
    const scale = Math.min(760 / spanLon, 460 / spanLat);
    const point = ([lon, lat]) => [500 + (lon - lonCenter) * scale, 350 - (lat - latCenter) * scale];
    const line = (className, d) => { const path = document.createElementNS(SVG_NS, 'path'); path.setAttribute('class', className); path.setAttribute('d', d); svg.append(path); return path; };
    for (let x = 0; x <= 1000; x += 100) { const node = document.createElementNS(SVG_NS, 'line'); node.setAttribute('class', 'grid-line'); node.setAttribute('x1', x); node.setAttribute('x2', x); node.setAttribute('y1', 0); node.setAttribute('y2', 700); svg.append(node); }
    for (let y = 0; y <= 700; y += 100) { const node = document.createElementNS(SVG_NS, 'line'); node.setAttribute('class', 'grid-line'); node.setAttribute('x1', 0); node.setAttribute('x2', 1000); node.setAttribute('y1', y); node.setAttribute('y2', y); svg.append(node); }
    line('contour', 'M0 180 Q180 70 360 180 T700 170 T1000 130');
    line('contour', 'M0 260 Q180 150 360 260 T700 250 T1000 210');
    line('contour', 'M0 560 Q180 450 360 560 T700 550 T1000 510');
    const d = lines.map(line => line.map((coord, index) => `${index ? 'L' : 'M'} ${point(coord).join(' ')}`).join(' ')).join(' ');
    line('road-shadow', d);
    const road = line('road', d);
    road.setAttribute('tabindex', '0');
    road.setAttribute('role', 'button');
    road.setAttribute('aria-label', `Select ${candidate.name}`);
    road.addEventListener('click', () => onSelect?.(candidate.id));
    road.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(candidate.id); } });
    for (const line of lines) for (const coord of [line[0], line.at(-1)]) { const [cx, cy] = point(coord); const circle = document.createElementNS(SVG_NS, 'circle'); circle.setAttribute('class', 'anchor'); circle.setAttribute('cx', cx); circle.setAttribute('cy', cy); circle.setAttribute('r', 8); svg.append(circle); }
    const label = document.createElementNS(SVG_NS, 'text'); label.setAttribute('class', 'map-label'); label.setAttribute('x', 20); label.setAttribute('y', 35); label.textContent = `${latCenter.toFixed(3)}° N  ·  ${Math.abs(lonCenter).toFixed(3)}° W`; svg.append(label);
    const badge = document.createElementNS(SVG_NS, 'text'); badge.setAttribute('class', 'map-badge'); badge.setAttribute('x', 20); badge.setAttribute('y', 660); badge.textContent = 'SYNTHETIC SAMPLE · NOT A VERIFIED ROAD'; svg.append(badge);
  }
  svg.addEventListener('wheel', event => { if (!selected) return; event.preventDefault(); zoom = Math.max(1, Math.min(4, zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2))); viewBox(); }, { passive: false });
  svg.addEventListener('pointerdown', event => { if (!selected || event.target.closest('.road')) return; dragging = { x: event.clientX, y: event.clientY, pan: { ...pan } }; svg.setPointerCapture(event.pointerId); });
  svg.addEventListener('pointermove', event => { if (!dragging) return; const rect = svg.getBoundingClientRect(); pan = { x: dragging.pan.x - (event.clientX - dragging.x) * 1000 / rect.width / zoom, y: dragging.pan.y - (event.clientY - dragging.y) * 700 / rect.height / zoom }; viewBox(); });
  svg.addEventListener('pointerup', () => { dragging = null; });
  draw(null);
  return { draw, fit, getZoom: () => zoom };
}
