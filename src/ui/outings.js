import { searchContextLine } from '../discovery/search-context.js';
import { MAX_CHECKLIST_ITEMS, MAX_CHECKLIST_TEXT, MAX_OUTING_ROADS, OUTING_NOTE_MAX_LENGTH, OUTING_STATUS,
  OUTING_STORAGE_STATUS, OUTINGS_NOTE, roadPosition } from '../state/outings.js';
import { savedDateLabel, storedUserMeta } from '../state/user-meta.js';

// OUTINGS: PLANS, NOT ROUTES.
//
// Everything here is the person's own planning state: a title, an optional date, the sequence they chose, their
// note, their checklist, and whether the day has happened. No cell on this screen is a measurement, a distance
// between roads, a travel time, or a recommendation - and the wording avoids every navigation verb on purpose.
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

export function renderOutings(container, state, { onOpenOuting, onSelectRoad, onRename, onDate, onNotes, onStatus,
  onMove, onRemoveRoad, onAddRoad, onAddItem, onToggleItem, onRemoveItem, onRemoveOuting } = {}) {
  container.replaceChildren();
  const outings = state.outings ?? [];
  const counts = { total: outings.length, planned: outings.filter(outing => outing.status === OUTING_STATUS.PLANNED).length,
    completed: outings.filter(outing => outing.status === OUTING_STATUS.COMPLETED).length };
  const header = el('p', 'small muted outings-counts');
  header.id = 'outings-counts';
  header.textContent = `Outings ${counts.total} · Planned ${counts.planned} · Completed ${counts.completed}`;
  container.append(header);
  container.append(el('p', 'small muted outings-note', OUTINGS_NOTE));
  if (state.outingStorage?.reason && state.outingStorage.status !== OUTING_STORAGE_STATUS.SAVED) {
    container.append(el('p', 'small outings-storage-note', state.outingStorage.reason));
  }
  const selected = outings.find(outing => outing.id === state.selectedOutingId) ?? null;
  if (!outings.length) {
    const empty = el('div', 'empty');
    empty.append(el('strong', null, 'No outings yet'),
      el('p', null, `Choose roads in Saved roads and press "Create outing" to plan a day from them. An outing holds up to ${MAX_OUTING_ROADS} roads, in the order you choose.`));
    container.append(empty);
    return;
  }
  container.append(list({ state, outings, selectedId: state.selectedOutingId, onOpenOuting }));
  if (selected) container.append(detail({ state, outing: selected, roadsById: roadsById(state), onSelectRoad, onRename, onDate,
    onNotes, onStatus, onMove, onRemoveRoad, onAddRoad, onAddItem, onToggleItem, onRemoveItem, onRemoveOuting }));
}

// Saved roads are the source of road facts: an outing holds references, and every fact shown here is read from
// the candidate it points at, not copied into the plan.
function roadsById(state) {
  const rows = new Map();
  const durable = state.durableCandidateIds ?? [];
  for (const candidate of state.candidates ?? []) {
    if (durable.includes(candidate.id)) rows.set(candidate.id, { candidate, meta: storedUserMeta(state.userMetaById?.[candidate.id]) });
  }
  return rows;
}

function list({ state, outings, selectedId, onOpenOuting }) {
  const block = el('div', 'outing-list');
  block.id = 'outing-list';
  const roads = roadsById(state);
  for (const outing of outings) {
    const card = el('article', 'outing-card');
    card.dataset.outingId = outing.id;
    const open = el('button', 'outing-name', outing.title);
    open.type = 'button';
    open.dataset.openOuting = outing.id;
    open.setAttribute('aria-pressed', String(outing.id === selectedId));
    open.addEventListener('click', () => onOpenOuting?.(outing.id));
    card.append(open);
    const facts = el('p', 'outing-card-facts small muted');
    facts.textContent = [outing.date ? dateLabel(outing.date) : 'No date chosen',
      `${outing.roadIds.length} road${outing.roadIds.length === 1 ? '' : 's'}`, statusLabel(outing.status)].join(' · ');
    card.append(facts);
    const names = outing.roadIds.map(id => roads.get(id)?.candidate.name ?? 'a road that is no longer saved');
    card.append(el('p', 'outing-card-roads small muted', names.slice(0, 4).join(' · ') + (names.length > 4 ? ` · +${names.length - 4} more` : '')));
    block.append(card);
  }
  return block;
}

export function dateLabel(value) {
  if (!value) return 'No date';
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function statusLabel(status) {
  return status === OUTING_STATUS.COMPLETED ? 'Completed' : 'Planned';
}

// THE DETAIL OF ONE OUTING. Every control is labelled, the order is changed with buttons that name the road they
// move, and nothing on this screen claims to know how to travel between two roads.
function detail({ state, outing, roadsById: roads, onSelectRoad, onRename, onDate, onNotes, onStatus, onMove,
  onRemoveRoad, onAddRoad, onAddItem, onToggleItem, onRemoveItem, onRemoveOuting }) {
  const block = el('section', 'outing-detail');
  block.id = 'outing-detail';
  block.dataset.outingId = outing.id;
  const titleField = el('label', 'outing-field', 'Outing name');
  const title = el('input', 'outing-input');
  title.type = 'text';
  title.id = 'outing-title';
  title.value = outing.title;
  title.maxLength = 120;
  title.addEventListener('change', () => onRename?.(outing.id, title.value));
  titleField.append(title);
  const dateField = el('label', 'outing-field', 'Date (optional)');
  const date = el('input', 'outing-input');
  date.type = 'date';
  date.id = 'outing-date';
  date.value = outing.date ?? '';
  date.addEventListener('change', () => onDate?.(outing.id, date.value || null));
  dateField.append(date);
  const row = el('div', 'outing-fields');
  row.append(titleField, dateField);
  block.append(row);
  const statusGroup = el('div', 'outing-status');
  statusGroup.setAttribute('role', 'group');
  statusGroup.setAttribute('aria-label', 'Outing status');
  for (const [value, label] of [[OUTING_STATUS.PLANNED, 'Planned'], [OUTING_STATUS.COMPLETED, 'Completed']]) {
    const button = el('button', 'quiet-button', label);
    button.type = 'button';
    button.dataset.outingStatus = value;
    button.setAttribute('aria-pressed', String(outing.status === value));
    button.addEventListener('click', () => onStatus?.(outing.id, value));
    statusGroup.append(button);
  }
  block.append(statusGroup);
  block.append(el('h3', null, `Roads in this order (${outing.roadIds.length} of ${MAX_OUTING_ROADS})`));
  const roadsList = el('ol', 'outing-roads');
  roadsList.id = 'outing-roads';
  for (const roadId of outing.roadIds) {
    const entry = roads.get(roadId) ?? null;
    const position = roadPosition(outing, roadId);
    const item = el('li', 'outing-road');
    item.dataset.roadId = roadId;
    const name = entry ? entry.candidate.name : 'A road that is no longer saved';
    const open = el('button', 'outing-road-name', name);
    open.type = 'button';
    open.dataset.openRoad = roadId;
    if (entry) open.addEventListener('click', () => onSelectRoad?.(roadId));
    else open.disabled = true;
    item.append(el('span', 'outing-position', `${position}.`), open);
    const facts = [];
    if (entry) {
      facts.push(`${(entry.candidate.corridor.lengthM / 1609.344).toFixed(1)} mi`);
      const context = searchContextLine(entry.candidate.searchContext);
      facts.push(context ? `Found ${context} · ${savedDateLabel(entry.meta)}` : `Saved ${savedDateLabel(entry.meta).replace('Saved ', '')}`);
      if (entry.meta.favorite) facts.push('Favorite');
    } else facts.push('It is not in Saved roads any more.');
    item.append(el('p', 'outing-road-facts small muted', facts.join(' · ')));
    const controls = el('div', 'outing-road-controls');
    const up = el('button', 'quiet-button', 'Move up');
    up.type = 'button';
    up.dataset.moveRoad = roadId;
    up.dataset.direction = 'up';
    up.disabled = position === 1;                      // the ends stay put
    up.setAttribute('aria-label', `Move ${name} earlier in the outing`);
    up.addEventListener('click', () => onMove?.(outing.id, roadId, 'up'));
    const down = el('button', 'quiet-button', 'Move down');
    down.type = 'button';
    down.dataset.moveRoad = roadId;
    down.dataset.direction = 'down';
    down.disabled = position === outing.roadIds.length;
    down.setAttribute('aria-label', `Move ${name} later in the outing`);
    down.addEventListener('click', () => onMove?.(outing.id, roadId, 'down'));
    const remove = el('button', 'quiet-button', 'Remove from outing');
    remove.type = 'button';
    remove.dataset.removeRoad = roadId;
    remove.setAttribute('aria-label', `Remove ${name} from this outing`);
    remove.addEventListener('click', () => onRemoveRoad?.(outing.id, roadId));
    controls.append(up, down, remove);
    item.append(controls);
    roadsList.append(item);
  }
  block.append(roadsList);
  block.append(addRoad({ state, outing, roads, onAddRoad }));
  block.append(notesAndChecklist({ outing, onNotes, onAddItem, onToggleItem, onRemoveItem, onRemoveOuting }));
  return block;
}

// Adding a road picks from what is already saved, and never from anywhere else: an outing references saved roads.
function addRoad({ state, outing, roads, onAddRoad }) {
  const block = el('div', 'outing-add-road');
  const candidates = [...roads.entries()].filter(([id]) => !outing.roadIds.includes(id));
  const field = el('label', 'outing-field', 'Add a saved road');
  const select = el('select', 'outing-input');
  select.id = 'outing-add-road';
  select.append(el('option', null, candidates.length ? 'Choose a saved road…' : 'Every saved road is already in this outing'));
  for (const [id, entry] of candidates) {
    const option = el('option', null, entry.candidate.name);
    option.value = id;
    select.append(option);
  }
  select.disabled = candidates.length === 0 || outing.roadIds.length >= MAX_OUTING_ROADS;
  const add = el('button', 'quiet-button', 'Add to outing');
  add.type = 'button';
  add.id = 'outing-add-road-button';
  add.disabled = select.disabled;
  add.addEventListener('click', () => { if (select.value) onAddRoad?.(outing.id, select.value); });
  field.append(select);
  block.append(field, add);
  if (outing.roadIds.length >= MAX_OUTING_ROADS) block.append(el('p', 'small muted', `An outing holds up to ${MAX_OUTING_ROADS} roads. Remove one to add another.`));
  return block;
}

// The plan's own note and checklist: plain text, bounded, device-local, and never part of any evidence.
function notesAndChecklist({ outing, onNotes, onAddItem, onToggleItem, onRemoveItem, onRemoveOuting }) {
  const block = el('div', 'outing-plan');
  const noteField = el('label', 'outing-field', `Outing notes (up to ${OUTING_NOTE_MAX_LENGTH} characters)`);
  const note = el('textarea', 'outing-notes');
  note.id = 'outing-notes';
  note.rows = 4;
  note.maxLength = OUTING_NOTE_MAX_LENGTH;
  note.value = outing.notes;
  note.setAttribute('aria-describedby', 'outing-notes-status');
  const noteStatus = el('p', 'small muted');
  noteStatus.id = 'outing-notes-status';
  noteStatus.textContent = outing.notes ? 'Saved on this device.' : 'Notes are yours; they stay on this device.';
  note.addEventListener('input', () => { noteStatus.textContent = 'Saving…'; onNotes?.(outing.id, note.value, { immediate: false }); });
  note.addEventListener('blur', () => onNotes?.(outing.id, note.value, { immediate: true }));
  noteField.append(note);
  block.append(noteField, noteStatus);
  block.append(el('h3', null, `Checklist (${outing.checklist.length} of ${MAX_CHECKLIST_ITEMS})`));
  const items = el('ul', 'outing-checklist');
  items.id = 'outing-checklist';
  for (const item of outing.checklist) {
    const row = el('li', 'checklist-item');
    row.dataset.itemId = item.id;
    const box = el('input');
    box.type = 'checkbox';
    box.id = `checklist-${item.id}`;
    box.dataset.checklistItem = item.id;
    box.checked = item.checked;
    box.addEventListener('change', () => onToggleItem?.(outing.id, item.id));
    const label = el('label', null, item.text);
    label.setAttribute('for', box.id);
    const remove = el('button', 'quiet-button', 'Remove');
    remove.type = 'button';
    remove.dataset.removeItem = item.id;
    remove.setAttribute('aria-label', `Remove checklist item ${item.text}`);
    remove.addEventListener('click', () => onRemoveItem?.(outing.id, item.id));
    row.append(box, label, remove);
    items.append(row);
  }
  block.append(items);
  const addField = el('div', 'outing-add-item');
  const input = el('input', 'outing-input');
  input.type = 'text';
  input.id = 'outing-new-item';
  input.maxLength = MAX_CHECKLIST_TEXT;
  input.placeholder = 'Binoculars';
  input.setAttribute('aria-label', 'New checklist item');
  const add = el('button', 'quiet-button', 'Add item');
  add.type = 'button';
  add.id = 'outing-add-item-button';
  add.disabled = outing.checklist.length >= MAX_CHECKLIST_ITEMS;
  add.addEventListener('click', () => { if (input.value.trim()) onAddItem?.(outing.id, input.value); });
  addField.append(input, add);
  block.append(addField);
  block.append(removeControl(outing.id, onRemoveOuting));
  return block;
}

// REMOVING AN OUTING removes the plan and nothing else: the roads stay saved, with their notes and favorites.
function removeControl(id, onRemoveOuting) {
  const block = el('div', 'outing-remove');
  block.id = 'outing-remove';
  const note = el('p', 'small muted', 'Removing this outing does not remove any road: every road in it stays in Saved roads.');
  const ask = el('button', 'quiet-button', 'Remove outing');
  ask.type = 'button';
  ask.id = 'outing-remove-button';
  ask.addEventListener('click', () => {
    const row = el('div', 'decision-actions');
    const yes = el('button', 'quiet-button warn', 'Confirm removal of this outing');
    yes.type = 'button';
    yes.id = 'outing-remove-confirm';
    yes.addEventListener('click', () => onRemoveOuting?.(id));
    const no = el('button', 'quiet-button', 'Keep outing');
    no.type = 'button';
    no.id = 'outing-remove-cancel';
    no.addEventListener('click', () => block.replaceChildren(ask, note));
    row.append(yes, no);
    block.replaceChildren(row, note);
  });
  block.append(ask, note);
  return block;
}
