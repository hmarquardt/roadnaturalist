import { COVERAGE, COVERAGE_DATASET, EVIDENCE_KIND } from '../domain/corridor.js';
import { OCCURRENCE_RADII_M, OCCURRENCE_SOURCE, SOURCE_LABELS, SPATIAL_USE, TAXON_LENSES } from './model.js';

// SPECIES OCCURRENCE EVIDENCE is the domain view of public occurrence records. It is deliberately
// separate from PHYSICAL HABITAT EVIDENCE and from EPA ecological context, and it never becomes a
// prediction: a public report proves a documented observation at a place and time.
export const OCCURRENCE_EVIDENCE_KIND = 'SPECIES_OCCURRENCE_EVIDENCE';
export const OCCURRENCE_INTERPRETATION = 'Documented public observations near this corridor, by source. Occurrence evidence is not habitat suitability, '
  + 'not abundance, and not a prediction that a species is on this road.';
export const COVERAGE_DATASETS = Object.freeze({
  [OCCURRENCE_SOURCE.INATURALIST]: COVERAGE_DATASET.OCCURRENCE_INATURALIST,
  [OCCURRENCE_SOURCE.EBIRD]: COVERAGE_DATASET.OCCURRENCE_EBIRD,
});

// Source-specific states are preserved; the aggregate `occurrence` dimension is derived from them so
// the coverage panel keeps showing one occurrence row without losing source detail.
export function combineOccurrenceCoverage(states) {
  const present = states.filter(Boolean);
  if (!present.length) return COVERAGE.UNKNOWN;
  if (present.every(state => state === COVERAGE.UNKNOWN)) return COVERAGE.UNKNOWN;
  if (present.every(state => state === COVERAGE.FULL)) return COVERAGE.FULL;
  if (present.some(state => state === COVERAGE.PARTIAL || state === COVERAGE.NONE)) return COVERAGE.PARTIAL;
  return COVERAGE.PARTIAL;
}

export function summarizeOccurrences(result) {
  const sources = Object.freeze(Object.fromEntries(Object.entries(result?.sources ?? {}).map(([sourceId, summary]) => [sourceId, summarizeSource(sourceId, summary)])));
  const coverage = Object.freeze({
    ...Object.fromEntries(Object.entries(sources).map(([sourceId, summary]) => [COVERAGE_DATASETS[sourceId], summary.coverage])),
    [COVERAGE_DATASET.OCCURRENCE]: combineOccurrenceCoverage(Object.values(sources).map(summary => summary.coverage)),
  });
  return Object.freeze({
    kind: OCCURRENCE_EVIDENCE_KIND,
    analysisRadiiM: Object.freeze([...(result?.analysisRadiiM ?? OCCURRENCE_RADII_M)]),
    measuredCrs: result?.measuredCrs ?? 'EPSG:5070',
    sources,
    lenses: TAXON_LENSES,
    coverage,
    provenance: Object.freeze({ ...(result?.provenance ?? {}) }),
    diagnostics: Object.freeze({ ...(result?.diagnostics ?? {}) }),
    interpretation: OCCURRENCE_INTERPRETATION,
  });
}

function summarizeSource(sourceId, summary) {
  if (!summary) return Object.freeze({ source: sourceId, label: SOURCE_LABELS[sourceId] ?? sourceId, available: false, coverage: COVERAGE.UNKNOWN, reason: 'This source has not been queried.' });
  const available = summary.coverage !== COVERAGE.UNKNOWN;
  return Object.freeze({
    source: sourceId, label: summary.label ?? SOURCE_LABELS[sourceId] ?? sourceId,
    available, coverage: summary.coverage ?? COVERAGE.UNKNOWN, reason: summary.reason ?? null, note: summary.note ?? null,
    observations: summary.observations ?? 0, uniqueTaxa: summary.uniqueTaxa ?? 0,
    preciseObservations: summary.preciseObservations ?? 0, regionalOnlyObservations: summary.regionalOnlyObservations ?? 0,
    nearestM: summary.nearestM ?? null, latestObservedAt: summary.latestObservedAt ?? null,
    buckets: Object.freeze(Object.fromEntries(Object.entries(summary.buckets ?? {}).map(([radius, entry]) => [radius, Object.freeze({ ...entry }) ]))),
    recency: Object.freeze(Object.fromEntries(Object.entries(summary.recency ?? {}).map(([id, entry]) => [id, Object.freeze({ ...entry })]))),
    groups: Object.freeze((summary.groups ?? []).map(entry => Object.freeze({ ...entry }))),
    taxa: Object.freeze((summary.taxa ?? []).map(taxon => Object.freeze({ ...taxon }))),
    // Only precise public observations leave the domain as coordinates. The filter is applied here so
    // that no consumer can map or measure a regional-only record, even by mistake.
    points: Object.freeze((summary.records ?? [])
      .filter(record => record.spatialUse === SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED && record.location)
      .map(record => Object.freeze({ source: record.source, sourceRecordId: record.sourceRecordId,
        label: record.commonName ?? record.scientificName, taxonomicGroup: record.taxonomicGroup,
        location: record.location, distanceToCorridorM: record.distanceToCorridorM ?? null }))),
    searchRegions: Object.freeze((summary.searchRegions ?? []).map(entry => Object.freeze({ ...entry }))),
    temporalCounts: Object.freeze((summary.temporalCounts ?? []).map(entry => Object.freeze({ ...entry }))),
    localRecent: summary.localRecent ?? null,
    windows: Object.freeze({ recency: Object.freeze(Object.entries(summary.recency ?? {}).map(([id, entry]) => Object.freeze({ id, ...entry }))),
      temporal: Object.freeze((summary.temporalCounts ?? []).map(entry => Object.freeze({ ...entry }))) }),
    retrieval: summary.retrieval ?? null, searchRadiusM: summary.searchRadiusM ?? null, searchDisk: summary.searchDisk ?? null,
    windowDays: summary.windowDays ?? null, windowLabel: summary.windowLabel ?? null,
    provenance: Object.freeze({ ...(summary.provenance ?? {}) }),
    diagnostics: Object.freeze({ ...(summary.diagnostics ?? {}) }),
    evidenceKinds: Object.freeze(evidenceKinds(summary)),
  });
}

// The epistemic distinctions the domain must keep: exact local reports, recent regional reports, and
// older documented records are different kinds of evidence and are never merged into one number.
function evidenceKinds(summary) {
  const kinds = [];
  const buckets = summary.buckets ?? {};
  const smallest = Math.min(...Object.keys(buckets).map(Number).filter(Number.isFinite));
  if (Number.isFinite(smallest) && (buckets[smallest]?.observations ?? 0) > 0) kinds.push(EVIDENCE_KIND.LOCAL);
  const recent = (summary.recency?.d30?.observations ?? 0) + (summary.recency?.d90?.observations ?? 0) + (summary.recency?.d365?.observations ?? 0);
  if (recent > 0) kinds.push(EVIDENCE_KIND.RECENT);
  const historical = summary.recency?.historical?.observations ?? 0;
  if (historical > 0) kinds.push(EVIDENCE_KIND.HISTORICAL);
  return kinds;
}

export function sourceCoverageEntries(evidence) {
  return Object.entries(evidence.coverage).map(([datasetId, coverage]) => ({ datasetId, coverage }));
}

export { OCCURRENCE_SOURCE };
