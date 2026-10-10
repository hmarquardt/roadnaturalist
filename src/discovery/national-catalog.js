// The national derived discovery catalog: what production discovery resolves for a search anywhere in the
// conterminous United States.
//
// It is a pointer, not a second data plane. It declares the published CONUS region, the partition scheme, the
// analysis halo, the data origin, and - as one small reviewed artifact - the analysis fingerprint and digest of
// the immutable national derived manifest the discovery runtime must fetch. It is deliberately *not* a regional
// catalog: the regional catalogs (`data/regional/manifest.json`) describe the raw roads/wetlands/hydrography
// partitions a detailed analysis reads, and those raw national planes are not published. National discovery is
// derived-first; the detailed, promotion path keeps using the regional catalogs and fails closed rather than
// silently measuring precomputed geometry.
//
// WHY THE CATALOG, NOT THE RUNTIME, PINS THE FINGERPRINT
//
// For a regional derived plane the browser recomputes the analysis fingerprint from the catalog it loaded, so a
// code change that alters discovery semantics invalidates the plane. The national plane's fingerprint also covers
// the Python builder and its pipeline digest (`scripts/build-national-derived.py`), which a browser cannot hash,
// so the reviewed catalog carries the expected fingerprint instead. The runtime still fails closed on everything
// it *can* check: the manifest's own fingerprint must equal the catalog's, its profileVersion and
// derivedSchemaVersion must equal the running code's, its region must equal the catalog's, and its schema must
// still carry every column the runtime reads. See `nationalDerivedAvailability` and the gate in
// `src/gis/service.js`.
export const NATIONAL_CATALOG_KIND = 'road-discovery-national-derived-catalog';
export const NATIONAL_CATALOG_SCHEMA_VERSION = 1;
export const NATIONAL_DERIVED_PREFIX = 'derived/corridor-metrics';

const FINGERPRINT = /^[a-f0-9]{64}$/;

function orderedBounds(bounds) {
  return Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)
    && bounds[0] < bounds[2] && bounds[1] < bounds[3];
}

function sameBounds(left, right) {
  return Array.isArray(left) && left.length === 4 && left.every((value, index) => Math.abs(value - right[index]) <= 1e-9);
}

export function isNationalCatalog(catalog) {
  return catalog?.kind === NATIONAL_CATALOG_KIND;
}

export function validateNationalDerivedCatalog(catalog) {
  if (catalog?.kind !== NATIONAL_CATALOG_KIND || catalog.schemaVersion !== NATIONAL_CATALOG_SCHEMA_VERSION
    || catalog.project !== 'roadnaturalist' || typeof catalog.version !== 'string' || !catalog.version) {
    throw new TypeError('Not a national derived discovery catalog');
  }
  const region = catalog.region ?? {};
  if (typeof region.id !== 'string' || !region.id || typeof region.name !== 'string' || !region.name
    || !orderedBounds(region.bounds)) throw new TypeError('The national catalog declares no published region');
  if (!orderedBounds(region.publishedBounds) || !sameBounds(region.publishedBounds, region.bounds)) {
    throw new TypeError('The national catalog published bounds disagree with its region bounds');
  }
  const grid = catalog.grid ?? {};
  if (grid.kind !== 'lonlat-grid' || !Array.isArray(grid.origin) || grid.origin.length !== 2
    || !grid.origin.every(Number.isFinite) || !(grid.stepLon > 0 && grid.stepLat > 0)) {
    throw new TypeError('The national catalog declares no partition scheme');
  }
  if (!(catalog.maxAnalysisDistanceM >= 1000)) throw new TypeError('The national catalog declares no analysis halo');
  if (catalog.assetBaseUrl != null && !/^https:\/\/[^/]+\/$/.test(catalog.assetBaseUrl)) {
    throw new TypeError('Invalid national asset base URL');
  }
  const derived = catalog.derived ?? {};
  if (!FINGERPRINT.test(derived.analysisFingerprint ?? '') || !FINGERPRINT.test(derived.manifestSha256 ?? '')
    || !Number.isSafeInteger(derived.manifestBytes) || !Number.isSafeInteger(derived.cells) || derived.cells <= 0
    || !Number.isSafeInteger(derived.derivedSchemaVersion) || !Number.isSafeInteger(derived.profileVersion)) {
    throw new TypeError('The national catalog declares no usable derived plane');
  }
  if (derived.manifestUrl !== `${NATIONAL_DERIVED_PREFIX}/${derived.analysisFingerprint}/manifest.json`) {
    throw new TypeError('The national derived manifest URL does not match its analysis fingerprint');
  }
  return catalog;
}
