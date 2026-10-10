import { METRES_PER_MILE, METRES_PER_DEGREE_LAT, METRES_PER_DEGREE_LON } from './search-area.js';
import { haversineM } from '../domain/geometry.js';

// THE PLACE GAZETTEER.
//
// Place names are a bounded, local lookup that feeds the search definition this project already trusts. The
// artifact is a small static file reduced offline (scripts/build-places.py) from the pinned U.S. Census
// Bureau Gazetteer file to the published region plus a 50-mile margin, so nothing here fetches, geocodes, or
// guesses: a query is matched against a few hundred named places in the browser, in microseconds.
//
// It is not a geocoder and not a general feature finder. There are no street addresses, no landmarks, no
// streams or peaks, and no national list; the artifact declares the states and place classes it covers, and
// this module refuses to read a document that says anything else.
export const PLACE_GAZETTEER_KIND = 'road-discovery-place-gazetteer';
export const PLACE_GAZETTEER_SCHEMA_VERSION = 1;
// Measured against the actual regional list: at two characters five prefixes already return a capped list
// and the mean result count is 3.2; at three characters no prefix exceeds six and the mean is 1.4.
export const MIN_PLACE_QUERY_LENGTH = 3;
export const MAX_PLACE_RESULTS = 8;
export const MAX_PLACE_QUERY_LENGTH = 64;
export const MAX_PLACE_NAME_LENGTH = 64;
export const PLACE_MARGIN_MILES = 50;
export const PLACE_FEATURE_CLASSES = Object.freeze({ city: 'City', town: 'Town', cdp: 'Census-designated place' });
// A documented normalization rule, not data: the two abbreviations that appear in this source's own names
// are folded to the word they abbreviate, so "St. Helens" and "Saint Helens" are the same query and the same
// place. Nothing else is rewritten, and no alias list is invented.
export const PLACE_ABBREVIATIONS = Object.freeze({ st: 'saint', mt: 'mount', ft: 'fort' });
// A typo is one insertion, deletion or substitution, only for a query of at least five characters, and only
// when the first character already matches: a short or unrelated query gets nothing rather than a guess.
const FUZZY_MIN_LENGTH = 5;

// Deterministic text normalization, applied identically to a query and to every stored name: Unicode NFKD
// with combining marks removed, case folded, periods/apostrophes and hyphens/slashes treated as separators,
// remaining punctuation dropped, whitespace collapsed, and the documented abbreviations folded.
export function normalizePlaceText(value) {
  if (typeof value !== 'string') return '';
  const folded = value.normalize('NFKD').replace(/\p{M}/gu, '');
  const words = folded.toLowerCase()
    .replace(/[.'’`]/g, ' ')
    .replace(/[-–—_/]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => PLACE_ABBREVIATIONS[word] ?? word);
  return words.join(' ');
}

// "Hillsboro, OR" and "City": the two lines a result shows, and the label a remembered search carries.
export function placeLabel(place) {
  return place ? `${place.name}, ${place.state}` : '';
}

export function placeTypeLabel(place) {
  if (place?.type && NATIONAL_PLACE_TYPES[place.type]) return NATIONAL_PLACE_TYPES[place.type];
  return PLACE_FEATURE_CLASSES[place?.featureClass] ?? 'Place';
}

// The search definition's own precision, and the window the artifact was reduced to. Both are re-derived
// here so a test can prove the committed artifact still matches the published region and this margin rule.
export function placeSearchBounds(regionBounds, marginMiles = PLACE_MARGIN_MILES) {
  if (!Array.isArray(regionBounds) || regionBounds.length !== 4 || !regionBounds.every(Number.isFinite)) {
    throw new TypeError('A place search window needs ordered finite region bounds');
  }
  if (!Number.isFinite(marginMiles) || marginMiles <= 0) throw new TypeError('A place search window needs a positive margin');
  const latMargin = marginMiles * METRES_PER_MILE / METRES_PER_DEGREE_LAT;
  const latMin = regionBounds[1] - latMargin;
  const latMax = regionBounds[3] + latMargin;
  const referenceLat = Math.max(Math.abs(latMin), Math.abs(latMax));
  const lonMargin = marginMiles * METRES_PER_MILE / (METRES_PER_DEGREE_LON * Math.cos(referenceLat * Math.PI / 180));
  return Object.freeze({ bounds: Object.freeze([regionBounds[0] - lonMargin, latMin, regionBounds[2] + lonMargin, latMax]),
    latMarginDeg: latMargin, lonMarginDeg: lonMargin, referenceLat, marginMiles });
}

function boundsContain(bounds, center) {
  return center[0] >= bounds[0] && center[0] <= bounds[2] && center[1] >= bounds[1] && center[1] <= bounds[3];
}

// Metres from a centre to the published region rectangle, in the local frame the search's own radius
// arithmetic uses. The build keeps a place only when this is within the margin, so every place in the
// artifact can reach published coverage with a search of at most the largest radius the interface offers.
export function regionDistanceM(center, regionBounds) {
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) {
    throw new TypeError('A place distance needs a finite centre');
  }
  const lonGap = Math.max(regionBounds[0] - center[0], 0, center[0] - regionBounds[2]);
  const latGap = Math.max(regionBounds[1] - center[1], 0, center[1] - regionBounds[3]);
  return Math.hypot(lonGap * METRES_PER_DEGREE_LON * Math.cos(center[1] * Math.PI / 180),
    latGap * METRES_PER_DEGREE_LAT);
}

export function validatePlaceGazetteer(document, { region = null } = {}) {
  if (document?.kind !== PLACE_GAZETTEER_KIND || document.schemaVersion !== PLACE_GAZETTEER_SCHEMA_VERSION) {
    throw new TypeError('Not a place gazetteer document');
  }
  const source = document.source ?? {};
  for (const key of ['agency', 'dataset', 'url', 'license', 'archiveSha256', 'memberSha256']) {
    if (typeof source[key] !== 'string' || !source[key]) throw new TypeError(`The place gazetteer must declare its source ${key}`);
  }
  const scope = document.scope ?? {};
  if (!Array.isArray(scope.bounds) || scope.bounds.length !== 4 || !scope.bounds.every(Number.isFinite)
    || scope.bounds[0] >= scope.bounds[2] || scope.bounds[1] >= scope.bounds[3]) {
    throw new TypeError('The place gazetteer must declare the window it covers');
  }
  if (!Number.isFinite(scope.marginMiles) || scope.marginMiles <= 0) throw new TypeError('The place gazetteer must declare its margin');
  if (region?.bounds) {
    const expected = placeSearchBounds(region.bounds, scope.marginMiles).bounds;
    if (expected.some((value, index) => Math.abs(value - scope.bounds[index]) > 1e-6)) {
      throw new TypeError('The place gazetteer window is not the published region plus the margin it declares');
    }
  }
  const states = scope.includedStates ?? {};
  if (typeof states !== 'object' || !Object.keys(states).length) throw new TypeError('The place gazetteer must declare the states it covers');
  const classes = new Set(Object.values(scope.includedFeatureClasses ?? {}));
  if (!classes.size || [...classes].some(name => !PLACE_FEATURE_CLASSES[name])) {
    throw new TypeError('The place gazetteer declares an unsupported place class');
  }
  if (!Array.isArray(document.places) || !document.places.length) throw new TypeError('The place gazetteer carries no places');
  const ids = new Set();
  for (const place of document.places) {
    if (typeof place?.id !== 'string' || !/^[0-9]{7}$/.test(place.id) || ids.has(place.id)) {
      throw new TypeError(`Invalid place id: ${place?.id ?? 'missing'}`);
    }
    ids.add(place.id);
    if (typeof place.name !== 'string' || !place.name.trim() || place.name.length > MAX_PLACE_NAME_LENGTH) {
      throw new TypeError(`Invalid place name for ${place.id}`);
    }
    if (place.name !== place.name.trim() || / (city|town|CDP|village)$/.test(place.name)) {
      throw new TypeError(`Unnormalized place name for ${place.id}: ${place.name}`);
    }
    if (!Object.hasOwn(states, place.state) || states[place.state] !== place.stateName) {
      throw new TypeError(`Place ${place.id} names a state the document does not cover`);
    }
    if (!classes.has(place.featureClass)) throw new TypeError(`Place ${place.id} has a class the document does not cover`);
    if (!Array.isArray(place.center) || place.center.length !== 2 || !place.center.every(Number.isFinite)
      || !boundsContain(scope.bounds, place.center)) {
      throw new TypeError(`Place ${place.id} has no centre inside the declared window`);
    }
  }
  const counts = scope.counts ?? {};
  if (counts.places !== document.places.length) throw new TypeError('The place gazetteer counts do not match its places');
  return document;
}

// The index is derived once per loaded document and cached, so typing costs a scan over a few hundred
// already-normalized names and never re-reads the artifact or touches the network.
const INDEX = new WeakMap();

export function placeIndex(gazetteer) {
  const cached = INDEX.get(gazetteer);
  if (cached) return cached;
  const entries = (gazetteer?.places ?? []).map(place => {
    const normalized = normalizePlaceText(place.name);
    return Object.freeze({ place, normalized, tokens: Object.freeze(normalized.split(' ')) });
  });
  // State qualifiers are read from the document itself: no state list is hard-coded here.
  const qualifiers = new Map();
  for (const [code, name] of Object.entries(gazetteer?.scope?.includedStates ?? {})) {
    qualifiers.set(code.toLowerCase(), code);
    qualifiers.set(normalizePlaceText(name), code);
  }
  const index = Object.freeze({ entries: Object.freeze(entries), qualifiers,
    states: Object.keys(gazetteer?.scope?.includedStates ?? {}) });
  INDEX.set(gazetteer, index);
  return index;
}

// "toledo wa", "toledo, washington" and "toledo" are three queries: the first two carry a state qualifier,
// which narrows the match rather than being part of the name.
export function splitPlaceStateQualifier(query, index) {
  const tokens = String(query ?? '').split(' ').filter(Boolean);
  if (tokens.length < 2) return { text: tokens.join(' '), state: null };
  const state = index.qualifiers.get(tokens[tokens.length - 1]) ?? null;
  return state ? { text: tokens.slice(0, -1).join(' '), state } : { text: tokens.join(' '), state: null };
}

// Levenshtein distance no greater than one, computed in a band of width one: exact for a single insertion,
// deletion or substitution, and bounded so a query can never wander into a different name.
export function placeEditDistanceWithinOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  const BIG = 2;
  let previous = new Array(b.length + 1).fill(BIG);
  previous[0] = 0;
  if (b.length >= 1) previous[1] = 1;
  for (let i = 1; i <= a.length; i++) {
    const current = new Array(b.length + 1).fill(BIG);
    const from = Math.max(1, i - 1), to = Math.min(b.length, i + 1);
    for (let j = from; j <= to; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length] <= 1;
}

function fuzzyMatch(entry, text) {
  if (text.length < FUZZY_MIN_LENGTH) return false;
  if (entry.normalized[0] !== text[0]) return false; // a typo inside one name, not a different name
  return placeEditDistanceWithinOne(entry.normalized, text);
}

function byNameThenState(left, right) {
  return left.normalized.length - right.normalized.length || left.normalized.localeCompare(right.normalized)
    || left.place.state.localeCompare(right.place.state) || left.place.id.localeCompare(right.place.id);
}

const TIERS = Object.freeze([
  Object.freeze({ id: 'exact', matches: (entry, text) => entry.normalized === text,
    rank: (left, right) => left.place.state.localeCompare(right.place.state) || left.place.id.localeCompare(right.place.id) }),
  Object.freeze({ id: 'prefix', matches: (entry, text) => entry.normalized.startsWith(text), rank: byNameThenState }),
  Object.freeze({ id: 'word-prefix', matches: (entry, text) => entry.tokens.some(token => token.startsWith(text)),
    rank: byNameThenState }),
  Object.freeze({ id: 'typo', matches: fuzzyMatch,
    rank: (left, right) => (left.normalized.length - right.normalized.length) || byNameThenState(left, right) }),
]);

// One query, one answer: exact name, then prefix, then a later word, then a single bounded typo. No score is
// computed, nothing is ranked by popularity, and a query that matches nothing says so.
export function searchPlaces(gazetteer, rawQuery, { limit = MAX_PLACE_RESULTS, center = null, recentIds = null } = {}) {
  if (gazetteer?.kind === NATIONAL_LIBRARY_KIND) {
    return searchNationalPlaces(gazetteer, rawQuery, { limit, center, recentIds });
  }
  const source = typeof rawQuery === 'string' ? rawQuery.slice(0, MAX_PLACE_QUERY_LENGTH) : '';
  const query = normalizePlaceText(source);
  if (!gazetteer?.places?.length) {
    return Object.freeze({ status: 'unavailable', query, text: '', state: null, tier: null, results: Object.freeze([]),
      message: 'Place names are not available in this build.' });
  }
  if (query.length < MIN_PLACE_QUERY_LENGTH) {
    return Object.freeze({ status: 'too-short', query, text: query, state: null, tier: null, results: Object.freeze([]),
      message: `Type at least ${MIN_PLACE_QUERY_LENGTH} characters.` });
  }
  const index = placeIndex(gazetteer);
  const { text, state } = splitPlaceStateQualifier(query, index);
  if (!text || text.length < MIN_PLACE_QUERY_LENGTH) {
    return Object.freeze({ status: 'too-short', query, text, state, tier: null, results: Object.freeze([]),
      message: `Type at least ${MIN_PLACE_QUERY_LENGTH} characters of the place name.` });
  }
  const candidates = index.entries.filter(entry => !state || entry.place.state === state);
  for (const tier of TIERS) {
    const matched = candidates.filter(entry => tier.matches(entry, text));
    if (!matched.length) continue;
    const results = [...matched].sort(tier.rank).slice(0, Math.max(1, limit)).map(entry => entry.place);
    return Object.freeze({ status: 'ok', query, text, state, tier: tier.id, results: Object.freeze(results), message: null });
  }
  return Object.freeze({ status: 'none', query, text, state, tier: null, results: Object.freeze([]),
    message: 'No matching place found.' });
}

// ------------------------------------------------ nearest place (inferred context)
//
// A map-picked or typed centre usually has no name. The nearest published place is a *label* for it, and the
// wording says so: "Near Vernonia, OR", never "Vernonia, OR", because the coordinates are the search and the
// gazetteer point is a Census interior point, not the centre, not a downtown address, and not a statement
// that the centre lies inside that place.
//
// The maximum labelling distance is measured, not guessed. Against the committed artifact (387 places, median
// nearest-neighbour spacing 3.0 mi, p90 6.9 mi), a uniform grid of points inside the published region is at
// most 5.2 mi (median), 9.4 mi (p75), 14.4 mi (p90) and 24.6 mi (maximum) from its nearest place. Ten miles
// labels about 77% of in-region centres while keeping the claim modest; beyond it the interface shows
// coordinates only rather than attaching a distant town to a search.
export const MAX_NEAR_PLACE_MILES = 10;
export const MAX_NEAR_PLACE_M = MAX_NEAR_PLACE_MILES * METRES_PER_MILE;

export function nearPlaceLabel(place) {
  return place ? `Near ${placeLabel(place)}` : '';
}

// The nearest published place to a centre, with its distance, or null when the artifact is unavailable.
// A linear scan over a few hundred places: measured well under a millisecond, so no index is built.
const TIE_TOLERANCE_M = 1;

export function nearestPlace(center, gazetteer, { maxDistanceM = MAX_NEAR_PLACE_M } = {}) {
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) return null;
  if (gazetteer?.kind === NATIONAL_LIBRARY_KIND) return nearestInLibrary(center, gazetteer, maxDistanceM);
  const places = gazetteer?.places;
  if (!Array.isArray(places) || !places.length) return null;
  let distanceM = Infinity;
  for (const place of places) distanceM = Math.min(distanceM, haversineM(center, place.center));
  // Two places a metre apart are the same distance at this scale; the tie is broken deterministically (name,
  // state, id) so the same centre always produces the same label.
  const tied = places.filter(place => haversineM(center, place.center) <= distanceM + TIE_TOLERANCE_M)
    .sort(comparePlaces);
  if (!tied.length) return null;
  if (!(maxDistanceM > 0) || distanceM > maxDistanceM) return null;
  return Object.freeze({ place: tied[0], distanceM: haversineM(center, tied[0].center), label: nearPlaceLabel(tied[0]) });
}

function comparePlaces(left, right) {
  return left.name.localeCompare(right.name) || left.state.localeCompare(right.state) || left.id.localeCompare(right.id);
}

// The presentation form the search state keeps for an inferred label. It is regenerated from the gazetteer
// rather than trusted: nothing here is persisted, and a stale label can never change a search.
export function nearPlaceMetadata(near) {
  if (!near?.place) return null;
  const metadata = placeMetadata(near.place);
  if (!metadata) return null;
  return Object.freeze({ id: metadata.id, label: near.label ?? nearPlaceLabel(near.place),
    featureClass: metadata.featureClass, distanceM: Number.isFinite(near.distanceM) ? near.distanceM : null });
}

// ------------------------------------------------ presentation metadata
//
// A selected place is remembered as a label beside a search, never as the search itself: the centre and the
// radius remain the definition, and a label that goes missing costs a nicer line in the recent list, not a
// search. Nothing here is required to run discovery.
export function placeMetadata(place) {
  if (!place?.id || typeof place.name !== 'string') return null;
  return Object.freeze({ id: String(place.id), label: placeLabel(place),
    featureClass: PLACE_FEATURE_CLASSES[place.featureClass] ? place.featureClass : null });
}

export function storedPlaceMetadata(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' && /^(?:[0-9]{7}|[A-Z]:[^:]{1,64})$/.test(value.id) ? value.id : null;
  const label = typeof value.label === 'string' && value.label.trim() && value.label.length <= 80 ? value.label.trim() : null;
  if (!id || !label) return null;
  return Object.freeze({ id, label, featureClass: PLACE_FEATURE_CLASSES[value.featureClass] ? value.featureClass : null });
}

// ================================================================ the national gazetteer (schema version 2)
//
// The artifact above matches a few hundred names in one window. The national artifact is tens of thousands of
// rows, so it is a compact columnar document - one row of ten small values plus dictionaries for states,
// counties, types and sources - read through a library that can hold one tier or two.
//
// Tiers, because they have different jobs: the core tier (populated places, counties, named federal areas) is
// what an ordinary query matches, and the extended tier (postal codes, GNIS communities) is added on demand.
// Both tiers declare identical dictionaries, so merging them is index-compatible.
export const NATIONAL_PLACE_SCHEMA_VERSION = 2;
// The longest published name in the national sources is a wildlife refuge at 80 characters, so the national
// schema's bound is 96 rather than the regional artifact's 64 - and the builder refuses anything longer.
export const MAX_NATIONAL_PLACE_NAME_LENGTH = 96;
export const NATIONAL_LIBRARY_KIND = 'road-discovery-national-place-library';
export const NATIONAL_PLACE_COLUMNS = Object.freeze(['id', 'name', 'state', 'county', 'lat', 'lon', 'type',
  'population', 'prominence', 'source']);
export const NATIONAL_PLACE_TYPES = Object.freeze({
  city: 'City', town: 'Town', village: 'Village', borough: 'Borough', cdp: 'Census-designated place',
  county: 'County', zip: 'ZIP Code Tabulation Area', community: 'Community', municipality: 'Municipality',
  'national-park': 'National park', 'national-monument': 'National monument',
  'national-historic-park': 'National historic park', 'national-historic-site': 'National historic site',
  'national-battlefield': 'National battlefield', 'national-military-park': 'National military park',
  'national-memorial': 'National memorial', 'national-seashore': 'National seashore',
  'national-lakeshore': 'National lakeshore', 'national-recreation-area': 'National recreation area',
  'national-preserve': 'National preserve', 'national-parkway': 'National parkway',
  'national-scenic-trail': 'National scenic trail', 'wild-and-scenic-river': 'Wild and scenic river',
  'national-scenic-river': 'National scenic river', 'national-forest': 'National forest',
  'national-grassland': 'National grassland', 'national-wilderness': 'National wilderness area',
  'national-conservation-area': 'National conservation area',
  'national-wildlife-refuge': 'National wildlife refuge',
  'wildlife-management-area': 'Wildlife management area', 'waterfowl-production-area': 'Waterfowl production area',
  'research-natural-area': 'Research natural area', 'coordinated-area': 'Coordinated area',
});
// What a result's second line says. It must always disambiguate and never repeat the first line, so a county
// names the kind of division it is, a postal code names its state (and county when one is known), and a
// protected area names what it is rather than a county it may straddle.
export function placeDetail(place) {
  if (!place) return '';
  if (place.type === 'county') return / (County|Parish)$/.test(place.name) ? place.name.split(' ').slice(-1)[0] : 'County';
  if (place.type === 'zip') return place.county ? `${place.stateName} · ${place.county}` : place.stateName;
  if (place.county) return place.county;
  return NATIONAL_PLACE_TYPES[place.type] ?? 'Place';
}


export function validateNationalPlaceGazetteer(document) {
  if (document?.kind !== PLACE_GAZETTEER_KIND || document.schemaVersion !== NATIONAL_PLACE_SCHEMA_VERSION) {
    throw new TypeError('Not a national place gazetteer document');
  }
  const tables = document.dictionaries ?? {};
  if (!Array.isArray(tables.states) || !Array.isArray(tables.stateNames)
    || tables.states.length !== tables.stateNames.length || !tables.states.length
    || !Array.isArray(tables.types) || !tables.types.length || !Array.isArray(tables.sources)
    || !tables.sources.length || !Array.isArray(tables.counties)) {
    throw new TypeError('The national gazetteer declares no dictionaries');
  }
  if (!Array.isArray(document.columns) || document.columns.length !== NATIONAL_PLACE_COLUMNS.length
    || document.columns.some((column, index) => column !== NATIONAL_PLACE_COLUMNS[index])) {
    throw new TypeError('The national gazetteer declares an unexpected column order');
  }
  if (!Array.isArray(document.rows) || !document.rows.length) throw new TypeError('The national gazetteer carries no rows');
  const scope = document.scope ?? {};
  if (!Array.isArray(scope.bounds) || scope.bounds.length !== 4 || !scope.bounds.every(Number.isFinite)) {
    throw new TypeError('The national gazetteer declares no coverage');
  }
  const ids = new Set();
  for (const row of document.rows) {
    if (!Array.isArray(row) || row.length !== NATIONAL_PLACE_COLUMNS.length) {
      throw new TypeError('A national gazetteer row is not the declared width');
    }
    if (typeof row[0] !== 'string' || !/^[A-Z]:[^:]{1,64}$/.test(row[0]) || ids.has(row[0])) {
      throw new TypeError(`Invalid national place id: ${String(row[0]).slice(0, 40)}`);
    }
    ids.add(row[0]);
    if (typeof row[1] !== 'string' || !row[1].trim() || row[1].length > MAX_NATIONAL_PLACE_NAME_LENGTH) {
      throw new TypeError(`Invalid national place name for ${row[0]}`);
    }
    if (!Number.isSafeInteger(row[2]) || !tables.states[row[2]]) throw new TypeError(`Place ${row[0]} names no state`);
    if (!Number.isSafeInteger(row[3]) || row[3] < -1 || row[3] >= tables.counties.length) {
      throw new TypeError(`Place ${row[0]} names no county dictionary entry`);
    }
    if (!Number.isFinite(row[4]) || !Number.isFinite(row[5]) || row[4] < -90 || row[4] > 90
      || row[5] < -180 || row[5] > 180) throw new TypeError(`Place ${row[0]} has no coordinate`);
    if (!Number.isSafeInteger(row[6]) || !tables.types[row[6]]) throw new TypeError(`Place ${row[0]} names no type`);
    if (!tables.sources[row[9]]) throw new TypeError(`Place ${row[0]} names no source`);
  }
  return document;
}

// The library: every loaded tier, decoded once into the shapes the search, the labels and the reverse lookup
// need. The columnar arrays are released as they are read, so one tier costs one representation, not two.
export function createPlaceLibrary(initial = []) {
  const entries = [];
  const byId = new Map();
  const byZip = new Map();
  const qualifiers = new Map();
  const tiers = new Set();
  const sources = new Map();
  let tables = null;
  let cells = null;
  let loadedMs = 0;

  function add(document) {
    const started = Date.now();
    const validated = validateNationalPlaceGazetteer(document);
    const local = validated.dictionaries;
    if (tables && JSON.stringify(tables) !== JSON.stringify(local)) {
      throw new TypeError('A national gazetteer tier declares different dictionaries from the loaded one');
    }
    tables = local;
    for (const row of validated.rows) {
      if (byId.has(row[0])) continue;
      const type = local.types[row[6]];
      const place = Object.freeze({ id: row[0], name: row[1], state: local.states[row[2]],
        stateName: local.stateNames[row[2]], county: row[3] < 0 ? null : local.counties[row[3]],
        center: Object.freeze([row[5], row[4]]), type, population: row[7] < 0 ? null : row[7],
        prominence: row[8], source: local.sources[row[9]],
        featureClass: Object.hasOwn(PLACE_FEATURE_CLASSES, type) ? type : null });
      byId.set(place.id, place);
      const normalized = normalizePlaceText(place.name);
      entries.push({ place, normalized });
      if (type === 'zip') byZip.set(place.name, place);
    }
    for (let index = 0; index < local.states.length; index += 1) {
      qualifiers.set(local.states[index].toLowerCase(), local.states[index]);
      qualifiers.set(normalizePlaceText(local.stateNames[index]), local.states[index]);
    }
    loadedMs += Date.now() - started;
    if (validated.scope?.tier) tiers.add(validated.scope.tier);
    // The provenance a reader can see: every source the loaded tiers were built from, named once.
    for (const [key, source] of Object.entries(validated.sources ?? {})) if (!sources.has(key)) sources.set(key, source);
    cells = null;
    return validated;
  }
  for (const document of initial) add(document);

  return Object.freeze({
    kind: NATIONAL_LIBRARY_KIND, schemaVersion: NATIONAL_PLACE_SCHEMA_VERSION,
    get size() { return entries.length; },
    get entries() { return entries; },
    get places() { return entries.map(entry => entry.place); },
    get byId() { return byId; },
    get byZip() { return byZip; },
    get qualifiers() { return qualifiers; },
    get nearCells() { if (!cells) cells = buildNearCells(entries); return cells; },
    get tiers() { return [...tiers]; },
    get sources() { return Object.fromEntries(sources); },
    loadedMs: () => loadedMs,
    has: id => byId.has(id),
    hasTier: tier => tiers.has(tier),
    add,
  });
}

// A half-degree grid over the core places, so labelling a map-picked centre is nine small buckets rather than a
// scan of forty thousand haversines. Half a degree is at least 36 km everywhere in the conterminous states,
// comfortably more than the ten-mile label radius, so the nine-cell neighbourhood always contains the answer.
const NEAR_CELL_DEGREES = 0.5;

export function buildNearCells(entries) {
  const cells = new Map();
  for (const entry of entries) {
    const key = `${Math.floor(entry.place.center[0] / NEAR_CELL_DEGREES)}|${Math.floor(entry.place.center[1] / NEAR_CELL_DEGREES)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(entry); else cells.set(key, [entry]);
  }
  return cells;
}


// ---------------------------------------------------------------- the national query and its tiers

export const NATIONAL_PLACE_TIERS = Object.freeze(['zip', 'exact', 'prefix', 'token-prefix', 'typo']);

// A query is a name with an optional trailing state qualifier, or a postal code. Parsing is total and
// deterministic, and a qualifier is only taken when something remains to search for - so "new york" is a place,
// not a state with an empty name.
export function parsePlaceQuery(rawQuery, qualifiers = null) {
  const source = typeof rawQuery === 'string' ? rawQuery.slice(0, MAX_PLACE_QUERY_LENGTH) : '';
  const normalized = normalizePlaceText(source);
  const tokens = normalized.split(' ').filter(Boolean);
  if (qualifiers?.size) {
    for (const size of [3, 2, 1]) {
      if (tokens.length <= size) continue;
      const code = qualifiers.get(tokens.slice(-size).join(' '));
      if (!code) continue;
      const rest = tokens.slice(0, -size).join(' ');
      if (rest.length < MIN_PLACE_QUERY_LENGTH) continue;
      return finishPlaceQuery(rest, code, normalized);
    }
  }
  return finishPlaceQuery(normalized, null, normalized);
}

function finishPlaceQuery(text, state, normalized) {
  if (/^[0-9]{5}$/.test(text)) return Object.freeze({ text: '', state, zip: text, normalized });
  return Object.freeze({ text, state, zip: null, normalized });
}

// The four name tiers, in the order a person expects them, as a number so one pass can keep the best tier.
// "A later word starts with the text" is a substring test on the normalized name - every word after the first
// is preceded by a space - so no per-entry token array is needed, which is what keeps a 170,000-row library
// cheap to hold and fast to scan.
function nationalTier(entry, text) {
  if (entry.normalized === text) return 0;
  if (entry.normalized.startsWith(text)) return 1;
  if (entry.normalized.includes(` ${text}`)) return 2;
  return fuzzyMatch(entry, text) ? 3 : -1;
}

export function searchNationalPlaces(library, rawQuery, { limit = MAX_PLACE_RESULTS, center = null,
  recentIds = null } = {}) {
  const query = parsePlaceQuery(rawQuery, library.qualifiers);
  if (!library.size) {
    return Object.freeze({ status: 'unavailable', query: query.normalized, text: '', state: null, tier: null,
      results: Object.freeze([]), message: 'Place names are not available in this build.' });
  }
  if (query.zip) {
    const place = library.byZip.get(query.zip);
    return place
      ? Object.freeze({ status: 'ok', query: query.normalized, text: query.zip, state: query.state, tier: 'zip',
        results: Object.freeze([place]), message: null })
      : Object.freeze({ status: 'none', query: query.normalized, text: query.zip, state: query.state, tier: null,
        results: Object.freeze([]),
        message: `No ZIP Code Tabulation Area ${query.zip} is published in the conterminous United States.` });
  }
  if (query.text.length < MIN_PLACE_QUERY_LENGTH) {
    return Object.freeze({ status: 'too-short', query: query.normalized, text: query.text, state: query.state,
      tier: null, results: Object.freeze([]),
      message: `Type at least ${MIN_PLACE_QUERY_LENGTH} characters of a place name or a five-digit ZIP code.` });
  }
  // One pass over the candidates keeps every entry of the best tier that matched, so the ranking below never
  // has to rescan for a worse tier.
  let tier = Number.POSITIVE_INFINITY;
  let matched = [];
  for (const entry of library.entries) {
    if (query.state && entry.place.state !== query.state) continue;
    const found = nationalTier(entry, query.text);
    if (found < 0) continue;
    if (found < tier) { tier = found; matched = [entry]; } else if (found === tier) matched.push(entry);
  }
  if (!matched.length) {
    return Object.freeze({ status: 'none', query: query.normalized, text: query.text, state: query.state, tier: null,
      results: Object.freeze([]),
      message: `No place matching "${query.text}"${query.state ? ` in ${query.state}` : ''} is published in the `
        + 'conterminous United States.' });
  }
  const recent = recentIds?.length ? new Set(recentIds) : null;
  const scored = matched.map(entry => ({ entry, distance: center ? haversineM(center, entry.place.center) : null }));
  scored.sort((left, right) => compareNational(left, right, { center, recent }));
  return Object.freeze({ status: 'ok', query: query.normalized, text: query.text, state: query.state,
    tier: NATIONAL_PLACE_TIERS[tier + 1],
    results: Object.freeze(scored.slice(0, Math.max(1, limit)).map(item => item.entry.place)), message: null });
}


// Deterministic ordering inside one tier: an administrative division yields to a place, then how many people live
// there, then a place this device chose recently, then how close it is to the centre already on screen, then the
// shorter and therefore more likely name, then the name, the state and the id. Two runs on the same input always
// produce the same list.
//
// A county is last within its tier on purpose. A county is a division rather than a place, so a bare name that is
// both means the place: "Yellowstone" is the national park, not the Montana county, and "Orange" is the city, not
// the 3.2-million-person county. Nothing is lost: typing the division's own word ("orange county", "gibson county
// indiana") matches it exactly and is unaffected by this, and a county that does not match exactly is still
// offered on the next line.
function countyRank(place) {
  return place.type === 'county' ? 1 : 0;
}

function compareNational(left, right, { center, recent }) {
  const byKind = countyRank(left.entry.place) - countyRank(right.entry.place);
  if (byKind) return byKind;
  const byPopulation = (right.entry.place.population ?? -1) - (left.entry.place.population ?? -1);
  if (byPopulation) return byPopulation;
  if (recent) {
    const difference = (recent.has(right.entry.place.id) ? 1 : 0) - (recent.has(left.entry.place.id) ? 1 : 0);
    if (difference) return difference;
  }
  if (center) {
    const byDistance = left.distance - right.distance;
    if (byDistance) return byDistance;
  }
  return (right.entry.place.prominence - left.entry.place.prominence)
    || (left.entry.place.name.length - right.entry.place.name.length)
    || left.entry.place.name.localeCompare(right.entry.place.name)
    || left.entry.place.state.localeCompare(right.entry.place.state)
    || left.entry.place.id.localeCompare(right.entry.place.id);
}

// Neighbouring cells hold every place within the label radius, so the reverse lookup is nine buckets rather
// than forty thousand haversines.
function nearestInLibrary(center, library, maxDistanceM) {
  const cells = library.nearCells;
  const keyX = Math.floor(center[0] / NEAR_CELL_DEGREES);
  const keyY = Math.floor(center[1] / NEAR_CELL_DEGREES);
  let bestDistance = Infinity;
  let best = null;
  const consider = place => {
    const distance = haversineM(center, place.center);
    if (distance < bestDistance - TIE_TOLERANCE_M) { bestDistance = distance; best = place; return; }
    if (Math.abs(distance - bestDistance) <= TIE_TOLERANCE_M && (!best || comparePlaces(place, best) < 0)) {
      bestDistance = Math.min(bestDistance, distance);
      best = place;
    }
  };
  for (let x = keyX - 1; x <= keyX + 1; x += 1) {
    for (let y = keyY - 1; y <= keyY + 1; y += 1) {
      for (const entry of cells.get(`${x}|${y}`) ?? []) consider(entry.place);
    }
  }
  if (!best || !(maxDistanceM > 0) || bestDistance > maxDistanceM) return null;
  return Object.freeze({ place: best, distanceM: bestDistance, label: nearPlaceLabel(best) });
}

