import { normalizeMarks } from './lifecycle.js';
import { storedDefinition, storedHistory } from './search-definition.js';

// Discovery marks (promoted / dismissed) survive a reload in one small versioned localStorage entry.
// This is the only thing discovery persists and it stays on the device: no accounts, no server, no
// cloud state. Anything unreadable, unparsable, or unknown is discarded rather than trusted, and a
// browser without storage simply keeps the marks in memory for the session.
export const DISCOVERY_MARKS_KEY = 'roadnaturalist.discovery.marks.v1';

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage can be blocked by policy; that is a missing convenience, not an error
  }
}

export function readDiscoveryMarks(storage = defaultStorage()) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(DISCOVERY_MARKS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed?.kind === 'roadnaturalist-discovery-marks' ? normalizeMarks(parsed.marks) : {};
  } catch {
    return {};
  }
}

export function writeDiscoveryMarks(marks, storage = defaultStorage()) {
  const clean = normalizeMarks(marks);
  if (!storage) return clean;
  try {
    if (!Object.keys(clean).length) storage.removeItem(DISCOVERY_MARKS_KEY);
    else storage.setItem(DISCOVERY_MARKS_KEY, JSON.stringify({ kind: 'roadnaturalist-discovery-marks', version: 1, marks: clean }));
  } catch {
    return clean; // a full or blocked storage never breaks a discovery run
  }
  return clean;
}

// The last search this device chose, and a short list of the searches it actually ran. Both are the same
// versioned single-entry shape as the marks, both are optional, and both are validated on read: a stored
// centre or radius that does not survive `storedDefinition` is discarded rather than restored. Nothing here is
// an account, a cloud state, or a saved trip - it is one device remembering its own last search.
export const DISCOVERY_SEARCH_KEY = 'roadnaturalist.discovery.search.v1';
export const DISCOVERY_SEARCH_HISTORY_KEY = 'roadnaturalist.discovery.search-history.v1';

function readEntry(key, kind, storage) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.kind === kind ? parsed : null;
  } catch {
    return null; // unreadable storage is a missing convenience, not an error
  }
}

export function readDiscoverySearch(storage = defaultStorage()) {
  return storedDefinition(readEntry(DISCOVERY_SEARCH_KEY, 'roadnaturalist-discovery-search', storage)?.definition);
}

export function writeDiscoverySearch(definition, storage = defaultStorage()) {
  const clean = storedDefinition(definition);
  if (!storage) return clean;
  try {
    if (!clean) storage.removeItem(DISCOVERY_SEARCH_KEY);
    else storage.setItem(DISCOVERY_SEARCH_KEY, JSON.stringify({ kind: 'roadnaturalist-discovery-search', version: 1, definition: clean }));
  } catch {
    return clean;
  }
  return clean;
}

export function readDiscoverySearchHistory(storage = defaultStorage()) {
  const parsed = readEntry(DISCOVERY_SEARCH_HISTORY_KEY, 'roadnaturalist-discovery-search-history', storage);
  return parsed ? storedHistory(parsed.searches) : Object.freeze([]);
}

export function writeDiscoverySearchHistory(history, storage = defaultStorage()) {
  const clean = storedHistory(history);
  if (!storage) return clean;
  try {
    if (!clean.length) storage.removeItem(DISCOVERY_SEARCH_HISTORY_KEY);
    else storage.setItem(DISCOVERY_SEARCH_HISTORY_KEY, JSON.stringify({ kind: 'roadnaturalist-discovery-search-history', version: 1, searches: clean }));
  } catch {
    return clean;
  }
  return clean;
}
