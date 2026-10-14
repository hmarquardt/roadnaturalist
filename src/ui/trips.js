import { MAX_TRIPS, TRIP_PRIVACY_NOTE, TRIP_RECORDING_NOTE, TRIP_STATUS, TRIP_STATUS_LABEL, eventLine, timeOfDay,
  tripSummaryRows } from '../state/trips.js';

// RECORDED TRIPS: WHAT ACTUALLY HAPPENED, KEPT ON THIS DEVICE.
//
// A compact history, not an analytics dashboard. Each recording shows its date, the plan it was started from, how long it
// ran, how long the recorded track is, how many roads the person marked visited by hand and how many events they typed.
// Opening one shows its track controls, its events and its roads; deleting one removes the trip and nothing else - not the
// outing, not a saved road, not a note, not a checklist.
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

export function renderTrips(container, state, { trips = [], selectedTripId = null, recording = null,
  recordingSummary = null, summaries = {}, roadNames = {}, onStartRecording, onStopRecording, onOpenTrip, onDeleteTrip,
  onExportTrip, onFinishTrip, onFitTrack } = {}) {
  container.replaceChildren();
  if (!trips.length && !recording) {
    container.append(el('p', 'small muted trips-note',
      'No trips recorded yet. Start recording in field mode to keep the track you actually drove, with your own notes.'));
    container.append(el('p', 'small muted trips-note', TRIP_PRIVACY_NOTE));
    return;
  }
  container.append(el('p', 'small muted trips-note',
    'A trip is what actually happened: the points this device reported while you were recording, the notes and sightings you typed, and the roads you marked visited yourself. Nothing here is inferred from the track.'));
  // A REFUSED SAVE IS SAID OUT LOUD. The trip is still in memory for this session, and the person is the one who decides
  // what to remove: nothing is evicted on their behalf.
  if (state.tripStorage?.reason) container.append(el('p', 'small trips-storage-note', state.tripStorage.reason));

  if (recording) {
    const banner = el('div', 'trip-recording-banner');
    banner.id = 'trip-recording-banner';
    banner.dataset.tripId = recording.id;
    banner.append(el('span', null, `Recording${recordingSummary ? ` · ${recordingSummary.points} recorded points · ${recordingSummary.lengthLabel} recorded GPS track` : ''}`));
    const stop = el('button', 'quiet-button', 'Stop recording');
    stop.type = 'button';
    stop.id = 'trips-stop-recording';
    stop.addEventListener('click', () => onStopRecording?.());
    banner.append(stop);
    container.append(banner);
  }
  // A RECORDING FOUND UNFINISHED IS NOT A FAILURE TO REPORT AWAY: it is preserved, labelled, and the person decides
  // whether to finish it or leave it as it stands.
  for (const trip of trips.filter(entry => entry.status === TRIP_STATUS.INTERRUPTED)) {
    const notice = el('p', 'trips-storage-note');
    notice.id = `trip-interrupted-${trip.id}`;
    notice.textContent = `A recording started ${timeOfDay(trip.startedAt)} was interrupted when this page closed. Its ${trip.track.length} recorded point${trip.track.length === 1 ? '' : 's'} are kept. Finish it to record an end, or delete it.`;
    container.append(notice);
  }

  const list = el('ul', 'trip-list');
  list.id = 'trip-list';
  for (const trip of trips) {
    const item = el('li', 'trip');
    item.dataset.tripId = trip.id;
    const open = el('button', 'trip-open');
    open.type = 'button';
    open.id = `trip-open-${trip.id}`;
    open.setAttribute('aria-expanded', String(trip.id === selectedTripId));
    const summary = summaries[trip.id] ?? null;
    open.append(el('span', 'trip-headline', `${dateTimeLabel(trip.startedAt)} · ${summary?.outingLabel ?? 'No outing'}`));
    open.append(el('span', 'trip-facts', summary ? tripFacts(summary) : ''));
    if (trip.status !== TRIP_STATUS.COMPLETED) open.append(el('span', 'trip-status', TRIP_STATUS_LABEL[trip.status] ?? trip.status));
    open.addEventListener('click', () => onOpenTrip?.(trip.id === selectedTripId ? null : trip.id));
    item.append(open);
    list.append(item);
    if (trip.id === selectedTripId) item.append(tripDetail(trip, { summary, roadNames, onDeleteTrip, onExportTrip,
      onFinishTrip, onFitTrack }));
  }
  container.append(list);
  container.append(el('p', 'small muted trips-note', TRIP_PRIVACY_NOTE));
  container.append(el('p', 'small muted trips-note', TRIP_RECORDING_NOTE));
}

function tripFacts(summary) {
  return [summary.durationLabel, `${summary.lengthLabel} recorded GPS track`, `${summary.points} points`,
    `${summary.visitedCount}${summary.outingRoadCount != null ? ` / ${summary.outingRoadCount}` : ''} roads marked visited`,
    `${summary.events} event${summary.events === 1 ? '' : 's'}`].join(' · ');
}

export function dateTimeLabel(value) {
  const parsed = new Date(value ?? '');
  if (!Number.isFinite(parsed.getTime())) return 'Date not recorded';
  return `${parsed.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })} · ${timeOfDay(value)}`;
}

export const TRIPS_LIMIT_NOTE = `This device holds up to ${MAX_TRIPS} recorded trips.`;

// ONE TRIP, OPENED. Its track (on the map), its events, the roads it snapshotted, and the two things a person can do with
// it: export it, or delete it.
function tripDetail(trip, { summary, roadNames, onDeleteTrip, onExportTrip, onFinishTrip, onFitTrack }) {
  const detail = el('div', 'trip-detail');
  detail.id = `trip-detail-${trip.id}`;
  const rows = tripSummaryRows(summary, { roadNames: trip.visitedRoadIds.map(roadId => roadNames[roadId] ?? 'Road no longer saved') });
  const list = el('ul', 'trip-summary');
  for (const [label, value] of rows) {
    const row = el('li', null);
    row.append(el('strong', null, `${label}: `), el('span', null, value));
    list.append(row);
  }
  detail.append(list);

  if (trip.status === TRIP_STATUS.INTERRUPTED) {
    const finish = el('button', 'quiet-button', 'Finish this recording');
    finish.type = 'button';
    finish.id = `trip-finish-${trip.id}`;
    finish.addEventListener('click', () => onFinishTrip?.(trip.id));
    detail.append(finish);
  }

  if (trip.events.length) {
    const events = el('ul', 'trip-events');
    events.id = `trip-events-${trip.id}`;
    for (const event of trip.events) {
      const item = el('li', 'trip-event');
      item.dataset.eventId = event.id;
      item.dataset.eventType = event.type;
      item.append(el('span', 'trip-event-when', eventLine(event,
        { roadName: event.roadId ? (roadNames[event.roadId] ?? null) : null })));
      item.append(el('span', 'trip-event-text', event.text));
      events.append(item);
    }
    detail.append(events);
  } else {
    detail.append(el('p', 'small muted', 'No field notes or sightings were recorded on this trip.'));
  }

  const roads = el('ul', 'trip-roads');
  roads.id = `trip-roads-${trip.id}`;
  if (!trip.visitedRoadIds.length) {
    roads.append(el('li', 'small muted', summary?.outingRoadCount != null
      ? 'No roads were marked visited during this recording.'
      : 'No roads were marked visited, and the plan this trip was started from is no longer on this device.'));
  }
  for (const roadId of trip.visitedRoadIds) {
    const item = el('li', null, roadNames[roadId] ?? 'Road no longer saved');
    item.dataset.roadId = roadId;
    roads.append(item);
  }
  detail.append(el('h4', null, 'Roads marked visited by hand'), roads);

  const actions = el('div', 'trip-actions');
  const fit = el('button', 'quiet-button', 'Fit recorded track');
  fit.type = 'button';
  fit.id = `trip-fit-${trip.id}`;
  fit.disabled = trip.track.length < 2;
  fit.addEventListener('click', () => onFitTrack?.(trip.id));
  actions.append(fit);
  const exportButton = el('button', 'quiet-button', 'Export GeoJSON');
  exportButton.type = 'button';
  exportButton.id = `trip-export-${trip.id}`;
  exportButton.disabled = !trip.track.length && !trip.events.length;
  exportButton.addEventListener('click', () => onExportTrip?.(trip.id));
  actions.append(exportButton);
  detail.append(actions);

  // DELETION IS THE PERSON'S, AND IT IS NARROW: the trip, its points and its events. The confirmation says exactly what
  // is removed and what is not.
  const remove = el('button', 'quiet-button trip-delete', 'Delete this recorded trip');
  remove.type = 'button';
  remove.id = `trip-delete-${trip.id}`;
  remove.addEventListener('click', () => {
    const ok = globalThis.confirm?.('Delete this recorded trip? Its track, its notes and its sightings are removed from this device. Your outing, your saved roads and your road notes are not affected.');
    if (ok !== false) onDeleteTrip?.(trip.id);
  });
  detail.append(remove);
  return detail;
}

