import { LOCATION_STATUS, locationAccuracyLabel, locationStatusMessage } from '../discovery/geolocation.js';

// WHERE THE PERSON IS, RIGHT NOW, IN THIS BROWSER - AND NOWHERE ELSE.
//
// This is transient state: one reading, replaced by the next one, cleared when the watch stops. Nothing here is
// persisted, nothing is written to storage, no history is kept, and no coordinate leaves the page. The state exists so
// the map can draw a position and the field view can measure how far the current road is from it.
//
// The browser's own codes are the one place that knows what went wrong (`locationErrorStatus`); this module only says
// what those outcomes mean to a person working a plan, in the field's own words.
export const LIVE_LOCATION_STATUS = Object.freeze({ IDLE: 'idle', REQUESTING: 'requesting', ACTIVE: 'active',
  DENIED: 'denied', UNAVAILABLE: 'unavailable', TIMEOUT: 'timeout', UNSUPPORTED: 'unsupported' });

export const IDLE_LIVE_LOCATION = Object.freeze({ status: LIVE_LOCATION_STATUS.IDLE, point: null, accuracyM: null,
  timestamp: null, message: null });

// The one mapping from the browser's vocabulary to the field's, so a status is never invented twice.
export function liveStatusFromLocationStatus(status) {
  if (status === LOCATION_STATUS.OK) return LIVE_LOCATION_STATUS.ACTIVE;
  if (status === LOCATION_STATUS.PERMISSION_DENIED) return LIVE_LOCATION_STATUS.DENIED;
  if (status === LOCATION_STATUS.TIMEOUT) return LIVE_LOCATION_STATUS.TIMEOUT;
  if (status === LOCATION_STATUS.UNSUPPORTED) return LIVE_LOCATION_STATUS.UNSUPPORTED;
  if (status === LOCATION_STATUS.POSITION_UNAVAILABLE) return LIVE_LOCATION_STATUS.UNAVAILABLE;
  return LIVE_LOCATION_STATUS.IDLE;
}

// WHAT THE FIELD VIEW SAYS. Every refusal leaves the plan exactly as usable as it was: the person can still move
// between roads, read them, mark progress and hand a coordinate to their own mapping app.
export function liveLocationMessage(status) {
  if (status === LIVE_LOCATION_STATUS.DENIED) return 'Location permission was not granted. The plan still works: move between roads, mark progress and open a road in your mapping app.';
  if (status === LIVE_LOCATION_STATUS.UNAVAILABLE) return 'Your device could not determine a location right now. The plan still works without it.';
  if (status === LIVE_LOCATION_STATUS.TIMEOUT) return 'The device did not report a location in time. Press "Use my location" to try again.';
  if (status === LIVE_LOCATION_STATUS.UNSUPPORTED) return 'This browser cannot report a live location. The plan still works without it.';
  if (status === LIVE_LOCATION_STATUS.REQUESTING) return 'Asking this device for its location…';
  return null;
}

export function liveLocationStatusLabel(status) {
  if (status === LIVE_LOCATION_STATUS.ACTIVE) return 'Location on';
  if (status === LIVE_LOCATION_STATUS.REQUESTING) return 'Location: asking…';
  if (status === LIVE_LOCATION_STATUS.DENIED) return 'Location: not granted';
  if (status === LIVE_LOCATION_STATUS.UNAVAILABLE) return 'Location: unavailable';
  if (status === LIVE_LOCATION_STATUS.TIMEOUT) return 'Location: timed out';
  if (status === LIVE_LOCATION_STATUS.UNSUPPORTED) return 'Location: not supported here';
  return 'Location off';
}

// One reading, in the state's own shape. A reading that is not a usable coordinate is a device that could not determine
// a location - never a position at (0, 0) and never a partially written point.
export function liveLocationReading(reading, { at = Date.now() } = {}) {
  const status = liveStatusFromLocationStatus(reading?.status ?? LOCATION_STATUS.POSITION_UNAVAILABLE);
  const [lon, lat] = Array.isArray(reading?.center) ? reading.center : [];
  // A READING WITHOUT A USABLE CENTRE IS NOT A POSITION, whatever it called itself: an "ok" fix with no coordinate is a
  // device that could not determine where it is, and it is reported that way rather than as a point at (0, 0).
  if (status !== LIVE_LOCATION_STATUS.ACTIVE || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    const reason = status === LIVE_LOCATION_STATUS.ACTIVE || status === LIVE_LOCATION_STATUS.IDLE
      ? LIVE_LOCATION_STATUS.UNAVAILABLE : status;
    return Object.freeze({ status: reason, point: null, accuracyM: null, timestamp: null,
      message: liveLocationMessage(reason) });
  }
  return Object.freeze({ status: LIVE_LOCATION_STATUS.ACTIVE, point: Object.freeze([lon, lat]),
    accuracyM: Number.isFinite(reading.accuracyM) ? reading.accuracyM : null,
    timestamp: Number.isFinite(at) ? at : null, message: null });
}

export function requestingLiveLocation() {
  return Object.freeze({ ...IDLE_LIVE_LOCATION, status: LIVE_LOCATION_STATUS.REQUESTING,
    message: liveLocationMessage(LIVE_LOCATION_STATUS.REQUESTING) });
}

// The accuracy line, or nothing when the device did not report one. It is presentation: it never changes a distance.
export function liveLocationAccuracyLabel(location) {
  return location?.status === LIVE_LOCATION_STATUS.ACTIVE ? locationAccuracyLabel(location.accuracyM) : null;
}

// THE PRIVACY STATEMENT, beside the control, and true of the implementation: the reading lives in this page's state
// until the watch stops, and it is not written to the plan or to any storage.
export const LIVE_LOCATION_PRIVACY_NOTE = 'Your live location stays in this browser and is not saved with the outing.';
