import { COVERAGE, COVERAGE_DATASET } from '../domain/corridor.js';
import { SORT_HELP, SORT_OPTIONS, WETLAND_FILTERS, DEFAULT_SORT, coverageFlag, ecoregionOptions, filterAndSort, sortNote } from '../discovery/filter.js';
import { DISCOVERY_STATUS } from '../discovery/lifecycle.js';
import { DISCOVERY_DISPOSITION } from '../discovery/eligibility.js';
import { MAX_RESULT_ROWS, SEGMENTED_ROAD_NOTE } from '../discovery/constants.js';
import { CUSTOM_SEARCH_AREA_ID, DEFAULT_RADIUS_MILES, MAX_RADIUS_MILES, MIN_RADIUS_MILES, RADIUS_STOPS_MILES,
  areaCoverage, formatCenter, formatRadius, radiusNumber, readSearchDefinition, searchIsRunnable,
  searchRefusal, searchRegionCoverage, storedDefinition } from '../discovery/search-definition.js';
import { parsePlaceQuery, placeDetail, placeLabel, placeTypeLabel, searchPlaces, nearestPlace } from '../discovery/place-gazetteer.js';
import { CENTER_LABEL_KIND, CONTEXT_NOTE, centerPresentation, formatContextDistance, formatContextDirection, runCenterPresentation } from '../discovery/search-context.js';
import { requestedRadiusM } from '../discovery/search-area.js';
import { naturalistInterest } from '../discovery/ranking.js';
import { EXPLORATION_ORDER_NOTE, explorationOrder } from '../discovery/exploration-order.js';
import { ADVANCED_HEADING, ADVANCED_NOTE, ADVANCED_SEARCH_HEADING, ADVANCED_SEARCH_NOTE, RECOMMENDATION_CAVEAT,
  RECOMMENDATION_EXPLAINER, RECOMMENDATION_HOW_HEADING, RECOMMENDATION_LIMIT, RECOMMENDATION_NOTE, RECOMMENDED_TERM,
  recommendationHeading, recommendations } from '../discovery/recommendation.js';
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

// THE ONE BUTTON A FIRST-TIME USER PRESSES, and it says what it does. "Discover roads" was the panel's own name for the
// machinery; a person pressing this is asking for roads.
const PRIMARY_ACTION_LABEL = 'Find roads';

// AFTER THE ANSWER, THE CONTROLS BECOME ONE SUMMARY AND ONE BUTTON. "Change location" is the ordinary way back to the place
// field - it is deliberately not Advanced search, and it is deliberately not a new search.
const CHANGE_LOCATION_LABEL = 'Change location';
const CHANGE_LOCATION_HEADING = 'Find roads somewhere else';
const CHANGE_LOCATION_NOTE = 'A place name, or this device\'s location. The radius, the exact coordinates and the declared '
  + 'areas stay under Advanced search, and the recommendations below stay until a new search is run.';



// THE DISCLOSURE PRIMITIVE. A real `<details>`/`<summary>`: keyboard-native, and collapsed content is genuinely absent
// from the tab order rather than hidden by CSS. Its open state is remembered for this session only, so a re-render (a
// selection, a promotion, a note) never slams a section shut while somebody is reading it - and nothing is persisted.
const disclosureState = { advancedSearch: false, results: false, how: false, change: false };

function disclosure({ id, key, label, note = null, className = 'discovery-disclosure' }) {
  const details = el('details', className);
  details.id = id;
  details.open = Boolean(disclosureState[key]);
  const summary = el('summary', 'discovery-disclosure-summary');
  summary.id = `${id}-heading`;
  summary.append(el('span', 'discovery-disclosure-label', label));
  details.append(summary);
  if (note) details.append(el('p', 'small muted discovery-disclosure-note', note));
  // THE OPEN STATE IS WRITTEN WHEN THE PERSON ACTS, not when the browser gets round to announcing it. The `toggle` event is
  // queued, so a re-render between a click and that event would build the next section closed - a lost click. The click
  // handler runs synchronously, before the element's own activation toggles it, so the value it is about to have is known
  // here; keyboard activation (Enter or Space on the summary) fires the same event, so both paths are covered.
  summary.addEventListener('click', () => { disclosureState[key] = !details.open; });
  return details;
}

// THE ONE POST-SEARCH FOCUS MOVE, AND WHY IT IS THIS SMALL.
//
// When a run completes and the recommendation heading is already on screen, focus moves there once: a keyboard or
// screen-reader user is taken to the answer rather than left at the button they pressed, and a sighted user sees no change.
// When the heading is *not* on screen nothing is focused, because moving a page a person is reading - or a camera they are
// looking at - is worse than leaving the answer where it is. Intermediate phases never move focus, and re-renders never
// move it again: only a run that has just finished does, and only once.
let focusedRun = null;

function focusRecommendationsOnce(discovery) {
  if (discovery.status !== 'ready' || !(discovery.results ?? []).length) return;
  const run = discovery.searchArea;
  const key = run ? `${run.id ?? ''}|${run.center?.join(',') ?? ''}|${run.radiusMiles ?? ''}|${discovery.results.length}` : null;
  if (!key || key === focusedRun) return;
  const heading = document.getElementById('recommendations-heading');
  if (!heading) return;
  const rect = heading.getBoundingClientRect();
  const onScreen = rect.top >= 0 && rect.top <= (window.innerHeight || 0);
  focusedRun = key;
  if (!onScreen) return;
  heading.focus({ preventScroll: true });
}

export function renderDiscovery(container, { discovery, searchAreas = [], searchAreaId = null, search = null,
  presets = [], region = null, gazetteer = null, loadPlaceTier = null, onDiscover, onSelect, onPromote, onDismiss,
  onFilters, onSort, onSearchArea, onSearchDefinition, onSearchRadius, onSearchPicking, onPreview, onSelectPlace,
  onShowOnMap,
  onUseLocation, locationSupported = false, outings = [], selectedOutingId = null, onAddToOuting } = {}) {
  container.replaceChildren();
  // The radius this run asked for, in metres. The exploration order normalises distance against it, and the panel
  // shows it beside the two scores; a declared box search has none, so the order falls back to the interest score.
  const radiusM = requestedRadiusM(discovery.searchArea);
  const coverage = coverageOf({ search, searchAreas, searchAreaId, region });
  container.append(controls({ discovery, searchAreas, searchAreaId, search, presets, region, gazetteer, loadPlaceTier,
    onDiscover, onSearchArea, onSearchDefinition, onSearchRadius, onSearchPicking, onPreview, onSelectPlace, onUseLocation,
    locationSupported }));
  // STATUS AND ERRORS ARE NEVER BEHIND A DISCLOSURE. A search that failed, a stale result set and a promotion that was
  // refused all stay in the ordinary flow, where they were before.
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
  const coverageNote = coverageConsequence(coverage);
  if (coverageNote) container.append(coverageNote);
  const stale = staleResults({ discovery, search, searchAreaId });
  if (stale) container.append(el('p', 'discovery-note', stale));
  const selected = discovery.selectedId ? discovery.results.find(result => result.id === discovery.selectedId) : null;
  if (discovery.status === 'ready' && discovery.results.length) {
    // RECOMMENDATIONS FIRST, THE DETAIL SECOND, THE WORKBENCH THIRD.
    //
    // The cards are the answer. The selected road's own detail sits immediately under them, so inspecting the road a
    // person just chose never requires opening the full result set - and everything the workspace could always do
    // (filters, sort, every measured column, the coverage internals, the sort explanation) is one deliberate click away
    // in "Explore all results".
    // THE ANSWER, THE DETAIL, THE WORKBENCH. What was searched is stated once, in the compact search summary at the top of
    // the panel - so it is not repeated here.
    container.append(recommendationsSection({ discovery, radiusM, onSelect, onShowOnMap, onPromote }));
    if (selected) container.append(selectedResult(selected, { onPromote, onDismiss, onSelect, radiusM, outings,
      selectedOutingId, onAddToOuting }));
    container.append(workbench({ discovery, radiusM, onFilters, onSort, onSelect,
      // THE BANNER DESCRIBES THE RUN THAT PRODUCED THESE RESULTS, so it uses the run's own coverage - which carries the
      // counts, the selection and the timings the run actually measured - and only falls back to the definition's
      // coverage when a run reported none. The consequence note above is the other way round on purpose: it is about the
      // search as it is currently defined, which is what a person is about to run.
      coverage: discovery.coverage ?? coverage,
      centerLabel: runCenterLabel({ discovery, search, gazetteer }) }));
    // The panel is built before focus is decided: whether the answer is already on screen is a question about the DOM that
    // was just written, not about the state that produced it.
    focusRecommendationsOnce(discovery);
  } else if (discovery.status === 'ready') {
    container.append(el('p', 'discovery-note', 'No discovery corridor was proposed in this search area. That is a result about the declared filters and data coverage, not a statement about the roads on the ground.'));
  }
  return container;
}

// WHAT A LIMITATION MEANS, IN PLAIN WORDS, IN THE ORDINARY FLOW. A healthy search says nothing technical here: the
// coverage internals (FULL/PARTIAL/NONE, cells, partitions, timings) live under "Explore all results", and only a real
// consequence is stated where a person will read it.
function coverageConsequence(coverage) {
  if (!coverage || coverage.coverage === COVERAGE.FULL) return null;
  const note = el('p', 'discovery-coverage-note');
  note.id = 'discovery-coverage-note';
  // EACH LIMITATION GETS ITS OWN SENTENCE, because they are different claims: no data at all, some data missing, and data
  // that could not be checked are not the same thing and must not be flattened into one cautious phrase.
  const consequence = {
    [COVERAGE.NONE]: 'No published environmental data covers this search area, so no recommendations can be made from it.',
    [COVERAGE.UNKNOWN]: 'The environmental data coverage of this search area could not be determined, so recommendations '
      + 'may use fewer signals.',
  }[coverage.coverage] ?? 'Some environmental data is unavailable here, so recommendations may use fewer signals.';
  note.textContent = coverage.reason ? `${consequence} ${coverage.reason}` : consequence;
  return note;
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

// THE SEARCH SURFACE, SPLIT BY WHAT A FIRST-TIME USER NEEDS - AND BY WHETHER IT HAS ALREADY DONE ITS JOB.
//
// Before a run the ordinary surface *is* the panel: a place name or this device's location, then one button. After a run it
// has answered the question it asks, so the panel keeps only a compact statement of what was searched - the place, the
// radius, how many roads - with one Change location control that brings the same controls back. The controls are built
// once and moved, never re-created: there is no second draft, and editing the next location never touches the answer.
function controls({ discovery, searchAreas, searchAreaId, search, presets, region, gazetteer, loadPlaceTier = null,
  onDiscover, onSearchArea, onSearchDefinition, onSearchRadius, onSearchPicking, onPreview, onSelectPlace,
  onUseLocation, locationSupported }) {
  const block = el('div', 'discovery-controls');
  // A RUN THAT CANNOT BE ANSWERED KEEPS ITS CONTROLS OPEN: a refusal must never collapse the only way to fix it.
  const customSearch = searchAreaId === CUSTOM_SEARCH_AREA_ID;
  const coverage = coverageOf({ search, searchAreas, searchAreaId, region });
  const draft = search?.definition ?? null;
  const runnable = customSearch ? Boolean(draft) && searchIsRunnable({ ok: true, coverage }) : true;
  if (!runnable) disclosureState.change = true;
  // A RUN IN FLIGHT COLLAPSES THE FORM: the person pressed the button, so the panel shows what is being searched and how
  // far it has got, rather than the controls they just used.
  if (discovery.status === 'running') disclosureState.change = false;
  const surface = searchSurface({ discovery, search, searchAreas, searchAreaId, region, gazetteer, loadPlaceTier,
    onSelectPlace, onUseLocation, locationSupported, onSearchDefinition, onDiscover });
  const advanced = advancedSearch({ searchAreas, searchAreaId, search, presets, region, gazetteer, loadPlaceTier,
    onSearchArea, onSearchDefinition, onSearchRadius, onSearchPicking, onPreview, onSelectPlace });
  if (discovery.searchArea) {
    block.append(compactSearch({ discovery, search, gazetteer }));
    const change = disclosure({ id: 'discovery-change', key: 'change', label: CHANGE_LOCATION_HEADING,
      note: CHANGE_LOCATION_NOTE });
    const body = el('div', 'discovery-change-body');
    body.append(surface, advanced);
    change.append(body);
    block.append(change);
  } else {
    block.append(surface, advanced);
  }
  block.append(searchStatus({ discovery, searchAreas, runnable }));
  return block;
}

// WHAT WAS SEARCHED, IN THREE SHORT PIECES AND NOTHING ELSE: where, how wide, and how many roads it considered. The
// coordinates, the cell counts, the megabytes, the phase timings and the coverage vocabulary are not here - they are
// Advanced material, and a person reading the answer does not need them.
function compactSearch({ discovery, search, gazetteer }) {
  const area = discovery.searchArea ?? null;
  const box = el('div', 'discovery-compact');
  box.id = 'discovery-search-compact';
  const presentation = runCenterPresentation({ center: area?.center ?? null, place: search?.place ?? null,
    near: search?.near ?? null, definitionCenter: search?.definition?.center ?? null, gazetteer });
  // A PLACE NAME WHEN THERE IS ONE, COORDINATES WHEN THERE IS NOT. A centre typed as coordinates and never named is
  // described as coordinates: the panel does not invent a place for it, and the nearest published place is used only when
  // the shared label rule says it is near (the same rule the map key and the row distances use).
  const label = presentation?.label ?? (area?.center ? formatCenter(area.center) : 'this search');
  const line = el('p', 'discovery-compact-line');
  line.id = 'discovery-compact-line';
  line.append(el('strong', null, label));
  box.append(line);
  const facts = [];
  if (area?.radiusMiles) facts.push(`within ${formatRadius(area.radiusMiles)}`);
  else if (area?.name) facts.push(area.name);
  const considered = (discovery.results ?? []).length;
  if (considered) facts.push(`${considered} road${considered === 1 ? '' : 's'} considered`);
  if (facts.length) {
    // This is the run's own summary line, in the one vocabulary the ordinary path uses: the radius and the count. It keeps
    // the id the gates and the panel have always used for "what was searched", and it carries no coordinates.
    const detail = el('p', 'small muted discovery-compact-facts', facts.join(' · '));
    detail.id = 'discovery-summary';
    box.append(detail);
  }
  // CHANGE LOCATION REVEALS THE ORDINARY CONTROLS AND NOTHING ELSE. It is not Advanced search: a person moving from
  // Princeton to Evansville types a place name, and never meets a latitude field.
  const change = el('button', 'quiet-button', CHANGE_LOCATION_LABEL);
  change.type = 'button';
  change.id = 'discovery-change-location';
  change.setAttribute('aria-controls', 'discovery-change');
  change.addEventListener('click', () => revealChangeLocation());
  box.append(change);
  return box;
}

// SHOW ON MAP MEANS SHOW THE MAP.
//
// Selecting a corridor and *seeing* the map that draws it are two different things, and the card promised both: on a phone
// the map sits two screens below the answer, so a tap that only changed a highlight the person cannot see looked like
// nothing happened. This brings the map panel into view when it is not already there, and does nothing when it is.
//
// IT NEVER TOUCHES THE CAMERA. The page scrolls; the geographic camera does not. Panning, zooming and fitting stay where
// they have always been - with the map's own controls (Fit results, Fit selected, Fit outing) - because a person who
// scrolled a page has not asked to move the world.
const MAP_VISIBLE_ENOUGH = 0.6;

function revealMap() {
  const panel = document.getElementById('map-panel');
  if (!panel) return;
  const viewport = window.innerHeight || 0;
  const rect = panel.getBoundingClientRect();
  const visible = Math.min(rect.bottom, viewport) - Math.max(rect.top, 0);
  const enough = Math.min(rect.height, viewport) * MAP_VISIBLE_ENOUGH;
  // ALREADY THERE? THEN NOTHING MOVES. A desktop layout can show the map beside the answer, and a page that jumps under a
  // person who can already see what they asked for is worse than no movement at all.
  if (visible >= enough) return;
  panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  // The region takes focus so a keyboard or screen-reader user is taken with the page, and `preventScroll` keeps focus from
  // starting a second, competing scroll of its own.
  panel.focus({ preventScroll: true });
}

// AND BACK AGAIN. The answer is where a person came from, and it is still there: the same cards, the same selection, the
// same search. This moves the page and nothing else - no store write, no new run, no camera.
export function revealRecommendations() {
  const section = document.getElementById('discovery-recommendations');
  const heading = document.getElementById('recommendations-heading');
  section?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  heading?.focus?.({ preventScroll: true });
}

// The one place that opens the search surface again, whether it is opened from the summary beside the answer or from the
// recommendation section: the disclosure is opened for the session (so a re-render keeps it open) and the place field takes
// focus, because that is the field a person came here to use.
function revealChangeLocation() {
  disclosureState.change = true;
  const details = document.getElementById('discovery-change');
  if (details) details.open = true;
  const place = document.getElementById('discovery-place');
  place?.scrollIntoView?.({ block: 'nearest' });
  place?.focus?.();
}

// The status of the search itself - the declaration still loading, a centre that cannot be searched, a run in flight, an
// extract that could not be read. It lives beside the controls in both presentations, so nothing important is ever hidden
// behind the disclosure a person is being asked to open.
function searchStatus({ discovery, searchAreas, runnable }) {
  const status = el('div', 'discovery-search-status-block');
  status.id = 'discovery-search-status';
  status.setAttribute('aria-live', 'polite');
  if (!searchAreas.length) status.append(el('p', 'discovery-status', 'Loading the discovery search-area declaration…'));
  else if (!runnable) status.append(el('p', 'discovery-status', 'Cannot search: this centre and radius do not overlap the published regional coverage.'));
  if (discovery.status === 'running') status.append(el('p', 'discovery-status', discovery.phase || 'Preparing search…'));
  else if (discovery.status === 'unavailable' && !discovery.error) {
    status.append(el('p', 'discovery-status', 'The road-network extract could not be read.'));
  }
  return status;
}

// WHERE SHOULD I SEARCH? A place, or where I am - and then one button that says what it does. This is the whole of the
// ordinary path, and after a run it is what Change location brings back.
function searchSurface({ discovery, search, searchAreas, searchAreaId, region, gazetteer, loadPlaceTier = null,
  onSelectPlace, onUseLocation, locationSupported, onSearchDefinition, onDiscover }) {
  const block = el('div', 'discovery-primary');
  const draft = search?.definition ?? null;
  const radiusMiles = draft?.radiusMiles ?? DEFAULT_RADIUS_MILES;
  const customSearch = searchAreaId === CUSTOM_SEARCH_AREA_ID;
  const coverage = coverageOf({ search, searchAreas, searchAreaId, region });
  const presentation = centerPresentation({ place: search?.place ?? null, near: search?.near ?? null,
    center: draft?.center ?? null });
  const runnable = customSearch ? Boolean(draft) && searchIsRunnable({ ok: true, coverage }) : true;

  // ONE ROW: the place to search, and this device's own location beside it. The ordinary path is these two ways of saying
  // where, one button, and nothing else - so the primary action stays on the first screen of the panel.
  const row = el('div', 'discovery-primary-row');
  row.append(placeFinder({ gazetteer, place: search?.place ?? null, onSelectPlace, loadPlaceTier }),
    locationControl({ location: search?.location ?? null, supported: locationSupported, onUseLocation }));
  block.append(row);
  // WHERE THE SEARCH IS, AND WHAT THE ASSUMPTION IS, on one line: a place a person chose, otherwise the nearest published
  // place, otherwise the coordinates - then the radius, so the answer can be read without opening the control that set it.
  const context = el('div', 'discovery-search-context');
  const centreLine = el('p', 'small discovery-center-label', centerLabelText(presentation));
  centreLine.id = 'discovery-center-label';
  context.append(centreLine);
  const summary = el('p', 'small muted discovery-search-assumption', customSearch
    ? (draft ? `within ${formatRadius(radiusMiles)}` : 'Choose a place, use your location, or set a centre under Advanced search.')
    : `declared area: ${searchAreas.find(area => area.id === searchAreaId)?.name ?? searchAreaId ?? 'none selected'}`);
  summary.id = 'discovery-search-assumption';
  context.append(summary);
  block.append(context);
  block.append(recentSearches({ search, gazetteer, onSearchDefinition }));

  const button = el('button', 'primary-button discovery-find', discovery.status === 'running' ? 'Finding…' : PRIMARY_ACTION_LABEL);
  button.type = 'button';
  button.id = 'discover-roads';
  // The button is created together with its listener, so it never needs a pre-attach disabled state. It does
  // stay disabled until the search-area declaration has loaded, and while the chosen centre and radius cannot
  // overlap the published coverage at all: a search that cannot be answered is refused, not answered emptily.
  button.disabled = discovery.status === 'running' || !searchAreas.length || !runnable;
  if (!runnable) button.setAttribute('aria-describedby', 'discovery-search-status');
  button.addEventListener('click', () => onDiscover?.());
  block.append(button);
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

// THE TECHNICAL HALF OF CHOOSING WHERE, INSIDE ITS OWN DISCLOSURE. Declared areas, exact coordinates, the map picker, the
// radius and its presets, and the benchmark scenarios: every one of them still produces the same plain centre-and-radius
// definition the ordinary path produces, and none of them is required to get recommendations.
function advancedSearch({ searchAreas, searchAreaId, search, presets, region, gazetteer, loadPlaceTier = null,
  onSearchArea, onSearchDefinition, onSearchRadius, onSearchPicking, onPreview, onSelectPlace }) {
  const details = disclosure({ id: 'discovery-advanced-search', key: 'advancedSearch', label: ADVANCED_SEARCH_HEADING,
    note: ADVANCED_SEARCH_NOTE });
  const body = el('div', 'discovery-advanced-search-body');
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
    body.append(label);
  } else if (searchAreas.length === 1) {
    body.append(el('p', 'discovery-area', `Search area: ${searchAreas[0].name}`));
  }
  body.append(advancedSearchControls({ search, searchAreas, searchAreaId, presets, region, gazetteer, loadPlaceTier,
    onSearchDefinition, onSearchRadius, onSearchPicking, onPreview, onSelectPlace }));
  details.append(body);
  return details;
}

// THE TECHNICAL HALF OF CHOOSING WHERE, inside its own disclosure: the active-search statement, the coverage line, exact
// coordinates, the map picker, the radius and its presets. Every control here produces the same plain centre-and-radius
// definition the ordinary path produces, and none of it is required to get recommendations.
function advancedSearchControls({ search, searchAreas, searchAreaId, presets, region, gazetteer, loadPlaceTier = null,
  onSearchDefinition, onSearchRadius, onSearchPicking, onPreview, onSelectPlace }) {
  const block = el('div', 'discovery-search');
  const draft = search?.definition ?? null;
  const custom = searchAreaId === CUSTOM_SEARCH_AREA_ID;
  const coverage = coverageOf({ search, searchAreas, searchAreaId, region });
  const radiusMiles = draft?.radiusMiles ?? DEFAULT_RADIUS_MILES;
  const picking = Boolean(search?.picking);
  const active = custom
    ? (draft ? `Custom radius search · ${formatRadius(draft.radiusMiles)}` : 'Custom radius search · no centre chosen yet')
    : `Declared search area · ${searchAreas.find(area => area.id === searchAreaId)?.name ?? searchAreaId ?? 'none selected'}`;
  const status = el('div', 'discovery-coverage-status');
  status.id = 'discovery-active-search';
  status.setAttribute('aria-live', 'polite');
  status.append(el('p', 'small', `Active search: ${active}${custom ? '' : ' (the centre and radius below define a custom search)'}`));
  // The coverage vocabulary - FULL, PARTIAL, NONE, UNKNOWN and the reason - is a data-coverage statement, and it lives with
  // the rest of the internals. The ordinary flow states the consequence instead (see `coverageConsequence`).
  status.append(el('p', `small discovery-coverage-line ${(coverage?.coverage ?? COVERAGE.UNKNOWN).toLowerCase()}`,
    `Coverage: ${coverage?.coverage ?? COVERAGE.UNKNOWN}${coverage?.reason ? ` — ${coverage.reason}` : ''}`));
  block.append(status);

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

  return block;
}

// RECENT SEARCHES ARE PART OF THE ORDINARY PATH: searching somewhere else is a normal thing to want, and one chip is the
// whole of it. They stay in the primary surface; only the radius they were made with travels with them.
function recentSearches({ search, gazetteer, onSearchDefinition }) {
  const history = (search?.history ?? []).filter(entry => storedDefinition(entry));
  if (!history.length) return el('div', 'discovery-recent-empty');
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
  return recent;
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
    status.textContent = 'This browser does not offer a location. Choose a place, or set a centre under Advanced search.';
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
  block.append(button);
  // THE STATUS LINE IS THE OUTCOME, and the note is one short sentence about what asking costs. Both are here rather than
  // under a disclosure because this is a privacy decision a person makes on the ordinary path.
  if (requesting) status.textContent = 'Asking this browser for its location…';
  else if (location?.status === LOCATION_STATUS.OK) {
    status.textContent = `Search centre set from this device's location. ${accuracyLabel(location.accuracyM) ?? ''}`.trim();
  } else if (location?.message) status.textContent = location.message;
  const line = el('p', 'small muted discovery-location-note');
  line.id = 'discovery-location-note';
  line.textContent = location?.status === LOCATION_STATUS.OK
    ? 'No search has run: press "Find roads" when you are ready.'
    : 'One position, used as the search centre. Nothing is sent anywhere and nothing is tracked.';
  block.append(status, line);
  return block;
}

function placeFinder({ gazetteer, place, onSelectPlace, loadPlaceTier = null }) {
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
  input.placeholder = 'Princeton, IN — or a ZIP code';
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
  const finder = { input, list, status, results: [], active: -1, open: false, onSelect: onSelectPlace,
    onNeedTier: loadPlaceTier, generation: 0 };
  input.addEventListener('input', () => updatePlaceResults(finder, gazetteer));
  input.addEventListener('keydown', event => onPlaceKey(event, finder, gazetteer, onSelectPlace));
  input.addEventListener('blur', () => closePlaceResults(finder));
  if (place) {
    // The chosen place is stated where the centre is stated, so the field itself stays a query box and this line stays for
    // what the lookup itself is doing (a lazy tier loading, a query with no match).
    status.textContent = '';
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

// One keystroke, one answer - and at most one lazy tier fetch. A five-digit query asks for the postal-code
// tier; a query the core tier cannot answer asks for the community tier once, saying so while it does. A newer
// keystroke supersedes an older in-flight search through the finder's generation, so a slow fetch can never
// overwrite a fresher list.
async function updatePlaceResults(finder, gazetteer) {
  const generation = (finder.generation += 1);
  let outcome = searchPlaces(gazetteer, finder.input.value);
  const wanted = tierToLoad(gazetteer, finder.input.value, outcome);
  if (wanted) {
    finder.status.textContent = wanted.message;
    finder.input.setAttribute('aria-busy', 'true');
    await nextFrame();
    await finder.onNeedTier?.(wanted.tier);
    finder.input.removeAttribute('aria-busy');
    if (generation !== finder.generation) return;
    outcome = searchPlaces(gazetteer, finder.input.value);
  }
  finder.results = outcome.status === 'ok' ? [...outcome.results] : [];
  finder.active = finder.results.length ? 0 : -1;
  finder.open = finder.results.length > 0;
  finder.status.textContent = outcome.status === 'ok'
    ? `${finder.results.length} matching place${finder.results.length === 1 ? '' : 's'}.`
    : (finder.input.value.trim() ? outcome.message : '');
  renderPlaceOptions(finder);
}

// Which lazy tier this query needs, if any. A tier already loaded, a build that offers none, or a query too
// short to be worth a fetch needs nothing.
function tierToLoad(gazetteer, rawQuery, outcome) {
  if (typeof gazetteer?.hasTier !== 'function') return null;
  const query = parsePlaceQuery(rawQuery, gazetteer.qualifiers);
  if (query.zip && !gazetteer.hasTier('postal')) return { tier: 'postal', message: 'Looking up that ZIP code…' };
  if (outcome.status === 'none' && outcome.text.length >= 3 && !gazetteer.hasTier('community')) {
    return { tier: 'community', message: 'Searching every U.S. place name…' };
  }
  return null;
}

// Let the field paint the state it just set before the (largest) tier is parsed and indexed, so a 175 ms index
// build reads as work being done rather than as a frozen page.
function nextFrame() {
  return new Promise(resolve => {
    if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(() => resolve());
    else resolve();
  });
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
    // The second line is what separates two places with the same name: the county a person knows, the state a
    // ZIP code falls in, or the kind of area a protected place is.
    option.append(el('span', 'discovery-place-name', placeLabel(place)),
      el('span', 'discovery-place-detail', ` — ${placeDetail(place)}`),
      el('span', 'discovery-place-type', placeTypeLabel(place)));
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
    if (!finder.open) {
      // The list is filled by the (possibly lazy) search this starts; this press only asks for it, so the next
      // press has something to move through. Nothing here blocks or reorders the keystroke.
      if (finder.input.value.trim()) updatePlaceResults(finder, gazetteer);
      return;
    }
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



// THE RUN'S OWN INTERNALS: what was read, how many cells or partitions, how long each stage took. Diagnostic detail, and
// it lives with the rest of the machinery under "Explore all results".
function diagnosticsBlock(diagnostics, searchArea, centerLabel = null) {
  const shape = diagnostics?.searchShape;
  if (!shape || shape.kind !== 'radius' || !Array.isArray(shape.center)) return el('div', 'discovery-diagnostics-empty');
  const derivedSelection = diagnostics.derivedSelection ?? null;
  const timing = diagnostics.derivedTimingMs ?? diagnostics.partitionTimingMs ?? {};
  const block = el('div', 'discovery-diagnostics');
  block.id = 'discovery-diagnostics';
  block.append(el('span', 'eyebrow', 'Search diagnostics'));
  // The coordinates stay here as the search's own state, whatever the label says.
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
  if (diagnostics) block.append(diagnosticsBlock(diagnostics, searchArea, centerLabel));
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

// THE RECOMMENDATION SECTION: THE ANSWER BEFORE THE MACHINERY.
//
// One order, one prefix of it, and one card per road: the rank, the name, one short verdict, two or three reasons in plain
// English, how far and how long, and the actions. Every word comes from `recommendation.js`, which reads only the
// measurements the discovery run already made - so a card cannot claim anything the analysis did not measure.
//
// The section carries the whole ordinary flow: the assumption in its heading ("within 25 miles"), one sentence saying what
// was compared, one caveat for all five cards, a way to search somewhere else, and "How recommendations work" for the
// longer explanation. None of the machinery is required to read it.
function recommendationsSection({ discovery, radiusM = null, onSelect, onShowOnMap, onPromote }) {
  const section = el('section', 'discovery-recommendations');
  section.id = 'discovery-recommendations';
  // A ROAD THE PERSON DISMISSED IS NOT RECOMMENDED. Dismissing it is an explicit judgement about this search, and putting
  // it back in the answer would be the interface arguing with them. Its row and its detail panel are still below.
  const results = (discovery.results ?? []).filter(result => result.status !== DISCOVERY_STATUS.DISMISSED);
  // WHETHER THE SEARCH HAS A CENTRE IS READ FROM THE RESULTS, not guessed from the search definition: a distance exists
  // exactly when the run measured one, so the heading and the cards can never disagree about whether there is a distance.
  const hasCenter = results.some(result => result.distanceFromCenterM != null);
  const head = el('div', 'discovery-recommendations-head');
  head.append(el('p', 'eyebrow', RECOMMENDED_TERM));
  const title = el('h3', null, recommendationHeading({ radiusMiles: discovery.searchArea?.radiusMiles ?? null, hasCenter }));
  title.id = 'recommendations-heading';
  // THE HEADING CAN TAKE FOCUS, and that is the whole of the post-search focus move: when a search completes and the
  // heading is already on screen, the answer is where a keyboard or screen-reader user lands - without the page jumping.
  title.tabIndex = -1;
  head.append(title);
  section.append(head);
  // WHAT WAS COMPARED, in one sentence. HOW MANY ROADS WERE FOUND IS NOT REPEATED HERE: the compact search summary above
  // already says how many roads this search considered, and the panel says each thing once.
  section.append(el('p', 'small muted recommendations-explainer', RECOMMENDATION_EXPLAINER));
  // THE TABLE'S OWN ORDER IS NOT THE RECOMMENDATION ORDER, and when they differ the panel says so rather than letting two
  // lists on one screen disagree silently.
  if (discovery.sort !== DEFAULT_SORT) {
    const chosen = SORT_OPTIONS.find(option => option.key === discovery.sort)?.label ?? discovery.sort;
    const note = el('p', 'small muted recommendations-sort-note',
      `The full results below are ordered by ${chosen}. The recommendations above always use the recommendation order.`);
    note.id = 'recommendations-sort-note';
    section.append(note);
  }
  if (!results.length) {
    const empty = el('p', 'discovery-note', 'Every corridor in this search has been dismissed. The full result set is '
      + 'below, and a dismissed road can be brought back from its own detail panel.');
    empty.id = 'recommendations-empty';
    section.append(empty);
    return section;
  }
  const cards = recommendations(results, { radiusM });
  const list = el('ol', 'recommendation-list');
  list.id = 'recommendation-list';
  cards.forEach(entry => list.append(recommendationCard(entry, { discovery, onSelect, onShowOnMap, onPromote })));
  section.append(list);
  // FEWER THAN FIVE IS NOT A FAILURE AND IS NOT PADDED. The count is stated so an empty-ish answer cannot read as a
  // layout that failed to fill.
  if (cards.length < RECOMMENDATION_LIMIT) {
    const fewer = el('p', 'small muted recommendations-note', `This search proposed ${cards.length} `
      + `corridor${cards.length === 1 ? '' : 's'}, so there ${cards.length === 1 ? 'is' : 'are'} ${cards.length} `
      + `recommendation${cards.length === 1 ? '' : 's'}.`);
    fewer.id = 'recommendations-count-note';
    section.append(fewer);
  }
  // THE ONE CAVEAT FOR THE WHOLE SECTION, AND THE LONG EXPLANATION, COME AFTER THE ANSWER. Both belong to the
  // recommendations - they are what the five roads do and do not claim - and neither is a warning about the data in hand,
  // so the answer gets the screen and they follow it directly.
  section.append(el('p', 'small muted recommendations-caveat', RECOMMENDATION_CAVEAT));
  const actions = el('div', 'recommendations-actions');
  const how = disclosure({ id: 'recommendations-how', key: 'how', label: RECOMMENDATION_HOW_HEADING,
    className: 'discovery-disclosure recommendations-how' });
  how.append(el('p', 'small muted recommendations-note', RECOMMENDATION_NOTE));
  actions.append(how);
  section.append(actions);
  return section;
}

// THE WORKBENCH, BEHIND A REAL DISCLOSURE. Everything the workspace could always do is inside it, unchanged: the coverage
// internals, the filters, the sort control, the full table, the sort explanation and the segmented-road note. It starts
// collapsed, so the answer is what a person sees first - and opening it removes nothing and hides nothing.
function workbench({ discovery, radiusM = null, coverage = null, onFilters, onSort, onSelect, centerLabel = null }) {
  const details = disclosure({ id: 'discovery-advanced', key: 'results', label: ADVANCED_HEADING, note: ADVANCED_NOTE });
  const body = el('div', 'discovery-advanced-body');
  // The coverage banner and the run's own summary are diagnostics about how the answer was produced: they belong with the
  // other internals, and the ordinary flow states only their consequence.
  if (coverage) {
    body.append(coverageBanner(coverage, discovery.diagnostics, discovery.searchArea, centerLabel));
  } else if (discovery.diagnostics) {
    body.append(diagnosticsBlock(discovery.diagnostics, discovery.searchArea, centerLabel));
  }
  const view = filterAndSort(discovery.results, discovery.filters, discovery.sort, { radiusM });
  body.append(toolbar({ discovery, results: discovery.results, view, onFilters, onSort }));
  body.append(resultTable(view, discovery, onSelect));
  body.append(el('p', 'discovery-note', sortNote(discovery.sort, { radiusM })));
  body.append(el('p', 'discovery-note', SEGMENTED_ROAD_NOTE));
  details.append(body);
  return details;
}

// ONE CARD. It carries the measurements behind its own sentences as data attributes, so a reader (and a committed test)
// can check the words against the numbers the analysis produced.
function recommendationCard({ result, summary }, { discovery, onSelect, onShowOnMap, onPromote }) {
  const card = el('li', 'recommendation');
  card.id = `recommendation-${result.id}`;
  card.dataset.candidateId = result.id;
  card.dataset.rank = String(summary.rank);
  card.dataset.best = String(summary.best);
  card.dataset.label = summary.label;
  card.dataset.score = summary.score == null ? '' : String(summary.score);
  card.dataset.wetland = summary.components.wetland == null ? '' : String(summary.components.wetland);
  card.dataset.water = summary.components.water == null ? '' : String(summary.components.water);
  card.dataset.variety = summary.components.ecologicalVariety == null ? '' : String(summary.components.ecologicalVariety);
  card.dataset.distanceM = result.distanceFromCenterM == null ? '' : String(Math.round(result.distanceFromCenterM));
  if (summary.best) card.classList.add('best');
  if (result.id === discovery.selectedId) card.classList.add('selected');

  const rank = el('p', 'recommendation-rank', summary.rankText);
  rank.id = `recommendation-rank-${result.id}`;
  const name = el('button', 'recommendation-name', result.name);
  name.type = 'button';
  name.id = `recommendation-open-${result.id}`;
  name.setAttribute('aria-current', result.id === discovery.selectedId ? 'true' : 'false');
  name.addEventListener('click', () => onSelect?.(result.id));
  const label = el('p', 'recommendation-label', summary.label);
  label.id = `recommendation-label-${result.id}`;
  card.append(rank, name, label);

  const reasons = el('ul', 'recommendation-reasons');
  reasons.id = `recommendation-reasons-${result.id}`;
  for (const reason of summary.reasons) {
    const item = el('li', null, reason.text);
    item.dataset.reason = reason.key;
    reasons.append(item);
  }
  if (reasons.childElementCount) card.append(reasons);

  const facts = el('p', 'recommendation-facts', [summary.distanceText, summary.lengthText].filter(Boolean).join(' · '));
  facts.id = `recommendation-facts-${result.id}`;
  card.append(facts);
  if (summary.note) card.append(el('p', 'recommendation-note', summary.note));
  if (summary.caution) {
    const caution = el('p', 'recommendation-caution', summary.caution);
    caution.id = `recommendation-caution-${result.id}`;
    card.append(caution);
  }

  const actions = el('div', 'recommendation-actions');
  // SHOW ON MAP IS THE PRIMARY ACTION, AND IT MEANS WHAT IT SAYS, IN THIS ORDER:
  //
  //   1. select this corridor through the one selection state;
  //   2. let the map redraw it (the selection's own render has already done that by the time this returns);
  //   3. frame exactly that corridor - an explicit camera move, because the person asked to see it;
  //   4. bring the map panel into view, on the next frame, because the selection changes the panel's height above it and a
  //      page measured before that change would land in the wrong place;
  //   5. take focus with it.
  //
  // Ordinary selection - the road's name, a table row, a map click - calls `onSelect` alone and never comes here.
  const show = el('button', 'primary-button', 'Show on map');
  show.type = 'button';
  show.id = `recommendation-show-${result.id}`;
  show.addEventListener('click', () => {
    onSelect?.(result.id);
    onShowOnMap?.(result.id);
    requestAnimationFrame(() => revealMap());
  });
  actions.append(show);
  // MORE DETAILS IS THE SAME SELECTION, and it brings the road's own detail into view: a card on a phone can sit far above
  // the panel that explains it, and the person should not have to guess that the road's name is also a control.
  const more = el('button', 'quiet-button', 'More details');
  more.type = 'button';
  more.id = `recommendation-more-${result.id}`;
  more.addEventListener('click', () => {
    onSelect?.(result.id);
    document.getElementById('discovery-selected')?.scrollIntoView?.({ block: 'nearest' });
  });
  actions.append(more);
  // SAVE IS THE EXISTING PROMOTION, unchanged: the road is kept on this device through exactly the path the detail
  // panel's own control runs. A road already kept says so instead of offering to keep it twice.
  const saved = result.status === DISCOVERY_STATUS.PROMOTED;
  const save = el('button', 'quiet-button', saved ? 'Saved' : 'Save');
  save.type = 'button';
  save.id = `recommendation-save-${result.id}`;
  save.disabled = saved;
  save.addEventListener('click', () => onPromote?.(result.id));
  actions.append(save);
  card.append(actions);
  return card;
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
  // THE TWO ORDERINGS, EXPLAINED ONCE, BESIDE THE CONTROL. Their option labels stay short because the menu is a
  // control, not a paragraph; this line is where a person can tell them apart without switching between them. It is
  // derived from the model's own help text, so the menu and the explanation cannot drift apart.
  wrapper.append(el('p', 'discovery-note discovery-sort-help',
    Object.entries(SORT_HELP).map(([key, text]) =>
      `${SORT_OPTIONS.find(option => option.key === key)?.label ?? key}: ${text}`).join(' ')));
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
    // The corridor id travels with the row so the map can reveal the row a click on the map selected.
    row.dataset.candidateId = result.id;
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

function selectedResult(result, { onPromote, onDismiss, onSelect, radiusM = null, outings = [], selectedOutingId = null,
  onAddToOuting = null }) {
  const block = el('div', 'discovery-selected');
  block.id = 'discovery-selected';
  block.append(el('span', 'eyebrow', 'Selected discovery corridor'));
  block.append(el('h3', null, `${result.name} (${result.id})`));
  const facts = el('dl', 'coverage-list discovery-facts');
  // BOTH SCORES, SIDE BY SIDE. Naturalist interest is the mapped-context score and does not depend on where the
  // search was made; the exploration order is that same score adjusted by distance from the search centre. Neither
  // is ever labelled as the other.
  const interest = naturalistInterest(result);
  const order = explorationOrder(result, { radiusM });
  const rows = [
    ['Naturalist interest', interest.score == null ? 'Not measured here' : `${interest.score} / 100`],
    ['Exploration order', order.score == null ? 'Not measured here' : `${order.score} / 100`
      + (order.distanceFraction == null ? ' (no search centre)'
        : ` · ${formatContextDistance(result.distanceFromCenterM)} from your centre, ${Math.round(order.distanceFraction * 100)}% of the radius`)],
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
  // The distance-aware order is explained only where it actually applies: a search with no centre has no distance,
  // and the panel must not imply one.
  if (radiusM != null) block.append(el('p', 'discovery-note', EXPLORATION_ORDER_NOTE));
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
  block.append(outingAction({ result, outings, selectedOutingId, onAddToOuting }));
  return block;
}

// ADD TO OUTING.
//
// An outing references saved roads, so adding a corridor that has only ever been discovered keeps it first - through the
// same promotion the Promote button runs, with the same honesty about what was and was not read. The control is one
// select and one button: the person picks the plan they mean, or asks for a new one, and nothing is created behind their
// back. A road already in the chosen outing is not added twice; the application says so instead of quietly duplicating.
export const NEW_OUTING_VALUE = '__new__';

function outingAction({ result, outings = [], selectedOutingId = null, onAddToOuting = null }) {
  const block = el('div', 'discovery-outing');
  const open = outings.find(outing => outing.id === selectedOutingId) ?? null;
  const field = el('label', 'discovery-field', 'Add to an outing');
  const select = el('select', 'discovery-input');
  select.id = 'discovery-add-outing';
  const add = (label, value) => { const option = el('option', null, label); option.value = value; select.append(option); };
  if (open) add(`Add to ${open.title}`, open.id);
  for (const outing of outings) if (outing.id !== open?.id) add(outing.title, outing.id);
  // A NEW OUTING IS NAMED AFTER THE ROAD, because that is the one thing the person already told us; it is renamed in the
  // workspace like any other plan.
  add(outings.length ? 'New outing…' : 'New outing', NEW_OUTING_VALUE);
  const button = el('button', 'quiet-button', 'Add to outing');
  button.type = 'button';
  button.id = 'discovery-add-to-outing';
  button.addEventListener('click', () => onAddToOuting?.({
    roadId: result.id, outingId: select.value === NEW_OUTING_VALUE ? null : select.value, title: result.name }));
  field.append(select);
  block.append(field, button);
  block.append(el('p', 'small muted discovery-outing-note',
    'An outing holds saved roads, so adding a discovered corridor saves it first. The plan is a list you arrange - not a route.'));
  return block;
}

export function eligibilityNote(eligibility) {
  const excluded = (eligibility ?? []).filter(entry => entry.key.startsWith(DISCOVERY_DISPOSITION.EXCLUDED)
    || entry.key.startsWith(DISCOVERY_DISPOSITION.SEPARATE));
  if (!excluded.length) return '';
  return `Not proposed: ${excluded.slice(0, 4).map(entry => `${entry.key} (${entry.count})`).join(', ')}`
    + `${excluded.length > 4 ? `, and ${excluded.length - 4} more` : ''}.`;
}
