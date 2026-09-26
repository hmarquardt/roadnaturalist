import { COVERAGE, COVERAGE_DATASET, setCandidateCoverage } from '../domain/corridor.js';
import { createStore } from '../state/store.js';
import { createCorridorMap } from '../map/corridor-map.js';
import { renderCandidates, renderDetail, renderContext } from '../ui/render.js';
import { loadManifest } from '../services/manifest.js';
import { createGisService } from '../gis/service.js';
import { summarizeEcoregions } from '../ecology/context.js';
import { summarizeHabitat } from '../habitat/context.js';
import { buildPilotCandidates, pilotRoadIds, roadSourceLabel, validatePilot } from '../roads/pilot.js';
import { roadEvidenceSummary } from '../roads/road.js';
import { createOccurrenceService } from '../occurrence/service.js';
import { COVERAGE_DATASETS, summarizeOccurrences } from '../occurrence/context.js';
import { createInvestigatorService } from '../investigator/service.js';
import { createResearchService, createRecordedTransport, createLiveResearchTransport } from '../investigator/research.js';
import { BROWSER_MIRRORS, createOsmSource, createRecordedOsmSource } from '../investigator/osm.js';
import { PILOT_PROBES_BY_CORRIDOR } from '../investigator/sources.js';
import { buildCorridorBundle } from '../investigator/bundle.js';

const PILOT_URL = new URL('../../data/roads/or-roads-pilot.json', import.meta.url);
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
};
let manifest = null;
let manifestError = null;
const drawn = { corridors: [], selectedId: null, overlay: null, occurrenceOverlay: null, resolvedId: null };

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
  const habitat = summarizeHabitat(await gis.getHabitatContext(candidate.geometry));
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
  const overlay = await gis.getHabitatOverlay(candidate.geometry);
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

function investigatorFor(candidateId, { liveOsm = false } = {}) {
  const probes = PILOT_PROBES_BY_CORRIDOR[candidateId] ?? [];
  // The capture is per corridor: a recorded run for another corridor is not evidence for this one.
  const corridorRecord = accessRecord?.corridors?.[candidateId] ?? null;
  const recordedRun = corridorRecord ? { ...corridorRecord, capturedAt: accessRecord.capturedAt ?? null } : null;
  const research = createResearchService({
    transport: liveOsm ? createLiveResearchTransport({ fetchImpl: fetch, operatorOnlyOrigins: OPERATOR_ONLY_ORIGINS })
      : createRecordedTransport({ record: recordedRun, browserOrigins: OPERATOR_ONLY_ORIGINS }),
    probes,
  });
  const osmSource = liveOsm ? createOsmSource({ mirrors: BROWSER_MIRRORS, requireCors: true }) : createRecordedOsmSource({ record: accessRecord, corridorId: candidateId });
  return createInvestigatorService({ osmSource, research, probes, record: recordedRun, environment: liveOsm ? 'browser/recorded official sources + live OpenStreetMap' : 'browser/recorded operator run' });
}

async function resolveAccess(id, { refresh = false, liveOsm = false } = {}) {
  const state = store.getState();
  const candidate = state.candidates.find(item => item.id === id);
  if (!candidate) return;
  if (state.investigationByCandidate[id] && !refresh) return;
  await loadAccessRecord();
  const roads = state.roadsByCandidate[id] ?? [];
  const investigation = await investigatorFor(id, { liveOsm }).investigate({ candidate, roads,
    evidence: { ecology: state.ecologyByCandidate[id] ?? null, habitat: state.habitatByCandidate[id] ?? null, occurrence: state.occurrenceByCandidate[id] ?? null } });
  store.setInvestigationResult(id, investigation);
  store.setCoverage(id, COVERAGE_DATASET.ACCESS_VERIFICATION, { coverage: investigation.access.coverage.coverage, reason: investigation.access.coverage.reason });
}

function reportAccessNote(message) { const node = document.getElementById('access-note'); if (node) node.textContent = message; }

function requestAccess({ refresh = true, liveOsm = false } = {}) {
  const selected = store.getState().selectedId;
  if (!selected) return;
  reportAccessNote('Running the staged access investigation…');
  resolveAccess(selected, { refresh, liveOsm })
    .then(() => reportAccessNote(liveOsm ? 'Access evidence: official sources replayed from the reviewed operator capture; OpenStreetMap queried live.' : 'Access evidence replayed from the reviewed operator capture. A failed source is reported as a failure, never as "no restriction found".'))
    .catch(error => reportAccessNote(error.message));
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
    onReviewAccess: review => recordAccessReview(review), recordedCaptureAt: accessRecord?.capturedAt ?? null, liveOsm: state.liveOsm });
  renderContext(nodes.context, { manifest, pilotLoaded: state.pilotLoaded, error: manifestError, coverage: selected?.coverage, roadQuery: state.roadQuery });
  nodes.fit.disabled = !selected;
  nodes.caption.textContent = caption(state);
  const overlay = state.habitatOverlay && state.habitatOverlay.candidateId === selected?.id ? state.habitatOverlay : null;
  const occurrenceOverlay = state.occurrenceOverlay && state.occurrenceOverlay.candidateId === selected?.id ? state.occurrenceOverlay : null;
  if (selected?.id !== drawn.selectedId || drawn.corridors.length !== state.candidates.length
    || drawn.overlay !== overlay || drawn.occurrenceOverlay !== occurrenceOverlay) {
    drawn.corridors = corridorDescriptors(state);
    drawn.overlay = overlay;
    drawn.occurrenceOverlay = occurrenceOverlay;
    map.draw({ corridors: drawn.corridors, selectedId: selected?.id ?? null, overlay, occurrenceOverlay });
    drawn.selectedId = selected?.id ?? null;
  }
});

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

loadManifest().then(value => {
  manifest = value;
  const state = store.getState();
  renderContext(nodes.context, { manifest, pilotLoaded: state.pilotLoaded, coverage: state.candidates.find(candidate => candidate.id === state.selectedId)?.coverage, roadQuery: state.roadQuery });
}).catch(error => {
  manifestError = error.message;
  renderContext(nodes.context, { error: manifestError });
});

