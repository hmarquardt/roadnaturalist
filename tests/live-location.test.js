import test from 'node:test';
import assert from 'node:assert/strict';

import { LIVE_LOCATION_OPTIONS, LOCATION_STATUS, createLocationProvider } from '../src/discovery/geolocation.js';
import { IDLE_LIVE_LOCATION, LIVE_LOCATION_STATUS, liveLocationAccuracyLabel, liveLocationMessage,
  liveLocationReading, liveLocationStatusLabel, liveStatusFromLocationStatus, requestingLiveLocation }
  from '../src/state/live-location.js';
import { OUTINGS_KEY, createOuting, writeStoredOutings } from '../src/state/outings.js';
import { createStore } from '../src/state/store.js';

// A READING, AND NOTHING MORE.
//
// Live location is the most transient state in this application: one reading, in memory, replaced by the next and thrown
// away when the watch stops. These tests hold that line - the shape, the browser's outcomes said in the field's words, one
// watch that stops cleanly, and the absence of any storage, history or track.
function fakeGeolocation() {
  const calls = { watches: 0, cleared: [], options: [], requested: 0 };
  const handlers = [];
  return {
    calls,
    geolocation: {
      getCurrentPosition() { calls.requested += 1; },
      watchPosition(success, error, options) { calls.watches += 1; calls.options.push(options);
        handlers.push({ success, error }); return 42; },
      clearWatch(id) { calls.cleared.push(id); },
    },
    emit(coords) { for (const handler of [...handlers]) handler.success({ coords }); },
    fail(code) { for (const handler of [...handlers]) handler.error({ code }); },
  };
}

const fix = (latitude, longitude, accuracy = 12) => ({ latitude, longitude, accuracy });

test('a reading is one validated point, or a status that says why there is none', () => {
  assert.deepEqual({ ...IDLE_LIVE_LOCATION },
    { status: LIVE_LOCATION_STATUS.IDLE, point: null, accuracyM: null, timestamp: null, message: null });
  const active = liveLocationReading({ status: LOCATION_STATUS.OK, center: [-87.5, 38.3], accuracyM: 12 }, { at: 5 });
  assert.equal(active.status, LIVE_LOCATION_STATUS.ACTIVE);
  assert.deepEqual([...active.point], [-87.5, 38.3]);
  assert.equal(active.accuracyM, 12);
  assert.equal(active.timestamp, 5);
  assert.equal(active.message, null);
  // A device that did not report an accuracy has none - never a zero, which would claim a perfect fix.
  assert.equal(liveLocationReading({ status: LOCATION_STATUS.OK, center: [0, 0] }).accuracyM, null);
  // A REFUSAL IS A STATUS, NEVER A POSITION. There is no reading at (0, 0) and no partially written point.
  for (const [status, expected] of [[LOCATION_STATUS.PERMISSION_DENIED, LIVE_LOCATION_STATUS.DENIED],
    [LOCATION_STATUS.POSITION_UNAVAILABLE, LIVE_LOCATION_STATUS.UNAVAILABLE],
    [LOCATION_STATUS.TIMEOUT, LIVE_LOCATION_STATUS.TIMEOUT],
    [LOCATION_STATUS.UNSUPPORTED, LIVE_LOCATION_STATUS.UNSUPPORTED]]) {
    const reading = liveLocationReading({ status });
    assert.equal(reading.status, expected);
    assert.equal(reading.point, null);
    assert.equal(reading.timestamp, null);
    assert.ok(reading.message, 'and it says what happened');
  }
  // A reading with no usable centre is unavailable, whatever it claims to be.
  assert.equal(liveLocationReading({ status: LOCATION_STATUS.OK }).status, LIVE_LOCATION_STATUS.UNAVAILABLE);
  assert.equal(liveLocationReading({ status: LOCATION_STATUS.OK, center: ['x', 'y'] }).point, null);
  assert.equal(liveLocationReading(null).status, LIVE_LOCATION_STATUS.UNAVAILABLE);
  assert.equal(requestingLiveLocation().status, LIVE_LOCATION_STATUS.REQUESTING);
  assert.equal(requestingLiveLocation().point, null);
});

test('the field says what the browser said, in its own words', () => {
  assert.equal(liveStatusFromLocationStatus(LOCATION_STATUS.OK), LIVE_LOCATION_STATUS.ACTIVE);
  assert.equal(liveStatusFromLocationStatus(LOCATION_STATUS.PERMISSION_DENIED), LIVE_LOCATION_STATUS.DENIED);
  assert.equal(liveStatusFromLocationStatus(LOCATION_STATUS.POSITION_UNAVAILABLE), LIVE_LOCATION_STATUS.UNAVAILABLE);
  assert.equal(liveStatusFromLocationStatus(LOCATION_STATUS.TIMEOUT), LIVE_LOCATION_STATUS.TIMEOUT);
  assert.equal(liveStatusFromLocationStatus(LOCATION_STATUS.UNSUPPORTED), LIVE_LOCATION_STATUS.UNSUPPORTED);
  assert.equal(liveStatusFromLocationStatus('something-new'), LIVE_LOCATION_STATUS.IDLE);
  assert.equal(liveLocationStatusLabel(LIVE_LOCATION_STATUS.ACTIVE), 'Location on');
  assert.equal(liveLocationStatusLabel(LIVE_LOCATION_STATUS.IDLE), 'Location off');
  // EVERY REFUSAL SAYS THE PLAN STILL WORKS, because it does.
  assert.match(liveLocationMessage(LIVE_LOCATION_STATUS.DENIED), /Location permission was not granted/);
  assert.match(liveLocationMessage(LIVE_LOCATION_STATUS.DENIED), /plan still works/);
  assert.match(liveLocationMessage(LIVE_LOCATION_STATUS.UNAVAILABLE), /plan still works/);
  assert.match(liveLocationMessage(LIVE_LOCATION_STATUS.UNSUPPORTED), /plan still works/);
  assert.match(liveLocationMessage(LIVE_LOCATION_STATUS.TIMEOUT), /try again/);
  assert.equal(liveLocationMessage(LIVE_LOCATION_STATUS.ACTIVE), null);
  // The accuracy line exists only when there is a reading, and it is compact.
  assert.equal(liveLocationAccuracyLabel({ status: LIVE_LOCATION_STATUS.ACTIVE, accuracyM: 18 }), 'GPS accuracy ≈ 18 m');
  assert.equal(liveLocationAccuracyLabel({ status: LIVE_LOCATION_STATUS.ACTIVE, accuracyM: 1500 }), 'GPS accuracy ≈ 1.5 km');
  assert.equal(liveLocationAccuracyLabel({ status: LIVE_LOCATION_STATUS.ACTIVE, accuracyM: null }), null);
  assert.equal(liveLocationAccuracyLabel({ status: LIVE_LOCATION_STATUS.DENIED, accuracyM: 18 }), null);

test('one watch, one reading at a time, stopped cleanly and idempotently', () => {
  const fake = fakeGeolocation();
  const provider = createLocationProvider({ geolocation: fake.geolocation });
  assert.equal(provider.watchSupported, true);
  const readings = [];
  const watch = provider.watch(reading => readings.push(reading));
  assert.equal(fake.calls.watches, 1, 'exactly one watch is opened');
  assert.deepEqual({ ...fake.calls.options[0] }, { ...LIVE_LOCATION_OPTIONS });
  assert.equal(LIVE_LOCATION_OPTIONS.enableHighAccuracy, true, 'a proximity reading asks the device to fix itself');
  assert.equal(LIVE_LOCATION_OPTIONS.maximumAge, 0, 'and refuses a stale fix');
  fake.emit(fix(38.3, -87.5, 12));
  fake.emit(fix(38.3001, -87.5, 9));
  assert.equal(readings.length, 2);
  assert.equal(readings[1].status, LOCATION_STATUS.OK);
  assert.ok(Math.abs(readings[1].center[1] - 38.3001) < 1e-9);
  // A DEVICE THAT REFUSES ARRIVES AS A STATUS, not as a rejection.
  fake.fail(1);
  assert.equal(readings[2].status, LOCATION_STATUS.PERMISSION_DENIED);
  // STOPPING CLEARS THE WATCH AND SILENCES IT: nothing arrives afterwards, and stopping again is not an error.
  watch.stop();
  assert.deepEqual(fake.calls.cleared, [42]);
  fake.emit(fix(38.4, -87.4));
  assert.equal(readings.length, 3, 'a stopped watch delivers nothing');
  watch.stop();
  assert.deepEqual(fake.calls.cleared, [42], 'and stopping twice clears once');
});

test('a browser without a watch says so instead of pretending', () => {
  const provider = createLocationProvider({ geolocation: { getCurrentPosition() {} } });
  assert.equal(provider.supported, true);
  assert.equal(provider.watchSupported, false);
  const readings = [];
  const watch = provider.watch(reading => readings.push(reading));
  assert.equal(watch.supported, false);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].status, LOCATION_STATUS.UNSUPPORTED);
  watch.stop();
  // A browser with no geolocation at all is the same story, told once.
  const none = createLocationProvider({ geolocation: null });
  assert.equal(none.watchSupported, false);
  const empty = [];
  none.watch(reading => empty.push(reading));
  assert.equal(empty[0].status, LOCATION_STATUS.UNSUPPORTED);
  // A watch that throws when asked is reported as unavailable rather than crashing the page.
  const throwing = createLocationProvider({ geolocation: { getCurrentPosition() {},
    watchPosition() { throw new Error('blocked by policy'); }, clearWatch() {} } });
  const failures = [];
  throwing.watch(reading => failures.push(reading));
  assert.equal(failures[0].status, LOCATION_STATUS.POSITION_UNAVAILABLE);
});

test('a reading is never written down: not to storage, not to the plan, and never as a history', () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: key => { entries.delete(key); } };
  const store = createStore({ storage });
  const outing = createOuting({ title: 'Field plan', roadIds: ['road-a'] });
  writeStoredOutings([outing], { storage });
  store.restoreOutings();
  // A reading arrives, and another one replaces it.
  store.setLiveLocation(liveLocationReading({ status: LOCATION_STATUS.OK, center: [-87.5, 38.3], accuracyM: 12 }));
  store.setLiveLocation(liveLocationReading({ status: LOCATION_STATUS.OK, center: [-87.6, 38.4], accuracyM: 20 }));
  const state = store.getState();
  assert.equal(state.liveLocation.status, LIVE_LOCATION_STATUS.ACTIVE);
  assert.deepEqual([...state.liveLocation.point], [-87.6, 38.4], 'the state holds where the person is now');
  assert.equal(Array.isArray(state.liveLocation.point[0]), false, 'and not a list of where they have been');
  // NOTHING ABOUT IT REACHES THE DEVICE.
  const written = [...entries.values()].join('|');
  assert.ok(!written.includes('38.4'), 'no coordinate is written to storage');
  assert.ok(!written.includes('liveLocation'), 'and no location field exists in any stored record');
  assert.equal(Object.keys(JSON.parse(entries.get(OUTINGS_KEY)).outings[0]).includes('liveLocation'), false);
  // STOPPING LEAVES NOTHING BEHIND BUT THE IDLE SHAPE.
  store.setLiveLocation(IDLE_LIVE_LOCATION);
  assert.deepEqual({ ...store.getState().liveLocation }, { ...IDLE_LIVE_LOCATION });
  // LEAVING FIELD MODE ALSO DISCARDS THE READING, because a reading belongs to the view that asked for it.
  store.setLiveLocation(liveLocationReading({ status: LOCATION_STATUS.OK, center: [-87.5, 38.3] }));
  store.setFieldMode(false);
  assert.equal(store.getState().liveLocation.point, null);
  assert.equal(store.getState().liveLocation.status, LIVE_LOCATION_STATUS.IDLE);
});

});
