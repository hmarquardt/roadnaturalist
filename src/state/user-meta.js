// USER METADATA: what a person said about a saved road.
//
// A candidate is a set of measured facts with source provenance. Whether someone wants to keep an eye on it,
// and why, is not a fact about the road: it is the person's own annotation. This module keeps that distinction
// explicit and gives the annotation one small, validated shape:
//
//   { favorite: boolean, note: string, savedAt: string|null, updatedAt: string|null }
//
// Nothing here is evidence. A note is never an observation, a finding, an access claim, or a data source, it
// never reaches the evidence bundle, and it never affects a measurement, a discovery ranking or a candidate's
// identity. It is stored on this device beside the candidate it belongs to, and it disappears with it.
export const USER_META_FIELDS = Object.freeze(['favorite', 'note', 'savedAt', 'updatedAt']);
// 2 000 characters is a page of notes: long enough for what a person would actually write on a road, short
// enough that a hundred of them cannot threaten a localStorage budget (measured in the storage benchmark).
export const NOTE_MAX_LENGTH = 2000;

export function defaultUserMeta() {
  return Object.freeze({ favorite: false, note: '', savedAt: null, updatedAt: null });
}

export const DEFAULT_USER_META = defaultUserMeta();

// Notes are stored as the person typed them, minus what a text field cannot mean: Windows line endings become
// newlines, other control characters are dropped (including a stray NUL or escape), and the result is bounded.
// Line breaks and indentation are kept, because a note is prose. Nothing here renders anything: every surface
// that shows a note writes it as text, never as markup.
export function normalizeNote(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what a note must not carry
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return text.slice(0, NOTE_MAX_LENGTH);
}

function storedTimestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? value : null;
}

// Metadata from storage, validated like every other untrusted input: an unknown favorite is false, an
// unreadable note is empty, an unparsable timestamp is unknown rather than invented.
export function storedUserMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_USER_META;
  return Object.freeze({ favorite: value.favorite === true, note: normalizeNote(value.note),
    savedAt: storedTimestamp(value.savedAt), updatedAt: storedTimestamp(value.updatedAt) });
}

// A candidate that is being persisted for the first time gets the moment it was saved. A re-promotion, or a
// later note, keeps the original: `savedAt` records when a person first decided to keep the road.
export function savedUserMeta(meta, { at }) {
  const clean = storedUserMeta(meta);
  return Object.freeze({ ...clean, savedAt: clean.savedAt ?? storedTimestamp(at) ?? new Date().toISOString() });
}

export function favoritedUserMeta(meta, favorite, { at = new Date().toISOString() } = {}) {
  const clean = storedUserMeta(meta);
  return Object.freeze({ ...clean, favorite: favorite === true, updatedAt: storedTimestamp(at) });
}

export function notedUserMeta(meta, note, { at = new Date().toISOString() } = {}) {
  const clean = storedUserMeta(meta);
  const clean_note = normalizeNote(note);
  // An unchanged note is not an edit: nothing is written, so `updatedAt` keeps describing the last real change.
  if (clean_note === clean.note) return clean;
  return Object.freeze({ ...clean, note: clean_note, updatedAt: storedTimestamp(at) });
}

export function userMetaRecord(value) {
  const clean = storedUserMeta(value);
  return { favorite: clean.favorite, note: clean.note, savedAt: clean.savedAt, updatedAt: clean.updatedAt };
}

// 'Saved 2026-09-27', or the honest alternative when an older record never recorded one.
export function savedDateLabel(meta) {
  const savedAt = storedUserMeta(meta).savedAt;
  if (!savedAt) return 'Saved date unknown';
  return `Saved ${savedAt.slice(0, 10)}`;
}
