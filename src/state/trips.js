import { TRIP_SAMPLING, appendTrackPoint, formatDuration, formatTrackLength, trackGeometry, trackLengthM, trackPoint,
  trackPointFromReading } from './trip-track.js';
import { isRoadVisited } from './outings.js';

// TRIPS: WHAT ACTUALLY HAPPENED, AS OPPOSED TO WHAT WAS PLANNED.
//
// An outing is a plan a person made; a trip is a recording they deliberately started and stopped. The two are separate
// records with separate lifecycles: an outing can produce several trips, a trip never rewrites its outing, and deleting a
// trip never touches a plan, a saved road or a note. A trip holds the points the device reported (sampled and validated),
// the events the person typed while out, and a snapshot of which of the outing's roads they marked visited during it.
//
// NOTHING HERE INFERS ANYTHING: a track passing a road does not visit it, a trip is not matched to a road network, and no
// route is reconstructed from a trace. It is a factual record, kept on this device.
export const TRIPS_KEY = 'roadnaturalist.trips.v1';
export const TRIPS_KIND = 'roadnaturalist-trips';
// Version 1, and the reader validates every field it reads, so an optional addition to this record does not need a bump.
export const TRIPS_SCHEMA_VERSION = 1;
export const MAX_TRIPS = 20;
// AND A TOTAL SIZE, because a count is a proxy for a resource and this is the resource: a recorded track is the largest
// thing this application writes to the device, and the browser's own store is shared with the candidate collection. The
// figure is measured rather than guessed - a recorded point is about 93 bytes of JSON, so a two-hour highway drive through
// the sampling rule is about 1,800 points and 170 kB - and it leaves room for the candidates this device already keeps.
export const MAX_TRIPS_BYTES = 1_500_000;
export const MAX_TRIP_EVENTS = 200;
export const MAX_EVENT_TEXT = 500;
export const MAX_TRIP_LABEL = 120;
export const TRIP_STATUS = Object.freeze({ RECORDING: 'recording', COMPLETED: 'completed', INTERRUPTED: 'interrupted' });
export const TRIP_EVENT_TYPE = Object.freeze({ NOTE: 'note', SIGHTING: 'sighting' });
export const TRIP_EVENT_LABEL = Object.freeze({ [TRIP_EVENT_TYPE.NOTE]: 'Field note', [TRIP_EVENT_TYPE.SIGHTING]: 'Sighting' });

export const TRIP_PRIVACY_NOTE = 'Recorded trips stay on this device unless you explicitly export them.';
export const TRIP_RECORDING_NOTE = 'Recording depends on your browser continuing to provide location updates.';

// A trip with a start and no end is the one thing a reload must not throw away: it is preserved, labelled, and finished
// or left alone by the person - never deleted and never silently completed.
export const TRIP_STATUS_LABEL = Object.freeze({ [TRIP_STATUS.RECORDING]: 'Recording', [TRIP_STATUS.COMPLETED]: 'Recorded',
  [TRIP_STATUS.INTERRUPTED]: 'Recording interrupted' });

function cleanText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what a field note must not carry
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, limit);
}

function stamp(value) {
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

export function tripId(existing = []) {
  let attempt = 0;
  let id = '';
  do {
    attempt += 1;
    id = `trip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${attempt > 1 ? `-${attempt}` : ''}`;
  } while (existing.includes(id));
  return id;
}

export function eventId(existing = []) {
  let attempt = 0;
  let id = '';
  do {
    attempt += 1;
    id = `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}${attempt > 1 ? `-${attempt}` : ''}`;
  } while (existing.includes(id));
  return id;
}

export function normalizeTripLabel(value) {
  const text = cleanText(value, MAX_TRIP_LABEL).replace(/\s+/g, ' ').trim();
  return text || 'Untitled outing';
}

// START RECORDING. The plan's identity and its title are snapshotted, because a historical record has to explain itself
// even after the plan has been renamed or deleted - and nothing else about the outing is copied.
export function createTrip({ outing = null, at = new Date().toISOString() } = {}, { existing = [] } = {}) {
  const startedAt = stamp(at) ?? new Date().toISOString();
  return Object.freeze({ id: tripId([...existing]), outingId: outing?.id ?? null,
    outingLabel: outing ? normalizeTripLabel(outing.title) : null, startedAt, endedAt: null,
    status: TRIP_STATUS.RECORDING, track: Object.freeze([]), events: Object.freeze([]),
    visitedRoadIds: Object.freeze([]),
    diagnostics: Object.freeze({ accepted: 0, skippedSampling: 0, skippedPoorAccuracy: 0, truncated: false }),
    createdAt: startedAt, updatedAt: startedAt });
}

// ONE READING, OFFERED TO A RECORDING. The sampling and accuracy rules live in `trip-track.js`; this only counts what
// they decided, so a trip can report honestly how many points it kept and why it kept so few.
export function recordTripPoint(trip, location, { at = new Date().toISOString() } = {}) {
  const reading = trackPointFromReading(location, { at });
  // A READING WITH NO POSITION IN IT IS NOT A SKIPPED POINT: it is a device that could not say where it is. Nothing is
  // counted, because no sampling decision was made - the reading never became a candidate for the track at all.
  if (!reading) return Object.freeze({ trip, added: false, reason: 'unusable' });
  const outcome = appendTrackPoint(trip.track, reading, { maxPoints: TRIP_SAMPLING.MAX_POINTS });
  if (outcome.added) {
    return Object.freeze({ trip: Object.freeze({ ...trip, track: outcome.points, updatedAt: at,
      diagnostics: Object.freeze({ ...trip.diagnostics, accepted: trip.diagnostics.accepted + 1 }) }), added: true });
  }
  if (outcome.reason === 'poor-accuracy') {
    return Object.freeze({ trip: Object.freeze({ ...trip, updatedAt: at,
      diagnostics: Object.freeze({ ...trip.diagnostics,
        skippedPoorAccuracy: trip.diagnostics.skippedPoorAccuracy + 1 }) }), added: false });
  }
  if (outcome.full) {
    return Object.freeze({ trip: Object.freeze({ ...trip, updatedAt: at,
      diagnostics: Object.freeze({ ...trip.diagnostics, truncated: true }) }), added: false });
  }
  // A reading the sampling rule did not need, and a reading that could not be validated at all: both are counted as
  // skipped rather than pretended into the track.
  return Object.freeze({ trip: Object.freeze({ ...trip, updatedAt: at,
    diagnostics: Object.freeze({ ...trip.diagnostics,
      skippedSampling: trip.diagnostics.skippedSampling + 1 }) }), added: false });
}

// A FIELD NOTE, OR A SIGHTING, WITH WHATEVER WAS TRUE AT THAT MOMENT: the time, the coordinate if there was a usable
// reading, and the road the person was on. It is deliberately not the saved road's note - that stays durable knowledge
// about the road, and this is something noticed once.
export function addTripEvent(trip, { type = TRIP_EVENT_TYPE.NOTE, text = '', point = null, roadId = null,
  at = new Date().toISOString() } = {}) {
  const body = cleanText(text, MAX_EVENT_TEXT).trim();
  if (!body) return Object.freeze({ trip, added: false, reason: 'A field note needs something written in it.' });
  if (trip.events.length >= MAX_TRIP_EVENTS) {
    return Object.freeze({ trip, added: false, reason: `A trip holds up to ${MAX_TRIP_EVENTS} events.` });
  }
  const recordedAt = stamp(at) ?? new Date().toISOString();
  const fix = trackPoint({ lon: point?.[0], lat: point?.[1], accuracyM: null, recordedAt });
  const event = Object.freeze({ id: eventId(trip.events.map(entry => entry.id)),
    type: Object.values(TRIP_EVENT_TYPE).includes(type) ? type : TRIP_EVENT_TYPE.NOTE, text: body, recordedAt,
    point: fix ? Object.freeze([fix.lon, fix.lat]) : null, roadId: typeof roadId === 'string' && roadId ? roadId : null });
  return Object.freeze({ trip: Object.freeze({ ...trip, events: Object.freeze([...trip.events, event]),
    updatedAt: recordedAt }), added: true, reason: null, event });
}

// STOPPING. The roads the person had marked visited in the plan at that moment are snapshotted, so the record says what
// was true during the trip rather than what the plan says now.
export function stopTrip(trip, { at = new Date().toISOString(), visitedRoadIds = null } = {}) {
  const endedAt = stamp(at) ?? new Date().toISOString();
  return Object.freeze({ ...trip, endedAt, status: TRIP_STATUS.COMPLETED,
    visitedRoadIds: Object.freeze([...(visitedRoadIds ?? trip.visitedRoadIds ?? [])]), updatedAt: endedAt });
}

// A RECORDING FOUND UNFINISHED. The points are kept exactly as they are, the status says what happened, and nothing is
// invented for the end - the person can finish it, or leave it as it stands.
export function markTripInterrupted(trip, { at = new Date().toISOString() } = {}) {
  if (trip.status !== TRIP_STATUS.RECORDING) return trip;
  return Object.freeze({ ...trip, status: TRIP_STATUS.INTERRUPTED, endedAt: null,
    updatedAt: stamp(at) ?? new Date().toISOString() });
}

export function finishInterruptedTrip(trip, { at = null, visitedRoadIds = null } = {}) {
  const last = trip.track[trip.track.length - 1] ?? null;
  // THE END IS THE LAST THING WE ACTUALLY KNOW: the last recorded point when there is one, otherwise the moment the
  // person finished it. Nothing is fabricated for the gap between the page closing and this.
  const endedAt = stamp(at) ?? last?.recordedAt ?? new Date().toISOString();
  return stopTrip(trip, { at: endedAt, visitedRoadIds });
}

// TRIP PERSISTENCE (device-local, and deliberately bounded).
//
// A track is far larger than a plan, so it lives in its own versioned entry with its own caps, and it never rides inside
// the outings record: a plan is a few kilobytes of user state, and a recorded track is not. The caps are measured rather
// than guessed (see the trip tests): a recorded point is about 93 bytes of JSON, a two-hour highway drive through the
// sampling rule is about 1,800 points and 170 kB, and the whole entry is bounded at `MAX_TRIPS_BYTES` so it cannot crowd
// out the candidates this device already keeps. Over a cap nothing is written and nothing is evicted: the person is told,
// and removing a trip is their decision.
//
// localStorage is untrusted input here too: every point is re-validated through `trackPoint`, every event is rebuilt
// from the fields it names, a record that cannot be read is skipped with its reason, and an unknown future version is
// left byte-for-byte untouched.
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function storedTripEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  const text = cleanText(value.text, MAX_EVENT_TEXT).trim();
  if (!text) return null;
  const recordedAt = stamp(value.recordedAt);
  if (!recordedAt) return null;
  const point = Array.isArray(value.point) && value.point.length === 2 && value.point.every(Number.isFinite)
    ? Object.freeze([Number(value.point[0]), Number(value.point[1])]) : null;
  return Object.freeze({ id: value.id,
    type: Object.values(TRIP_EVENT_TYPE).includes(value.type) ? value.type : TRIP_EVENT_TYPE.NOTE,
    text, recordedAt, point, roadId: typeof value.roadId === 'string' && value.roadId ? value.roadId : null });
}

export function storedTrip(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  const startedAt = stamp(value.startedAt);
  if (!startedAt) return null;
  const status = Object.values(TRIP_STATUS).includes(value.status) ? value.status : TRIP_STATUS.COMPLETED;
  const track = [];
  let truncated = Boolean(value.diagnostics?.truncated);
  for (const entry of Array.isArray(value.track) ? value.track : []) {
    if (track.length >= TRIP_SAMPLING.MAX_POINTS) { truncated = true; break; }
    const point = trackPoint(entry);
    if (point) track.push(point);
  }
  const events = [];
  for (const entry of Array.isArray(value.events) ? value.events : []) {
    if (events.length >= MAX_TRIP_EVENTS) break;
    const event = storedTripEvent(entry);
    if (event) events.push(event);
  }
  const visited = [];
  for (const roadId of Array.isArray(value.visitedRoadIds) ? value.visitedRoadIds : []) {
    if (typeof roadId === 'string' && roadId && !visited.includes(roadId)) visited.push(roadId);
  }
  const skippedSampling = Number.isFinite(value.diagnostics?.skippedSampling) ? Math.max(0, value.diagnostics.skippedSampling) : 0;
  const skippedPoorAccuracy = Number.isFinite(value.diagnostics?.skippedPoorAccuracy) ? Math.max(0, value.diagnostics.skippedPoorAccuracy) : 0;
  return Object.freeze({ id: value.id,
    outingId: typeof value.outingId === 'string' && value.outingId ? value.outingId : null,
    outingLabel: typeof value.outingLabel === 'string' && value.outingLabel ? normalizeTripLabel(value.outingLabel) : null,
    startedAt, endedAt: stamp(value.endedAt), status, track: Object.freeze(track), events: Object.freeze(events),
    visitedRoadIds: Object.freeze(visited),
    // The counts are rebuilt from what was actually read, so a tampered record cannot claim a track it does not have.
    diagnostics: Object.freeze({ accepted: track.length, skippedSampling, skippedPoorAccuracy, truncated }),
    createdAt: stamp(value.createdAt) ?? startedAt, updatedAt: stamp(value.updatedAt) ?? startedAt });
}

// WHAT THE TRIP ACTUALLY RECORDED, IN THE TERMS IT WAS RECORDED IN. Every number is a count or a recorded length; there
// is no average speed, no fuel, no road miles and no inference about what the trace means.
export function tripSummary(trip, { outing = null, at = Date.now() } = {}) {
  if (!trip) return null;
  const length = trackLengthM(trip.track);
  const last = trip.track[trip.track.length - 1] ?? null;
  const startedMs = new Date(trip.startedAt).getTime();
  const endedMs = trip.endedAt ? new Date(trip.endedAt).getTime()
    : last ? new Date(last.recordedAt).getTime() : startedMs;
  const events = trip.events ?? [];
  const outingRoadIds = outing?.roadIds ?? null;
  // A RECORDING STILL RUNNING HAS NO SNAPSHOT YET, so its visited count is read from the plan it is being recorded
  // against - the same count that stopping freezes into the trip. A finished or interrupted trip reads its own snapshot,
  // and never the plan's current state: history does not rewrite itself.
  const visited = trip.status === TRIP_STATUS.RECORDING && outing
    ? outing.roadIds.filter(roadId => isRoadVisited(outing.roadState, roadId))
    : trip.visitedRoadIds ?? [];
  return Object.freeze({
    id: trip.id, outingId: trip.outingId, outingLabel: outing?.title ?? trip.outingLabel ?? null,
    outingMissing: Boolean(trip.outingId) && !outing,
    status: trip.status, interrupted: trip.status === TRIP_STATUS.INTERRUPTED,
    recording: trip.status === TRIP_STATUS.RECORDING,
    startedAt: trip.startedAt, endedAt: trip.endedAt,
    durationMs: Math.max(0, endedMs - startedMs), durationLabel: formatDuration(Math.max(0, endedMs - startedMs)),
    metres: length.metres, lengthLabel: formatTrackLength(length.metres),
    points: trip.track.length, skippedSampling: trip.diagnostics?.skippedSampling ?? 0,
    skippedPoorAccuracy: trip.diagnostics?.skippedPoorAccuracy ?? 0, truncated: Boolean(trip.diagnostics?.truncated),
    skippedLegs: length.skippedLegs, skippedMetres: length.skippedMetres,
    visitedCount: visited.length, outingRoadCount: outingRoadIds?.length ?? null,
    events: events.length,
    notes: events.filter(event => event.type === TRIP_EVENT_TYPE.NOTE).length,
    sightings: events.filter(event => event.type === TRIP_EVENT_TYPE.SIGHTING).length,
    at,
  });
}

// THE EXPORT: an ordinary GeoJSON FeatureCollection, written to a file the person chose to download. Nothing is
// uploaded, and the only coordinates in it are the ones this trip recorded.
export function tripGeoJson(trip, { outing = null, at = new Date() } = {}) {
  const summary = tripSummary(trip, { outing });
  const features = [];
  const geometry = trackGeometry(trip.track);
  if (geometry) {
    features.push(Object.freeze({ type: 'Feature', geometry,
      properties: Object.freeze({ kind: 'trip-track', tripId: trip.id, status: trip.status,
        startedAt: trip.startedAt, endedAt: trip.endedAt, pointCount: trip.track.length,
        recordedLengthM: Math.round(summary.metres),
        lengthNote: 'recorded GPS track: the sum of the straight lines between recorded points, not a driving distance' }) }));
  }
  for (const point of trip.track) {
    features.push(Object.freeze({ type: 'Feature',
      geometry: Object.freeze({ type: 'Point', coordinates: Object.freeze([point.lon, point.lat]) }),
      properties: Object.freeze({ kind: 'trip-point', tripId: trip.id, recordedAt: point.recordedAt,
        accuracyM: point.accuracyM }) }));
  }
  for (const event of trip.events ?? []) {
    features.push(Object.freeze({ type: 'Feature',
      geometry: event.point ? Object.freeze({ type: 'Point', coordinates: Object.freeze([event.point[0], event.point[1]]) })
        : null,
      properties: Object.freeze({ kind: 'trip-event', tripId: trip.id, eventId: event.id, eventType: event.type,
        label: TRIP_EVENT_LABEL[event.type] ?? event.type, text: event.text, recordedAt: event.recordedAt,
        roadId: event.roadId }) }));
  }
  return Object.freeze({ type: 'FeatureCollection', features: Object.freeze(features),
    properties: Object.freeze({ generator: 'Road Naturalist', exportedAt: at.toISOString(), tripId: trip.id,
      label: outing?.title ?? trip.outingLabel ?? null, outingId: trip.outingId, status: trip.status,
      startedAt: trip.startedAt, endedAt: trip.endedAt, recordedPoints: trip.track.length,
      recordedLengthM: Math.round(summary.metres), skippedPoorAccuracy: summary.skippedPoorAccuracy,
      skippedSampling: summary.skippedSampling, truncated: summary.truncated, events: summary.events,
      note: 'Recorded on this device by Road Naturalist. It is a factual GPS recording and a set of notes: no route was reconstructed, no road was matched to the trace, and no distance here is a driving distance.' }) });
}

// WHAT A RECORDING HAS SO FAR, WHILE IT IS STILL RUNNING. Counts and a recorded length - never a speed, never an
// estimate, and never a claim about which roads the trace followed.
export function recordingLine(summary) {
  if (!summary) return '';
  const parts = [`${summary.points} recorded point${summary.points === 1 ? '' : 's'}`];
  if (summary.points > 1) parts.push(`${summary.lengthLabel} recorded GPS track`);
  parts.push(`${summary.events} field event${summary.events === 1 ? '' : 's'}`);
  if (summary.visitedCount) parts.push(`${summary.visitedCount} road${summary.visitedCount === 1 ? '' : 's'} marked visited`);
  return parts.join(' · ');
}

export function timeOfDay(value) {
  const parsed = new Date(value ?? '');
  if (!Number.isFinite(parsed.getTime())) return 'Time not recorded';
  return parsed.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// ONE EVENT, SAID AS WHAT IT IS: when it happened, what kind it is, and whether a position was captured with it.
export function eventLine(event, { roadName = null } = {}) {
  if (!event) return '';
  const parts = [timeOfDay(event.recordedAt), TRIP_EVENT_LABEL[event.type] ?? event.type];
  if (roadName) parts.push(roadName);
  else if (event.point) parts.push('with a recorded position');
  else if (event.roadId) parts.push('road no longer saved');
  return parts.join(' · ');
}

// THE POSITION AN EVENT CARRIES: the trip's own last recorded point when there is one, otherwise a live reading that
// currently has a position. Nothing is invented, and an event with neither carries no coordinate at all.
export function tripEventPoint(trip, location = null) {
  const last = trip?.track?.[trip.track.length - 1] ?? null;
  if (last) return Object.freeze([last.lon, last.lat]);
  const point = Array.isArray(location?.point) ? location.point : null;
  return point?.length === 2 && point.every(Number.isFinite) ? Object.freeze([point[0], point[1]]) : null;
}

// WHAT A FINISHED TRIP RECORDED, IN THE ORDER A PERSON WOULD READ IT. Every line is a fact about the recording: no
// average speed, no road miles, and no statement about what the trace means.
export function tripSummaryRows(summary, { roadNames = null } = {}) {
  if (!summary) return [];
  const rows = [['Recorded', `${summary.durationLabel} · ${timeOfDay(summary.startedAt)} to ${summary.endedAt ? timeOfDay(summary.endedAt) : 'not recorded'}`],
    ['Recorded GPS track', summary.points > 1 ? summary.lengthLabel : 'not enough points for a distance'],
    ['Recorded points', `${summary.points} kept${summary.skippedSampling ? ` · ${summary.skippedSampling} not needed by the sampling rule` : ''}${summary.skippedPoorAccuracy ? ` · ${summary.skippedPoorAccuracy} too inaccurate to record` : ''}`]];
  if (summary.skippedLegs) rows.push(['Implausible jumps', `${summary.skippedLegs} leg${summary.skippedLegs === 1 ? '' : 's'} left out of the distance (not removed from the track)`]);
  rows.push(['Roads marked visited', summary.outingRoadCount != null
    ? `${summary.visitedCount} / ${summary.outingRoadCount} roads in this outing, marked by hand`
    : `${summary.visitedCount} recorded (the plan is no longer on this device)`]);
  rows.push(['Field events', `${summary.notes} note${summary.notes === 1 ? '' : 's'} · ${summary.sightings} sighting${summary.sightings === 1 ? '' : 's'}`]);
  if (roadNames?.length) rows.push(['Those roads', roadNames.join(' · ')]);
  return rows;
}

export function tripExportText(trip, options = {}) {
  return `${JSON.stringify(tripGeoJson(trip, options), null, 2)}\n`;
}

export function tripExportFilename(trip) {
  const day = trip.startedAt.slice(0, 10);
  return `road-naturalist-trip-${day}-${trip.id}.geojson`;
}

export function readStoredTrips(storage = defaultStorage()) {
  const empty = (status, reason = null, bytes = 0, skipped = Object.freeze([])) => Object.freeze({
    trips: Object.freeze([]), skipped, bytes, status, reason });
  if (!storage) return empty('unavailable', 'This browser has no local storage.');
  let raw = null;
  let parsed = null;
  try {
    raw = storage.getItem(TRIPS_KEY);
    if (!raw) return empty('empty');
    parsed = JSON.parse(raw);
  } catch {
    return empty('unsupported', 'The stored trips could not be read and were ignored.');
  }
  if (parsed?.kind !== TRIPS_KIND) return empty('unsupported', 'The stored trips are not a trip record and were ignored.', raw.length);
  if (parsed.version !== TRIPS_SCHEMA_VERSION) {
    return empty('unsupported', `Stored trips use version ${JSON.stringify(parsed.version)}, which this build does not read; they were left untouched.`, raw.length);
  }
  if (!Array.isArray(parsed.trips)) {
    return empty('unsupported', 'The stored trip list is not a list and was ignored; it was left untouched.', raw.length);
  }
  const trips = [];
  const skipped = [];
  const seen = new Set();
  for (const record of parsed.trips) {
    const trip = storedTrip(record);
    if (!trip) { skipped.push(Object.freeze({ id: typeof record?.id === 'string' ? record.id : null,
      reason: 'the record is not a usable trip' })); continue; }
    if (seen.has(trip.id)) { skipped.push(Object.freeze({ id: trip.id, reason: 'the same trip id appears twice' })); continue; }
    seen.add(trip.id);
    trips.push(trip);
  }
  return Object.freeze({ trips: Object.freeze(trips), skipped: Object.freeze(skipped), bytes: raw.length,
    status: trips.length ? 'restored' : 'empty', reason: null });
}

export function writeStoredTrips(trips, { storage = defaultStorage(), savedAt = new Date().toISOString() } = {}) {
  const records = (trips ?? []).map(trip => ({ id: trip.id, outingId: trip.outingId ?? null,
    outingLabel: trip.outingLabel ?? null, startedAt: trip.startedAt, endedAt: trip.endedAt ?? null,
    status: trip.status, track: trip.track.map(point => ({ lon: point.lon, lat: point.lat,
      accuracyM: point.accuracyM ?? null, recordedAt: point.recordedAt })),
    events: trip.events.map(event => ({ id: event.id, type: event.type, text: event.text,
      recordedAt: event.recordedAt, point: event.point ?? null, roadId: event.roadId ?? null })),
    visitedRoadIds: [...(trip.visitedRoadIds ?? [])], diagnostics: { ...trip.diagnostics },
    createdAt: trip.createdAt ?? null, updatedAt: trip.updatedAt ?? null }));
  if (records.length > MAX_TRIPS) {
    return Object.freeze({ ok: false, count: 0, bytes: 0, status: 'full', savedAt: null,
      reason: `This device holds the maximum of ${MAX_TRIPS} recorded trips. Remove one to record another.` });
  }
  const text = JSON.stringify({ kind: TRIPS_KIND, version: TRIPS_SCHEMA_VERSION, savedAt, trips: records });
  if (text.length > MAX_TRIPS_BYTES) {
    return Object.freeze({ ok: false, count: 0, bytes: 0, status: 'full', savedAt: null,
      reason: `This device already holds as much recorded trip data as it can (about ${Math.round(MAX_TRIPS_BYTES / 100000) / 10} MB). Remove a recorded trip to record another.` });
  }
  if (!storage) {
    return Object.freeze({ ok: false, count: 0, bytes: 0, status: 'unavailable', savedAt: null,
      reason: 'This browser has no local storage, so recorded trips are kept for this session only.' });
  }
  try {
    if (!records.length) storage.removeItem(TRIPS_KEY);
    else storage.setItem(TRIPS_KEY, text);
  } catch (error) {
    return Object.freeze({ ok: false, count: 0, bytes: 0, status: 'unavailable', savedAt: null,
      reason: `The trip could not be saved on this device: ${error.message}` });
  }
  return Object.freeze({ ok: true, count: records.length, bytes: text.length, savedAt, status: 'saved', reason: null });
}

// A TRIP REMOVED IS A TRIP REMOVED. The caller keeps the rest of the collection; nothing about an outing, a saved road,
// a road note or a checklist is touched by this function or by any caller of it.
export function withoutTrip(trips, tripId) {
  return (trips ?? []).filter(trip => trip.id !== tripId);
}
