// OUTINGS: A PLAN MADE FROM ROADS THAT WERE ALREADY SAVED.
//
// An outing is an ordered list of saved roads plus planning notes - a title, an optional calendar date, a
// planning note, a small checklist, and a status the person sets. It is *not* a route: the order is the person's
// own sequence, chosen with move up / move down, and nothing here computes, optimises, ranks or recommends an
// order. There are no distances between roads, no travel times, no directions, and no connected line on the map.
//
// An outing owns only user state (order, note, checklist, date, status). Road facts stay with the candidates:
// an outing stores references, and the workspace resolves them against the saved collection. Nothing here
// measures anything, reads any dataset, or contacts anything.
export const OUTINGS_KEY = 'roadnaturalist.outings.v1';
export const OUTINGS_KIND = 'roadnaturalist-outings';
export const OUTINGS_SCHEMA_VERSION = 1;
// Measured with the storage benchmark: an outing with five roads, a note and ten checklist items is about 1 KB,
// so fifty of them is a few tens of kilobytes - small beside a single candidate record (7-28 KB). The cap is
// about keeping the workspace and its storage honest, not about storage pressure.
export const MAX_OUTINGS = 50;
export const MAX_OUTING_ROADS = 10;
export const MAX_CHECKLIST_ITEMS = 20;
export const MAX_CHECKLIST_TEXT = 120;
export const MAX_TITLE_LENGTH = 120;
export const OUTING_NOTE_MAX_LENGTH = 4000;
export const OUTING_STATUS = Object.freeze({ PLANNED: 'planned', COMPLETED: 'completed' });
export const DEFAULT_OUTING_TITLE = 'Untitled outing';

export const OUTINGS_NOTE = 'Outings are yours: the order is the sequence you chose, not a route Road Naturalist calculated. Nothing here predicts driving time, distances between roads, or conditions on the day.';

export const OUTING_STORAGE_STATUS = Object.freeze({ EMPTY: 'empty', SAVED: 'saved', RESTORED: 'restored',
  FULL: 'full', UNAVAILABLE: 'unavailable', UNSUPPORTED: 'unsupported' });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;   // no storage: outings live for the session and say so
  } catch {
    return null;
  }
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what a note must not carry
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function normalizeOutingNote(value) {
  return cleanText(value).slice(0, OUTING_NOTE_MAX_LENGTH);
}

export function normalizeTitle(value) {
  const text = cleanText(value).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
  return text || DEFAULT_OUTING_TITLE;
}

// A calendar date, or nothing. It is planning metadata: no schedule, no reminder, no time of day.
export function normalizeDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value.trim())) return null;
  const text = value.trim();
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  // A date the calendar does not have (2026-02-30) is refused rather than rolled over.
  return parsed.toISOString().slice(0, 10) === text ? text : null;
}

export function normalizeStatus(value) {
  return value === OUTING_STATUS.COMPLETED ? OUTING_STATUS.COMPLETED : OUTING_STATUS.PLANNED;
}

export function outingId(existing = []) {
  // A locally generated id that does not need to be globally unique - only stable on this device. The counter is
  // the fallback that keeps ids apart inside the same millisecond.
  let attempt = 0;
  let id = '';
  do {
    attempt += 1;
    id = `outing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${attempt > 1 ? `-${attempt}` : ''}`;
  } while (existing.includes(id));
  return id;
}

export function checklistItemId(existing = []) {
  let attempt = 0;
  let id = '';
  do {
    attempt += 1;
    id = `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}${attempt > 1 ? `-${attempt}` : ''}`;
  } while (existing.includes(id));
  return id;
}

export function normalizeChecklist(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const items = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const text = cleanText(entry.text).replace(/\s+/g, ' ').trim().slice(0, MAX_CHECKLIST_TEXT);
    if (!text) continue;
    let id = typeof entry.id === 'string' && entry.id ? entry.id : checklistItemId([...seen]);
    if (seen.has(id)) id = checklistItemId([...seen]);
    seen.add(id);
    items.push(Object.freeze({ id, text, checked: entry.checked === true }));
    if (items.length >= MAX_CHECKLIST_ITEMS) break;
  }
  return Object.freeze(items);
}

// A road appears in a plan once: the list is a sequence of places to stop, not a route that may double back.
export function normalizeRoadIds(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const ids = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || ids.includes(entry)) continue;
    ids.push(entry);
    if (ids.length >= MAX_OUTING_ROADS) break;
  }
  return Object.freeze(ids);
}

function storedTimestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

export function createOuting({ title = '', date = null, roadIds = [], notes = '', checklist = [], status = OUTING_STATUS.PLANNED,
  at = new Date().toISOString() } = {}, { existing = [] } = {}) {
  const stamp = storedTimestamp(at) ?? new Date().toISOString();
  return Object.freeze({ id: outingId([...existing]), title: normalizeTitle(title), date: normalizeDate(date),
    status: normalizeStatus(status), roadIds: Object.freeze(normalizeRoadIds(roadIds)), notes: normalizeOutingNote(notes),
    checklist: normalizeChecklist(checklist), createdAt: stamp, updatedAt: stamp });
}

// Only the fields a person can change, and only in the shape the model allows. `updatedAt` moves with a real
// change; `createdAt` never does.
export function updateOuting(outing, patch = {}, { at = new Date().toISOString() } = {}) {
  const stamp = storedTimestamp(at) ?? new Date().toISOString();
  return Object.freeze({ ...outing, title: patch.title !== undefined ? normalizeTitle(patch.title) : outing.title,
    date: patch.date !== undefined ? normalizeDate(patch.date) : outing.date,
    status: patch.status !== undefined ? normalizeStatus(patch.status) : outing.status,
    roadIds: patch.roadIds !== undefined ? Object.freeze(normalizeRoadIds(patch.roadIds)) : outing.roadIds,
    notes: patch.notes !== undefined ? normalizeOutingNote(patch.notes) : outing.notes,
    checklist: patch.checklist !== undefined ? normalizeChecklist(patch.checklist) : outing.checklist,
    updatedAt: stamp });
}

// THE ORDER IS THE PERSON'S. Moving a road swaps it with its neighbour and stops at the ends; nothing returns a
// different order than the one asked for, and no distance, habitat value or species record is consulted.
export function moveRoad(outing, roadId, direction) {
  const ids = [...outing.roadIds];
  const index = ids.indexOf(roadId);
  if (index < 0) return outing;
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= ids.length) return outing;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  return updateOuting(outing, { roadIds: ids });
}

export function roadPosition(outing, roadId) {
  const index = outing.roadIds.indexOf(roadId);
  return index < 0 ? null : index + 1;   // the sequence number shown on screen: chosen, never computed
}

export function withRoad(outing, roadId) {
  if (!roadId) return Object.freeze({ outing, changed: false, reason: 'That road is not saved on this device.' });
  if (outing.roadIds.includes(roadId)) return Object.freeze({ outing, changed: false, reason: 'That road is already in this outing.' });
  if (outing.roadIds.length >= MAX_OUTING_ROADS) {
    return Object.freeze({ outing, changed: false, reason: `An outing holds up to ${MAX_OUTING_ROADS} roads. Remove one to add another.` });
  }
  return Object.freeze({ outing: updateOuting(outing, { roadIds: [...outing.roadIds, roadId] }), changed: true, reason: null });
}

export function withoutRoad(outing, roadId) {
  if (!outing.roadIds.includes(roadId)) return outing;
  return updateOuting(outing, { roadIds: outing.roadIds.filter(id => id !== roadId) });
}

// Which outings use a road, and how to remove it from all of them: the workspace asks before doing this, and
// says what it will do, rather than leaving a plan pointing at a road that is no longer saved.
export function outingsUsingRoad(outings, roadId) {
  return (outings ?? []).filter(outing => outing.roadIds.includes(roadId));
}

export function removeRoadEverywhere(outings, roadId) {
  return (outings ?? []).map(outing => withoutRoad(outing, roadId));
}

// PERSISTENCE. Outings live in their own versioned entry - not inside the candidate blob - because they have
// their own lifecycle: a person can throw a plan away without touching the roads in it, and roads can be added
// or removed without rewriting a plan. localStorage is untrusted here too: an outing that cannot be read is left
// out with its reason, one bad record never costs the rest, and an unknown future version is left untouched.
export function storedOuting(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (typeof value.title !== 'string') return null;
  const createdAt = storedTimestamp(value.createdAt);
  const updatedAt = storedTimestamp(value.updatedAt) ?? createdAt;
  return Object.freeze({ id: value.id, title: normalizeTitle(value.title), date: normalizeDate(value.date),
    status: normalizeStatus(value.status), roadIds: Object.freeze(normalizeRoadIds(value.roadIds)),
    notes: normalizeOutingNote(value.notes), checklist: normalizeChecklist(value.checklist),
    createdAt, updatedAt });
}

export function readStoredOutings(storage = defaultStorage()) {
  const empty = (status, reason = null, bytes = 0, skipped = Object.freeze([])) => Object.freeze({ outings: Object.freeze([]),
    skipped, bytes, status, reason });
  if (!storage) return empty(OUTING_STORAGE_STATUS.UNAVAILABLE, 'This browser has no local storage.');
  let parsed;
  let raw = null;
  try {
    raw = storage.getItem(OUTINGS_KEY);
    if (!raw) return empty(OUTING_STORAGE_STATUS.EMPTY);
    parsed = JSON.parse(raw);
  } catch {
    return empty(OUTING_STORAGE_STATUS.UNSUPPORTED, 'The stored outings could not be read and were ignored.');
  }
  if (parsed?.kind !== OUTINGS_KIND) {
    return empty(OUTING_STORAGE_STATUS.UNSUPPORTED, 'The stored outings are not an outing record and were ignored.', raw.length);
  }
  if (!Number.isInteger(parsed.version) || parsed.version !== OUTINGS_SCHEMA_VERSION) {
    return empty(OUTING_STORAGE_STATUS.UNSUPPORTED,
      `Stored outings use version ${JSON.stringify(parsed.version)}, which this build does not read; they were left untouched.`, raw.length);
  }
  if (!Array.isArray(parsed.outings)) {
    return empty(OUTING_STORAGE_STATUS.UNSUPPORTED, 'The stored outing list is not a list and was ignored; it was left untouched.', raw.length);
  }
  const outings = [];
  const skipped = [];
  const seen = new Set();
  for (const record of parsed.outings) {
    const outing = storedOuting(record);
    if (!outing) { skipped.push(Object.freeze({ id: typeof record?.id === 'string' ? record.id : null,
      reason: 'the record is not a usable outing' })); continue; }
    if (seen.has(outing.id)) { skipped.push(Object.freeze({ id: outing.id, reason: 'the same outing id appears twice' })); continue; }
    seen.add(outing.id);
    outings.push(outing);
  }
  return Object.freeze({ outings: Object.freeze(outings), skipped: Object.freeze(skipped), bytes: raw.length,
    status: outings.length ? OUTING_STORAGE_STATUS.RESTORED : OUTING_STORAGE_STATUS.EMPTY, reason: null });
}

// Over the cap, nothing is written and nothing is evicted: the caller is told, and the remedy is the person's.
export function writeStoredOutings(outings, { storage = defaultStorage(), savedAt = new Date().toISOString() } = {}) {
  const records = (outings ?? []).map(outing => ({ id: outing.id, title: normalizeTitle(outing.title), date: normalizeDate(outing.date),
    status: normalizeStatus(outing.status), roadIds: [...normalizeRoadIds(outing.roadIds)], notes: normalizeOutingNote(outing.notes),
    checklist: normalizeChecklist(outing.checklist).map(item => ({ id: item.id, text: item.text, checked: item.checked })),
    createdAt: outing.createdAt ?? null, updatedAt: outing.updatedAt ?? null }));
  if (records.length > MAX_OUTINGS) {
    return Object.freeze({ ok: false, count: 0, bytes: 0, status: OUTING_STORAGE_STATUS.FULL,
      reason: `This device holds the maximum of ${MAX_OUTINGS} outings. Remove one to plan another.` });
  }
  const text = JSON.stringify({ kind: OUTINGS_KIND, version: OUTINGS_SCHEMA_VERSION, savedAt, outings: records });
  if (!storage) {
    return Object.freeze({ ok: false, count: 0, bytes: 0, status: OUTING_STORAGE_STATUS.UNAVAILABLE,
      reason: 'This browser has no local storage, so outings are kept for this session only.' });
  }
  try {
    if (!records.length) storage.removeItem(OUTINGS_KEY);
    else storage.setItem(OUTINGS_KEY, text);
  } catch (error) {
    return Object.freeze({ ok: false, count: 0, bytes: 0, status: OUTING_STORAGE_STATUS.UNAVAILABLE,
      reason: `The outing could not be saved on this device: ${error.message}` });
  }
  return Object.freeze({ ok: true, count: records.length, bytes: text.length, savedAt, status: OUTING_STORAGE_STATUS.SAVED, reason: null });
}
