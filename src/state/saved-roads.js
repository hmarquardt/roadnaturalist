import { COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';
import { roadClassAttribute } from '../roads/road.js';
import { searchContextLine, storedSearchContext } from '../discovery/search-context.js';
import { DEFAULT_USER_META, NOTE_MAX_LENGTH, savedDateLabel, storedUserMeta } from './user-meta.js';

// SAVED ROADS: the collection a person keeps, ordered and compared.
//
// This module holds only describe-and-arrange logic over what is already there: which saved candidates match a
// filter, in what order to show them, which ones are selected for comparison, and what the comparison may
// honestly say. It measures nothing, ranks nothing, decides nothing, and never turns a person's annotation into
// evidence. Everything here is pure, so the sorting, the filters and every comparison cell are testable without
// a browser.
export const SAVED_SORTS = Object.freeze({ SAVED: 'saved', NAME: 'name', FAVORITE: 'favorite', DISTANCE: 'distance' });
export const SAVED_FILTERS = Object.freeze({ ALL: 'all', FAVORITE: 'favorite', NOTED: 'noted' });
export const MAX_COMPARISON = 3;
export const MIN_COMPARISON = 2;
// A note preview is a hint, not the note: the full text has a home in the candidate panel.
export const NOTE_PREVIEW_LENGTH = 120;

const SORT_LABELS = Object.freeze([
  { id: SAVED_SORTS.SAVED, label: 'Saved date' },
  { id: SAVED_SORTS.NAME, label: 'Name' },
  { id: SAVED_SORTS.FAVORITE, label: 'Favorites first' },
  { id: SAVED_SORTS.DISTANCE, label: 'Distance from search centre' },
]);

const FILTER_LABELS = Object.freeze([
  { id: SAVED_FILTERS.ALL, label: 'All' },
  { id: SAVED_FILTERS.FAVORITE, label: 'Favorites' },
  { id: SAVED_FILTERS.NOTED, label: 'Has notes' },
]);

// Presentation vocabulary for the durable coverage dimensions, so a comparison row can name a dataset without
// this module reaching into the interface layer.
const COVERAGE_LABELS = Object.freeze({
  [COVERAGE_DATASET.ROAD_GEOMETRY]: 'Road geometry', [COVERAGE_DATASET.ROAD_NETWORK]: 'Road network',
  [COVERAGE_DATASET.DISCOVERY]: 'Discovery', [COVERAGE_DATASET.EPA_LEVEL3]: 'Ecoregion III',
  [COVERAGE_DATASET.EPA_LEVEL4]: 'Ecoregion IV', [COVERAGE_DATASET.WETLANDS]: 'Wetlands',
  [COVERAGE_DATASET.HYDROGRAPHY]: 'Hydrography', [COVERAGE_DATASET.OCCURRENCE]: 'Occurrence',
  [COVERAGE_DATASET.OCCURRENCE_INATURALIST]: 'iNaturalist', [COVERAGE_DATASET.OCCURRENCE_EBIRD]: 'eBird',
  [COVERAGE_DATASET.ACCESS_VERIFICATION]: 'Access verification',
});

export const SAVED_SORT_OPTIONS = SORT_LABELS;
export const SAVED_FILTER_OPTIONS = FILTER_LABELS;
// What a saved-roads surface always says out loud: it is a list, not a ranking.
export const SAVED_NOTE = 'Saved roads are the corridors you promoted, kept on this device. Your notes and favorites are your own annotations: they are not evidence, and this list does not rank or recommend a road.';

export function savedRoadRows(state) {
  const userMeta = state?.userMetaById ?? {};
  const durable = state?.durableCandidateIds ?? [];
  return (state?.candidates ?? []).filter(candidate => durable.includes(candidate.id))
    .map(candidate => ({ candidate, meta: storedUserMeta(userMeta[candidate.id] ?? DEFAULT_USER_META) }));
}

export function savedCounts(state) {
  const rows = savedRoadRows(state);
  return Object.freeze({ total: rows.length, favorites: rows.filter(row => row.meta.favorite).length,
    noted: rows.filter(row => row.meta.note).length });
}

export function filterSavedRoads(rows, filter = SAVED_FILTERS.ALL) {
  if (filter === SAVED_FILTERS.FAVORITE) return rows.filter(row => row.meta.favorite);
  if (filter === SAVED_FILTERS.NOTED) return rows.filter(row => row.meta.note);
  return [...rows];
}

// Deterministic order, always: a tie is broken by name and then by id, so the same collection is always shown in
// the same order. A sort by a value a candidate does not have (no saved date, no search centre) groups those
// candidates last rather than pretending they are zero or nearest.
function byName(left, right) {
  return left.candidate.name.localeCompare(right.candidate.name) || left.candidate.id.localeCompare(right.candidate.id);
}

function savedAtOf(row) { return row.meta.savedAt ?? null; }
function distanceOf(row) { return storedSearchContext(row.candidate.searchContext)?.distanceFromCenterM ?? null; }

function bySavedDate(left, right) {
  const leftAt = savedAtOf(left);
  const rightAt = savedAtOf(right);
  if (!leftAt && !rightAt) return byName(left, right);
  if (!leftAt) return 1;   // a candidate from before saved dates were recorded is not newer than one that has one
  if (!rightAt) return -1;
  return rightAt.localeCompare(leftAt) || byName(left, right); // newest first
}

function byDistance(left, right) {
  const leftM = distanceOf(left);
  const rightM = distanceOf(right);
  if (leftM == null && rightM == null) return byName(left, right);
  if (leftM == null) return 1;  // no original search centre: distance is unavailable, so it sorts last
  if (rightM == null) return -1;
  return leftM - rightM || byName(left, right);
}

function byFavorite(left, right) {
  return Number(right.meta.favorite) - Number(left.meta.favorite) || bySavedDate(left, right);
}

export function sortSavedRoads(rows, sort = SAVED_SORTS.SAVED) {
  const sorted = [...rows];
  if (sort === SAVED_SORTS.NAME) return sorted.sort(byName);
  if (sort === SAVED_SORTS.FAVORITE) return sorted.sort(byFavorite);
  if (sort === SAVED_SORTS.DISTANCE) return sorted.sort(byDistance);
  return sorted.sort(bySavedDate);
}

export function savedRoadRowsFor(state, { sort = SAVED_SORTS.SAVED, filter = SAVED_FILTERS.ALL } = {}) {
  return sortSavedRoads(filterSavedRoads(savedRoadRows(state), filter), sort);
}

// COMPARISON SELECTION. At most three, and always reconcilable with what is saved: an id that is no longer a
// saved candidate drops out rather than leaving a stale column. The selection is interface state and is never
// persisted - a reload starts with nothing selected.
export const COMPARISON_LIMIT_REASON = `Up to ${MAX_COMPARISON} saved roads can be compared at once. Clear one to add another.`;

export function comparisonIds(state) {
  const saved = new Set(savedRoadRows(state).map(row => row.candidate.id));
  return Object.freeze((state?.savedRoads?.compare ?? []).filter(id => saved.has(id)));
}

export function nextComparison(compare, id, { savedIds = [] } = {}) {
  const current = (compare ?? []).filter(entry => savedIds.includes(entry));
  if (current.includes(id)) return Object.freeze({ compare: Object.freeze(current.filter(entry => entry !== id)), changed: true, reason: null });
  if (!savedIds.includes(id)) return Object.freeze({ compare: Object.freeze(current), changed: false, reason: 'That road is not saved on this device.' });
  if (current.length >= MAX_COMPARISON) return Object.freeze({ compare: Object.freeze(current), changed: false, reason: COMPARISON_LIMIT_REASON });
  return Object.freeze({ compare: Object.freeze([...current, id]), changed: true, reason: null });
}

export function comparisonSelection(state) {
  const rows = new Map(savedRoadRows(state).map(row => [row.candidate.id, row]));
  return Object.freeze(comparisonIds(state).map(id => rows.get(id)).filter(Boolean));
}

// COMPARISON DIMENSIONS. Facts side by side, and never a conclusion: no winner, no score, no order of merit, no
// colour that means "better". Session measurements appear only when this session actually measured them; a
// candidate restored from this device says so instead of showing a zero it does not have.
const NOT_MEASURED = 'Not measured this session';
export const COMPARISON_STATES = Object.freeze({ NOT_MEASURED, UNKNOWN: 'Unknown', NONE_MAPPED: 'None mapped' });

function measurement(entry) {
  return entry ?? null;
}

function coverageText(coverage) {
  if (!coverage) return NOT_MEASURED;
  if (coverage === COVERAGE.UNKNOWN) return COMPARISON_STATES.UNKNOWN;
  if (coverage === COVERAGE.NONE) return COMPARISON_STATES.NONE_MAPPED;
  return coverage;
}

function hectareArea(areaM2) {
  if (typeof areaM2 !== 'number' || !Number.isFinite(areaM2)) return null;
  return `${(areaM2 / 10000).toFixed(1)} ha`;
}

function kilometreLength(lengthM) {
  if (typeof lengthM !== 'number' || !Number.isFinite(lengthM)) return null;
  return `${(lengthM / 1000).toFixed(2)} km`;
}

function firstName(level) {
  const primary = level?.primary;
  if (!primary) return null;
  return primary.code ? `${primary.name} (${primary.code})` : primary.name;
}

function roadClasses(candidate) {
  const classes = [...new Set((candidate.roads ?? []).map(road => road.roadClass).filter(Boolean))].sort();
  return classes.map(code => { const attribute = roadClassAttribute(code);
    return attribute.state === 'known' ? attribute.value.label : code; }).join(' / ') || 'Unknown';
}

export function notePreview(note, length = NOTE_PREVIEW_LENGTH) {
  const text = typeof note === 'string' ? note : '';
  const flattened = text.replace(/\s+/g, ' ').trim();
  if (!flattened) return '';
  return flattened.length > length ? `${flattened.slice(0, length - 1)}…` : flattened;
}

function wetlandValue(habitat) {
  if (!habitat) return NOT_MEASURED;
  const coverage = habitat.wetlands?.coverage;
  if (!coverage) return NOT_MEASURED;
  if (coverage !== COVERAGE.FULL && coverage !== COVERAGE.PARTIAL) return coverageText(coverage);
  const buffer = habitat.wetlands.buffers?.[250] ?? habitat.wetlands.buffers?.['250'] ?? null;
  const area = hectareArea(buffer?.areaM2);
  const features = Number.isFinite(buffer?.featureCount) ? `${buffer.featureCount} feature(s)` : null;
  const measured = [area ? `${area} within 250 m` : null, features].filter(Boolean).join(' · ');
  return [coverage === COVERAGE.PARTIAL ? 'Partial coverage' : null, measured || null].filter(Boolean).join(' · ') || coverage;
}

function hydrographyValue(habitat) {
  if (!habitat) return NOT_MEASURED;
  const coverage = habitat.hydrography?.coverage;
  if (!coverage) return NOT_MEASURED;
  if (coverage !== COVERAGE.FULL && coverage !== COVERAGE.PARTIAL) return coverageText(coverage);
  const buffer = habitat.hydrography.buffers?.[1000] ?? habitat.hydrography.buffers?.['1000'] ?? null;
  const length = kilometreLength(buffer?.lengthM);
  const crossings = Number.isFinite(habitat.hydrography.crossingCount) ? `${habitat.hydrography.crossingCount} crossing(s)` : null;
  const measured = [length ? `${length} within 1 km` : null, crossings].filter(Boolean).join(' · ');
  return [coverage === COVERAGE.PARTIAL ? 'Partial coverage' : null, measured || null].filter(Boolean).join(' · ') || coverage;
}

function ecologyValue(ecology) {
  if (!ecology) return NOT_MEASURED;
  if (!ecology.coverage || ecology.coverage === COVERAGE.UNKNOWN) return coverageText(ecology.coverage);
  if (ecology.coverage === COVERAGE.NONE) return COMPARISON_STATES.NONE_MAPPED;
  const line = [firstName(ecology.level3), firstName(ecology.level4)].filter(Boolean).join(' / ');
  return line || ecology.coverage;
}

function occurrenceValue(result) {
  if (!result) return 'Not queried this session';
  return coverageText(result.coverage ?? null);
}

function accessValue(investigation) {
  if (!investigation) return 'Not investigated this session';
  const finding = investigation.access?.finding ?? investigation.finding ?? null;
  const coverage = investigation.access?.coverage ?? null;
  return [finding ? String(finding) : COMPARISON_STATES.UNKNOWN, coverage ? coverageText(coverage) : null]
    .filter(Boolean).join(' · ');
}

function durableCoverage(candidate) {
  const entries = Object.values(COVERAGE_DATASET)
    .map(id => [COVERAGE_LABELS[id] ?? id, candidate.coverage?.[id]?.coverage])
    .filter(([, coverage]) => coverage && coverage !== COVERAGE.UNKNOWN);
  if (!entries.length) return 'Not yet analyzed';
  return entries.map(([label, coverage]) => `${label} ${coverage}`).join(' · ');
}

// One row per dimension, one value per candidate, in the selection's own order. `measurements` is keyed by
// candidate id and holds only what this session has: a missing entry is a state, not a zero.
export function comparisonDimensions(selection, measurements = {}) {
  const rows = [];
  const row = (id, label, values, kind = 'fact') => rows.push(Object.freeze({ id, label, kind, values: Object.freeze(values) }));
  row('road', 'Road', selection.map(entry => entry.candidate.name));
  row('length', 'Length', selection.map(entry => `${(entry.candidate.corridor.lengthM / 1609.344).toFixed(1)} mi`));
  row('class', 'Road class', selection.map(entry => roadClasses(entry.candidate)));
  row('status', 'Status', selection.map(entry => entry.candidate.status));
  row('favorite', 'Favorite', selection.map(entry => entry.meta.favorite ? 'Yes' : 'No'));
  row('saved', 'Saved', selection.map(entry => savedDateLabel(entry.meta)));
  row('note', 'My notes', selection.map(entry => notePreview(entry.meta.note) || (entry.meta.note ? 'Has note' : 'No note')));
  // The candidates may have been found from different centres, so the row names its origin rather than
  // inviting a comparison of two distances that do not share one.
  row('origin', 'From original search centre', selection.map(entry => searchContextLine(entry.candidate.searchContext) || 'No original search centre'));
  row('coverage', 'Durable coverage', selection.map(entry => durableCoverage(entry.candidate)));
  row('ecology', 'Ecoregion (this session)', selection.map(entry => ecologyValue(measurement(measurements[entry.candidate.id]?.ecology))), 'session');
  row('wetlands', 'Wetlands (this session)', selection.map(entry => wetlandValue(measurement(measurements[entry.candidate.id]?.habitat))), 'session');
  row('hydrography', 'Hydrography (this session)', selection.map(entry => hydrographyValue(measurement(measurements[entry.candidate.id]?.habitat))), 'session');
  row('occurrence', 'Occurrence (this session)', selection.map(entry => occurrenceValue(measurement(measurements[entry.candidate.id]?.occurrence))), 'session');
  row('access', 'Access (this session)', selection.map(entry => accessValue(measurement(measurements[entry.candidate.id]?.access))), 'session');
  return Object.freeze(rows);
}

export const COMPARISON_NOTE = 'This table lists measured facts next to each other. It does not rank the roads, score them, or recommend one.';
export { NOTE_MAX_LENGTH };
