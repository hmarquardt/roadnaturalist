import { corridorGeometry, haversineM, linesOf } from '../domain/geometry.js';
import { MIN_CORRIDOR_M, TARGET_CORRIDOR_M, MAX_CORRIDOR_M } from './constants.js';
import { lineLengthM } from '../roads/normalize.js';

// A 40-mile named road is not a useful discovery candidate, so a long unit is divided into contiguous
// analysis corridors. Cuts land on source vertices, are ordered along the composed geometry, and never
// bridge a reported gap; length is preserved exactly (the segments tile the unit). These thresholds are
// interface units, not ecological truths, and the segmentation is reported with every result.

export function segmentationCount(totalM, { targetCorridorM = TARGET_CORRIDOR_M, maxCorridorM = MAX_CORRIDOR_M } = {}) {
  if (!Number.isFinite(totalM) || totalM <= 0) throw new TypeError('Segmentation needs a positive corridor length');
  if (totalM <= maxCorridorM) return 1;
  return Math.max(2, Math.round(totalM / targetCorridorM));
}

export function segmentUnit(unit, { minCorridorM = MIN_CORRIDOR_M, targetCorridorM = TARGET_CORRIDOR_M,
  maxCorridorM = MAX_CORRIDOR_M } = {}) {
  const geometry = corridorGeometry(unit.geometry).geometry;
  const parts = linesOf(geometry).map(coordinates => ({ coordinates, lengthM: lineLengthM(coordinates) }));
  const totalM = parts.reduce((sum, part) => sum + part.lengthM, 0);
  if (totalM < minCorridorM) {
    return { corridors: [], dropped: Object.freeze({ reason: 'shorter than the minimum discovery corridor',
      lengthM: totalM, minCorridorM }) };
  }
  const count = segmentationCount(totalM, { targetCorridorM, maxCorridorM });
  const cuts = [];
  for (let index = 1; index < count; index++) cuts.push(totalM * index / count);
  const pieces = [];
  let current = [];
  let accumulated = 0;
  let cutIndex = 0;
  for (const part of parts) {
    let pieceStart = 0;
    for (let index = 1; index < part.coordinates.length; index++) {
      accumulated += haversineM(part.coordinates[index - 1], part.coordinates[index]);
      while (cutIndex < cuts.length && accumulated >= cuts[cutIndex]) {
        // A cut at the last vertex of a part belongs to the part boundary, and a zero-length piece is
        // never emitted, so no segment can be empty or overlap its neighbour.
        if (index >= part.coordinates.length - 1 || pieceStart === index) { cutIndex += 1; continue; }
        current.push(part.coordinates.slice(pieceStart, index + 1));
        pieces.push(current);
        current = [];
        pieceStart = index;
        cutIndex += 1;
      }
    }
    const tail = part.coordinates.slice(pieceStart);
    if (tail.length >= 2) current.push(tail);
  }
  if (current.length) pieces.push(current);
  const corridors = pieces.filter(piece => piece.length).map((lines, index) => {
    const geometry = lines.length === 1 ? { type: 'LineString', coordinates: lines[0] }
      : { type: 'MultiLineString', coordinates: lines };
    const measured = corridorGeometry(geometry);
    return Object.freeze({
      id: `${unit.id}-s${index + 1}`, name: unit.name, geometry: measured.geometry, lengthM: measured.lengthM,
      bounds: measured.bounds, unitId: unit.id, segmentIndex: index + 1, segmentCount: pieces.length,
      parts: lines.length,
    });
  });
  return { corridors, segmentation: Object.freeze({ count, totalM, targetM: totalM / count, minCorridorM, targetCorridorM, maxCorridorM }) };
}
