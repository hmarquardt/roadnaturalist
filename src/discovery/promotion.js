import { minDistanceToLineM } from '../domain/geometry.js';
import { buildDiscoveryUnits } from './units.js';
import { segmentUnit } from './segment.js';

// Promotion verification for a precomputed corridor row.
//
// A derived row is an index over the raw regional partitions: it accelerates browsing, and it is never
// evidence. Before a precomputed corridor may become a candidate, the raw regional road network is composed
// again and the corridor the row claims must be reproduced by that composition - same corridor id, same
// geometry to within a metre. If it is not, promotion fails closed and the person is told why, rather than the
// detailed panel quietly measuring precomputed geometry.
export const PROMOTION_MAX_DRIFT_M = 1;

export function linesOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  return geometry.type === 'MultiLineString' ? geometry.coordinates : [];
}

export function maxDriftM(from, to) {
  let worst = 0;
  for (const line of linesOf(from)) {
    for (const point of line) worst = Math.max(worst, minDistanceToLineM(point, to));
  }
  return worst;
}

export function verifyDerivedPromotion({ derived, features, maxDriftM: tolerance = PROMOTION_MAX_DRIFT_M } = {}) {
  if (!derived?.id) throw new TypeError('Promotion verification needs the precomputed corridor row');
  for (const unit of buildDiscoveryUnits(features ?? []).units) {
    for (const corridor of segmentUnit(unit).corridors) {
      if (corridor.id !== derived.id) continue;
      const driftM = Math.max(maxDriftM(derived.geometry, corridor.geometry),
        maxDriftM(corridor.geometry, derived.geometry));
      if (driftM > tolerance) {
        throw new Error(`the raw corridor differs from the precomputed row by about ${Math.round(driftM)} m`);
      }
      return Object.freeze({ unit, corridor, features: features ?? [], driftM });
    }
  }
  throw new Error('the raw regional road network does not compose this corridor id');
}
