// WHAT A SAVED ROAD REMEMBERS ABOUT ITS OWN MEASUREMENTS.
//
// A promoted corridor keeps its geometry, its coverage and its evidence - not the discovery metrics its Naturalist
// interest was computed from. An outing is built from saved roads and is often opened long after the search that
// found them, so each saved road keeps the small set of numbers its score came from: the discovery signals block and
// the ecology block, exactly as the discovery result carried them.
//
// This is a dozen numbers per road, not data: no geometry, no dataset, no source archive, and nothing measured here
// that the source-search result did not already measure. A record without it (an older saved road) is still a valid
// saved road; the outing simply says the score was not kept for that one instead of inventing it.
export const PLANNING_CONTEXT_VERSION = 1;

const COVERAGE_VALUES = new Set(['FULL', 'PARTIAL', 'NONE', 'UNKNOWN']);
const coverage = value => (COVERAGE_VALUES.has(value) ? value : 'UNKNOWN');
const count = (value, fallback = 0) => (Number.isFinite(value) ? Number(value) : fallback);
const optional = value => (Number.isFinite(value) ? Number(value) : null);

function storedWetlands(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.freeze({ coverage: coverage(value.coverage), intersectsCorridor: value.intersectsCorridor === true,
    nearestM: optional(value.nearestM), area250M2: count(value.area250M2), area500M2: count(value.area500M2),
    area1000M2: count(value.area1000M2) });
}

function storedHydrography(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.freeze({ coverage: coverage(value.coverage), crossingCount: count(value.crossingCount),
    nearestFlowingM: optional(value.nearestFlowingM), nearestStandingM: optional(value.nearestStandingM),
    flowlineLength1000M: count(value.flowlineLength1000M) });
}

function storedEcology(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.freeze({ coverage: coverage(value.coverage), ecoregionCount: optional(value.ecoregionCount),
    transitions: optional(value.transitions) });
}

// The snapshot a saved road carries, rebuilt from untrusted storage the same way every other record is: the shape is
// explicit, unknown keys are dropped, and a block that is not usable is absent rather than guessed at.
export function storedPlanningContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const wetlands = storedWetlands(value.signals?.wetlands);
  const hydrography = storedHydrography(value.signals?.hydrography);
  const ecology = storedEcology(value.ecology);
  if (!wetlands && !hydrography) return null;   // no measured context at all: nothing to remember
  return Object.freeze({ version: PLANNING_CONTEXT_VERSION,
    signals: Object.freeze({ wetlands, hydrography }), ecology,
    // WHICH MODEL PRODUCED THE SCORE and WHEN the search that measured it ran, so a saved road can say what its
    // number means rather than showing a bare value, and can admit that it is a snapshot.
    rankingVersion: typeof value.rankingVersion === 'string' && value.rankingVersion ? value.rankingVersion : null,
    recordedAt: typeof value.recordedAt === 'string' && Number.isFinite(new Date(value.recordedAt).getTime())
      ? value.recordedAt : null });
}

// Built at promotion time from the discovery result itself, so the numbers are the ones the score was computed from
// rather than a second measurement of anything.
export function planningContextFrom(result, { rankingVersion = null, at = null } = {}) {
  if (!result?.signals) return null;
  return storedPlanningContext({ signals: result.signals, ecology: result.ecology, rankingVersion,
    recordedAt: at });
}
