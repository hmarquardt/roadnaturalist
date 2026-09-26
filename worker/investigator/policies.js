// SERVER-OWNED FETCH POLICY.
//
// The probe declarations (src/investigator/probes/or-pilot.js) say WHAT to read and WHICH phrases count as a fact.
// This module says HOW this Worker is allowed to read it: which hosts may ever be contacted, and for each probe the
// method, byte cap, timeout, accepted content types, and cache lifetime.
//
// Nothing here is client-supplied. There is no path by which a request can introduce a URL, a host, a header, or a
// method: the registry resolves a probe id to a declaration and a policy, and both are code committed in this repo.
//
// Security posture: this is an SSRF-sensitive boundary, so the allow-list is static and exact. A URL is rejected
// unless it is https on the default port, with an ASCII host that appears here verbatim, no embedded credentials,
// and a path under the declared prefix. Redirects are never followed to another host, and no host in this list is
// loopback, private, link-local, or a cloud metadata name.
import { PROBE_KIND } from '../../src/investigator/research.js';

export const WORKER_VERSION = 'roadnaturalist-investigator-worker/1';

// Hosts this Worker may contact, with the ceiling that applies to every probe on that host.
export const HOST_POLICY = Object.freeze({
  'www.washingtoncountyor.gov': Object.freeze({ maxBytes: 524288, timeoutMs: 15000, ttlSeconds: 21600,
    contentTypes: Object.freeze(['text/html', 'application/xhtml+xml', 'text/plain']),
    note: 'Washington County Land Use & Transportation pages and news releases.' }),
  'www.wc-roads.com': Object.freeze({ maxBytes: 524288, timeoutMs: 15000, ttlSeconds: 900,
    contentTypes: Object.freeze(['text/html', 'application/xhtml+xml']),
    note: 'Washington County road closures and traffic advisories: a status page, so it is cached briefly.' }),
  'multco.us': Object.freeze({ maxBytes: 524288, timeoutMs: 15000, ttlSeconds: 86400,
    contentTypes: Object.freeze(['text/html', 'application/xhtml+xml', 'text/plain']),
    note: 'Multnomah County transportation pages and its capital plan.' }),
  'content.govdelivery.com': Object.freeze({ maxBytes: 524288, timeoutMs: 15000, ttlSeconds: 86400,
    contentTypes: Object.freeze(['text/html', 'application/xhtml+xml', 'text/plain']),
    note: 'GovDelivery bulletin archives used by ODOT for transfer and project notices.' }),
});

// Cache lifetime by what a probe is about: a closure notice changes fastest, a funding programme slowest.
export const KIND_TTL_SECONDS = Object.freeze({
  [PROBE_KIND.CLOSURE]: 900,        // 15 minutes: a closure can be extended or lifted
  [PROBE_KIND.ROAD_STATUS]: 21600,   //  6 hours: a project or programme page
  [PROBE_KIND.AUTHORITY]: 86400,     // 24 hours: a jurisdiction or ownership document
  [PROBE_KIND.PRIVATE_ACCESS]: 86400,
  [PROBE_KIND.PERMIT]: 86400,
  [PROBE_KIND.SURFACE]: 21600,
});

// Per-probe overrides, only where a probe's own page is more volatile or heavier than its kind implies.
export const PROBE_POLICY_OVERRIDES = Object.freeze({
  // The county advisory list is a live status page: never serve it from cache for long.
  'wc-roads-cornelius-advisory': Object.freeze({ ttlSeconds: 900 }),
  'wc-roads-springville-advisory': Object.freeze({ ttlSeconds: 900 }),
});

export const FETCH_LIMITS = Object.freeze({
  maxBytes: 524288,            // hard ceiling for any upstream body, streaming read aborts past it
  timeoutMs: 15000,
  maxRedirects: 1,             // same host and same path prefix only; anything else is a failure
  maxResponseBytes: 65536,     // ceiling for the normalized JSON this Worker returns
  maxFactsPerProbe: 32,
});

// Build the policy for one declaration and prove it is safe before the registry can serve it.
export function buildProbePolicy(declaration, { hosts = HOST_POLICY, limits = FETCH_LIMITS, overrides = PROBE_POLICY_OVERRIDES } = {}) {
  const url = assertStaticSourceUrl(declaration.url);
  const host = hosts[url.hostname];
  if (!host) throw new TypeError(`Probe ${declaration.id}: host ${url.hostname} is not in the Worker source allow-list`);
  const override = overrides[declaration.id] ?? {};
  const ttlSeconds = override.ttlSeconds ?? KIND_TTL_SECONDS[declaration.kind] ?? host.ttlSeconds;
  return Object.freeze({ probeId: declaration.id, url, host: url.hostname, method: 'GET',
    maxBytes: Math.min(override.maxBytes ?? host.maxBytes ?? limits.maxBytes, limits.maxBytes),
    timeoutMs: Math.min(override.timeoutMs ?? host.timeoutMs ?? limits.timeoutMs, limits.timeoutMs),
    ttlSeconds,
    contentTypes: Object.freeze([...(override.contentTypes ?? host.contentTypes ?? ['text/html'])]),
    maxRedirects: limits.maxRedirects,
    maxResponseBytes: limits.maxResponseBytes,
    note: host.note ?? null });
}

// A source URL is trusted only if it is exactly the kind of URL this project would have declared by hand.
export function assertStaticSourceUrl(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('Source URL must be a non-empty string');
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`Source URL is not a URL: ${value}`); }
  if (url.protocol !== 'https:') throw new TypeError(`Source URL must use https: ${value}`);
  if (url.username || url.password) throw new TypeError('Source URL must not contain credentials');
  if (url.port && url.port !== '443') throw new TypeError(`Source URL must use the default https port: ${value}`);
  if (value !== url.href) throw new TypeError(`Source URL must be in canonical form: ${value}`);
  // A declared source is a fixed document. No query string, no fragment: nothing about the request can reach the
  // source's own parameters, now or in a future edit.
  if (url.search) throw new TypeError(`Source URL must not carry a query string: ${value}`);
  if (url.hash) throw new TypeError(`Source URL must not carry a fragment: ${value}`);
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(url.hostname)) throw new TypeError('Source URL host must be ASCII');
  const host = url.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) throw new TypeError('Source URL must not be an IP literal');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new TypeError('Source URL must not be a local or internal host');
  if (/^\d+$/.test(host)) throw new TypeError('Source URL must not be a numeric host');
  if (!host.includes('.')) throw new TypeError('Source URL must be a fully qualified domain name');
  return url;
}

// A redirect may only continue on the same host, over https, under the same path prefix.
export function assertAllowedRedirect(location, current, policy) {
  let next;
  try { next = new URL(location, current); } catch { throw new TypeError('Redirect location is not a URL'); }
  if (next.protocol !== 'https:') throw new TypeError('Redirect must stay on https');
  if (next.hostname !== policy.host) throw new TypeError(`Redirect to ${next.hostname} is not allowed (only ${policy.host})`);
  if (next.port && next.port !== '443') throw new TypeError('Redirect must use the default https port');
  if (!next.pathname.startsWith(policy.url.pathname.split('/').slice(0, -1).join('/') || '/')) throw new TypeError('Redirect must stay under the declared path prefix');
  return next;
}
