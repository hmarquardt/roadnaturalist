import { COVERAGE, EVIDENCE_KIND } from '../domain/corridor.js';
import { LOCATION_PRECISION, OCCURRENCE_SOURCE, SPATIAL_USE, normalizeOccurrence, taxonomicGroup } from './model.js';

// eBird public API adapter (api.ebird.org/v2).
//
// Credential rule: eBird requires a personal API key on every request. Road Naturalist therefore
// never ships a key to the browser. The adapter takes an injected credential-safe transport; when no
// transport is configured the source reports UNKNOWN with an explicit "credential required" reason
// instead of pretending that no birds were reported. Local development and live verification pass a
// Node transport that reads EBIRD_API_KEY from the environment; production will use a reviewed
// server-side boundary (Cloudflare secret, see worker/README.md). The key is sent only in the
// X-eBirdApiToken request header and is never placed in a URL, in provenance, in fixtures, or in logs.
//
// Product scope: the public API only serves recent observations (`back` is limited to 30 days). It is
// not a historical or bulk source. Road Naturalist uses it for recent bird evidence only; the eBird
// Basic Dataset and Status & Trends products are deliberately out of scope.

export const EBIRD_API = 'https://api.ebird.org/v2';
export const EBIRD_PRODUCT = 'eBird public API (recent observations)';
export const EBIRD_ENDPOINT = `${EBIRD_API}/data/obs/geo/recent`;
export const EBIRD_LICENSE = 'eBird observation data is provided by the Cornell Lab of Ornithology under the eBird API terms of use.';
export const EBIRD_HEADER = 'X-eBirdApiToken';
export const EBIRD_DOCS = 'https://documenter.getpostman.com/view/664302/S1ENwy59';
export const EBIRD_CREDENTIAL_REASON = `eBird requires a personal API key, which Road Naturalist never ships to a browser. No credential-safe transport is configured in this environment (set ${'EBIRD_API_KEY'} for local live verification).`;
export const EBIRD_RECENT_LIMIT_DAYS = 30;
export const EBIRD_ACCEPTABLE_LICENSES = 'https://www.birds.cornell.edu/home/ebird-data-access-terms-of-use/';

export const EBIRD_QUERY = Object.freeze({
  maxRadiusKm: 50,
  maxDaysBack: EBIRD_RECENT_LIMIT_DAYS,
  daysBack: 30,
  maxResults: 200,
  timeoutMs: 20000,
});

// eBird takes a point and a radius, so the search disk is centred on the corridor midpoint with a
// radius large enough to contain the whole corridor neighbourhood: a point within `radiusM` of the
// corridor is within radiusM + corridorLength/2 of the midpoint, by the triangle inequality.
export function searchDisk({ bounds, lengthM, radiusM }, { maxRadiusKm = EBIRD_QUERY.maxRadiusKm } = {}) {
  const lat = (bounds[1] + bounds[3]) / 2;
  const lng = (bounds[0] + bounds[2]) / 2;
  const requiredKm = Math.ceil((lengthM / 2 + radiusM) / 1000);
  return { lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)), distKm: Math.max(1, Math.min(maxRadiusKm, requiredKm)), requiredKm };
}

export function ebirdQueryParams({ disk, daysBack = EBIRD_QUERY.daysBack, maxResults = EBIRD_QUERY.maxResults, sort = 'obs_dt' }) {
  return new URLSearchParams({ lat: String(disk.lat), lng: String(disk.lng), dist: String(disk.distKm), back: String(Math.max(1, Math.min(EBIRD_QUERY.maxDaysBack, daysBack))), maxResults: String(maxResults), sort });
}

export function ebirdCanonicalQuery({ disk, daysBack, maxResults }) {
  return `${EBIRD_ENDPOINT}?${ebirdQueryParams({ disk, daysBack, maxResults }).toString()}`;
}

export async function fetchEbirdRecent({ disk, daysBack, maxResults, transport, timeoutMs = EBIRD_QUERY.timeoutMs }) {
  if (typeof transport !== 'function') {
    return { ok: false, status: 'unavailable', reason: EBIRD_CREDENTIAL_REASON, credentialRequired: true, url: null, elapsedMs: null };
  }
  const params = ebirdQueryParams({ disk, daysBack, maxResults });
  const url = `${EBIRD_ENDPOINT}?${params.toString()}`;
  const started = performance.now();
  try {
    const payload = await transport(url, { timeoutMs });
    const elapsedMs = Math.round(performance.now() - started);
    if (!Array.isArray(payload)) return { ok: false, status: 'failure', reason: 'eBird response is not an observation list', url: ebirdCanonicalQuery({ disk, daysBack, maxResults }), elapsedMs };
    return { ok: true, payload, elapsedMs, url: ebirdCanonicalQuery({ disk, daysBack, maxResults }) };
  } catch (error) {
    return { ok: false, status: 'failure', reason: error.message, url: ebirdCanonicalQuery({ disk, daysBack, maxResults }), elapsedMs: Math.round(performance.now() - started) };
  }
}

// eBird exposes no positional-accuracy field. A public (non-private) checklist location is treated as
// precise at checklist scale; a private location exposes no usable point and stays regional evidence.
// A sensitive-species record is reported at its listed location by eBird itself and is not marked.
export function normalizeEbirdRecord(raw, { retrievedAt = new Date().toISOString(), diskM = null } = {}) {
  const coordinates = Number.isFinite(Number(raw?.lat)) && Number.isFinite(Number(raw?.lng)) ? [Number(raw.lng), Number(raw.lat)] : null;
  const privateLocation = raw?.locationPrivate === true;
  const decision = privateLocation || !coordinates
    ? { locationPrecision: privateLocation ? LOCATION_PRECISION.REGIONAL : LOCATION_PRECISION.UNAVAILABLE, spatialUse: privateLocation ? SPATIAL_USE.REGIONAL_ONLY : SPATIAL_USE.NOT_SPATIALLY_USABLE,
        reason: privateLocation ? 'eBird reports this checklist at a private location, so its coordinates are not used for corridor-distance evidence.' : 'eBird reports no coordinates for this record.' }
    : { locationPrecision: LOCATION_PRECISION.PRECISE, spatialUse: SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED, reason: null };
  const count = raw?.howMany == null || raw.howMany === '' ? null : Number(raw.howMany);
  return normalizeOccurrence({
    source: OCCURRENCE_SOURCE.EBIRD,
    sourceRecordId: [raw?.subId, raw?.speciesCode, raw?.obsDt, raw?.locId].filter(Boolean).join(':') || `${raw?.speciesCode ?? 'unknown'}:${raw?.obsDt ?? 'unknown'}`,
    sourceUrl: raw?.subId ? `https://ebird.org/checklist/${raw.subId}` : 'https://ebird.org',
    taxonId: raw?.speciesCode ?? null, sourceTaxonId: raw?.speciesCode ?? null,
    scientificName: raw?.sciName ?? null, commonName: raw?.comName ?? null,
    taxonomicGroup: taxonomicGroup('Aves'), sourceTaxonGroup: 'Aves', taxonRank: 'species',
    observedAt: isoFromEbird(raw?.obsDt), observedOn: raw?.obsDt ? String(raw.obsDt).slice(0, 10) : null, observedTimeZone: null,
    location: decision.spatialUse === SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED ? coordinates : null,
    locationPrecision: decision.locationPrecision, spatialUse: decision.spatialUse, spatialExclusionReason: decision.reason,
    positionalAccuracyM: null, publicAccuracyM: null,
    quality: raw?.obsReviewed === true ? 'reviewed' : raw?.obsValid === false ? 'invalid' : 'unreviewed',
    captive: raw?.exoticCategory ? raw.exoticCategory : null,
    // A missing count is UNKNOWN, never zero.
    count: Number.isFinite(count) ? count : null,
    placeGuess: raw?.locName ?? null,
    sourceMetadata: {
      speciesCode: raw?.speciesCode ?? null, locationId: raw?.locId ?? null, locationName: raw?.locName ?? null,
      submissionId: raw?.subId ?? null, howMany: Number.isFinite(count) ? count : null, countUnknown: !Number.isFinite(count),
      obsValid: raw?.obsValid ?? null, obsReviewed: raw?.obsReviewed ?? null, locationPrivate: privateLocation,
      exoticCategory: raw?.exoticCategory ?? null,
    },
    provenance: { source: OCCURRENCE_SOURCE.EBIRD, product: EBIRD_PRODUCT, retrievedAt, referenceUrl: raw?.subId ? `https://ebird.org/checklist/${raw.subId}` : null, searchRadiusM: diskM },
  });
}

export function unavailableResult({ reason = EBIRD_CREDENTIAL_REASON, retrievedAt, credentialRequired = true, status = 'unavailable' }) {
  return Object.freeze({
    coverage: COVERAGE.UNKNOWN, records: [], reason, credentialRequired,
    // The same zero-valued shape as a successful summary, so callers never read undefined or mistake
    // an unavailable source for an empty one.
    observations: 0, uniqueTaxa: 0, preciseObservations: 0, regionalOnlyObservations: 0,
    captiveObservations: 0, nearestM: null, latestObservedAt: null,
    buckets: Object.freeze({}), recency: Object.freeze({}), locationPrecision: Object.freeze({}),
    groups: Object.freeze([]), taxa: Object.freeze([]), searchRegions: Object.freeze([]), temporalCounts: Object.freeze([]),
    localRecent: null, retrieval: Object.freeze({ retrieved: 0, truncated: null, measurement: null }),
    note: 'eBird could not be queried. An unavailable source is not evidence that no species were reported.',
    provenance: Object.freeze({ source: OCCURRENCE_SOURCE.EBIRD, product: EBIRD_PRODUCT, endpoint: EBIRD_ENDPOINT, documentationUrl: EBIRD_DOCS,
      license: EBIRD_LICENSE, productScope: 'recent observations only (the public API limits `back` to 30 days); no historical or bulk dataset is used', retrievedAt }),
    diagnostics: Object.freeze({ status, reason, credentialRequired }),
  });
}

export { EVIDENCE_KIND };

function isoFromEbird(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return `${text.replace(' ', 'T')}:00`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00:00Z`;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
