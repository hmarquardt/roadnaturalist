import { COVERAGE, COVERAGE_DATASET, setCandidateCoverage } from '../domain/corridor.js';
import { createStore } from '../state/store.js';
import { createCorridorMap } from '../map/corridor-map.js';
import { ACCESS_FINDING_LABELS, renderCandidates, renderDetail, renderContext } from '../ui/render.js';
import { loadManifest } from '../services/manifest.js';
import { createGisService } from '../gis/service.js';
import { summarizeEcoregions } from '../ecology/context.js';
import { summarizeHabitat } from '../habitat/context.js';
import { buildPilotCandidates, pilotRoadIds, roadSourceLabel, validatePilot } from '../roads/pilot.js';
import { roadEvidenceSummary } from '../roads/road.js';
import { createOccurrenceService } from '../occurrence/service.js';
import { COVERAGE_DATASETS, summarizeOccurrences } from '../occurrence/context.js';
import { createInvestigatorService } from '../investigator/service.js';
import { RETRIEVAL_MODE, createWorkerResearchTransport, probeAvailability, retrievalModeCounts } from '../investigator/worker-transport.js';
import { buildProbeBaseline, baselineIndex, compareProbeEvidence, summarizeDrift } from '../investigator/drift.js';
import { INVESTIGATOR_WORKER_URL } from './config.js';
import { createResearchService, createRecordedTransport, createLiveResearchTransport } from '../investigator/research.js';
import { BROWSER_MIRRORS, createOsmSource, createRecordedOsmSource } from '../investigator/osm.js';
import { PILOT_PROBES_BY_CORRIDOR } from '../investigator/sources.js';
import { buildCorridorBundle } from '../investigator/bundle.js';
import { runDiscovery } from '../discovery/run.js';
import { verifyDerivedPromotion } from '../discovery/promotion.js';
import { buildDiscoveryUnits } from '../discovery/units.js';
import { segmentUnit } from '../discovery/segment.js';
import { eligibleClasses } from '../discovery/eligibility.js';
import { ANALYSIS_DISTANCES_M } from '../gis/habitat-result.js';
import { renderDiscovery, eligibilityNote } from '../ui/discovery.js';
import { renderSavedRoads } from '../ui/saved-roads.js';
import { renderOutings } from '../ui/outings.js';
import { comparisonIds, savedCounts } from '../state/saved-roads.js';
import { readDiscoveryMarks, readDiscoverySearch, readDiscoverySearchHistory, writeDiscoveryMarks,
  writeDiscoverySearch, writeDiscoverySearchHistory } from '../discovery/persistence.js';
import { DISCOVERY_STATUS, applyMarks, markDiscovery, promoteDerivedCandidate, promoteDiscoveryResult } from '../discovery/lifecycle.js';
import { createEvidenceRequests, detailLevelFor, evidenceLabel, sourceEvidence, unavailableMessage } from '../discovery/evidence.js';
import { SOURCE_EVIDENCE_TIMEOUT_MS, createSourceEvidenceRun, runSourceEvidence } from '../discovery/source-evidence-run.js';
import { identityStagePayload } from '../discovery/identity-evidence.js';
import { defaultSearchArea, searchAreaBounds, validateSearchAreas } from '../discovery/search-area.js';
import { CUSTOM_SEARCH_AREA_ID, addSearchHistory, areaCoverage, createInteractiveSearchArea,
  definitionFromSearchArea, formatRadius, initialSearchSelection, interactiveSearchTemplate, placeForSearch, radiusPresets,
  readSearchDefinition, searchDefinitionOf, searchIsRunnable, searchRefusal, searchRegionCoverage, withSearchQuery } from '../discovery/search-definition.js';
import { createPlaceLibrary, placeMetadata, validateNationalPlaceGazetteer } from '../discovery/place-gazetteer.js';
import { globalEcoregionPlane, globalPlaneReady, rawAvailability, rawAvailabilityMessage, validateRawRegionsIndex }
  from '../discovery/raw-catalog.js';
import { nearestPlace } from '../discovery/place-gazetteer.js';
import { centerPresentation, formatContextDirection, pendingSearchContext, runCenterPresentation, storedSearchContext } from '../discovery/search-context.js';
import { filterAndSort } from '../discovery/filter.js';
import { MAX_RESULT_ROWS } from '../discovery/constants.js';
import { LOCATION_STATUS, createLocationProvider, createLocationRequest, locationSearchDefinition, locationStatusMessage } from '../discovery/geolocation.js';

const PILOT_URL = new URL('../../data/roads/or-roads-pilot.json', import.meta.url);
// Declared discovery search areas. The loader refuses an area that is not inside every dataset it
// requires, so the workspace can never offer a survey the loaded data cannot cover.
const SEARCH_AREAS_URL = new URL('../../data/discovery/search-areas.json', import.meta.url);
// The national place gazetteer: three versioned tiers, read by need rather than all at once.
//
//   * `core` - populated places, counties and named federal areas: loaded in the background at start-up.
//   * `postal` - ZIP Code Tabulation Areas: fetched the first time a query is a five-digit code.
//   * `community` - the communities a Census place file does not carry (GNIS populated places): fetched the
//     first time the core tier cannot answer, with a stated "searching wider" state.
//
// Measured on the committed artifacts: the core tier is 2.4 MB of JSON (884 KB compressed), about 96 ms to parse
// and index, and about 19 MB of heap; postal codes add 40 ms and 18 MB; communities add 175 ms and 65 MB. That
// is why the last two are fetched only when a query needs them, and why the UI yields a frame before the largest
// one, so the field can say what it is doing instead of appearing to freeze. It is local, deterministic and
// private: no geocoding service is contacted and nothing leaves the page.
const PLACE_TIER_URL = Object.freeze({
  core: new URL('../../data/places/national-places.json', import.meta.url),
  postal: new URL('../../data/places/national-places-zip.json', import.meta.url),
  community: new URL('../../data/places/national-places-communities.json', import.meta.url),
});
// The core tier's download starts here, at import time, so it overlaps the manifest and declaration fetches:
// the workspace waits for the slowest of them rather than for their sum.
const placeCoreRequest = fetchJson(PLACE_TIER_URL.core).then(document => validateNationalPlaceGazetteer(document));
let placeLibrary = null;
const placeTierLoads = new Map();

// A tier is fetched at most once; a second request while the first is in flight waits for the same promise.
function ensurePlaceTier(tier) {
  if (!placeLibrary || placeLibrary.hasTier(tier)) return Promise.resolve(false);
  if (placeTierLoads.has(tier)) return placeTierLoads.get(tier);
  const load = (async () => {
    try {
      placeLibrary.add(validateNationalPlaceGazetteer(await fetchJson(PLACE_TIER_URL[tier])));
      return true;
    } catch (error) {
      if (!store.getState().search.error) store.setSearchError(`Some place names are unavailable: ${error.message}`);
      return false;
    } finally {
      placeTierLoads.delete(tier);
    }
  })();
  placeTierLoads.set(tier, load);
  return load;
}
// The reviewed operator capture of official-source research, replayed offline. The browser cannot crawl county
// sites (they send no CORS header) and must not depend on a live Overpass mirror, so it replays this record and
// offers a live OpenStreetMap re-check as an explicit, separate action.
const ACCESS_EVIDENCE_URL = new URL('../../data/investigator/or-pilot-access-evidence.json', import.meta.url);
// Origins a browser cannot fetch: recorded evidence for them is replayed as OPERATOR_ONLY, never as a fresh check.
const OPERATOR_ONLY_ORIGINS = Object.freeze(['https://www.washingtoncountyor.gov', 'https://content.govdelivery.com', 'https://multco.us', 'https://www.wc-roads.com']);
const store = createStore();
// The browser's location is one more way to say where the search is centred. The provider is the only place the
// geolocation API is touched, and the request token makes the latest deliberate centre selection win.
const locationProvider = createLocationProvider();
const locationRequest = createLocationRequest();
export const gis = createGisService();
// Occurrence evidence is lazy (queried only when the user asks), and the browser never holds an
// eBird credential: its transport stays null so the source reports UNKNOWN with a clear reason.
export const occurrence = createOccurrenceService({
  inaturalistTransport: defaultInaturalistTransport,
  ebirdTransport: null,
  measureDistances: (corridor, points) => gis.measureOccurrenceDistances(corridor, points),
});

async function defaultInaturalistTransport(url, { timeoutMs = 20000, headers = {} } = {}) {
  return fetch(url, {
    headers: { ...headers, Accept: 'application/json' },
    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
  });
}
const map = createCorridorMap(document.getElementById('map'), { onSelect: id => store.select(id),
  onPickCoordinate: center => selectSearchCenter(center) });
const nodes = {
  list: document.getElementById('candidate-list'), detail: document.getElementById('candidate-detail'),
  context: document.getElementById('data-context'), count: document.getElementById('candidate-count'),
  caption: document.getElementById('map-caption'), fit: document.getElementById('fit-map'),
  load: document.getElementById('load-pilot'), overlayNote: document.getElementById('habitat-layers-note'),
  discovery: document.getElementById('discovery'), discoveryCount: document.getElementById('discovery-count'),
  savedRoads: document.getElementById('saved-roads'), savedCount: document.getElementById('saved-count'),
  outings: document.getElementById('outings'), outingCount: document.getElementById('outing-count'),
};
let manifest = null;
let manifestError = null;
let searchAreas = [];
let publishedRegion = null;
let declaredRadiusPresets = [];
let radiusSearchTemplate = null;
let places = null;
const drawn = { corridors: [], selectedId: null, overlay: null, occurrenceOverlay: null, resolvedId: null,
  savedRoads: null, savedMeta: null, savedDurable: null, savedStorage: null, savedEcology: null, savedHabitat: null,
  savedOutingSelection: null, savedOutings: null,
  outings: null, outingStorage: null, outingSelection: null, selectedOuting: null,
  discoveryNodes: null, discoverySignature: null, searchKey: null };

function activeSearch() { return store.getState().search; }

// DISCOVERY WORKSPACE. Discovery reads only the bounded road-network extract and the bounded habitat and
// ecoregion extracts through the GIS service: it never calls an occurrence API and never calls the
// Investigator Worker or Overpass. Deeper evidence starts when a person promotes a corridor.
async function loadSearchAreas() {
  const declaration = validateSearchAreas(await fetchJson(SEARCH_AREAS_URL), manifest);
  searchAreas = [...declaration.searchAreas];
  // A search is classified against the region its discovery catalog actually covers. That is the national region
  // once the national derived plane is the production discovery payload, so a centre anywhere in the conterminous
  // United States is runnable rather than refused as "outside the published region".
  publishedRegion = declaration.discoveryRegion ?? declaration.publishedRegion ?? null;
  declaredRadiusPresets = [...radiusPresets(declaration)];
  radiusSearchTemplate = interactiveSearchTemplate(declaration);
  // Precedence is explicit and testable: a URL search, then the search this device last chose, then a
  // committed preset while the declared window stays the active search. Nothing here runs a search.
  const initial = initialSearchSelection({ search: globalThis.location?.search ?? '',
    stored: readDiscoverySearch(), history: readDiscoverySearchHistory(), presets: declaredRadiusPresets,
    declaredAreaId: searchAreas[0]?.id ?? null, region: publishedRegion });
  // The place list is loaded *before* the first panel render, so the workspace appears complete instead of
  // being rebuilt a moment later: a rebuild would replace whatever a fast reader had already typed.
  await loadPlaces();
  // A search this device ran before carries its place label beside its coordinates, so a reload shows
  // "Hillsboro, OR · 25 mi" when it can and coordinates when it cannot.
  const remembered = placeForSearch(initial.history, initial.selection.definition);
  store.setSearchHistory(initial.history);
  store.setSearchSelection({ ...initial.selection, place: remembered,
    // A restored centre is labelled from the gazetteer the same way a picked one is: the URL and the stored
    // definition carry coordinates only, and the label is derived here.
    near: nearestPlace(initial.selection.definition?.center, places) });
  if (initial.problems.length) {
    store.setSearchError('The search parameters in this link were ignored: '
      + initial.problems.map(entry => entry.message).join(' '));
  }
  return searchAreas;
}

// The national gazetteer's core tier, validated and indexed once. A missing or inconsistent artifact costs the
// place-name field (the panel says so) and nothing else: coordinates remain the search.
async function loadPlaces() {
  try {
    placeLibrary = createPlaceLibrary([await placeCoreRequest]);
    places = placeLibrary;
  } catch (error) {
    placeLibrary = null;
    places = null;
    if (!store.getState().search.error) store.setSearchError(`Place names are unavailable: ${error.message}`);
  }
  return places;
}

// The search area a run would survey. A declared window and a custom centre are two values of one field, and
// both end up as an ordinary search area for the same derived discovery pipeline.
function resolveActiveSearchArea() {
  const search = activeSearch();
  if (search.areaId !== CUSTOM_SEARCH_AREA_ID) {
    const area = searchAreas.find(entry => entry.id === search.areaId) ?? defaultSearchArea({ searchAreas });
    if (!area) return { error: 'No discovery search area is declared in this build.' };
    return { area, coverage: areaCoverage(area, publishedRegion) };
  }
  const definition = search.definition;
  if (!definition) return { error: 'Choose a search centre and radius before searching.' };
  const coverage = searchRegionCoverage(definition, publishedRegion);
  if (!searchIsRunnable({ ok: true, coverage })) return { error: coverage.reason, coverage };
  try {
    return { area: createInteractiveSearchArea(definition, { template: radiusSearchTemplate }), coverage };
  } catch (error) {
    return { error: error.message, coverage };
  }
}

async function discoverRoads() {
  const state = store.getState();
  const resolved = resolveActiveSearchArea();
  const marks = state.discovery.marks ?? readDiscoveryMarks();
  if (resolved.error) {
    store.failDiscovery({ error: resolved.error, marks, coverage: resolved.coverage ?? null,
      searchArea: resolved.area ?? state.discovery.searchArea ?? null });
    return;
  }
  const searchArea = resolved.area;
  store.startDiscovery(searchArea, marks);
  try {
    const run = await runDiscovery({ gis, searchArea, marks, onProgress: phase => store.setDiscoveryPhase(phase) });
    if (run.status !== 'ready') {
      store.failDiscovery({ coverage: run.coverage, searchArea, marks,
        error: `${run.roadQuery.reason ?? run.roadQuery.note ?? 'The road-network extract could not be read.'} A failed query is not an empty search area.` });
      return;
    }
    store.finishDiscovery({ results: run.results, coverage: run.coverage, diagnostics: run.diagnostics,
      eligibility: run.eligibility, raw: { ...run.raw, provenance: run.roadQuery.provenance }, searchArea, marks });
    rememberSearch(run.searchArea);
  } catch (error) {
    store.failDiscovery({ searchArea, marks, error: error.message,
      coverage: { coverage: error.coverage ?? COVERAGE.UNKNOWN, reason: error.message, counts: {} } });
  }
}

// ------------------------------------------------------------------ the search definition
//
// One path in, four ways to produce it: the map, the coordinate fields, a preset or a recent search, and a
// shared URL. Whichever produced it, the definition is validated here, the URL is updated so the search is
// shareable, and the search is remembered on this device.

// One path into the store, so what the store holds is always a definition this build validated: the bounds
// and the metre radius are re-derived from the centre and radius here rather than trusted from the caller. A
// definition assembled by spreading an older one (a changed radius on a stale box) cannot reach the run.
//
// The nearest published place is looked up here, for every centre, and kept beside the definition as an
// inferred label. It never moves the centre: the coordinates stay exact, the URL stays coordinate-based, and
// the label is presence only.
function applySearchDefinition(definition, { picking = false, place = null, location = null } = {}) {
  const result = readSearchDefinition({ lat: definition?.center?.[1], lon: definition?.center?.[0],
    radiusMiles: definition?.radiusMiles }, { region: publishedRegion });
  if (!result.ok) {
    store.setSearchError(result.problems.map(entry => entry.message).join(' '));
    return null;
  }
  const clean = result.definition;
  const near = nearestPlace(clean.center, places);
  // A deliberate centre change cancels a location request still in flight: the person's newer choice wins over a
  // fix that arrives afterwards. Changing only the radius leaves that request alone, because the centre stands.
  const previous = activeSearch().definition;
  if (!previous || previous.center[0] !== clean.center[0] || previous.center[1] !== clean.center[1]) locationRequest.invalidate();
  store.setSearchError(null);
  store.setSearchDefinition(clean, { picking, place, near, location });
  store.setSearchHistory(writeDiscoverySearchHistory(addSearchHistory(activeSearch().history, clean, { place })));
  writeSearchUrl(clean);
  return clean;
}

// USE MY LOCATION. The browser's position is another centre, so it takes the ordinary path: a validated
// definition at the radius already on screen, the local gazetteer for a label, the existing coverage preview,
// and no search. `locationRequest` makes the latest deliberate choice win, so a fix that arrives after someone
// picked a place, clicked the map or typed coordinates is discarded instead of overwriting them.
async function useMyLocation() {
  const token = locationRequest.begin();
  store.setSearchLocation({ status: LOCATION_STATUS.REQUESTING });
  const fix = await locationProvider.request();
  if (!locationRequest.isCurrent(token)) return; // a newer centre selection won while the browser was looking
  if (!fix.ok) { store.setSearchLocation({ status: fix.status, message: fix.message ?? locationStatusMessage(fix.status) }); return; }
  const current = activeSearch().definition;
  const result = locationSearchDefinition(fix, { radiusMiles: current?.radiusMiles ?? undefined, region: publishedRegion });
  if (!result.ok) {
    store.setSearchLocation({ status: LOCATION_STATUS.REFUSED, message: searchRefusal(result), accuracyM: fix.accuracyM });
    return;
  }
  applySearchDefinition(result.definition, { location: { status: LOCATION_STATUS.OK, message: null, accuracyM: fix.accuracyM } });
}

// Choosing a place sets the centre and leaves the radius exactly as it was: the place answers "where", the
// radius control keeps answering "how far", and nothing here starts a search.
function selectPlace(selected) {
  const current = activeSearch().definition;
  const result = readSearchDefinition({ lat: selected.center[1], lon: selected.center[0],
    radiusMiles: current?.radiusMiles ?? undefined }, { region: publishedRegion });
  if (!result.ok) { store.setSearchError(result.problems.map(entry => entry.message).join(' ')); return; }
  applySearchDefinition(result.definition, { place: placeMetadata(selected) });
}

function selectSearchCenter(center) {
  const current = activeSearch().definition;
  const result = readSearchDefinition({ lat: center[1], lon: center[0],
    radiusMiles: current?.radiusMiles ?? undefined }, { region: publishedRegion });
  if (!result.ok) { store.setSearchError(result.problems.map(entry => entry.message).join(' ')); return; }
  applySearchDefinition(result.definition);
}

// Only a search that can actually run is remembered as "the last search" on this device; a definition that
// does not overlap the published coverage stays visible in the controls and in the URL until it is changed.
function rememberSearch(searchArea) {
  if (searchArea?.kind !== 'radius' || !Array.isArray(searchArea.center)) return;
  const result = readSearchDefinition({ lat: searchArea.center[1], lon: searchArea.center[0],
    radiusMiles: searchArea.radiusMiles }, { region: publishedRegion });
  if (!result.ok) return;
  const coverage = searchRegionCoverage(result.definition, publishedRegion);
  if (!searchIsRunnable({ ok: true, coverage })) return;
  writeDiscoverySearch(result.definition);
  store.setSearchHistory(writeDiscoverySearchHistory(addSearchHistory(activeSearch().history, result.definition,
    { place: activeSearch().place })));
}

function writeSearchUrl(definition) {
  const location = globalThis.location;
  if (!location || typeof globalThis.history?.replaceState !== 'function') return;
  const query = withSearchQuery(location.search, definition);
  globalThis.history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

// The map preview is a view of the current draft, never an input to analysis: it shows where the centre and
// the requested radius are, and which part of that reaches published coverage.
function searchPreview(state) {
  const active = resolveActiveSearchArea();
  const area = active.area ?? null;
  const definition = area ? definitionFromSearchArea(area) : (state.search.definition ?? null);
  const bounds = area ? searchAreaBounds(area) : (definition?.bounds ?? null);
  const coverage = active.coverage ?? null;
  const radius = area?.kind === 'radius' && definition;
  // The label is the same presentation every surface uses: an explicitly chosen place, otherwise the nearest
  // published place, otherwise the coordinates that are the search.
  const presentation = centerPresentation({ place: state.search.place, near: state.search.near,
    center: radius ? definition.center : null });
  const status = `${coverage?.coverage ?? COVERAGE.UNKNOWN}`;
  return { kind: radius ? 'radius' : 'bbox', center: radius ? definition.center : null,
    radiusMiles: definition?.radiusMiles ?? null, bounds,
    coverage: coverage?.coverage ?? COVERAGE.UNKNOWN, regionBounds: publishedRegion?.bounds ?? null,
    label: radius ? `${formatRadius(definition.radiusMiles)} · ${status} · ${presentation.label}`
      : area ? `${area.name} · ${status}` : null };
}

function updateSearchPreview(state) {
  const preview = searchPreview(state);
  const key = [preview.kind, preview.center?.join(','), preview.radiusMiles, preview.coverage,
    preview.bounds?.join(','), preview.regionBounds?.join(','), preview.label, state.search.picking].join('|');
  if (drawn.searchKey === key) return;
  drawn.searchKey = key;
  map.setSearchPreview(preview.bounds ? preview : null);
  map.setPickMode(state.search.picking);
}


// The published raw regions: a small committed index that says which raw cells are online, so a promotion can
// answer "is the raw source for this corridor here?" from the index alone, before fetching anything. The regions
// themselves are immutable catalogs on R2, validated by the same contract the regional reader already uses.
const RAW_REGIONS_URL = new URL('../../data/national/raw-regions.json', import.meta.url);
let rawRegions = null;
let rawRegionsAttempted = false;

async function loadRawRegions() {
  if (rawRegionsAttempted) return rawRegions;
  rawRegionsAttempted = true;
  try {
    rawRegions = validateRawRegionsIndex(await fetchJson(RAW_REGIONS_URL));
  } catch {
    // No index (or an index that does not validate) is a state, not a failure: discovery is unaffected, and the
    // promotion below says which raw source is missing rather than crashing on a document nobody published yet.
    rawRegions = null;
  }
  return rawRegions;
}

// What the published raw regions say about this corridor: available, or exactly which cells are missing. The
// answer comes from the committed index alone - no catalog, no object, no probe - so refusal is instant and named.
async function rawAvailabilityFor(bounds) {
  const index = await loadRawRegions();
  return index ? rawAvailability(index, { bounds })
    : { region: null, available: false, missing: null, required: null };
}

// Promotion reuses the ordinary road/candidate builders, so a discovered corridor becomes a normal
// candidate: same detail pipeline, same evidence workflow, and no Investigator probe entry required.
// A precomputed corridor is an index, not evidence. Promotion rebuilds it from the published *raw* partitions of
// the bounded region the corridor falls in and checks the id and the geometry before the corridor is allowed to
// become a candidate; a corridor whose raw source is not published is refused with what is missing, and one that
// cannot be reconstructed is refused instead of being analysed from precomputed geometry.
async function reconstructDerivedCorridor(result) {
  const state = store.getState();
  const entry = state.discovery.raw?.corridors?.find(item => item.corridor?.id === result.id) ?? null;
  if (!entry) throw new Error('the precomputed row is no longer loaded');
  const bounds = entry.corridor.bounds;
  // Raw detail reads the *published raw region* the corridor falls in, not the national derived pointer: the
  // derived plane is the discovery payload and carries no raw cells at all. A corridor outside every published
  // region is a state the person is told about, never a measured corridor. The catalog URL travels with the
  // candidate so the detailed panel reads the same region later.
  const availability = await rawAvailabilityFor(bounds);
  if (!availability.available) {
    const error = new Error(rawAvailabilityMessage(availability));
    error.rawUnavailable = true;
    error.missingCells = availability.missing ?? null;
    throw error;
  }
  const region = availability.region;
  // A raw catalog is a data-origin document: the index says where it is served from, so the reader never assumes
  // the page's own origin. Its cells are resolved against the same origin by the catalog's own assetBaseUrl.
  const catalogUrl = new URL(region.catalogUrl, region.assetBaseUrl).href;
  // Roads are nationally published, so the reader reads them from the plane's own namespace instead of the bounded
  // region's: the region is then only what it now is - the wetlands and hydrography of the places people explore.
  // The two global raw planes, declared once by the published index rather than by this bounded region: roads are
  // read from the national plane, and the whole-CONUS ecoregion layers are read from theirs. Wetlands and
  // hydrography remain bounded, and the region is what it now is - those two planes, where people explore.
  const rawIndex = await loadRawRegions() ?? { kind: '', schemaVersion: 0, planes: [], regions: [] };
  const globalRoads = globalPlaneReady(rawIndex, 'roads');
  const globalEcoregions = globalEcoregionPlane(rawIndex);
  // The corridor's own road component, named: the closure then follows exactly the road this corridor belongs to
  // instead of every road that happens to touch its box, which is what makes the rebuild both small and the same
  // composition the derived row came from.
  const scope = await gis.prepareRegionalSearch({ bbox: bounds, catalogUrl, catalogType: 'raw',
    rawRegionId: region.id, distancesM: ANALYSIS_DISTANCES_M, globalRoads, globalEcoregions,
    roadComponentIds: entry.corridor.componentId ? [entry.corridor.componentId] : null }, {});
  const road = await scope.queryRoadNetwork({ bbox: bounds, roadClasses: eligibleClasses(), limit: 100000 });
  evidenceStage('roads:query', { id: result.id, globalRoads: Boolean(scope.selection?.globalRoads),
    cells: scope.selection?.partitions?.roads?.length ?? null, features: road.features?.length ?? null,
    coverage: road.coverage, components: scope.selection?.globalRoadsComponents ?? null });
  if (road.coverage !== COVERAGE.FULL && road.coverage !== COVERAGE.PARTIAL) {
    throw new Error('the raw road network could not be read back');
  }
  let verified;
  try {
    verified = verifyDerivedPromotion({ derived: entry.corridor, features: road.features,
      sourceFeatureIds: result.road?.sourceFeatureIds ?? entry.corridor.sourceFeatureIds ?? null,
      segmentIndex: result.road?.segmentation?.index ?? entry.corridor.segmentIndex ?? null,
      segmentCount: result.road?.segmentation?.count ?? entry.corridor.segmentCount ?? null });
  } catch (error) {
    // The verifier names what it could not match, including the closest composed units, when the evidence flag is
    // on; here it is only recorded that the road stage failed, with the counts that make the failure legible.
    evidenceStage('roads:verify-failed', { id: result.id, name: entry.corridor.name ?? null,
      wantedId: entry.corridor.id, wantedFeatures: (result.road?.sourceFeatureIds ?? entry.corridor.sourceFeatureIds ?? []).length,
      features: road.features?.length ?? null, error: error.message });
    throw new Error(`${error.message} - this corridor's road needs raw source cells that the published region does `
      + 'not hold, so it cannot be rebuilt here yet. National discovery is unaffected.');
  }
  // The identity pair this run proved: the build id the row carries, the id the windowed composition gave the same
  // road, and the evidence that they are the same corridor. Only counts and booleans travel; the release artefact
  // records these and never a source-id array.
  const identity = Object.freeze({ corridorName: entry.corridor.name ?? null, derivedId: verified.derivedId,
    reconstructedId: verified.corridor.id, sourceFeatureCount: verified.sourceFeatureIds.length,
    segmentIndex: Number(result.road?.segmentation?.index ?? entry.corridor.segmentIndex ?? 1),
    segmentCount: Number(result.road?.segmentation?.count ?? entry.corridor.segmentCount ?? 1),
    geometryDriftM: verified.drift });
  return { unit: verified.unit, corridor: verified.corridor, features: verified.features,
    dataCatalogUrl: catalogUrl, identity, scope };
}

// The search context a promotion carries: the run's own centre, how that centre was named, the run's radius, and
// the measured relationship between the centre and the corridor that was chosen. It is read from the *run* (its
// centre, its radius) rather than from the draft controls, so promoting a result after the centre has moved
// still describes the search that produced it. No centre (a declared box search) means no context.
function promotionSearchContext(result) {
  const state = store.getState();
  const area = state.discovery.searchArea ?? null;
  const center = area?.kind === 'radius' ? area.center : null;
  if (!Array.isArray(center) || result.distanceFromCenterM == null) return null;
  const presentation = runCenterPresentation({ center, place: state.search.place, near: state.search.near,
    definitionCenter: state.search.definition?.center ?? null, gazetteer: places });
  return pendingSearchContext({ center, radiusMiles: area.radiusMiles ?? null,
    centerLabel: presentation?.label ?? null, centerLabelKind: presentation?.kind ?? null, placeId: presentation?.placeId ?? null,
    distanceFromCenterM: result.distanceFromCenterM, nearestCenterPoint: result.nearestCenterPoint,
    bearingFromCenterDeg: result.bearingFromCenterDeg, cardinalFromCenter: result.cardinalFromCenter });
}

async function promoteDiscoveryCorridor(id) {
  const state = store.getState();
  const result = state.discovery.results.find(entry => entry.id === id);
  if (!result) return;
  const searchContext = promotionSearchContext(result);
  store.clearDiscoveryPromotion();
  try {
    // Both promotion paths are wrapped the same way: a reconstruction or search-context verification that fails
    // creates no candidate and says why, rather than publishing a candidate whose geometry or orientation
    // cannot be reproduced.
    const candidate = result.derived
      ? await promoteDerivedResult(result, searchContext, state)
      : promoteRawResult(result, searchContext, state);
    store.promoteDiscoveryCandidate(candidate, id);
    writeDiscoveryMarks(store.getState().discovery.marks);
    nodes.list.scrollIntoView({ block: 'nearest' });
  } catch (error) {
    // A missing raw source is not a failed reconstruction: the corridor was never read, and the person is told
    // exactly what has not been published rather than that the data disagreed with itself.
    store.noteDiscoveryPromotion(id, error.rawUnavailable ? error.message
      : `the corridor could not be reconstructed from the published data (${error.message})`);
  }
}

// LEVEL 1. A promotion opens the corridor's precomputed metrics: the row the discovery run already loaded, its
// geometry as the national build composed it, and no raw cell fetched. This succeeds wherever the derived plane is
// published - everywhere discovery runs - so a corridor is never unopenable merely because its wetland or
// hydrography cells have not been published. What the panel shows is labelled as precomputed, because that is what
// it is; the source-backed level is the separate action below.
async function promoteDerivedResult(result, searchContext, state) {
  const entry = state.discovery.raw?.corridors?.find(item => item.corridor?.id === result.id) ?? null;
  if (!entry) throw new Error('the precomputed row is no longer loaded');
  const availability = await rawAvailabilityFor(entry.corridor.bounds);
  // The availability answer is the committed index's, not a probe: one small document, already cached, and no raw
  // object is read to produce it.
  return promoteDerivedCandidate(result, { corridor: entry.corridor, derived: derivedMetricsFor(result),
    derivedVersion: state.discovery.raw?.provenance?.regionVersion ?? null,
    dataCatalogUrl: availability.available ? new URL(availability.region.catalogUrl, availability.region.assetBaseUrl).href : null,
    searchContext, provenance: state.discovery.raw?.provenance ?? null,
    sourceEvidence: { status: availability.available ? 'available' : 'unavailable',
      message: availability.available ? null : rawAvailabilityMessage(availability),
      missing: availability.missing ?? null } });
}

// The derived metrics exactly as the plane stores them, kept on the candidate so the panel renders stored values
// rather than recomputing anything in the browser.
function derivedMetricsFor(result) {
  return Object.freeze({ road: result.road ?? null, ecology: result.ecology ?? null,
    wetlands: result.signals?.wetlands ?? null, hydrography: result.signals?.hydrography ?? null,
    coverage: result.coverage ?? null });
}

// LEVEL 2, and only ever on an explicit request. The corridor is rebuilt from the published raw road network and
// verified against the row, then read against the published raw wetland and hydrography cells. If the row cannot be
// reproduced, the derived candidate stays exactly as it was and the failure is reported as the source step's
// status - never as a lost corridor.
//
// A request always ends. Every stage is named, every rejection is caught and mapped to a terminal status, and the
// whole operation is bounded by a timeout, because a panel that says "loading" forever is worse than one that says
// the source step failed: it hides the failure and cannot be retried. The stage markers are silent unless
// `globalThis.__RN_DEBUG_EVIDENCE` is set, which is how a test or a developer watches the path without leaving
// noise in production.
function evidenceStage(stage, detail = {}) {
  if (!globalThis.__RN_DEBUG_EVIDENCE) return;
  console.log(`sourceEvidence:${stage} ` + JSON.stringify({ at: Date.now(), ...detail }));
}

// One request per candidate, identified by a token: a completion that belongs to a corridor the person has since
// left must not overwrite the corridor they are looking at.
const sourceEvidenceRequests = createEvidenceRequests();

async function requestSourceEvidence(id) {
  const state = store.getState();
  const result = state.discovery.results.find(entry => entry.id === id);
  if (!result) return;
  const candidate = () => store.getState().candidates.find(item => item.id === id) ?? null;
  const current = candidate();
  if (!current) return;
  if (current.sourceEvidence?.status === 'loading') { evidenceStage('ignored:already-loading', { id }); return; }
  if (current.sourceEvidence?.status === 'ready') { evidenceStage('ignored:already-source', { id }); return; }

  // THE RUN OWNS THIS CORRIDOR UNTIL IT IS CLOSED, EXACTLY ONCE.
  //
  // The request token names the current request and the run carries the timeout, the signal and the terminal state,
  // so a request that has timed out, been superseded, or already finished cannot write anything afterwards - not a
  // status, not an ecology or habitat result, and never an identity record as though it had succeeded. Work that
  // cannot be aborted (a DuckDB query in a browser) is allowed to finish internally; its result is discarded.
  const mine = sourceEvidenceRequests.begin(id);
  const run = createSourceEvidenceRun({ id, isOwner: mine });
  const writeStatus = (sourceEvidence) => {
    if (!candidate()) return false;
    store.promoteDiscoveryCandidate({ ...candidate(), sourceEvidence }, id);
    evidenceStage('render', { id, status: sourceEvidence.status });
    return true;
  };
  const writeCandidate = (promoted) => {
    if (!candidate()) return false;
    store.promoteDiscoveryCandidate(promoted, id);
    evidenceStage('render', { id, status: 'ready' });
    return true;
  };
  const promote = (planes, built) => promoteDiscoveryResult(result, { features: built.features,
    corridor: built.corridor, searchContext: promotionSearchContext(result),
    provenance: state.discovery.raw?.provenance ?? null, dataCatalogUrl: built.dataCatalogUrl,
    derived: current.derived, derivedVersion: state.discovery.raw?.provenance?.regionVersion ?? null,
    evidenceLevels: sourceEvidenceLevels(planes),
    sourceEvidence: { status: 'ready', message: null, missing: null } });
  const steps = {
    corridorName: result.name,
    loading: () => writeStatus({ ...current.sourceEvidence, status: 'loading', message: null, missing: null }),
    reconstruct: async () => {
      evidenceStage('roads:start', { id });
      return reconstructDerivedCorridor(result);
    },
    promote: (planes, built) => writeCandidate(promote(planes, built)),
    ecology: async (built) => {
      evidenceStage('ecology:start', { id });
      await resolveEcology(id, built?.scope ?? null, run);
      evidenceStage('ecology:done', { id });
      return true;
    },
    habitat: async (built) => {
      evidenceStage('habitat:start', { id });
      await resolveHabitat(id, built?.scope ?? null, run);
      evidenceStage('habitat:done', { id });
      return true;
    },
    // The run posts again with the levels its reads earned: a plane that was re-read says so, and a plane that came
    // back "not published" keeps saying precomputed, so a partially source-backed corridor reads as partly source.
    levels: () => ({ roads: true, ecology: true, ...habitatReadPlanes(id) }),
    identity: (built) => {
      const levels = steps.levels();
      evidenceStage('levels', { id, ...levels });
      evidenceStage('identity', identityStagePayload({ identity: built.identity,
        evidenceLevel: evidenceLabel(detailLevelFor(sourceEvidenceLevels(levels))) }));
      return true;
    },
    terminal: async ({ error, unavailable }) => {
      // The one sentence a person reads when the deeper level is not published: the same vocabulary the panel and
      // the tests agree on, with the bounded planes counted and roads never named (roads are published nationally).
      const bounded = Object.fromEntries(Object.entries(error?.missingCells ?? {})
        .filter(([plane]) => plane !== 'roads'));
      writeStatus({ status: unavailable ? 'unavailable' : 'failed',
        message: unavailable ? unavailableMessage(bounded)
          : `Source-level evidence could not be loaded. ${error?.sourceTimeout ? error.message + '. ' : ''}The precomputed corridor metrics above remain available.`,
        missing: error?.missingCells ?? null });
    },
  };
  // A timeout is a terminal outcome of this run, so the run itself writes the terminal state - the panel must never
  // sit on "loading" - and no stage that finishes later may touch the corridor again.
  run.onClose(async (closed) => {
    if (closed !== 'timeout') return;
    evidenceStage('timeout', { id, ms: SOURCE_EVIDENCE_TIMEOUT_MS() });
    await steps.terminal({ error: Object.assign(new Error(`source evidence took longer than ${SOURCE_EVIDENCE_TIMEOUT_MS() / 1000} s`),
      { sourceTimeout: true }) });
  });
  try {
    const outcome = await runSourceEvidence({ run, steps, onStage: evidenceStage });
    if (outcome === 'ready') evidenceStage('complete', { id });
  } finally {
    sourceEvidenceRequests.finish(id, mine);
  }
}

// Which planes a source run actually read. A plane it did not cover stays precomputed, so a partially
// source-backed corridor is representable without pretending the other planes were re-read.
function sourceEvidenceLevels({ roads = false, ecology = false, wetlands = false, hydrography = false } = {}) {
  return sourceEvidence({ roads, ecology, wetlands, hydrography });
}

// Which bounded planes a habitat read actually came from. A read that fell back to "not published" leaves its plane
// precomputed, and that is what the panel keeps saying for it.
function habitatReadPlanes(id) {
  const habitat = store.getState().habitatByCandidate[id] ?? null;
  const sourced = (datasetId) => [COVERAGE.FULL, COVERAGE.PARTIAL].includes(habitat?.coverage?.[datasetId]);
  return { wetlands: sourced(COVERAGE_DATASET.WETLANDS), hydrography: sourced(COVERAGE_DATASET.HYDROGRAPHY) };
}

async function requestSourceEvidenceForSelected() {
  const state = store.getState();
  if (state.selectedId) await requestSourceEvidence(state.selectedId);
}


function promoteRawResult(result, searchContext, state) {
  // The corridor object carries the canonical geometry of the row the person selected; the candidate is
  // built from it so the detailed panel measures the corridor that was promoted, not the whole road group.
  const corridor = state.discovery.raw?.corridors?.find(entry => entry.corridor?.id === result.id)?.corridor ?? null;
  return promoteDiscoveryResult(result, { features: state.discovery.raw?.features ?? [], corridor, searchContext,
    provenance: state.discovery.raw?.provenance ?? null, dataCatalogUrl: state.discovery.searchArea?.catalogUrl ?? null });
}

function markDiscoveryCorridor(id, status) {
  const state = store.getState();
  const current = state.discovery.results.find(entry => entry.id === id);
  if (!current) return;
  const next = status ?? (current.status === DISCOVERY_STATUS.DISMISSED ? DISCOVERY_STATUS.DISCOVERED : DISCOVERY_STATUS.DISMISSED);
  store.setDiscoveryMarks(writeDiscoveryMarks(markDiscovery(state.discovery.marks, id, next)));
}

// The explicit run behind the restored candidate's panel: the same two analyses a newly selected corridor gets,
// asked for by a person instead of by boot.
async function runCandidateAnalysis(id) {
  if (!id) return;
  try {
    await resolveEcology(id);
    await resolveHabitat(id);
  } catch (error) {
    store.setRoadQuery({ ...store.getState().roadQuery, reason: error.message });
  }
}

// Both reads take an optional prepared publication scope. The CONUS ecology layers and the bounded wetland and
// hydrography cells are published on the data origin, so a reader without one asks the page's own origin for them
// and collects a 404 for a file the application never served; the prepared scope carries the publication's asset
// base, which is why the habitat read has always been given one.
async function resolveEcology(id, service = null, run = null) {
  const state = store.getState();
  if (state.ecologyByCandidate[id]) return;
  const candidate = state.candidates.find(item => item.id === id);
  if (!candidate) return;
  // Ownership is checked at every write, not only around the whole call: a source run that has timed out must not
  // leave an ecology result - or a coverage row - behind for a corridor the panel has already declared failed.
  const owns = () => !run || run.isCurrent();
  if (!owns()) { evidenceStage('discarded', { id, step: 'ecology' }); return; }
  store.setEcologyResult(id, { coverage: COVERAGE.UNKNOWN, diagnostics: { status: 'loading', reason: 'Resolving EPA ecoregions…' } });
  const index = await loadRawRegions() ?? { kind: '', schemaVersion: 0, planes: [], regions: [] };
  // Ecology is a global plane, so the declaration travels with the read whether or not this corridor has a prepared
  // raw scope: a scope keeps its own (it was prepared against a publication), and a bare read is given the index's
  // declaration. Either way the CONUS layers are read from the origin the index names, never from the page's own.
  const reader = service ?? gis;
  const globalEcoregions = globalEcoregionPlane(index);
  const ecology = summarizeEcoregions(await reader.getEcoregions(candidate.geometry, { globalEcoregions }));
  if (!owns()) { evidenceStage('discarded:late', { id, step: 'ecology' }); return; }
  store.setEcologyResult(id, ecology);
  for (const [datasetId, level] of [[COVERAGE_DATASET.EPA_LEVEL3, ecology.level3], [COVERAGE_DATASET.EPA_LEVEL4, ecology.level4]]) {
    if (!owns()) { evidenceStage('discarded:late', { id, step: 'ecology-coverage' }); return; }
    store.setCoverage(id, datasetId, { coverage: level?.coverage ?? COVERAGE.UNKNOWN, reason: ecology.diagnostics?.status === 'partial' ? ecology.diagnostics.reason : null });
  }
}

async function resolveHabitat(id, service = null, run = null) {
  const state = store.getState();
  if (state.habitatByCandidate[id]) return;
  const candidate = state.candidates.find(item => item.id === id);
  if (!candidate) return;
  const owns = () => !run || run.isCurrent();
  if (!owns()) { evidenceStage('discarded', { id, step: 'habitat' }); return; }
  store.setHabitatResult(id, { diagnostics: { status: 'loading', reason: 'Analyzing wetlands and hydrography…' } });
  let habitat;
  try {
    const habitatService = service ?? (candidate.dataCatalogUrl
      ? await gis.prepareRegionalSearch({ bbox: candidate.corridor.bounds, catalogUrl: candidate.dataCatalogUrl }) : gis);
    habitat = summarizeHabitat(await habitatService.getHabitatContext(candidate.geometry));
  } catch (error) {
    habitat = summarizeHabitat({ wetlands: { coverage: error.coverage ?? COVERAGE.UNKNOWN, reason: error.message },
      hydrography: { coverage: error.coverage ?? COVERAGE.UNKNOWN, reason: error.message },
      diagnostics: { status: 'unavailable', reason: error.message } });
  }
  if (!owns()) { evidenceStage('discarded:late', { id, step: 'habitat' }); return; }
  store.setHabitatResult(id, habitat);
  for (const [datasetId, coverage] of Object.entries(habitat.coverage)) {
    if (!owns()) { evidenceStage('discarded:late', { id, step: 'habitat-coverage' }); return; }
    store.setCoverage(id, datasetId, { coverage, reason: habitatReason(habitat, datasetId) });
  }
}

function habitatReason(habitat, datasetId) {
  const block = datasetId === COVERAGE_DATASET.WETLANDS ? habitat.wetlands : habitat.hydrography;
  return block?.reason ?? block?.note ?? null;
}

async function toggleHabitatOverlay(enabled) {
  const state = store.getState();
  const candidate = state.candidates.find(item => item.id === state.selectedId);
  if (!enabled || !candidate) { store.setHabitatOverlay(null); return; }
  let overlay;
  try {
    const habitatService = candidate.dataCatalogUrl
      ? await gis.prepareRegionalSearch({ bbox: candidate.corridor.bounds, catalogUrl: candidate.dataCatalogUrl }) : gis;
    overlay = await habitatService.getHabitatOverlay(candidate.geometry);
  } catch (error) {
    overlay = { bufferGeometry: null, features: [], diagnostics: { status: 'unavailable', reason: error.message } };
  }
  store.setHabitatOverlay({ ...overlay, candidateId: candidate.id });
}

// Occurrence evidence is requested explicitly: no public biodiversity API is called during load or
// on a corridor switch, so the road, ecology, and habitat panels never wait on external services.
async function resolveOccurrence(id, { refresh = false } = {}) {
  const state = store.getState();
  const candidate = state.candidates.find(item => item.id === id);
  if (!candidate) return;
  if (state.occurrenceByCandidate[id]?.kind && !refresh) return;
  store.setOccurrenceResult(id, { diagnostics: { status: 'loading', reason: 'Querying public occurrence sources…' } });
  const evidence = summarizeOccurrences(await occurrence.analyze(candidate.geometry));
  store.setOccurrenceResult(id, evidence);
  for (const [datasetId, coverage] of Object.entries(evidence.coverage)) {
    store.setCoverage(id, datasetId, { coverage, reason: occurrenceCoverageReason(evidence, datasetId) });
  }
  if (store.getState().occurrenceOverlay) await toggleOccurrenceOverlay(true);
}

function occurrenceCoverageReason(evidence, datasetId) {
  const entry = Object.entries(COVERAGE_DATASETS).find(([, id]) => id === datasetId);
  if (!entry) return null; // the aggregate `occurrence` row keeps the source rows' reasons instead
  const summary = evidence.sources[entry[0]];
  return summary?.reason ?? summary?.note ?? null;
}

// Only precise public observations may become map points; obscured, approximate, and unavailable
// locations never reach the map, and the layer is bounded.
async function toggleOccurrenceOverlay(enabled) {
  const state = store.getState();
  const candidate = state.candidates.find(item => item.id === state.selectedId);
  const evidence = candidate ? state.occurrenceByCandidate[candidate.id] : null;
  if (!enabled || !candidate || !evidence?.sources) { store.setOccurrenceOverlay(null); return; }
  // The domain already filtered these to precise public observations; the cap keeps the layer bounded.
  const points = Object.values(evidence.sources).flatMap(summary => summary.points ?? [])
    .slice(0, OCCURRENCE_MAP_LIMIT)
    .map(point => ({ source: point.source, sourceRecordId: point.sourceRecordId, label: point.label,
      group: point.taxonomicGroup, coordinates: point.location, distanceToCorridorM: point.distanceToCorridorM }));
  store.setOccurrenceOverlay({ candidateId: candidate.id, points, excluded: Object.values(evidence.sources)
    .reduce((total, summary) => total + (summary.regionalOnlyObservations ?? 0), 0) });
}


// ACCESS INVESTIGATION. Explicitly requested, like occurrence evidence: nothing is fetched on load or on a
// corridor switch. Official sources replay the reviewed operator capture; OpenStreetMap is replayed from that
// capture by default and queried live only when the reader asks for it.
let accessRecord = null;
let accessRecordError = null;
async function loadAccessRecord() {
  if (accessRecord || accessRecordError) return accessRecord;
  try { accessRecord = await fetchJson(ACCESS_EVIDENCE_URL); } catch (error) { accessRecordError = error.message; }
  return accessRecord;
}

// LIVE VS RECORDED. The browser cannot read a county site that sends no CORS header, so live official-source
// research goes through the Road Naturalist Worker boundary when this build is configured with one. The choice is
// made by asking the boundary what it declares (no source is contacted), and whichever path runs is recorded in the
// result so nothing reads as a fresh check when it was a replay.
async function chooseResearchPath(candidateId) {
  const probes = PILOT_PROBES_BY_CORRIDOR[candidateId] ?? [];
  const corridorRecord = accessRecord?.corridors?.[candidateId] ?? null;
  const recordedRun = corridorRecord ? { ...corridorRecord, capturedAt: accessRecord.capturedAt ?? null } : null;
  const recordedProbes = (corridorRecord?.probes ?? []).map(probe => buildProbeBaseline(probe.probeId, { capturedAt: accessRecord?.capturedAt ?? null,
    outcome: probe.outcome ?? null, facts: probe.evidence ?? [], sourceUrl: probe.searched?.url ?? null }));
  let availability = { available: false, reason: 'no investigator Worker is configured for this build', worker: null, probeIds: [] };
  if (INVESTIGATOR_WORKER_URL) availability = await probeAvailability({ baseUrl: INVESTIGATOR_WORKER_URL, fetchImpl: fetch });
  if (INVESTIGATOR_WORKER_URL) store.setWorkerStatus(Object.freeze({ url: INVESTIGATOR_WORKER_URL, available: availability.available,
    reason: availability.reason, worker: availability.worker ?? null, probeIds: Object.freeze([...(availability.probeIds ?? [])]), checkedAt: new Date().toISOString() }));
  const live = INVESTIGATOR_WORKER_URL && availability.available;
  return { probes, recordedRun, recordedProbes, availability, live,
    transport: live ? createWorkerResearchTransport({ baseUrl: INVESTIGATOR_WORKER_URL, fetchImpl: fetch, recordedProbes })
      : createRecordedTransport({ record: recordedRun, browserOrigins: OPERATOR_ONLY_ORIGINS }),
    environment: live ? 'browser/live Worker boundary' : 'browser/recorded operator run' };
}

function investigatorFor(candidateId, { liveOsm = false, path }) {
  const research = createResearchService({ transport: path.transport, probes: path.probes });
  return createInvestigatorService({ osmSource: osmSourceFor(candidateId, liveOsm), research, probes: path.probes,
    record: path.recordedRun, environment: `${path.environment}${liveOsm ? ' + live OpenStreetMap' : ''}` });
}

// A recorded capture can still carry the source comparison when the live facts come from the Worker: the transport
// already compares live facts against the capture, so the UI can show both kinds of drift.
function previousRunSummary(prior, next) {
  if (!prior?.access) return null;
  const summary = next?.access?.coverage?.probeSummary ?? {};
  const lost = (summary.failed ?? 0) + (summary.deferred ?? 0);
  const changed = prior.access.finding !== next?.access?.finding;
  if (!lost && !changed) return null;
  return Object.freeze({ finding: prior.access.finding, ruleId: prior.access.ruleId ?? null, checkedAsOf: prior.access.checkedAsOf ?? null,
    evidenceCheckedAt: prior.access.evidenceCheckedAt ?? null, coverage: prior.access.coverage?.coverage ?? null, transport: prior.transport ?? null,
    reason: lost ? `${lost} source(s) in the new run did not answer` : 'the new run changed the finding',
    humanFinding: prior.access.human?.finding ?? null });
}

function driftSummaryOf(investigation) {
  const states = investigation.research.probes.map(probe => ({ worker: probe.drift?.worker?.state ?? null, recorded: probe.drift?.recorded?.state ?? null }));
  const changed = states.filter(entry => [entry.worker, entry.recorded].some(state => state === 'EVIDENCE_CHANGED' || state === 'NO_LONGER_MATCHES'));
  const unavailable = states.filter(entry => [entry.worker, entry.recorded].some(state => state === 'SOURCE_UNAVAILABLE'));
  return Object.freeze({ changed: changed.length, unavailable: unavailable.length, states: Object.freeze(states),
    note: changed.length ? `${changed.length} source(s) differ from the reviewed baseline; open the investigation record for the facts involved.`
      : 'No source differs from the reviewed baseline.' });
}

function osmSourceFor(candidateId, liveOsm) {
  return liveOsm ? createOsmSource({ mirrors: BROWSER_MIRRORS, requireCors: true }) : createRecordedOsmSource({ record: accessRecord, corridorId: candidateId });
}

// One investigation run. The path is chosen first (Worker boundary or reviewed capture), and the result records which
// path produced each source's answer. If a live run cannot reach a single source while a reviewed capture exists, the
// capture is replayed and the fallback is recorded rather than silently swapped in.
async function resolveAccess(id, { refresh = false, liveOsm = false } = {}) {
  const state = store.getState();
  const candidate = state.candidates.find(item => item.id === id);
  if (!candidate) return;
  if (state.investigationByCandidate[id] && !refresh) return;
  await loadAccessRecord();
  const roads = state.roadsByCandidate[id] ?? [];
  const prior = state.investigationByCandidate[id] ?? null;
  const path = await chooseResearchPath(id);
  const evidence = { ecology: state.ecologyByCandidate[id] ?? null, habitat: state.habitatByCandidate[id] ?? null,
    occurrence: state.occurrenceByCandidate[id] ?? null };
  let investigation = await investigatorFor(id, { liveOsm, path }).investigate({ candidate, roads, evidence });
  let fallback = null;
  if (path.live && (investigation.access?.coverage?.probeSummary?.answered ?? 0) === 0 && path.recordedRun) {
    // The boundary is unreachable for every source, and a reviewed capture exists: replay it, and say so.
    const recordedPath = { ...path, live: false, transport: createRecordedTransport({ record: path.recordedRun, browserOrigins: OPERATOR_ONLY_ORIGINS }),
      environment: 'browser/recorded operator run (live Worker unreachable)' };
    const replayed = await investigatorFor(id, { liveOsm, path: recordedPath }).investigate({ candidate, roads, evidence });
    fallback = Object.freeze({ from: path.transport.id, to: recordedPath.transport.id,
      reason: `no source answered through the Worker boundary (${path.availability.reason ?? 'unavailable'})`, attemptedAt: investigation.ranAt });
    investigation = Object.freeze({ ...replayed, transportFallback: fallback });
  }
  const previousRun = previousRunSummary(prior, investigation);
  const drift = driftSummaryOf(investigation);
  const modes = retrievalModeCounts(investigation.research.probes);
  store.setInvestigationResult(id, Object.freeze({ ...investigation,
    access: Object.freeze({ ...investigation.access, previousRun, driftSummary: drift, retrievalModes: modes }) }));
  store.setCoverage(id, COVERAGE_DATASET.ACCESS_VERIFICATION, { coverage: investigation.access.coverage.coverage, reason: investigation.access.coverage.reason });
  return Object.freeze({ investigation, previousRun, drift, modes, fallback });
}

function reportAccessNote(message) { const node = document.getElementById('access-note'); if (node) node.textContent = message; }

function requestAccess({ refresh = true, liveOsm = false } = {}) {
  const selected = store.getState().selectedId;
  if (!selected) return;
  reportAccessNote('Running the staged access investigation…');
  resolveAccess(selected, { refresh, liveOsm })
    .then(result => { if (result) reportAccessNote(accessNoteFor(result)); })
    .catch(error => reportAccessNote(error.message));
}

// What the reader should know after a run: which path was used, what coverage that reached, whether a source changed,
// and whether an earlier finding was kept beside this one.
function accessNoteFor({ investigation, drift, modes, previousRun, fallback }) {
  const access = investigation.access;
  const parts = [`Access evidence: ${modes.summary} through ${investigation.transport}.`];
  parts.push(`Coverage ${access.coverage.coverage}.`);
  if (drift.changed) parts.push(drift.note);
  if (fallback) parts.push(`The Worker boundary could not be reached, so the reviewed capture was replayed (${fallback.reason}).`);
  if (previousRun) parts.push(`The previous finding (${ACCESS_FINDING_LABELS[previousRun.finding] ?? previousRun.finding}, ${String(previousRun.checkedAsOf ?? '').slice(0, 10)}) is kept beside this run: ${previousRun.reason}.`);
  if (access.human?.finding) parts.push(`Your recorded human finding (${ACCESS_FINDING_LABELS[access.human.finding] ?? access.human.finding}) still stands beside the automated one.`);
  parts.push('A failed source is reported as a failure, never as "no restriction found".');
  return parts.join(' ');
}

// A human finding is stored beside the automated one. Neither replaces the other.
function recordAccessReview({ candidateId, finding, annotation }) {
  const selected = candidateId ?? store.getState().selectedId;
  if (!selected) return;
  if (!finding && !annotation) { store.setAccessReview(selected, null); return; }
  store.setAccessReview(selected, Object.freeze({ finding: finding ?? null, annotation: annotation ?? null, decidedAt: new Date().toISOString(),
    automatedFinding: store.getState().investigationByCandidate[selected]?.access?.finding ?? null }));
}

// EXPORT. The bundle is JSON, versioned, and carries summaries and provenance only.
async function exportBundle(candidateId = null) {
  const state = store.getState();
  const candidate = state.candidates.find(item => item.id === (candidateId ?? state.selectedId));
  if (!candidate) return;
  await loadAccessRecord();
  const investigation = state.investigationByCandidate[candidate.id] ?? null;
  const review = state.accessReviewByCandidate[candidate.id] ?? null;
  const bundle = buildCorridorBundle({
    candidate, roads: state.roadsByCandidate[candidate.id] ?? [], ecology: state.ecologyByCandidate[candidate.id] ?? null,
    habitat: state.habitatByCandidate[candidate.id] ?? null, occurrence: state.occurrenceByCandidate[candidate.id] ?? null,
    investigation: investigation && review ? { ...investigation, access: { ...investigation.access, human: review } } : investigation,
  });
  const text = `${JSON.stringify(bundle, null, 2)}
`;
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${candidate.id}-evidence-bundle.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  reportAccessNote(`Exported ${(text.length / 1024).toFixed(1)} kB evidence bundle for ${candidate.name}.`);
}

const OCCURRENCE_MAP_LIMIT = 300;

function corridorDescriptors(state) {
  return state.candidates.map(candidate => {
    const roads = state.roadsByCandidate[candidate.id] ?? [];
    // Where the corridor was found, for a candidate that came out of a radius search: the map draws the search
    // centre and the nearest point of the selected corridor so the orientation in the panel is visible.
    const context = storedSearchContext(candidate.searchContext);
    return { id: candidate.id, name: candidate.name, geometry: candidate.geometry,
      searchCenter: context?.center ?? null, nearestCenterPoint: context?.nearestCenterPoint ?? null,
      badge: roads.length ? badgeText(roads) : 'CORRIDOR GEOMETRY UNAVAILABLE' };
  });
}

function badgeText(roads) {
  const evidence = roadEvidenceSummary(roads);
  const vintage = roads[0].provenance.vintage ?? roads[0].provenance.datasetVersion ?? 'source';
  return `${String(vintage).toUpperCase()} · ${evidence.geometry.label} · ${evidence.access.label}`;
}

function caption(state) {
  const selected = state.candidates.find(candidate => candidate.id === state.selectedId);
  if (!selected) return 'Select a corridor to see its mapped geometry. Geometry is evidence, not an invented route.';
  const roads = state.roadsByCandidate[selected.id] ?? [];
  const parts = [`${(selected.corridor.lengthM / 1609.344).toFixed(1)} mi`, roads.length ? roadSourceLabel(roads) : 'road source unavailable'];
  if (selected.corridor.maxUnresolvedGapM) parts.push(`${Math.round(selected.corridor.maxUnresolvedGapM)} m source gap shown, not bridged`);
  return `${parts.join(' · ')} · no basemap; ecological context is listed in the evidence panel.`;
}

// OUTING NOTES use the same debounce as candidate notes: a plan's prose is written once a person pauses, not on
// every keystroke, and the panel says where the note actually is.
const outingNoteTimers = new Map();
function saveOutingNotes(id, value, { immediate = false } = {}) {
  if (!id) return;
  clearTimeout(outingNoteTimers.get(id));
  if (immediate) { outingNoteTimers.delete(id); store.updateOuting(id, { notes: value }); return; }
  outingNoteTimers.set(id, setTimeout(() => { outingNoteTimers.delete(id); store.updateOuting(id, { notes: value }); }, NOTE_DEBOUNCE_MS));
}

// The outings panel is rebuilt only when the plans, the selection or the roads they point at change.
function renderOutingsPanel(state) {
  if (drawn.outings === state.outings && drawn.outingStorage === state.outingStorage
    && drawn.outingSelection === state.outingSelection && drawn.selectedOuting === state.selectedOutingId
    && drawn.outingRoads === state.userMetaById && drawn.outingDurable === state.durableCandidateIds) return;
  drawn.outings = state.outings;
  drawn.outingStorage = state.outingStorage;
  drawn.outingSelection = state.outingSelection;
  drawn.selectedOuting = state.selectedOutingId;
  drawn.outingRoads = state.userMetaById;
  drawn.outingDurable = state.durableCandidateIds;
  nodes.outingCount.textContent = String((state.outings ?? []).length);
  renderOutings(nodes.outings, state, {
    onOpenOuting: id => store.selectOuting(id),
    // A road in a plan opens the ordinary saved-candidate detail: there is no second road page.
    onSelectRoad: id => store.select(id),
    onRename: (id, title) => store.updateOuting(id, { title }),
    onDate: (id, date) => store.updateOuting(id, { date }),
    onStatus: (id, status) => store.updateOuting(id, { status }),
    onMove: (id, roadId, direction) => store.moveOutingRoad(id, roadId, direction),
    onRemoveRoad: (id, roadId) => store.removeRoadFromOuting(id, roadId),
    onAddRoad: (id, roadId) => store.addRoadToOuting(id, roadId),
    onNotes: (id, value, options) => saveOutingNotes(id, value, options),
    onAddItem: (id, text) => { const outing = (store.getState().outings ?? []).find(entry => entry.id === id);
      store.updateOuting(id, { checklist: [...(outing?.checklist ?? []), { text, checked: false }] }); },
    onToggleItem: (id, itemId) => { const outing = (store.getState().outings ?? []).find(entry => entry.id === id);
      store.updateOuting(id, { checklist: (outing?.checklist ?? []).map(item => item.id === itemId ? { ...item, checked: !item.checked } : item) }); },
    onRemoveItem: (id, itemId) => { const outing = (store.getState().outings ?? []).find(entry => entry.id === id);
      store.updateOuting(id, { checklist: (outing?.checklist ?? []).filter(item => item.id !== itemId) }); },
    onRemoveOuting: id => store.removeOuting(id) });
}

// NOTES ARE WRITTEN ON A SHORT DEBOUNCE, not on every keystroke: typing stays smooth, and the write either lands
// or says it did not. The panel keeps the draft either way.
const noteTimers = new Map();
const NOTE_DEBOUNCE_MS = 600;
function saveCandidateNote(id, value, { immediate = false } = {}) {
  if (!id) return;
  clearTimeout(noteTimers.get(id));
  if (immediate) { noteTimers.delete(id); store.setCandidateNote(id, value); return; }
  noteTimers.set(id, setTimeout(() => { noteTimers.delete(id); store.setCandidateNote(id, value); }, NOTE_DEBOUNCE_MS));
}

// What this session has measured for the candidates being compared. A candidate with no entry here is not a
// candidate with zeros: the comparison says "not measured this session" instead.
function comparisonMeasurements(state) {
  const measurements = {};
  for (const id of comparisonIds(state)) {
    measurements[id] = { ecology: state.ecologyByCandidate[id] ?? null, habitat: state.habitatByCandidate[id] ?? null,
      occurrence: state.occurrenceByCandidate[id] ?? null, access: state.investigationByCandidate[id] ?? null };
  }
  return measurements;
}

// The saved-roads panel is rebuilt only when the collection, the annotations or the session measurements it
// shows actually change: typing a note must not rebuild a list of a hundred cards on every publish.
function renderSavedRoadsPanel(state) {
  if (drawn.savedRoads === state.savedRoads && drawn.savedMeta === state.userMetaById
    && drawn.savedDurable === state.durableCandidateIds && drawn.savedStorage === state.candidateStorage
    && drawn.savedEcology === state.ecologyByCandidate && drawn.savedHabitat === state.habitatByCandidate
    && drawn.savedOutingSelection === state.outingSelection && drawn.savedOutings === state.outings) return;
  drawn.savedRoads = state.savedRoads;
  drawn.savedMeta = state.userMetaById;
  drawn.savedDurable = state.durableCandidateIds;
  drawn.savedStorage = state.candidateStorage;
  drawn.savedEcology = state.ecologyByCandidate;
  drawn.savedHabitat = state.habitatByCandidate;
  drawn.savedOutingSelection = state.outingSelection;
  drawn.savedOutings = state.outings;
  const counts = savedCounts(state);
  nodes.savedCount.textContent = String(counts.total);
  renderSavedRoads(nodes.savedRoads, state, { measurements: comparisonMeasurements(state),
    onSelect: id => store.select(id),
    onFavorite: (id, favorite) => store.setCandidateFavorite(id, favorite),
    onToggleCompare: id => store.toggleSavedRoadCompare(id),
    onClearCompare: () => store.clearSavedRoadCompare(),
    onTogglePlan: id => store.toggleOutingSelection(id),
    onCreateOuting: roadIds => { const outcome = store.createOutingFromRoads(roadIds);
      if (!outcome.ok) store.setOutingStorage({ status: 'unavailable', reason: outcome.reason }); },
    onSort: sort => store.setSavedRoadsSort(sort),
    onFilter: filter => store.setSavedRoadsFilter(filter) });
}

store.subscribe(state => {
  const selected = state.candidates.find(candidate => candidate.id === state.selectedId) ?? null;
  const ecology = selected ? state.ecologyByCandidate[selected.id] : null;
  const habitat = selected ? state.habitatByCandidate[selected.id] : null;
  const occurrenceEvidence = selected ? state.occurrenceByCandidate[selected.id] ?? null : null;
  const investigation = selected ? state.investigationByCandidate[selected.id] ?? null : null;
  const accessReview = selected ? state.accessReviewByCandidate[selected.id] ?? null : null;
  const roads = selected ? state.roadsByCandidate[selected.id] ?? [] : [];
  // Selecting a corridor never reads source data by itself. A corridor whose detail is the precomputed metrics -
  // which is every corridor until source evidence is explicitly requested - opens with no GIS read at all, and
  // occurrence evidence was already explicit. The two exceptions are deliberate: a restored candidate (its
  // analysis is the whole point of restoring it and the panel says so) and a candidate whose source evidence has
  // been requested, where the habitat and ecology reads are the step the person asked for.
  const restored = Boolean(selected && state.restoredCandidateIds.includes(selected.id));
  const wantsSourceReads = selected?.sourceEvidence?.status === 'ready';
  if (selected && (restored || wantsSourceReads) && drawn.resolvedId !== selected.id) {
    drawn.resolvedId = selected.id;
    resolveEcology(selected.id)
      .then(() => resolveHabitat(selected.id))
      .catch(error => store.setRoadQuery({ ...state.roadQuery, reason: error.message }));
  }
  nodes.count.textContent = String(state.candidates.length);
  renderCandidates(nodes.list, state, id => store.select(id));
  renderDetail(nodes.detail, selected, (id, status) => store.decide(id, status), { ecology, roads, habitat, occurrence: occurrenceEvidence,
    onQueryOccurrence: () => requestOccurrence({ refresh: true }),
    // A candidate this device kept comes back without its detailed analysis: running it again is this control,
    // never a boot step.
    restored,
    persisted: Boolean(selected && state.durableCandidateIds.includes(selected.id)),
    storage: state.candidateStorage,
    userMeta: selected ? state.userMetaById[selected.id] ?? null : null,
    onFavorite: (id, favorite) => store.setCandidateFavorite(id, favorite),
    onNote: (id, value, options) => saveCandidateNote(id, value, options),
    onRunAnalysis: () => runCandidateAnalysis(selected?.id),
    onRequestSourceEvidence: () => requestSourceEvidenceForSelected(),
    // The workspace checks first: a road used by a plan is removed from it only when a person says so.
    outingsUsing: selected ? store.outingsUsingCandidate(selected.id).length : 0,
    onRemove: (id, options) => store.removeCandidate(id, options),
    investigation, access: investigation && accessReview ? { ...investigation.access, human: accessReview } : investigation?.access ?? null,
    onRunAccess: options => requestAccess(options), onExportBundle: () => { exportBundle().catch(error => reportAccessNote(error.message)); },
    onReviewAccess: review => recordAccessReview(review), recordedCaptureAt: accessRecord?.capturedAt ?? null, liveOsm: state.liveOsm,
    workerStatus: state.workerStatus, workerUrl: INVESTIGATOR_WORKER_URL,
    declaredSourceCount: (PILOT_PROBES_BY_CORRIDOR[selected?.id] ?? []).length });
  renderContext(nodes.context, { manifest, pilotLoaded: state.pilotLoaded, error: manifestError, coverage: selected?.coverage, roadQuery: state.roadQuery, places });
  // The discovery workspace renders from its own state slice, so a candidate interaction never
  // rebuilds a bounded result table.
  renderDiscoveryPanel(state);
  // The saved-roads workspace renders from its own state slice, and never asks for data to do it.
  renderSavedRoadsPanel(state);
  renderOutingsPanel(state);
  // The search preview follows the search definition, not the discovery run: it is on screen while a centre
  // is being chosen, and it stays after a search so the results can be read against the area they came from.
  updateSearchPreview(state);
  nodes.fit.disabled = !selected;
  nodes.caption.textContent = caption(state);
  const overlay = state.habitatOverlay && state.habitatOverlay.candidateId === selected?.id ? state.habitatOverlay : null;
  const occurrenceOverlay = state.occurrenceOverlay && state.occurrenceOverlay.candidateId === selected?.id ? state.occurrenceOverlay : null;
  const discoveryLayer = discoveryDescriptors(state);
  const discoveryKey = `${state.discovery.status}|${state.discovery.selectedId}|${discoveryLayer?.corridors.length ?? 0}|${discoveryLayer?.promotedIds.join(',') ?? ''}`;
  if (selected?.id !== drawn.selectedId || drawn.corridors.length !== state.candidates.length
    || drawn.overlay !== overlay || drawn.occurrenceOverlay !== occurrenceOverlay || drawn.discoveryKey !== discoveryKey) {
    drawn.corridors = corridorDescriptors(state);
    drawn.overlay = overlay;
    drawn.occurrenceOverlay = occurrenceOverlay;
    drawn.discoveryKey = discoveryKey;
    map.draw({ corridors: drawn.corridors, selectedId: selected?.id ?? null, overlay, occurrenceOverlay, discovery: discoveryLayer });
    drawn.selectedId = selected?.id ?? null;
  }
});

function signature(state) {
  const discovery = state.discovery;
  return `${discovery.status}|${discovery.results.length}|${discovery.selectedId}|${Object.keys(discovery.marks).length}|${discovery.sort}|${JSON.stringify(discovery.filters)}|${discovery.error ?? ''}|${JSON.stringify(state.search)}`;
}

// The discovery panel is rendered only when its own state changed: selecting a candidate must not
// rebuild a bounded result table of up to a few hundred rows.
function renderDiscoveryPanel(state) {
  if (drawn.discoveryNodes === state.discovery && drawn.discoverySignature === signature(state)) return;
  drawn.discoveryNodes = state.discovery;
  drawn.discoverySignature = signature(state);
  // Marks are the authoritative promoted/dismissed state: applying them at render time keeps the table,
  // the map layer, and the persisted record in step with each other after a promotion.
  const discovery = { ...state.discovery, results: applyMarks(state.discovery.results, state.discovery.marks) };
  renderDiscovery(nodes.discovery, {
    discovery, searchAreas, searchAreaId: state.search.areaId, search: state.search,
    presets: declaredRadiusPresets, region: publishedRegion, gazetteer: places, loadPlaceTier: ensurePlaceTier,
    onDiscover: () => { discoverRoads().catch(error => store.failDiscovery({ error: error.message, marks: state.discovery.marks })); },
    onSelect: id => store.selectDiscovery(id),
    onPromote: id => promoteDiscoveryCorridor(id),
    onDismiss: id => markDiscoveryCorridor(id),
    onFilters: filters => store.setDiscoveryFilters(filters),
    onSort: sort => store.setDiscoverySort(sort),
    // A selected place is the same input a map click or a typed coordinate produces; only the label differs.
    onSelectPlace: selected => selectPlace(selected),
    // The browser's current location is the same input again: one more centre, at the radius already chosen.
    onUseLocation: () => { useMyLocation().catch(error => store.setSearchLocation({ status: LOCATION_STATUS.POSITION_UNAVAILABLE, message: error.message })); },
    locationSupported: locationProvider.supported,
    // A declared radius scenario is a preset, not a second kind of search: choosing one fills the centre and
    // radius and nothing else about the run changes.
    onSearchArea: id => {
      const area = searchAreas.find(entry => entry.id === id) ?? null;
      const definition = definitionFromSearchArea(area);
      if (definition) { applySearchDefinition(definition); return; }
      store.setSearchArea(id);
    },
    onSearchDefinition: (definition, options = {}) => {
      if (options.source === 'coordinate') store.setSearchError(null);
      // Presets and coordinates carry no place; a recent search carries the label it was remembered with.
      applySearchDefinition(definition, { place: options.place ?? null });
    },
    onSearchRadius: radiusMiles => {
      if (typeof radiusMiles !== 'number') return;
      const current = state.search.definition;
      if (!current) return;
      // A radius change is a new definition, so the bounds are derived again: the search box always matches
      // the radius on screen. The place label stays, because the centre did not move.
      applySearchDefinition(searchDefinitionOf(current.center, radiusMiles), { place: state.search.place });
    },
    onSearchPicking: picking => store.setSearchPicking(picking),
    onPreview: patch => previewSearch(patch),
  });
  const note = eligibilityNote(state.discovery.eligibility);
  if (note) nodes.discovery.append(el('p', 'discovery-eligible', note));
  nodes.discoveryCount.textContent = state.discovery.results.length ? String(state.discovery.results.length) : '0';
}

// A live preview while a radius changes. It only moves the map's search layer: it publishes nothing, runs
// nothing, and never touches the results.
function previewSearch(patch) {
  const current = activeSearch().definition;
  if (!current) return;
  const merged = { ...current, ...patch };
  const result = readSearchDefinition({ lat: merged.center[1], lon: merged.center[0], radiusMiles: merged.radiusMiles },
    { region: publishedRegion });
  if (!result.ok) return;
  const coverage = result.coverage;
  map.setSearchPreview({ kind: 'radius', center: result.definition.center,
    radiusMiles: result.definition.radiusMiles, bounds: result.definition.bounds,
    coverage: coverage?.coverage ?? COVERAGE.UNKNOWN, regionBounds: publishedRegion?.bounds ?? null,
    label: `${formatRadius(result.definition.radiusMiles)} · ${coverage?.coverage ?? COVERAGE.UNKNOWN}` });
}


function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

// Only the bounded, currently visible discovery corridors reach the map: the same first rows the table
// shows, so a search area stays a bounded number of SVG paths.
function discoveryDescriptors(state) {
  const discovery = state.discovery;
  if (discovery.status !== 'ready' || !discovery.results.length) return null;
  const results = applyMarks(discovery.results, discovery.marks);
  const view = filterAndSort(results, discovery.filters, discovery.sort).slice(0, MAX_RESULT_ROWS);
  const search = state.search;
  return {
    // Where the search was made and where the nearest part of every drawn corridor is: the selected corridor
    // gets one line from the centre, and nothing else on the map is drawn from this.
    center: search.areaId === CUSTOM_SEARCH_AREA_ID ? (search.definition?.center ?? null) : null,
    centerLabel: centerPresentation({ place: search.place, near: search.near, center: search.definition?.center ?? null }).label,
    corridors: view.map(result => ({ id: result.id, name: result.name, geometry: result.geometry,
      nearestCenterPoint: result.nearestCenterPoint ?? null,
      distanceLabel: result.distanceFromCenterM == null ? null
        : formatContextDirection({ distanceM: result.distanceFromCenterM, cardinal: result.cardinalFromCenter }) })),
    selectedId: discovery.selectedId,
    promotedIds: view.filter(result => result.status === DISCOVERY_STATUS.PROMOTED).map(result => result.id),
    badge: `DISCOVERY ${discovery.coverage?.coverage ?? COVERAGE.UNKNOWN} · ${view.length} OF ${results.length} CORRIDORS · ACCESS UNVERIFIED`,
  };
}

async function openPilot() {
  nodes.load.disabled = true;
  try {
    const declaration = validatePilot(await fetchJson(PILOT_URL));
    const roadQuery = await gis.queryRoads({ roadIds: pilotRoadIds(declaration) });
    if (roadQuery.coverage === COVERAGE.UNKNOWN) {
      store.setRoadQuery({ status: 'unavailable', coverage: roadQuery.coverage, reason: roadQuery.reason, provenance: null, missingRoadIds: [], note: roadQuery.note });
      nodes.load.disabled = false;
      nodes.load.textContent = 'Road data unavailable';
      return;
    }
    const built = buildPilotCandidates(declaration, roadQuery);
    store.loadPilot({
      pilotId: declaration.pilot, candidates: built.candidates, roadsByCandidate: built.roadsByCandidate,
      roadQuery: { status: 'ready', coverage: roadQuery.coverage, reason: roadQuery.reason, provenance: roadQuery.provenance,
        missingRoadIds: roadQuery.missingRoadIds, note: roadQuery.note },
    });
    nodes.load.textContent = 'Road pilot loaded';
    if (built.candidates[0]) { await resolveEcology(built.candidates[0].id); await resolveHabitat(built.candidates[0].id); }
  } catch (error) {
    store.setRoadQuery({ status: 'unavailable', coverage: COVERAGE.UNKNOWN, reason: error.message, provenance: null, missingRoadIds: [], note: null });
    nodes.load.disabled = false;
    nodes.load.textContent = `Could not load the road pilot: ${error.message}`;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

nodes.load.addEventListener('click', openPilot);
nodes.fit.addEventListener('click', () => map.fit());
nodes.occurrenceNote = document.getElementById('occurrence-note');
nodes.occurrenceToggle = document.getElementById('occurrence-layer');
function requestOccurrence({ refresh = false } = {}) {
  const selected = store.getState().selectedId;
  if (!selected) return;
  nodes.occurrenceNote.textContent = 'Querying public occurrence sources…';
  resolveOccurrence(selected, { refresh })
    .then(() => { nodes.occurrenceNote.textContent = 'Occurrence coverage is reported per source; an unavailable source is never a zero.'; })
    .catch(error => { nodes.occurrenceNote.textContent = error.message; });
}
const accessLiveToggle = document.getElementById('access-live-osm');
accessLiveToggle?.addEventListener('change', event => { store.setLiveOsm(event.target.checked); reportAccessNote(event.target.checked ? 'OpenStreetMap will be queried live on the next run; official sources still replay the reviewed operator capture.' : 'The next run replays the reviewed operator capture for OpenStreetMap as well.'); });

nodes.occurrenceToggle?.addEventListener('change', event => {
  toggleOccurrenceOverlay(event.target.checked).catch(error => { nodes.occurrenceNote.textContent = error.message; });
});

const habitatToggle = document.getElementById('habitat-layers');
habitatToggle?.addEventListener('change', event => {
  const enabled = event.target.checked;
  nodes.overlayNote.textContent = enabled ? 'Loading habitat layers…' : '';
  toggleHabitatOverlay(enabled).then(() => { nodes.overlayNote.textContent = enabled ? 'Wetlands, flowlines, and the 1 km analysis buffer for the selected corridor.' : ''; }).catch(error => { nodes.overlayNote.textContent = error.message; });
});
// The pilot button ships disabled: enabling it here is the signal that every listener above is attached, so a
// click can never arrive before the workspace can answer it.
nodes.load.disabled = false;

const dialog = document.getElementById('about-dialog');
document.getElementById('about-button').addEventListener('click', () => dialog.showModal());
document.getElementById('close-about').addEventListener('click', () => dialog.close());

loadManifest().then(async value => {
  manifest = value;
  const state = store.getState();
  renderContext(nodes.context, { manifest, pilotLoaded: state.pilotLoaded, coverage: state.candidates.find(candidate => candidate.id === state.selectedId)?.coverage, roadQuery: state.roadQuery, places });
  try {
    await loadSearchAreas();
  } catch (error) {
    // A search area that the loaded datasets cannot cover is a declaration problem, not a survey.
    store.failDiscovery({ error: `Discovery search areas are unavailable: ${error.message}`, marks: readDiscoveryMarks() });
  }
  // Candidates this device kept come back before the first render, so a reload lands on the workspace a person
  // left: no discovery run, no analysis, and no network read. A record that cannot be read is left out with its
  // reason (reported under the candidate list), and the rest still load.
  store.restoreCandidates();
  // Outings are a second device-local entry, restored the same way and with the same zero-network promise.
  store.restoreOutings();
  renderDiscoveryPanel(store.getState());
  updateSearchPreview(store.getState());
  const discovery = store.getState().discovery;
  if (discovery.status === 'idle') store.setDiscoveryMarks(readDiscoveryMarks());
}).catch(error => {
  manifestError = error.message;
  renderContext(nodes.context, { error: manifestError });
});
