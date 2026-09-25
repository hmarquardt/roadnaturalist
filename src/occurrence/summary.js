import { EVIDENCE_KIND } from '../domain/corridor.js';
import {
  LOCATION_PRECISION, OCCURRENCE_RADII_M, RECENCY_WINDOWS, SOURCE_LABELS, SPATIAL_USE,
  TAXON_LENSES, TAXONOMIC_GROUP_LABELS, taxonomicGroup,
} from './model.js';

// Deterministic aggregation of normalized occurrence records. Everything here is arithmetic over
// records that already passed the privacy rules; no source payload and no network access is involved.
// "Observations" are documented reports, never animals: repeated reports of one individual remain
// separate observations and must not be read as abundance.

export const OBSERVATION_TERM = 'observations';
export const SAMPLE_TERM = 'retrieved records';

export function recencyWindowFor(observedAt, now) {
  const date = parseDate(observedAt);
  if (!date || !Number.isFinite(now)) return 'unknown';
  const ageDays = (now - date.getTime()) / 86400000;
  if (ageDays < 0) return 'd30'; // future-dated records stay in the most recent window rather than hiding
  for (const window of RECENCY_WINDOWS) if (window.days != null && ageDays <= window.days) return window.id;
  return 'historical';
}

// LOCAL means a precise public record inside the smallest evidence radius; otherwise the record is
// classified by recency (RECENT within a year, HISTORICAL older). Records whose location cannot be
// used spatially still count as temporal evidence, never as local evidence.
export function occurrenceEvidenceKind(record, { radiiM = OCCURRENCE_RADII_M, now = Date.now() } = {}) {
  const smallest = Math.min(...radiiM);
  if (Number.isFinite(record.distanceToCorridorM) && record.distanceToCorridorM <= smallest) return EVIDENCE_KIND.LOCAL;
  const window = recencyWindowFor(record.observedAt, now);
  if (window === 'unknown') return record.spatialUse === SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED ? EVIDENCE_KIND.LOCAL : EVIDENCE_KIND.HISTORICAL;
  return window === 'historical' ? EVIDENCE_KIND.HISTORICAL : EVIDENCE_KIND.RECENT;
}

export function summarizeOccurrences(records, { now = Date.now(), radiiM = OCCURRENCE_RADII_M, sources = [] } = {}) {
  const list = [...records];
  const buckets = Object.fromEntries(radiiM.map(radius => [radius, { radiusM: radius, observations: 0, uniqueTaxa: 0, nearestM: null }]));
  const recency = Object.fromEntries(RECENCY_WINDOWS.map(window => [window.id, { id: window.id, label: window.label, days: window.days, observations: 0 }]));
  const precision = Object.fromEntries(Object.values(LOCATION_PRECISION).map(value => [value, 0]));
  const groups = new Map();
  const taxa = new Map();
  const taxaByBucket = Object.fromEntries(radiiM.map(radius => [radius, new Set()]));
  let latestObservedAt = null;
  let nearestM = null;
  let captiveCount = 0;

  for (const record of list) {
    const window = recencyWindowFor(record.observedAt, now);
    if (recency[window]) recency[window].observations += 1;
    precision[record.locationPrecision] = (precision[record.locationPrecision] ?? 0) + 1;
    if (record.captive === true) captiveCount += 1;
    const group = record.taxonomicGroup ?? taxonomicGroup(record.sourceTaxonGroup);
    if (!groups.has(group)) groups.set(group, { group, label: TAXONOMIC_GROUP_LABELS[group] ?? group, observations: 0, uniqueTaxa: new Set() });
    const groupEntry = groups.get(group);
    groupEntry.observations += 1;
    groupEntry.uniqueTaxa.add(taxonKey(record));

    const key = taxonKey(record);
    if (!taxa.has(key)) taxa.set(key, { key, taxonId: record.taxonId ?? null, scientificName: record.scientificName ?? null, commonName: record.commonName ?? null,
      taxonomicGroup: group, groupLabel: TAXONOMIC_GROUP_LABELS[group] ?? group, observations: 0, sources: new Set(), nearestM: null, latestObservedAt: null,
      locationPrecision: new Set(), spatialUse: new Set(), sourceRecordIds: [], evidence: [], regionalOnly: false });
    const taxon = taxa.get(key);
    taxon.observations += 1;
    taxon.sources.add(record.source);
    taxon.locationPrecision.add(record.locationPrecision);
    taxon.spatialUse.add(record.spatialUse);
    if (taxon.sourceRecordIds.length < 5) taxon.sourceRecordIds.push(`${record.source}:${record.sourceRecordId}`);
    taxon.latestObservedAt = laterOf(taxon.latestObservedAt, record.observedAt);
    if (record.spatialUse !== SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED) taxon.regionalOnly = true;
    if (Number.isFinite(record.distanceToCorridorM)) taxon.nearestM = minOf(taxon.nearestM, record.distanceToCorridorM);
    const kind = occurrenceEvidenceKind(record, { radiiM, now });
    if (!taxon.evidence.includes(kind)) taxon.evidence.push(kind);

    latestObservedAt = laterOf(latestObservedAt, record.observedAt);
    if (Number.isFinite(record.distanceToCorridorM)) {
      nearestM = minOf(nearestM, record.distanceToCorridorM);
      for (const radius of radiiM) if (record.distanceToCorridorM <= radius) { buckets[radius].observations += 1; taxaByBucket[radius].add(key); }
    }
  }

  for (const radius of radiiM) {
    buckets[radius].uniqueTaxa = taxaByBucket[radius].size;
    const inBucket = list.filter(record => Number.isFinite(record.distanceToCorridorM) && record.distanceToCorridorM <= radius);
    buckets[radius].nearestM = inBucket.length ? Math.min(...inBucket.map(record => record.distanceToCorridorM)) : null;
    buckets[radius].latestObservedAt = inBucket.map(record => record.observedAt).filter(Boolean).sort().at(-1) ?? null;
  }

  const measured = list.filter(record => Number.isFinite(record.distanceToCorridorM));
  const regionalOnly = list.filter(record => record.spatialUse !== SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED);
  return Object.freeze({
    sources: Object.freeze([...new Set([...sources, ...list.map(record => record.source)])]),
    observations: list.length,
    uniqueTaxa: taxa.size,
    preciseObservations: measured.length,
    regionalOnlyObservations: regionalOnly.length,
    captiveObservations: captiveCount,
    nearestM: round(nearestM),
    latestObservedAt,
    buckets: Object.freeze(Object.fromEntries(Object.entries(buckets).map(([radius, entry]) => [radius, Object.freeze({ ...entry, nearestM: round(entry.nearestM) })]))),
    recency: Object.freeze(Object.fromEntries(Object.entries(recency).map(([id, entry]) => [id, Object.freeze({ ...entry })]))),
    locationPrecision: Object.freeze({ ...precision }),
    groups: Object.freeze([...groups.values()].map(entry => Object.freeze({ group: entry.group, label: entry.label, observations: entry.observations, uniqueTaxa: entry.uniqueTaxa.size }))
      .sort((a, b) => b.observations - a.observations || a.group.localeCompare(b.group))),
    taxa: Object.freeze([...taxa.values()].map(taxon => Object.freeze({
      key: taxon.key, taxonId: taxon.taxonId, scientificName: taxon.scientificName, commonName: taxon.commonName,
      taxonomicGroup: taxon.taxonomicGroup, groupLabel: taxon.groupLabel, observations: taxon.observations,
      sources: Object.freeze([...taxon.sources].sort()), sourceLabels: Object.freeze([...taxon.sources].sort().map(source => SOURCE_LABELS[source] ?? source)),
      nearestM: round(taxon.nearestM), latestObservedAt: taxon.latestObservedAt,
      locationPrecision: Object.freeze([...taxon.locationPrecision].sort()), spatialUse: Object.freeze([...taxon.spatialUse].sort()),
      regionalOnly: taxon.regionalOnly, evidence: Object.freeze(sortEvidence(taxon.evidence)), sourceRecordIds: Object.freeze([...taxon.sourceRecordIds]),
    })).sort((a, b) => b.observations - a.observations || (a.scientificName ?? '').localeCompare(b.scientificName ?? ''))),
  });
}

// Lenses come from the model so the UI can never invent taxonomy mapping of its own.
export function taxaForLens(taxa, lensId) {
  if (!lensId || lensId === 'all') return taxa;
  const lens = TAXON_LENSES.find(entry => entry.id === lensId);
  if (!lens) return taxa;
  const groups = new Set(lens.groups);
  return taxa.filter(taxon => groups.has(taxon.taxonomicGroup));
}

export function taxonKey(record) {
  if (record.taxonId) return `id:${record.taxonId}`;
  const name = (record.scientificName ?? record.commonName ?? '').trim().toLowerCase();
  return `name:${name}`;
}

export function sortEvidence(values) {
  const order = [EVIDENCE_KIND.LOCAL, EVIDENCE_KIND.RECENT, EVIDENCE_KIND.HISTORICAL, EVIDENCE_KIND.EXPECTED, EVIDENCE_KIND.MODELED, EVIDENCE_KIND.INFERRED];
  return [...new Set(values)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function laterOf(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

function minOf(a, b) { return a == null ? b : b == null ? a : Math.min(a, b); }
function round(value) { return value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10; }
