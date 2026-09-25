import { COVERAGE } from '../domain/corridor.js';

// Physical habitat metrics are only as good as the coverage of the requested analysis region.
// A buffered habitat dataset can cover part of the requested region, so coverage is reported per
// requested distance: FULL only when every requested buffer lies inside the dataset's coverage
// extent, PARTIAL when some do, NONE when the corridor's region is outside that extent (a fact,
// not a zero), and UNKNOWN when the dataset could not be fetched, verified, or queried.

export const ANALYSIS_DISTANCES_M = Object.freeze([250, 500, 1000]);
export const MEASURE_CRS = 'EPSG:5070';

export function summarizeBufferCoverage({ distancesM = ANALYSIS_DISTANCES_M, coverageRows = [], reason = null } = {}) {
  const byDistance = new Map(coverageRows.map(row => [Number(row.distanceM), row]));
  const perDistance = {};
  for (const distance of distancesM) {
    const row = byDistance.get(distance);
    perDistance[distance] = { covered: Boolean(row?.covered), corridorInside: Boolean(row?.corridorInside) };
  }
  if (reason) {
    return Object.freeze({
      coverage: COVERAGE.UNKNOWN, reason,
      perDistance: freezeDistances(perDistance, Object.fromEntries(distancesM.map(distance => [distance, COVERAGE.UNKNOWN]))),
      note: 'Habitat analysis could not run against this dataset. An unavailable dataset is not evidence that no habitat is present.',
    });
  }
  const coveredCount = distancesM.filter(distance => perDistance[distance].covered).length;
  const coverage = coveredCount === distancesM.length ? COVERAGE.FULL : coveredCount ? COVERAGE.PARTIAL : COVERAGE.NONE;
  const states = Object.fromEntries(distancesM.map(distance => [distance,
    perDistance[distance].covered ? COVERAGE.FULL : coverage === COVERAGE.NONE ? COVERAGE.NONE : COVERAGE.PARTIAL]));
  const uncovered = distancesM.filter(distance => !perDistance[distance].covered);
  return Object.freeze({
    coverage, reason: null, perDistance: freezeDistances(perDistance, states),
    note: coverage === COVERAGE.FULL ? null
      : coverage === COVERAGE.PARTIAL ? `This extract does not fully cover the ${uncovered.map(distance => `${distance} m`).join(' and ')} analysis region, so outer-buffer metrics may under-count.`
        : 'The corridor analysis region is outside this dataset extract; these metrics are unknown here, not zero.',
  });
}

function freezeDistances(perDistance, states) {
  return Object.freeze(Object.fromEntries(Object.entries(perDistance)
    .map(([distance, entry]) => [distance, Object.freeze({ ...entry, coverage: states[distance] })])));
}

export function bufferSummary(rows, distancesM = ANALYSIS_DISTANCES_M, keys = {}) {
  const byDistance = new Map();
  for (const row of rows) {
    const distance = Number(row.distanceM);
    if (!byDistance.has(distance)) byDistance.set(distance, { distanceM: distance, featureCount: 0, areaM2: 0, lengthM: 0, breakdown: [] });
    const entry = byDistance.get(distance);
    const areaM2 = Number(row.areaM2 ?? 0);
    const lengthM = Number(row.lengthM ?? 0);
    entry.featureCount += Number(row.featureCount ?? 0);
    entry.areaM2 += areaM2;
    entry.lengthM += lengthM;
    const label = row[keys.label ?? 'label'];
    if (label) entry.breakdown.push({ label, code: row[keys.code ?? 'code'] ?? null, areaM2: round(areaM2), lengthM: round(lengthM), featureCount: Number(row.featureCount ?? 0) });
  }
  for (const distance of distancesM) if (!byDistance.has(distance)) byDistance.set(distance, { distanceM: distance, featureCount: 0, areaM2: 0, lengthM: 0, breakdown: [] });
  return Object.freeze(Object.fromEntries([...byDistance.entries()].sort((a, b) => a[0] - b[0]).map(([distance, entry]) => [distance, Object.freeze({
    areaM2: round(entry.areaM2), lengthM: round(entry.lengthM), featureCount: entry.featureCount,
    breakdown: Object.freeze(entry.breakdown.sort((a, b) => b.areaM2 - a.areaM2 || b.lengthM - a.lengthM || a.label.localeCompare(b.label))),
  })])));
}

export function distanceOrNull(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : round(Number(value));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
