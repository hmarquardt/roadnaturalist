import { COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';
import { DEFAULT_SORT_NOTE, SORT_OPTIONS, WETLAND_FILTERS, coverageFlag, ecoregionOptions, filterAndSort } from '../discovery/filter.js';
import { DISCOVERY_STATUS } from '../discovery/lifecycle.js';
import { DISCOVERY_DISPOSITION } from '../discovery/eligibility.js';
import { MAX_RESULT_ROWS, SEGMENTED_ROAD_NOTE } from '../discovery/constants.js';
import { CUSTOM_SEARCH_AREA_ID, DEFAULT_RADIUS_MILES, MAX_RADIUS_MILES, MIN_RADIUS_MILES, RADIUS_STOPS_MILES,
  areaCoverage, formatCenter, formatRadius, radiusNumber, readSearchDefinition, searchIsRunnable,
  searchRefusal, searchRegionCoverage, storedDefinition } from '../discovery/search-definition.js';
import { placeLabel, placeTypeLabel, searchPlaces, nearestPlace } from '../discovery/place-gazetteer.js';
import { CENTER_LABEL_KIND, CONTEXT_NOTE, centerPresentation, formatContextDistance, formatContextDirection, runCenterPresentation } from '../discovery/search-context.js';
import { LOCATION_STATUS, accuracyLabel } from '../discovery/geolocation.js';
import { formatArea, formatDistance, formatLength } from './render.js';

// The discovery workspace: choose a bounded area, run the deterministic survey, filter and sort the
// measured facts, inspect one corridor, and promote what deserves a closer look. It never runs
// occurrence queries or access research, and it never shows a score: every column is a measured value.
//
// A search is either a declared window or a centre and radius a person chose. Both are the same thing to the
// run - a search area - so the panel never offers two ways to discover roads, only two ways to say where.

function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

const CLASS_LABELS = Object.freeze({ S1200: 'Secondary road', S1400: 'Local road' });

export function renderDiscovery(container, { discovery, searchAreas = [], searchAreaId = null, search = null,
  presets = [], region = null, gazetteer = null, onDiscover, onSelect, onPromote, onDismiss, onFilters, onSort, onSearchArea,
  onSearchDefinition, onSearchRadius, onSearchPicking, onPreview, onSelectPlace, onUseLocation, locationSupported = false } = {}) {
  container.replaceChildren();
  container.append(controls({ discovery, searchAreas, searchAreaId, search, presets, region, gazetteer, onDiscover,
    onSearchArea, onSearchDefinition, onSearchRadius, onSearchPicking, onPreview, onSelectPlace, onUseLocation, locationSupported }));
  if (discovery.error) container.append(el('p', 'discovery-error', discovery.error));
  // A promotion that could not be completed says so, with the reason the application actually hit. It used to
  // be state that nothing rendered: pressing Promote on a published object that was never uploaded looked
  // exactly like a page that was still thinking, and no test could tell a refused promotion from a slow one.
  if (discovery.promotionError) {
    const note = el('p', 'discovery-error', `Promotion stopped: ${discovery.promotionError.reason}`);
    note.id = 'discovery-promotion-error';
    container.append(note);
  }
  if (search?.error) container.append(el('p', 'discovery-error', search.error));
  if (discovery.coverage) container.append(coverageBanner(discovery.coverage, discovery.diagnostics, discovery.searchArea,
    runCenterLabel({ discovery, search, gazetteer })));
  const stale = staleResults({ discovery, search, searchAreaId });
  if (stale) container.append(el('p', 'discovery-note', stale));
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

// Changing the search does not silently re-run it: the results stay on screen, marked as belonging to the
// search that produced them, until a person starts the new one.
function staleResults({ discovery, search, searchAreaId }) {
  const area = discovery.searchArea;
  if (!area || discovery.status !== 'ready') return null;
  const activeId = searchAreaId ?? null;
  const draft = search?.definition ?? null;
  const sameDefinition = activeId !== CUSTOM_SEARCH_AREA_ID ? (area.id ?? null) === activeId
    : Boolean(draft && area.center && draft.radiusMiles === area.radiusMiles
      && draft.center[0] === area.center[0] && draft.center[1] === area.center[1]);
  if (sameDefinition) return null;
  const previous = area.radiusMiles ? `${area.radiusMiles}-mile search at ${formatCenter(area.center)}` : `search area ${area.name ?? area.id}`;
  return `These results are from the previous search (${previous}). Choose a centre and radius, then search again to replace them.`;
}

function controls({ discovery, searchAreas, searchAreaId, search, presets, region, gazetteer, onDiscover, onSearchArea,
  onSearchDefinition, onSearchRadius, onSearchPicking, onPreview, onSelectPlace, onUseLocation, locationSupported }) {
  const block = el('div', 'discovery-controls');
  if (searchAreas.length > 1) {
    const label = el('label', 'discovery-field', 'Search area');
    const select = el('select', 'discovery-select');
    select.id = 'discovery-area';
    const custom = el('option', null, 'Custom radius search (centre + radius)');
    custom.value = CUSTOM_SEARCH_AREA_ID;
    if (searchAreaId === CUSTOM_SEARCH_AREA_ID) custom.selected = true;
    select.append(custom);
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
  block.append(searchControls({ search, searchAreas, searchAreaId, presets, region, gazetteer, onSearchDefinition,
    onSearchRadius, onSearchPicking, onPreview, onSelectPlace, onUseLocation, locationSupported }));
  const customSearch = searchAreaId === CUSTOM_SEARCH_AREA_ID;
  const coverage = coverageOf({ search, searchAreas, searchAreaId, region });
  const runnable = customSearch ? Boolean(search?.definition) && searchIsRunnable({ ok: true, coverage }) : true;
  const button = el('button', 'primary-button', discovery.status === 'running' ? 'Discovering…' : 'Discover roads');
  button.type = 'button';
  button.id = 'discover-roads';
  // The button is created together with its listener, so it never needs a pre-attach disabled state. It does
  // stay disabled until the search-area declaration has loaded, and while the chosen centre and radius cannot
  // overlap the published coverage at all: a search that cannot be answered is refused, not answered emptily.
  button.disabled = discovery.status === 'running' || !searchAreas.length || !runnable;
  if (!runnable) button.setAttribute('aria-describedby', 'discovery-search-status');
  button.addEventListener('click', () => onDiscover?.());
  block.append(button);
  if (!searchAreas.length) block.append(el('p', 'discovery-status', 'Loading the discovery search-area declaration…'));
  else if (!runnable) block.append(el('p', 'discovery-status', 'Cannot search: this centre and radius do not overlap the published regional coverage.'));
  if (discovery.status === 'running') {
    block.append(el('p', 'discovery-status', discovery.phase || 'Preparing search…'));
  } else if (discovery.status === 'unavailable' && !discovery.error) {
    block.append(el('p', 'discovery-status', 'The road-network extract could not be read.'));
  }
  return block;
}

// What the panel calls the current centre: the label first, then the coordinates it is only a label for, plus
// how far the inferred place is. The coordinates are always shown, because they are the search.
function centerLabelText(presentation) {
  if (presentation.kind === CENTER_LABEL_KIND.EXPLICIT_PLACE) {
    return presentation.coordinates ? `${presentation.label} · ${presentation.coordinates}` : presentation.label;
  }
  if (presentation.kind === CENTER_LABEL_KIND.NEAR_PLACE) {
    const away = presentation.distanceM == null ? '' : ` (${formatContextDistance(presentation.distanceM)} away)`;
    return presentation.coordinates ? `${presentation.label} · ${presentation.coordinates}${away}` : `${presentation.label}${away}`;
  }
  return `Centre: ${presentation.label}`;
}

function coverageOf({ search, searchAreas, searchAreaId, region }) {
  if (searchAreaId !== CUSTOM_SEARCH_AREA_ID) {
    const declared = searchAreas.find(area => area.id === searchAreaId) ?? null;
    return declared ? areaCoverage(declared, region) : null;
  }
  return search?.definition ? searchRegionCoverage(search.definition, region) : null;
}

// The centre and the radius. Every control here produces the same plain value, and a map pick, a preset, a
// shared URL and a remembered search are all just other ways of arriving at it.
function searchControls({ search, searchAreas, searchAreaId, presets, region, gazetteer, onSearchDefinition, onSearchRadius,
  onSearchPicking, onPreview, onSelectPlace, onUseLocation, locationSupported }) {
  const block = el('div', 'discovery-search');
  const draft = search?.definition ?? null;
  const custom = searchAreaId === CUSTOM_SEARCH_AREA_ID;
  const coverage = coverageOf({ search, searchAreas, searchAreaId, region });
  const radiusMiles = draft?.radiusMiles ?? DEFAULT_RADIUS_MILES;
  const picking = Boolean(search?.picking);
  const place = search?.place ?? null;
  const near = search?.near ?? null;
  const presentation = centerPresentation({ place, near, center: draft?.center ?? null });
  const active = custom
    ? (draft ? `Custom radius search · ${formatRadius(draft.radiusMiles)}` : 'Custom radius search · no centre chosen yet')
    : `Declared search area · ${searchAreas.find(area => area.id === searchAreaId)?.name ?? searchAreaId ?? 'none selected'}`;
  const status = el('div', 'discovery-coverage-status');
  status.id = 'discovery-search-status';
  status.setAttribute('aria-live', 'polite');
  status.append(el('p', 'small', `Active search: ${active}${custom ? '' : ' (the centre and radius below define a custom search)'}`));
  // Where the search is, in the one vocabulary every surface uses: a place a person chose, otherwise the
  // nearest published place ("Near Vernonia, OR"), otherwise the coordinates. The coordinates stay visible in
  // every case, because they are the search.
  const centreLine = el('p', 'small discovery-center-label', centerLabelText(presentation));
  centreLine.id = 'discovery-center-label';
  status.append(centreLine);
  status.append(el('p', `small discovery-coverage-line ${(coverage?.coverage ?? COVERAGE.UNKNOWN).toLowerCase()}`,
    `Coverage: ${coverage?.coverage ?? COVERAGE.UNKNOWN}${coverage?.reason ? ` — ${coverage.reason}` : ''}`));
  block.append(status);
  block.append(placeFinder({ gazetteer, place, onSelectPlace }));
  // Another way to say where: the browser's own location, after an explicit click and nothing else. It sits
  // beside the other centre inputs rather than above them, and the radius below stays the person's.
  block.append(locationControl({ location: search?.location ?? null, supported: locationSupported, onUseLocation }));

  const form = el('form', 'discovery-search-fields');
  form.id = 'discovery-search-fields';
  const latInput = textField('discovery-center-lat', 'Latitude', draft ? draft.center[1].toFixed(4) : '');
  const lonInput = textField('discovery-center-lon', 'Longitude', draft ? draft.center[0].toFixed(4) : '');
  const apply = el('button', 'quiet-button', 'Set centre');
  apply.type = 'submit';
  apply.id = 'discovery-center-apply';
  const applied = el('p', 'discovery-error');
  applied.id = 'discovery-center-error';
  applied.setAttribute('role', 'status');
  // A centre that is not a coordinate, or a radius outside the declared range, is refused here and never
  // becomes a definition. A centre whose search cannot overlap the published coverage is accepted as a
  // definition, so that state stays visible and shareable, and refused as a search by the button below.
  form.addEventListener('submit', event => {
    event.preventDefault();
    const result = readSearchDefinition({ lat: latInput.value, lon: lonInput.value, radiusMiles }, { region });
    if (!result.ok) { applied.textContent = searchRefusal(result); return; }
    applied.textContent = '';
    onSearchDefinition?.(result.definition, { source: 'coordinate' });
  });
  const pick = el('button', 'quiet-button', picking ? 'Stop choosing on the map' : 'Set centre on map');
  pick.type = 'button';
  pick.id = 'discovery-center-pick';
  pick.setAttribute('aria-pressed', String(picking));
  pick.addEventListener('click', () => onSearchPicking?.(!picking));
  const row = el('div', 'discovery-search-row');
  row.append(latInput.closest('label'), lonInput.closest('label'), apply, pick);
  form.append(row, applied);
  block.append(form);

  const radiusField = el('label', 'discovery-field', `Search radius (miles, ${MIN_RADIUS_MILES}–${MAX_RADIUS_MILES})`);
  const radiusRow = el('div', 'discovery-radius-row');
  const slider = el('input', 'discovery-range');
  slider.type = 'range';
  slider.id = 'discovery-radius';
  slider.min = String(MIN_RADIUS_MILES);
  slider.max = String(MAX_RADIUS_MILES);
  slider.step = '1';
  slider.value = String(radiusMiles);
  const readout = el('span', 'discovery-radius-value', formatRadius(radiusMiles));
  readout.id = 'discovery-radius-value';
  // Dragging previews the disk on the map and never starts a search; releasing commits the radius.
  slider.addEventListener('input', () => { readout.textContent = `${slider.value} mi`; onPreview?.({ radiusMiles: radiusNumber(slider.value) }); });
  slider.addEventListener('change', () => onSearchRadius?.(radiusNumber(slider.value)));
  const number = el('input', 'discovery-input');
  number.type = 'number';
  number.id = 'discovery-radius-input';
  number.min = String(MIN_RADIUS_MILES);
  number.max = String(MAX_RADIUS_MILES);
  number.step = '1';
  number.value = String(radiusMiles);
  number.addEventListener('input', () => { readout.textContent = `${number.value || '—'} mi`; onPreview?.({ radiusMiles: radiusNumber(number.value) }); });
  number.addEventListener('change', () => onSearchRadius?.(radiusNumber(number.value)));
  radiusRow.append(slider, number, readout);
  radiusField.append(radiusRow);
  const stops = el('div', 'discovery-presets');
  for (const stop of RADIUS_STOPS_MILES) {
    const chip = el('button', 'quiet-button', formatRadius(stop));
    chip.type = 'button';
    chip.id = `discovery-radius-${stop}`;
    chip.setAttribute('aria-label', `Search a ${stop}-mile radius`);
    chip.addEventListener('click', () => onSearchRadius?.(stop));
    stops.append(chip);
  }
  block.append(radiusField, stops);

  if (presets.length) {
    const presetBlock = el('div', 'discovery-presets');
    presetBlock.id = 'discovery-presets';
    presetBlock.append(el('span', 'eyebrow', 'Benchmark presets'));
    for (const preset of presets) {
      const definition = storedDefinition({ center: preset.center, radiusMiles: preset.radiusMiles });
      if (!definition) continue;
      const chip = el('button', 'quiet-button', preset.name);
      chip.type = 'button';
      chip.id = `discovery-preset-${preset.id}`;
      chip.setAttribute('aria-label', `${preset.name}: ${formatRadius(definition.radiusMiles)} at ${formatCenter(definition.center)}`);
      chip.addEventListener('click', () => onSearchDefinition?.(definition, { source: 'preset' }));
      presetBlock.append(chip);
    }
    block.append(presetBlock);
  }

  const history = (search?.history ?? []).filter(entry => storedDefinition(entry));
  if (history.length) {
    const recent = el('div', 'discovery-presets');
    recent.id = 'discovery-recent';
    recent.append(el('span', 'eyebrow', 'Recent searches'));
    history.forEach((entry, index) => {
      const definition = storedDefinition(entry);
      // The same precedence as everywhere else: the place a person chose, otherwise the nearest published
      // place (regenerated from the gazetteer, never stored), otherwise the coordinates.
      const label = entry.place?.label
        ?? (nearestPlace(entry.center, gazetteer)?.label ?? formatCenter(entry.center));
      const chip = el('button', 'quiet-button', `${label} · ${formatRadius(definition.radiusMiles)}`);
      chip.type = 'button';
      chip.id = `discovery-recent-${index}`;
      chip.addEventListener('click', () => onSearchDefinition?.(definition, { source: 'recent', place: entry.place ?? null }));
      recent.append(chip);
    });
    block.append(recent);
  }
  return block;
}

// "Find a place": a small local lookup over the committed regional gazetteer, above the coordinate fields it
// feeds. Typing never publishes state, never runs a search, and never leaves the browser; choosing a result
// sets the centre (the radius control is untouched) through the ordinary search definition.
// USE MY LOCATION. One control, one position, one centre: the browser asks the person for permission, this
// workspace uses the answer as the search centre and says what accuracy it came with. It never searches, never
// moves the radius, never tracks, and never sends the position anywhere. Nothing here disables the other ways of
// choosing a centre - a refusal is one line of text, not a dead panel.
function locationControl({ location = null, supported = false, onUseLocation = null }) {
  const block = el('div', 'discovery-location');
  block.id = 'discovery-location';
  const status = el('p', 'discovery-status');
  status.id = 'discovery-location-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  if (!supported) {
    // A browser without the API is not an error state: the feature is simply absent and the panel says so.
    status.textContent = 'This browser does not offer a location. Choose a place, click the map, or enter coordinates.';
    block.append(status);
    return block;
  }
  const requesting = location?.status === LOCATION_STATUS.REQUESTING;
  const button = el('button', 'quiet-button', requesting ? 'Locating…' : 'Use my location');
  button.type = 'button';
  button.id = 'discovery-use-location';
  // One request at a time: a second click while the browser is looking would only start a race with itself.
  button.disabled = requesting;
  button.addEventListener('click', () => onUseLocation?.());
  const line = el('p', 'small muted discovery-location-note');
  line.id = 'discovery-location-note';
  if (requesting) status.textContent = 'Asking this browser for its location…';
  else if (location?.status === LOCATION_STATUS.OK) {
    status.textContent = `Search centre set from this device's location. ${accuracyLabel(location.accuracyM) ?? ''}`.trim();
  } else if (location?.message) status.textContent = location.message;
  block.append(button, status);
  line.textContent = location?.status === LOCATION_STATUS.OK
    ? 'The radius above is unchanged, and no search has run: press "Discover roads" when you are ready.'
    : 'Asks the browser for one current position and uses it as the search centre. Nothing is sent anywhere, and nothing is tracked.';
  block.append(line);
  return block;
}

function placeFinder({ gazetteer, place, onSelectPlace }) {
  const box = el('div', 'discovery-place');
  box.id = 'discovery-place-box';
  if (!gazetteer) {
    box.append(el('p', 'discovery-status', 'Place-name search is unavailable: the place gazetteer did not load. Coordinates below still work.'));
    return box;
  }
  const field = el('label', 'discovery-field', 'Find a place');
  const input = el('input', 'discovery-input');
  input.type = 'text';
  input.id = 'discovery-place';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Hillsboro';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'discovery-place-results');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-describedby', 'discovery-place-status');
  field.append(input);
  const list = el('ul', 'discovery-place-results');
  list.id = 'discovery-place-results';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Matching places');
  list.hidden = true;
  const status = el('p', 'discovery-status');
  status.id = 'discovery-place-status';
  status.setAttribute('role', 'status');
  box.append(field, list, status);
  const finder = { input, list, status, results: [], active: -1, open: false, onSelect: onSelectPlace };
  input.addEventListener('input', () => updatePlaceResults(finder, gazetteer));
  input.addEventListener('keydown', event => onPlaceKey(event, finder, gazetteer, onSelectPlace));
  input.addEventListener('blur', () => closePlaceResults(finder));
  if (place) {
    // The chosen place is stated where the centre is stated, so the field itself stays a query box.
    status.textContent = `Centre set to ${place.label}.`;
  }
  return box;
}

function closePlaceResults(finder) {
  finder.open = false;
  finder.results = [];
  finder.active = -1;
  finder.list.replaceChildren();
  finder.list.hidden = true;
  finder.input.setAttribute('aria-expanded', 'false');
  finder.input.removeAttribute('aria-activedescendant');
}

function updatePlaceResults(finder, gazetteer) {
  const outcome = searchPlaces(gazetteer, finder.input.value);
  finder.results = outcome.status === 'ok' ? [...outcome.results] : [];
  finder.active = finder.results.length ? 0 : -1;
  finder.open = finder.results.length > 0;
  finder.status.textContent = outcome.status === 'ok'
    ? `${finder.results.length} matching place${finder.results.length === 1 ? '' : 's'}.`
    : (finder.input.value.trim() ? outcome.message : '');
  renderPlaceOptions(finder);
}

function renderPlaceOptions(finder) {
  finder.list.replaceChildren();
  finder.list.hidden = !finder.open;
  finder.input.setAttribute('aria-expanded', String(finder.open));
  if (!finder.open) {
    finder.input.removeAttribute('aria-activedescendant');
    return;
  }
  finder.results.forEach((place, index) => {
    const option = el('li', `discovery-place-option${index === finder.active ? ' active' : ''}`);
    option.id = `discovery-place-option-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(index === finder.active));
    option.append(el('span', 'discovery-place-name', placeLabel(place)), el('span', 'discovery-place-type', placeTypeLabel(place)));
    // A pointer press selects without moving focus out of the field, so the same list works with a mouse, a
    // finger, and a keyboard.
    option.addEventListener('pointerdown', event => { event.preventDefault(); choosePlace(finder, index, finder.onSelect); });
    finder.list.append(option);
  });
  finder.input.setAttribute('aria-activedescendant', `discovery-place-option-${finder.active}`);
}

function onPlaceKey(event, finder, gazetteer, onSelectPlace) {
  if (event.key === 'Escape') {
    if (finder.open) { event.preventDefault(); closePlaceResults(finder); }
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!finder.open && finder.input.value.trim()) updatePlaceResults(finder, gazetteer);
    if (!finder.open) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    finder.active = (finder.active + step + finder.results.length) % finder.results.length;
    renderPlaceOptions(finder);
    return;
  }
  if (event.key === 'Enter' && finder.open && finder.active >= 0) {
    // Enter selects the highlighted place and nothing else: it never starts a search by itself.
    event.preventDefault();
    choosePlace(finder, finder.active, onSelectPlace);
  }
}

function choosePlace(finder, index, onSelect) {
  const place = finder.results[index];
  if (!place) return;
  closePlaceResults(finder);
  finder.status.textContent = '';
  finder.input.value = '';
  onSelect?.(place);
}

function textField(id, label, value) {
  const field = el('label', 'discovery-field', label);
  const input = el('input', 'discovery-input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.autocomplete = 'off';
  input.id = id;
  input.value = value;
  field.append(input);
  return input;
}


// The run's own summary: what was asked for, what came back, and how long each stage took. It reports the
// search that produced these results, not the search currently typed into the controls above.
function searchSummary(diagnostics, searchArea, centerLabel = null) {
  const shape = diagnostics?.searchShape;
  if (!shape || shape.kind !== 'radius' || !Array.isArray(shape.center)) return null;
  const derivedSelection = diagnostics.derivedSelection ?? null;
  const timing = diagnostics.derivedTimingMs ?? diagnostics.partitionTimingMs ?? {};
  const block = el('div', 'discovery-summary');
  block.id = 'discovery-summary';
  block.append(el('span', 'eyebrow', 'Search summary'));
  block.append(el('p', 'small', `${shape.radiusMiles}-mile radius search · ${centerLabel ?? formatCenter(shape.center)}`));
  // The coordinates stay in the summary as the search's own state, whatever the label says.
  block.append(el('p', 'small muted', `centre ${formatCenter(shape.center)}`
    + `${searchArea?.id === CUSTOM_SEARCH_AREA_ID ? ' (custom search centre)' : ''}`));
  const parts = [`${diagnostics.counts?.corridors ?? 0} corridor(s) found`];
  if (derivedSelection) {
    parts.push(`${derivedSelection.cells.present} metric cell(s) loaded (${derivedSelection.cells.empty} declared empty)`);
    parts.push(`${(derivedSelection.bytes / 1048576).toFixed(1)} MiB`);
  } else if (diagnostics.partitionSelection) {
    const selected = Object.values(diagnostics.partitionSelection.counts ?? {}).reduce((sum, value) => sum + value, 0);
    parts.push(`${selected} partition(s)`);
    parts.push(`${(diagnostics.partitionSelection.bytes / 1048576).toFixed(1)} MiB`);
  }
  block.append(el('p', 'small', parts.join(' · ')));
  const stages = [`search ${((diagnostics.totalMs ?? 0) / 1000).toFixed(1)} s`];
  if (timing.totalPreparationMs != null) stages.push(`data ${(timing.totalPreparationMs / 1000).toFixed(1)} s`);
  if (diagnostics.selectionMs != null) stages.push(`selection ${(diagnostics.selectionMs / 1000).toFixed(1)} s`);
  if (diagnostics.queryMs != null) stages.push(`query ${(diagnostics.queryMs / 1000).toFixed(1)} s`);
  if (diagnostics.buildMs != null) stages.push(`build ${(diagnostics.buildMs / 1000).toFixed(1)} s`);
  block.append(el('p', 'small muted', stages.join(' · ')));
  return block;
}

// The summary describes the search that produced the results, so it is labelled from that search's own centre:
// the place a person chose when it still describes that centre, otherwise the nearest published place to it,
// otherwise the coordinates. A newer centre can never relabel an older run. The label comes from the same helper
// a promotion uses, so the summary, the discovery row and a promoted candidate cannot disagree.
function runCenterLabel({ discovery, search, gazetteer }) {
  const area = discovery.searchArea;
  if (!area?.center || area.kind !== 'radius') return null;
  return runCenterPresentation({ center: area.center, place: search?.place ?? null, near: search?.near ?? null,
    definitionCenter: search?.definition?.center ?? null, gazetteer })?.label ?? null;
}

function coverageBanner(coverage, diagnostics, searchArea = null, centerLabel = null) {
  const block = el('div', `discovery-coverage ${coverage.coverage === COVERAGE.FULL ? 'ok' : 'caution'}`);
  block.append(el('span', 'eyebrow', 'Discovery coverage'));
  block.append(el('strong', null, `Discovery coverage ${coverage.coverage}`));
  const summary = searchSummary(diagnostics, searchArea, centerLabel);
  if (summary) block.append(summary);
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
    if (diagnostics.derived) {
      // Discovery metrics and detailed GIS are two different claims, and the interface says which one is on
      // screen: the list is the precomputed deterministic metrics, the panel below it measures raw regional GIS.
      const derivedSelection = diagnostics.derivedSelection;
      const derivedTiming = diagnostics.derivedTimingMs ?? {};
      block.append(el('span', 'eyebrow', 'Discovery metrics'));
      block.append(el('p', 'small', 'Precomputed deterministic GIS metrics, verified on load. '
        + 'Detailed GIS is measured from the raw regional data when a corridor is opened.'));
      if (derivedSelection) {
        block.append(el('p', 'small muted', `${diagnostics.counts.corridors ?? 0} corridor(s) in this search area · `
          + `${derivedSelection.cells.present} metric cell(s) selected (${derivedSelection.cells.empty} declared empty) · `
          + `${(derivedSelection.bytes / 1048576).toFixed(1)} MiB verified.`));
      }
      if (derivedTiming.totalPreparationMs != null) {
        block.append(el('p', 'small muted', `Metric preparation ${derivedTiming.totalPreparationMs} ms · downloaded `
          + `${(derivedTiming.downloadedBytes / 1048576).toFixed(1)} MiB · ${derivedTiming.cacheHits} verified cell cache hit(s).`));
      }
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
    if (!diagnostics.derived) {
      block.append(el('p', 'small muted', `Measured in ${diagnostics.totalMs} ms: ${diagnostics.counts.features} road features read, `
        + `${diagnostics.counts.eligibleUnits} named road units composed, ${diagnostics.counts.corridors} corridors analysed in one GIS batch `
        + `(${diagnostics.analysisMs} ms), ${diagnostics.roadQueryMs} ms for the road-network query.`));
    }
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
  for (const label of ['Road', 'Length', 'From center', 'Wetland ≤250 m', 'Crossings', 'Ecoregion', 'Coverage', 'Status']) headRow.append(el('th', null, label));
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
    // Straight-line distance from the search centre to the nearest point of this road, with the 8-point
    // direction it lies in. A declared box search has no centre to measure from, so the cell stays empty.
    const fromCenter = el('td', null, result.distanceFromCenterM == null ? '—'
      : `${formatContextDistance(result.distanceFromCenterM)}${result.cardinalFromCenter ? ` ${result.cardinalFromCenter}` : ''}`);
    fromCenter.title = CONTEXT_NOTE;
    row.append(fromCenter);
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
    // Orientation, not recommendation: where the nearest part of this road lies relative to the centre the
    // person chose. The measurement is the same one the exact-radius search used to include the corridor.
    ['From search center', result.distanceFromCenterM == null ? 'Not measured (no search center)'
      : `${formatContextDistance(result.distanceFromCenterM)}${result.cardinalFromCenter ? ` ${result.cardinalFromCenter}` : ''}`
        + ` (bearing ${result.bearingFromCenterDeg == null ? 'not applicable' : `${result.bearingFromCenterDeg.toFixed(0)}°`})`],
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
  if (result.distanceFromCenterM != null) block.append(el('p', 'discovery-note', CONTEXT_NOTE));
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
