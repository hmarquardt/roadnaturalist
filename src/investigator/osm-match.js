// Deterministic association of OSM ways with the canonical TIGER/Line corridor.
//
// TIGER/Line stays the geometry authority and OSM stays an independent context/verification source: a way
// that matches the corridor adds context and never replaces the corridor line.
//
// Method. The corridor line is sampled at a fixed interval (default 25 m, both ends included). Every sample
// point is measured against every mapped way segment, and the sample counts as matched when the nearest way
// segment is within toleranceM (default 30 m: a two-lane road width plus junction noise). Distances are
// computed in one local equirectangular frame centred on the corridor (x = Δλ·111320·cos φ₀, y = Δφ·110574),
// which is dependency-free, identical in Node and the browser, and accurate to well under 1 % across a
// corridor-sized extent. Corridor *decision* distances (habitat, occurrence) keep using the DuckDB Spatial
// engine in EPSG:5070; this module only associates two vector sources, and docs/INVESTIGATOR.md says so.
import { corridorGeometry, haversineM } from '../domain/geometry.js';

export const MATCH_DEFAULTS = Object.freeze({ sampleIntervalM: 25, toleranceM: 30 });

// Directional prefixes vary by source ('NW Cornelius Pass Rd' in TIGER/Line, 'Northeast Cornelius Pass Road'
// in OpenStreetMap). Prefixes are recorded and compared, never silently discarded.
// Directions are canonicalized so spelling differences are not reported as different roads: TIGER/Line says
// 'NW …' where OpenStreetMap says 'Northwest …'. A genuinely different quadrant ('NE' vs 'NW') stays visible.
const DIRECTION_CANON = Object.freeze({ north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  n: 'n', s: 's', e: 'e', w: 'w', ne: 'ne', nw: 'nw', se: 'se', sw: 'sw' });
const DIRECTIONS = new Set(Object.keys(DIRECTION_CANON));
const STREET_WORDS = new Set(['rd', 'road', 'st', 'street', 'ave', 'avenue', 'blvd', 'boulevard', 'dr', 'drive', 'ln', 'lane', 'hwy', 'highway', 'ct', 'court', 'way', 'pl', 'place']);

export function normalizeRoadName(name) {
  const tokens = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const directionToken = tokens.find(token => DIRECTIONS.has(token)) ?? null;
  const direction = directionToken ? DIRECTION_CANON[directionToken] : null;
  const core = tokens.filter(token => !DIRECTIONS.has(token) && !STREET_WORDS.has(token));
  return Object.freeze({ tokens: Object.freeze(tokens), direction, core: core.join(' '), coreTokens: Object.freeze(core) });
}

export const ROAD_NAME_RELATION = Object.freeze({ SAME: 'SAME', DIRECTION_VARIANT: 'DIRECTION_VARIANT', CORE_VARIANT: 'CORE_VARIANT', DIFFERENT: 'DIFFERENT' });

// How a mapped way's name relates to the corridor's name. A directional difference is a documented variant,
// not a match and not a rejection; a core difference means a different road with a similar name.
export function roadNameRelation(corridorName, wayName) {
  const corridor = normalizeRoadName(corridorName);
  const way = normalizeRoadName(wayName);
  if (!way.core || !corridor.core) return ROAD_NAME_RELATION.DIFFERENT;
  if (way.core === corridor.core) return (way.direction ?? '') === (corridor.direction ?? '') ? ROAD_NAME_RELATION.SAME : ROAD_NAME_RELATION.DIRECTION_VARIANT;
  const shared = way.coreTokens.filter(token => corridor.coreTokens.includes(token));
  if (shared.length >= Math.ceil(corridor.coreTokens.length * 0.5)) return ROAD_NAME_RELATION.CORE_VARIANT;
  return ROAD_NAME_RELATION.DIFFERENT;
}

export const nameVariantsOf = (corridorName, ways) => [...new Set(ways.map(way => way.name).filter(Boolean))]
  .map(name => Object.freeze({ name, relation: roadNameRelation(corridorName, name) }))
  .filter(entry => entry.relation !== ROAD_NAME_RELATION.SAME);

// One frame for corridor and ways, so every number below is commensurate.
function frameConverter(origin) {
  const cosLat = Math.cos(origin[1] * Math.PI / 180);
  return point => [(point[0] - origin[0]) * 111320 * cosLat, (point[1] - origin[1]) * 110574];
}

function distanceToSegment(point, start, end) {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

function distanceToPolyline(point, segments) {
  let best = Infinity;
  for (let index = 1; index < segments.length; index += 1) best = Math.min(best, distanceToSegment(point, segments[index - 1], segments[index]));
  return best;
}

export function lineLengthM(coordinates) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) total += haversineM(coordinates[index - 1], coordinates[index]);
  return total;
}

export function sampleLine(coordinates, { sampleIntervalM = MATCH_DEFAULTS.sampleIntervalM } = {}) {
  const samples = [];
  for (const line of coordinates) {
    if (line.length < 2) continue;
    samples.push([...line[0]]);
    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1], end = line[index];
      const steps = Math.max(1, Math.round(haversineM(start, end) / sampleIntervalM));
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        samples.push([start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t]);
      }
    }
  }
  return samples;
}

// Per-way and per-corridor association metrics. Every number is a derived fact with a stated method.
export function matchOsmWaysToCorridor(corridor, ways, { sampleIntervalM = MATCH_DEFAULTS.sampleIntervalM, toleranceM = MATCH_DEFAULTS.toleranceM } = {}) {
  const geometry = corridorGeometry(corridor);
  const lines = geometry.geometry.type === 'LineString' ? [geometry.geometry.coordinates] : geometry.geometry.coordinates;
  const origin = [(geometry.bounds[0] + geometry.bounds[2]) / 2, (geometry.bounds[1] + geometry.bounds[3]) / 2];
  const convert = frameConverter(origin);
  const samples = sampleLine(lines, { sampleIntervalM }).map(convert);
  const prepared = (ways ?? []).filter(way => (way.geometry ?? []).length >= 2).map(way => ({
    way, segments: way.geometry.map(convert), matchedSamples: 0, nearestM: Infinity, lengthM: lineLengthM(way.geometry),
  }));
  let corridorMatchedSamples = 0;
  for (const sample of samples) {
    let bestForSample = Infinity;
    for (const entry of prepared) {
      const distance = distanceToPolyline(sample, entry.segments);
      if (distance < entry.nearestM) entry.nearestM = distance;
      if (distance <= toleranceM) entry.matchedSamples += 1;
      if (distance < bestForSample) bestForSample = distance;
    }
    if (bestForSample <= toleranceM) corridorMatchedSamples += 1;
  }
  const withinTolerance = prepared.filter(entry => entry.matchedSamples > 0).sort((a, b) => a.nearestM - b.nearestM);
  const matchedLengthM = corridorMatchedSamples * sampleIntervalM;
  const distances = withinTolerance.map(entry => entry.nearestM);
  return Object.freeze({
    method: `corridor sampled every ${sampleIntervalM} m; a sample counts as matched when a mapped way segment is within ${toleranceM} m; all distances computed in one local equirectangular frame centred on the corridor`, 
    crs: 'EPSG:4326 source coordinates, local metric frame for measurement',
    corridorLengthM: geometry.lengthM, sampleIntervalM, toleranceM,
    sampleCount: samples.length, matchedSampleCount: corridorMatchedSamples,
    matchedFraction: samples.length ? corridorMatchedSamples / samples.length : 0,
    matchedLengthM, unmatchedLengthM: Math.max(0, geometry.lengthM - matchedLengthM),
    matchedWayCount: withinTolerance.length, candidateWayCount: prepared.length,
    meanWayDistanceM: distances.length ? distances.reduce((total, value) => total + value, 0) / distances.length : null,
    maxWayDistanceM: distances.length ? Math.max(...distances) : null,
    geometryVerified: samples.length > 0 && corridorMatchedSamples === samples.length,
    ways: Object.freeze(withinTolerance.map(entry => Object.freeze({
      osmId: entry.way.osmId, name: entry.way.name, highway: entry.way.highway, ref: entry.way.ref ?? null,
      surface: entry.way.surface ?? null, url: entry.way.url,
      nearestM: Math.round(entry.nearestM * 10) / 10, matchedSamples: entry.matchedSamples,
      lengthM: Math.round(entry.lengthM), accessSignal: entry.way.accessSignal?.signal ?? null,
    }))),
  });
}
