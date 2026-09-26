// BROWSER BUILD CONFIGURATION.
//
// The investigator Worker boundary is optional by design. With no URL configured, the app replays the reviewed
// operator capture (data/investigator/or-pilot-access-evidence.json) and reports those sources as deferred with
// access-verification coverage PARTIAL — the honest behaviour for a build that has no live boundary.
//
// When a boundary is deployed, the deployment sets `window.ROADNATURALIST_WORKER_URL` (for example in a small inline
// script or a Pages transform) rather than editing code, so the same committed build can run with or without it.
// Tests set the same global before loading the app.
const overrideValue = typeof globalThis === 'undefined' ? undefined : globalThis.ROADNATURALIST_WORKER_URL;

const normalized = typeof overrideValue === 'string' && overrideValue.trim() ? overrideValue.trim().replace(/\/+$/, '') : '';

export const INVESTIGATOR_WORKER_URL = normalized;
export const INVESTIGATOR_WORKER_CONFIGURED = Boolean(normalized);
export const CONFIG_NOTE = INVESTIGATOR_WORKER_CONFIGURED
  ? `Investigator live research is configured against ${normalized}; the reviewed capture stays available as the fallback.`
  : 'No investigator Worker is configured for this build, so official-source research replays the reviewed operator capture.';
