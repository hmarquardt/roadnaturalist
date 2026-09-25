import { COVERAGE } from '../domain/corridor.js';
import {
  CORRIDOR_ACCURACY_LIMIT_M, LOCATION_PRECISION, OCCURRENCE_SOURCE, SPATIAL_USE,
  normalizeOccurrence, taxonomicGroup,
} from './model.js';

// iNaturalist public read adapter.
//
// Endpoint: the public v2 observations API (api.inaturalist.org/v2/observations), unauthenticated,
// which supports a compact `fields` projection. The v1 endpoint returns the same records but ~12 MB
// per 200 records, so v2 is used deliberately. Public reads need no token and the API sends
// `access-control-allow-origin: *`, so the browser can call it directly.
//
// Privacy is decided here, once, from the source's own flags:
//   * obscured observation (geoprivacy, taxon_geoprivacy, or the `obscured` flag) -> REGIONAL_ONLY,
//     and no coordinate is kept at all: the published point is a randomized position inside a cell
//     up to tens of kilometres across, so it can never support a corridor-distance claim.
//   * open observation with a stated accuracy at or below CORRIDOR_ACCURACY_LIMIT_M -> PRECISE.
//   * open observation with a stated accuracy worse than that, or with no stated accuracy at all ->
//     APPROXIMATE, which stays regional evidence because precision is unverified.
//   * no public point at all -> UNAVAILABLE.

export const INATURALIST_API = 'https://api.inaturalist.org/v2/observations';
export const INATURALIST_PRODUCT = 'iNaturalist public observations API (v2)';
export const INATURALIST_LICENSE = 'Observation records are contributed by iNaturalist participants; individual observation licenses are reported per record.';
export const INATURALIST_FIELDS = [
  'id', 'uuid', 'observed_on', 'time_observed_at', 'location', 'geojson', 'positional_accuracy',
  'public_positional_accuracy', 'obscured', 'geoprivacy', 'taxon_geoprivacy', 'quality_grade',
  'captive', 'mappable', 'uri', 'place_guess', 'license_code', 'updated_at', 'created_at',
  'user.login', 'taxon.id', 'taxon.name', 'taxon.preferred_common_name', 'taxon.iconic_taxon_name', 'taxon.rank', 'taxon.ancestor_ids',
].join(',');

export const INATURALIST_QUERY = Object.freeze({
  qualityGrade: 'research',
  maxRecordsPerRegion: 200,
  maxPages: 1,
  recordPageSize: 200,
  countPageSize: 0,
  orderBy: 'observed_on',
  order: 'desc',
  timeoutMs: 20000,
});

export function inaturalistQueryParams({ region, qualityGrade = INATURALIST_QUERY.qualityGrade, perPage, page, d1, fields = INATURALIST_FIELDS }) {
  const params = new URLSearchParams({ swlat: String(region.swlat), swlng: String(region.swlng), nelat: String(region.nelat), nelng: String(region.nelng), geo: 'true' });
  if (qualityGrade) params.set('quality_grade', qualityGrade);
  if (d1) params.set('d1', d1);
  if (perPage != null) params.set('per_page', String(perPage));
  if (page != null) params.set('page', String(page));
  if (perPage) { params.set('order_by', INATURALIST_QUERY.orderBy); params.set('order', INATURALIST_QUERY.order); params.set('fields', fields); }
  return params;
}

// One bounded call. The transport is injected so tests, the browser, and the live verification
// script all exercise the same request construction and the same response handling.
export async function fetchInaturalist({ region, qualityGrade, d1, perPage = 1, page, transport = defaultTransport, timeoutMs = INATURALIST_QUERY.timeoutMs }) {
  const params = inaturalistQueryParams({ region, qualityGrade, perPage, page, d1 });
  const url = `${INATURALIST_API}?${params.toString()}`;
  const started = performance.now();
  const response = await transport(url, { timeoutMs, headers: { Accept: 'application/json' } });
  const elapsedMs = Math.round(performance.now() - started);
  if (!response.ok) throw new Error(`iNaturalist HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.results)) throw new Error('iNaturalist response is not an observation page');
  return { url: canonicalUrl(region, qualityGrade, d1, page), payload, elapsedMs, bytes: response.byteLength ?? null };
}

async function defaultTransport(url, { timeoutMs, headers }) {
  const response = await fetch(url, { headers, signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined });
  return response;
}

// The canonical description of a query, safe to store: no credentials exist for this source and
// none are ever placed in a URL or in provenance.
export function canonicalUrl(region, qualityGrade, d1, page) {
  const params = inaturalistQueryParams({ region, qualityGrade, perPage: null, page: null });
  if (d1) params.set('d1', d1);
  if (page != null) params.set('page', String(page));
  return `${INATURALIST_API}?${params.toString()}`;
}

export const INATURALIST_SPATIAL_RULE = 'iNaturalist open observations may be measured against a corridor when the source states a positional accuracy of '
  + `${CORRIDOR_ACCURACY_LIMIT_M} m or better. Obscured observations are regional evidence only and their published randomized point is never stored, measured, or mapped.`;

// Map one raw iNaturalist observation into the normalized occurrence model.
export function normalizeInaturalistRecord(raw, { retrievedAt = new Date().toISOString() } = {}) {
  const taxon = raw?.taxon ?? {};
  const obscured = raw?.obscured === true || raw?.geoprivacy === 'obscured' || raw?.taxon_geoprivacy === 'obscured';
  const publicAccuracy = numeric(raw?.public_positional_accuracy);
  const statedAccuracy = numeric(raw?.positional_accuracy);
  const coordinates = pointFrom(raw?.geojson, raw?.location);
  const decision = privacyDecision({ obscured, coordinates, statedAccuracy });
  const scientificName = taxon.name ?? null;
  const commonName = taxon.preferred_common_name ?? null;
  return normalizeOccurrence({
    source: OCCURRENCE_SOURCE.INATURALIST,
    sourceRecordId: String(raw?.id ?? raw?.uuid ?? ''),
    sourceUrl: raw?.uri ?? null,
    taxonId: taxon.id ?? null, sourceTaxonId: taxon.id == null ? null : String(taxon.id),
    scientificName: scientificName ?? commonName ?? `iNaturalist observation ${raw?.id}`, commonName,
    sourceTaxonGroup: taxon.iconic_taxon_name ?? null,
    taxonomicGroup: taxonomicGroup(taxon.iconic_taxon_name),
    taxonRank: taxon.rank ?? null,
    observedAt: raw?.time_observed_at ?? (raw?.observed_on ? `${raw.observed_on}T00:00:00Z` : null),
    observedOn: raw?.observed_on ?? null,
    observedTimeZone: null,
    location: decision.spatialUse === SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED ? coordinates : null,
    locationPrecision: decision.locationPrecision, spatialUse: decision.spatialUse,
    spatialExclusionReason: decision.reason,
    positionalAccuracyM: statedAccuracy, publicAccuracyM: publicAccuracy,
    quality: raw?.quality_grade ?? null, captive: raw?.captive ?? null, count: null,
    placeGuess: raw?.place_guess ?? null,
    sourceMetadata: {
      obscured, geoprivacy: raw?.geoprivacy ?? null, taxonGeoprivacy: raw?.taxon_geoprivacy ?? null,
      mappable: raw?.mappable ?? null, licenseCode: raw?.license_code ?? null,
      updatedAt: raw?.updated_at ?? null, userId: raw?.user?.login ?? null, qualityGrade: raw?.quality_grade ?? null,
    },
    provenance: { source: OCCURRENCE_SOURCE.INATURALIST, product: INATURALIST_PRODUCT, retrievedAt, referenceUrl: raw?.uri ?? null },
  });
}

export function privacyDecision({ obscured, coordinates, statedAccuracy }) {
  if (obscured) {
    return { locationPrecision: LOCATION_PRECISION.OBSCURED, spatialUse: SPATIAL_USE.REGIONAL_ONLY,
      reason: 'iNaturalist obscures this observation: the published position is randomized, so it cannot support a corridor-distance claim.' };
  }
  if (!coordinates) {
    return { locationPrecision: LOCATION_PRECISION.UNAVAILABLE, spatialUse: SPATIAL_USE.NOT_SPATIALLY_USABLE,
      reason: 'iNaturalist publishes no public coordinates for this observation.' };
  }
  if (statedAccuracy == null) {
    return { locationPrecision: LOCATION_PRECISION.APPROXIMATE, spatialUse: SPATIAL_USE.REGIONAL_ONLY,
      reason: 'iNaturalist states no positional accuracy for this observation, so its precision is unverified.' };
  }
  if (statedAccuracy > CORRIDOR_ACCURACY_LIMIT_M) {
    return { locationPrecision: LOCATION_PRECISION.APPROXIMATE, spatialUse: SPATIAL_USE.REGIONAL_ONLY,
      reason: `iNaturalist states a positional accuracy of ${Math.round(statedAccuracy)} m, which is coarser than the ${CORRIDOR_ACCURACY_LIMIT_M} m limit for corridor-distance evidence.` };
  }
  return { locationPrecision: LOCATION_PRECISION.PRECISE, spatialUse: SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED, reason: null };
}

function pointFrom(geojson, location) {
  if (geojson?.type === 'Point' && Array.isArray(geojson.coordinates) && geojson.coordinates.every(Number.isFinite)) {
    const [lon, lat] = geojson.coordinates;
    if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) return [lon, lat];
    return null;
  }
  if (typeof location === 'string' && location.includes(',')) {
    const [lat, lon] = location.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return [lon, lat];
  }
  return null;
}

function numeric(value) { const number = Number(value); return value == null || value === '' || !Number.isFinite(number) ? null : number; }

export function summarizeQuery({ raw, region, qualityGrade, d1, retrievedAt, records }) {
  const reported = Number.isFinite(Number(raw?.total_results)) ? Number(raw.total_results) : null;
  return Object.freeze({
    canonicalQuery: canonicalUrl(region, qualityGrade, d1, null), region: Object.freeze({ ...region }),
    qualityGrade: qualityGrade ?? null, d1: d1 ?? null, retrievedAt,
    sourceReportedTotal: reported, retrieved: records.length,
    truncated: reported == null ? null : reported > records.length,
  });
}

export function emptyResult({ reason, region = null, qualityGrade = null, retrievedAt }) {
  return Object.freeze({ coverage: COVERAGE.UNKNOWN, records: [], reason, note: null, regions: [], temporalCounts: [], provenance: Object.freeze({ source: OCCURRENCE_SOURCE.INATURALIST, product: INATURALIST_PRODUCT, retrievedAt }), diagnostics: Object.freeze({ status: 'unavailable', reason }) });
}
