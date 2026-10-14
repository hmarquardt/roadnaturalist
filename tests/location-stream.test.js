import test from 'node:test';
import assert from 'node:assert/strict';

import { createLocationProvider, LOCATION_STATUS } from '../src/discovery/geolocation.js';
import { createLocationStream } from '../src/discovery/location-stream.js';

// ONE BROWSER WATCH, HOWEVER MANY THINGS WANT A READING.
//
// Live location and trip recording are separate choices that consume the same device stream, and the whole point of this
// module is that they cannot open two competing watches. These tests hold the lifecycle: the first consumer opens it, the
// last one to leave closes it, a consumer leaving never disturbs another, and no watch is ever leaked.
function fakeDevice() {
  const calls = { watches: 0, cleared: [], handlers: [] };
  return {
    calls,
    geolocation: {
      getCurrentPosition() {},
      watchPosition(success, error) {
        calls.watches += 1;
        calls.handlers.push({ success, error });
        return calls.watches;
      },
      clearWatch(id) { calls.cleared.push(id); },
    },
    emit(reading) {
      // EVERY WATCH EVER OPENED, including cleared ones: a reading delivered after a stop must reach nothing, and a test
      // can only prove that if the device still holds the callback.
      for (const handler of calls.handlers) handler.success({ coords: reading });
    },
  };
}

const FIX = { latitude: 45.55, longitude: -122.9, accuracy: 12 };

test('the first consumer opens one watch, and further consumers join it rather than opening another', () => {
  const device = fakeDevice();
  const stream = createLocationStream({ provider: createLocationProvider({ geolocation: device.geolocation }) });
  const live = [];
  const recorded = [];
  assert.equal(stream.active(), false, 'nothing is watched until somebody is listening');
  assert.equal(stream.watchCount(), 0);
  // LIVE LOCATION FIRST, THEN RECORDING: still one browser watch.
  const leaveLive = stream.subscribe(reading => live.push(reading));
  assert.equal(stream.watchCount(), 1);
  const leaveRecorder = stream.subscribe(reading => recorded.push(reading));
  assert.equal(stream.watchCount(), 1, 'a second consumer shares the watch that is already running');
  assert.equal(stream.consumerCount(), 2);
  device.emit(FIX);
  assert.equal(live.length, 1, 'both consumers are fed the same reading');
  assert.equal(recorded.length, 1);
  // STOPPING LIVE LOCATION LEAVES THE RECORDING RUNNING.
  leaveLive();
  assert.equal(stream.active(), true, 'the watch stays open while a recording is listening');
  assert.equal(stream.consumerCount(), 1);
  assert.equal(device.calls.cleared.length, 0);
  device.emit(FIX);
  assert.equal(live.length, 1, 'and the stopped consumer receives nothing more');
  assert.equal(recorded.length, 2);
  // AND THE LAST ONE OUT CLOSES IT.
  leaveRecorder();
  assert.equal(stream.active(), false);
  assert.equal(stream.watchCount(), 1, 'the session opened exactly one browser watch');
  assert.deepEqual(device.calls.cleared, [1], 'and cleared exactly that one');
  device.emit(FIX);
  assert.equal(recorded.length, 2, 'a reading after the stop reaches nothing');
});

test('recording first opens the watch, and enabling live location joins it', () => {
  const device = fakeDevice();
  const stream = createLocationStream({ provider: createLocationProvider({ geolocation: device.geolocation }) });
  const recorded = [];
  const leaveRecorder = stream.subscribe(reading => recorded.push(reading));
  assert.equal(stream.watchCount(), 1, 'a recording may own the stream when it starts first');
  const live = [];
  const leaveLive = stream.subscribe(reading => live.push(reading));
  assert.equal(stream.watchCount(), 1, 'and enabling live location opens no second watch');
  device.emit(FIX);
  assert.equal(live.length, 1);
  assert.equal(recorded.length, 1);
  // STOPPING THE RECORDING LEAVES LIVE LOCATION RUNNING.
  leaveRecorder();
  assert.equal(stream.active(), true);
  device.emit(FIX);
  assert.equal(live.length, 2);
  assert.equal(recorded.length, 1);
  leaveLive();
  assert.equal(stream.active(), false, 'both off, no watch');
  assert.deepEqual(device.calls.cleared, [1]);
});

test('leaving twice closes nothing twice, and one consumer’s failure is not another one’s', () => {
  const device = fakeDevice();
  const stream = createLocationStream({ provider: createLocationProvider({ geolocation: device.geolocation }) });
  const seen = [];
  const leave = stream.subscribe(() => { throw new Error('a view blew up while a reading arrived'); });
  const leaveOther = stream.subscribe(reading => seen.push(reading));
  assert.doesNotThrow(() => device.emit(FIX), 'one consumer’s failure does not stop the reading being delivered');
  assert.equal(seen.length, 1, 'the other consumer still receives it');
  // IDEMPOTENT LEAVING: a view that stops twice must not close somebody else\'s watch.
  leave();
  leave();
  assert.equal(stream.active(), true);
  assert.equal(stream.consumerCount(), 1);
  leaveOther();
  leaveOther();
  assert.deepEqual(device.calls.cleared, [1]);
  assert.equal(stream.active(), false);
  // A HANDLER THAT IS NOT A FUNCTION IS NOT A CONSUMER.
  const none = createLocationStream({ provider: createLocationProvider({ geolocation: device.geolocation }) });
  const noop = none.subscribe(null);
  assert.equal(none.consumerCount(), 0);
  assert.equal(none.active(), false);
  noop();
});

test('a device that cannot watch is reported to its consumers, and a stopped stream delivers nothing', () => {
  const unsupported = createLocationStream({ provider: createLocationProvider({ geolocation: null }) });
  const readings = [];
  const stop = unsupported.subscribe(reading => readings.push(reading));
  assert.equal(readings.length, 1, 'the refusal arrives as a reading, not as a throw');
  assert.equal(readings[0].status, LOCATION_STATUS.UNSUPPORTED);
  stop();
  assert.equal(unsupported.watchCount(), 1);
  // A STREAM WITH NO PROVIDER IS SIMPLY INACTIVE rather than an error at boot.
  const absent = createLocationStream({});
  const leave = absent.subscribe(() => {});
  assert.equal(absent.active(), false);
  assert.equal(absent.watchCount(), 0);
  leave();
  // SHUTTING THE WHOLE STREAM DOWN CLOSES THE WATCH AND FORGETS EVERY CONSUMER.
  const device = fakeDevice();
  const stream = createLocationStream({ provider: createLocationProvider({ geolocation: device.geolocation }) });
  const seen = [];
  stream.subscribe(reading => seen.push(reading));
  stream.subscribe(reading => seen.push(reading));
  device.emit(FIX);
  assert.equal(seen.length, 2);
  stream.stopAll();
  assert.equal(stream.active(), false);
  assert.equal(stream.consumerCount(), 0);
  assert.deepEqual(device.calls.cleared, [1]);
  device.emit(FIX);
  assert.equal(seen.length, 2, 'and a stopped stream delivers nothing at all');
  // A READING THAT ARRIVES WHILE NOBODY IS LISTENING OPENS NO WATCH OF ITS OWN.
  assert.equal(stream.watchCount(), 1);
});
