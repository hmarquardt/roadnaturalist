import { COVERAGE } from '../domain/corridor.js';

const COMPLETE_RATIO = 0.995; // rounding and shared-boundary tolerances

export function summarizeLevel(rows, routeLengthM) {
  const intersections = rows.filter(row => Number(row.overlapM) > 0).map(row => ({
    code: String(row.code), name: String(row.name), overlapM: Number(row.overlapM),
    percent: Math.round(Number(row.overlapM) / routeLengthM * 1000) / 10
  })).sort((a, b) => b.overlapM - a.overlapM || a.code.localeCompare(b.code));
  const measuredM = intersections.reduce((sum, item) => sum + item.overlapM, 0);
  const coverage = measuredM <= 0 ? COVERAGE.NONE : measuredM / routeLengthM >= COMPLETE_RATIO ? COVERAGE.FULL : COVERAGE.PARTIAL;
  return { primary: intersections[0] ?? null, intersections, spansMultiple: intersections.length > 1, measuredM, routeLengthM, coverage };
}

export function combineCoverage(level3, level4) {
  if (level3.coverage === COVERAGE.FULL && level4.coverage === COVERAGE.FULL) return COVERAGE.FULL;
  if (level3.coverage === COVERAGE.NONE && level4.coverage === COVERAGE.NONE) return COVERAGE.NONE;
  if (level3.coverage === COVERAGE.UNKNOWN || level4.coverage === COVERAGE.UNKNOWN) {
    const known = level3.coverage === COVERAGE.UNKNOWN ? level4.coverage : level3.coverage;
    return known === COVERAGE.FULL || known === COVERAGE.PARTIAL ? COVERAGE.PARTIAL : COVERAGE.UNKNOWN;
  }
  return COVERAGE.PARTIAL;
}
