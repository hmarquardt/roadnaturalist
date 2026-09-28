import { searchContextLine } from '../discovery/search-context.js';
import { COMPARISON_LIMIT_REASON, COMPARISON_NOTE, MIN_COMPARISON, MAX_COMPARISON, SAVED_FILTER_OPTIONS, SAVED_NOTE, SAVED_SORT_OPTIONS,
  comparisonDimensions, comparisonIds, notePreview, savedCounts, savedRoadRowsFor } from '../state/saved-roads.js';
import { MAX_OUTING_ROADS } from '../state/outings.js';
import { savedDateLabel } from '../state/user-meta.js';

// THE SAVED ROADS WORKSPACE.
//
// The corridors a person kept, on this device, with the two things they own about them: a favorite flag and a
// note. It shows facts and the person's own words, never a verdict: no score, no ranking, no recommendation, no
// colour that means "better". Notes are rendered as text, always - never as markup - and every annotation is
// labelled as the person's own, so it can never be read as ecological, access or Investigator evidence.

function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

export function renderSavedRoads(container, state, { measurements = {}, onSelect, onFavorite, onToggleCompare,
  onClearCompare, onSort, onFilter, onTogglePlan, onCreateOuting } = {}) {
  container.replaceChildren();
  const counts = savedCounts(state);
  const compare = comparisonIds(state);
  const rows = savedRoadRowsFor(state, { sort: state.savedRoads?.sort, filter: state.savedRoads?.filter });
  const header = el('p', 'saved-counts small muted');
  header.id = 'saved-counts';
  header.textContent = `Saved roads ${counts.total} · Favorites ${counts.favorites} · Has notes ${counts.noted}`;
  container.append(header);
  if (state.candidateStorage?.migrated) {
    // Said once, plainly: the collection came from an earlier format and will be written in this one the next
    // time something about it changes.
    container.append(el('p', 'small muted saved-migration', 'These saved roads were kept by an earlier version of this workspace. They will be written in the current format the next time you favorite, note or save a road.'));
  }
  if (!counts.total) {
    const empty = el('div', 'empty');
    empty.append(el('strong', null, 'No saved roads yet'),
      el('p', null, 'Promote a corridor from discovery and it is kept on this device, with room for your own favorite flag and notes.'));
    container.append(empty);
    return;
  }
  container.append(controls({ state, onSort, onFilter, counts }));
  container.append(planning({ state, rows, onCreateOuting, onTogglePlan }));
  container.append(el('p', 'small muted saved-note', SAVED_NOTE));
  const list = el('div', 'saved-list');
  list.id = 'saved-list';
  for (const row of rows) list.append(savedCard(row, { compare, plan: state.outingSelection ?? [], outings: state.outings ?? [],
    onSelect, onFavorite, onToggleCompare, onTogglePlan }));
  container.append(list);
  container.append(comparison({ state, compare, measurements, onSelect, onClearCompare }));
}

function controls({ state, onSort, onFilter, counts }) {
  const block = el('div', 'saved-controls');
  const sortLabel = el('label', 'saved-field', 'Sort saved roads');
  const sort = el('select', 'saved-select');
  sort.id = 'saved-sort';
  for (const option of SAVED_SORT_OPTIONS) {
    const node = el('option', null, option.label);
    node.value = option.id;
    if ((state.savedRoads?.sort ?? SAVED_SORT_OPTIONS[0].id) === option.id) node.selected = true;
    sort.append(node);
  }
  sort.addEventListener('change', event => onSort?.(event.target.value));
  sortLabel.append(sort);
  const filters = el('div', 'saved-filters');
  filters.id = 'saved-filters';
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter saved roads');
  for (const option of SAVED_FILTER_OPTIONS) {
    const active = (state.savedRoads?.filter ?? SAVED_FILTER_OPTIONS[0].id) === option.id;
    const label = option.id === 'favorite' ? `${option.label} (${counts.favorites})`
      : option.id === 'noted' ? `${option.label} (${counts.noted})` : option.label;
    const chip = el('button', 'quiet-button saved-filter', label);
    chip.type = 'button';
    chip.dataset.filter = option.id;
    chip.setAttribute('aria-pressed', String(active));
    chip.addEventListener('click', () => onFilter?.(option.id));
    filters.append(chip);
  }
  block.append(sortLabel, filters);
  return block;
}

function savedCard(row, { compare, plan = [], outings = [], onSelect, onFavorite, onToggleCompare, onTogglePlan }) {
  const { candidate, meta } = row;
  const card = el('article', 'saved-card');
  card.dataset.candidateId = candidate.id;
  const head = el('div', 'saved-card-head');
  const open = el('button', 'saved-name', candidate.name);
  open.type = 'button';
  open.dataset.openSaved = candidate.id;
  open.addEventListener('click', () => onSelect?.(candidate.id));
  const favorite = el('button', 'quiet-button saved-favorite', meta.favorite ? 'Favorite ✓' : 'Favorite');
  favorite.type = 'button';
  favorite.dataset.favorite = candidate.id;
  favorite.setAttribute('aria-pressed', String(meta.favorite));
  favorite.title = meta.favorite ? 'Remove this favorite' : 'Keep this road near the top of the saved list';
  favorite.addEventListener('click', () => onFavorite?.(candidate.id, !meta.favorite));
  head.append(open, favorite);
  card.append(head);
  const facts = el('p', 'saved-card-facts small muted');
  facts.append(el('span', 'tag', candidate.status));
  facts.append(document.createTextNode(` · ${(candidate.corridor.lengthM / 1609.344).toFixed(1)} mi · ${savedDateLabel(meta)}`));
  card.append(facts);
  const context = searchContextLine(candidate.searchContext);
  card.append(el('p', 'saved-card-origin small muted', context
    ? `From original search centre: ${context}` : 'No original search centre recorded for this road.'));
  // The note is text, never markup, and always named as the person's own.
  card.append(el('p', meta.note ? 'saved-card-note' : 'saved-card-note small muted',
    meta.note ? notePreview(meta.note) : 'My notes: none yet.'));
  const compareLabel = el('label', 'saved-compare-toggle');
  const box = el('input');
  box.type = 'checkbox';
  box.dataset.compare = candidate.id;
  const selected = compare.includes(candidate.id);
  box.checked = selected;
  // A fourth selection is refused out loud rather than silently ignored; the reason is shown under the list.
  box.disabled = !selected && compare.length >= MAX_COMPARISON;
  box.setAttribute('aria-describedby', 'saved-compare-status');
  box.addEventListener('change', () => onToggleCompare?.(candidate.id));
  compareLabel.append(box, document.createTextNode(' Compare'));
  card.append(compareLabel);
  // Planning is a separate choice from comparing: the plan selection is what an outing is created from.
  const planLabel = el('label', 'saved-compare-toggle');
  const planBox = el('input');
  planBox.type = 'checkbox';
  planBox.dataset.plan = candidate.id;
  planBox.checked = plan.includes(candidate.id);
  planBox.addEventListener('change', () => onTogglePlan?.(candidate.id));
  planLabel.append(planBox, document.createTextNode(' Add to an outing'));
  card.append(planLabel);
  const used = outings.filter(outing => outing.roadIds.includes(candidate.id)).length;
  if (used) card.append(el('p', 'small muted saved-card-outings', `In ${used} outing${used === 1 ? '' : 's'}`));
  return card;
}

// COMPARISON. Facts side by side for two or three saved roads, in a table that can be scrolled sideways on a
// phone rather than squeezed into three unreadable columns. Nothing here picks a winner: the rows are facts and
// session states, and a measurement this session has not taken says so.
function comparison({ state, compare, measurements, onSelect, onClearCompare }) {
  const block = el('section', 'saved-compare');
  block.id = 'saved-compare';
  block.append(el('h3', null, 'Compare saved roads'));
  const status = el('p', 'saved-compare-status small muted');
  status.id = 'saved-compare-status';
  status.setAttribute('role', 'status');
  // What the selection means right now, including the limit: a disabled fourth box must say why it is disabled.
  const limitReached = compare.length >= MAX_COMPARISON;
  status.textContent = state.savedRoads?.note ?? (compare.length === 0
    ? `Select two or three saved roads to compare their facts side by side (${MIN_COMPARISON}–${MAX_COMPARISON}).`
    : compare.length < MIN_COMPARISON ? 'Select one more saved road to compare.'
    : limitReached ? COMPARISON_LIMIT_REASON
    : 'The facts of these roads side by side. The comparison does not rank or score them.');
  block.append(status);
  if (compare.length < MIN_COMPARISON) return block;
  const selection = savedRoadRowsFor(state, { sort: state.savedRoads?.sort, filter: state.savedRoads?.filter })
    .filter(row => compare.includes(row.candidate.id));
  const ordered = compare.map(id => selection.find(row => row.candidate.id === id)).filter(Boolean);
  const scroll = el('div', 'saved-compare-scroll');
  const table = el('table', 'saved-compare-table');
  table.id = 'saved-compare-table';
  const head = el('thead');
  const headRow = el('tr');
  headRow.append(el('th', null, 'Fact'));
  for (const row of ordered) {
    const cell = el('th');
    const open = el('button', 'saved-name', row.candidate.name);
    open.type = 'button';
    open.dataset.openSaved = row.candidate.id;
    open.addEventListener('click', () => onSelect?.(row.candidate.id));
    cell.append(open, el('span', 'small muted', savedDateLabel(row.meta)));
    headRow.append(cell);
  }
  head.append(headRow);
  const body = el('tbody');
  for (const dimension of comparisonDimensions(ordered, measurements)) {
    const row = el('tr', dimension.kind === 'session' ? 'saved-compare-session' : 'saved-compare-fact');
    const label = el('th');
    label.setAttribute('scope', 'row');
    label.textContent = dimension.label;
    row.append(label);
    for (const value of dimension.values) row.append(el('td', null, value));
    body.append(row);
  }
  table.append(head, body);
  scroll.append(table);
  block.append(scroll);
  const clear = el('button', 'quiet-button', 'Clear comparison');
  clear.type = 'button';
  clear.id = 'saved-compare-clear';
  clear.addEventListener('click', () => onClearCompare?.());
  const noteNode = el('p', 'small muted saved-compare-note', COMPARISON_NOTE);
  noteNode.id = 'saved-compare-note';
  block.append(noteNode, clear);
  return block;
}


// PLANNING. The roads chosen here are the ones an outing is created from, in the order they are listed; the
// order inside the outing is then changed by hand. Nothing about this choice is a comparison or a ranking.
function planning({ state, rows, onCreateOuting, onTogglePlan }) {
  const selected = rows.filter(row => (state.outingSelection ?? []).includes(row.candidate.id));
  const block = el('div', 'saved-planning');
  block.id = 'saved-planning';
  const status = el('p', 'small muted saved-planning-status');
  status.id = 'saved-planning-status';
  status.setAttribute('role', 'status');
  const button = el('button', 'quiet-button', 'Create outing');
  button.type = 'button';
  button.id = 'saved-create-outing';
  button.disabled = selected.length === 0 || selected.length > MAX_OUTING_ROADS;
  button.addEventListener('click', () => onCreateOuting?.(selected.map(row => row.candidate.id)));
  const clear = el('button', 'quiet-button', 'Clear selection');
  clear.type = 'button';
  clear.id = 'saved-planning-clear';
  clear.disabled = selected.length === 0;
  clear.addEventListener('click', () => (state.outingSelection ?? []).forEach(id => onTogglePlan?.(id)));
  block.append(button, clear, status);
  status.textContent = selected.length === 0
    ? `Tick "Add to an outing" on the roads you want to plan with, then create the outing (up to ${MAX_OUTING_ROADS} roads).`
    : `${selected.length} road${selected.length === 1 ? '' : 's'} chosen: ${selected.map(row => row.candidate.name).join(', ')}`;
  return block;
}
