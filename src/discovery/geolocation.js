import { coordinateNumber, readSearchDefinition } from './search-definition.js';

// BROWSER LOCATION AS A SEARCH CENTRE.
//
// "Use my location" is another way to answer *where*, and nothing else. After an explicit user gesture the
// browser reports a position; this module turns that position into the same centre and radius definition every
// other input produces, and the existing pipeline does the rest. It never runs a search, never changes the
// radius, never snaps the centre to a place, never asks a geocoder, and never tracks anything: one position, on
// request.
//
// The options trade accuracy for speed and battery, because a road-search centre is not turn-by-turn
// navigation: `enableHighAccuracy: false` lets the browser answer from WiFi or cell instead of demanding a GPS
// fix, `timeout: 15000` bounds the wait so the control always comes back, and `maximumAge: 60000` accepts a fix
// up to a minute old rather than paying for a new one. None of them touch the search itself - the radius is the
// person's, and the reported accuracy is presentation only.
export const LOCATION_OPTIONS = Object.freeze({ enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });

export const LOCATION_STATUS = Object.freeze({ IDLE: 'idle', REQUESTING: 'requesting', OK: 'ok',
  PERMISSION_DENIED: 'permission-denied', POSITION_UNAVAILABLE: 'position-unavailable', TIMEOUT: 'timeout',
  UNSUPPORTED: 'unsupported', REFUSED: 'refused' });

export const IDLE_LOCATION = Object.freeze({ status: LOCATION_STATUS.IDLE, message: null, accuracyM: null });

// The browser's own codes, mapped to the states this workspace can say. Every refusal leaves the other ways of
// choosing a centre exactly as they were.
export function locationErrorStatus(code) {
  if (code === 1) return LOCATION_STATUS.PERMISSION_DENIED;
  if (code === 3) return LOCATION_STATUS.TIMEOUT;
  return LOCATION_STATUS.POSITION_UNAVAILABLE; // 2, and anything a browser invents later
}

export function locationStatusMessage(status) {
  if (status === LOCATION_STATUS.PERMISSION_DENIED) return 'Location permission was not granted. You can still choose a place, click the map, or enter coordinates.';
  if (status === LOCATION_STATUS.POSITION_UNAVAILABLE) return 'Your device could not determine a location. You can still choose a place, click the map, or enter coordinates.';
  if (status === LOCATION_STATUS.TIMEOUT) return 'The device did not report a location in time. Press "Use my location" to try again, or choose a place, click the map, or enter coordinates.';
  if (status === LOCATION_STATUS.UNSUPPORTED) return 'This browser cannot report a location. Choose a place, click the map, or enter coordinates.';
  return null;
}

// Presentation only, and clearly about the browser's fix rather than the place label beside it: the accuracy
// describes how well the device knows where it is, not how well the gazetteer knows where Hillsboro is.
export function accuracyLabel(accuracyM) {
  if (typeof accuracyM !== 'number' || !Number.isFinite(accuracyM) || accuracyM < 0) return null;
  if (accuracyM < 1000) return `Browser location accuracy: about ${Math.max(1, Math.round(accuracyM))} m.`;
  return `Browser location accuracy: about ${(accuracyM / 1000).toFixed(1)} km.`;
}

// A device position, validated exactly like a typed coordinate: the numbers in, the ordinary definition out.
// Nothing here is geolocation-specific beyond reading `coords`, so a fixed position and a typed pair of numbers
// produce byte-identical definitions, URLs, labels and coverage.
export function locationSearchDefinition(fix, { radiusMiles, region = null } = {}) {
  return readSearchDefinition({ lat: fix?.center?.[1], lon: fix?.center?.[0], radiusMiles }, { region });
}

function failed(status, message = null) {
  return Object.freeze({ ok: false, status, message: message ?? locationStatusMessage(status), center: null, accuracyM: null });
}

// One position, or a refusal that says why. A position whose numbers are not usable coordinates is a device that
// could not determine a location, not a centre.
export function positionFromBrowser(position) {
  const latitude = coordinateNumber(position?.coords?.latitude);
  const longitude = coordinateNumber(position?.coords?.longitude);
  if (latitude == null || longitude == null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return failed(LOCATION_STATUS.POSITION_UNAVAILABLE, 'The device reported a position that is not a usable coordinate. Choose a place, click the map, or enter coordinates.');
  }
  const accuracy = position?.coords?.accuracy;
  return Object.freeze({ ok: true, status: LOCATION_STATUS.OK, message: null,
    center: Object.freeze([longitude, latitude]),
    accuracyM: typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null });
}

function defaultGeolocation() {
  try {
    return globalThis.navigator?.geolocation ?? null;
  } catch {
    return null; // a browser that blocks the property is a browser without the feature
  }
}

// The geolocation boundary, injectable so tests can answer instead of a physical device. `request` never rejects
// and never resolves twice: every outcome is a value the caller can render.
export function createLocationProvider({ geolocation = defaultGeolocation(), options = LOCATION_OPTIONS } = {}) {
  const supported = Boolean(geolocation && typeof geolocation.getCurrentPosition === 'function');
  return Object.freeze({
    supported,
    options,
    request() {
      if (!supported) return Promise.resolve(failed(LOCATION_STATUS.UNSUPPORTED));
      return new Promise(resolve => {
        try {
          geolocation.getCurrentPosition(position => resolve(positionFromBrowser(position)),
            error => resolve(failed(locationErrorStatus(error?.code))), { ...options });
        } catch (error) {
          resolve(failed(LOCATION_STATUS.POSITION_UNAVAILABLE, `The browser refused the location request: ${error.message}`));
        }
      });
    },
  });
}

// ONE POSITION, LATEST CHOICE WINS.
//
// A location request is asynchronous and a person is not: they can pick a place, click the map or type
// coordinates while the browser is still looking. Each deliberate centre selection invalidates the pending
// request, so a late fix can never overwrite a newer, explicit choice.
export function createLocationRequest() {
  let current = 0;
  return Object.freeze({
    begin() { current += 1; return current; },
    isCurrent(token) { return token === current; },
    invalidate() { current += 1; },
  });
}
