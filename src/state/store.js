import { setCandidateStatus, setCandidateCoverage } from '../domain/corridor.js';
import { DEFAULT_FILTERS, DEFAULT_SORT } from '../discovery/filter.js';
import { DISCOVERY_STATUS, markDiscovery } from '../discovery/lifecycle.js';
import { CUSTOM_SEARCH_AREA_ID } from '../discovery/search-definition.js';
import { nearPlaceMetadata, storedPlaceMetadata } from '../discovery/place-gazetteer.js';

export function createStore() {
  const initialQuery = Object.freeze({ status: 'idle', coverage: null, reason: null, provenance: null, missingRoadIds: [], note: null });
  const initialDiscovery = Object.freeze({ status: 'idle', results: Object.freeze([]), coverage: null, diagnostics: null, promotionError: null,
    eligibility: Object.freeze([]), searchArea: null, selectedId: null, marks: Object.freeze({}), error: null,
    filters: DEFAULT_FILTERS, sort: DEFAULT_SORT, raw: null });
  // The search definition is its own slice: which declared window (or custom centre and radius) a run would
  // survey, the centre and radius themselves, whether the map is waiting for a centre, the short list of
  // searches this device ran, and - as labels only - the place those coordinates came from and the nearest
  // published place when nobody chose one. `place` (explicit) and `near` (inferred) are presentation: they
  // never reach the run, they are never persisted as fact, and a search works exactly the same without them.
  const initialSearch = Object.freeze({ areaId: null, definition: null, picking: false, history: Object.freeze([]),
    place: null, near: null, error: null });
  let state = Object.freeze({ candidates: [], selectedId: null, pilotId: null, pilotLoaded: false, roadsByCandidate: {}, roadQuery: initialQuery, ecologyByCandidate: {}, habitatByCandidate: {}, habitatOverlay: null, occurrenceByCandidate: {}, occurrenceOverlay: null, investigationByCandidate: {}, accessReviewByCandidate: {}, liveOsm: false, workerStatus: null, discovery: initialDiscovery, search: initialSearch });
  const listeners = new Set();
  const publish = next => { state = Object.freeze(next); for (const listener of listeners) listener(state); };
  const publishDiscovery = patch => publish({ ...state, discovery: Object.freeze({ ...state.discovery, ...patch }) });
  const publishSearch = patch => publish({ ...state, search: Object.freeze({ ...state.search, ...patch }) });
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    loadPilot({ pilotId, candidates, roadsByCandidate = {}, roadQuery = initialQuery }) {
      publish({ ...state, candidates, selectedId: candidates[0]?.id ?? null, pilotId, pilotLoaded: true, roadsByCandidate, roadQuery, ecologyByCandidate: {}, habitatByCandidate: {}, habitatOverlay: null, occurrenceByCandidate: {}, occurrenceOverlay: null, investigationByCandidate: {}, accessReviewByCandidate: {}, liveOsm: false, workerStatus: null });
    },
    // DISCOVERY. A discovery run is its own state: its results are lightweight summaries with explicit
    // coverage, and they stay separate from the candidates until a person promotes one.
    startDiscovery(searchArea, marks) { publishDiscovery({ status: 'running', phase: 'Preparing search…', searchArea, results: Object.freeze([]), coverage: null, diagnostics: null, eligibility: Object.freeze([]), raw: null, selectedId: null, error: null, marks: Object.freeze({ ...marks }) }); },
    setDiscoveryPhase(phase) { publishDiscovery({ phase }); },
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
    // Promotion of a precomputed corridor is verified against the raw regional partitions. When that
    // verification fails the promotion is refused, and the reason is recorded here rather than hidden.
    noteDiscoveryPromotion(id, reason) { publishDiscovery({ promotionError: Object.freeze({ id, reason }) }); },
    clearDiscoveryPromotion() { publishDiscovery({ promotionError: null }); },
    setDiscoveryFilters(filters) { publishDiscovery({ filters: Object.freeze({ ...DEFAULT_FILTERS, ...filters }) }); },
    setDiscoverySort(sort) { publishDiscovery({ sort }); },
    // SEARCH DEFINITION. One selection, one definition, one run: a declared window and a custom radius are two
    // values of the same field, so nothing downstream can tell an arbitrary search from a committed preset.
    setSearchSelection({ areaId, definition, picking = false, place = null, near = null }) {
      publishSearch({ areaId: areaId ?? null, definition: definition ?? null, picking: Boolean(picking),
        place: storedPlaceMetadata(place), near: nearPlaceMetadata(near) });
    },
    setSearchArea(areaId) { publishSearch({ areaId, picking: false }); },
    setSearchDefinition(definition, { picking = false, place = null, near = null } = {}) {
      // The place label travels with the centre it describes: a new centre means a new label or none, while a
      // radius change keeps the label because the centre did not move. The inferred label is regenerated from
      // the gazetteer for every centre, so it can never outlive the centre it describes.
      publishSearch({ definition: definition ?? null, areaId: CUSTOM_SEARCH_AREA_ID, picking: Boolean(picking),
        place: storedPlaceMetadata(place), near: nearPlaceMetadata(near) });
    },
    setSearchPicking(picking) { publishSearch({ picking: Boolean(picking) }); },
    setSearchHistory(history) { publishSearch({ history: Object.freeze([...(history ?? [])]) }); },
    setSearchError(error) { publishSearch({ error: error ?? null }); },
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
