// Analytical geometry: the one place that decides what geometry the spatial engine is handed.
//
// Three roles stay distinct on purpose:
//   SOURCE GEOMETRY     - the TIGER/Line vertices as published, untouched by this module
//   CANONICAL GEOMETRY  - the Road Naturalist corridor (composed, deduped, segmented): what the map
//                         draws, what road length is reported from, and what provenance describes
//   ANALYTICAL GEOMETRY - the geometry actually supplied to buffered spatial operations. Normally it
//                         is the canonical geometry itself; when a repair is necessary it is a
//                         point-set-preserving rewriting of it, recorded as such in the results.
//
// This module is pure and engine-free, so the same decision runs in Node tests and in the browser. It
// decides *candidates* and measures their impact; the GIS layer only confirms that a candidate is
// actually acceptable to the engine.

import { boundsOf, corridorGeometry, linesOf, symmetricDisplacementM, vertexCount } from './geometry.js';
import { insertSelfIntersectionNodes, removeDuplicateSegments, splitRepeatedVertices } from './line-repair.js';

// The repair ladder, in order. Each rung is a strictly stronger version of the previous one, and no
// rung ever does anything but subdivide the existing line or drop an exactly duplicated traversal.
export const ANALYSIS_GEOMETRY_METHOD = Object.freeze({
  NONE: 'none',
  DUPLICATE_SEGMENTS: 'remove-duplicate-segments',
  DUPLICATE_SEGMENTS_REPEATED_VERTICES: 'remove-duplicate-segments+split-repeated-vertices',
  DUPLICATE_SEGMENTS_SELF_INTERSECTIONS: 'remove-duplicate-segments+node-self-intersections',
});

// Acceptance limits. These are engineering tolerances about numerical robustness, not ecological
// assumptions: they say how far the geometry supplied to the engine may sit from the canonical
// corridor. Every rung above moves no vertex at all, so a real repair measures 0 m displacement; the
// limits exist so that a future rung which *would* move geometry is rejected instead of shipped.
export const ANALYSIS_GEOMETRY_TOLERANCE = Object.freeze({
  maxDisplacementM: 0.05,
  maxBoundsDeltaDeg: 1e-6,
  minLengthRatio: 0.5,
  note: 'A repaired analytical geometry may not move or lose any sampled point of the canonical corridor by more '
    + 'than 5 cm (bounds 1e-6 degrees, about 11 cm), must keep at least half the canonical traversal length, and '
    + 'is rejected outright if it fails. TIGER/Line centreline positional accuracy is measured in metres, so 5 cm '
    + 'is noise; a repair that needed more would be a different road and is never used.',
});

export const UNREPAIRABLE_GEOMETRY_REASON = 'the analysis engine could not buffer this corridor geometry, and no '
  + 'point-preserving repair was accepted for it, so buffered habitat metrics were not measured. The corridor '
  + 'geometry itself is unchanged; only the buffered analysis is unavailable.';

export function describeGeometryForAnalysis(facts) {
  return Object.freeze({
    repaired: Boolean(facts?.repaired),
    method: facts?.method ?? ANALYSIS_GEOMETRY_METHOD.NONE,
    note: facts?.repaired
      ? 'The canonical corridor geometry is unchanged. The analytical geometry is a point-preserving rewriting of '
        + 'it, used only for buffered spatial operations.'
      : 'The canonical corridor geometry was used directly for spatial analysis; no repair was needed.',
    canonicalLengthM: round(facts?.metrics?.canonicalLengthM),
    analyticalLengthM: round(facts?.metrics?.analyticalLengthM),
    lengthDeltaM: round(facts?.metrics?.lengthDeltaM),
    displacementM: round(facts?.metrics?.displacementM, 6),
    removedDuplicateLengthM: round(facts?.repairs?.removedLengthM),
    removedSegmentCount: facts?.repairs?.removedSegmentCount ?? null,
    vertexCountBefore: facts?.metrics?.vertexCountBefore ?? null,
    vertexCountAfter: facts?.metrics?.vertexCountAfter ?? null,
    partCountBefore: facts?.metrics?.partCountBefore ?? null,
    partCountAfter: facts?.metrics?.partCountAfter ?? null,
  });
}

// Repair impact, measured independently of any engine: how much the candidate differs from the
// canonical corridor. `displacementM` samples vertices *and* segment midpoints in both directions, so
// dropping a segment that is not exactly duplicated shows up immediately instead of hiding.
export function measureAnalyticalChange(canonical, candidate) {
  const before = corridorGeometry(canonical);
  const after = corridorGeometry(candidate);
  const boundsAfter = boundsOf(after.geometry);
  const centroidLat = (before.bounds[1] + before.bounds[3]) / 2;
  const degPerMetreLat = 1 / 110540;
  const degPerMetreLon = 1 / (111320 * Math.max(Math.cos(centroidLat * Math.PI / 180), 0.2));
  return Object.freeze({
    canonicalLengthM: before.lengthM,
    analyticalLengthM: after.lengthM,
    lengthDeltaM: after.lengthM - before.lengthM,
    lengthRatio: before.lengthM === 0 ? 0 : after.lengthM / before.lengthM,
    displacementM: symmetricDisplacementM(before.geometry, after.geometry),
    boundsDeltaDeg: Math.max(...before.bounds.map((value, index) => Math.abs(value - boundsAfter[index]))),
    boundsDeltaM: Math.max(Math.abs(before.bounds[0] - boundsAfter[0]) / degPerMetreLon,
      Math.abs(before.bounds[1] - boundsAfter[1]) / degPerMetreLat,
      Math.abs(before.bounds[2] - boundsAfter[2]) / degPerMetreLon,
      Math.abs(before.bounds[3] - boundsAfter[3]) / degPerMetreLat),
    vertexCountBefore: vertexCount(before.geometry),
    vertexCountAfter: vertexCount(after.geometry),
    partCountBefore: linesOf(before.geometry).length,
    partCountAfter: linesOf(after.geometry).length,
  });
}

// The acceptance gate. Fail closed: a candidate that moves geometry, loses an unreasonable share of the
// traversal, or changes the corridor's extent is rejected and the caller keeps its unavailable result.
export function acceptAnalyticalGeometry(metrics, tolerance = ANALYSIS_GEOMETRY_TOLERANCE) {
  if (!metrics) return Object.freeze({ accepted: false, reason: 'the candidate geometry was empty or invalid.' });
  if (metrics.displacementM > tolerance.maxDisplacementM) {
    return Object.freeze({ accepted: false, reason: `the candidate moves corridor geometry by ${metrics.displacementM.toFixed(3)} m `
      + `(limit ${tolerance.maxDisplacementM} m), which is not a numerical repair.` });
  }
  if (metrics.boundsDeltaDeg > tolerance.maxBoundsDeltaDeg) {
    return Object.freeze({ accepted: false, reason: `the candidate changes the corridor extent by ${metrics.boundsDeltaDeg.toExponential(2)} degrees.` });
  }
  if (metrics.lengthRatio < tolerance.minLengthRatio) {
    return Object.freeze({ accepted: false, reason: `the candidate keeps only ${Math.round(metrics.lengthRatio * 100)}% of the corridor length.` });
  }
  return Object.freeze({ accepted: true, reason: null });
}

// The ordered ladder for one corridor. Rung 1 is the repair the production failures actually need
// (measured: it is the only rung that resolves all eight, and it is exact); the stronger rungs exist
// for lines whose self-overlap is not an exact duplicate, and for future extracts.
export function repairCandidates(geometry, { tolerance = ANALYSIS_GEOMETRY_TOLERANCE } = {}) {
  const canonical = corridorGeometry(geometry);
  const ladder = [];
  const add = (method, candidate, repairs, changed) => {
    if (!changed || !candidate?.geometry) return;
    const metrics = measureAnalyticalChange(canonical.geometry, candidate.geometry);
    const verdict = acceptAnalyticalGeometry(metrics, tolerance);
    ladder.push(Object.freeze({ method, geometry: candidate.geometry, repairs: Object.freeze({ ...repairs }),
      metrics, accepted: verdict.accepted, rejection: verdict.reason }));
  };
  const dedupe = removeDuplicateSegments(canonical.geometry);
  add(ANALYSIS_GEOMETRY_METHOD.DUPLICATE_SEGMENTS, dedupe,
    { removedSegmentCount: dedupe.removedSegmentCount, removedLengthM: round(dedupe.removedLengthM) }, dedupe.removedSegmentCount > 0);
  const dedupeRepeated = dedupe.geometry ? splitRepeatedVertices(dedupe.geometry) : { geometry: null, splitPointCount: 0 };
  add(ANALYSIS_GEOMETRY_METHOD.DUPLICATE_SEGMENTS_REPEATED_VERTICES,
    { geometry: dedupeRepeated.geometry }, { splitPointCount: dedupeRepeated.splitPointCount ?? 0 }, (dedupeRepeated.splitPointCount ?? 0) > 0);
  const dedupeNodes = dedupe.geometry ? insertSelfIntersectionNodes(dedupe.geometry) : { geometry: null, nodeCount: 0 };
  add(ANALYSIS_GEOMETRY_METHOD.DUPLICATE_SEGMENTS_SELF_INTERSECTIONS,
    { geometry: dedupeNodes.geometry }, { nodeCount: dedupeNodes.nodeCount ?? 0 }, (dedupeNodes.nodeCount ?? 0) > 0);
  return Object.freeze(ladder);
}

// The canonical selection, used for the fast path and whenever no repair is accepted.
export function canonicalAnalysis(geometry) {
  const canonical = corridorGeometry(geometry);
  return Object.freeze({ method: ANALYSIS_GEOMETRY_METHOD.NONE, geometry: canonical.geometry, repairs: Object.freeze({}),
    metrics: measureAnalyticalChange(canonical.geometry, canonical.geometry), accepted: true, rejection: null });
}

export function geometryForAnalyticalUse(selection) {
  return selection?.geometry ? selection.geometry : null;
}

function round(value, digits = 3) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}
