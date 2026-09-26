import { COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';
import { DEFAULT_SORT_NOTE, SORT_OPTIONS, WETLAND_FILTERS, coverageFlag, ecoregionOptions, filterAndSort } from '../discovery/filter.js';
import { DISCOVERY_STATUS } from '../discovery/lifecycle.js';
import { DISCOVERY_DISPOSITION } from '../discovery/eligibility.js';
import { MAX_RESULT_ROWS, SEGMENTED_ROAD_NOTE } from '../discovery/constants.js';
import { formatArea, formatDistance, formatLength } from './render.js';

// The discovery workspace: choose a bounded area, run the deterministic survey, filter and sort the
// measured facts, inspect one corridor, and promote what deserves a closer look. It never runs
// occurrence queries or access research, and it never shows a score: every column is a measured value.

function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

const CLASS_LABELS = Object.freeze({ S1200: 'Secondary road', S1400: 'Local road' });

export function renderDiscovery(container, { discovery, searchAreas = [], searchAreaId = null, onDiscover, onSelect, onPromote, onDismiss,
  onFilters, onSort, onSearchArea } = {}) {
  container.replaceChildren();
  container.append(controls({ discovery, searchAreas, searchAreaId, onDiscover, onSearchArea }));
  if (discovery.error) container.append(el('p', 'discovery-error', discovery.error));
  if (discovery.coverage) container.append(coverageBanner(discovery.coverage, discovery.diagnostics));
  const selected = discovery.selectedId ? discovery.results.find(result => result.id === discovery.selectedId) : null;
  if (discovery.status === 'ready' && discovery.results.length) {
    const view = filterAndSort(discovery.results, discovery.filters, discovery.sort);
    container.append(toolbar({ discovery, results: discovery.results, view, onFilters, onSort }));
    container.append(resultTable(view, discovery, onSelect));
    container.append(el('p', 'discovery-note', DEFAULT_SORT_NOTE));
    container.append(el('p', 'discovery-note', SEGMENTED_ROAD_NOTE));
  } else if (discovery.status === 'ready') {
    container.append(el('p', 'discovery-note', 'No discovery corridor was proposed in this search area. That is a result about the declared filters and data coverage, not a statement about the roads on the ground.'));
  }
  if (selected) container.append(selectedResult(selected, { onPromote, onDismiss, onSelect }));
  return container;
}

function controls({ discovery, searchAreas, searchAreaId, onDiscover, onSearchArea }) {
  const block = el('div', 'discovery-controls');
  if (searchAreas.length > 1) {
    const label = el('label', 'discovery-field', 'Search area');
    const select = el('select', 'discovery-select');
    select.id = 'discovery-area';
    for (const area of searchAreas) {
      const option = el('option', null, area.name);
      option.value = area.id;
      if (area.id === searchAreaId) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', event => onSearchArea?.(event.target.value));
    label.append(select);
    block.append(label);
  } else if (searchAreas.length === 1) {
    block.append(el('p', 'discovery-area', `Search area: ${searchAreas[0].name}`));
  }
  const button = el('button', 'primary-button', discovery.status === 'running' ? 'Discovering…' : 'Discover roads');
  button.type = 'button';
  button.id = 'discover-roads';
  // The button is created together with its listener, so it never needs a pre-attach disabled state. It
  // does stay disabled until the search-area declaration has loaded: a survey cannot run without one.
  button.disabled = discovery.status === 'running' || !searchAreas.length;
  button.addEventListener('click', () => onDiscover?.());
  block.append(button);
  if (!searchAreas.length) block.append(el('p', 'discovery-status', 'Loading the discovery search-area declaration…'));
  if (discovery.status === 'running') {
    block.append(el('p', 'discovery-status', discovery.phase || 'Preparing search…'));
  } else if (discovery.status === 'unavailable' && !discovery.error) {
    block.append(el('p', 'discovery-status', 'The road-network extract could not be read.'));
  }
  return block;
}


function coverageBanner(coverage, diagnostics) {
  const block = el('div', `discovery-coverage ${coverage.coverage === COVERAGE.FULL ? 'ok' : 'caution'}`);
  block.append(el('span', 'eyebrow', 'Discovery coverage'));
  block.append(el('strong', null, `Discovery coverage ${coverage.coverage}`));
  const counts = coverage.counts ?? {};
  block.append(el('p', 'small', `${counts.corridors ?? 0} discovery corridor(s) proposed in this area · `
    + `${counts.fullHabitat ?? 0} with full wetland and hydrography coverage · `
    + `${counts.excludedFeatureCount ?? 0} source feature(s) outside the eligible classes · `
    + `${counts.droppedShortUnits ?? 0} named road unit(s) shorter than the minimum corridor length`));
  if (coverage.reason) block.append(el('p', 'small', `Reason: ${coverage.reason}`));
  if (coverage.note) block.append(el('p', 'small muted', coverage.note));
  if (diagnostics?.counts?.unbufferableCorridors) {
    block.append(el('p', 'small', `${diagnostics.counts.unbufferableCorridors} corridor(s) have UNKNOWN habitat coverage: `
      + 'the geometry engine could not buffer that source geometry, so no habitat was measured there (unknown, not zero).'));
  }
  if (diagnostics?.counts) {
    const selection = diagnostics.partitionSelection;
    if (diagnostics.searchShape?.kind === 'radius') {
      const shape = diagnostics.searchShape;
      block.append(el('p', 'small muted', `Search region: ${shape.radiusMiles}-mile radius around `
        + `${shape.center[1].toFixed(3)}, ${shape.center[0].toFixed(3)} · cells are selected by the bounding box, `
        + 'corridors are kept only where the road crosses the disk.'));
    }
    if (selection) {
      block.append(el('p', 'small muted', `Search data: ${selection.counts.roads} road, ${selection.counts.wetlands} wetland, `
        + `${selection.counts.hydrography} hydrography partitions · ${(selection.bytes / 1048576).toFixed(1)} MiB verified · 1 km habitat halo.`));
      const empty = Object.values(selection.emptyCounts ?? {}).reduce((sum, value) => sum + value, 0);
      const closure = selection.closure;
      if (empty) block.append(el('p', 'small muted', `${empty} selected partition(s) are declared covered and empty: `
        + 'the published source has nothing mapped there, which is a measured zero rather than missing data.'));
      if (closure?.addedCells) block.append(el('p', 'small muted', `Road-name continuity added ${closure.addedCells} `
        + `cell(s) (${(closure.addedBytes / 1048576).toFixed(1)} MiB) beyond the ${closure.baseCells} cell(s) the search box selects, `
        + `so ${closure.selectedNames} named road group(s) are complete before composition.`));
    }
    if (diagnostics.partitionTimingMs) {
      const timing = diagnostics.partitionTimingMs;
      block.append(el('p', 'small muted', `Data preparation ${timing.totalPreparationMs} ms · downloaded ${(timing.downloadedBytes / 1048576).toFixed(1)} MiB · `
        + `${timing.cacheHits} verified partition cache hit(s).`));
    }
    block.append(el('p', 'small muted', `Measured in ${diagnostics.totalMs} ms: ${diagnostics.counts.features} road features read, `
      + `${diagnostics.counts.eligibleUnits} named road units composed, ${diagnostics.counts.corridors} corridors analysed in one GIS batch `
      + `(${diagnostics.analysisMs} ms), ${diagnostics.roadQueryMs} ms for the road-network query.`));
    const phases = diagnostics.batch?.phaseMs ?? {};
    const breakdown = Object.entries(phases).map(([key, value]) => `${key} ${value} ms`).join(' · ');
    if (breakdown) block.append(el('p', 'small muted', `Batch phases: ${breakdown}.`));
  }
  if (diagnostics?.batch?.reason) block.append(el('p', 'small', `Batch diagnostics: ${diagnostics.batch.reason}`));
  return block;
}

function toolbar({ discovery, results, view, onFilters, onSort }) {
  const filters = discovery.filters ?? {};
  const form = el('form', 'discovery-filters');
  form.addEventListener('submit', event => event.preventDefault());
  form.append(numberField('discovery-min-length', 'Min length (mi)', filters.minLengthMi, '0.5', id => onFilters?.({ ...filters, minLengthMi: id })));
  form.append(numberField('discovery-max-length', 'Max length (mi)', filters.maxLengthMi, '0.5', id => onFilters?.({ ...filters, maxLengthMi: id })));
  const wetlandField = el('label', 'discovery-field', 'Mapped wetland');
  const wetland = el('select', 'discovery-select');
  wetland.id = 'discovery-wetland';
  for (const option of WETLAND_FILTERS) {
    const item = el('option', null, option.label);
    item.value = option.key;
    if (option.key === filters.wetland) item.selected = true;
    wetland.append(item);
  }
  wetland.addEventListener('change', () => onFilters?.({ ...filters, wetland: wetland.value }));
  wetlandField.append(wetland);
  form.append(wetlandField);
  form.append(numberField('discovery-max-nearest-wetland', 'Max nearest wetland (m)', filters.maxNearestWetlandM, '50', id => onFilters?.({ ...filters, maxNearestWetlandM: id })));
  form.append(numberField('discovery-min-crossings', 'Min water crossings', filters.minCrossings, '1', id => onFilters?.({ ...filters, minCrossings: id })));
  const classes = el('div', 'discovery-field');
  classes.append(el('span', null, 'Road class'));
  for (const code of ['S1400', 'S1200']) {
    const label = el('label', 'discovery-check');
    const input = el('input');
    input.type = 'checkbox';
    input.value = code;
    input.checked = (filters.roadClasses ?? []).includes(code);
    input.addEventListener('change', () => {
      const chosen = new Set(filters.roadClasses ?? []);
      if (input.checked) chosen.add(code); else chosen.delete(code);
      onFilters?.({ ...filters, roadClasses: [...chosen].sort() });
    });
    label.append(input, el('span', null, `${CLASS_LABELS[code] ?? code} (${code})`));
    classes.append(label);
  }
  form.append(classes);
  const options = ecoregionOptions(results);
  if (options.length) {
    const ecoregionField = el('label', 'discovery-field', 'Ecoregion');
    const select = el('select', 'discovery-select');
    select.id = 'discovery-ecoregion';
    const any = el('option', null, 'Any');
    any.value = '';
    select.append(any);
    for (const option of options) {
      const item = el('option', null, option.label);
      item.value = option.code;
      if (option.code === filters.ecoregion) item.selected = true;
      select.append(item);
    }
    select.addEventListener('change', () => onFilters?.({ ...filters, ecoregion: select.value || null }));
    ecoregionField.append(select);
    form.append(ecoregionField);
  }
  const reset = el('button', 'quiet-button', 'Reset filters');
  reset.type = 'button';
  reset.addEventListener('click', () => onFilters?.(null));
  form.append(reset);
  const sortField = el('label', 'discovery-field', 'Sort by');
  const sort = el('select', 'discovery-select');
  sort.id = 'discovery-sort';
  for (const option of SORT_OPTIONS) {
    const item = el('option', null, `${option.label}${option.unit ? ` (${option.unit})` : ''}`);
    item.value = option.key;
    if (option.key === discovery.sort) item.selected = true;
    sort.append(item);
  }
  sort.addEventListener('change', () => onSort?.(sort.value));
  sortField.append(sort);
  form.append(sortField);
  const wrapper = el('div', 'discovery-toolbar');
  wrapper.append(form, el('p', 'discovery-count', `${view.length} of ${results.length} corridor(s) shown`));
  return wrapper;
}

function numberField(id, label, value, step, onChange) {
  const field = el('label', 'discovery-field', label);
  const input = el('input', 'discovery-input');
  input.type = 'number';
  input.id = id;
  input.min = '0';
  input.step = step;
  input.placeholder = 'any';
  if (value != null) input.value = String(value);
  input.addEventListener('change', () => onChange(input.value === '' ? null : Number(input.value)));
  field.append(input);
  return field;
}

function resultTable(results, discovery, onSelect) {
  const wrapper = el('div', 'discovery-table-wrap');
  const table = el('table', 'discovery-table');
  table.id = 'discovery-results';
  const head = el('thead');
  const headRow = el('tr');
  for (const label of ['Road', 'Length', 'Wetland ≤250 m', 'Crossings', 'Ecoregion', 'Coverage', 'Status']) headRow.append(el('th', null, label));
  head.append(headRow);
  table.append(head);
  const body = el('tbody');
  for (const result of results.slice(0, MAX_RESULT_ROWS)) {
    const row = el('tr');
    row.className = result.id === discovery.selectedId ? 'selected'
      : result.status === DISCOVERY_STATUS.PROMOTED ? 'promoted' : result.status === DISCOVERY_STATUS.DISMISSED ? 'dismissed' : '';
    const nameCell = el('td');
    const button = el('button', 'discovery-row', result.name);
    button.type = 'button';
    button.setAttribute('aria-current', result.id === discovery.selectedId ? 'true' : 'false');
    button.addEventListener('click', () => onSelect?.(result.id));
    nameCell.append(button, el('small', 'muted', `${formatLength(result.lengthM)} · ${result.road.classes.join(', ') || 'class not provided'}`
      + (result.road.segmentation.count > 1 ? ` · segment ${result.road.segmentation.index}/${result.road.segmentation.count}` : '')));
    row.append(nameCell);
    row.append(el('td', null, `${(result.lengthM / 1609.344).toFixed(1)} mi`));
    row.append(el('td', null, result.signals.wetlands.area250M2 > 0 ? formatArea(result.signals.wetlands.area250M2) : '0'));
    row.append(el('td', null, String(result.signals.hydrography.crossingCount)));
    row.append(el('td', null, result.ecology.level3?.primary ? `${result.ecology.level3.primary.name} (${result.ecology.level3.primary.code})` : 'Unknown'));
    row.append(el('td', null, coverageFlag(result)));
    row.append(el('td', null, result.status));
    body.append(row);
  }
  table.append(body);
  wrapper.append(table);
  if (results.length > MAX_RESULT_ROWS) {
    wrapper.append(el('p', 'discovery-note', `Showing the first ${MAX_RESULT_ROWS} of ${results.length} corridors. Narrow the filters to see the rest; the map draws the same first ${MAX_RESULT_ROWS}.`));
  }
  return wrapper;
}


// One honest sentence about the geometry the spatial engine was given. A benign repair states what it
// did without a warning banner; a corridor whose analysis is unavailable already carries that reason in
// its coverage rows, so this line never contradicts them.
function analyticalGeometryLine(facts) {
  if (!facts) return 'Not recorded';
  if (facts.method === 'none') return 'Canonical corridor geometry used directly (no repair needed)';
  const removed = facts.removedDuplicateLengthM ? ` · ${Math.round(facts.removedDuplicateLengthM).toLocaleString('en-US')} m of doubled centerline traversal not counted twice` : '';
  return `Minor topology repair applied (${facts.method}): canonical road geometry preserved, nothing moved${removed}`;
}

function selectedResult(result, { onPromote, onDismiss, onSelect }) {
  const block = el('div', 'discovery-selected');
  block.id = 'discovery-selected';
  block.append(el('span', 'eyebrow', 'Selected discovery corridor'));
  block.append(el('h3', null, `${result.name} (${result.id})`));
  const facts = el('dl', 'coverage-list discovery-facts');
  const rows = [
    ['Length', `${(result.lengthM / 1609.344).toFixed(2)} mi · ${Math.round(result.lengthM).toLocaleString('en-US')} m`],
    ['Road class', result.road.classes.join(' · ') || 'Not provided by this source'],
    ['Counties', result.road.counties.join(' · ') || 'Not recorded'],
    ['Source features', `${result.road.sourceFeatureCount} feature(s)`],
    ['Nearest mapped wetland', result.signals.wetlands.nearestM == null ? 'Unknown' : formatDistance(result.signals.wetlands.nearestM)],
    ['Mapped wetland within 250 m', result.signals.wetlands.area250M2 ? formatArea(result.signals.wetlands.area250M2) : 'None mapped'],
    ['Mapped wetland within 1 km', result.signals.wetlands.area1000M2 ? formatArea(result.signals.wetlands.area1000M2) : 'None mapped'],
    ['Corridor intersects a mapped wetland', result.signals.wetlands.intersectsCorridor ? 'Yes (mapped geometry)' : 'No'],
    ['Mapped water crossings', `${result.signals.hydrography.crossingCount}`],
    ['Nearest flowing water', result.signals.hydrography.nearestFlowingM == null ? 'Unknown' : formatDistance(result.signals.hydrography.nearestFlowingM)],
    ['Nearest standing water', result.signals.hydrography.nearestStandingM == null ? 'Unknown' : formatDistance(result.signals.hydrography.nearestStandingM)],
    ['Flowline length within 1 km', result.signals.hydrography.flowlineLength1000M ? formatLength(result.signals.hydrography.flowlineLength1000M) : 'None mapped'],
    ['Primary ecoregion', result.ecology.level3?.primary ? `${result.ecology.level3.primary.name} (${result.ecology.level3.primary.code})` : 'Unknown'],
    ['Ecoregions crossed', `${result.ecology.ecoregionCount}`],
    ['Analytical geometry', analyticalGeometryLine(result.provenance.geometryForAnalysis)],
  ];
  for (const [label, value] of rows) {
    const row = el('div');
    row.append(el('dt', null, label), el('dd', null, value));
    facts.append(row);
  }
  block.append(facts);
  const coverageList = el('dl', 'coverage-list discovery-coverage-list');
  const labels = { [COVERAGE_DATASET.ROAD_NETWORK]: 'Road network', [COVERAGE_DATASET.WETLANDS]: 'Wetlands', [COVERAGE_DATASET.HYDROGRAPHY]: 'Hydrography' };
  for (const [datasetId, entry] of Object.entries(result.coverage)) {
    const row = el('div');
    row.append(el('dt', null, labels[datasetId] ?? datasetId), el('dd', null, `${entry.coverage}${entry.reason ? ` — ${entry.reason}` : ''}`));
    coverageList.append(row);
  }
  block.append(coverageList);
  const notRun = el('div', 'discovery-not-run');
  notRun.append(el('p', 'small', 'Access verification: NOT YET RUN / UNVERIFIED. Discovery does not research access, and presence in a road centerline dataset is not evidence of legal public access.'));
  notRun.append(el('p', 'small', 'Occurrence sources: not queried. Species evidence is an explicit deeper-analysis step after promotion.'));
  block.append(notRun);
  const actions = el('div', 'discovery-actions');
  const promote = el('button', 'primary-button', 'Promote candidate');
  promote.type = 'button';
  promote.id = 'discovery-promote';
  promote.addEventListener('click', () => onPromote?.(result.id));
  const dismiss = el('button', 'quiet-button', result.status === DISCOVERY_STATUS.DISMISSED ? 'Restore to discovered' : 'Dismiss');
  dismiss.type = 'button';
  dismiss.id = 'discovery-dismiss';
  dismiss.addEventListener('click', () => onDismiss?.(result.id));
  const clear = el('button', 'quiet-button', 'Clear selection');
  clear.type = 'button';
  clear.addEventListener('click', () => onSelect?.(null));
  actions.append(promote, dismiss, clear);
  block.append(actions);
  return block;
}

export function eligibilityNote(eligibility) {
  const excluded = (eligibility ?? []).filter(entry => entry.key.startsWith(DISCOVERY_DISPOSITION.EXCLUDED)
    || entry.key.startsWith(DISCOVERY_DISPOSITION.SEPARATE));
  if (!excluded.length) return '';
  return `Not proposed: ${excluded.slice(0, 4).map(entry => `${entry.key} (${entry.count})`).join(', ')}`
    + `${excluded.length > 4 ? `, and ${excluded.length - 4} more` : ''}.`;
}
