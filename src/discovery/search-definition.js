import { COVERAGE } from '../domain/corridor.js';
import { boundsCoverage } from './regional-catalog.js';
import { METRES_PER_MILE, radiusBounds, searchAreaBounds } from './search-area.js';

// THE INTERACTIVE SEARCH DEFINITION.
//
// A search definition is what a person chose: a centre and a radius in whole statute miles. It is the only
// difference between an arbitrary search and the committed 10/25/50-mile scenarios - everything downstream is
// the same derived discovery machinery, because a definition is converted into an ordinary radius search area
// and handed to the same run.
//
// A definition is a plain value, so the map, the coordinate fields, the presets, the URL and the local storage
// all produce the same input. Nothing here reads data, runs a query, or touches an evidence source: this module
// decides what a search *is* and whether it can be run at all, and the runtime decides what is found.
export const SEARCH_DEFINITION_KIND = 'road-discovery-interactive-search';
export const SEARCH_DEFINITION_VERSION = 1;
// The value of the search-area control that means "the centre and radius below", rather than a declared window.
export const CUSTOM_SEARCH_AREA_ID = 'custom-radius';
export const MIN_RADIUS_MILES = 1;
export const MAX_RADIUS_MILES = 50;
export const DEFAULT_RADIUS_MILES = 10;
// Useful stops, not a capability boundary: every whole mile from 1 to 50 is valid.
export const RADIUS_STOPS_MILES = Object.freeze([5, 10, 25, 50]);
export const MAX_SEARCH_HISTORY = 8;
// A centre is remembered to five decimal places (about a metre). That is finer than the radius test can
// distinguish and coarse enough for a URL that reloads to the same search.
export const CENTER_DECIMALS = 5;
export const SEARCH_QUERY_KEYS = Object.freeze({ latitude: 'lat', longitude: 'lon', radius: 'r' });

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER = /^[+-]?\d+$/;

// A coordinate is read from a number or from a plain decimal string. Anything else - an exponent, a hex
// literal, NaN, Infinity, a comma-separated pair, an empty box - is not a coordinate, and is refused rather
// than coerced. A URL parameter and a text field are the same untrusted input and take the same path.
export function coordinateNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || !DECIMAL.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function radiusNumber(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || !INTEGER.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function problem(field, code, message) { return Object.freeze({ field, code, message }); }

function round(value, decimals) { return Number(value.toFixed(decimals)); }

export function formatCenter(center) {
  return `${center[1].toFixed(4)}, ${center[0].toFixed(4)}`;
}

export function formatRadius(radiusMiles) { return `${radiusMiles} mi`; }

// The one place a centre and a radius become a definition. Bounds come from `radiusBounds`, the same function
// the committed benchmark bounds are asserted against, so an interactive search selects cells exactly as the
// preset with the same centre and radius does.
export function readSearchDefinition(input = {}, { region = null } = {}) {
  const problems = [];
  const lat = coordinateNumber(input.lat);
  const lon = coordinateNumber(input.lon);
  const radiusMiles = radiusNumber(input.radiusMiles);
  if (lat == null) problems.push(problem('latitude', 'latitude.invalid', 'Latitude must be a decimal number of degrees, for example 45.595.'));
  else if (lat < -90 || lat > 90) problems.push(problem('latitude', 'latitude.range', 'Latitude must be between -90 and 90 degrees.'));
  if (lon == null) problems.push(problem('longitude', 'longitude.invalid', 'Longitude must be a decimal number of degrees, for example -122.920.'));
  else if (lon < -180 || lon > 180) problems.push(problem('longitude', 'longitude.range', 'Longitude must be between -180 and 180 degrees.'));
  if (radiusMiles == null) problems.push(problem('radiusMiles', 'radius.invalid', `Radius must be a whole number of miles between ${MIN_RADIUS_MILES} and ${MAX_RADIUS_MILES}.`));
  else if (radiusMiles < MIN_RADIUS_MILES) problems.push(problem('radiusMiles', 'radius.tooSmall', `The smallest search radius in this build is ${MIN_RADIUS_MILES} mile.`));
  else if (radiusMiles > MAX_RADIUS_MILES) problems.push(problem('radiusMiles', 'radius.tooLarge', `The largest search radius in this build is ${MAX_RADIUS_MILES} miles.`));
  let definition = null;
  if (!problems.length) {
    const center = Object.freeze([round(lon, CENTER_DECIMALS), round(lat, CENTER_DECIMALS)]);
    const bounds = Object.freeze(radiusBounds(center, radiusMiles));
    definition = Object.freeze({ kind: SEARCH_DEFINITION_KIND, version: SEARCH_DEFINITION_VERSION,
      center, radiusMiles, bounds, radiusM: radiusMiles * METRES_PER_MILE });
  }
  return Object.freeze({ ok: !problems.length, definition, problems: Object.freeze(problems),
    coverage: definition ? searchRegionCoverage(definition, region) : null });
}

// A definition from a centre that is already known to be finite (a map pick, a preset, a stored search).
export function searchDefinitionOf(center, radiusMiles) {
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) {
    throw new TypeError('A search definition needs a finite centre');
  }
  const result = readSearchDefinition({ lat: center[1], lon: center[0], radiusMiles });
  if (!result.ok) throw new TypeError(result.problems.map(entry => entry.message).join(' '));
  return result.definition;
}

export function regionBoundsOf(region) {
  const bounds = Array.isArray(region) ? region : region?.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return null;
  return bounds;
}

export function regionNameOf(region) {
  return typeof region?.name === 'string' && region.name ? region.name : 'published regional';
}

// What the interface can say before a search runs. It classifies the *bounding box* the search selects cells
// with, which is what the derived runtime classifies too, so the preview and the run agree. That makes the
// answer deliberately conservative: a search whose disk is inside but whose selection box crosses the published
// edge reports PARTIAL before and after, which is a warning rather than a wrong claim.
export function regionCoverageForBounds(bounds, region) {
  const regionBounds = regionBoundsOf(region);
  const name = regionNameOf(region);
  if (!bounds) throw new TypeError('Search coverage needs search bounds');
  if (!regionBounds) {
    return Object.freeze({ coverage: COVERAGE.UNKNOWN, bounds, region: null, name,
      reason: 'This build does not declare the published regional bounds, so coverage cannot be predicted.' });
  }
  const coverage = boundsCoverage(bounds, regionBounds);
  return Object.freeze({ coverage, bounds, region: regionBounds, name, reason: coverageReason(coverage, name) });
}

export function searchRegionCoverage(definition, region) {
  if (!definition) throw new TypeError('Search coverage needs a search definition');
  const bounds = definition.bounds ?? radiusBounds(definition.center, definition.radiusMiles);
  return regionCoverageForBounds(bounds, region);
}

export function areaCoverage(area, region) {
  const bounds = searchAreaBounds(area);
  if (!bounds) throw new TypeError('Area coverage needs a search area with bounds');
  return regionCoverageForBounds(bounds, region);
}

function coverageReason(coverage, name) {
  if (coverage === COVERAGE.FULL) return `The search area lies inside the published ${name} region.`;
  if (coverage === COVERAGE.PARTIAL) {
    return `The search area crosses the edge of the published ${name} region. Corridors near that edge keep `
      + 'their own coverage, and the area outside the region is not read as empty or as having no roads.';
  }
  if (coverage === COVERAGE.NONE) {
    return `The search area does not overlap the published ${name} region, so no corridor metrics can be read for it.`;
  }
  return 'Coverage of the search area could not be determined.';
}

// A search may run when its input is valid and the region is not known to be unreachable. NONE is refused here
// (and refused again by the derived runtime, which is the authority); UNKNOWN is allowed to try, because a
// missing declaration is a configuration problem rather than proof that nothing is there.
export function searchIsRunnable({ ok = false, coverage = null } = {}) {
  if (!ok) return false;
  return coverage?.coverage !== COVERAGE.NONE;
}

// The refusal reason for a definition that cannot be searched, or null when it can.
export function searchRefusal(result) {
  if (!result || !result.ok) {
    const problems = result?.problems ?? [];
    return problems.map(entry => entry.message).join(' ') || 'Choose a search centre and radius.';
  }
  if (result.coverage?.coverage === COVERAGE.NONE) return result.coverage.reason;
  return null;
}

// A definition becomes an ordinary radius search area by taking a *declared* radius scenario as its template:
// same catalog, same required datasets, and only the centre and radius replaced. No second discovery path is
// introduced, and a deployment that publishes no radius scenario cannot offer an interactive search.
export function createInteractiveSearchArea(definition, { template, id = CUSTOM_SEARCH_AREA_ID, name = null } = {}) {
  if (!definition) throw new TypeError('An interactive radius search needs a search definition');
  if (!template || template.kind !== 'radius' || typeof template.catalogUrl !== 'string' || !template.catalogUrl) {
    throw new TypeError('An interactive radius search needs a declared radius search area as its template');
  }
  return Object.freeze({ ...template, id, kind: 'radius',
    name: name ?? `Custom radius search: ${formatRadius(definition.radiusMiles)} at ${formatCenter(definition.center)}`,
    center: Object.freeze([...definition.center]), radiusMiles: definition.radiusMiles, bbox: definition.bounds });
}

// A preset (or a declared radius scenario) is just a definition: selecting one simply fills the centre and
// radius, and nothing else about the search changes.
export function definitionFromSearchArea(area) {
  if (area?.kind !== 'radius') return null;
  const result = readSearchDefinition({ lat: area.center?.[1], lon: area.center?.[0], radiusMiles: area.radiusMiles });
  return result.ok ? result.definition : null;
}

export function radiusPresets(declaration) {
  return Object.freeze((declaration?.searchAreas ?? []).filter(area => area.kind === 'radius'));
}

export function radiusTemplate(declaration) {
  return radiusPresets(declaration)[0] ?? null;
}

// ------------------------------------------------------------------ URL state

// The search is reproducible through the URL. Serialization writes the definition, never a query result, and
// parsing only ever produces a validated definition: an unparsable value is a problem the caller reports, not a
// value that reaches the pipeline. A restored definition is never run automatically.
export function serializeSearchQuery(definition) {
  if (!definition) return '';
  const params = new URLSearchParams();
  params.set(SEARCH_QUERY_KEYS.latitude, String(definition.center[1]));
  params.set(SEARCH_QUERY_KEYS.longitude, String(definition.center[0]));
  params.set(SEARCH_QUERY_KEYS.radius, String(definition.radiusMiles));
  return params.toString();
}

export function parseSearchQuery(search, { region = null } = {}) {
  const params = new URLSearchParams(search ?? '');
  const keys = Object.values(SEARCH_QUERY_KEYS);
  if (!keys.some(key => params.has(key))) return null;
  const result = readSearchDefinition({ lat: params.get(SEARCH_QUERY_KEYS.latitude),
    lon: params.get(SEARCH_QUERY_KEYS.longitude), radiusMiles: params.get(SEARCH_QUERY_KEYS.radius) }, { region });
  return Object.freeze({ ...result, source: 'url' });
}

export function withSearchQuery(search, definition) {
  const params = new URLSearchParams(search ?? '');
  for (const key of Object.values(SEARCH_QUERY_KEYS)) params.delete(key);
  for (const [key, value] of new URLSearchParams(serializeSearchQuery(definition))) params.set(key, value);
  return params.toString();
}

// ------------------------------------------------------------------ storage and history

export function searchDefinitionKey(definition) {
  return `${definition.center[1]},${definition.center[0]},${definition.radiusMiles}`;
}

// Anything read from storage is normalized through the same validation as user input; a value that does not
// survive it is dropped rather than trusted.
export function storedDefinition(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.center) || value.center.length !== 2) return null;
  const result = readSearchDefinition({ lat: value.center[1], lon: value.center[0], radiusMiles: value.radiusMiles });
  return result.ok ? result.definition : null;
}

export function searchHistoryEntry(definition, { at = null } = {}) {
  return Object.freeze({ center: Object.freeze([...definition.center]), radiusMiles: definition.radiusMiles,
    at: typeof at === 'string' && at ? at : null });
}

export function storedHistory(value, { limit = MAX_SEARCH_HISTORY } = {}) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const entries = [];
  const seen = new Set();
  for (const entry of value) {
    const definition = storedDefinition(entry);
    if (!definition) continue;
    const key = searchDefinitionKey(definition);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(searchHistoryEntry(definition, { at: entry?.at }));
    if (entries.length >= limit) break;
  }
  return Object.freeze(entries);
}

export function addSearchHistory(history, definition, { limit = MAX_SEARCH_HISTORY, at = null } = {}) {
  const clean = storedHistory(history, { limit });
  if (!definition) return clean;
  const key = searchDefinitionKey(definition);
  const rest = clean.filter(entry => searchDefinitionKey(storedDefinition(entry) ?? entry) !== key);
  return Object.freeze([searchHistoryEntry(definition, { at }), ...rest].slice(0, Math.max(1, limit)));
}

// The first selection of a session. Precedence is explicit: a URL search, then the search this device last ran,
// then a committed preset while the *declared* area stays the active search - so a URL never silently replaces
// what the workspace already offers, and a reload restores what a person chose.
export function initialSearchSelection({ search = '', stored = null, history = [], presets = [],
  declaredAreaId = null, region = null } = {}) {
  const fromUrl = parseSearchQuery(search, { region });
  if (fromUrl?.definition) {
    return Object.freeze({ selection: Object.freeze({ areaId: CUSTOM_SEARCH_AREA_ID, definition: fromUrl.definition, picking: false }),
      history: storedHistory(history), problems: Object.freeze([]), source: 'url' });
  }
  const remembered = storedDefinition(stored);
  if (remembered) {
    return Object.freeze({ selection: Object.freeze({ areaId: CUSTOM_SEARCH_AREA_ID, definition: remembered, picking: false }),
      history: storedHistory(history), problems: Object.freeze(fromUrl?.problems ?? []), source: 'stored' });
  }
  const preset = presets.map(definitionFromSearchArea).find(Boolean) ?? null;
  return Object.freeze({ selection: Object.freeze({ areaId: declaredAreaId ?? CUSTOM_SEARCH_AREA_ID, definition: preset, picking: false }),
    history: storedHistory(history), problems: Object.freeze(fromUrl?.problems ?? []), source: preset ? 'preset' : 'declared' });
}
