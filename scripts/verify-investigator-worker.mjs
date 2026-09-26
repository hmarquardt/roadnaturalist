#!/usr/bin/env node
/**
 * Opt-in verification of the investigator Worker boundary.
 *
 *   npm run verify:investigator:worker
 *
 * Two modes, and the script says which one it used:
 *
 *   1. DEPLOYED — when INVESTIGATOR_WORKER_URL is set (for example
 *      https://roadnaturalist-investigator.<account>.workers.dev), every declared probe is requested from the real
 *      Cloudflare Worker and the results are reported as they came back.
 *   2. LOCAL — when no URL is configured, the same handler this Worker deploys is served over a local HTTP socket in
 *      this Node process and exercised identically. That is a real end-to-end run of the boundary (SSRF checks, size
 *      caps, content-type checks, extraction, cache, drift, rate limits) that involves no Cloudflare account.
 *
 * Either way it reports, per probe: HTTP result, extraction result, cache state, drift against the committed baseline,
 * and then coverage and the deterministic finding per corridor, plus timing and payload numbers. It never reads a
 * credential (there is none) and it never writes to the repository.
 *
 * Nothing here fails the ordinary test suite: `npm test` and `npm run test:e2e` do not run this file.
 */
import { createServer } from 'node:http';
import { DEFAULT_ALLOWED_ORIGINS, createInvestigatorHandler } from '../worker/investigator/handler.js';
import { createProbeCache } from '../worker/investigator/cache.js';
import { FETCH_LIMITS } from '../worker/investigator/policies.js';
import { createProbeRegistry } from '../worker/investigator/registry.js';
import { createInvestigatorService } from '../src/investigator/service.js';
import { createResearchService } from '../src/investigator/research.js';
import { createWorkerResearchTransport, probeAvailability, retrievalModeCounts } from '../src/investigator/worker-transport.js';
import { PILOT_PROBES_BY_CORRIDOR } from '../src/investigator/sources.js';
import { DRIFT_BASELINE } from '../src/investigator/probes/drift-baseline.js';
import { createCandidate } from '../src/domain/corridor.js';
import { createRoad, groupRoadFeatures } from '../src/roads/road.js';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const readJson = path => JSON.parse(readFileSync(new URL(path, ROOT)));
const DEPLOYED_URL = (process.env.INVESTIGATOR_WORKER_URL ?? '').replace(/\/+$/, '');

// A Cache-API-shaped store over a Map, so the local mode exercises the same cache code the deployed Worker uses.
function localCacheStore() {
  const map = new Map();
  return { size: () => map.size, entries: () => [...map.keys()],
    async match(key) { const text = map.get(String(key)); return text === undefined ? undefined : new Response(text); },
    async put(key, response) { map.set(String(key), await response.text()); },
    async delete(key) { return map.delete(String(key)); } };
}

// Serve the handler over real HTTP: a Request in, a Response out, exactly as the platform does.
async function startLocalBoundary() {
  const store = localCacheStore();
  const handler = createInvestigatorHandler({ registry: createProbeRegistry(), cache: createProbeCache({ store }),
    allowedOrigins: DEFAULT_ALLOWED_ORIGINS });
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const method = incoming.method ?? 'GET';
    const body = chunks.length && method !== 'GET' && method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`, { method, headers: incoming.headers, body });
    const response = await handler.handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)), store, handler };
}

function pilotCorridors() {
  const snapshot = readJson('tests/fixtures/or-roads-pilot.snapshot.json');
  const declaration = readJson('data/roads/or-roads-pilot.json');
  const groups = new Map(groupRoadFeatures(snapshot.roads.flatMap(road => road.features.map(feature => ({ ...feature, roadId: road.roadId, name: road.name,
    roadClass: road.roadClass, routeType: road.routeType, countyFips: road.countyFips, countyName: road.countyName })))).map(group => [group.roadId, group]));
  return declaration.candidates.map(entry => {
    const roads = entry.roadIds.filter(roadId => groups.has(roadId)).map(roadId => createRoad(groups.get(roadId), { provenance: null }));
    return { candidate: createCandidate({ ...entry, roads }), roads };
  });
}

const log = (prefix, message) => console.log(`${prefix.padEnd(16)} ${message}`);

let local = null;
let baseUrl = DEPLOYED_URL;
console.log('Investigator Worker boundary verification');
if (DEPLOYED_URL) {
  console.log(`Mode: DEPLOYED boundary at ${DEPLOYED_URL}`);
} else {
  console.log('Mode: LOCAL handler served over 127.0.0.1 (no Cloudflare account involved)');
  console.log('Deployed mode is SKIPPED: set INVESTIGATOR_WORKER_URL to a deployed boundary to verify the real one.');
  local = await startLocalBoundary();
  baseUrl = local.url;
}
console.log(`Baseline: ${DRIFT_BASELINE.capturedAt} (${DRIFT_BASELINE.probes.length} probes)`);

const availability = await probeAvailability({ baseUrl });
log('availability', availability.available ? `available (${availability.worker ?? 'version unrecorded'}), ${availability.probeIds.length} declared probe(s)` : `UNAVAILABLE — ${availability.reason}`);
if (!availability.available) {
  console.log('\nThe boundary could not be reached, so no source was contacted. Nothing else can be verified.');
  if (local) await local.close();
  process.exit(0);
}

const totals = { probes: 0, upstream: 0, cacheHits: 0, failures: 0, normalizedBytes: 0, upstreamBytes: 0, coldMs: [], hitMs: [] };
const drift = { UNCHANGED: 0, EVIDENCE_CHANGED: 0, NO_LONGER_MATCHES: 0, SOURCE_UNAVAILABLE: 0, NO_BASELINE: 0 };
const firstRequestAt = Date.now();

for (const { candidate, roads } of pilotCorridors()) {
  const probes = PILOT_PROBES_BY_CORRIDOR[candidate.id] ?? [];
  const transport = createWorkerResearchTransport({ baseUrl });
  const research = createResearchService({ transport, probes });
  const service = createInvestigatorService({ osmSource: null, research, probes, environment: `worker-boundary/${DEPLOYED_URL ? 'deployed' : 'local'}` });
  console.log(`\n=== ${candidate.id} (${candidate.name}) — ${probes.length} declared source(s) ===`);
  const started = Date.now();
  const investigation = await service.investigate({ candidate, roads });
  const elapsed = Date.now() - started;
  for (const probe of investigation.research.probes) {
    totals.probes += 1;
    const cacheStatus = probe.searched?.cacheStatus ?? 'n/a';
    if (cacheStatus === 'HIT') totals.cacheHits += 1; else totals.upstream += 1;
    if (probe.outcome === 'FAILED') totals.failures += 1;
    totals.normalizedBytes += probe.searched?.bytesNormalized ?? 0;
    totals.upstreamBytes += probe.searched?.bytes ?? 0;
    const state = probe.drift?.worker?.state ?? 'n/a';
    if (state in drift) drift[state] += 1;
    log(`  ${probe.outcome.toLowerCase()}`, `${probe.probeId} · http=${probe.searched?.httpStatus ?? 'n/a'} · cache=${cacheStatus} · facts=${probe.matches.length} · drift=${state} · ${probe.searched?.bytes ?? 'n/a'}B upstream`);
    if (probe.outcome === 'FAILED') log('    reason', probe.searched?.reason ?? 'no reason reported');
  }
  const modes = retrievalModeCounts(investigation.research.probes);
  log('coverage', `${investigation.access.coverage.coverage} — ${investigation.access.coverage.reason.slice(0, 150)}`);
  log('finding', `${investigation.access.finding} (${investigation.access.ruleId})`);
  log('restrictions', investigation.access.restrictions.map(item => `${item.claimType}(${item.temporalScope})`).join(', ') || 'none');
  log('reads', modes.summary);
  log('timing', `${elapsed} ms for the corridor (including the availability check it does not repeat)`);
}

// A second pass over one corridor shows what the cache does: the probes should be served without touching a source.
const cacheProbe = pilotCorridors()[0];
const cacheProbes = PILOT_PROBES_BY_CORRIDOR[cacheProbe.candidate.id] ?? [];
const secondTransport = createWorkerResearchTransport({ baseUrl });
const secondStarted = Date.now();
const secondResults = [];
for (const probe of cacheProbes) secondResults.push(await secondTransport.run(probe, { corridorId: cacheProbe.candidate.id }));
const secondMs = Date.now() - secondStarted;
const secondModes = retrievalModeCounts(secondResults);
console.log('\n=== cache behaviour (repeat pass over the first corridor) ===');
log('reads', secondModes.summary);
log('timing', `${secondMs} ms for ${secondResults.length} probe(s) (${(secondMs / secondResults.length).toFixed(0)} ms each)`);
log('store', local ? `${local.store.size()} cached page(s) in the local cache` : 'the deployed Worker uses its own Cache API store');

console.log('\n=== summary ===');
log('probes', `${totals.probes} requested · ${totals.upstream} upstream read(s) · ${totals.cacheHits} cache hit(s) · ${totals.failures} failure(s)`);
log('drift', Object.entries(drift).map(([state, count]) => `${state} ${count}`).join(' · '));
log('payload', `${(totals.upstreamBytes / 1024).toFixed(1)} kB read from the sources, ${totals.normalizedBytes} B returned to the browser`);
log('elapsed', `${Date.now() - firstRequestAt} ms for the full run`);
if (!DEPLOYED_URL) {
  console.log('\nTo verify the deployed boundary instead, deploy worker/ with wrangler (see worker/README.md) and set');
  console.log('INVESTIGATOR_WORKER_URL to its URL. That step needs a Cloudflare account decision this repository does not make.');
}
if (local) await local.close();
