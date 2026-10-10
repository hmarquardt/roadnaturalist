import { validateNationalDerivedCatalog } from './national-catalog.js';
import { validateRegionalCatalog } from './regional-catalog.js';

// WHICH CATALOG A DISCOVERY SEARCH LOADS IS DECLARED, NOT INFERRED
//
// A search area names a catalog *and its type*, and the loader validates the fetched document with the contract
// that type owns - and only that contract. A regional catalog is validated as a regional catalog; a national
// derived catalog is validated as a national derived catalog. Nothing sniffs `kind` to pick a schema, nothing
// falls back to another schema when the first one fails, and nothing coerces one shape into the other.
//
// That distinction is not academic. On the national cutover the deployed frontend and the deployed data were
// briefly one version apart: the browser ran the previous release's `validateRegionalCatalog(await
// response.json())` while `data/national/derived-catalog.json` was already the national pointer, so an
// interactive *national* search failed as `TypeError: Invalid regional catalog` - a message about the wrong
// contract entirely. With a declared type the same skew fails closed on the right question: the document at
// `national/...` is not a valid national derived catalog, and the search refuses rather than being validated
// against a schema it never claimed to satisfy.
export const DISCOVERY_CATALOG_TYPE = Object.freeze({ REGIONAL: 'regional', NATIONAL: 'national', RAW: 'raw' });
export const DISCOVERY_CATALOG_TYPES = Object.freeze(Object.values(DISCOVERY_CATALOG_TYPE));

// Where each type's catalog is published. A declared type whose path does not match is a declaration error,
// reported as one, because guessing which of the two a URL meant is exactly how this bug happened.
export const DISCOVERY_CATALOG_PREFIX = Object.freeze({ regional: 'regional/', national: 'national/', raw: 'raw/' });

export function isDiscoveryCatalogType(value) {
  return DISCOVERY_CATALOG_TYPES.includes(value);
}

// The one place a fetched document becomes a validated catalog. `catalogType` decides the contract; an unknown
// type is refused rather than defaulted.
//
// RAW is the third type, and it is the *regional raw partition contract* applied to a bounded published region
// of the national planes: same shape, same grid, same reader, same promotion engine. The name records which
// plane it serves rather than inventing a second schema - and keeping it a distinct declared type is what stops a
// national derived pointer (which has no raw cells at all) from ever being read as raw source, or the reverse.
export function validateDiscoveryCatalog(document, catalogType) {
  if (catalogType === DISCOVERY_CATALOG_TYPE.REGIONAL) return validateRegionalCatalog(document);
  if (catalogType === DISCOVERY_CATALOG_TYPE.NATIONAL) return validateNationalDerivedCatalog(document);
  if (catalogType === DISCOVERY_CATALOG_TYPE.RAW) {
    const catalog = validateRegionalCatalog(document);
    if (catalog.publication?.kind !== 'raw-regions') {
      throw new TypeError('A raw catalog must declare its raw publication block');
    }
    return catalog;
  }
  throw new TypeError(`Unknown discovery catalog type: ${String(catalogType)}`);
}

// The type a catalog *path* names, used to check that a declaration is internally consistent (and nothing else:
// the validator for a fetched document always comes from the search area's declared type).
export function catalogTypeForPath(url) {
  if (typeof url !== 'string' || !url.endsWith('.json')) return null;
  for (const type of DISCOVERY_CATALOG_TYPES) {
    if (url.startsWith(DISCOVERY_CATALOG_PREFIX[type])) return type;
  }
  return null;
}
