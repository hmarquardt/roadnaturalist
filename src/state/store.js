import { setCandidateStatus, setCandidateCoverage } from '../domain/corridor.js';

export function createStore() {
  const initialQuery = Object.freeze({ status: 'idle', coverage: null, reason: null, provenance: null, missingRoadIds: [], note: null });
  let state = Object.freeze({ candidates: [], selectedId: null, pilotId: null, pilotLoaded: false, roadsByCandidate: {}, roadQuery: initialQuery, ecologyByCandidate: {}, habitatByCandidate: {}, habitatOverlay: null, occurrenceByCandidate: {}, occurrenceOverlay: null, investigationByCandidate: {}, accessReviewByCandidate: {}, liveOsm: false, workerStatus: null });
  const listeners = new Set();
  const publish = next => { state = Object.freeze(next); for (const listener of listeners) listener(state); };
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    loadPilot({ pilotId, candidates, roadsByCandidate = {}, roadQuery = initialQuery }) {
      publish({ candidates, selectedId: candidates[0]?.id ?? null, pilotId, pilotLoaded: true, roadsByCandidate, roadQuery, ecologyByCandidate: {}, habitatByCandidate: {}, habitatOverlay: null, occurrenceByCandidate: {}, occurrenceOverlay: null, investigationByCandidate: {}, accessReviewByCandidate: {}, liveOsm: false, workerStatus: null });
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

