import { COVERAGE, CANDIDATE_STATUS, COVERAGE_DATASET, createCandidate, createCoverage, setDatasetCoverage } from '../domain/corridor.js';
import { storedSearchContext } from '../discovery/search-context.js';

// CANDIDATE PERSISTENCE (device-local).
//
// A promoted corridor is something a person keeps, so it should still be there after a reload. One versioned
// localStorage entry holds the durable candidate state and nothing else: identity, the road records and corridor
// geometry, coverage, status, the evidence already part of the candidate, and the verified search context. It
// stays on this device - no account, no server, no cloud state, no cross-device sync - and it is written only
// when a person promotes, decides, re-measures or removes a candidate.
//
// WHAT IS NOT PERSISTED, deliberately:
//   * the per-candidate analysis results (ecology, habitat, occurrence, the access investigation and a human
//     review). They are owned by their own store slices, are re-derived by explicit actions, and can be large; a
//     restored candidate says plainly that they have not run in this session instead of pretending otherwise;
//   * discovery state: candidates, marks and the last search keep their own entries;
//   * everything about the interface (selection, filters, overlays, transient errors).
//
// localStorage is untrusted input: it can be edited by hand, written by an older build, or truncated by a full
// quota. Every record is re-validated on read through the same domain constructor that built it, and a record
// that fails is discarded on its own - one unreadable candidate never costs the rest of the collection.
export const CANDIDATES_KEY = 'roadnaturalist.candidates.v1';
export const CANDIDATES_KIND = 'roadnaturalist-candidates';
export const CANDIDATES_SCHEMA_VERSION = 1;
// Measured on real promoted corridors: a record is 7-28 KB (mean ~11 KB, 40-489 vertices), so 100 candidates is
// about 1.1 MB - inside a typical 5 MB localStorage budget with room for the other entries, and parsed and
// validated in a couple of milliseconds. Reaching the cap refuses further saves (see writeStoredCandidates)
// rather than evicting something a person chose to keep.
export const MAX_PERSISTED_CANDIDATES = 100;

// Exactly the fields a stored candidate carries. The list is explicit in both directions: extra keys in a
// tampered record are dropped rather than spread into the candidate, and a new candidate field is persisted only
// by naming it here.
export const PERSISTED_CANDIDATE_FIELDS = Object.freeze(['id', 'name', 'status', 'summary', 'dataCatalogUrl',
  'geometry', 'roads', 'coverage', 'evidence', 'access', 'questions', 'searchContext']);

export const CANDIDATE_STORAGE_STATUS = Object.freeze({
  EMPTY: 'empty', SAVED: 'saved', RESTORED: 'restored', FULL: 'full', UNAVAILABLE: 'unavailable', UNSUPPORTED: 'unsupported',
});

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null; // a browser without storage keeps candidates in memory for the session
  } catch {
    return null;
  }
}

function pick(value, fields) {
  return Object.fromEntries(fields.filter(field => value?.[field] !== undefined).map(field => [field, value[field]]));
}

// Only the fields a stored candidate is allowed to carry, in a stable order, so identical state serializes to
// identical bytes.
export function persistedCandidateRecord(candidate) {
  const record = pick(candidate, PERSISTED_CANDIDATE_FIELDS);
  return { ...record, searchContext: storedSearchContext(record.searchContext) };
}

// A coverage map from storage, rebuilt through the domain validator: an unknown dataset or an unknown coverage
// value keeps that dataset UNKNOWN rather than entering the candidate as a claim.
function storedCoverage(value) {
  let coverage = createCoverage();
  for (const datasetId of Object.values(COVERAGE_DATASET)) {
    const entry = value?.[datasetId];
    if (!entry || typeof entry !== 'object') continue;
    if (!Object.values(COVERAGE).includes(entry.coverage)) continue;
    coverage = setDatasetCoverage(coverage, datasetId, { coverage: entry.coverage,
      reason: typeof entry.reason === 'string' && entry.reason ? entry.reason : null });
  }
  return coverage;
}

function storedRoads(roads) {
  if (!Array.isArray(roads) || !roads.length) return null;
  const valid = roads.every(road => road && typeof road === 'object' && typeof road.id === 'string' && road.id
    && road.geometry && road.provenance && typeof road.provenance === 'object');
  return valid ? roads.map(road => ({ ...road })) : null;
}

function storedQuestions(questions) {
  return Array.isArray(questions) ? questions.filter(question => typeof question === 'string' && question) : [];
}

// Rebuild one candidate from a stored record, or say why it cannot be trusted. Every field the candidate model
// requires is checked by the constructor; this only has to hand it plausible input and catch the refusal.
export function restoreCandidateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, reason: 'the record is not an object' };
  if (typeof record.id !== 'string' || !record.id) return { ok: false, reason: 'the record has no candidate id' };
  const status = Object.values(CANDIDATE_STATUS).includes(record.status) ? record.status : null;
  if (!status) return { ok: false, reason: `unknown candidate status ${JSON.stringify(record.status)}` };
  if (typeof record.name !== 'string' || !record.name) return { ok: false, reason: 'the candidate has no name' };
  const roads = storedRoads(record.roads);
  if (!roads) return { ok: false, reason: 'the candidate has no usable road records' };
  let candidate;
  try {
    candidate = createCandidate({ ...pick(record, PERSISTED_CANDIDATE_FIELDS), status, roads,
      coverage: storedCoverage(record.coverage), questions: storedQuestions(record.questions),
      searchContext: storedSearchContext(record.searchContext) });
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (candidate.id !== record.id) return { ok: false, reason: 'the candidate id changed while it was rebuilt' };
  return { ok: true, candidate };
}

// The whole entry, validated: a supported version, an array of candidates, and the ones that cannot be read left
// out with their reasons. Anything unrecognized is treated as no entry at all rather than guessed at, and an
// unsupported future version is left untouched on disk.
export function readStoredCandidates(storage = defaultStorage()) {
  if (!storage) return Object.freeze({ candidates: Object.freeze([]), savedAt: null, skipped: Object.freeze([]), bytes: 0,
    status: CANDIDATE_STORAGE_STATUS.UNAVAILABLE, reason: 'This browser has no local storage.' });
  let parsed;
  let raw = null;
  try {
    raw = storage.getItem(CANDIDATES_KEY);
    if (!raw) return Object.freeze({ candidates: Object.freeze([]), savedAt: null, skipped: Object.freeze([]), bytes: 0,
      status: CANDIDATE_STORAGE_STATUS.EMPTY, reason: null });
    parsed = JSON.parse(raw);
  } catch {
    return Object.freeze({ candidates: Object.freeze([]), savedAt: null, skipped: Object.freeze([]), bytes: 0,
      status: CANDIDATE_STORAGE_STATUS.UNSUPPORTED, reason: 'The stored candidates could not be read and were ignored.' });
  }
  if (parsed?.kind !== CANDIDATES_KIND) {
    return Object.freeze({ candidates: Object.freeze([]), savedAt: null, skipped: Object.freeze([]), bytes: raw.length,
      status: CANDIDATE_STORAGE_STATUS.UNSUPPORTED, reason: 'The stored candidates are not a candidate record and were ignored.' });
  }
  if (parsed.version !== CANDIDATES_SCHEMA_VERSION) {
    return Object.freeze({ candidates: Object.freeze([]), savedAt: null, skipped: Object.freeze([]), bytes: raw.length,
      status: CANDIDATE_STORAGE_STATUS.UNSUPPORTED,
      reason: `Stored candidates use version ${JSON.stringify(parsed.version)}, which this build does not read; they were left untouched.` });
  }
  const records = Array.isArray(parsed.candidates) ? parsed.candidates : null;
  if (!records) {
    return Object.freeze({ candidates: Object.freeze([]), savedAt: null, skipped: Object.freeze([]), bytes: raw.length,
      status: CANDIDATE_STORAGE_STATUS.UNSUPPORTED,
      reason: 'The stored candidate list is not a list and was ignored; it was left untouched.' });
  }
  const candidates = [];
  const skipped = [];
  const seen = new Set();
  for (const record of records) {
    const restored = restoreCandidateRecord(record);
    if (!restored.ok) { skipped.push(Object.freeze({ id: typeof record?.id === 'string' ? record.id : null, reason: restored.reason })); continue; }
    if (seen.has(restored.candidate.id)) { skipped.push(Object.freeze({ id: restored.candidate.id, reason: 'the same candidate id appears twice' })); continue; }
    seen.add(restored.candidate.id);
    candidates.push(restored.candidate);
  }
  return Object.freeze({ candidates: Object.freeze(candidates), savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
    skipped: Object.freeze(skipped), bytes: raw.length, status: candidates.length ? CANDIDATE_STORAGE_STATUS.RESTORED : CANDIDATE_STORAGE_STATUS.EMPTY,
    reason: null });
}

// Write the durable candidates. Over the cap nothing is written and nothing is evicted: the caller is told, and
// the remedy is the person's - remove a candidate they no longer want.
export function writeStoredCandidates(candidates, { storage = defaultStorage(), savedAt = new Date().toISOString() } = {}) {
  const records = (candidates ?? []).map(persistedCandidateRecord);
  if (records.length > MAX_PERSISTED_CANDIDATES) {
    return Object.freeze({ ok: false, count: 0, bytes: 0, savedAt: null, status: CANDIDATE_STORAGE_STATUS.FULL,
      reason: `This device holds the maximum of ${MAX_PERSISTED_CANDIDATES} saved candidates. Remove one to save another.` });
  }
  const entry = { kind: CANDIDATES_KIND, version: CANDIDATES_SCHEMA_VERSION, savedAt, candidates: records };
  const text = JSON.stringify(entry);
  if (!storage) {
    return Object.freeze({ ok: false, count: 0, bytes: 0, savedAt: null, status: CANDIDATE_STORAGE_STATUS.UNAVAILABLE,
      reason: 'This browser has no local storage, so candidates are kept for this session only.' });
  }
  try {
    if (!records.length) storage.removeItem(CANDIDATES_KEY);
    else storage.setItem(CANDIDATES_KEY, text);
  } catch (error) {
    // A full or blocked quota is a missing convenience, not a failed promotion: the candidate is real, and the
    // interface says it was not saved here.
    return Object.freeze({ ok: false, count: 0, bytes: 0, savedAt: null, status: CANDIDATE_STORAGE_STATUS.UNAVAILABLE,
      reason: `The candidate could not be saved on this device: ${error.message}` });
  }
  return Object.freeze({ ok: true, count: records.length, bytes: text.length, savedAt, status: CANDIDATE_STORAGE_STATUS.SAVED, reason: null });
}
