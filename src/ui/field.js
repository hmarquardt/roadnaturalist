import { MAX_CHECKLIST_ITEMS, MAX_CHECKLIST_TEXT, OUTING_NOTE_MAX_LENGTH } from '../state/outings.js';
import { FIELD_MODE_NOTE, fieldFacts } from '../state/outing-field.js';
import { LIVE_LOCATION_PRIVACY_NOTE, LIVE_LOCATION_STATUS, liveLocationAccuracyLabel, liveLocationMessage,
  liveLocationStatusLabel } from '../state/live-location.js';
import { PROXIMITY_NOTE, PROXIMITY_UNAVAILABLE } from '../state/outing-proximity.js';
import { NAVIGATION_DESTINATION_NOTE, NAVIGATION_VERIFY_NOTE, navigationDestination, navigationDestinationLabel,
  navigationLinks } from '../state/outing-navigation.js';
import { dateLabel, statusLabel } from './outings.js';

// FIELD MODE: THE SAME OUTING, READ WHERE THE ROAD IS.
//
// This is a view of one persisted plan, not a second one and not a dashboard. It shows where the person is in their own
// list, what the current road measured, what they wrote about it, the plan's checklist, and an ordinary link that hands
// one representative point on the road to the person's own mapping app. It tracks nothing: no position is requested, no
// arrival is inferred, and no distance, time or progress beyond "roads I marked" is claimed.
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

export function renderFieldMode(container, state, { view, roadNote = null, roadFavorite = false, onExit, onSelectRoad,
  onPrevious, onNext, onMarkVisited, onShowOnMap, onFitRoad, onRoadNote, onNotes, onToggleItem, onAddItem,
  location = null, proximity = null, locationSupported = false, onStartLocation, onStopLocation, onCenterOnMe,
  onFitMeAndRoad } = {}) {
  container.replaceChildren();
  if (!view) {
    container.append(el('p', 'field-empty', 'Open an outing to use field mode.'));
    return;
  }
  const block = el('section', 'field-mode');
  block.id = 'field-mode';
  block.append(head(view, onExit));
  block.append(el('p', 'small muted field-mode-note', FIELD_MODE_NOTE));
  block.append(currentRoad({ view, roadNote, roadFavorite, onMarkVisited, onShowOnMap, onFitRoad, onPrevious, onNext,
    onRoadNote, location, proximity, locationSupported, onStartLocation, onStopLocation, onCenterOnMe, onFitMeAndRoad }));
  block.append(roadList(view, onSelectRoad));
  block.append(checklist(view, { onToggleItem, onAddItem }));
  block.append(outingNotes(view, onNotes));
  container.append(block);
}

function head(view, onExit) {
  const head = el('header', 'field-head');
  head.append(el('p', 'eyebrow', 'Field mode'));
  const title = el('h3', 'field-title', view.title);
  title.id = 'field-title';
  head.append(title);
  const facts = [view.date ? dateLabel(view.date) : 'No date chosen', statusLabel(view.status)];
  head.append(el('p', 'small muted field-head-facts', facts.join(' · ')));
  // PROGRESS THROUGH THE PERSON'S OWN LIST, in the only terms this knows: roads they marked, out of roads the plan holds.
  const progress = el('p', 'field-progress');
  progress.id = 'field-progress';
  progress.textContent = `${view.progress.visited} / ${view.progress.total} roads visited · ${view.progress.percent}%`;
  head.append(progress);
  const exit = el('button', 'quiet-button', 'Leave field mode');
  exit.type = 'button';
  exit.id = 'field-exit';
  exit.addEventListener('click', () => onExit?.());
  head.append(exit);
  return head;
}


function currentRoad({ view, roadNote, roadFavorite, onMarkVisited, onShowOnMap, onFitRoad, onPrevious, onNext,
  onRoadNote, location, proximity, locationSupported, onStartLocation, onStopLocation, onCenterOnMe, onFitMeAndRoad }) {
  const member = view.current;
  const block = el('article', 'field-current');
  block.id = 'field-current';
  if (!member) {
    block.append(el('h4', null, 'This outing has no roads yet'));
    block.append(el('p', 'small muted', 'Add roads in the outing workspace, then come back to field mode.'));
    return block;
  }
  const stop = el('p', 'field-stop', `Road ${view.index + 1} of ${view.roads.length}`);
  stop.id = 'field-stop';
  block.append(stop);
  const name = el('h4', 'field-current-name', member.resolved ? member.name : 'A road that is no longer saved');
  name.id = 'field-current-name';
  block.append(name);
  if (!member.resolved) {
    // AN UNRESOLVABLE ROAD KEEPS ITS PLACE. It is reported, it can still be marked visited, and Previous/Next walk past it.
    const unavailable = el('p', 'field-unavailable', 'Road details unavailable');
    unavailable.id = 'field-unavailable';
    block.append(unavailable);
    block.append(el('p', 'small muted', member.unavailableReason ?? 'This road is not saved on this device.'));
  } else {
    const meta = [Number.isFinite(member.lengthM) ? `${(member.lengthM / 1609.344).toFixed(1)} mi` : null,
      roadFavorite ? 'Favorite' : null, member.distanceFromSearchCentreM != null
        ? `${(member.distanceFromSearchCentreM / 1609.344).toFixed(1)} mi from the search that found it` : null]
      .filter(Boolean);
    if (meta.length) block.append(el('p', 'small muted field-current-meta', meta.join(' · ')));
    const facts = el('ul', 'field-current-facts');
    facts.id = 'field-current-facts';
    for (const fact of fieldFacts(member)) {
      const item = el('li', null, `${fact.label}: ${fact.value}`);
      item.dataset.fact = fact.key;
      facts.append(item);
    }
    block.append(facts);
  }
  // THE GAP TO THE NEXT ROAD, in the plan's own words, or nothing when this is the last road.
  if (view.legToNext) {
    const leg = el('p', 'field-leg', view.legToNext.text);
    leg.id = 'field-leg';
    block.append(leg);
  }
  block.append(moveControls(view, { onPrevious, onNext }));
  block.append(visitControl(view, member, onMarkVisited, proximity));
  block.append(mapControls(member, { onShowOnMap, onFitRoad }));
  block.append(liveLocation({ member, location, proximity, locationSupported, onStartLocation, onStopLocation,
    onCenterOnMe, onFitMeAndRoad }));
  if (member.resolved) block.append(navigate(member));
  if (member.resolved) block.append(roadNoteBlock(member, roadNote, onRoadNote));
  return block;
}

// PREVIOUS / NEXT WALK THE PERSON'S OWN ORDER, and stop at its ends: there is no wrap-around and no suggestion about
// which road to do next.
function moveControls(view, { onPrevious, onNext }) {
  const row = el('div', 'field-move');
  const previous = el('button', 'quiet-button', 'Previous');
  previous.type = 'button';
  previous.id = 'field-previous';
  previous.disabled = !view.previousId;
  previous.addEventListener('click', () => onPrevious?.(view.previousId));
  const next = el('button', 'quiet-button', 'Next');
  next.type = 'button';
  next.id = 'field-next';
  next.disabled = !view.nextId;
  next.addEventListener('click', () => onNext?.(view.nextId));
  row.append(previous, next);
  return row;
}

function visitControl(view, member, onMarkVisited, proximity = null) {
  const row = el('div', 'field-visit');
  const entry = view.roads.find(road => road.roadId === member.roadId) ?? null;
  const visited = entry?.visited === true;
  const button = el('button', visited ? 'quiet-button' : 'primary-button', visited ? 'Undo visited' : 'Mark visited');
  button.type = 'button';
  button.id = visited ? 'field-unvisit' : 'field-visit-button';
  button.dataset.visited = String(visited);
  // BEING NEAR A ROAD MAKES THE BUTTON EASIER TO SEE, AND DOES NOTHING ELSE. Nothing here marks anything: the person
  // presses it, or the road stays unvisited.
  button.dataset.near = String(proximity?.near === true);
  if (proximity?.near === true && !visited) row.className += ' near';
  button.addEventListener('click', () => onMarkVisited?.(member.roadId, !visited));
  row.append(button);
  if (visited) row.append(el('span', 'small muted field-visited-at', 'Visited'));
  else if (proximity?.near === true) row.append(el('span', 'small muted field-near-note', 'You appear to be near this road.'));
  return row;
}

function mapControls(member, { onShowOnMap, onFitRoad }) {
  const row = el('div', 'field-map-controls');
  const show = el('button', 'quiet-button', 'Show on map');
  show.type = 'button';
  show.id = 'field-show-on-map';
  show.addEventListener('click', () => onShowOnMap?.(member.roadId));
  row.append(show);
  // Fitting is offered because the map already has that exact action for the selected road; it is never done for the
  // person, and moving between roads does not move the camera.
  if (member.resolved) {
    const fit = el('button', 'quiet-button', 'Fit current road');
    fit.type = 'button';
    fit.id = 'field-fit-road';
    fit.addEventListener('click', () => onFitRoad?.(member.roadId));
    row.append(fit);
  }
  return row;
}

// THE HANDOFF. Ordinary links to the person's own mapping application, built from the road's representative point - the
// same point the plan measures its separations from - and nothing else. No directions are fetched here, and Road
// Naturalist never learns what the app did with the coordinate.
function navigate(member) {
  const block = el('div', 'field-navigate');
  block.id = 'field-navigate';
  const links = navigationLinks(member);
  if (!links.length) {
    block.append(el('p', 'field-navigate-none', 'Navigation is unavailable: this road has no representative point.'));
    return block;
  }
  for (const link of links) {
    const anchor = el('a', 'field-navigate-link', `Navigate with ${link.label}`);
    anchor.href = link.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.id = `field-navigate-${link.key}`;
    block.append(anchor);
  }
  block.append(el('p', 'small muted field-destination', navigationDestinationLabel(navigationDestination(member))));
  block.append(el('p', 'small muted field-navigate-note', NAVIGATION_DESTINATION_NOTE));
  block.append(el('p', 'small muted field-navigate-note', NAVIGATION_VERIFY_NOTE));
  return block;
}

// WHERE THE PERSON IS, AND HOW FAR THE ROAD THEY ARE ON IS FROM THERE.
//
// One control that asks, one that stops, and - while a reading exists - the distance and the accuracy it came with. The
// position is never requested until the button is pressed, nothing is written down, and the two camera moves are the
// person's own. The status line says what the browser said, in the field's own words.
function liveLocation({ member, location, proximity, locationSupported, onStartLocation, onStopLocation, onCenterOnMe,
  onFitMeAndRoad }) {
  const block = el('div', 'field-location');
  block.id = 'field-location';
  const status = location?.status ?? LIVE_LOCATION_STATUS.IDLE;
  const active = status === LIVE_LOCATION_STATUS.ACTIVE;
  const asking = status === LIVE_LOCATION_STATUS.REQUESTING;
  const on = active || asking;
  // A WATCH IS STILL OPEN UNTIL IT IS STOPPED OR PERMANENTLY REFUSED, so "Stop" is offered for a device that could not
  // fix its position and for a timeout as well: both are still being watched, and both may answer later.
  const watchOpen = on || status === LIVE_LOCATION_STATUS.UNAVAILABLE || status === LIVE_LOCATION_STATUS.TIMEOUT;

  const controls = el('div', 'field-location-controls');
  // THE BUTTON IS A REQUEST, AND A RETRY. It reads "Location on" only while a reading is actually being watched, and it
  // is pressable again the moment a refusal or a timeout leaves something to try - which is what makes those states
  // recoverable rather than dead ends.
  const start = el('button', on ? 'quiet-button' : 'primary-button', on ? 'Location on' : 'Use my location');
  start.type = 'button';
  start.id = 'field-location-start';
  start.dataset.status = status;
  start.disabled = on || !locationSupported;
  start.addEventListener('click', () => onStartLocation?.());
  controls.append(start);
  if (watchOpen) {
    const stop = el('button', 'quiet-button', 'Stop');
    stop.type = 'button';
    stop.id = 'field-location-stop';
    stop.addEventListener('click', () => onStopLocation?.());
    controls.append(stop);
  }
  block.append(controls);

  const statusLine = el('p', 'field-location-status');
  statusLine.id = 'field-location-status';
  statusLine.dataset.status = status;
  statusLine.textContent = liveLocationStatusLabel(status);
  block.append(statusLine);

  // AN UNSUPPORTED BROWSER IS TOLD SO WHERE THE CONTROL IS, and the plan carries on.
  if (!locationSupported) {
    const unsupported = el('p', 'small muted', liveLocationMessage(LIVE_LOCATION_STATUS.UNSUPPORTED));
    unsupported.id = 'field-location-message';
    block.append(unsupported);
    const privacy = el('p', 'small muted field-location-privacy', LIVE_LOCATION_PRIVACY_NOTE);
    privacy.id = 'field-location-privacy';
    block.append(privacy);
    return block;
  }
  if (status !== LIVE_LOCATION_STATUS.IDLE && !active) {
    const message = el('p', 'small field-location-message', location?.message ?? liveLocationMessage(status));
    message.id = 'field-location-message';
    block.append(message);
  }

  if (active) {
    const accuracy = liveLocationAccuracyLabel(location);
    if (accuracy) {
      const accuracyLine = el('p', 'small muted field-location-accuracy', accuracy);
      accuracyLine.id = 'field-location-accuracy';
      block.append(accuracyLine);
    }
    const proximityLine = el('p', 'field-proximity');
    proximityLine.id = 'field-proximity';
    proximityLine.textContent = proximity?.label ?? PROXIMITY_UNAVAILABLE;
    proximityLine.dataset.basis = proximity?.basis ?? 'none';
    proximityLine.dataset.near = String(proximity?.near === true);
    block.append(proximityLine);
    const note = el('p', 'small muted field-proximity-note', PROXIMITY_NOTE);
    note.id = 'field-proximity-note';
    block.append(note);
    const moves = el('div', 'field-location-actions');
    const center = el('button', 'quiet-button', 'Center on me');
    center.type = 'button';
    center.id = 'field-center-on-me';
    center.addEventListener('click', () => onCenterOnMe?.());
    const fitBoth = el('button', 'quiet-button', 'Fit me + current road');
    fitBoth.type = 'button';
    fitBoth.id = 'field-fit-me-road';
    fitBoth.disabled = !member?.resolved;
    fitBoth.addEventListener('click', () => onFitMeAndRoad?.());
    moves.append(center, fitBoth);
    block.append(moves);
  }

  const privacy = el('p', 'small muted field-location-privacy', LIVE_LOCATION_PRIVACY_NOTE);
  privacy.id = 'field-location-privacy';
  block.append(privacy);
  return block;
}

function roadNoteBlock(member, roadNote, onRoadNote) {
  const block = el('div', 'field-road-note');
  const field = el('label', 'field-label', `Your note on ${member.name}`);
  const note = el('textarea', 'field-textarea');
  note.id = 'field-road-note';
  note.rows = 3;
  note.value = roadNote ?? '';
  note.placeholder = 'Where you would stop, what you saw, what to check.';
  const status = el('p', 'small muted');
  status.id = 'field-road-note-status';
  status.textContent = roadNote ? 'Saved on this device.' : 'Notes are yours; they stay on this device.';
  note.addEventListener('input', () => { status.textContent = 'Saving…'; onRoadNote?.(member.roadId, note.value, { immediate: false }); });
  note.addEventListener('blur', () => onRoadNote?.(member.roadId, note.value, { immediate: true }));
  field.append(note);
  block.append(field, status);
  return block;
}

function roadList(view, onSelectRoad) {
  const block = el('div', 'field-roads');
  block.append(el('h4', null, 'Roads in this order'));
  const list = el('ol', 'field-road-list');
  list.id = 'field-road-list';
  for (const road of view.roads) {
    const item = el('li', 'field-road');
    item.dataset.roadId = road.roadId;
    item.dataset.visited = String(road.visited);
    item.dataset.current = String(road.current);
    if (road.current) item.className += ' current';
    const open = el('button', 'field-road-name', `${road.stop}. ${road.resolved ? road.name : 'Road details unavailable'}`);
    open.type = 'button';
    open.dataset.openFieldRoad = road.roadId;
    open.setAttribute('aria-current', String(road.current));
    open.addEventListener('click', () => onSelectRoad?.(road.roadId));
    item.append(open);
    item.append(el('span', 'field-road-state small muted', road.visited ? 'Visited' : 'Not visited'));
    list.append(item);
  }
  block.append(list);
  return block;
}

// THE PLAN'S OWN CHECKLIST, checked here rather than anywhere else: no item is invented and none is hard-coded.
function checklist(view, { onToggleItem, onAddItem }) {
  const block = el('div', 'field-checklist');
  const done = view.checklist.filter(item => item.checked).length;
  block.append(el('h4', null, `Checklist (${done} of ${view.checklist.length})`));
  const list = el('ul', 'field-checklist-items');
  list.id = 'field-checklist';
  for (const item of view.checklist) {
    const row = el('li', 'field-checklist-item');
    row.dataset.itemId = item.id;
    const box = el('input');
    box.type = 'checkbox';
    box.id = `field-item-${item.id}`;
    box.dataset.fieldItem = item.id;
    box.checked = item.checked;
    box.addEventListener('change', () => onToggleItem?.(item.id));
    const label = el('label', null, item.text);
    label.setAttribute('for', box.id);
    row.append(box, label);
    list.append(row);
  }
  block.append(list);
  const add = el('div', 'field-add-item');
  const input = el('input', 'field-input');
  input.type = 'text';
  input.id = 'field-new-item';
  input.maxLength = MAX_CHECKLIST_TEXT;
  input.placeholder = 'Add an item';
  input.setAttribute('aria-label', 'New checklist item');
  const button = el('button', 'quiet-button', 'Add');
  button.type = 'button';
  button.id = 'field-add-item';
  button.disabled = view.checklist.length >= MAX_CHECKLIST_ITEMS;
  button.addEventListener('click', () => { if (input.value.trim()) onAddItem?.(input.value); });
  add.append(input, button);
  block.append(add);
  return block;
}

function outingNotes(view, onNotes) {
  const block = el('div', 'field-outing-notes');
  const field = el('label', 'field-label', 'Notes for this outing');
  const note = el('textarea', 'field-textarea');
  note.id = 'field-outing-notes';
  note.rows = 3;
  note.maxLength = OUTING_NOTE_MAX_LENGTH;
  note.value = view.notes;
  const status = el('p', 'small muted');
  status.id = 'field-outing-notes-status';
  status.textContent = view.notes ? 'Saved on this device.' : 'Notes are yours; they stay on this device.';
  note.addEventListener('input', () => { status.textContent = 'Saving…'; onNotes?.(note.value, { immediate: false }); });
  note.addEventListener('blur', () => onNotes?.(note.value, { immediate: true }));
  field.append(note);
  block.append(field, status);
  return block;
}
