import { COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';
import { createStore } from '../state/store.js';
import { createCorridorMap } from '../map/corridor-map.js';
import { renderCandidates, renderDetail, renderContext } from '../ui/render.js';
import { loadManifest } from '../services/manifest.js';
import { createGisService } from '../gis/service.js';
import { summarizeEcoregions } from '../ecology/context.js';
import { summarizeHabitat } from '../habitat/context.js';
import { buildPilotCandidates, pilotRoadIds, roadSourceLabel, validatePilot } from '../roads/pilot.js';
import { roadEvidenceSummary } from '../roads/road.js';

const PILOT_URL = new URL('../../data/roads/or-roads-pilot.json', import.meta.url);
const store = createStore();
export const gis = createGisService();
const map = createCorridorMap(document.getElementById('map'), { onSelect: id => store.select(id) });
const nodes = {
  list: document.getElementById('candidate-list'), detail: document.getElementById('candidate-detail'),
  context: document.getElementById('data-context'), count: document.getElementById('candidate-count'),
  caption: document.getElementById('map-caption'), fit: document.getElementById('fit-map'),
  load: document.getElementById('load-pilot'), overlayNote: document.getElementById('habitat-layers-note'),
};
let manifest = null;
let manifestError = null;
const drawn = { corridors: [], selectedId: null, overlay: null, resolvedId: null };

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
  const roads = selected ? state.roadsByCandidate[selected.id] ?? [] : [];
  // Each corridor resolves its own ecological and habitat analysis when it is first selected.
  if (selected && drawn.resolvedId !== selected.id) {
    drawn.resolvedId = selected.id;
    resolveEcology(selected.id)
      .then(() => resolveHabitat(selected.id))
      .catch(error => store.setRoadQuery({ ...state.roadQuery, reason: error.message }));
  }
  nodes.count.textContent = String(state.candidates.length);
  renderCandidates(nodes.list, state, id => store.select(id));
  renderDetail(nodes.detail, selected, (id, status) => store.decide(id, status), { ecology, roads, habitat });
  renderContext(nodes.context, { manifest, pilotLoaded: state.pilotLoaded, error: manifestError, coverage: selected?.coverage, roadQuery: state.roadQuery });
  nodes.fit.disabled = !selected;
  nodes.caption.textContent = caption(state);
  const overlay = state.habitatOverlay && state.habitatOverlay.candidateId === selected?.id ? state.habitatOverlay : null;
  if (selected?.id !== drawn.selectedId || drawn.corridors.length !== state.candidates.length || drawn.overlay !== overlay) {
    drawn.corridors = corridorDescriptors(state);
    drawn.overlay = overlay;
    map.draw({ corridors: drawn.corridors, selectedId: selected?.id ?? null, overlay });
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
const habitatToggle = document.getElementById('habitat-layers');
habitatToggle?.addEventListener('change', event => {
  const enabled = event.target.checked;
  nodes.overlayNote.textContent = enabled ? 'Loading habitat layers…' : '';
  toggleHabitatOverlay(enabled).then(() => { nodes.overlayNote.textContent = enabled ? 'Wetlands, flowlines, and the 1 km analysis buffer for the selected corridor.' : ''; }).catch(error => { nodes.overlayNote.textContent = error.message; });
});
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

