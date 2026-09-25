import { CANDIDATE_STATUS, COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';
import { ATTRIBUTE_STATE } from '../domain/attributes.js';
import { roadEvidenceSummary } from '../roads/road.js';
import { roadSourceLabel } from '../roads/pilot.js';

function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

export const COVERAGE_LABELS = Object.freeze({
  [COVERAGE_DATASET.ROAD_GEOMETRY]: 'Road geometry',
  [COVERAGE_DATASET.EPA_LEVEL3]: 'EPA Level III',
  [COVERAGE_DATASET.EPA_LEVEL4]: 'EPA Level IV',
  [COVERAGE_DATASET.WETLANDS]: 'Wetlands',
  [COVERAGE_DATASET.OCCURRENCE]: 'Occurrence',
  [COVERAGE_DATASET.ACCESS_VERIFICATION]: 'Access verification',
});

export function renderCandidates(container, state, onSelect) {
  container.replaceChildren();
  if (state.roadQuery?.status === 'unavailable') {
    container.append(empty('Road geometry could not be loaded',
      `${state.roadQuery.reason ?? 'The road dataset could not be queried.'} This is a data-availability result, not evidence that no roads exist.`));
    return;
  }
  if (!state.candidates.length) {
    container.append(empty('No corridor loaded', 'Open the Oregon road pilot to load real road-centerline geometry and resolve its EPA ecoregions.'));
    return;
  }
  for (const candidate of state.candidates) {
    const card = el('button', 'candidate-card'); card.type = 'button';
    card.setAttribute('aria-current', candidate.id === state.selectedId ? 'true' : 'false');
    card.append(el('strong', '', candidate.name), el('small', '', candidate.summary ?? 'Summary unavailable'), el('span', 'tag', candidate.status));
    card.addEventListener('click', () => onSelect(candidate.id));
    container.append(card);
  }
  if (state.roadQuery?.missingRoadIds?.length) {
    container.append(el('p', 'small muted', `Partial road coverage: ${state.roadQuery.missingRoadIds.join(', ')} ${state.roadQuery.missingRoadIds.length === 1 ? 'is' : 'are'} absent from this bounded extract.`));
  }
}

export function renderDetail(container, candidate, onDecide, { ecology = null, roads = [] } = {}) {
  container.replaceChildren();
  if (!candidate) { container.append(empty('Investigation starts with a road', 'Open the pilot and select a corridor to inspect its geometry source, evidence, missing data, and research questions.')); return; }
  container.append(el('h3', 'detail-title', candidate.name), el('p', 'detail-lede', candidate.summary ?? ''), el('span', `tag ${candidate.status === 'rejected' ? 'warn' : ''}`, candidate.status));
  if (roads.length) container.append(roadSection(candidate, roads));
  container.append(ecologySection(ecology));
  const evidenceSection = section('Evidence trail');
  const list = el('ul', 'evidence-list');
  for (const item of candidate.evidence) {
    const row = el('li'); row.append(el('span', 'tag unknown', item.kind), el('p', '', item.statement),
      el('small', '', `${item.provenance.source} · ${item.provenance.method ?? 'Method unrecorded'} · coverage ${item.coverage}`));
    list.append(row);
  }
  if (!candidate.evidence.length) list.append(el('li', 'small muted', 'No evidence recorded for this candidate.'));
  evidenceSection.append(list);
  container.append(evidenceSection);
  if (!roads.length) {
    const accessSection = section('Access');
    accessSection.append(el('p', 'small', `${candidate.access.status}: ${candidate.access.note}`));
    container.append(accessSection);
  }
  const questionsSection = section('Questions to resolve');
  const questions = el('ul', 'small');
  for (const question of candidate.questions ?? []) questions.append(el('li', '', question));
  if (!candidate.questions?.length) questions.append(el('li', 'muted', 'No open questions recorded.'));
  questionsSection.append(questions);
  container.append(questionsSection);
  const decisionSection = section('Candidate decision');
  const actions = el('div', 'decision-actions');
  for (const [statusValue, label] of [[CANDIDATE_STATUS.SHORTLISTED, 'Shortlist'], [CANDIDATE_STATUS.REJECTED, 'Reject'], [CANDIDATE_STATUS.DISCOVERED, 'Reset']]) {
    const button = el('button', 'quiet-button', label); button.type = 'button';
    button.setAttribute('aria-pressed', candidate.status === statusValue ? 'true' : 'false');
    button.addEventListener('click', () => onDecide(candidate.id, statusValue));
    actions.append(button);
  }
  decisionSection.append(actions);
  container.append(decisionSection);
}

export function renderContext(container, { manifest, pilotLoaded, error, coverage, roadQuery } = {}) {
  container.replaceChildren();
  const rows = [['Published GIS datasets', manifest ? `${manifest.datasets.length}` : 'Unavailable']];
  for (const [datasetId, label] of Object.entries(COVERAGE_LABELS)) rows.push([label, coverage?.[datasetId]?.coverage ?? COVERAGE.UNKNOWN]);
  const dl = el('dl', 'coverage-list');
  for (const [label, value] of rows) { const row = el('div'); row.append(el('dt', '', label), el('dd', '', value)); dl.append(row); }
  container.append(dl);
  const reason = coverage?.[COVERAGE_DATASET.ROAD_GEOMETRY]?.reason;
  container.append(el('p', 'context-note', contextNote({ error, pilotLoaded, roadQuery, reason })));
}

function contextNote({ error, pilotLoaded, roadQuery, reason }) {
  if (error) return `Manifest could not be loaded: ${error}`;
  if (roadQuery?.status === 'unavailable') return `Road geometry is UNKNOWN because the road dataset query failed (${roadQuery.reason}). A failed query is not zero roads.`;
  if (!pilotLoaded) return 'Coverage is reported per dataset for the selected corridor. Missing data is never counted as zero.';
  if (reason) return reason;
  return 'Each dataset has its own coverage: a failure is UNKNOWN, not NONE. Road geometry and EPA ecoregions are separate dimensions, and access remains unverified.';
}

function roadSection(candidate, roads) {
  const node = section('Road');
  const evidence = roadEvidenceSummary(roads);
  const dl = el('dl', 'coverage-list road-facts');
  const rows = [
    ['Name', candidate.name],
    ['Length', `${(candidate.corridor.lengthM / 1609.344).toFixed(1)} mi  ·  ${Math.round(candidate.corridor.lengthM).toLocaleString('en-US')} m`],
    ['Road class', attributeText(commonAttribute(roads, road => road.roadClass), 'Multiple source classes')],
    ['Route type', attributeText(commonAttribute(roads, road => road.routeType), 'Multiple route types')],
    ['Counties', (candidate.corridor.sourceCounties.join(' · ') || 'Not recorded')],
    ['Source features', `${candidate.corridor.sourceFeatureCount} feature(s) in ${candidate.corridor.roadCount} county-scoped road record(s)`],
    ['Geometry source', roadSourceLabel(roads)],
    ['Surface', attributeText(roads[0].surface)],
    ['Access', `${evidence.access.label} — ${evidence.access.statement}`],
  ];
  for (const [label, value] of rows) { const row = el('div'); row.append(el('dt', '', label), el('dd', '', value)); dl.append(row); }
  node.append(dl);

  const evidenceBlock = el('div', 'evidence-notes');
  for (const [label, record] of [['Geometry evidence', evidence.geometry], ['Access evidence', evidence.access]]) {
    const block = el('div', `evidence-note ${record.status === 'verified' ? 'ok' : 'caution'}`);
    block.append(el('span', 'eyebrow', label), el('strong', '', record.label), el('p', 'small', record.statement));
    if (record.note) block.append(el('p', 'small muted', record.note));
    evidenceBlock.append(block);
  }
  evidenceBlock.append(el('p', 'small muted', compositionText(roads)));
  node.append(evidenceBlock);
  node.append(provenanceDetails(roads));
  return node;
}

function compositionText(roads) {
  const compositions = roads.map(road => road.composition);
  const total = key => compositions.reduce((sum, entry) => sum + (entry[key] ?? 0), 0);
  const gaps = compositions.flatMap(entry => entry.gapsM);
  const unresolved = compositions.map(entry => entry.maxUnresolvedGapM).filter(Number.isFinite);
  const parts = ['Composition', `${total('sourceFeatureCount')} source feature(s)`,
    `${total('lineCount')} line(s)`, `${total('partCount')} connected part(s)`,
    `junction tolerance ${compositions[0].toleranceM} m`];
  if (total('duplicatesRemoved')) parts.push(`${total('duplicatesRemoved')} duplicate feature(s) removed`);
  if (total('collapsedReversedLinks')) parts.push(`${total('collapsedReversedLinks')} reversed duplicate link(s) collapsed`);
  if (gaps.length) parts.push(`${gaps.length} short junction gap(s) joined (${gaps.map(gap => `${Math.round(gap)} m`).join(', ')})`);
  if (unresolved.length) parts.push(`${Math.round(Math.max(...unresolved))} m unresolved gap between parts — kept visible, not bridged`);
  return parts.join(' · ');
}

function provenanceDetails(roads) {
  const details = el('details', 'provenance-details');
  details.append(el('summary', '', 'Source & method'));
  const provenance = roads[0].provenance;
  details.append(el('p', 'small', `${provenance.organization ?? 'Source unrecorded'} · ${provenance.dataset ?? 'Dataset unrecorded'} · dataset ${provenance.datasetId ?? 'unrecorded'} @ ${provenance.datasetVersion ?? 'version unrecorded'} · published ${provenance.publicationDate ?? 'date unrecorded'}`));
  details.append(el('p', 'small', `Normalization: ${provenance.normalization.method ?? 'method unrecorded'} · composition ${provenance.normalization.composition} at ${provenance.normalization.toleranceM} m · ${provenance.sourceCrs ?? 'source CRS unrecorded'} → ${provenance.crs}`));
  details.append(el('p', 'small', `Source feature IDs: ${provenance.sourceFeatureIds.join(', ') || 'none'}`));
  details.append(el('p', 'small', `Dataset digest: ${provenance.datasetDigest ? provenance.datasetDigest.slice(0, 16) : 'unrecorded'} · retrieved ${provenance.retrievedAt ?? 'unrecorded'}`));
  for (const archive of provenance.sourceArchives) {
    const row = el('p', 'small');
    row.append(document.createTextNode(`${archive.countyName ?? archive.fips ?? 'Source archive'} · SHA-256 ${archive.sha256 ? archive.sha256.slice(0, 16) : 'unrecorded'} · `));
    if (String(archive.url ?? '').startsWith('https://')) { const link = el('a', '', 'source archive'); link.href = archive.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
    details.append(row);
  }
  if (String(provenance.documentationUrl ?? '').startsWith('https://')) {
    const row = el('p', 'small'); const link = el('a', '', 'Dataset documentation'); link.href = provenance.documentationUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); details.append(row);
  }
  if (provenance.license) details.append(el('p', 'small', `License: ${provenance.license}`));
  return details;
}

function attributeText(value, fallback = 'Unrecorded') {
  if (!value) return fallback;
  const text = value.value && typeof value.value === 'object' ? (value.value.label ? `${value.value.label} (${value.value.code})` : JSON.stringify(value.value)) : String(value.value ?? '');
  if (value.state === ATTRIBUTE_STATE.KNOWN) return text;
  if (value.state === ATTRIBUTE_STATE.INFERRED) return `${text} (inferred, unverified)`;
  if (value.state === ATTRIBUTE_STATE.NOT_PROVIDED) return `Not provided by this source${value.note ? ` — ${value.note}` : ''}`;
  return `Unknown${value.note ? ` — ${value.note}` : ''}`;
}

function commonAttribute(roads, pick) {
  const values = roads.map(pick);
  const first = JSON.stringify(values[0]);
  return values.every(value => JSON.stringify(value) === first) ? values[0] : null;
}


function ecologySection(ecology) {
  const node = section('Ecological context');
  node.classList.add('ecology-section');
  if (!ecology || ecology.diagnostics?.status === 'loading') {
    node.append(el('p', 'small muted', ecology?.diagnostics?.reason ?? 'Ecoregion analysis has not run.'));
  } else if (ecology.coverage === COVERAGE.UNKNOWN) {
    node.append(el('p', 'small muted', `Ecoregions unavailable: ${ecology.diagnostics?.reason ?? 'Analysis did not complete.'}`));
  } else if (ecology.coverage === COVERAGE.NONE) {
    node.append(el('p', 'small muted', 'This corridor does not intersect the published Oregon EPA extract.'));
  } else {
    for (const [label, level] of [['Level III', ecology.level3], ['Level IV', ecology.level4]]) {
      const block = el('div', 'ecology-level');
      block.append(el('span', 'eyebrow', label), el('strong', '', level?.primary ? `${level.primary.name} (${level.primary.code})` : level?.coverage === COVERAGE.UNKNOWN ? 'Unavailable' : 'No intersection'));
      if (level?.spansMultiple) block.append(el('p', 'small', `Also crosses ${level.intersections.slice(1).map(region => `${region.name} — about ${Math.round(region.percent)}%`).join(' · ')}`));
      node.append(block);
    }
  }
  node.append(el('p', 'small', `Coverage: ${ecology?.coverage ?? COVERAGE.UNKNOWN} · Broad ecological context, not proof of a species occurrence. EPA boundaries are approximate at road scale.`));
  if (ecology?.diagnostics?.status === 'partial' && ecology.diagnostics.reason) node.append(el('p', 'small muted', ecology.diagnostics.reason));
  if (ecology?.provenance?.sources?.length) {
    const details = el('details', 'provenance-details');
    details.append(el('summary', '', 'Source & method'), el('p', 'small', ecology.provenance.method));
    for (const source of ecology.provenance.sources) {
      const row = el('p', 'small');
      row.append(document.createTextNode(`${source.agency} · ${source.publicationDate ?? source.version ?? 'version unrecorded'} · `));
      if (String(source.url ?? '').startsWith('https://')) { const link = el('a', '', 'EPA source'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
      details.append(row);
    }
    node.append(details);
  }
  return node;
}

function section(title) { const node = el('section', 'detail-section'); node.append(el('h3', '', title)); return node; }
function empty(title, description) { const node = el('div', 'empty'); node.append(el('strong', '', title), el('p', '', description)); return node; }

