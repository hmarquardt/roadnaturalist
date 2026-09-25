// Road Naturalist distinguishes what a source actually states from what the application
// does not know. A field is never filled with a plausible guess.
export const ATTRIBUTE_STATE = Object.freeze({
  KNOWN: 'known',            // the source provides this value
  UNKNOWN: 'unknown',        // the fact is not established, though it may exist
  NOT_PROVIDED: 'not provided', // the selected source has no such field
  INFERRED: 'inferred',      // analyst/derived value; must stay visibly unverified
});

const states = new Set(Object.values(ATTRIBUTE_STATE));

export function attribute(state, value = null, note = null) {
  if (!states.has(state)) throw new TypeError('Unknown attribute state');
  if (state === ATTRIBUTE_STATE.KNOWN && value == null) throw new TypeError('A known attribute needs a value');
  return Object.freeze({ state, value, note });
}

export const known = (value, note = null) => attribute(ATTRIBUTE_STATE.KNOWN, value, note);
export const unknown = (note = null) => attribute(ATTRIBUTE_STATE.UNKNOWN, null, note);
export const notProvided = (note = null) => attribute(ATTRIBUTE_STATE.NOT_PROVIDED, null, note);
// Inferred values are allowed to exist but must never be presented as source facts.
export const inferred = (value, note = null) => attribute(ATTRIBUTE_STATE.INFERRED, value, note);
