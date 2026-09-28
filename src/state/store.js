import { setCandidateStatus, setCandidateCoverage } from '../domain/corridor.js';
import { DEFAULT_FILTERS, DEFAULT_SORT } from '../discovery/filter.js';
import { DISCOVERY_STATUS, markDiscovery } from '../discovery/lifecycle.js';
import { CUSTOM_SEARCH_AREA_ID } from '../discovery/search-definition.js';
import { nearPlaceMetadata, storedPlaceMetadata } from '../discovery/place-gazetteer.js';
import { IDLE_LOCATION } from '../discovery/geolocation.js';
import { DEFAULT_USER_META, favoritedUserMeta, notedUserMeta, savedUserMeta, storedUserMeta } from './user-meta.js';
import { SAVED_FILTERS, SAVED_SORTS, nextComparison, savedRoadRows } from './saved-roads.js';
import { MAX_OUTINGS, OUTING_STATUS, OUTING_STORAGE_STATUS, createOuting, moveRoad, outingsUsingRoad,
  readStoredOutings, removeRoadEverywhere, updateOuting, withoutRoad, withRoad, writeStoredOutings } from './outings.js';
import { CANDIDATE_STORAGE_STATUS, readStoredCandidates, writeStoredCandidates } from './candidate-persistence.js';

export function createStore({ storage } = {}) {
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
    place: null, near: null, error: null, location: IDLE_LOCATION });
  // CANDIDATE STORAGE. `durableCandidateIds` are the candidates this device keeps on disk; `restoredCandidateIds`
  // are the ones that came back from disk at boot (so the panel can say its detailed analysis has not run in this
  // session). The storage slice reports what the last read or write did, including a refused save.
  // The saved-roads workspace: how the collection a person kept is ordered, filtered and (at most three at a
  // time) selected for comparison. Interface state only - never persisted, never part of a candidate.
  const initialSavedRoads = Object.freeze({ sort: SAVED_SORTS.SAVED, filter: SAVED_FILTERS.ALL,
    compare: Object.freeze([]), note: null });
  // OUTINGS: plans a person made from saved roads. Their own device-local entry, their own lifecycle. The
  // selection used to create one is interface state, and is deliberately not the comparison selection.
  const initialOutings = Object.freeze([]);
  const initialOutingStorage = Object.freeze({ status: OUTING_STORAGE_STATUS.EMPTY, savedAt: null, persisted: 0,
    bytes: 0, skipped: Object.freeze([]), reason: null });
  const initialCandidateStorage = Object.freeze({ status: CANDIDATE_STORAGE_STATUS.EMPTY, savedAt: null,
    persisted: 0, bytes: 0, skipped: Object.freeze([]), reason: null });
  let state = Object.freeze({ candidates: [], selectedId: null, pilotId: null, pilotLoaded: false, roadsByCandidate: {}, roadQuery: initialQuery, ecologyByCandidate: {}, habitatByCandidate: {}, habitatOverlay: null, occurrenceByCandidate: {}, occurrenceOverlay: null, investigationByCandidate: {}, accessReviewByCandidate: {}, liveOsm: false, workerStatus: null, durableCandidateIds: Object.freeze([]), restoredCandidateIds: Object.freeze([]),
    userMetaById: Object.freeze({}), savedRoads: initialSavedRoads, candidateStorage: initialCandidateStorage,
    outings: initialOutings, outingStorage: initialOutingStorage, outingSelection: Object.freeze([]), selectedOutingId: null,
    discovery: initialDiscovery, search: initialSearch });
  const listeners = new Set();
  const publish = next => { state = Object.freeze(next); for (const listener of listeners) listener(state); };
  const publishDiscovery = patch => publish({ ...state, discovery: Object.freeze({ ...state.discovery, ...patch }) });
  const publishSearch = patch => publish({ ...state, search: Object.freeze({ ...state.search, ...patch }) });
  // The durable candidates are the ones this device keeps: the corridors it promoted (plus anything restored from
  // disk). A pilot corridor is not written - it is always one click away in its own button - and an in-memory
  // candidate that was never promoted is not written either.
  const durableCandidates = from => from.candidates.filter(candidate => from.durableCandidateIds.includes(candidate.id));
  const saveCandidates = from => writeStoredCandidates(durableCandidates(from), { storage,
    userMetaById: from.userMetaById });
  // An annotation is durable state of its own: it is saved when a person favorites, notes or unsaves a road,
  // and the write either succeeded (and says so) or is reported honestly as not saved on this device.
  const metaOf = (from, id) => storedUserMeta(from.userMetaById[id] ?? DEFAULT_USER_META);
  const withUserMeta = (from, id, meta) => ({ ...from, userMetaById: Object.freeze({ ...from.userMetaById, [id]: meta }) });
  // The storage slice reports what the last read or write did. A refused write never claims the extra candidate
  // was persisted: `persisted` stays on the number the device actually holds.
  const storageAfterSave = (from, written, skipped = Object.freeze([])) => Object.freeze({ status: written.status,
    savedAt: written.savedAt, persisted: written.ok ? written.count : state.candidateStorage.persisted,
    bytes: written.bytes, skipped, migrated: false, reason: written.reason });
  const dropEntries = (map, ids) => Object.fromEntries(Object.entries(map).filter(([key]) => !ids.has(key)));
  const saveOutings = from => writeStoredOutings(from.outings, { storage });
  const storageAfterOutingWrite = (written, skipped = Object.freeze([])) => Object.freeze({ status: written.status,
    savedAt: written.savedAt, persisted: written.ok ? written.count : state.outingStorage.persisted,
    bytes: written.bytes, skipped, reason: written.reason });
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    // RESTORE. The candidates this device kept are read, validated and hydrated before the first render, so a
    // person sees them immediately without running discovery again. Nothing here touches the network: a restored
    // candidate's detailed analysis is an explicit action, not a boot step.
    restoreCandidates() {
      const stored = readStoredCandidates(storage);
      if (!stored.candidates.length) {
        publish({ ...state, candidateStorage: Object.freeze({ status: stored.status, savedAt: stored.savedAt,
          persisted: 0, bytes: stored.bytes ?? 0, skipped: stored.skipped, migrated: Boolean(stored.migrated),
          reason: stored.reason }) });
        return stored;
      }
      const roadsByCandidate = { ...state.roadsByCandidate };
      for (const candidate of stored.candidates) roadsByCandidate[candidate.id] = candidate.roads;
      const restoredIds = stored.candidates.map(candidate => candidate.id);
      // The person's own annotations come back with the candidates they belong to, and never enter the
      // candidate itself: favorites and notes are not evidence, and nothing downstream can mistake them.
      publish({ ...state, candidates: [...state.candidates, ...stored.candidates],
        selectedId: state.selectedId ?? restoredIds[0] ?? null, roadsByCandidate,
        durableCandidateIds: Object.freeze([...new Set([...state.durableCandidateIds, ...restoredIds])]),
        restoredCandidateIds: Object.freeze(restoredIds),
        userMetaById: Object.freeze({ ...state.userMetaById, ...stored.userMetaById }),
        candidateStorage: Object.freeze({ status: stored.status, savedAt: stored.savedAt, persisted: stored.candidates.length,
          bytes: stored.bytes ?? 0, skipped: stored.skipped, migrated: Boolean(stored.migrated), reason: stored.reason }) });
      return stored;
    },
    loadPilot({ pilotId, candidates: loaded = [], roadsByCandidate = {}, roadQuery = initialQuery }) {
      // The pilot is merged into whatever is already here rather than replacing it: a candidate this device kept
      // must not disappear because a person opened the pilot to look at something else.
      const loadedIds = new Set(loaded.map(candidate => candidate.id));
      const candidates = [...state.candidates.filter(candidate => !loadedIds.has(candidate.id)), ...loaded];
      publish({ ...state, candidates, selectedId: loaded[0]?.id ?? state.selectedId ?? candidates[0]?.id ?? null,
        pilotId, pilotLoaded: true, roadsByCandidate: { ...state.roadsByCandidate, ...roadsByCandidate }, roadQuery,
        ecologyByCandidate: dropEntries(state.ecologyByCandidate, loadedIds),
        habitatByCandidate: dropEntries(state.habitatByCandidate, loadedIds),
        habitatOverlay: loadedIds.has(state.habitatOverlay?.candidateId) ? null : state.habitatOverlay,
        occurrenceByCandidate: dropEntries(state.occurrenceByCandidate, loadedIds),
        occurrenceOverlay: loadedIds.has(state.occurrenceOverlay?.candidateId) ? null : state.occurrenceOverlay,
        investigationByCandidate: dropEntries(state.investigationByCandidate, loadedIds),
        accessReviewByCandidate: dropEntries(state.accessReviewByCandidate, loadedIds), liveOsm: false, workerStatus: null });
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
    setSearchDefinition(definition, { picking = false, place = null, near = null, location = null } = {}) {
      // The place label travels with the centre it describes: a new centre means a new label or none, while a
      // radius change keeps the label because the centre did not move. The inferred label is regenerated from
      // the gazetteer for every centre, so it can never outlive the centre it describes.
      // `location` is the one-shot report of the browser fix that produced this centre, when it did: presentation
      // only, never part of the definition, and cleared by every selection that did not come from the device.
      publishSearch({ definition: definition ?? null, areaId: CUSTOM_SEARCH_AREA_ID, picking: Boolean(picking),
        place: storedPlaceMetadata(place), near: nearPlaceMetadata(near),
        location: location ? Object.freeze({ ...IDLE_LOCATION, ...location }) : IDLE_LOCATION });
    },
    // The state of a location request that has not produced a definition yet (asking, refused, unavailable,
    // timed out, unsupported). It changes nothing about the search itself.
    setSearchLocation(location) {
      publishSearch({ location: Object.freeze({ ...IDLE_LOCATION, ...(location ?? {}) }) });
    },
    setSearchPicking(picking) { publishSearch({ picking: Boolean(picking) }); },
    setSearchHistory(history) { publishSearch({ history: Object.freeze([...(history ?? [])]) }); },
    setSearchError(error) { publishSearch({ error: error ?? null }); },
    // Promotion appends the discovered corridor to the normal candidate list, exactly like the pilot
    // candidates: same domain object, same detail pipeline, same evidence workflow. A promoted corridor also
    // becomes durable, so it is written to this device and still there after a reload; re-promoting the same
    // corridor replaces it rather than adding a second copy.
    promoteDiscoveryCandidate(candidate, discoveryId) {
      const others = state.candidates.filter(item => item.id !== candidate.id);
      // Re-promoting the same corridor is the same candidate: the annotation a person wrote about it is not
      // theirs to lose. A candidate saved for the first time gets the moment it was saved; one kept from an
      // earlier version keeps its unknown saved date rather than being given a fabricated one.
      const meta = savedUserMeta(metaOf(state, candidate.id), { at: new Date().toISOString() });
      const next = { ...withUserMeta(state, candidate.id, meta), candidates: [...others, candidate],
        durableCandidateIds: Object.freeze([...new Set([...state.durableCandidateIds, candidate.id])]),
        selectedId: candidate.id,
        discovery: Object.freeze({ ...state.discovery, selectedId: null,
          marks: Object.freeze(markDiscovery(state.discovery.marks, discoveryId, DISCOVERY_STATUS.PROMOTED)) }) };
      publish({ ...next, candidateStorage: storageAfterSave(next, saveCandidates(next)) });
    },
    // REMOVAL. Taking a candidate off this device removes the candidate and its session results, and rewrites the
    // stored set without it. It touches nothing else: not the discovery artefacts, not the other candidates, and
    // never the source data.
    // REMOVAL. `removeFromOutings` is the caller's explicit decision: the workspace asks first, and only then
    // passes true. Plans are never silently damaged, and removing an outing never removes a road.
    removeCandidate(id, { removeFromOutings = false } = {}) {
      if (!state.candidates.some(candidate => candidate.id === id)) return null;
      const used = outingsUsingRoad(state.outings, id);
      if (used.length && !removeFromOutings) {
        publish({ ...state, outingStorage: Object.freeze({ ...state.outingStorage,
          reason: `This road is used in ${used.length} outing${used.length === 1 ? '' : 's'}. Remove it from those outings as well, or keep it.` }) });
        return null;
      }
      const droppedIds = new Set([id]);
      const candidates = state.candidates.filter(candidate => candidate.id !== id);
      // The annotation belongs to the candidate: removing the road removes its favorite flag and its notes
      // with it, and drops it from the comparison rather than leaving a stale column behind.
      const userMetaById = Object.fromEntries(Object.entries(state.userMetaById).filter(([candidateId]) => candidateId !== id));
      const outings = used.length ? removeRoadEverywhere(state.outings, id) : state.outings;
      const next = { ...state, candidates, userMetaById: Object.freeze(userMetaById),
        ...(used.length ? { outings: Object.freeze(outings) } : {}),
        savedRoads: Object.freeze({ ...state.savedRoads,
          compare: Object.freeze(state.savedRoads.compare.filter(entry => entry !== id)) }),
        durableCandidateIds: Object.freeze(state.durableCandidateIds.filter(candidateId => candidateId !== id)),
        restoredCandidateIds: Object.freeze(state.restoredCandidateIds.filter(candidateId => candidateId !== id)),
        selectedId: state.selectedId === id ? (candidates[0]?.id ?? null) : state.selectedId,
        roadsByCandidate: dropEntries(state.roadsByCandidate, droppedIds),
        ecologyByCandidate: dropEntries(state.ecologyByCandidate, droppedIds),
        habitatByCandidate: dropEntries(state.habitatByCandidate, droppedIds),
        habitatOverlay: state.habitatOverlay?.candidateId === id ? null : state.habitatOverlay,
        occurrenceByCandidate: dropEntries(state.occurrenceByCandidate, droppedIds),
        occurrenceOverlay: state.occurrenceOverlay?.candidateId === id ? null : state.occurrenceOverlay,
        investigationByCandidate: dropEntries(state.investigationByCandidate, droppedIds),
        accessReviewByCandidate: dropEntries(state.accessReviewByCandidate, droppedIds) };
      const written = saveCandidates(next);
      const outingWritten = used.length ? saveOutings(next) : null;
      publish({ ...next, candidateStorage: storageAfterSave(next, written),
        ...(outingWritten ? { outingStorage: storageAfterOutingWrite(outingWritten) } : {}) });
      return next.selectedId;
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
    decide(id, status) {
      if (!state.candidates.some(candidate => candidate.id === id)) throw new Error('Unknown candidate');
      const next = { ...state, candidates: state.candidates.map(candidate => candidate.id === id ? setCandidateStatus(candidate, status) : candidate) };
      // A decision on a candidate this device keeps is part of what is kept: the restored candidate comes back
      // with the status it was left in.
      publish(state.durableCandidateIds.includes(id)
        ? { ...next, candidateStorage: storageAfterSave(next, saveCandidates(next)) } : next);
    },
    // SAVED ROADS. One annotation per saved candidate, and the arrangement of the collection. A favorite or a
    // note is written when it changes, with the same honest reporting as every other durable write: the panel
    // says "saved on this device" only when the write actually happened, and the annotation itself is never
    // evidence, never part of the candidate, and never part of an evidence bundle.
    setCandidateFavorite(id, favorite) {
      if (!state.durableCandidateIds.includes(id)) return null;
      const meta = favoritedUserMeta(metaOf(state, id), favorite);
      const next = withUserMeta(state, id, meta);
      publish({ ...next, candidateStorage: storageAfterSave(next, saveCandidates(next)) });
      return meta;
    },
    setCandidateNote(id, note) {
      if (!state.durableCandidateIds.includes(id)) return null;
      const meta = notedUserMeta(metaOf(state, id), note);
      const next = withUserMeta(state, id, meta);
      publish({ ...next, candidateStorage: storageAfterSave(next, saveCandidates(next)) });
      return meta;
    },
    // OUTINGS. Every action writes the whole plan set, exactly like the candidate store: the entry stays
    // consistent, and a failure is reported with the same honest vocabulary. Outings never touch candidates.
    restoreOutings() {
      const stored = readStoredOutings(storage);
      publish({ ...state, outings: stored.outings, outingStorage: Object.freeze({ status: stored.status,
        savedAt: null, persisted: stored.outings.length, bytes: stored.bytes ?? 0, skipped: stored.skipped,
        reason: stored.reason }) });
      return stored;
    },
    setOutingStorage(note) { publish({ ...state, outingStorage: Object.freeze({ ...state.outingStorage, ...note }) }); },
    // Only roads that are saved on this device can join a plan: an outing references saved candidates, it never
    // creates a hidden copy of one.
    createOutingFromRoads(roadIds, { title = '', date = null, notes = '' } = {}) {
      const savedIds = savedRoadRows(state).map(row => row.candidate.id);
      const usable = [...new Set((roadIds ?? []).filter(id => savedIds.includes(id)))];
      if (!usable.length) return Object.freeze({ ok: false, reason: 'Choose at least one saved road for the outing.' });
      if (state.outings.length >= MAX_OUTINGS) return Object.freeze({ ok: false,
        reason: `This device holds the maximum of ${MAX_OUTINGS} outings. Remove one to plan another.` });
      const outing = createOuting({ title, date, roadIds: usable, notes }, { existing: state.outings.map(entry => entry.id) });
      const next = { ...state, outings: Object.freeze([...state.outings, outing]), selectedOutingId: outing.id,
        outingSelection: Object.freeze([]) };
      const written = saveOutings(next);
      publish({ ...next, outingStorage: storageAfterOutingWrite(written) });
      return Object.freeze({ ok: written.ok, outing, reason: written.reason });
    },
    updateOuting(id, patch) {
      if (!state.outings.some(outing => outing.id === id)) return null;
      const next = { ...state, outings: Object.freeze(state.outings.map(outing => outing.id === id ? updateOuting(outing, patch) : outing)) };
      publish({ ...next, outingStorage: storageAfterOutingWrite(saveOutings(next)) });
      return next.outings.find(outing => outing.id === id);
    },
    moveOutingRoad(id, roadId, direction) {
      if (!state.outings.some(outing => outing.id === id)) return null;
      const next = { ...state, outings: Object.freeze(state.outings.map(outing => outing.id === id ? moveRoad(outing, roadId, direction) : outing)) };
      publish({ ...next, outingStorage: storageAfterOutingWrite(saveOutings(next)) });
      return next.outings.find(outing => outing.id === id);
    },
    addRoadToOuting(id, roadId) {
      const savedIds = savedRoadRows(state).map(row => row.candidate.id);
      const outing = state.outings.find(entry => entry.id === id) ?? null;
      if (!outing) return Object.freeze({ changed: false, reason: 'That outing is not here.' });
      const outcome = withRoad(outing, savedIds.includes(roadId) ? roadId : '');
      if (!outcome.changed) { publish({ ...state, outingStorage: Object.freeze({ ...state.outingStorage, reason: outcome.reason }) }); return outcome; }
      const next = { ...state, outings: Object.freeze(state.outings.map(entry => entry.id === id ? outcome.outing : entry)) };
      publish({ ...next, outingStorage: storageAfterOutingWrite(saveOutings(next)) });
      return outcome;
    },
    removeRoadFromOuting(id, roadId) {
      if (!state.outings.some(outing => outing.id === id)) return null;
      const next = { ...state, outings: Object.freeze(state.outings.map(outing => outing.id === id ? withoutRoad(outing, roadId) : outing)) };
      publish({ ...next, outingStorage: storageAfterOutingWrite(saveOutings(next)) });
      return next.outings.find(outing => outing.id === id);
    },
    removeOuting(id) {
      if (!state.outings.some(outing => outing.id === id)) return null;
      const outings = state.outings.filter(outing => outing.id !== id);
      const next = { ...state, outings: Object.freeze(outings),
        selectedOutingId: state.selectedOutingId === id ? (outings[0]?.id ?? null) : state.selectedOutingId,
        outingSelection: Object.freeze(state.outingSelection.filter(entry => entry !== id)) };
      publish({ ...next, outingStorage: storageAfterOutingWrite(saveOutings(next)) });
      return next.selectedOutingId;
    },
    selectOuting(id) {
      if (id == null) { publish({ ...state, selectedOutingId: null }); return null; }
      if (!state.outings.some(outing => outing.id === id)) return null;
      publish({ ...state, selectedOutingId: id });
      return id;
    },
    // The roads chosen for a new outing: interface state, separate from the comparison selection.
    toggleOutingSelection(roadId) {
      const savedIds = savedRoadRows(state).map(row => row.candidate.id);
      const current = state.outingSelection;
      const selection = current.includes(roadId) ? current.filter(entry => entry !== roadId)
        : savedIds.includes(roadId) ? [...current, roadId] : current;
      publish({ ...state, outingSelection: Object.freeze(selection) });
      return Object.freeze([...selection]);
    },
    clearOutingSelection() { publish({ ...state, outingSelection: Object.freeze([]) }); },
    outingsUsingCandidate(id) { return outingsUsingRoad(state.outings, id); },
    setSavedRoadsSort(sort) { publish({ ...state, savedRoads: Object.freeze({ ...state.savedRoads, sort }) }); },
    setSavedRoadsFilter(filter) { publish({ ...state, savedRoads: Object.freeze({ ...state.savedRoads, filter }) }); },
    // Comparison is interface state: at most three, never persisted, and always reconciled with what is saved.
    // A refusal to add a fourth is a reason the panel can show, not a silent no-op.
    toggleSavedRoadCompare(id) {
      const savedIds = savedRoadRows(state).map(row => row.candidate.id);
      const outcome = nextComparison(state.savedRoads.compare, id, { savedIds });
      publish({ ...state, savedRoads: Object.freeze({ ...state.savedRoads, compare: outcome.compare, note: outcome.reason }) });
      return outcome;
    },
    clearSavedRoadCompare() {
      publish({ ...state, savedRoads: Object.freeze({ ...state.savedRoads, compare: Object.freeze([]), note: null }) });
    },
    setEcologyResult(id, result) { if (!state.candidates.some(candidate => candidate.id === id)) return; publish({ ...state, ecologyByCandidate: { ...state.ecologyByCandidate, [id]: result } }); },
    setCoverage(id, datasetId, entry) {
      if (!state.candidates.some(candidate => candidate.id === id)) return;
      const next = { ...state, candidates: state.candidates.map(candidate => candidate.id === id ? setCandidateCoverage(candidate, datasetId, entry) : candidate) };
      // Coverage that detailed analysis narrowed is durable candidate state, so it is written with the candidate.
      publish(state.durableCandidateIds.includes(id)
        ? { ...next, candidateStorage: storageAfterSave(next, saveCandidates(next)) } : next);
    },
  };
}
