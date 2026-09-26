// THE SERVER-OWNED PROBE REGISTRY.
//
// A request carries a probe id and nothing else. The registry is the only thing that can turn that id into a URL,
// because it is built here, at module load, from the reviewed probe catalog (data/investigator/probe-catalog.json)
// plus this Worker's own fetch policy. A catalog entry can name a source and a policy profile; it cannot add a host to
// the allow-list, and a declaration whose host is not allow-listed makes this registry throw rather than fetch it.
// There is no code path in this Worker that accepts a URL, a host, a header, a method, or a query string from the
// client.
//
// If a probe id is unknown, the request fails with 404 and no upstream request is made.
import { createProbe } from '../../src/investigator/research.js';
import { PROBE_CATALOG } from '../../src/investigator/probes/catalog.js';
import { HOST_POLICY, buildProbePolicy } from './policies.js';

// Ids are opaque to the client and compared verbatim: no path segments, no encoding tricks, no unicode.
const PROBE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

export function normalizeProbeId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return PROBE_ID_PATTERN.test(value) ? value : null;
}

export function createProbeRegistry({ declarations = PROBE_CATALOG.declarations, hosts = HOST_POLICY } = {}) {
  const entries = new Map();
  for (const declaration of declarations) {
    // createProbe re-validates everything (https URL, stage, source class, declared facts, quoted windows), so the
    // Worker cannot serve a probe the browser side would reject.
    const probe = createProbe(declaration);
    // The policy is derived server-side from the declaration's profile name; an unknown profile or an unapproved
    // host throws here, so a bad catalog entry cannot be served at all.
    const policy = buildProbePolicy(declaration, { hosts });
    entries.set(probe.id, Object.freeze({ probe, policy }));
  }
  const probeIds = Object.freeze([...entries.keys()]);
  const sourceHosts = Object.freeze([...new Set([...entries.values()].map(entry => entry.policy.host))]);
  return Object.freeze({
    size: entries.size,
    probeIds,
    sourceHosts,
    has: probeId => entries.has(probeId),
    get: probeId => entries.get(probeId) ?? null,
    // The listing carries only what a client may know: the id and the public source description. No policy, no
    // internal host detail beyond the public source URL that is already provenance.
    list: () => Object.freeze([...entries.values()].map(entry => Object.freeze({ probeId: entry.probe.id, organization: entry.probe.organization,
      title: entry.probe.title, stage: entry.probe.stage, kind: entry.probe.kind, sourceUrl: entry.probe.url, sourceClass: entry.probe.sourceClass }))),
  });
}

// Built once per isolate; every request path reads from this frozen registry.
export const defaultProbeRegistry = createProbeRegistry();
