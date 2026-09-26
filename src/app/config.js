// BROWSER BUILD CONFIGURATION.
//
// Which Investigator boundary this build talks to, in this order:
//
//   1. `window.ROADNATURALIST_WORKER_URL` — an explicit override. Tests use it, and so does a developer running a
//      local Worker (`cd worker && npx wrangler dev`).
//   2. `PRODUCTION_BOUNDARY` on any deployed origin — so production does not depend on somebody setting a global by
//      hand in a browser console. This is the checked-in production configuration.
//   3. nothing on a local origin — `npm run dev` replays the reviewed capture unless the override points it at a
//      local Worker, so offline development keeps working with no Cloudflare access at all.
//
// The resolved URL is the *base* of the Worker boundary: requests go to `${base}/api/investigator/probes/:probeId`.
// Whatever is resolved here, the browser only ever sends a probe id (worker/README.md).
export const PRODUCTION_BOUNDARY = 'https://api.roadnaturalist.com';

const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

// Pure so it can be tested directly (tests/investigator.test.js) without a browser.
export function resolveWorkerUrl({ override = undefined, hostname = undefined, production = PRODUCTION_BOUNDARY,
  localHosts = LOCAL_HOSTS } = {}) {
  const given = typeof override === 'string' ? override.trim() : '';
  if (given) return given.replace(/\/+$/, '');
  const host = String(hostname ?? '').toLowerCase();
  if (!host || localHosts.has(host)) return '';
  return production;
}

const overrideValue = typeof globalThis === 'undefined' ? undefined : globalThis.ROADNATURALIST_WORKER_URL;
const hostname = typeof globalThis === 'undefined' ? undefined : globalThis.location?.hostname;

export const INVESTIGATOR_WORKER_URL = resolveWorkerUrl({ override: overrideValue, hostname });
export const INVESTIGATOR_WORKER_CONFIGURED = Boolean(INVESTIGATOR_WORKER_URL);
export const CONFIG_NOTE = INVESTIGATOR_WORKER_CONFIGURED
  ? `Investigator live research is configured against ${INVESTIGATOR_WORKER_URL}; the reviewed capture stays available as the fallback.`
  : 'No investigator Worker is configured for this build, so official-source research replays the reviewed operator capture.';

