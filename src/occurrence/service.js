import { COVERAGE } from '../domain/corridor.js';
import { corridorGeometry } from '../domain/geometry.js';
import {
  EBIRD_ENDPOINT, EBIRD_PRODUCT, EBIRD_QUERY, fetchEbirdRecent, normalizeEbirdRecord, searchDisk,
  unavailableResult as ebirdUnavailable,
} from './ebird.js';
import {
  INATURALIST_API, INATURALIST_PRODUCT, INATURALIST_QUERY, fetchInaturalist,
  normalizeInaturalistRecord,
} from './inaturalist.js';
import {
  OCCURRENCE_RADII_M, OCCURRENCE_SOURCE, PRIVACY_RULE, RECENCY_WINDOWS, SOURCE_LABELS,
  SPATIAL_USE, normalizeOccurrence,
} from './model.js';
import { summarizeOccurrences } from './summary.js';

// Occurrence orchestration: canonical queries, bounded retrieval, one request cache, and the
// deterministic spatial/temporal/taxonomic summaries built on the normalized model.
//
// Nothing here decides whether a species is likely to be on a road. It reports what was publicly
// reported, how recent it is, and how strong the spatial evidence is.

export const NORMALIZATION_VERSION = 'occurrence-normalize-v1';
export const OCCURRENCE_SOURCES = Object.freeze([OCCURRENCE_SOURCE.INATURALIST, OCCURRENCE_SOURCE.EBIRD]);
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CONCURRENT_REQUESTS = 3;
const RECORD_REGIONS = 2; // per-record detail is retrieved for the smallest regions only

export function searchRegion(bounds, radiusM) {
  const centre = ((bounds[1] + bounds[3]) / 2) * Math.PI / 180;
  const latPad = radiusM / 110000;
  const lonPad = radiusM / (111320 * Math.max(Math.cos(centre), 0.2));
  return Object.freeze({
    swlat: round5(bounds[1] - latPad), swlng: round5(bounds[0] - lonPad),
    nelat: round5(bounds[3] + latPad), nelng: round5(bounds[2] + lonPad), radiusM,
  });
}

export function createOccurrenceCache({ ttlMs = DEFAULT_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) { entries.delete(key); return null; }
      return entry.value;
    },
    set(key, value) { entries.set(key, { value, expiresAt: now() + ttlMs }); return value; },
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}

export { normalizeOccurrence };

export function createOccurrenceService({
  inaturalistTransport = null, ebirdTransport = null, measureDistances = null,
  now = () => Date.now(), cache = null, clock = () => Date.now(),
} = {}) {
  // The default cache shares the injected clock, so freshness is testable without waiting.
  const requestCache = cache ?? createOccurrenceCache({ now });
  const requests = { inaturalist: 0, ebird: 0 };

  async function limit(items, worker) {
    const results = [];
    const queue = [...items];
    const runners = Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, queue.length) }, async () => {
      while (queue.length) results.push(await worker(queue.shift()));
    });
    await Promise.all(runners);
    return results;
  }

  // Distance measurement is delegated to the GIS layer (DuckDB Spatial) so occurrence evidence uses
  // the same projected measurement path as habitat evidence.
  async function measure(records, geometry) {
    const eligible = records.filter(record => record.spatialUse === SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED && record.location);
    if (!eligible.length) return { records, measurement: { measured: 0, skipped: 0, crs: null, note: 'No record had a usable precise public location.' } };
    if (typeof measureDistances !== 'function') {
      return { records, measurement: { measured: 0, skipped: eligible.length, crs: null, note: 'No spatial measurement engine is connected, so no corridor distances were claimed.' } };
    }
    const measured = await measureDistances(geometry, eligible.map(record => ({ id: `${record.source}:${record.sourceRecordId}`, coordinates: record.location })));
    const enriched = records.map(record => {
      const distance = measured.distances.get(`${record.source}:${record.sourceRecordId}`);
      return Number.isFinite(distance) ? Object.freeze({ ...record, distanceToCorridorM: Math.round(distance * 10) / 10 }) : record;
    });
    return { records: enriched, measurement: { measured: measured.measured, skipped: measured.skipped, crs: measured.crs, note: null } };
  }

  async function inaturalistSummary(corridor, { radiiM = OCCURRENCE_RADII_M } = {}) {
    const geometry = corridorGeometry(corridor);
    const key = `inaturalist:${radiiM.join(',')}:${geometry.bounds.map(value => value.toFixed(4)).join(',')}`;
    const cached = requestCache.get(key);
    if (cached) return { ...cached, diagnostics: { ...cached.diagnostics, cached: true } };
    const started = clock();
    const retrievedAt = new Date(now()).toISOString();
    const regions = radiiM.map(radius => ({ radiusM: radius, region: searchRegion(geometry.bounds, radius) }));
    const outer = regions.at(-1);
    const daysAgo = days => new Date(now() - days * 86400000).toISOString().slice(0, 10);
    if (typeof inaturalistTransport !== 'function') {
      return unavailableInaturalist({ reason: 'No iNaturalist transport is configured in this environment.', retrievedAt, queryMs: 0, requests: 0 });
    }
    const countJobs = [
      ...regions.map(entry => ({ kind: 'count', entry, params: { region: entry.region, qualityGrade: INATURALIST_QUERY.qualityGrade, perPage: 0 } })),
      { kind: 'count', entry: regions[0], params: { region: regions[0].region, qualityGrade: null, perPage: 0 } },
      ...RECENCY_WINDOWS.filter(window => window.days != null).map(window => ({ kind: 'temporal', window, entry: outer, params: { region: outer.region, qualityGrade: INATURALIST_QUERY.qualityGrade, perPage: 0, d1: daysAgo(window.days) } })),
      { kind: 'localRecent', window: RECENCY_WINDOWS[0], entry: regions[0], params: { region: regions[0].region, qualityGrade: INATURALIST_QUERY.qualityGrade, perPage: 0, d1: daysAgo(RECENCY_WINDOWS[0].days) } },
    ];
    const recordJobs = regions.slice(0, RECORD_REGIONS).map(entry => ({ kind: 'records', entry, params: { region: entry.region, qualityGrade: INATURALIST_QUERY.qualityGrade, perPage: INATURALIST_QUERY.maxRecordsPerRegion } }));
    const outcomes = await limit([...countJobs, ...recordJobs], async job => {
      requests.inaturalist += 1;
      try {
        const result = await fetchInaturalist({ ...job.params, transport: inaturalistTransport });
        return { job, result };
      } catch (error) {
        return { job, error: error.message };
      }
    });
    const failures = outcomes.filter(outcome => outcome.error);
    if (failures.length === outcomes.length) {
      return unavailableInaturalist({ reason: failures[0].error, retrievedAt, queryMs: Math.round(clock() - started), requests: outcomes.length });
    }
    const searchRegions = regions.map(entry => {
      const count = outcomes.find(outcome => outcome.job.kind === 'count' && outcome.job.entry.radiusM === entry.radiusM && outcome.job.params.qualityGrade);
      const allGrades = outcomes.find(outcome => outcome.job.kind === 'count' && outcome.job.entry.radiusM === entry.radiusM && !outcome.job.params.qualityGrade);
      const records = outcomes.find(outcome => outcome.job.kind === 'records' && outcome.job.entry.radiusM === entry.radiusM);
      const reported = count ? totalOf(count.result?.payload) : null;
      return Object.freeze({
        radiusM: entry.radiusM, region: entry.region, recordDetail: regions.slice(0, RECORD_REGIONS).some(item => item.radiusM === entry.radiusM),
        sourceReportedTotal: reported,
        allGradesTotal: allGrades ? totalOf(allGrades.result?.payload) : null,
        retrieved: records ? records.result.payload.results.length : 0,
        truncated: reported == null || !records ? null : reported > records.result.payload.results.length,
        error: count?.error ?? records?.error ?? null,
      });
    });
    const temporalCounts = RECENCY_WINDOWS.filter(window => window.days != null).map(window => {
      const outcome = outcomes.find(item => item.job.kind === 'temporal' && item.job.window.id === window.id);
      return Object.freeze({ id: window.id, label: `Reported in the last ${window.days} days`, days: window.days, regionRadiusM: outer.radiusM,
        sourceReportedTotal: outcome ? totalOf(outcome.result?.payload) : null, error: outcome?.error ?? null });
    });
    const localRecent = outcomes.find(outcome => outcome.job.kind === 'localRecent');
    const rawRecords = outcomes.filter(outcome => outcome.job.kind === 'records' && outcome.result)
      .flatMap(outcome => outcome.result.payload.results.map(raw => normalizeInaturalistRecord(raw, { retrievedAt })));
    const { records, measurement } = await measure(rawRecords, geometry.geometry);
    const summaries = summarizeOccurrences(records, { now: now(), radiiM });
    const truncatedRegions = searchRegions.filter(region => region.truncated === true);
    const incomplete = truncatedRegions.length > 0 || failures.length > 0;
    const coverage = incomplete ? COVERAGE.PARTIAL : COVERAGE.FULL;
    const result = Object.freeze({
      source: OCCURRENCE_SOURCE.INATURALIST, label: SOURCE_LABELS[OCCURRENCE_SOURCE.INATURALIST],
      coverage, reason: null,
      note: [
        truncatedRegions.length ? `The public record is larger than the retrieval budget: ${truncatedRegions.length} of ${searchRegions.length} search regions returned more records than the ${INATURALIST_QUERY.maxRecordsPerRegion}-record cap, which was kept most-recent-first. Search-region totals are source-reported and complete; the per-taxon detail is a bounded sample.` : null,
        failures.length ? `${failures.length} of ${outcomes.length} iNaturalist queries failed: ${failures[0].error}.` : null,
      ].filter(Boolean).join(' ') || null,
      searchRegions: Object.freeze(searchRegions), temporalCounts: Object.freeze(temporalCounts),
      localRecent: localRecent?.result ? Object.freeze({ id: RECENCY_WINDOWS[0].id, label: `Reported in the last ${RECENCY_WINDOWS[0].days} days`, days: RECENCY_WINDOWS[0].days,
        regionRadiusM: regions[0].radiusM, sourceReportedTotal: totalOf(localRecent.result.payload) }) : null,
      records: Object.freeze([...records]),
      retrieval: Object.freeze({
        recordRegions: regions.slice(0, RECORD_REGIONS).map(entry => entry.radiusM), capPerRegion: INATURALIST_QUERY.maxRecordsPerRegion,
        retrieved: records.length, precise: summaries.preciseObservations, regionalOnly: summaries.regionalOnlyObservations,
        truncated: truncatedRegions.length > 0, requestCount: outcomes.length, failedRequests: failures.length,
        measurement: Object.freeze({ ...measurement }),
      }),
      ...summaries,
      provenance: Object.freeze({
        source: OCCURRENCE_SOURCE.INATURALIST, label: SOURCE_LABELS[OCCURRENCE_SOURCE.INATURALIST],
        product: INATURALIST_PRODUCT, endpoint: INATURALIST_API, authentication: 'none (public read)',
        referenceUrl: 'https://api.inaturalist.org/v1/docs/', license: null, retrievedAt,
        qualityGrade: INATURALIST_QUERY.qualityGrade, radiiM: Object.freeze([...radiiM]), windowDays: null,
        canonicalQueries: Object.freeze([...new Set(outcomes.filter(outcome => outcome.result).map(outcome => outcome.result.url))]),
        returnedBySource: Object.freeze({ records: summaries.observations, uniqueTaxa: summaries.uniqueTaxa }),
        resultCounts: Object.freeze({ requests: outcomes.length, retrieved: records.length }),
        truncation: Object.freeze({ truncated: truncatedRegions.length > 0, truncatedRegions: Object.freeze(truncatedRegions.map(region => region.radiusM)), capPerRegion: INATURALIST_QUERY.maxRecordsPerRegion }),
        privacyFilter: PRIVACY_RULE, normalizationVersion: NORMALIZATION_VERSION,
      }),
      diagnostics: Object.freeze({ status: 'ready', reason: null, queryMs: Math.round(clock() - started), requests: outcomes.length, cached: false }),
    });
    requestCache.set(key, result);
    return result;
  }

  async function ebirdSummary(corridor, { radiiM = OCCURRENCE_RADII_M, daysBack = EBIRD_QUERY.daysBack } = {}) {
    const geometry = corridorGeometry(corridor);
    const key = `ebird:${radiiM.join(',')}:${daysBack}:${geometry.bounds.map(value => value.toFixed(4)).join(',')}`;
    const cached = requestCache.get(key);
    if (cached) return { ...cached, diagnostics: { ...cached.diagnostics, cached: true } };
    const started = clock();
    const retrievedAt = new Date(now()).toISOString();
    const disk = searchDisk({ bounds: geometry.bounds, lengthM: geometry.lengthM, radiusM: Math.max(...radiiM) });
    if (typeof ebirdTransport !== 'function') {
      return Object.freeze({ ...ebirdUnavailable({ retrievedAt }),
        label: SOURCE_LABELS[OCCURRENCE_SOURCE.EBIRD], searchRadiusM: Math.max(...radiiM), searchDisk: disk,
        diagnostics: Object.freeze({ status: 'unavailable', reason: ebirdUnavailable({ retrievedAt }).reason, credentialRequired: true, queryMs: 0, requests: 0, cached: false }) });
    }
    requests.ebird += 1;
    const outcome = await fetchEbirdRecent({ disk, daysBack, maxResults: EBIRD_QUERY.maxResults, transport: ebirdTransport });
    if (!outcome.ok) {
      return Object.freeze({ ...ebirdUnavailable({ reason: outcome.reason, retrievedAt, credentialRequired: Boolean(outcome.credentialRequired), status: outcome.status ?? 'failure' }),
        label: SOURCE_LABELS[OCCURRENCE_SOURCE.EBIRD], searchRadiusM: Math.max(...radiiM), searchDisk: disk,
        diagnostics: Object.freeze({ status: outcome.status ?? 'unavailable', reason: outcome.reason, credentialRequired: Boolean(outcome.credentialRequired), queryMs: outcome.elapsedMs, requests: 1, cached: false }) });
    }
    const rawRecords = outcome.payload.map(raw => normalizeEbirdRecord(raw, { retrievedAt, diskM: disk.distKm * 1000 }));
    const { records, measurement } = await measure(rawRecords, geometry.geometry);
    const summaries = summarizeOccurrences(records, { now: now(), radiiM });
    const truncated = outcome.payload.length >= EBIRD_QUERY.maxResults;
    const result = Object.freeze({
      source: OCCURRENCE_SOURCE.EBIRD, label: SOURCE_LABELS[OCCURRENCE_SOURCE.EBIRD],
      coverage: truncated ? COVERAGE.PARTIAL : COVERAGE.FULL, reason: null,
      note: truncated
        ? `eBird returned the ${EBIRD_QUERY.maxResults}-record maximum for this search, so more reports may exist. Counts here describe the retrieved reports only.`
        : null,
      records: Object.freeze([...records]),
      searchRadiusM: Math.max(...radiiM), searchDisk: Object.freeze({ ...disk }),
      windowDays: daysBack, windowLabel: `Last ${daysBack} days`,
      retrieval: Object.freeze({ retrieved: records.length, precise: summaries.preciseObservations, regionalOnly: summaries.regionalOnlyObservations,
        truncated, maxResults: EBIRD_QUERY.maxResults, requestCount: 1, measurement: Object.freeze({ ...measurement }) }),
      ...summaries,
      provenance: Object.freeze({
        source: OCCURRENCE_SOURCE.EBIRD, label: SOURCE_LABELS[OCCURRENCE_SOURCE.EBIRD],
        product: EBIRD_PRODUCT, endpoint: EBIRD_ENDPOINT, authentication: 'personal API key held server-side; never sent to the browser',
        referenceUrl: 'https://documenter.getpostman.com/view/664302/S1ENwy59', license: null, retrievedAt,
        canonicalQuery: outcome.url, searchDiskKm: disk.distKm, windowDays: daysBack, radiiM: Object.freeze([...radiiM]),
        productScope: 'recent observations only; the public API limits `back` to 30 days, so historical and bulk eBird data are out of scope',
        returnedBySource: Object.freeze({ records: summaries.observations, uniqueTaxa: summaries.uniqueTaxa }),
        resultCounts: Object.freeze({ requests: 1, retrieved: records.length }),
        truncation: Object.freeze({ truncated, maxResults: EBIRD_QUERY.maxResults }),
        privacyFilter: 'eBird private checklist locations are regional evidence only; species counts marked X by the observer stay UNKNOWN, never zero.',
        normalizationVersion: NORMALIZATION_VERSION,
      }),
      diagnostics: Object.freeze({ status: 'ready', reason: null, queryMs: Math.round(clock() - started), requests: 1, cached: false }),
    });
    requestCache.set(key, result);
    return result;
  }

  async function analyze(corridor, { radiiM = OCCURRENCE_RADII_M, sources = OCCURRENCE_SOURCES } = {}) {
    const started = clock();
    const results = {};
    // Sequential per source: both summaries share one DuckDB connection for measurement.
    if (sources.includes(OCCURRENCE_SOURCE.INATURALIST)) results[OCCURRENCE_SOURCE.INATURALIST] = await inaturalistSummary(corridor, { radiiM });
    if (sources.includes(OCCURRENCE_SOURCE.EBIRD)) results[OCCURRENCE_SOURCE.EBIRD] = await ebirdSummary(corridor, { radiiM });
    const measuredCrs = Object.values(results).map(result => result.retrieval?.measurement?.crs).find(Boolean) ?? null;
    return {
      analysisRadiiM: [...radiiM], measuredCrs, sources: results,
      provenance: Object.freeze({ method: SUMMARY_METHOD, privacyRule: PRIVACY_RULE, normalizationVersion: NORMALIZATION_VERSION, retrievedAt: new Date(now()).toISOString() }),
      diagnostics: { status: 'ready', reason: null, queryMs: Math.round(clock() - started), requests: { ...requests }, cached: Object.values(results).some(result => result.diagnostics.cached) },
    };
  }

  // One source, one radius: the small per-source query used by callers that do not need the whole
  // evidence bundle. Unknown sources and missing corridors stay UNKNOWN rather than becoming zero.
  async function getNearby({ source, corridor = null, radiusM = OCCURRENCE_RADII_M[0] } = {}) {
    if (!OCCURRENCE_SOURCES.includes(source)) {
      return { source: source ?? null, coverage: COVERAGE.UNKNOWN, records: [], reason: `${source ?? 'Occurrence'} source is not connected`, provenance: null, diagnostics: { status: 'unavailable' } };
    }
    if (!corridor) return { source, coverage: COVERAGE.UNKNOWN, records: [], reason: 'Occurrence queries need a corridor', provenance: null, diagnostics: { status: 'unavailable' } };
    const summary = source === OCCURRENCE_SOURCE.INATURALIST
      ? await inaturalistSummary(corridor, { radiiM: [radiusM] })
      : await ebirdSummary(corridor, { radiiM: [radiusM] });
    return { source, coverage: summary.coverage, records: summary.records ?? [], taxa: summary.taxa ?? [],
      reason: summary.reason ?? null, note: summary.note ?? null, provenance: summary.provenance, diagnostics: summary.diagnostics };
  }

  return { analyze, getNearby, inaturalistSummary, ebirdSummary, cache: requestCache, requests: () => ({ ...requests }) };
}

export const SUMMARY_METHOD = 'Source adapters retrieve bounded public occurrence pages; records are normalized once, privacy-filtered, '
  + 'measured against the corridor in EPSG:5070 with DuckDB Spatial, then aggregated by evidence radius, recency window and taxonomic group.';

function unavailableInaturalist({ reason, retrievedAt, queryMs, requests }) {
  return Object.freeze({
    source: OCCURRENCE_SOURCE.INATURALIST, label: SOURCE_LABELS[OCCURRENCE_SOURCE.INATURALIST],
    coverage: COVERAGE.UNKNOWN, reason, records: [], taxa: Object.freeze([]), groups: Object.freeze([]),
    searchRegions: Object.freeze([]), temporalCounts: Object.freeze([]), buckets: Object.freeze({}), recency: Object.freeze({}),
    observations: 0, uniqueTaxa: 0, preciseObservations: 0, regionalOnlyObservations: 0, latestObservedAt: null, nearestM: null,
    localRecent: null, retrieval: Object.freeze({ retrieved: 0, truncated: null, measurement: null }),
    note: 'iNaturalist could not be queried. An unavailable source is not evidence that no species were reported.',
    provenance: Object.freeze({ source: OCCURRENCE_SOURCE.INATURALIST, product: INATURALIST_PRODUCT, endpoint: INATURALIST_API,
      authentication: 'none (public read)', retrievedAt, privacyFilter: PRIVACY_RULE, normalizationVersion: NORMALIZATION_VERSION }),
    diagnostics: Object.freeze({ status: 'unavailable', reason, queryMs, requests, cached: false }),
  });
}

function totalOf(payload) {
  const value = Number(payload?.total_results);
  return Number.isFinite(value) ? value : null;
}

function round5(value) { return Math.round(value * 100000) / 100000; }
