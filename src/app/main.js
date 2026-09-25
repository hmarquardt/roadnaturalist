import { createCandidate } from '../domain/corridor.js';
import { createStore } from '../state/store.js';
import { createCorridorMap } from '../map/corridor-map.js';
import { renderCandidates, renderDetail, renderContext } from '../ui/render.js';
import { loadManifest } from '../services/manifest.js';
import { createGisService } from '../gis/service.js';
import { summarizeEcoregions } from '../ecology/context.js';

const store = createStore();
export const gis = createGisService();
const map = createCorridorMap(document.getElementById('map'), { onSelect: id => store.select(id) });
const nodes = { list: document.getElementById('candidate-list'), detail: document.getElementById('candidate-detail'), context: document.getElementById('data-context'), count: document.getElementById('candidate-count'), caption: document.getElementById('map-caption'), fit: document.getElementById('fit-map') };
let manifest = null;
let manifestError = null;
let drawnId = null;

async function resolveEcology(id) {
  const state = store.getState();
  if (state.ecologyByCandidate[id]) return;
  const candidate = state.candidates.find(item => item.id === id);
  if (!candidate) return;
  store.setEcologyResult(id, { coverage: 'UNKNOWN', diagnostics: { status: 'loading', reason: 'Resolving EPA ecoregions…' } });
  store.setEcologyResult(id, summarizeEcoregions(await gis.getEcoregions(candidate.geometry)));
}

store.subscribe(state => {
  const selected = state.candidates.find(candidate => candidate.id === state.selectedId) ?? null;
  const ecology = selected ? state.ecologyByCandidate[selected.id] : null;
  nodes.count.textContent = String(state.candidates.length);
  renderCandidates(nodes.list, state, id => store.select(id));
  renderDetail(nodes.detail, selected, (id, status) => store.decide(id, status), ecology);
  renderContext(nodes.context, { manifest, sampleLoaded: state.sampleLoaded, error: manifestError, ecology });
  if (selected?.id !== drawnId) { map.draw(selected); drawnId = selected?.id ?? null; }
  nodes.fit.disabled = !selected;
  nodes.caption.textContent = selected ? 'Synthetic sample geometry. Drag to pan, scroll to zoom, or fit the corridor. No basemap or GIS layer is connected.' : 'Select a candidate to see its mapped geometry. Geometry is evidence, not an invented route.';
});

document.getElementById('load-sample').addEventListener('click', async () => {
  const button = document.getElementById('load-sample'); button.disabled = true;
  try {
    const response = await fetch(new URL('../../data/sample-corridor.json', import.meta.url));
    if (!response.ok) throw new Error(`Sample unavailable: HTTP ${response.status}`);
    const fixture = await response.json();
    if (fixture.fixture !== true) throw new Error('Sample marker missing');
    store.loadSample(fixture.candidates.map(createCandidate));
    resolveEcology(fixture.candidates[0].id);
    button.textContent = 'Sample loaded';
  } catch (error) { button.disabled = false; button.textContent = `Could not load sample: ${error.message}`; }
});
nodes.fit.addEventListener('click', () => map.fit());
const dialog = document.getElementById('about-dialog');
document.getElementById('about-button').addEventListener('click', () => dialog.showModal());
document.getElementById('close-about').addEventListener('click', () => dialog.close());

loadManifest().then(value => { manifest = value; const state = store.getState(); renderContext(nodes.context, { manifest, sampleLoaded: state.sampleLoaded, ecology: state.ecologyByCandidate[state.selectedId] }); }).catch(error => { manifestError = error.message; const state = store.getState(); renderContext(nodes.context, { error: manifestError, sampleLoaded: state.sampleLoaded, ecology: state.ecologyByCandidate[state.selectedId] }); });
