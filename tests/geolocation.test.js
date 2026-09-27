import test from 'node:test';
import assert from 'node:assert/strict';
import { COVERAGE } from '../src/domain/corridor.js';
import { LOCATION_OPTIONS, LOCATION_STATUS, accuracyLabel, createLocationProvider, createLocationRequest,
  locationErrorStatus, locationSearchDefinition, locationStatusMessage, positionFromBrowser } from '../src/discovery/geolocation.js';
import { CENTER_DECIMALS, readSearchDefinition, searchIsRunnable, serializeSearchQuery, storedDefinition } from '../src/discovery/search-definition.js';
import { nearestPlace } from '../src/discovery/place-gazetteer.js';

// USE MY LOCATION, AS A CENTRE.
//
// The browser's position is not a second kind of search: it is one more way to answer *where*. These tests hold
// that line - the same validated definition, the same canonical centre, the same radius the person chose, the
// same coverage vocabulary, the same label rules, and a refusal for every way a browser can decline to answer.
const REGION = { id: 'greater-portland', name: 'Greater Portland', bounds: [-124.1, 45.2, -122.4, 46.4] };

function browserPosition({ latitude = 45.5229, longitude = -122.9898, accuracy = 118.6 } = {}) {
  return { coords: { latitude, longitude, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
    timestamp: 1767225600000 };
}

// A geolocation API that answers however a test needs, without a device or a permission prompt.
function fakeGeolocation({ position = null, error = null, delayMs = 0, onCall = null } = {}) {
  const calls = [];
  return { calls,
    getCurrentPosition(success, failure, options) {
      calls.push(options);
      if (onCall) onCall(options);
      const answer = () => { if (error) failure(error); else success(position ?? browserPosition()); };
      if (delayMs > 0) setTimeout(answer, delayMs); else answer();
    } };
}

test('a browser position becomes exactly the definition a typed coordinate makes', () => {
  const fix = positionFromBrowser(browserPosition());
  assert.equal(fix.ok, true);
  assert.deepEqual(fix.center, [-122.9898, 45.5229]);
  assert.equal(fix.accuracyM, 118.6);
  const fromLocation = locationSearchDefinition(fix, { radiusMiles: 25, region: REGION });
  const typed = readSearchDefinition({ lat: 45.5229, lon: -122.9898, radiusMiles: 25 }, { region: REGION });
  assert.deepEqual(fromLocation.definition, typed.definition, 'the same numbers make the same definition');
  assert.equal(fromLocation.definition.center[1].toFixed(CENTER_DECIMALS), '45.52290',
    'the ordinary canonical centre, not the browser’s extra precision');
  assert.equal(fromLocation.coverage.coverage, typed.coverage.coverage);
  // The URL stays coordinates and radius: nothing about where they came from travels in a link.
  assert.equal(serializeSearchQuery(fromLocation.definition), 'lat=45.5229&lon=-122.9898&r=25');
  assert.deepEqual(storedDefinition(JSON.parse(JSON.stringify(fromLocation.definition))), fromLocation.definition);
});

test('the radius is the person’s, and the browser’s accuracy never changes it', () => {
  for (const accuracy of [8, 120, 4500]) {
    const fix = positionFromBrowser(browserPosition({ accuracy }));
    const result = locationSearchDefinition(fix, { radiusMiles: 25, region: REGION });
    assert.equal(result.definition.radiusMiles, 25, `a ${accuracy} m fix must not move the radius`);
    assert.equal(result.definition.radiusM, 25 * 1609.344);
  }
  // The browser's extra precision is not kept: the definition carries the same five decimals every other centre
  // does, so a fix and a typed coordinate can never disagree by a metre of noise.
  const noisy = locationSearchDefinition(positionFromBrowser(browserPosition({ latitude: 45.52290012345, longitude: -122.98980098765 })), { radiusMiles: 10, region: REGION });
  const written = locationSearchDefinition(positionFromBrowser(browserPosition({ latitude: 45.5229, longitude: -122.9898 })), { radiusMiles: 10, region: REGION });
  assert.deepEqual(noisy.definition.center, written.definition.center);
  assert.equal(noisy.definition.center[0], -122.9898);
});

test('coverage keeps its three outcomes, and a centre outside the region is refused like any other', () => {
  const inside = locationSearchDefinition(positionFromBrowser(browserPosition()), { radiusMiles: 10, region: REGION });
  assert.equal(inside.coverage.coverage, COVERAGE.FULL);
  assert.equal(searchIsRunnable(inside), true);
  // Outside the published region, far enough that the radius cannot reach it: NONE, and not runnable.
  const outside = locationSearchDefinition(positionFromBrowser(browserPosition({ latitude: 40.7, longitude: -74.0 })), { radiusMiles: 10, region: REGION });
  assert.equal(outside.coverage.coverage, COVERAGE.NONE);
  assert.equal(searchIsRunnable(outside), false);
  // Outside, but the radius still overlaps: PARTIAL, and still runnable.
  const partial = locationSearchDefinition(positionFromBrowser(browserPosition({ latitude: 45.1, longitude: -123.4 })), { radiusMiles: 25, region: REGION });
  assert.equal(partial.coverage.coverage, COVERAGE.PARTIAL);
  assert.equal(searchIsRunnable(partial), true);
  // A position the browser could not express remains a refusal, never a definition.
  const broken = positionFromBrowser({ coords: { latitude: 'north', longitude: -122.9 } });
  assert.equal(broken.ok, false);
  assert.equal(broken.status, LOCATION_STATUS.POSITION_UNAVAILABLE);
  assert.equal(broken.center, null);
  assert.equal(locationSearchDefinition(broken, { radiusMiles: 10, region: REGION }).ok, false);
});

test('the accuracy is presentation, and it is clearly about the browser’s fix', () => {
  assert.equal(accuracyLabel(118.6), 'Browser location accuracy: about 119 m.');
  assert.equal(accuracyLabel(8), 'Browser location accuracy: about 8 m.');
  assert.equal(accuracyLabel(4200), 'Browser location accuracy: about 4.2 km.');
  assert.equal(accuracyLabel(null), null);
  assert.equal(accuracyLabel(Number.NaN), null);
  assert.equal(accuracyLabel(-1), null);
  const withoutAccuracy = positionFromBrowser({ coords: { latitude: 45.5, longitude: -122.9 } });
  assert.equal(withoutAccuracy.accuracyM, null, 'a missing accuracy is unknown, not zero');
  assert.equal(accuracyLabel(withoutAccuracy.accuracyM), null);
});

test('every way a browser can decline is its own state with its own sentence', () => {
  assert.equal(locationErrorStatus(1), LOCATION_STATUS.PERMISSION_DENIED);
  assert.equal(locationErrorStatus(2), LOCATION_STATUS.POSITION_UNAVAILABLE);
  assert.equal(locationErrorStatus(3), LOCATION_STATUS.TIMEOUT);
  assert.equal(locationErrorStatus(99), LOCATION_STATUS.POSITION_UNAVAILABLE);
  assert.match(locationStatusMessage(LOCATION_STATUS.PERMISSION_DENIED), /permission was not granted/);
  assert.match(locationStatusMessage(LOCATION_STATUS.PERMISSION_DENIED), /place, click the map, or enter coordinates/);
  assert.match(locationStatusMessage(LOCATION_STATUS.POSITION_UNAVAILABLE), /could not determine a location/);
  assert.match(locationStatusMessage(LOCATION_STATUS.TIMEOUT), /did not report a location in time/);
  assert.match(locationStatusMessage(LOCATION_STATUS.TIMEOUT), /try again/);
  assert.match(locationStatusMessage(LOCATION_STATUS.UNSUPPORTED), /cannot report a location/);
});

test('the provider answers with a value, never an exception, and asks for one position only', async () => {
  const geolocation = fakeGeolocation();
  const provider = createLocationProvider({ geolocation });
  assert.equal(provider.supported, true);
  const fix = await provider.request();
  assert.equal(fix.ok, true);
  assert.deepEqual(fix.center, [-122.9898, 45.5229]);
  assert.equal(geolocation.calls.length, 1, 'one request, no watchPosition and no polling');
  assert.deepEqual(geolocation.calls[0], { ...LOCATION_OPTIONS });
  assert.equal(LOCATION_OPTIONS.enableHighAccuracy, false, 'a road-search centre does not need a satellite fix');
  assert.ok(LOCATION_OPTIONS.timeout > 0 && LOCATION_OPTIONS.timeout <= 20000);
  assert.ok(LOCATION_OPTIONS.maximumAge > 0);
  // The three refusals, and an API that throws instead of answering.
  for (const [code, status] of [[1, LOCATION_STATUS.PERMISSION_DENIED], [2, LOCATION_STATUS.POSITION_UNAVAILABLE], [3, LOCATION_STATUS.TIMEOUT]]) {
    const refused = await createLocationProvider({ geolocation: fakeGeolocation({ error: { code, message: 'refused' } }) }).request();
    assert.equal(refused.ok, false);
    assert.equal(refused.status, status);
    assert.equal(refused.center, null);
    assert.ok(refused.message, 'every refusal has something to say');
  }
  const throwing = { getCurrentPosition() { throw new Error('insecure context'); } };
  const failedProvider = await createLocationProvider({ geolocation: throwing }).request();
  assert.equal(failedProvider.ok, false);
  assert.match(failedProvider.message, /insecure context/);
  const unsupported = createLocationProvider({ geolocation: null });
  assert.equal(unsupported.supported, false);
  assert.equal((await unsupported.request()).status, LOCATION_STATUS.UNSUPPORTED);
  assert.equal(positionFromBrowser({ coords: { latitude: 91, longitude: 0 } }).ok, false);
  assert.equal(positionFromBrowser({ coords: { latitude: 45.5, longitude: 200 } }).ok, false);
});

test('the latest deliberate centre selection wins over a late fix', async () => {
  const request = createLocationRequest();
  const token = request.begin();
  assert.equal(request.isCurrent(token), true);
  // While the browser is looking, the person picks a place: that choice cancels the pending request.
  request.invalidate();
  assert.equal(request.isCurrent(token), false, 'a stale fix must not overwrite a newer centre');
  // A second request of its own also supersedes the first, and only the newest is current.
  const newer = request.begin();
  assert.equal(request.isCurrent(token), false);
  assert.equal(request.isCurrent(newer), true);
  // The provider is stateless and the ordering lives in the request: a cancelled request stays cancelled.
  const pending = createLocationProvider({ geolocation: fakeGeolocation({ delayMs: 1 }) }).request();
  request.invalidate();
  const fix = await pending;
  assert.equal(fix.ok, true, 'the browser still answers; the workspace just does not use it');
  assert.equal(request.isCurrent(newer), false);
  assert.equal(request.isCurrent(token), false);
});

test('the centre is labelled by the local gazetteer, and never moved to a place', () => {
  const gazetteer = { places: [
    { id: 'or-hillsboro', name: 'Hillsboro', state: 'OR', type: 'City', center: [-122.9898, 45.5229] },
    { id: 'or-cornelius', name: 'Cornelius', state: 'OR', type: 'City', center: [-123.0596, 45.5201] },
  ] };
  const near = nearestPlace([-122.9898, 45.5229], gazetteer);
  assert.equal(near.label, 'Near Hillsboro, OR');
  assert.deepEqual(near.place.center, [-122.9898, 45.5229], 'the label describes the fix; it does not replace it');
  assert.equal(near.distanceM, 0);
  // A fix far from every published place is labelled by its coordinates instead of a snapped name.
  assert.equal(nearestPlace([-120.4, 43.9], gazetteer), null);
  // No gazetteer at all is a missing label, never a failed search.
  assert.equal(nearestPlace([-122.9898, 45.5229], null), null);
});
