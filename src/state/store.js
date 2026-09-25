import { setCandidateStatus } from '../domain/corridor.js';

export function createStore() {
  let state = Object.freeze({ candidates: [], selectedId: null, sampleLoaded: false, ecologyByCandidate: {} });
  const listeners = new Set();
  const publish = next => { state = Object.freeze(next); for (const listener of listeners) listener(state); };
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    loadSample(candidates) { publish({ candidates, selectedId: candidates[0]?.id ?? null, sampleLoaded: true, ecologyByCandidate: {} }); },
    select(id) { if (!state.candidates.some(candidate => candidate.id === id)) throw new Error('Unknown candidate'); publish({ ...state, selectedId: id }); },
    decide(id, status) { if (!state.candidates.some(candidate => candidate.id === id)) throw new Error('Unknown candidate'); publish({ ...state, candidates: state.candidates.map(candidate => candidate.id === id ? setCandidateStatus(candidate, status) : candidate) }); },
    setEcologyResult(id, result) { if (!state.candidates.some(candidate => candidate.id === id)) return; publish({ ...state, ecologyByCandidate: { ...state.ecologyByCandidate, [id]: result } }); }
  };
}
