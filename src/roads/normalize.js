import { corridorGeometry, haversineM } from '../domain/geometry.js';

// Source road features (one per agency feature) become Road Naturalist road geometry here.
// This is the reusable normalization layer for real centerline data: duplicates are removed,
// connected features are ordered, and unresolved gaps are reported instead of invented.
// The result is plain GeoJSON and never a map-library object.

export const DEFAULT_TOLERANCE_M = 150; // short junction gaps are joined; larger gaps stay unresolved
export const REVERSED_LINK_LENGTH_RATIO = 0.25;
const MERGE_EPSILON_M = 0.01; // identical junction vertices merge; anything larger becomes a reported gap

export function composeRoadLines(features, { toleranceM = DEFAULT_TOLERANCE_M } = {}) {
  if (!Array.isArray(features) || !features.length) throw new TypeError('Road composition needs at least one source feature');
  if (!Number.isFinite(toleranceM) || toleranceM <= 0) throw new TypeError('Composition tolerance must be a positive number of meters');
  const cleaned = features.map(feature => ({ sourceFeatureId: String(feature?.sourceFeatureId ?? ''), coordinates: cleanLine(feature?.coordinates) }));
  const usable = cleaned.filter(line => line.coordinates.length >= 2);
  if (!usable.length) throw new TypeError('Road composition found no usable source line');

  const exact = removeExactDuplicates(usable);
  const collapsed = collapseReversedLinks(exact.lines, toleranceM);
  const ordered = orderComponents(connectedComponents(collapsed.lines, toleranceM), toleranceM);
  const lines = ordered.flatMap(component => component.lines);
  const geometry = lines.length === 1
    ? { type: 'LineString', coordinates: lines[0] }
    : { type: 'MultiLineString', coordinates: lines };
  const { lengthM, bounds } = corridorGeometry(geometry);
  const gapsM = ordered.flatMap(component => component.gapsM);
  return {
    geometry, lengthM, bounds,
    composition: Object.freeze({
      method: 'source-feature composition',
      toleranceM,
      sourceFeatureCount: features.length,
      droppedFeatures: cleaned.length - usable.length,
      duplicatesRemoved: exact.duplicatesRemoved,
      collapsedReversedLinks: collapsed.collapsed,
      lineCount: lines.length,
      partCount: ordered.length,
      gapsM: Object.freeze(gapsM),
      maxResolvedGapM: gapsM.length ? Math.max(...gapsM) : null,
      maxUnresolvedGapM: unresolvedGapM(ordered),
    }),
  };
}

export function cleanLine(coordinates) {
  if (!Array.isArray(coordinates)) return [];
  const kept = [];
  for (const point of coordinates) {
    if (!Array.isArray(point) || point.length !== 2) continue;
    const [lon, lat] = point;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
    const previous = kept.at(-1);
    if (previous && previous[0] === lon && previous[1] === lat) continue;
    kept.push([lon, lat]);
  }
  return kept;
}

export function lineLengthM(coordinates) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index++) total += haversineM(coordinates[index - 1], coordinates[index]);
  return total;
}

export function endpointGapM(first, second) {
  const left = [first[0], first.at(-1)];
  const right = [second[0], second.at(-1)];
  return Math.min(...left.flatMap(a => right.map(b => haversineM(a, b))));
}

export function isReversedLink(first, second, toleranceM = DEFAULT_TOLERANCE_M) {
  const reversed = [...first].reverse();
  if (endpointGapM(reversed, second) > toleranceM) return false;
  const lengths = [lineLengthM(first), lineLengthM(second)];
  if (Math.abs(lengths[0] - lengths[1]) > REVERSED_LINK_LENGTH_RATIO * Math.max(...lengths)) return false;
  return haversineM(first[Math.floor(first.length / 2)], second[Math.floor(second.length / 2)]) <= toleranceM;
}

function sourceOrder(line) { return [-lineLengthM(line.coordinates), line.sourceFeatureId]; }

function compareLines(left, right) {
  const [leftLength, leftId] = sourceOrder(left);
  const [rightLength, rightId] = sourceOrder(right);
  return leftLength - rightLength || leftId.localeCompare(rightId);
}

function representative(lines) { return [...lines].sort(compareLines)[0]; }

function key(coordinates) { return coordinates.map(point => `${point[0]},${point[1]}`).join(';'); }

function removeExactDuplicates(lines) {
  const seen = new Set();
  const kept = [];
  let duplicatesRemoved = 0;
  for (const line of [...lines].sort(compareLines)) {
    const forward = key(line.coordinates);
    const backward = key([...line.coordinates].reverse());
    if (seen.has(forward) || seen.has(backward)) { duplicatesRemoved += 1; continue; }
    seen.add(forward);
    seen.add(backward);
    kept.push(line);
  }
  return { lines: kept, duplicatesRemoved };
}

function collapseReversedLinks(lines, toleranceM) {
  const kept = [];
  let collapsed = 0;
  for (const line of [...lines].sort(compareLines)) {
    if (kept.some(other => isReversedLink(other.coordinates, line.coordinates, toleranceM))) { collapsed += 1; continue; }
    kept.push(line);
  }
  return { lines: kept, collapsed };
}

// Duplicate handling and endpoint connectivity are the road-composition primitives. Candidate
// discovery needs the same decisions per named road rather than per composed corridor, so both are
// exported: one implementation, two callers, no second set of duplicate rules.
export function dedupeSourceLines(lines, toleranceM = DEFAULT_TOLERANCE_M) {
  const cleaned = (lines ?? []).map(line => ({ sourceFeatureId: String(line?.sourceFeatureId ?? ''), coordinates: cleanLine(line?.coordinates) }))
    .filter(line => line.coordinates.length >= 2);
  const exact = removeExactDuplicates(cleaned);
  const collapsed = collapseReversedLinks(exact.lines, toleranceM);
  return { lines: collapsed.lines, duplicatesRemoved: exact.duplicatesRemoved, collapsedReversedLinks: collapsed.collapsed };
}

export function componentGroups(lines, toleranceM = DEFAULT_TOLERANCE_M) {
  if (!Array.isArray(lines) || !lines.length) return [];
  return connectedComponents(lines, toleranceM);
}

export function compareSourceLines(left, right) { return compareLines(left, right); }

function connectedComponents(lines, toleranceM) {
  const parent = lines.map((_, index) => index);
  const find = index => parent[index] === index ? index : (parent[index] = find(parent[index]));
  for (let a = 0; a < lines.length; a++) {
    for (let b = a + 1; b < lines.length; b++) {
      if (endpointGapM(lines[a].coordinates, lines[b].coordinates) <= toleranceM) parent[find(a)] = find(b);
    }
  }
  const groups = new Map();
  lines.forEach((line, index) => groups.set(find(index), [...(groups.get(find(index)) ?? []), line]));
  return [...groups.values()].sort((a, b) => compareLines(representative(a), representative(b)));
}

function orderComponents(components, toleranceM) {
  return [...components].sort((a, b) => compareLines(representative(a), representative(b))).map(component => {
    const remaining = [...component].sort(compareLines);
    const chain = [remaining.shift()];
    let extended = true;
    while (extended) {
      extended = false;
      for (const side of ['end', 'start']) {
        const next = nearestJoin(remaining, chain, side, toleranceM);
        if (!next) continue;
        if (side === 'end') chain.push(next.line); else chain.unshift(next.line);
        remaining.splice(remaining.indexOf(next.line), 1);
        extended = true;
      }
    }
    // Exactly coincident junction vertices merge into one canonical line; any real gap stays a
    // separate line and is reported, so no connector geometry is ever invented.
    const lines = [];
    const gapsM = [];
    for (const line of chain) {
      const previous = lines.at(-1);
      if (!previous) { lines.push([...line.coordinates]); continue; }
      const gapM = haversineM(previous.at(-1), line.coordinates[0]);
      if (gapM <= MERGE_EPSILON_M) { previous.push(...line.coordinates.slice(1)); continue; }
      gapsM.push(gapM);
      lines.push([...line.coordinates]);
    }
    return { lines, gapsM };
  });
}

function nearestJoin(remaining, chain, side, toleranceM) {
  const anchor = side === 'end' ? chain.at(-1).coordinates.at(-1) : chain[0].coordinates[0];
  let best = null;
  for (const line of remaining) {
    const forward = side === 'end' ? haversineM(anchor, line.coordinates[0]) : haversineM(anchor, line.coordinates.at(-1));
    const backward = side === 'end' ? haversineM(anchor, line.coordinates.at(-1)) : haversineM(anchor, line.coordinates[0]);
    const gapM = Math.min(forward, backward);
    if (gapM > toleranceM) continue;
    if (best && (gapM > best.gapM || (gapM === best.gapM && line.sourceFeatureId >= best.line.sourceFeatureId))) continue;
    const coordinates = backward < forward ? [...line.coordinates].reverse() : line.coordinates;
    best = { line: { ...line, coordinates }, gapM };
  }
  return best;
}

function unresolvedGapM(components) {
  if (components.length < 2) return null;
  let largest = 0;
  for (let a = 0; a < components.length; a++) {
    for (let b = a + 1; b < components.length; b++) {
      let closest = Infinity;
      for (const first of components[a].lines) for (const second of components[b].lines) {
        closest = Math.min(closest, endpointGapM(first, second));
      }
      largest = Math.max(largest, closest);
    }
  }
  return Number.isFinite(largest) ? largest : null;
}

