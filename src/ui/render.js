import { CANDIDATE_STATUS } from '../domain/corridor.js';

function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

export function renderCandidates(container, state, onSelect) {
  container.replaceChildren();
  if (!state.candidates.length) { container.append(empty('No corridors yet', 'Start with the clearly labeled sample. Real discovery and GIS analysis will arrive as data sources are connected.')); return; }
  for (const candidate of state.candidates) {
    const card = el('button', 'candidate-card'); card.type = 'button'; card.setAttribute('aria-current', candidate.id === state.selectedId ? 'true' : 'false');
    card.append(el('strong', '', candidate.name), el('small', '', candidate.summary), el('span', 'tag', candidate.status));
    card.addEventListener('click', () => onSelect(candidate.id)); container.append(card);
  }
}

export function renderDetail(container, candidate, onDecide, ecology = null) {
  container.replaceChildren();
  if (!candidate) { container.append(empty('Investigation starts with a road', 'Select a corridor to inspect its supporting evidence, missing data, and research questions.')); return; }
  container.append(el('h3', 'detail-title', candidate.name), el('p', 'detail-lede', candidate.summary));
  const status = el('span', `tag ${candidate.status === 'rejected' ? 'warn' : ''}`, candidate.status); container.append(status);
  const ecologySection = section('Ecological context');
  ecologySection.classList.add('ecology-section');
  if (!ecology || ecology.diagnostics?.status === 'loading') {
    ecologySection.append(el('p', 'small muted', ecology?.diagnostics?.reason ?? 'Ecoregion analysis has not run.'));
  } else if (ecology.coverage === 'UNKNOWN') {
    ecologySection.append(el('p', 'small muted', `Ecoregions unavailable: ${ecology.diagnostics?.reason ?? 'Analysis did not complete.'}`));
  } else if (ecology.coverage === 'NONE') {
    ecologySection.append(el('p', 'small muted', 'This corridor does not intersect the published Oregon EPA extract.'));
  } else {
    for (const [label, level] of [['Level III', ecology.level3], ['Level IV', ecology.level4]]) {
      const block = el('div', 'ecology-level');
      block.append(el('span', 'eyebrow', label), el('strong', '', level?.primary ? `${level.primary.name} (${level.primary.code})` : level?.coverage === 'UNKNOWN' ? 'Unavailable' : 'No intersection'));
      if (level?.spansMultiple) block.append(el('p', 'small', `Also crosses ${level.intersections.slice(1).map(region => `${region.name} — about ${Math.round(region.percent)}%`).join(' · ')}`));
      ecologySection.append(block);
    }
  }
  ecologySection.append(el('p', 'small', `Coverage: ${ecology?.coverage ?? 'UNKNOWN'} · Broad ecological context, not proof of a species occurrence. EPA boundaries are approximate at road scale.`));
  if (ecology?.diagnostics?.status === 'partial' && ecology.diagnostics.reason) ecologySection.append(el('p', 'small muted', ecology.diagnostics.reason));
  if (ecology?.provenance?.sources?.length) {
    const details = el('details', 'provenance-details'); details.append(el('summary', '', 'Source & method'));
    details.append(el('p', 'small', ecology.provenance.method));
    for (const source of ecology.provenance.sources) {
      const row = el('p', 'small'); row.append(document.createTextNode(`${source.agency} · ${source.publicationDate ?? source.version ?? 'version unrecorded'} · `));
      if (source.url?.startsWith('https://')) { const link = el('a', '', 'EPA source'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
      details.append(row);
    }
    ecologySection.append(details);
  }
  container.append(ecologySection);
  const evidenceSection = section('Evidence trail');
  const list = el('ul', 'evidence-list');
  for (const item of candidate.evidence) {
    const row = el('li'); row.append(el('span', 'tag unknown', item.kind), el('p', '', item.statement), el('small', '', `${item.provenance.source} · ${item.provenance.method ?? 'Method unrecorded'} · coverage ${item.coverage}`)); list.append(row);
  }
  evidenceSection.append(list); container.append(evidenceSection);
  const accessSection = section('Access'); accessSection.append(el('p', 'small', `${candidate.access.status}: ${candidate.access.note}`)); container.append(accessSection);
  const questionsSection = section('Questions to resolve'); const questions = el('ul', 'small'); for (const question of candidate.questions ?? []) questions.append(el('li', '', question)); questionsSection.append(questions); container.append(questionsSection);
  const decisionSection = section('Candidate decision'); const actions = el('div', 'decision-actions');
  for (const [statusValue, label] of [[CANDIDATE_STATUS.SHORTLISTED, 'Shortlist'], [CANDIDATE_STATUS.REJECTED, 'Reject'], [CANDIDATE_STATUS.DISCOVERED, 'Reset']]) { const button = el('button', 'quiet-button', label); button.type = 'button'; button.setAttribute('aria-pressed', candidate.status === statusValue ? 'true' : 'false'); button.addEventListener('click', () => onDecide(candidate.id, statusValue)); actions.append(button); }
  decisionSection.append(actions); container.append(decisionSection);
}

export function renderContext(container, { manifest, sampleLoaded, error, ecology } = {}) {
  container.replaceChildren();
  const rows = [ ['Published GIS datasets', manifest ? `${manifest.datasets.length}` : 'Unavailable'], ['Habitat', 'UNKNOWN'], ['EPA ecoregions', ecology?.coverage ?? 'UNKNOWN'], ['Occurrence', 'UNKNOWN'], ['Access', 'UNKNOWN'] ];
  const dl = el('dl', 'coverage-list');
  for (const [label, value] of rows) { const row = el('div'); row.append(el('dt', '', label), el('dd', '', value)); dl.append(row); }
  container.append(dl, el('p', 'context-note', error ? `Manifest could not be loaded: ${error}` : sampleLoaded ? 'EPA ecoregion coverage refers to the selected corridor. The sample road is synthetic; habitat, occurrence, and access remain unverified.' : 'Coverage will be reported per corridor and dataset. Missing data is never counted as zero.'));
}

function section(title) { const node = el('section', 'detail-section'); node.append(el('h3', '', title)); return node; }
function empty(title, description) { const node = el('div', 'empty'); node.append(el('strong', '', title), el('p', '', description)); return node; }
