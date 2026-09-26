// SERVER-OWNED FETCH POLICY.
//
// The probe catalog (data/investigator/probe-catalog.json) says WHAT to read and WHICH phrases count as a fact. This
// module says HOW this Worker is allowed to read it: which hosts may ever be contacted, and for each probe the method,
// byte cap, timeout, accepted content types, and cache lifetime.
//
// Nothing here is client-supplied, and nothing here is catalog-supplied except a profile NAME. There is no path by
// which a request — or a catalog entry — can introduce a URL, a host, a header, a method, a byte cap, a timeout, or a
// redirect target: the registry resolves a probe id to a declaration, a catalog entry resolves to a profile name, and
// this file decides what that name means.
//
// Security posture: this is an SSRF-sensitive boundary, so the allow-list is static and exact. A URL is rejected
// unless it is https on the default port, with an ASCII host that appears here verbatim, no embedded credentials,
// and a path under the declared prefix. Redirects are never followed to another host, and no host in this list is
// loopback, private, link-local, or a cloud metadata name. Declaring a new source therefore requires two reviewed
// changes: the catalog entry, and — if the host is genuinely new — an explicit allow-list entry here.
import { POLICY_PROFILES as CATALOG_POLICY_PROFILES } from '../../src/investigator/probes/catalog.js';

export const WORKER_VERSION = 'roadnaturalist-investigator-worker/1';

// Hosts this Worker may contact, with the ceiling that applies to every probe on that host. A catalog entry whose URL
// is not here cannot be served at all: the registry refuses to build it.
export const HOST_POLICY = Object.freeze({
  'www.washingtoncountyor.gov': Object.freeze({ maxBytes: 524288, timeoutMs: 15000,
    contentTypes: Object.freeze(['text/html', 'application/xhtml+xml', 'text/plain']),
    note: 'Washington County Land Use & Transportation pages and news releases.' }),
  'www.wc-roads.com': Object.freeze({ maxBytes: 524288, timeoutMs: 15000,
    contentTypes: Object.freeze(['text/html', 'application/xhtml+xml']),
    note: 'Washington County road closures and traffic advisories: a status page, so it is cached briefly.' }),
  'multco.us': Object.freeze({ maxBytes: 524288, timeoutMs: 15000,
    contentTypes: Object.freeze(['text/html', 'application/xhtml+xml', 'text/plain']),
    note: 'Multnomah County transportation pages and its capital plan.' }),
  'content.govdelivery.com': Object.freeze({ maxBytes: 524288, timeoutMs: 15000,
    contentTypes: Object.freeze(['text/html', 'application/xhtml+xml', 'text/plain']),
    note: 'GovDelivery bulletin archives used by ODOT for transfer and project notices.' }),
});

// Cache lifetime by what a probe is about, not by host and not by anything a catalog entry can set numerically. The
// names are the catalog's logical profiles; a test asserts this map and the catalog's vocabulary are the same set, and
// an unknown name fails closed rather than falling back to a default lifetime.
export const POLICY_PROFILES = Object.freeze({
  'closure-status': Object.freeze({ ttlSeconds: 900,
    note: '15 minutes: a closure or a live road-status page can be extended, lifted, or replaced within a day.' }),
  'project-page': Object.freeze({ ttlSeconds: 21600,
    note: '6 hours: a project or programme page changes rarely, but it does change.' }),
  'jurisdiction-document': Object.freeze({ ttlSeconds: 86400,
    note: '24 hours: a jurisdiction, ownership, or funding document is a stable record.' }),
});

export const PROFILE_NAMES = Object.freeze(Object.keys(POLICY_PROFILES));

export const FETCH_LIMITS = Object.freeze({
  maxBytes: 524288,            // hard ceiling for any upstream body, streaming read aborts past it
  timeoutMs: 15000,
  maxRedirects: 1,             // same host and same path prefix only; anything else is a failure
  maxResponseBytes: 65536,     // ceiling for the normalized JSON this Worker returns
  maxFactsPerProbe: 32,
});

// Build the policy for one declaration and prove it is safe before the registry can serve it.
export function buildProbePolicy(declaration, { hosts = HOST_POLICY, limits = FETCH_LIMITS, profiles = POLICY_PROFILES } = {}) {
  const url = assertStaticSourceUrl(declaration.url);
  const host = hosts[url.hostname];
  if (!host) throw new TypeError(`Probe ${declaration.id}: host ${url.hostname} is not in the Worker source allow-list`);
  const profile = profiles[declaration.policyProfile];
  if (!profile) {
    throw new TypeError(`Probe ${declaration.id}: policy profile ${JSON.stringify(declaration.policyProfile ?? null)} is not implemented by this Worker; allowed profiles are ${PROFILE_NAMES.join(', ')}`);
  }
  return Object.freeze({ probeId: declaration.id, url, host: url.hostname, method: 'GET', profile: declaration.policyProfile,
    maxBytes: Math.min(host.maxBytes ?? limits.maxBytes, limits.maxBytes),
    timeoutMs: Math.min(host.timeoutMs ?? limits.timeoutMs, limits.timeoutMs),
    ttlSeconds: profile.ttlSeconds,
    contentTypes: Object.freeze([...(host.contentTypes ?? ['text/html'])]),
    maxRedirects: limits.maxRedirects,
    maxResponseBytes: limits.maxResponseBytes,
    note: host.note ?? null });
}

// Check a whole catalog against this Worker's policy without fetching anything: every declared source host must be
// allow-listed, and every profile name must be one this Worker implements. This is what the review CLI runs and what a
// test asserts, so "the catalog cannot widen the boundary" is a checked property rather than a comment.
export function checkCatalogAgainstPolicy(catalog, { hosts = HOST_POLICY, profiles = POLICY_PROFILES } = {}) {
  const errors = [];
  for (const [index, probe] of (catalog?.probes ?? []).entries()) {
    let url = null;
    try { url = assertStaticSourceUrl(probe.url); } catch (error) { errors.push({ probeId: probe.id, pointer: `/probes/${index}/url`, message: `Probe "${probe.id}": ${error.message}` }); continue; }
    if (!hosts[url.hostname]) {
      errors.push({ probeId: probe.id, pointer: `/probes/${index}/url`,
        message: `Probe "${probe.id}" declares ${url.hostname}, which is not in the Worker source allow-list (${Object.keys(hosts).join(', ')}). Declaring a host in the catalog does not allow it: add it to HOST_POLICY deliberately, or use an existing host.` });
    }
    if (!profiles[probe.policyProfile]) {
      errors.push({ probeId: probe.id, pointer: `/probes/${index}/policyProfile`,
        message: `Probe "${probe.id}" uses policy profile ${JSON.stringify(probe.policyProfile ?? null)}, which this Worker does not implement (${Object.keys(profiles).join(', ')}).` });
    }
  }
  return Object.freeze({ errors: Object.freeze(errors),
    hosts: Object.freeze([...new Set((catalog?.probes ?? []).map(probe => { try { return new URL(probe.url).hostname; } catch { return null; } }).filter(Boolean))]),
    profiles: Object.freeze([...new Set((catalog?.probes ?? []).map(probe => probe.policyProfile))]) });
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
