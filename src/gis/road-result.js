import { COVERAGE } from '../domain/corridor.js';

// Road-data coverage is its own dimension. A failed or unavailable road source is UNKNOWN and is
// never reported as "no roads exist"; a successful query with no matching feature is NONE, and for
// this bounded pilot extract NONE means "not present in this extract", not "no road on the ground".
export function summarizeRoadQuery({ requestedRoadIds = [], foundRoadIds = [], featureCount = 0, bounded = false, reason = null } = {}) {
  if (reason) {
    return Object.freeze({
      coverage: COVERAGE.UNKNOWN, reason, requestedRoadIds: Object.freeze([...requestedRoadIds]),
      foundRoadIds: Object.freeze([]), missingRoadIds: Object.freeze([...requestedRoadIds]), featureCount,
      note: 'Road geometry could not be retrieved. This is a data-availability result, not evidence that no roads exist.',
    });
  }
  const found = [...new Set(foundRoadIds)];
  const missing = requestedRoadIds.filter(roadId => !found.includes(roadId));
  if (!requestedRoadIds.length) {
    return Object.freeze({
      coverage: featureCount > 0 ? COVERAGE.FULL : COVERAGE.NONE, reason: null,
      requestedRoadIds: Object.freeze([]), foundRoadIds: Object.freeze(found), missingRoadIds: Object.freeze([]), featureCount,
      note: bounded ? 'The road dataset is a bounded pilot extract: NONE describes this extract, not the road network on the ground.' : null,
    });
  }
  const coverage = missing.length === 0 ? COVERAGE.FULL : found.length ? COVERAGE.PARTIAL : COVERAGE.NONE;
  return Object.freeze({
    coverage, reason: null, requestedRoadIds: Object.freeze([...requestedRoadIds]),
    foundRoadIds: Object.freeze(found), missingRoadIds: Object.freeze(missing), featureCount,
    note: coverage === COVERAGE.NONE ? 'The requested roads are absent from this bounded pilot extract; they are not evidence about the road network on the ground.' : null,
  });
}
