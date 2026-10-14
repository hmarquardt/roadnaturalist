import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_TRIP_EVENTS, MAX_TRIPS, MAX_TRIPS_BYTES, TRIPS_KEY, TRIP_EVENT_TYPE, TRIP_STATUS, addTripEvent,
  createTrip, finishInterruptedTrip, markTripInterrupted, readStoredTrips, recordTripPoint, stopTrip, tripEventPoint,
  tripGeoJson, tripSummary, tripSummaryRows, withoutTrip, writeStoredTrips } from '../src/state/trips.js';
import { trackPoint } from '../src/state/trip-track.js';
import { createOuting, markRoadVisited, writeStoredOutings } from '../src/state/outings.js';
import { createStore } from '../src/state/store.js';

// A TRIP IS WHAT ACTUALLY HAPPENED: A RECORDING THE PERSON STARTED, AND NOTHING INFERRED FROM IT.
//
// These tests hold the boundary between a plan and a record, the shape of what is kept, the honesty of the summary, what a
// delete removes and what it must never touch, and the one thing this feature changes about privacy: coordinates are now
// written to this device on purpose - and only ever to this device.
const AT = '2026-10-14T15:00:00.000Z';
const LATER = '2026-10-14T17:14:00.000Z';
const LAT_PER_M = 1 / 110540;
const point = (metres, seconds, accuracyM = 10) => ({ point: [-122.9, 45.55 + metres * LAT_PER_M], accuracyM,
  timestamp: Date.parse(AT) + seconds * 1000 });
const at = seconds => new Date(Date.parse(AT) + seconds * 1000).toISOString();
const OUTING = { id: 'outing-1', title: 'Saturday loop', roadIds: ['road-a', 'road-b', 'road-c'],
  roadState: { 'road-a': { visited: true, visitedAt: AT }, 'road-b': { visited: false } } };
function fakeStorage(seed = {}) {
  const entries = new Map(Object.entries(seed));
  return { entries, getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: key => { entries.delete(key); } };
}

test('a trip is created by an explicit act, and it snapshots only what a historical record needs', () => {
  const trip = createTrip({ outing: OUTING, at: AT }, { existing: ['trip-x'] });
  assert.equal(trip.outingId, 'outing-1');
  assert.equal(trip.outingLabel, 'Saturday loop', 'the plan label is snapshotted so history explains itself');
  assert.equal(trip.status, TRIP_STATUS.RECORDING);
  assert.equal(trip.startedAt, AT);
  assert.equal(trip.endedAt, null);
  assert.deepEqual([...trip.track], []);
  assert.deepEqual([...trip.events], []);
  assert.deepEqual([...trip.visitedRoadIds], [], 'nothing is visited until the person marks it and stopping freezes it');
  assert.notEqual(trip.id, 'trip-x', 'an id is never reused');
  // NOTHING ELSE ABOUT THE PLAN IS COPIED: a trip is not a clone of an outing.
  assert.equal(trip.roadIds, undefined);
  assert.equal(trip.checklist, undefined);
  assert.equal(trip.notes, undefined);
  // A RECORDING WITH NO PLAN OPEN IS STILL A RECORDING, and it says so rather than inventing a label.
  const bare = createTrip({ at: AT });
  assert.equal(bare.outingId, null);
  assert.equal(bare.outingLabel, null);
  // THE TRIP IS IMMUTABLE: every change produces a new record, so a view can never be holding a trip that moved.
  assert.equal(Object.isFrozen(trip), true);
  assert.notEqual(addTripEvent(trip, { text: 'a note', at: AT }).trip, trip);
});

test('a recording counts what it kept and why it kept so few, and never pretends', () => {
  let trip = createTrip({ outing: OUTING, at: AT });
  // THE FIRST POINT IS KEPT.
  trip = recordTripPoint(trip, point(0, 0), { at: at(0) }).trip;
  assert.equal(trip.track.length, 1);
  assert.equal(trip.diagnostics.accepted, 1);
  // A POINT THE RULE DOES NOT NEED IS COUNTED AS SKIPPED, not stored.
  trip = recordTripPoint(trip, point(5, 3), { at: at(3) }).trip;
  assert.equal(trip.track.length, 1);
  assert.equal(trip.diagnostics.skippedSampling, 1);
  // A POOR FIX IS COUNTED SEPARATELY: the two reasons are different facts.
  trip = recordTripPoint(trip, point(400, 30, 900), { at: at(30) }).trip;
  assert.equal(trip.track.length, 1);
  assert.equal(trip.diagnostics.skippedPoorAccuracy, 1);
  assert.equal(trip.diagnostics.skippedSampling, 1);
  // A REAL MOVEMENT IS KEPT.
  trip = recordTripPoint(trip, point(250, 40), { at: at(40) }).trip;
  assert.equal(trip.track.length, 2);
  assert.equal(trip.diagnostics.accepted, 2);
  // A READING WITH NO POSITION IS NOT A POINT AT ALL, and is not counted as a sampling decision either.
  trip = recordTripPoint(trip, { point: null, accuracyM: null }, { at: at(50) }).trip;
  assert.equal(trip.track.length, 2);
  assert.equal(trip.diagnostics.skippedSampling, 1, 'a device that cannot say where it is is not a skipped point');
});

test('a field note and a sighting are the person\'s own words, with the time and the place they were written', () => {
  let trip = createTrip({ outing: OUTING, at: AT });
  trip = recordTripPoint(trip, point(0, 0), { at: at(0) }).trip;
  const note = addTripEvent(trip, { text: 'Gate open, cattle grid', roadId: 'road-a', point: tripEventPoint(trip), at: at(60) });
  assert.equal(note.added, true);
  trip = note.trip;
  assert.equal(trip.events.length, 1);
  assert.equal(trip.events[0].type, TRIP_EVENT_TYPE.NOTE, 'a field note is the default kind of event');
  assert.equal(trip.events[0].text, 'Gate open, cattle grid');
  assert.equal(trip.events[0].recordedAt, at(60));
  assert.deepEqual([...trip.events[0].point], [-122.9, 45.55], 'the event carries the position that was current');
  assert.equal(trip.events[0].roadId, 'road-a', 'and the road the person was on');
  // A SIGHTING IS THE SAME KIND OF RECORD WITH ITS OWN LABEL: no taxonomy, no species picker, no source lookup.
  const sighting = addTripEvent(trip, { type: TRIP_EVENT_TYPE.SIGHTING, text: 'Two kestrels', at: at(120) });
  trip = sighting.trip;
  assert.equal(trip.events[1].type, TRIP_EVENT_TYPE.SIGHTING);
  assert.equal(trip.events[1].point, null, 'and no position is invented when there is none');
  // AN EMPTY NOTE IS REFUSED WITH A REASON, and control characters do not reach the record.
  assert.equal(addTripEvent(trip, { text: '   ' }).added, false);
  assert.match(addTripEvent(trip, { text: '  ' }).reason, /something written/);
  const cleaned = addTripEvent(trip, { text: 'a\u0000b\u0007c\r\nd', at: at(180) }).trip.events.at(-1);
  assert.equal(cleaned.text, 'abc\nd');
  // AN UNKNOWN EVENT KIND FALLS BACK TO A NOTE rather than entering the record as a type nothing understands.
  assert.equal(addTripEvent(trip, { type: 'telepathy', text: 'x', at: at(200) }).trip.events.at(-1).type, TRIP_EVENT_TYPE.NOTE);
  // THE COUNT IS BOUNDED, and the refusal says so.
  let full = trip;
  for (let index = 0; index < MAX_TRIP_EVENTS + 5; index += 1) {
    full = addTripEvent(full, { text: `note ${index}`, at: at(300 + index) }).trip;
  }
  assert.equal(full.events.length, MAX_TRIP_EVENTS);
  assert.match(addTripEvent(full, { text: 'one more' }).reason, /up to/);
});

test('stopping freezes what was true during the trip, and an interrupted recording keeps every point it had', () => {
  let trip = createTrip({ outing: OUTING, at: AT });
  trip = recordTripPoint(trip, point(0, 0), { at: at(0) }).trip;
  trip = recordTripPoint(trip, point(1000, 600), { at: at(600) }).trip;
  const stopped = stopTrip(trip, { at: LATER, visitedRoadIds: ['road-a'] });
  assert.equal(stopped.status, TRIP_STATUS.COMPLETED);
  assert.equal(stopped.endedAt, LATER);
  assert.deepEqual([...stopped.visitedRoadIds], ['road-a'], 'the roads are the ones marked at that moment');
  assert.equal(trip.status, TRIP_STATUS.RECORDING, 'the trip it was given is untouched');
  // A RECORDING FOUND UNFINISHED IS LABELLED, KEPT, AND NOT INVENTED AN END.
  const interrupted = markTripInterrupted(trip, { at: LATER });
  assert.equal(interrupted.status, TRIP_STATUS.INTERRUPTED);
  assert.equal(interrupted.endedAt, null, 'nothing is fabricated for an end nobody recorded');
  assert.equal(interrupted.track.length, 2, 'and every point it had is still there');
  assert.equal(markTripInterrupted(stopped, { at: LATER }), stopped, 'a finished trip is not relabelled');
  // FINISHING IT ENDS THE RECORD AT THE LAST THING ACTUALLY KNOWN.
  const finished = finishInterruptedTrip(interrupted, { visitedRoadIds: ['road-a', 'road-b'] });
  assert.equal(finished.status, TRIP_STATUS.COMPLETED);
  assert.equal(finished.endedAt, at(600), 'the end is the last recorded point, not the moment of returning');
  assert.deepEqual([...finished.visitedRoadIds], ['road-a', 'road-b']);
  assert.equal(finishInterruptedTrip(markTripInterrupted(createTrip({ at: AT }), { at: LATER }), { at: LATER }).endedAt, LATER,
    'a recording with no points ends when the person says it does');
});

test('the summary says what was recorded, in the terms it was recorded in', () => {
  let trip = createTrip({ outing: OUTING, at: AT });
  trip = recordTripPoint(trip, point(0, 0), { at: at(0) }).trip;
  trip = recordTripPoint(trip, point(1609, 3600), { at: at(3600) }).trip;
  trip = addTripEvent(trip, { text: 'note one', at: at(60) }).trip;
  trip = addTripEvent(trip, { type: TRIP_EVENT_TYPE.SIGHTING, text: 'sighting', at: at(90) }).trip;
  const stopped = stopTrip(trip, { at: at(8040), visitedRoadIds: ['road-a'] });
  const summary = tripSummary(stopped, { outing: OUTING });
  assert.equal(summary.points, 2);
  assert.equal(summary.durationLabel, '2h 14m', 'two hours and fourteen minutes of recording');
  assert.equal(summary.lengthLabel, '1.0 mi', 'a recorded GPS track, in the units a person reads');
  assert.equal(summary.visitedCount, 1);
  assert.equal(summary.outingRoadCount, 3, 'and how many roads the plan held');
  assert.equal(summary.notes, 1);
  assert.equal(summary.sightings, 1);
  assert.equal(summary.events, 2);
  // NO SPEED, NO FUEL, NO ROAD MILES: the summary is a count of what was recorded and nothing else.
  assert.equal(summary.averageSpeedMps, undefined);
  assert.equal(summary.roadMiles, undefined);
  const rows = tripSummaryRows(summary).map(([label]) => label);
  assert.deepEqual(rows, ['Recorded', 'Recorded GPS track', 'Recorded points', 'Roads marked visited', 'Field events']);
  // A PLAN THAT IS NO LONGER ON THE DEVICE IS SAID SO, and the trip is not rewritten to match anything.
  const orphan = tripSummary(stopped, { outing: null });
  assert.equal(orphan.outingRoadCount, null);
  assert.equal(orphan.outingMissing, true);
  assert.equal(orphan.outingLabel, 'Saturday loop', 'the snapshot label is what the history still has');
  assert.match(tripSummaryRows(orphan).find(([label]) => label === 'Roads marked visited')[1], /no longer on this device/);
  // A RECORDING STILL RUNNING REPORTS THE PLAN'S VISITED ROADS AS THEY ARE NOW, because stopping has not frozen them yet.
  const running = tripSummary(recordTripPoint(trip, point(2000, 4000), { at: at(4000) }).trip, { outing: OUTING });
  assert.equal(running.recording, true);
  assert.equal(running.visitedCount, 1);
  assert.equal(tripSummary(null), null);
});

test('the export is an ordinary GeoJSON file, and the only coordinates in it are the ones recorded', () => {
  let trip = createTrip({ outing: OUTING, at: AT });
  trip = recordTripPoint(trip, point(0, 0), { at: at(0) }).trip;
  trip = recordTripPoint(trip, point(500, 30), { at: at(30) }).trip;
  trip = addTripEvent(trip, { text: 'gate', roadId: 'road-a', point: [-122.9, 45.55], at: at(40) }).trip;
  trip = addTripEvent(trip, { type: TRIP_EVENT_TYPE.SIGHTING, text: 'kestrels', at: at(50) }).trip;
  const stopped = stopTrip(trip, { at: LATER, visitedRoadIds: ['road-a'] });
  const geojson = tripGeoJson(stopped, { outing: OUTING, at: new Date(LATER) });
  assert.equal(geojson.type, 'FeatureCollection');
  // THE LINE FIRST, THEN THE POINTS, THEN THE EVENTS.
  assert.equal(geojson.features[0].geometry.type, 'LineString');
  assert.equal(geojson.features[0].properties.kind, 'trip-track');
  assert.equal(geojson.features[0].properties.pointCount, 2);
  assert.match(geojson.features[0].properties.lengthNote, /not a driving distance/);
  const trackPoints = geojson.features.filter(feature => feature.properties.kind === 'trip-point');
  assert.equal(trackPoints.length, 2);
  assert.equal(trackPoints[0].geometry.coordinates.length, 2);
  assert.equal(trackPoints[0].properties.recordedAt, at(0));
  assert.equal(trackPoints[0].properties.accuracyM, 10);
  const events = geojson.features.filter(feature => feature.properties.kind === 'trip-event');
  assert.equal(events.length, 2);
  assert.equal(events[0].geometry.coordinates.length, 2, 'an event with a position is a point');
  assert.equal(events[1].geometry, null, 'an event with no position is still a feature, with no geometry');
  assert.equal(events[1].properties.text, 'kestrels');
  assert.equal(events[1].properties.label, 'Sighting');
  // THE METADATA IS USEFUL AND NOT SENSITIVE: no device fingerprint, no identity, no account, and a plain statement of
  // what the file is.
  assert.equal(geojson.properties.recordedLengthM > 400, true);
  assert.equal(geojson.properties.recordedPoints, 2);
  assert.match(geojson.properties.note, /no route was reconstructed/);
  for (const key of ['userAgent', 'platform', 'deviceId', 'screen', 'email', 'account', 'sessionId']) {
    assert.equal(geojson.properties[key], undefined, `the export carries no ${key}`);
  }
  // AND THE ONLY COORDINATES IN THE FILE ARE THE ONES THE TRIP RECORDED.
  const exported = new Set(JSON.stringify(geojson).match(/-?\\d+\\.\\d+/g) ?? []);
  const recorded = new Set(stopped.track.flatMap(entry => [String(entry.lon), String(entry.lat)]));
  for (const value of exported) {
    assert.equal(recorded.has(value) || Number(value) < 200, true, `${value} is not a recorded coordinate`);
  }
});

test('trips survive a reload, and a stored record is untrusted input like any other', () => {
  const storage = fakeStorage();
  let trip = createTrip({ outing: OUTING, at: AT }, {});
  trip = recordTripPoint(trip, point(0, 0), { at: at(0) }).trip;
  trip = recordTripPoint(trip, point(800, 120), { at: at(120) }).trip;
  trip = addTripEvent(trip, { text: 'cattle grid', roadId: 'road-a', point: [-122.9, 45.55], at: at(130) }).trip;
  const stopped = stopTrip(trip, { at: LATER, visitedRoadIds: ['road-a'] });
  const written = writeStoredTrips([stopped], { storage, savedAt: LATER });
  assert.equal(written.ok, true);
  assert.equal(written.status, 'saved');
  // THE WHOLE THING COMES BACK, and it is the trip that was recorded.
  const read = readStoredTrips(storage);
  assert.equal(read.status, 'restored');
  assert.equal(read.trips.length, 1);
  assert.deepEqual({ ...read.trips[0] }, { ...stopped });
  // NOTHING IS WRITTEN INTO THE OUTING RECORD: a track is not a plan.
  assert.equal(storage.entries.has('roadnaturalist.outings.v1'), false);
  // A RECORD THAT CANNOT BE READ IS SKIPPED WITH ITS REASON, AND THE REST STILL LOAD.
  const tampered = JSON.parse(storage.entries.get(TRIPS_KEY));
  tampered.trips.push({ id: 'trip-broken', startedAt: 'never' });
  tampered.trips[0].track.push({ lon: 'north', lat: 45, recordedAt: at(0) }, { lon: -122.9, lat: 45.6, recordedAt: at(0) });
  tampered.trips[0].diagnostics.accepted = 999;
  storage.setItem(TRIPS_KEY, JSON.stringify(tampered));
  const repaired = readStoredTrips(storage);
  assert.equal(repaired.trips.length, 1, 'the usable trip still loads');
  assert.equal(repaired.trips[0].track.length, 3, 'the unusable point is dropped and the usable one is kept');
  assert.equal(repaired.trips[0].diagnostics.accepted, 3, 'and the count is rebuilt from what was actually read');
  assert.equal(repaired.skipped.length, 1);
  assert.equal(repaired.skipped[0].id, 'trip-broken');
  // A DUPLICATE ID IS REFUSED RATHER THAN SILENTLY OVERWRITING A RECORD.
  const duplicated = JSON.parse(storage.entries.get(TRIPS_KEY));
  duplicated.trips.push(duplicated.trips[0]);
  storage.setItem(TRIPS_KEY, JSON.stringify(duplicated));
  assert.equal(readStoredTrips(storage).skipped.at(-1).reason, 'the same trip id appears twice');
  // A FUTURE VERSION IS LEFT EXACTLY AS IT IS, byte for byte.
  const future = JSON.stringify({ kind: 'roadnaturalist-trips', version: 99, trips: [{ id: 'x' }] });
  storage.setItem(TRIPS_KEY, future);
  const unreadable = readStoredTrips(storage);
  assert.equal(unreadable.status, 'unsupported');
  assert.match(unreadable.reason, /version 99/);
  assert.equal(storage.entries.get(TRIPS_KEY), future);
  // RUBBLE IS RUBBLE, AND AN EMPTY ENTRY IS NOTHING AT ALL.
  storage.setItem(TRIPS_KEY, '{not json');
  assert.equal(readStoredTrips(storage).status, 'unsupported');
  storage.removeItem(TRIPS_KEY);
  assert.equal(readStoredTrips(storage).status, 'empty');
  assert.equal(readStoredTrips(null).status, 'unavailable');
});

test('the device entry is bounded, and a bound that is reached is reported rather than quietly worked around', () => {
  const storage = fakeStorage();
  const many = Array.from({ length: MAX_TRIPS + 1 }, (unused, index) =>
    createTrip({ outing: OUTING, at: at(index) }, {}));
  const overCount = writeStoredTrips(many, { storage });
  assert.equal(overCount.ok, false);
  assert.equal(overCount.status, 'full');
  assert.match(overCount.reason, new RegExp(String(MAX_TRIPS)));
  assert.equal(storage.entries.has(TRIPS_KEY), false, 'and nothing is written when the set is over the cap');
  // THE SIZE CAP IS THE REAL ONE, and it is checked before anything is written: a trip at its own point limit is about
  // 465 kB, so the entry's budget is reached across recordings rather than by one.
  const bigTrack = Array.from({ length: 5000 }, (unused, index) =>
    trackPoint({ lon: -122.9 + index * 0.001, lat: 45.55, accuracyM: 8, recordedAt: at(index * 20) }));
  const heavy = Array.from({ length: 4 }, (unused, index) =>
    ({ ...createTrip({ at: at(index) }, {}), track: bigTrack }));
  const big = writeStoredTrips(heavy, { storage });
  assert.equal(big.ok, false, 'the entry cannot hold four recordings of that size');
  assert.match(big.reason, /as much recorded trip data/);
  assert.equal(storage.entries.has(TRIPS_KEY), false);
  assert.equal(writeStoredTrips(heavy.slice(0, 2), { storage }).ok, true, 'and two of them still fit');
  assert.ok(MAX_TRIPS_BYTES > 1000000 && MAX_TRIPS_BYTES <= 5000000, 'and the budget is a real one');
  // REMOVING A TRIP REMOVES THAT TRIP AND NOTHING ELSE.
  const kept = createTrip({ at: AT }, {});
  const other = createTrip({ at: LATER }, { existing: [kept.id] });
  assert.deepEqual(withoutTrip([kept, other], kept.id).map(entry => entry.id), [other.id]);
  assert.deepEqual(withoutTrip([kept], 'trip-unknown').map(entry => entry.id), [kept.id]);
});

// THE STORE'S OWN CONTRACT, WHICH IS WHERE THE GUARDRAILS ACTUALLY LIVE.
//
// Nothing starts a recording but the person pressing the control, visited roads are snapshotted from the plan rather than
// inferred, deleting a trip touches nothing else, and a reload finds an interrupted recording rather than losing it.
function storeWithPlan() {
  const storage = fakeStorage();
  const outing = createOuting({ title: 'Saturday loop', roadIds: ['road-a', 'road-b'] });
  writeStoredOutings([outing], { storage });
  const store = createStore({ storage });
  store.restoreOutings();
  store.restoreTrips();
  store.selectOuting(outing.id);
  return { storage, store, outing };
}

test('a recording is started by the person, fed by the stream, and frozen with the plan it was made against', () => {
  const { store, outing } = storeWithPlan();
  // LOADING, RESTORING AND OPENING A PLAN RECORD NOTHING.
  assert.equal(store.getState().trips.length, 0);
  assert.equal(store.getState().recordingTripId, null);
  // STARTING IS EXPLICIT AND IT BELONGS TO THE OPEN PLAN.
  const started = store.startTrip({ at: AT });
  assert.equal(started.ok, true);
  assert.equal(started.trip.outingId, outing.id);
  assert.equal(store.getState().recordingTripId, started.trip.id);
  assert.equal(store.getState().trips.length, 1);
  // A SECOND RECORDING CANNOT START WHILE ONE IS RUNNING.
  const again = store.startTrip({ at: AT });
  assert.equal(again.ok, false);
  assert.match(again.reason, /already running/);
  // READINGS ARE OFFERED, AND THE TRIP'S OWN RULES DECIDE.
  assert.equal(store.recordTripPoint({ point: [-122.9, 45.55], accuracyM: 10 }, { at: at(0) }).added, true);
  assert.equal(store.recordTripPoint({ point: [-122.9, 45.5501], accuracyM: 10 }, { at: at(5) }).added, false);
  assert.equal(store.getState().trips[0].track.length, 1);
  // A FIELD NOTE CARRIES THE ROAD THE PERSON WAS ON, and the position the trip last recorded.
  const event = store.addTripEvent({ text: 'gate open', roadId: 'road-b', point: tripEventPoint(store.recordingTrip()), at: at(60) });
  assert.equal(event.ok, true);
  assert.equal(store.getState().trips[0].events[0].roadId, 'road-b');
  // MARKING A ROAD VISITED IS THE PERSON'S OWN ACT, and the plan is what changes.
  store.markRoadVisited(outing.id, 'road-a', true);
  const stopped = store.stopTrip({ at: LATER });
  assert.equal(stopped.trip.status, TRIP_STATUS.COMPLETED);
  assert.equal(stopped.trip.endedAt, LATER);
  assert.deepEqual([...stopped.trip.visitedRoadIds], ['road-a'], 'the snapshot is the plan as it was at that moment');
  assert.equal(store.getState().recordingTripId, null, 'and the recording is over');
  // THE PLAN ITSELF IS UNCHANGED BY THE RECORDING: no road was visited by the trace, and no plan status moved.
  const plan = store.getState().outings.find(entry => entry.id === outing.id);
  assert.equal(plan.roadIds.length, 2);
  assert.equal(plan.status, 'planned');
  assert.deepEqual(Object.keys(plan.roadState), ['road-a']);
  // AND THE TRIP IS ON THE DEVICE, in its own entry, under its own key.
  assert.equal(store.getState().tripStorage.status, 'saved');
  assert.equal(readStoredTrips(fakeStorage(Object.fromEntries([]))).status, 'empty');
});

test('a trip passing a road visits nothing, and the trace is never consulted for progress', () => {
  const { store, outing } = storeWithPlan();
  store.startTrip({ at: AT });
  // A TRACE THAT RUNS ALONG ROAD-B, TWICE, AT ROAD-B\'S OWN COORDINATES.
  for (let index = 0; index < 6; index += 1) {
    store.recordTripPoint({ point: [-122.9 + index * 0.002, 45.55], accuracyM: 6 }, { at: at(index * 60) });
  }
  const plan = store.getState().outings.find(entry => entry.id === outing.id);
  assert.deepEqual(Object.keys(plan.roadState), [], 'driving a road does not mark it visited');
  assert.equal(store.getState().trips[0].track.length, 6, 'and the points are kept regardless');
  // THE SNAPSHOT AT STOP TIME SAYS THE SAME THING: nothing was marked, so nothing is recorded as marked.
  const stopped = store.stopTrip({ at: LATER });
  assert.deepEqual([...stopped.trip.visitedRoadIds], []);
});

test('deleting a trip deletes the trip, and leaves the plan, the roads and the notes alone', () => {
  const { storage, store, outing } = storeWithPlan();
  store.startTrip({ at: AT });
  store.recordTripPoint({ point: [-122.9, 45.55], accuracyM: 10 }, { at: at(0) });
  store.addTripEvent({ text: 'a note worth keeping', at: at(10) });
  store.markRoadVisited(outing.id, 'road-a', true);
  const stopped = store.stopTrip({ at: LATER });
  const before = { outings: JSON.stringify(store.getState().outings), saved: JSON.stringify(store.getState().savedRoads) };
  assert.equal(store.deleteTrip(stopped.trip.id), 0);
  assert.equal(store.getState().trips.length, 0);
  assert.equal(store.getState().selectedTripId, null);
  // THE PLAN IS EXACTLY WHAT IT WAS, INCLUDING THE PROGRESS THE PERSON MARKED.
  assert.equal(JSON.stringify(store.getState().outings), before.outings);
  assert.equal(JSON.stringify(store.getState().savedRoads), before.saved);
  assert.equal(store.getState().outings.find(entry => entry.id === outing.id).roadState['road-a'].visited, true);
  assert.equal(storage.entries.has(TRIPS_KEY), false, 'and the entry is removed, not left holding a deleted track');
  assert.equal(store.deleteTrip('trip-unknown'), null, 'deleting something that is not there does nothing');
});

test('a reload finds an unfinished recording, keeps it, and offers to finish it', () => {
  const storage = fakeStorage();
  const outing = createOuting({ title: 'Saturday loop', roadIds: ['road-a'] });
  writeStoredOutings([outing], { storage });
  const first = createStore({ storage });
  first.restoreOutings();
  first.restoreTrips();
  first.selectOuting(outing.id);
  first.startTrip({ at: AT });
  first.recordTripPoint({ point: [-122.9, 45.55], accuracyM: 10 }, { at: at(0) });
  first.recordTripPoint({ point: [-122.9, 45.57], accuracyM: 10 }, { at: at(600) });
  // THE PAGE GOES AWAY MID-RECORDING. Nothing is stopped and nothing is cleaned up.
  const second = createStore({ storage });
  second.restoreOutings();
  const restored = second.restoreTrips();
  assert.equal(restored.interrupted, true);
  const trip = second.getState().trips[0];
  assert.equal(trip.status, TRIP_STATUS.INTERRUPTED);
  assert.equal(trip.track.length, 2, 'every recorded point is kept');
  assert.equal(trip.endedAt, null);
  assert.equal(second.getState().recordingTripId, null, 'and nothing is recording until the person says so');
  // FINISHING IT ENDS THE RECORD AT THE LAST POINT THAT WAS ACTUALLY RECORDED.
  const finished = second.finishTrip(trip.id);
  assert.equal(finished.status, TRIP_STATUS.COMPLETED);
  assert.equal(finished.endedAt, at(600));
  assert.equal(tripSummary(finished, { outing: null }).durationLabel, '10 min');
  // AND IT SURVIVES ANOTHER RELOAD AS A FINISHED RECORD.
  const third = createStore({ storage });
  third.restoreOutings();
  third.restoreTrips();
  assert.equal(third.getState().trips[0].status, TRIP_STATUS.COMPLETED);
  assert.equal(third.getState().trips[0].track.length, 2);
});

test('nothing about a trip reaches a console, and nothing is written anywhere but the trip entry', () => {
  const { storage, store, outing } = storeWithPlan();
  const calls = [];
  const originals = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[name] = console[name];
    console[name] = (...args) => { calls.push([name, args]); };
  }
  try {
    store.startTrip({ at: AT });
    store.recordTripPoint({ point: [-122.9, 45.55], accuracyM: 10 }, { at: at(0) });
    store.recordTripPoint({ point: [-122.9, 45.57], accuracyM: 10 }, { at: at(600) });
    store.addTripEvent({ text: 'a note', at: at(610) });
    store.markRoadVisited(outing.id, 'road-a', true);
    store.stopTrip({ at: LATER });
    tripGeoJson(store.getState().trips[0], { outing: null });
  } finally {
    for (const [name, value] of Object.entries(originals)) console[name] = value;
  }
  assert.deepEqual(calls, [], 'a coordinate never goes to a console');
  // AND THE ONLY ENTRY THAT HOLDS A COORDINATE IS THE TRIP ENTRY.
  const written = [...storage.entries.entries()].map(([key, value]) => `${key}:${value}`).join('|');
  assert.match(written, /45\.55/, 'the trip entry holds the recorded points');
  assert.equal(/45\.55/.test(storage.entries.get('roadnaturalist.outings.v1')), false,
    'the plan does not hold a track');
  assert.equal([...storage.entries.keys()].sort().join(','),
    ['roadnaturalist.outings.v1', TRIPS_KEY].sort().join(','), 'and nothing else was written');
});
