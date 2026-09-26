// GeoJSON longitude/latitude coordinates are the domain boundary. Metrics are
// derived, not trusted from fixtures or map-library objects.
export function corridorGeometry(input) {
  const geometry = input?.geometry ?? input;
  const lines = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : null;
  if (!Array.isArray(lines) || !lines.length || !lines.every(line => Array.isArray(line) && line.length >= 2 && line.every(validPoint))) {
    throw new TypeError('Corridor must be a GeoJSON LineString or MultiLineString with valid [longitude, latitude] coordinates');
  }
  const points = lines.flat();
  const bounds = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
  let lengthM = 0;
  for (const line of lines) for (let i = 1; i < line.length; i++) lengthM += haversineM(line[i - 1], line[i]);
  if (lengthM <= 0) throw new TypeError('Corridor must have positive length');
  const coordinates = lines.map(line => line.map(point => [...point]));
  return { geometry: { type: geometry.type, coordinates: geometry.type === 'LineString' ? coordinates[0] : coordinates }, bounds, lengthM };
}

function validPoint(point) { return Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90; }
export function haversineM(a, b) { const rad = Math.PI / 180; const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2; return 12742000 * Math.asin(Math.min(1, Math.sqrt(h))); }

export function mergeLineGeometries(geometries) {
  const lines = geometries.flatMap(geometry => geometry?.type === 'LineString' ? [geometry.coordinates]
    : geometry?.type === 'MultiLineString' ? geometry.coordinates : []);
  if (!lines.length) throw new TypeError('No line geometry to merge');
  return lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines };
}

// Coordinate access for line GeoJSON, defined once at the domain boundary so the analysis layers and
// the replaceable map view read the same shape.
export function linesOf(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

export function corridorWkt(input) {
  const { geometry } = corridorGeometry(input);
  const lineText = line => `(${line.map(point => point.join(' ')).join(',')})`;
  return geometry.type === 'LineString' ? `LINESTRING${lineText(geometry.coordinates)}` : `MULTILINESTRING(${geometry.coordinates.map(lineText).join(',')})`;
}

// Explicit metric accessors for analytical geometry preparation, so repair impact can be measured
// without another geometry engine and without trusting a derived value.
export function lineLengthM(geometry) {
  let total = 0;
  for (const line of linesOf(geometry)) for (let index = 1; index < line.length; index++) total += haversineM(line[index - 1], line[index]);
  return total;
}

export function vertexCount(geometry) {
  return linesOf(geometry).reduce((total, line) => total + line.length, 0);
}

export function boundsOf(geometry) {
  const points = linesOf(geometry).flat();
  if (!points.length) return null;
  return [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])),
    Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))];
}

// Metres from a point to the closest position on any line, in a local equirectangular frame. This is
// the displacement measure repair has to stay inside; it is deliberately independent of the engine.
export function pointToLineM(point, geometry) {
  let best = Infinity;
  for (const line of linesOf(geometry)) {
    for (let index = 1; index < line.length; index++) {
      const from = line[index - 1], to = line[index];
      const latScale = Math.cos(point[1] * Math.PI / 180);
      const dx = (to[0] - from[0]) * 111320 * latScale, dy = (to[1] - from[1]) * 110540;
      const lengthSquared = dx * dx + dy * dy;
      const px = (point[0] - from[0]) * 111320 * latScale, py = (point[1] - from[1]) * 110540;
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared));
      best = Math.min(best, Math.hypot(px - t * dx, py - t * dy));
    }
  }
  return best;
}

// Symmetric discrete Hausdorff distance: the largest distance from any sampled point of either
// geometry to the other geometry. Segment midpoints are sampled as well as vertices, so dropping a
// segment that is not exactly duplicated is caught instead of being hidden by its surviving endpoints.
export function sampledPoints(geometry) {
  const points = [];
  for (const line of linesOf(geometry)) {
    for (let index = 0; index < line.length; index++) {
      points.push(line[index]);
      if (index > 0) points.push([(line[index - 1][0] + line[index][0]) / 2, (line[index - 1][1] + line[index][1]) / 2]);
    }
  }
  return points;
}

export function symmetricDisplacementM(first, second) {
  let worst = 0;
  for (const point of sampledPoints(first)) worst = Math.max(worst, pointToLineM(point, second));
  for (const point of sampledPoints(second)) worst = Math.max(worst, pointToLineM(point, first));
  return worst;
}
