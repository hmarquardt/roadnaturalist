// CLOUDFLARE WORKER ENTRY POINT.
//
// This is the only file the platform loads. It binds the runtime's `fetch` and Cache API to the request handler in
// worker/investigator/handler.js and keeps the logging shape minimal: one JSON line per event, with the fields a
// reviewer needs and never a response body, a credential, or user data.
//
// Configuration (all optional; see worker/README.md):
//   INVESTIGATOR_ALLOWED_ORIGINS  comma-separated list overriding the committed default origins
//   INVESTIGATOR_CACHE            set to "off" to bypass the source cache (useful while reviewing a page by hand)
// No secret is read here, and none exists: the sources are public pages.
import { createInvestigatorHandler, parseAllowedOrigins } from './investigator/handler.js';
import { createProbeCache } from './investigator/cache.js';

const logLine = line => console.log(line);

function bindHandler(env = {}) {
  const allowedOrigins = parseAllowedOrigins(env.INVESTIGATOR_ALLOWED_ORIGINS);
  const cacheEnabled = String(env.INVESTIGATOR_CACHE ?? 'on').toLowerCase() !== 'off';
  const store = cacheEnabled ? globalThis.caches?.default ?? null : null;
  return createInvestigatorHandler({ cache: createProbeCache({ store }), allowedOrigins, log: logLine });
}

// Built per isolate: the registry and baseline are module state, the handler is cheap to construct.
let handler = null;
export default {
  async fetch(request, env, ctx) {
    if (!handler) handler = bindHandler(env);
    try {
      return await handler.handle(request);
    } catch (error) {
      logLine(JSON.stringify({ worker: handler.version, event: 'unhandled_error', message: error?.message ?? 'unknown error' }));
      return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'the investigator boundary failed to answer' } }),
        { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
  },
};

export { bindHandler };
