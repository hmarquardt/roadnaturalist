import { normalizeMarks } from './lifecycle.js';
import { storedDefinition, storedHistory } from './search-definition.js';
import { SORT_OPTIONS } from './filter.js';

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

// THE LAST SEARCH, AND THE SORT THE PERSON DELIBERATELY CHOSE.
//
// One record, because both are the same kind of thing: what this device has decided about discovery, as opposed to
// anything measured. `definition` is the search this device last chose. `preferredSort` is the ordering someone
// deliberately picked, and it is deliberately a *preference* rather than "what the default was at the time": an
// absent field means nobody has chosen, so a future product default reaches everyone who never picked. Only an
// explicit choice writes it.
export const DISCOVERY_SEARCH_KEY = 'roadnaturalist.discovery.search.v1';
export const DISCOVERY_SEARCH_HISTORY_KEY = 'roadnaturalist.discovery.search-history.v1';
const DISCOVERY_SEARCH_KIND = 'roadnaturalist-discovery-search';

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

// The sort keys this build offers. A stored value that is not one of them is ignored rather than trusted, so an
// unknown or obsolete key can never reach the table.
const SORT_KEYS = new Set(SORT_OPTIONS.map(option => option.key));

function storedSort(value) {
  return typeof value === 'string' && SORT_KEYS.has(value) ? value : null;
}

// One writer for the record, so neither field can clobber the other: a field that the caller does not name is kept
// as it was. The key is removed only when there is nothing left to remember. The version stays 1 - the reader has
// always accepted the object it finds and validated each field it reads, so an optional field is a compatible
// addition, and an older record without it simply has no preference.
function writeSearchRecord({ definition, preferredSort }, storage) {
  const existing = readEntry(DISCOVERY_SEARCH_KEY, DISCOVERY_SEARCH_KIND, storage) ?? {};
  const nextDefinition = definition === undefined ? storedDefinition(existing.definition) : storedDefinition(definition);
  const nextSort = preferredSort === undefined ? storedSort(existing.preferredSort) : storedSort(preferredSort);
  const record = { kind: DISCOVERY_SEARCH_KIND, version: 1, definition: nextDefinition };
  // Absent, not null: a record written before anyone chose a sort looks exactly like one nobody has chosen with.
  if (nextSort) record.preferredSort = nextSort;
  if (!storage) return { definition: nextDefinition, preferredSort: nextSort };
  try {
    if (!nextDefinition && !nextSort) storage.removeItem(DISCOVERY_SEARCH_KEY);
    else storage.setItem(DISCOVERY_SEARCH_KEY, JSON.stringify(record));
  } catch {
    return { definition: nextDefinition, preferredSort: nextSort }; // a full or blocked storage never breaks a run
  }
  return { definition: nextDefinition, preferredSort: nextSort };
}

export function readDiscoverySearch(storage = defaultStorage()) {
  return storedDefinition(readEntry(DISCOVERY_SEARCH_KEY, DISCOVERY_SEARCH_KIND, storage)?.definition);
}

export function writeDiscoverySearch(definition, storage = defaultStorage()) {
  return writeSearchRecord({ definition }, storage).definition;
}

// The ordering someone deliberately chose, or `null` when nobody has: a missing preference follows the product
// default, which is what lets the default change again without overriding anyone's decision.
export function readDiscoverySort(storage = defaultStorage()) {
  return storedSort(readEntry(DISCOVERY_SEARCH_KEY, DISCOVERY_SEARCH_KIND, storage)?.preferredSort);
}

// `null` clears the preference, so a device can go back to following the product default. A value that is not a
// sort this build offers is ignored rather than stored. The last search is untouched either way.
export function writeDiscoverySort(sort, storage = defaultStorage()) {
  const clean = sort == null ? null : storedSort(sort);
  if (sort != null && clean == null) return readDiscoverySort(storage);
  return writeSearchRecord({ preferredSort: clean }, storage).preferredSort;
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
