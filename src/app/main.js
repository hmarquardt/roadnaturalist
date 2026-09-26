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
import { renderDiscovery, eligibilityNote } from '../ui/discovery.js';
import { readDiscoveryMarks, writeDiscoveryMarks } from '../discovery/persistence.js';
import { DISCOVERY_STATUS, applyMarks, markDiscovery, promoteDiscoveryResult } from '../discovery/lifecycle.js';
import { defaultSearchArea, validateSearchAreas } from '../discovery/search-area.js';
import { filterAndSort } from '../discovery/filter.js';
import { MAX_RESULT_ROWS } from '../discovery/constants.js';

const PILOT_URL = new URL('../../data/roads/or-roads-pilot.json', import.meta.url);
// Declared discovery search areas. The loader refuses an area that is not inside every dataset it
// requires, so the workspace can never offer a survey the loaded data cannot cover.
const SEARCH_AREAS_URL = new URL('../../data/discovery/search-areas.json', import.meta.url);
// The reviewed operator capture of official-source research, replayed offline. The browser cannot crawl county
// sites (they send no CORS header) and must not depend on a live Overpass mirror, so it replays this record and
// offers a live OpenStreetMap re-check as an explicit, separate action.
const ACCESS_EVIDENCE_URL = new URL('../../data/investigator/or-pilot-access-evidence.json', import.meta.url);
// Origins a browser cannot fetch: recorded evidence for them is replayed as OPERATOR_ONLY, never as a fresh check.
const OPERATOR_ONLY_ORIGINS = Object.freeze(['https://www.washingtoncountyor.gov', 'https://content.govdelivery.com', 'https://multco.us', 'https://www.wc-roads.com']);
const store = createStore();
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
const map = createCorridorMap(document.getElementById('map'), { onSelect: id => store.select(id) });
const nodes = {
  list: document.getElementById('candidate-list'), detail: document.getElementById('candidate-detail'),
  context: document.getElementById('data-context'), count: document.getElementById('candidate-count'),
  caption: document.getElementById('map-caption'), fit: document.getElementById('fit-map'),
  load: document.getElementById('load-pilot'), overlayNote: document.getElementById('habitat-layers-note'),
  discovery: document.getElementById('discovery'), discoveryCount: document.getElementById('discovery-count'),
};
let manifest = null;
let manifestError = null;
let searchAreas = [];
let searchAreaId = null;
const drawn = { corridors: [], selectedId: null, overlay: null, occurrenceOverlay: null, resolvedId: null,
  discoveryNodes: null, discoverySignature: null };

// DISCOVERY WORKSPACE. Discovery reads only the bounded road-network extract and the bounded habitat and
// ecoregion extracts through the GIS service: it never calls an occurrence API and never calls the
// Investigator Worker or Overpass. Deeper evidence starts when a person promotes a corridor.
async function loadSearchAreas() {
  const declaration = validateSearchAreas(await fetchJson(SEARCH_AREAS_URL), manifest);
  searchAreas = [...declaration.searchAreas];
  searchAreaId = searchAreas[0]?.id ?? null;
  return searchAreas;
}

async function discoverRoads() {
  const state = store.getState();
  const searchArea = searchAreas.find(area => area.id === searchAreaId) ?? defaultSearchArea({ searchAreas });
  const marks = state.discovery.marks ?? readDiscoveryMarks();
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
  } catch (error) {
    store.failDiscovery({ searchArea, marks, error: error.message,
      coverage: { coverage: error.coverage ?? COVERAGE.UNKNOWN, reason: error.message, counts: {} } });
  }
}

// Promotion reuses the ordinary road/candidate builders, so a discovered corridor becomes a normal
// candidate: same detail pipeline, same evidence workflow, and no Investigator probe entry required.
function promoteDiscoveryCorridor(id) {
  const state = store.getState();
  const result = state.discovery.results.find(entry => entry.id === id);
  if (!result) return;
  const candidate = promoteDiscoveryResult(result, { features: state.discovery.raw?.features ?? [],
    provenance: state.discovery.raw?.provenance ?? null, dataCatalogUrl: state.discovery.searchArea?.catalogUrl ?? null });
  store.promoteDiscoveryCandidate(candidate, id);
  writeDiscoveryMarks(store.getState().discovery.marks);
  nodes.list.scrollIntoView({ block: 'nearest' });
}

function markDiscoveryCorridor(id, status) {
  const state = store.getState();
  const current = state.discovery.results.find(entry => entry.id === id);
  if (!current) return;
  const next = status ?? (current.status === DISCOVERY_STATUS.DISMISSED ? DISCOVERY_STATUS.DISCOVERED : DISCOVERY_STATUS.DISMISSED);
  store.setDiscoveryMarks(writeDiscoveryMarks(markDiscovery(state.discovery.marks, id, next)));
}

async function resolveEcology(id) {
  const state = store.getState();
  if (state.ecologyByCandidate[id]) return;
  const candidate = state.candidates.find(item => item.id === id);
  if (!candidate) return;
  store.setEcologyResult(id, { coverage: COVERAGE.UNKNOWN, diagnostics: { status: 'loading', reason: 'Resolving EPA ecoregions…' } });
  const ecology = summarizeEcoregions(await gis.getEcoregions(candidate.geometry));
  store.setEcologyResult(id, ecology);
  for (const [datasetId, level] of [[COVERAGE_DATASET.EPA_LEVEL3, ecology.level3], [COVERAGE_DATASET.EPA_LEVEL4, ecology.level4]]) {
    store.setCoverage(id, datasetId, { coverage: level?.coverage ?? COVERAGE.UNKNOWN, reason: ecology.diagnostics?.status === 'partial' ? ecology.diagnostics.reason : null });
  }
}

async function resolveHabitat(id) {
  const state = store.getState();
  if (state.habitatByCandidate[id]) return;
  const candidate = state.candidates.find(item => item.id === id);
  if (!candidate) return;
  store.setHabitatResult(id, { diagnostics: { status: 'loading', reason: 'Analyzing wetlands and hydrography…' } });
  let habitat;
  try {
    const habitatService = candidate.dataCatalogUrl
      ? await gis.prepareRegionalSearch({ bbox: candidate.corridor.bounds, catalogUrl: candidate.dataCatalogUrl }) : gis;
    habitat = summarizeHabitat(await habitatService.getHabitatContext(candidate.geometry));
  } catch (error) {
    habitat = summarizeHabitat({ wetlands: { coverage: error.coverage ?? COVERAGE.UNKNOWN, reason: error.message },
      hydrography: { coverage: error.coverage ?? COVERAGE.UNKNOWN, reason: error.message },
      diagnostics: { status: 'unavailable', reason: error.message } });
  }
  store.setHabitatResult(id, habitat);
  for (const [datasetId, coverage] of Object.entries(habitat.coverage)) {
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
    return { id: candidate.id, name: candidate.name, geometry: candidate.geometry,
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

store.subscribe(state => {
  const selected = state.candidates.find(candidate => candidate.id === state.selectedId) ?? null;
  const ecology = selected ? state.ecologyByCandidate[selected.id] : null;
  const habitat = selected ? state.habitatByCandidate[selected.id] : null;
  const occurrenceEvidence = selected ? state.occurrenceByCandidate[selected.id] ?? null : null;
  const investigation = selected ? state.investigationByCandidate[selected.id] ?? null : null;
  const accessReview = selected ? state.accessReviewByCandidate[selected.id] ?? null : null;
  const roads = selected ? state.roadsByCandidate[selected.id] ?? [] : [];
  // Each corridor resolves its own ecological and habitat analysis when it is first selected.
  // Occurrence evidence is never fetched automatically: only the explicit button triggers it.
  if (selected && drawn.resolvedId !== selected.id) {
    drawn.resolvedId = selected.id;
    resolveEcology(selected.id)
      .then(() => resolveHabitat(selected.id))
      .catch(error => store.setRoadQuery({ ...state.roadQuery, reason: error.message }));
  }
  nodes.count.textContent = String(state.candidates.length);
  renderCandidates(nodes.list, state, id => store.select(id));
  renderDetail(nodes.detail, selected, (id, status) => store.decide(id, status), { ecology, roads, habitat, occurrence: occurrenceEvidence,
    onQueryOccurrence: () => requestOccurrence({ refresh: true }),
    investigation, access: investigation && accessReview ? { ...investigation.access, human: accessReview } : investigation?.access ?? null,
    onRunAccess: options => requestAccess(options), onExportBundle: () => { exportBundle().catch(error => reportAccessNote(error.message)); },
    onReviewAccess: review => recordAccessReview(review), recordedCaptureAt: accessRecord?.capturedAt ?? null, liveOsm: state.liveOsm,
    workerStatus: state.workerStatus, workerUrl: INVESTIGATOR_WORKER_URL,
    declaredSourceCount: (PILOT_PROBES_BY_CORRIDOR[selected?.id] ?? []).length });
  renderContext(nodes.context, { manifest, pilotLoaded: state.pilotLoaded, error: manifestError, coverage: selected?.coverage, roadQuery: state.roadQuery });
  // The discovery workspace renders from its own state slice, so a candidate interaction never
  // rebuilds a bounded result table.
  renderDiscoveryPanel(state);
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
  return `${discovery.status}|${discovery.results.length}|${discovery.selectedId}|${Object.keys(discovery.marks).length}|${discovery.sort}|${JSON.stringify(discovery.filters)}|${discovery.error ?? ''}`;
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
    discovery, searchAreas, searchAreaId,
    onDiscover: () => { discoverRoads().catch(error => store.failDiscovery({ error: error.message, marks: state.discovery.marks })); },
    onSelect: id => store.selectDiscovery(id),
    onPromote: id => promoteDiscoveryCorridor(id),
    onDismiss: id => markDiscoveryCorridor(id),
    onFilters: filters => store.setDiscoveryFilters(filters),
    onSort: sort => store.setDiscoverySort(sort),
    onSearchArea: id => { searchAreaId = id; },
  });
  const note = eligibilityNote(state.discovery.eligibility);
  if (note) nodes.discovery.append(el('p', 'discovery-eligible', note));
  nodes.discoveryCount.textContent = state.discovery.results.length ? String(state.discovery.results.length) : '0';
}

function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

// Only the bounded, currently visible discovery corridors reach the map: the same first rows the table
// shows, so a search area stays a bounded number of SVG paths.
function discoveryDescriptors(state) {
  const discovery = state.discovery;
  if (discovery.status !== 'ready' || !discovery.results.length) return null;
  const results = applyMarks(discovery.results, discovery.marks);
  const view = filterAndSort(results, discovery.filters, discovery.sort).slice(0, MAX_RESULT_ROWS);
  return {
    corridors: view.map(result => ({ id: result.id, name: result.name, geometry: result.geometry })),
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
  renderContext(nodes.context, { manifest, pilotLoaded: state.pilotLoaded, coverage: state.candidates.find(candidate => candidate.id === state.selectedId)?.coverage, roadQuery: state.roadQuery });
  try {
    await loadSearchAreas();
  } catch (error) {
    // A search area that the loaded datasets cannot cover is a declaration problem, not a survey.
    store.failDiscovery({ error: `Discovery search areas are unavailable: ${error.message}`, marks: readDiscoveryMarks() });
  }
  renderDiscoveryPanel(store.getState());
  const discovery = store.getState().discovery;
  if (discovery.status === 'idle') store.setDiscoveryMarks(readDiscoveryMarks());
}).catch(error => {
  manifestError = error.message;
  renderContext(nodes.context, { error: manifestError });
});
