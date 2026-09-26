import { normalizeMarks } from './lifecycle.js';

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
