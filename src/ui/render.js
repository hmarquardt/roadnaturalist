import { CANDIDATE_STATUS, COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';
import { ATTRIBUTE_STATE } from '../domain/attributes.js';
import { roadEvidenceSummary } from '../roads/road.js';
import { roadSourceLabel } from '../roads/pilot.js';
import { taxaForLens } from '../occurrence/summary.js';

function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

export const COVERAGE_LABELS = Object.freeze({
  [COVERAGE_DATASET.ROAD_GEOMETRY]: 'Road geometry',
  [COVERAGE_DATASET.ROAD_NETWORK]: 'Road network (discovery)',
  [COVERAGE_DATASET.DISCOVERY]: 'Road discovery',
  [COVERAGE_DATASET.EPA_LEVEL3]: 'EPA Level III',
  [COVERAGE_DATASET.EPA_LEVEL4]: 'EPA Level IV',
  [COVERAGE_DATASET.WETLANDS]: 'Wetlands',
  [COVERAGE_DATASET.HYDROGRAPHY]: 'Hydrography',
  [COVERAGE_DATASET.OCCURRENCE]: 'Occurrence',
  [COVERAGE_DATASET.OCCURRENCE_INATURALIST]: 'Occurrence — iNaturalist',
  [COVERAGE_DATASET.OCCURRENCE_EBIRD]: 'Occurrence — eBird',
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

export function renderDetail(container, candidate, onDecide, { ecology = null, roads = [], habitat = null, occurrence = null, onQueryOccurrence = null,
  investigation = null, access = null, onRunAccess = null, onExportBundle = null, onReviewAccess = null, recordedCaptureAt = null, liveOsm = false,
  workerStatus = null, workerUrl = '', declaredSourceCount = null } = {}) {
  container.replaceChildren();
  if (!candidate) { container.append(empty('Investigation starts with a road', 'Open the pilot and select a corridor to inspect its geometry source, evidence, missing data, and research questions.')); return; }
  container.append(el('h3', 'detail-title', candidate.name), el('p', 'detail-lede', candidate.summary ?? ''), el('span', `tag ${candidate.status === 'rejected' ? 'warn' : ''}`, candidate.status));
  if (roads.length) container.append(roadSection(candidate, roads));
  container.append(ecologySection(ecology));
  container.append(habitatSection(habitat));
  container.append(occurrenceSection(occurrence, onQueryOccurrence));
  // ACCESS & ROAD STATUS is its own section and its own evidence class: geometry being verified never
  // implies access, and access never borrows habitat or occurrence language.
  const accessEvidence = access ?? investigation?.access ?? null;
  const accessOptions = { onRun: onRunAccess, onExport: onExportBundle, onReview: onReviewAccess, recordedCaptureAt, liveOsm,
    workerStatus, workerUrl, declaredSourceCount };
  container.append(investigation ? renderAccessSection({ ...investigation, access: accessEvidence }, accessOptions)
    : renderAccessSection(null, { onRun: onRunAccess, recordedCaptureAt, liveOsm, workerStatus, workerUrl, declaredSourceCount }));
  container.append(renderInvestigationSection(investigation ? { ...investigation, access: accessEvidence } : null, { onReview: onReviewAccess, onExport: onExportBundle, candidateId: candidate.id }));
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


function habitatSection(habitat) {
  const node = section('Habitat context');
  node.classList.add('habitat-section');
  node.append(el('span', 'tag unknown', 'PHYSICAL HABITAT EVIDENCE'));
  if (!habitat || habitat.diagnostics?.status === 'loading') {
    node.append(el('p', 'small muted', habitat?.diagnostics?.reason ?? 'Habitat analysis has not run.'));
    return node;
  }
  node.append(wetlandBlock(habitat.wetlands), hydrographyBlock(habitat.hydrography));
  node.append(el('p', 'small muted', habitat.interpretation ?? ''));
  node.append(habitatProvenance(habitat));
  return node;
}

function wetlandBlock(wetlands) {
  const block = el('div', 'habitat-block');
  block.append(el('span', 'eyebrow', 'Wetlands (NWI)'));
  if (!wetlands?.available) {
    block.append(el('p', 'small muted', wetlands?.reason ?? 'Wetland analysis unavailable.'));
    return block;
  }
  const rows = [['Nearest mapped wetland', wetlands.intersectsCorridor ? 'Corridor intersects a mapped wetland' : formatDistance(wetlands.nearestDistanceM)]];
  for (const [distance, entry] of Object.entries(wetlands.buffers)) {
    rows.push([`Within ${formatDistance(entry.distanceM)}`, `${formatArea(entry.areaM2)} mapped wetland · ${entry.featureCount} feature${entry.featureCount === 1 ? '' : 's'}${entry.coverage === 'FULL' ? '' : ` (coverage ${entry.coverage})`}`]);
  }
  const classScope = wetlands.classDistanceM ?? Math.max(...Object.values(wetlands.buffers).map(entry => entry.distanceM));
  rows.push([`Types within ${formatDistance(classScope)}`, wetlands.classes.length
    ? wetlands.classes.map(item => `${item.label}${item.areaM2 > 0 ? ` ${formatArea(item.areaM2)}` : ''}`).join(' · ')
    : 'None mapped within the analysis region']);
  rows.push(['Coverage', wetlands.coverage]);
  block.append(factList(rows));
  if (wetlands.note) block.append(el('p', 'small muted', wetlands.note));
  if (wetlands.reason) block.append(el('p', 'small muted', `Wetlands unavailable: ${wetlands.reason}`));
  block.append(el('p', 'small muted', 'NWI maps wetlands from imagery of varying dates; it is not a current-condition or jurisdictional determination.'));
  return block;
}

function hydrographyBlock(hydrography) {
  const block = el('div', 'habitat-block');
  block.append(el('span', 'eyebrow', 'Surface water (NHD)'));
  if (!hydrography?.available) {
    block.append(el('p', 'small muted', hydrography?.reason ?? 'Hydrography analysis unavailable.'));
    return block;
  }
  const rows = [
    ['Mapped crossings', `${hydrography.crossingCount} documented geometric crossing${hydrography.crossingCount === 1 ? '' : 's'}`],
    ['Nearest flowing water', formatDistance(hydrography.nearestFlowingWaterM, { zero: 'Corridor intersects mapped flowing water' })],
    ['Nearest standing water', formatDistance(hydrography.nearestStandingWaterM)],
  ];
  for (const [distance, entry] of Object.entries(hydrography.buffers)) {
    rows.push([`Within ${formatDistance(entry.distanceM)}`, `${formatLength(entry.flowlineLengthM)} flowline · ${formatArea(entry.waterbodyAreaM2)} waterbody`]);
  }
  if (hydrography.names.length) rows.push(['Named waters nearby', hydrography.names.slice(0, 5).join(' · ')]);
  rows.push(['Coverage', hydrography.coverage]);
  block.append(factList(rows));
  if (hydrography.crossings.length) {
    const details = el('details', 'provenance-details');
    details.append(el('summary', '', `Crossing features (${hydrography.crossingCount})`));
    for (const crossing of hydrography.crossings.slice(0, 12)) {
      details.append(el('p', 'small', `${crossing.name ?? 'Unnamed'} · ${crossing.featureTypeLabel} · ${crossing.waterClass} · ${formatLength(crossing.overlapM)} overlap · feature ${crossing.sourceFeatureId}`));
    }
    block.append(details);
  }
  block.append(el('p', 'small muted', hydrography.caveat ?? ''));
  if (hydrography.note) block.append(el('p', 'small muted', hydrography.note));
  if (hydrography.reason) block.append(el('p', 'small muted', `Hydrography unavailable: ${hydrography.reason}`));
  return block;
}

function habitatProvenance(habitat) {
  const sources = [habitat.provenance?.wetlands, habitat.provenance?.hydrography].filter(Boolean);
  const details = el('details', 'provenance-details');
  details.append(el('summary', '', 'Habitat source & method'));
  details.append(el('p', 'small', habitat.provenance?.method ?? 'Method unrecorded.'));
  // Did Road Naturalist alter the corridor geometry before measuring? Answered explicitly, in the same
  // restrained register as the rest of the provenance: a repair that moved nothing is not a warning.
  const analytical = habitat.provenance?.geometryForAnalysis ?? habitat.geometryForAnalysis;
  if (analytical) {
    const moved = analytical.displacementM == null ? 'displacement not recorded' : `maximum displacement ${Number(analytical.displacementM).toFixed(3)} m`;
    details.append(el('p', 'small', analytical.repaired
      ? `Analytical geometry: minor topology repair applied (${analytical.method}); canonical road geometry preserved · ${moved}`
      : 'Analytical geometry: canonical corridor geometry used directly · no repair needed'));
  }
  for (const source of sources) {
    details.append(el('p', 'small', `${source.agency} · ${source.dataset} · ${source.datasetVersion} · published ${source.publicationDate ?? 'date unrecorded'} · geometry ${source.geometryCrs} (measured in ${source.measureCrs}) · simplified at ${source.simplifyToleranceM} m`));
    if (source.productStatus) details.append(el('p', 'small muted', source.productStatus));
    const row = el('p', 'small', `Digest ${String(source.datasetDigest).slice(0, 16)} · coverage extent ${(source.coverageExtent ?? []).map(value => value.toFixed(3)).join(', ')} · `);
    if (String(source.referenceUrl ?? '').startsWith('https://')) { const link = el('a', '', 'source archive'); link.href = source.referenceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
    details.append(row);
  }
  return details;
}

function factList(rows) {
  const list = el('dl', 'coverage-list road-facts');
  for (const [label, value] of rows) { const row = el('div'); row.append(el('dt', '', label), el('dd', '', value)); list.append(row); }
  return list;
}

export function formatDistance(meters, { zero = null } = {}) {
  if (meters == null || !Number.isFinite(Number(meters))) return 'Not measured';
  const value = Number(meters);
  if (zero && value < 1) return zero;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} km`;
  return `${Math.round(value)} m`;
}

export function formatArea(squareMeters) {
  if (squareMeters == null || !Number.isFinite(Number(squareMeters))) return 'Not measured';
  const value = Number(squareMeters);
  if (value < 10000) return `${Math.round(value).toLocaleString('en-US')} m²`;
  return `${(value / 10000).toFixed(2)} ha`;
}

export function formatLength(meters) {
  if (meters == null || !Number.isFinite(Number(meters))) return 'Not measured';
  const value = Number(meters);
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

// SPECIES OCCURRENCE EVIDENCE stays visually and lexically separate from PHYSICAL HABITAT EVIDENCE.
// Every number here is a count of documented public observations, never an abundance, a probability,
// or a prediction that a species is on the road.
function occurrenceSection(occurrence, onQuery) {
  const node = section('Species occurrence evidence');
  node.classList.add('occurrence-section');
  node.append(el('span', 'tag unknown', 'SPECIES OCCURRENCE EVIDENCE'));
  if (!occurrence) {
    node.append(el('p', 'small', 'Query the public occurrence sources (iNaturalist and eBird) for documented observations near this corridor at 1 km, 5 km, and 10 km. Road Naturalist only asks when you do, so the road, ecology, and habitat panels never wait on an external service.'));
    node.append(queryButton(onQuery, 'Query public occurrence sources'));
    return node;
  }
  if (occurrence.diagnostics?.status === 'loading') {
    node.append(el('p', 'small muted', occurrence.diagnostics.reason ?? 'Querying public occurrence sources…'));
    return node;
  }
  node.append(queryButton(onQuery, 'Query again'));
  const lenses = occurrence.lenses ?? [];
  for (const summary of Object.values(occurrence.sources ?? {})) node.append(occurrenceSourceBlock(summary, lenses));
  node.append(el('p', 'small muted', occurrence.interpretation ?? ''));
  node.append(el('p', 'small muted', 'Public observation counts record where observers reported and identified organisms. Observer effort is uneven, so these numbers describe the public record near this road, not the wildlife present on it.'));
  node.append(occurrenceProvenance(occurrence));
  return node;
}

function occurrenceSourceBlock(summary, lenses) {
  const block = el('div', 'habitat-block occurrence-block');
  block.append(el('span', 'eyebrow', summary.label ?? summary.source));
  if (!summary.available) {
    block.append(el('p', 'small muted', summary.reason ?? 'This source is unavailable.'));
    block.append(el('p', 'small muted', `Coverage ${summary.coverage}. An unavailable source is not evidence that no species were reported.`));
    return block;
  }
  const rows = [];
  const regions = summary.searchRegions ?? [];
  const outer = regions.length ? regions[regions.length - 1] : null;
  if (outer) rows.push(['Search region', `corridor ± ${formatDistance(outer.radiusM)} · bbox ${regionBounds(outer.region)}`]);
  if (outer?.sourceReportedTotal != null) rows.push(['Reported in region', `${count(outer.sourceReportedTotal)} observations (source-reported, exact for this query)`]);
  if (summary.retrieval) rows.push(['Retrieved in detail', `${count(summary.retrieval.retrieved)} records${summary.retrieval.truncated ? ` — capped at ${count(summary.retrieval.capPerRegion ?? 0)} per search region, most recent first` : ' — complete for the requested query'}`]);
  const buckets = Object.entries(summary.buckets ?? {});
  for (const [radius, bucket] of buckets) {
    if (!bucket.observations) continue;
    rows.push([`Precise within ${formatDistance(Number(radius))}`, `${count(bucket.observations)} observations · ${count(bucket.uniqueTaxa)} taxa · nearest ${formatDistance(bucket.nearestM)} (at least, from retrieved records)`]);
  }
  rows.push(['Located precisely', `${count(summary.preciseObservations ?? 0)} of the retrieved records carry a public location precise enough to measure against the corridor`]);
  rows.push(['Regional/obscured', `${count(summary.regionalOnlyObservations ?? 0)} retrieved records — public location not usable for corridor distance`]);
  rows.push(['Unique taxa', `${count(summary.uniqueTaxa ?? 0)} from the retrieved records`]);
  for (const window of summary.temporalCounts ?? []) {
    if (window.sourceReportedTotal == null) continue;
    rows.push([window.label, `${count(window.sourceReportedTotal)} observations in the search region (source-reported)`]);
  }
  if (summary.localRecent?.sourceReportedTotal != null) rows.push(['Most local recency', `${count(summary.localRecent.sourceReportedTotal)} reported within ${formatDistance(summary.localRecent.regionRadiusM)} in the last ${summary.localRecent.days} days`]);
  const bucketsSummary = Object.values(summary.recency ?? {}).filter(entry => entry.observations).map(entry => `${entry.label}: ${count(entry.observations)}`);
  if (bucketsSummary.length) rows.push(['Retrieved recency', bucketsSummary.join(' · ')]);
  if (summary.latestObservedAt) rows.push(['Most recent retrieved', String(summary.latestObservedAt).slice(0, 10)]);
  if (summary.groups?.length) rows.push(['Groups', summary.groups.slice(0, 6).map(entry => `${entry.label} ${count(entry.observations)}`).join(' · ')]);
  rows.push(['Coverage', `${summary.coverage}${summary.note ? ` — ${summary.note}` : ''}`]);
  if (summary.reason) rows.push(['Unavailable', summary.reason]);
  block.append(factList(rows));
  if (summary.taxa?.length) block.append(occurrenceTaxaList(summary, lenses));
  return block;
}

function occurrenceTaxaList(summary, lenses) {
  const details = el('details', 'provenance-details occurrence-taxa');
  details.append(el('summary', '', `Taxa in the retrieved records (${(summary.taxa ?? []).length})`));
  const lensRow = el('div', 'lens-row');
  const list = el('ul', 'taxa-list');
  const render = lensId => {
    list.replaceChildren();
    const rows = taxaForLens(summary.taxa ?? [], lensId).slice(0, 40);
    if (!rows.length) list.append(el('li', 'small muted', 'No taxa in this lens for the retrieved records.'));
    for (const taxon of rows) list.append(occurrenceTaxonRow(taxon));
    if ((summary.taxa ?? []).length > rows.length) list.append(el('li', 'small muted', `Showing ${rows.length} of ${(summary.taxa ?? []).length} taxa.`));
  };
  for (const lens of lenses ?? []) {
    const button = el('button', 'lens-button', lens.label); button.type = 'button';
    button.setAttribute('aria-pressed', lens.id === 'all' ? 'true' : 'false');
    button.addEventListener('click', () => {
      for (const other of lensRow.querySelectorAll('button')) other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
      render(lens.id);
    });
    lensRow.append(button);
  }
  details.append(lensRow, list);
  render('all');
  return details;
}

function occurrenceTaxonRow(taxon) {
  const row = el('li', 'taxon-row');
  const head = el('p', 'taxon-head');
  head.append(el('strong', '', taxon.commonName ? `${taxon.commonName} (${taxon.scientificName ?? 'no scientific name'})` : taxon.scientificName ?? 'Unidentified taxon'));
  head.append(el('span', 'tag unknown', taxon.groupLabel ?? taxon.taxonomicGroup ?? 'other'));
  for (const kind of taxon.evidence ?? []) head.append(el('span', 'tag unknown', kind));
  row.append(head);
  const parts = [`${count(taxon.observations)} observation${taxon.observations === 1 ? '' : 's'}`, `source ${taxon.sourceLabels?.join(' + ') ?? 'unknown'}`];
  if (taxon.latestObservedAt) parts.push(`most recent ${String(taxon.latestObservedAt).slice(0, 10)}`);
  if (taxon.regionalOnly && taxon.nearestM == null) parts.push('distance not used — regional or obscured location');
  else if (taxon.nearestM != null) parts.push(`nearest eligible ${formatDistance(taxon.nearestM)}`);
  row.append(el('p', 'small muted', parts.join(' · ')));
  return row;
}

function occurrenceProvenance(occurrence) {
  const details = el('details', 'provenance-details');
  details.append(el('summary', '', 'Occurrence source & method'));
  details.append(el('p', 'small', occurrence.provenance?.method ?? 'Method unrecorded.'));
  details.append(el('p', 'small', occurrence.provenance?.privacyRule ?? ''));
  for (const summary of Object.values(occurrence.sources ?? {})) {
    details.append(el('p', 'small', `${summary.label} · ${summary.provenance?.product ?? 'product unrecorded'} · ${summary.provenance?.endpoint ?? 'endpoint unrecorded'} · retrieved ${summary.provenance?.retrievedAt ?? 'unknown'} · authentication ${summary.provenance?.authentication ?? 'unknown'}`));
    for (const query of (summary.provenance?.canonicalQueries ?? (summary.provenance?.canonicalQuery ? [summary.provenance.canonicalQuery] : [])).slice(0, 6)) details.append(el('p', 'small muted mono', query));
    if (summary.provenance?.privacyFilter) details.append(el('p', 'small muted', summary.provenance.privacyFilter));
    if (summary.provenance?.productScope) details.append(el('p', 'small muted', summary.provenance.productScope));
  }
  return details;
}

function queryButton(onQuery, label) {
  const button = el('button', 'quiet-button occurrence-query', label);
  button.type = 'button';
  button.addEventListener('click', () => { if (typeof onQuery === 'function') onQuery(); });
  return button;
}

function regionBounds(region) {
  if (!region) return 'bounds unrecorded';
  return `${region.swlat}, ${region.swlng} → ${region.nelat}, ${region.nelng}`;
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-US') : 'unknown';
}

// ACCESS & ROAD STATUS. A separate, first-class section: it answers a different question from geometry,
// ecology, habitat, or occurrence evidence, and it never borrows their language. A finding is shown with its
// guardrail rule, its date, its restrictions, its contradictions, and what is still unresolved.
export const ACCESS_FINDING_LABELS = Object.freeze({
  VERIFIED_PUBLIC: 'VERIFIED PUBLIC',
  PROBABLE_PUBLIC: 'PROBABLE PUBLIC',
  UNVERIFIED: 'UNVERIFIED',
  CONFLICTED: 'CONFLICTED',
  RESTRICTED_OR_CLOSED: 'RESTRICTED OR CLOSED',
});
export const ACCESS_FINDING_CLASS = Object.freeze({
  VERIFIED_PUBLIC: 'ok', PROBABLE_PUBLIC: 'caution', UNVERIFIED: 'unknown', CONFLICTED: 'warn', RESTRICTED_OR_CLOSED: 'warn',
});
export const PROBE_OUTCOME_LABELS = Object.freeze({
  EVIDENCE: 'evidence', NO_RELEVANT_EVIDENCE: 'no relevant evidence', FAILED: 'source failed', OPERATOR_ONLY: 'operator path only', NOT_RUN: 'not run',
});

const TIER_LABELS = Object.freeze({ 1: 'Tier 1 authority', 2: 'Tier 2 government data', 3: 'Tier 3 community map', 4: 'Tier 4 anecdotal' });
const formatDate = value => (value ? String(value).slice(0, 10) : 'date unrecorded');

function sourceLine(item) {
  const row = el('p', 'small access-source');
  row.append(el('span', 'tag unknown', TIER_LABELS[item.sourceTier] ?? 'tier unrecorded'), document.createTextNode(` ${item.sourceOrganization} · ${item.sourceTitle} · published ${formatDate(item.publishedAt)} · retrieved ${formatDate(item.retrievedAt)}${item.effectiveUntil ? ` · effective to ${formatDate(item.effectiveUntil)}` : ''}${item.recurrence ? ` · recurs (${item.recurrence})` : ''}`));
  if (String(item.sourceUrl ?? '').startsWith('https://')) {
    const link = el('a', '', ' source'); link.href = item.sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link);
  }
  return row;
}

function evidenceBlock(title, items, { sign = '', className = '' } = {}) {
  const block = el('div', `access-evidence ${className}`.trim());
  block.append(el('span', 'eyebrow', title));
  if (!items.length) { block.append(el('p', 'small muted', 'None.')); return block; }
  for (const item of items) {
    block.append(el('p', 'small access-claim', `${sign}${item.claimType}${item.claimValue ? `: ${item.claimValue}` : ''}${item.temporalScope ? ` · ${item.temporalScope.toLowerCase()}` : ''}`));
    if (item.geographicScope?.corridorPart) block.append(el('p', 'small muted', `Applies to: ${item.geographicScope.corridorPart}`));
    block.append(el('p', 'small muted', `“${item.quote.length > 240 ? `${item.quote.slice(0, 240)}…` : item.quote}”`));
    block.append(sourceLine(item));
    block.append(el('p', 'small', item.summary));
  }
  return block;
}

// The main Access & road status section. Restrained by default: the finding, its guardrail, restrictions,
// contradictions, and the unresolved list are visible; the stage log, every source check, and the adversarial
// checklist live behind disclosure elements.
export function renderAccessSection(investigation, { onRun = null, onExport = null, onReview = null, recordedCaptureAt = null, liveOsm = false,
  workerStatus = null, workerUrl = '', declaredSourceCount = null } = {}) {
  const node = section('Access & road status');
  node.classList.add('access-section');
  node.append(el('span', 'tag unknown', 'ACCESS EVIDENCE'));
  // A corridor discovered by candidate discovery has no reviewed research sources until a reviewer
  // declares them. That is expected, not an error: access stays UNVERIFIED and the panel says so.
  if (declaredSourceCount === 0) {
    node.append(el('p', 'small muted', 'No reviewed research sources are declared for this corridor. Access verification is UNVERIFIED; '
      + 'community mapping can still be replayed, and a reviewer can declare official sources for it later.'));
  }
  const boundary = researchBoundaryLine(workerStatus, workerUrl, recordedCaptureAt);
  if (!investigation) {
    node.append(el('p', 'small muted', 'No access verification has run for this corridor. The road geometry is evidence that the road is mapped, not that the public may drive it.'));
    node.append(el('p', 'small muted', boundary));
    if (onRun) node.append(runRow(onRun, { liveOsm, recordedCaptureAt, workerUrl }));
    return node;
  }
  const access = investigation.access;
  const human = access.human ?? null;
  const shown = human?.finding ?? access.finding;
  const header = el('div', `access-finding ${ACCESS_FINDING_CLASS[shown] ?? 'unknown'}`);
  header.append(el('span', 'eyebrow', 'Finding'), el('strong', 'access-finding-label', ACCESS_FINDING_LABELS[shown] ?? shown));
  header.append(el('p', 'small', human ? `Human review recorded ${formatDate(human.decidedAt)}: ${human.finding}. Automated finding: ${ACCESS_FINDING_LABELS[access.finding] ?? access.finding}.` : access.meaning));
  node.append(header);

  if (human?.annotation) node.append(el('p', 'small', `Human annotation: ${human.annotation}`));
  if (human?.automatedFinding && human.automatedFinding !== access.finding) {
    node.append(el('p', 'small warn-text', `The automated finding has since changed from ${ACCESS_FINDING_LABELS[human.automatedFinding] ?? human.automatedFinding} to ${ACCESS_FINDING_LABELS[access.finding] ?? access.finding}. Your annotation is kept; review whether it still applies.`));
  }
  const rows = [
    ['Public road evidence', access.publicRoadEvidence],
    ['Motor-vehicle access', access.motorVehicleAccess],
    ['Restrictions', access.restrictionsFound ? `${access.restrictions.filter(item => item.temporalScope === 'CURRENT' || item.temporalScope === 'RECURRING').length} in force or recurring` : 'No restriction in force'],
    ['Evidence checked', evidenceCheckedLabel(access, recordedCaptureAt)],
    ['Access verification coverage', `${access.coverage?.coverage ?? COVERAGE.UNKNOWN}`],
    ['Scope', access.scope?.wholeCorridor ? 'whole corridor' : access.scope?.note ?? 'unrecorded'],
    ['Guardrail rule', `${access.ruleId} — ${access.rule}`],
    ['Corridor', `${investigation.environment ?? 'environment unrecorded'} · transport ${investigation.transport ?? 'unrecorded'}`],
  ];
  node.append(factList(rows));
  if (access.coverage?.reason) node.append(el('p', 'small muted', access.coverage.reason));
  node.append(el('p', 'small muted', `Evidence mix: ${access.evidenceCounts.tier1} Tier 1 · ${access.evidenceCounts.tier2} Tier 2 · ${access.evidenceCounts.tier3} Tier 3 · ${access.evidenceCounts.tier4} Tier 4.`));

  if (access.contradictions.length) {
    const box = el('div', 'access-contradictions');
    box.append(el('span', 'eyebrow', `Contradictions and disagreements (${access.contradictions.length})`));
    for (const contradiction of access.contradictions) box.append(el('p', 'small', `${contradiction.kind}: ${contradiction.note}`));
    box.append(el('p', 'small muted', 'A contradiction is never resolved here by preference. Review the sources, then record a human finding if the conflict matters.'));
    node.append(box);
  }

  node.append(evidenceBlock('Supporting evidence', access.affirmative, { sign: '✓ ' }));
  node.append(evidenceBlock('Community-mapped evidence', access.community, { sign: '~ ', className: 'community' }));
  node.append(evidenceBlock('Restrictions and closures', access.restrictions, { sign: '! ', className: 'restrictions' }));
  if (access.notActing?.length) node.append(evidenceBlock('Restrictions that cannot act (expired, stale, or undated)', access.notActing, { sign: '· ', className: 'inactive' }));
  node.append(evidenceBlock('Caution (gates, unmaintained, similar road names)', access.attention, { sign: '? ', className: 'attention' }));

  if (access.unresolved.length) {
    const list = el('ul', 'access-unresolved');
    for (const item of access.unresolved) list.append(el('li', 'small', `${item.code}: ${item.text}`));
    const block = el('div', 'access-evidence');
    block.append(el('span', 'eyebrow', 'Unresolved'), list);
    node.append(block);
  }
  if (access.qualifiers.length) {
    const details = el('details', 'provenance-details');
    details.append(el('summary', '', `Qualifiers (${access.qualifiers.length})`));
    for (const qualifier of access.qualifiers) details.append(el('p', 'small', qualifier));
    node.append(details);
  }
  // How each source's answer was obtained, and whether a source has changed since the reviewed baseline.
  if (access.retrievalModes) node.append(el('p', 'small muted', `Source reads: ${access.retrievalModes.summary}.`));
  node.append(el('p', 'small muted', boundary));
  if (investigation.access.previousRun) {
    const block = el('div', 'access-evidence inactive');
    block.append(el('span', 'eyebrow', 'Previous run kept'), el('p', 'small', `${ACCESS_FINDING_LABELS[investigation.access.previousRun.finding] ?? investigation.access.previousRun.finding}${investigation.access.previousRun.ruleId ? ` (${investigation.access.previousRun.ruleId})` : ''} — ${investigation.access.previousRun.reason}.`),
      el('p', 'small muted', `Evaluated ${formatDate(investigation.access.previousRun.checkedAsOf)} · coverage ${investigation.access.previousRun.coverage ?? 'unrecorded'} · transport ${investigation.access.previousRun.transport ?? 'unrecorded'}`));
    node.append(block);
  }
  if (access.driftSummary?.changed) {
    const block = el('div', 'access-evidence attention');
    block.append(el('span', 'eyebrow', `Source drift (${access.driftSummary.changed})`), el('p', 'small', access.driftSummary.note));
    for (const probe of investigation.research.probes) {
      const state = probe.drift?.worker?.state ?? probe.drift?.recorded?.state ?? null;
      const comparedAgainst = probe.drift?.worker?.state ? 'the Worker baseline' : 'the reviewed capture';
      if (state !== 'EVIDENCE_CHANGED' && state !== 'NO_LONGER_MATCHES') continue;
      block.append(el('p', 'small', `${probe.organization} · ${probe.url} — ${state} against ${comparedAgainst}.`));
      const removed = probe.drift?.worker?.removed ?? probe.drift?.recorded?.removed ?? [];
      const added = probe.drift?.worker?.added ?? probe.drift?.recorded?.added ?? [];
      for (const quote of removed.slice(0, 3)) block.append(el('p', 'small muted', `no longer found: “${quote.slice(0, 160)}”`));
      for (const quote of added.slice(0, 3)) block.append(el('p', 'small muted', `newly found: “${quote.slice(0, 160)}”`));
    }
    block.append(el('p', 'small muted', 'A changed page is not a changed finding: the facts above are what the source says now, and the guardrail rules decide from them.'));
    node.append(block);
  }
  if (investigation.transportFallback) node.append(el('p', 'small warn-text', `The live Worker boundary could not answer, so this run replayed the reviewed capture instead (${investigation.transportFallback.reason}).`));

  // Research may be re-requested at any time: a dated finding is a snapshot, and the reader decides when to
  // refresh it. The recorded/deferred note stays attached so a replay is never mistaken for a fresh check.
  if (onRun) node.append(runRow(onRun, { liveOsm, recordedCaptureAt, workerUrl, label: 'Re-check access evidence' }));
  return node;
}

// When the evidence was read, and how — a live read must never be labelled as a recorded run.
function evidenceCheckedLabel(access, recordedCaptureAt) {
  const modes = access.retrievalModes ?? {};
  const liveReads = (modes.live ?? 0) + (modes.cache ?? 0);
  const date = formatDate(access.evidenceCheckedAt);
  if (liveReads) return `${date} (${liveReads} source(s) read live through the Worker boundary${modes.replayed ? `, ${modes.replayed} replayed` : ''})`;
  return `${date}${recordedCaptureAt ? ` (recorded operator run ${formatDate(recordedCaptureAt)})` : ''}`;
}

// What the browser can and cannot read directly, stated plainly next to the finding it affects.
function researchBoundaryLine(workerStatus, workerUrl, recordedCaptureAt) {
  if (!workerUrl) return `Official-source research: no live boundary is configured for this build, so sources replay the reviewed operator capture${recordedCaptureAt ? ` of ${formatDate(recordedCaptureAt)}` : ''}. Those sources are reported as deferred, not freshly checked.`;
  if (!workerStatus) return `Official-source research: a live boundary is configured at ${workerUrl} and is checked when you run the investigation.`;
  const probeCount = (workerStatus.probeIds ?? []).length;
  return workerStatus.available
    ? `Official-source research: live through the Road Naturalist Worker boundary (${workerUrl}, ${workerStatus.worker ?? 'version unrecorded'}, ${probeCount} declared probe(s)); the reviewed capture stays available as the fallback.`
    : `Official-source research: the Worker boundary at ${workerUrl} is unavailable (${workerStatus.reason}), so sources replay the reviewed capture${recordedCaptureAt ? ` of ${formatDate(recordedCaptureAt)}` : ''} and are reported as deferred.`;
}

function runRow(onRun, { liveOsm, recordedCaptureAt, workerUrl = '', label = 'Run access investigation' }) {
  const row = el('div', 'access-actions');
  const button = el('button', label === 'Run access investigation' ? 'primary-button' : 'quiet-button', label);
  button.type = 'button';
  button.addEventListener('click', () => onRun({ refresh: true, liveOsm: Boolean(liveOsm) }));
  row.append(button);
  const sourceLine = workerUrl
    ? `Official sources will be read live through the Worker boundary at ${workerUrl}.`
    : `Official sources replay the reviewed operator run${recordedCaptureAt ? ` captured ${formatDate(recordedCaptureAt)}` : ''}.`;
  row.append(el('span', 'small muted', `${sourceLine} OpenStreetMap ${liveOsm ? 'will be queried live' : 'replays the same capture'}.`));
  return row;
}

// The investigation record: stages, source checks, adversarial review, and the human review controls. This is
// where a reader can see how the finding was reached and where they can disagree with it without erasing it.
export function renderInvestigationSection(investigation, { onReview = null, onExport = null, candidateId = null, bundleReady = false } = {}) {
  const node = section('Investigation record');
  node.classList.add('investigation-section');
  if (!investigation) {
    node.append(el('p', 'small muted', 'The staged investigation has not run for this corridor. Access stays unverified until it does.'));
    return node;
  }
  const access = investigation.access;
  const stages = el('ol', 'stage-list');
  for (const stage of investigation.stages) {
    const row = el('li', `stage ${stage.status}`);
    row.append(el('span', 'stage-status', `${stage.status}`), el('strong', '', stage.label), el('p', 'small', stage.summary));
    const counters = Object.entries(stage.counters ?? {}).map(([key, value]) => `${key} ${value}`).join(' · ');
    if (counters) row.append(el('p', 'small muted', counters));
    for (const warning of stage.warnings ?? []) row.append(el('p', 'small warn-text', warning));
    stages.append(row);
  }
  const stagesBlock = el('div', 'access-evidence');
  stagesBlock.append(el('span', 'eyebrow', `Stages (${investigation.stageSummary.complete} complete · ${investigation.stageSummary.warning} warning · ${investigation.stageSummary.failed} failed)`), stages);
  node.append(stagesBlock);

  const review = access.review;
  if (review) {
    const checks = el('ul', 'adversarial-list');
    for (const check of review.checks) checks.append(el('li', `small ${check.outcome.toLowerCase()}`, `${check.outcome} — ${check.question} ${check.note}`));
    const details = el('details', 'provenance-details');
    details.open = review.concerns.length > 0;
    details.append(el('summary', '', `Adversarial review (${review.concerns.length} concern(s))`), checks);
    node.append(details);
  }

  if (access.provisionalFinding && access.findingsChangedByReview !== false && access.findingChangedByReview != null) {
    node.append(el('p', 'small', `Provisional finding before the contradiction search and adversarial review: ${ACCESS_FINDING_LABELS[access.provisionalFinding] ?? access.provisionalFinding}. Final finding: ${ACCESS_FINDING_LABELS[access.finding] ?? access.finding}${access.findingChangedByReview ? ' (changed by the review)' : ' (unchanged)'}.`));
  }

  const probeRows = el('ul', 'source-list');
  for (const probe of investigation.research.probes) {
    const row = el('li', `source ${probe.outcome.toLowerCase()}`);
    row.append(el('span', 'tag unknown', PROBE_OUTCOME_LABELS[probe.outcome] ?? probe.outcome), el('strong', '', probe.organization));
    row.append(el('p', 'small', probe.question));
    row.append(el('p', 'small muted', `${probe.title} · retrieved ${formatDate(probe.searched?.retrievedAt)}${probe.searched?.httpStatus ? ` · HTTP ${probe.searched.httpStatus}` : ''}`));
    row.append(el('p', 'small muted', `read ${retrievalModeOf(probe)}${probe.searched?.cacheStatus ? ` (cache ${probe.searched.cacheStatus.toLowerCase()})` : ''}${driftLabelOf(probe)}`));
    if (String(probe.url ?? '').startsWith('https://')) { const link = el('a', '', 'source'); link.href = probe.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(el('span', 'small', ' '), link); }
    if (probe.note) row.append(el('p', 'small muted', probe.note));
    probeRows.append(row);
  }
  const sourcesBlock = el('div', 'access-evidence');
  sourcesBlock.append(el('span', 'eyebrow', `Sources checked (${investigation.research.probes.length})`), probeRows);
  node.append(sourcesBlock);

  if (investigation.osm) {
    const osm = investigation.osm;
    const rows = [['OpenStreetMap status', osm.status],
      ['Retrieved', `${formatDate(osm.retrievedAt)}${osm.capturedAt ? ` (recorded ${formatDate(osm.capturedAt)})` : ''}`],
      ['Mirrors used', osm.mirrorsUsed?.join(', ') || 'none'],
      ['Search names', (osm.searchNames ?? []).join(' | ')],
      ['Ways matched', osm.match ? `${osm.match.matchedWayCount} of ${osm.match.candidateWayCount} within ${osm.match.toleranceM} m` : 'not measured'],
      ['Corridor matched', osm.match ? `${(osm.match.matchedFraction * 100).toFixed(1)}% at ${osm.match.sampleIntervalM} m sampling` : 'not measured'],
      ['Name variants seen', (osm.nameVariants ?? []).map(variant => `${variant.name} (${variant.relation.toLowerCase().replace(/_/g, ' ')})`).join(' · ') || 'none']];
    const details = el('details', 'provenance-details');
    details.append(el('summary', '', 'OpenStreetMap road context'), factList(rows));
    if (osm.match?.method) details.append(el('p', 'small muted', osm.match.method));
    for (const way of (osm.waySummaries ?? []).slice(0, 12)) details.append(el('p', 'small', `${way.highway ?? 'highway unrecorded'} · ${way.name ?? 'unnamed'} · ${way.ref ?? 'no ref'} · ${way.surface ?? 'surface unrecorded'} · access tag ${way.accessSignal === 'ABSENT' ? 'absent' : way.accessSignal}`));
    for (const failure of osm.failures ?? []) details.append(el('p', 'small warn-text', `Mirror failure: ${failure.mirror ?? 'transport'} — ${failure.reason}`));
    node.append(details);
  }

  node.append(renderHumanReview(access, { onReview, candidateId }));
  if (onExport) {
    const row = el('div', 'access-actions');
    const button = el('button', 'quiet-button', bundleReady ? 'Export evidence bundle (JSON)' : 'Export evidence bundle');
    button.type = 'button';
    button.addEventListener('click', () => onExport());
    row.append(button, el('span', 'small muted', 'The bundle carries summaries, evidence, provenance, coverage, and freshness. It carries no credential, no observation record, and no raw GIS data.'));
    node.append(row);
  }
  return node;
}

// How a source's answer was obtained: live through the boundary, served from the boundary's cache, replayed from the
// reviewed capture, or deferred because this environment cannot read it at all.
function retrievalModeOf(probe) {
  const mode = probe.searched?.retrievalMode ?? null;
  if (mode === 'LIVE') return 'live read (worker boundary)';
  if (mode === 'CACHE') return 'cache read (worker boundary)';
  return probe.deferred ? 'deferred read (not re-checked here)' : 'replayed from the reviewed capture';
}

function driftLabelOf(probe) {
  const state = probe.drift?.worker?.state ?? probe.drift?.recorded?.state ?? null;
  if (!state || state === 'UNCHANGED' || state === 'NO_BASELINE') return '';
  return ` · drift ${state.toLowerCase().replace(/_/g, ' ')}`;
}

function renderHumanReview(access, { onReview, candidateId }) {
  const block = el('div', 'access-evidence human-review');
  block.append(el('span', 'eyebrow', 'Human review'));
  block.append(el('p', 'small muted', 'A human finding is recorded alongside the automated one; the automated result is never erased.'));
  if (access.human) {
    block.append(el('p', 'small', `Recorded ${formatDate(access.human.decidedAt)}: ${ACCESS_FINDING_LABELS[access.human.finding] ?? access.human.finding}${access.human.annotation ? ` — ${access.human.annotation}` : ''}`));
    if (access.human.automatedFinding) block.append(el('p', 'small muted', `Recorded when the automated finding was ${ACCESS_FINDING_LABELS[access.human.automatedFinding] ?? access.human.automatedFinding}.`));
  }
  if (!onReview) return block;
  const select = el('select', 'review-select');
  for (const finding of ['', 'VERIFIED_PUBLIC', 'PROBABLE_PUBLIC', 'UNVERIFIED', 'CONFLICTED', 'RESTRICTED_OR_CLOSED']) {
    const option = el('option', '', finding ? ACCESS_FINDING_LABELS[finding] : 'Automated finding only');
    option.value = finding;
    select.append(option);
  }
  select.value = access.human?.finding ?? '';
  const note = el('textarea', 'review-note');
  note.rows = 2; note.placeholder = 'Annotation (what you checked, what you disagree with) — optional';
  note.value = access.human?.annotation ?? '';
  const button = el('button', 'quiet-button', 'Record human review');
  button.type = 'button';
  button.addEventListener('click', () => onReview({ candidateId, finding: select.value || null, annotation: note.value.trim() || null }));
  const row = el('div', 'access-actions');
  row.append(select, button);
  block.append(row, note);
  return block;
}
