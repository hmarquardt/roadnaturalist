import { setCandidateStatus, setCandidateCoverage } from '../domain/corridor.js';
import { DEFAULT_FILTERS, DEFAULT_SORT } from '../discovery/filter.js';
import { DISCOVERY_STATUS, markDiscovery } from '../discovery/lifecycle.js';

export function createStore() {
  const initialQuery = Object.freeze({ status: 'idle', coverage: null, reason: null, provenance: null, missingRoadIds: [], note: null });
  const initialDiscovery = Object.freeze({ status: 'idle', results: Object.freeze([]), coverage: null, diagnostics: null,
    eligibility: Object.freeze([]), searchArea: null, selectedId: null, marks: Object.freeze({}), error: null,
    filters: DEFAULT_FILTERS, sort: DEFAULT_SORT, raw: null });
  let state = Object.freeze({ candidates: [], selectedId: null, pilotId: null, pilotLoaded: false, roadsByCandidate: {}, roadQuery: initialQuery, ecologyByCandidate: {}, habitatByCandidate: {}, habitatOverlay: null, occurrenceByCandidate: {}, occurrenceOverlay: null, investigationByCandidate: {}, accessReviewByCandidate: {}, liveOsm: false, workerStatus: null, discovery: initialDiscovery });
  const listeners = new Set();
  const publish = next => { state = Object.freeze(next); for (const listener of listeners) listener(state); };
  const publishDiscovery = patch => publish({ ...state, discovery: Object.freeze({ ...state.discovery, ...patch }) });
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    loadPilot({ pilotId, candidates, roadsByCandidate = {}, roadQuery = initialQuery }) {
      publish({ ...state, candidates, selectedId: candidates[0]?.id ?? null, pilotId, pilotLoaded: true, roadsByCandidate, roadQuery, ecologyByCandidate: {}, habitatByCandidate: {}, habitatOverlay: null, occurrenceByCandidate: {}, occurrenceOverlay: null, investigationByCandidate: {}, accessReviewByCandidate: {}, liveOsm: false, workerStatus: null });
    },
    // DISCOVERY. A discovery run is its own state: its results are lightweight summaries with explicit
    // coverage, and they stay separate from the candidates until a person promotes one.
    startDiscovery(searchArea, marks) { publishDiscovery({ status: 'running', searchArea, results: Object.freeze([]), coverage: null, diagnostics: null, eligibility: Object.freeze([]), raw: null, selectedId: null, error: null, marks: Object.freeze({ ...marks }) }); },
    finishDiscovery({ results, coverage, diagnostics, eligibility, raw, searchArea, marks, status = 'ready' }) {
      publishDiscovery({ status, results: Object.freeze([...results]), coverage, diagnostics, eligibility: Object.freeze([...eligibility]),
        raw, searchArea, marks: Object.freeze({ ...marks }), selectedId: null, error: null });
    },
    failDiscovery({ status = 'unavailable', coverage, error, searchArea, marks }) {
      publishDiscovery({ status, coverage: coverage ?? null, results: Object.freeze([]), diagnostics: null,
        eligibility: Object.freeze([]), raw: null, searchArea, marks: Object.freeze({ ...marks }), selectedId: null, error });
    },
    selectDiscovery(id) {
      const known = (state.discovery.raw?.corridors ?? []).some(entry => entry.corridor.id === id)
        || state.discovery.results.some(result => result.id === id);
      if (id != null && !known) throw new Error('Unknown discovery corridor');
      publishDiscovery({ selectedId: id });
    },
    // Marks are the only persisted discovery state: promoted and dismissed stay beside the results.
    setDiscoveryMarks(marks) { publishDiscovery({ marks: Object.freeze({ ...marks }) }); },
    setDiscoveryFilters(filters) { publishDiscovery({ filters: Object.freeze({ ...DEFAULT_FILTERS, ...filters }) }); },
    setDiscoverySort(sort) { publishDiscovery({ sort }); },
    // Promotion appends the discovered corridor to the normal candidate list, exactly like the pilot
    // candidates: same domain object, same detail pipeline, same evidence workflow.
    promoteDiscoveryCandidate(candidate, discoveryId) {
      const others = state.candidates.filter(item => item.id !== candidate.id);
      publish({ ...state, candidates: [...others, candidate], selectedId: candidate.id,
        discovery: Object.freeze({ ...state.discovery, selectedId: null,
          marks: Object.freeze(markDiscovery(state.discovery.marks, discoveryId, DISCOVERY_STATUS.PROMOTED)) }) });
    },
    setRoadQuery(roadQuery) { publish({ ...state, roadQuery }); },
    setHabitatResult(id, result) { if (!state.candidates.some(candidate => candidate.id === id)) return; publish({ ...state, habitatByCandidate: { ...state.habitatByCandidate, [id]: result } }); },
    setHabitatOverlay(habitatOverlay) { publish({ ...state, habitatOverlay }); },
    setOccurrenceResult(id, result) { if (!state.candidates.some(candidate => candidate.id === id)) return; publish({ ...state, occurrenceByCandidate: { ...state.occurrenceByCandidate, [id]: result } }); },
    setOccurrenceOverlay(occurrenceOverlay) { publish({ ...state, occurrenceOverlay }); },
    setLiveOsm(liveOsm) { publish({ ...state, liveOsm: Boolean(liveOsm) }); },
    // An investigation result and a human review are stored separately: the automated finding is never
    // overwritten by a person's decision, and a re-run does not erase the review record.
    // A run replaces the current one. Whether a removed run is worth keeping beside it (a lost source, a changed
    // finding) is decided where that knowledge lives, in src/app/main.js, and arrives as `access.previousRun`.
    setInvestigationResult(id, result) { if (!state.candidates.some(candidate => candidate.id === id)) return; publish({ ...state, investigationByCandidate: { ...state.investigationByCandidate, [id]: result } }); },
    setWorkerStatus(workerStatus) { publish({ ...state, workerStatus }); },
    setAccessReview(id, review) { if (!state.candidates.some(candidate => candidate.id === id)) return; publish({ ...state, accessReviewByCandidate: { ...state.accessReviewByCandidate, [id]: review } }); },
    select(id) { if (!state.candidates.some(candidate => candidate.id === id)) throw new Error('Unknown candidate'); publish({ ...state, selectedId: id, habitatOverlay: null, occurrenceOverlay: null }); },
    decide(id, status) { if (!state.candidates.some(candidate => candidate.id === id)) throw new Error('Unknown candidate'); publish({ ...state, candidates: state.candidates.map(candidate => candidate.id === id ? setCandidateStatus(candidate, status) : candidate) }); },
    setEcologyResult(id, result) { if (!state.candidates.some(candidate => candidate.id === id)) return; publish({ ...state, ecologyByCandidate: { ...state.ecologyByCandidate, [id]: result } }); },
    setCoverage(id, datasetId, entry) { if (!state.candidates.some(candidate => candidate.id === id)) return; publish({ ...state, candidates: state.candidates.map(candidate => candidate.id === id ? setCandidateCoverage(candidate, datasetId, entry) : candidate) }); },
  };
}

