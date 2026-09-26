// THE SERVER-OWNED PROBE REGISTRY.
//
// A request carries a probe id and nothing else. The registry is the only thing that can turn that id into a URL,
// because it is built here, at module load, from committed declarations plus committed fetch policy. There is no
// code path in this Worker that accepts a URL, a host, a header, a method, or a query string from the client.
//
// If a probe id is unknown, the request fails with 404 and no upstream request is made.
import { createProbe } from '../../src/investigator/research.js';
import { ALL_PROBE_DECLARATIONS } from '../../src/investigator/probes/or-pilot.js';
import { HOST_POLICY, buildProbePolicy } from './policies.js';

// Ids are opaque to the client and compared verbatim: no path segments, no encoding tricks, no unicode.
const PROBE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

export function normalizeProbeId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return PROBE_ID_PATTERN.test(value) ? value : null;
}

export function createProbeRegistry({ declarations = ALL_PROBE_DECLARATIONS, hosts = HOST_POLICY } = {}) {
  const entries = new Map();
  for (const declaration of declarations) {
    // createProbe re-validates everything (https URL, stage, source class, declared facts, quoted windows), so the
    // Worker cannot serve a probe the browser side would reject.
    const probe = createProbe(declaration);
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
