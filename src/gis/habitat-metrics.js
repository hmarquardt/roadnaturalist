import { ANALYSIS_DISTANCES_M } from './habitat-result.js';

// One definition of the habitat metrics, used by both the set-oriented discovery batch and the detailed
// single-corridor panel. Consolidating the expressions is what keeps "same corridor, same data, same
// geometry, same buffer -> same number" true by construction instead of by two authors agreeing.
//
// Wetland and hydrography metrics are **feature-area sums**: each mapped feature contributes the area
// (or length) of its own geometry clipped to the requested buffer. Two overlapping mapped features
// therefore contribute twice, which is the documented Road Naturalist reading of "mapped wetland area
// inside this buffer": it answers "how much mapped wetland is recorded around this corridor", not "how
// much ground is wetland". A spatial-union metric would be a different, stronger claim (it would need the
// mapped features to be a complete, non-overlapping coverage, which NWI is not). See docs/HABITAT.md.
export const HABITAT_METRIC_DEFINITION = Object.freeze({
  area: 'sum of each mapped feature\'s own geometry clipped to the requested buffer (feature-area sum, not a spatial union)',
  length: 'sum of each mapped line feature\'s clipped length within the requested buffer',
  counts: 'distinct source feature ids contributing a positive clipped area or length at that buffer distance',
  distancesM: Object.freeze([...ANALYSIS_DISTANCES_M]),
});

export function clippedAreaExpression(feature, buffer) {
  return `ST_Area(ST_Intersection(${feature}, ${buffer}))`;
}

export function clippedLengthExpression(feature, buffer) {
  return `ST_Length(ST_Intersection(${feature}, ${buffer}))`;
}

export function featureCountExpression() {
  return 'count(DISTINCT source_feature_id)';
}

export function distanceValuesSql(distancesM) {
  return distancesM.map(distance => `(${Number(distance)})`).join(', ');
}

// Coverage of one corridor's requested buffers against a dataset's extent. Both paths build it from the
// same expressions: the corridor is always compared in its projected form against the projected extent, so
// a coverage answer can never depend on which query asked - and a metric is only compared when both paths
// report the same coverage for that distance.
export function coverageExpressions({ extentExpr, corridorExpr, distanceExpr }) {
  return {
    covered: `ST_Contains(${extentExpr}, ST_Buffer(${corridorExpr}, ${distanceExpr}))`,
    corridorInside: `ST_Intersects(${extentExpr}, ${corridorExpr})`,
  };
}

export function bufferCoverageSql({ extent, corridor, distancesM = ANALYSIS_DISTANCES_M }) {
  const { covered, corridorInside } = coverageExpressions({ extentExpr: '(SELECT w FROM extent)',
    corridorExpr: '(SELECT g FROM road)', distanceExpr: 'd.distance_m' });
  return `WITH road AS (SELECT (${corridor}) AS g), extent AS (SELECT (${extent}) AS w),
    d(distance_m) AS (VALUES ${distanceValuesSql(distancesM)})
    SELECT d.distance_m, ${covered} AS covered, ${corridorInside} AS corridor_inside
    FROM d ORDER BY d.distance_m`;
}
