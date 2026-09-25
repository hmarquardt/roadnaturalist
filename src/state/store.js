import { setCandidateStatus, setCandidateCoverage } from '../domain/corridor.js';

export function createStore() {
  const initialQuery = Object.freeze({ status: 'idle', coverage: null, reason: null, provenance: null, missingRoadIds: [], note: null });
  let state = Object.freeze({ candidates: [], selectedId: null, pilotId: null, pilotLoaded: false, roadsByCandidate: {}, roadQuery: initialQuery, ecologyByCandidate: {} });
  const listeners = new Set();
  const publish = next => { state = Object.freeze(next); for (const listener of listeners) listener(state); };
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    loadPilot({ pilotId, candidates, roadsByCandidate = {}, roadQuery = initialQuery }) {
      publish({ candidates, selectedId: candidates[0]?.id ?? null, pilotId, pilotLoaded: true, roadsByCandidate, roadQuery, ecologyByCandidate: {} });
    },
    setRoadQuery(roadQuery) { publish({ ...state, roadQuery }); },
    select(id) { if (!state.candidates.some(candidate => candidate.id === id)) throw new Error('Unknown candidate'); publish({ ...state, selectedId: id }); },
    decide(id, status) { if (!state.candidates.some(candidate => candidate.id === id)) throw new Error('Unknown candidate'); publish({ ...state, candidates: state.candidates.map(candidate => candidate.id === id ? setCandidateStatus(candidate, status) : candidate) }); },
    setEcologyResult(id, result) { if (!state.candidates.some(candidate => candidate.id === id)) return; publish({ ...state, ecologyByCandidate: { ...state.ecologyByCandidate, [id]: result } }); },
    setCoverage(id, datasetId, entry) { if (!state.candidates.some(candidate => candidate.id === id)) return; publish({ ...state, candidates: state.candidates.map(candidate => candidate.id === id ? setCandidateCoverage(candidate, datasetId, entry) : candidate) }); },
  };
}

