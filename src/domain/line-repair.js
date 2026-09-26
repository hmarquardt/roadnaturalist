// Deterministic repairs for analytical line geometry.
//
// GEOS refuses to buffer some real corridors ("TopologyException: assigned depths do not match").
// The production evidence in tests/fixtures/discovery-geometry-failures.json shows why: every
// affected corridor is ST_IsValid = true but ST_IsSimple = false, because composing a name group
// makes the line visit some of its own points twice - a stretch retraced through two source features,
// a segment digitized in both directions, or a vertex the path returns to. GEOS's offset-curve builder
// assigns side depths per input edge and cannot resolve the conflict there. The road is fine; the
// representation handed to the engine is what breaks.
//
// Every repair in this module is point-set preserving, and that is the whole point:
//   - removeDuplicateSegments drops a segment whose two endpoints were already traversed, so the
//     covered points are unchanged (the twin copy still covers them exactly);
//   - splitRepeatedVertices only subdivides at a vertex the path already visits;
//   - insertSelfIntersectionNodes only adds vertices where the line already meets itself.
// No vertex moves, no gap closes, no branch disappears, no road is straightened, and no two separate
// roads are joined. Length along the traversal can change (removing a doubled traversal), which is why
// every caller reports that delta as provenance instead of hiding it.

import { haversineM, linesOf } from './geometry.js';

const SAME_VERTEX = (a, b) => a[0] === b[0] && a[1] === b[1];
const vertexKey = point => `${point[0]},${point[1]}`;

// A segment identity that ignores direction: a stretch traversed A->B and B->A is one stretch of road.
export function segmentKey(from, to) {
  return from[0] < to[0] || (from[0] === to[0] && from[1] <= to[1])
    ? `${from[0]},${from[1]}|${to[0]},${to[1]}` : `${to[0]},${to[1]}|${from[0]},${from[1]}`;
}

// Consecutive duplicate vertices and zero-length segments carry no geometry, and they confuse every
// metric and predicate that follows. Exact: only points bit-identical to their predecessor are dropped.
export function normalizeLineCoordinates(coordinates) {
  if (!Array.isArray(coordinates)) return [];
  const kept = [];
  for (const point of coordinates) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) continue;
    const previous = kept.at(-1);
    if (previous && SAME_VERTEX(previous, point)) continue;
    kept.push([point[0], point[1]]);
  }
  return kept;
}

// Join consecutive segments back into maximal runs. Solitary segments stay their own part.
function toGeometry(parts) {
  const usable = parts.filter(part => part.length >= 2);
  if (!usable.length) return null;
  return usable.length === 1 ? { type: 'LineString', coordinates: usable[0] }
    : { type: 'MultiLineString', coordinates: usable };
}

function joinSegments(segments) {
  const parts = [];
  for (const [from, to] of segments) {
    const current = parts.at(-1);
    if (current && SAME_VERTEX(current.at(-1), from)) current.push(to);
    else parts.push([from, to]);
  }
  return parts;
}

// Repair 1: drop segments whose vertex pair has already been traversed, keeping the first copy.
// The point set of the geometry is identical afterwards; only the doubly counted traversal goes.
export function removeDuplicateSegments(geometry) {
  const seen = new Set();
  const segments = [];
  let removedSegmentCount = 0;
  let removedLengthM = 0;
  for (const line of linesOf(geometry)) {
    const normalized = normalizeLineCoordinates(line);
    for (let index = 1; index < normalized.length; index++) {
      const key = segmentKey(normalized[index - 1], normalized[index]);
      if (seen.has(key)) {
        removedSegmentCount += 1;
        removedLengthM += haversineM(normalized[index - 1], normalized[index]);
        continue;
      }
      seen.add(key);
      segments.push([normalized[index - 1], normalized[index]]);
    }
  }
  return { geometry: toGeometry(joinSegments(segments)), changed: removedSegmentCount > 0,
    removedSegmentCount, removedLengthM };
}

// Repair 2: subdivide at every vertex the path visits more than once, so each piece is simple. This is
// pure subdivision: coordinates, order, gaps, and total length are untouched.
export function splitRepeatedVertices(geometry) {
  const parts = [];
  let splitPointCount = 0;
  for (const line of linesOf(geometry)) {
    const normalized = normalizeLineCoordinates(line);
    const counts = new Map();
    for (const point of normalized) counts.set(vertexKey(point), (counts.get(vertexKey(point)) ?? 0) + 1);
    let current = normalized.length ? [normalized[0]] : [];
    for (let index = 1; index < normalized.length; index++) {
      current.push(normalized[index]);
      const repeated = (counts.get(vertexKey(normalized[index - 1])) ?? 0) > 1 || (counts.get(vertexKey(normalized[index])) ?? 0) > 1;
      if (repeated && current.length > 1) { parts.push(current); splitPointCount += 1; current = [normalized[index]]; }
    }
    if (current.length > 1) parts.push(current);
  }
  return { geometry: toGeometry(parts), changed: splitPointCount > 0, splitPointCount };
}

// Repair 3: insert a vertex wherever the line meets itself (a crossing, a tangential touch, or a
// vertex lying on a later segment), then split into simple runs at those nodes and at repeated
// vertices. Subdivision only: every inserted vertex lies exactly on the source line.
export function insertSelfIntersectionNodes(geometry) {
  const lines = linesOf(geometry).map(normalizeLineCoordinates).filter(line => line.length >= 2);
  if (!lines.length) return { geometry: null, changed: false, nodeCount: 0 };
  const origin = lines[0][0];
  const lonScale = 111320 * Math.cos(origin[1] * Math.PI / 180);
  const toMetres = point => [(point[0] - origin[0]) * lonScale, (point[1] - origin[1]) * 110540];
  const toDegrees = point => [point[0] / lonScale + origin[0], point[1] / 110540 + origin[1]];
  const meeting = 1e-9; // one nanometre: exact coincidence, never a near miss
  const segments = [];
  for (const line of lines) for (let index = 1; index < line.length; index++) {
    segments.push({ a: toMetres(line[index - 1]), b: toMetres(line[index]), cuts: [] });
  }
  for (let first = 0; first < segments.length; first++) {
    for (let second = first + 1; second < segments.length; second++) cutAtMeeting(segments[first], segments[second], meeting);
  }
  const at = (segment, parameter) => [segment.a[0] + (segment.b[0] - segment.a[0]) * parameter, segment.a[1] + (segment.b[1] - segment.a[1]) * parameter];
  const nodeKey = point => `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
  const nodes = new Set();
  for (const segment of segments) for (const cut of segment.cuts) nodes.add(nodeKey(at(segment, cut)));
  for (const line of lines) {
    const counts = new Map();
    for (const point of line) counts.set(vertexKey(point), (counts.get(vertexKey(point)) ?? 0) + 1);
    for (const [key, count] of counts) if (count > 1) nodes.add(nodeKey(toMetres(key.split(',').map(Number))));
  }
  // Walk the original traversal once, inserting node vertices where the line meets itself, then split at
  // those nodes. This only re-splits the existing path: no vertex moves, none is dropped, and total
  // length is unchanged.
  const vertices = [];
  let segmentIndex = 0;
  for (const line of lines) {
    vertices.push({ point: line[0], junction: nodes.has(nodeKey(toMetres(line[0]))), boundary: false });
    for (let index = 1; index < line.length; index++) {
      const segment = segments[segmentIndex++];
      const cuts = [...new Set(segment.cuts.map(cut => cut.toFixed(12)))].map(Number).sort((a, b) => a - b);
      for (const cut of cuts) vertices.push({ point: toDegrees(at(segment, cut)), junction: true, boundary: false });
      vertices.push({ point: line[index], junction: nodes.has(nodeKey(toMetres(line[index]))), boundary: false });
    }
    // A part boundary is always a break: separate parts of a MultiLineString are never joined, however
    // close they are.
    vertices.at(-1).boundary = true;
  }
  const runs = [];
  let current = [];
  for (const vertex of vertices) {
    current.push(vertex.point);
    if (vertex.boundary) { if (current.length >= 2) runs.push(current); current = []; continue; }
    if (vertex.junction && current.length >= 2) { runs.push(current); current = [vertex.point]; }
  }
  if (current.length >= 2) runs.push(current);
  const nodeCount = segments.reduce((total, segment) => total + new Set(segment.cuts.map(cut => cut.toFixed(12))).size, 0);
  return { geometry: toGeometry(runs), changed: nodeCount > 0, nodeCount };
}

// Closest approach between two segments in metres (clamped least squares, after Ericson), recording the
// interior meeting point as a parameter cut on each segment. A near miss beyond the tolerance is left
// alone: this only nodes a line where it genuinely meets itself.
function cutAtMeeting(first, second, toleranceM) {
  const ux = first.b[0] - first.a[0], uy = first.b[1] - first.a[1];
  const vx = second.b[0] - second.a[0], vy = second.b[1] - second.a[1];
  const wx = first.a[0] - second.a[0], wy = first.a[1] - second.a[1];
  const a = ux * ux + uy * uy, c = vx * vx + vy * vy;
  if (a === 0 || c === 0) return;
  const b = ux * vx + uy * vy, d = ux * wx + uy * wy, e = vx * wx + vy * wy;
  const denominator = a * c - b * b;
  const clamp = value => Math.max(0, Math.min(1, value));
  if (denominator === 0) {
    // Parallel. Only collinear segments can share points, and then the node points are the other
    // segment's endpoints projected into this one, which is what makes an overlapping traversal simple.
    if (Math.abs(ux * wy - uy * wx) / Math.sqrt(a) > toleranceM) return;
    const projectOnto = (target, origin, direction, lengthSquared, point) => {
      const dx = point[0] - origin[0], dy = point[1] - origin[1];
      const parameter = (dx * direction[0] + dy * direction[1]) / lengthSquared;
      if (parameter > 1e-9 && parameter < 1 - 1e-9) target.cuts.push(parameter);
    };
    projectOnto(first, first.a, [ux, uy], a, second.a);
    projectOnto(first, first.a, [ux, uy], a, second.b);
    projectOnto(second, second.a, [vx, vy], c, first.a);
    projectOnto(second, second.a, [vx, vy], c, first.b);
    return;
  }
  let t = clamp((b * e - c * d) / denominator);
  let s = (a * e - b * d) / denominator;
  if (s < 0) { s = 0; t = clamp(-d / a); } else if (s > 1) { s = 1; t = clamp((b - d) / a); }
  const onFirst = [first.a[0] + ux * t, first.a[1] + uy * t];
  const onSecond = [second.a[0] + vx * s, second.a[1] + vy * s];
  if (Math.hypot(onFirst[0] - onSecond[0], onFirst[1] - onSecond[1]) > toleranceM) return;
  if (t > 1e-9 && t < 1 - 1e-9) first.cuts.push(t);
  if (s > 1e-9 && s < 1 - 1e-9) second.cuts.push(s);
}
