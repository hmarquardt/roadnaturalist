#!/usr/bin/env node
/**
 * Opt-in live/operator verification for the Investigator.
 *
 *   npm run verify:investigator:live
 *   npm run verify:investigator:live -- --corridors=or-roads-susbauer-rd --no-osm
 *   npm run verify:investigator:live -- --write-record          # regenerate the reviewed capture
 *
 * Routine `npm test` never runs this script and never needs a credential: official sources are public pages
 * and OpenStreetMap's Overpass API needs no key. The script:
 *
 *   1. fetches every declared source in src/investigator/sources.js and checks each declared phrase against
 *      the text the source actually served (a phrase that has moved or disappeared is reported as drift);
 *   2. queries OpenStreetMap through the same adapter and mirrors the browser uses, matches the mapped ways
 *      to the canonical TIGER/Line corridor, and reports the match metrics;
 *   3. runs the real staged pipeline and prints the qualified finding, its guardrail rule, restrictions,
 *      contradictions, unresolved items, and access-verification coverage;
 *   4. with --write-record, writes data/investigator/or-pilot-access-evidence.json, the reviewed capture the
 *      browser build replays offline. Live results never become fixture truth automatically: the capture is
 *      a dated, git-reviewable artifact and this script re-verifies it on demand.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { corridorGeometry } from '../src/domain/geometry.js';
import { createCandidate } from '../src/domain/corridor.js';
import { createRoad, groupRoadFeatures } from '../src/roads/road.js';
import { createOsmSource, OVERPASS_MIRRORS } from '../src/investigator/osm.js';
import { createLiveResearchTransport, createResearchService } from '../src/investigator/research.js';
import { PILOT_PROBES_BY_CORRIDOR } from '../src/investigator/sources.js';
import { createInvestigatorService } from '../src/investigator/service.js';
import { STAGE_STATUS } from '../src/investigator/workflow.js';
import { buildBaselineFromRecord } from '../src/investigator/drift.js';

const ROOT = new URL('..', import.meta.url);
const readJson = path => JSON.parse(readFileSync(new URL(path, ROOT)));
const RECORD_PATH = 'data/investigator/or-pilot-access-evidence.json';
const BASELINE_PATH = 'src/investigator/probes/drift-baseline.js';
const flags = new Set(process.argv.slice(2).filter(argument => argument.startsWith('--')));
const corridorFlag = process.argv.slice(2).find(argument => argument.startsWith('--corridors='));
const selected = corridorFlag ? corridorFlag.split('=')[1].split(',') : null;
const useOsm = !flags.has('--no-osm');
const writeRecord = flags.has('--write-record');

function pilotCorridors() {
  const snapshot = readJson('tests/fixtures/or-roads-pilot.snapshot.json');
  const declaration = readJson('data/roads/or-roads-pilot.json');
  const groups = new Map(groupRoadFeatures(snapshot.roads.flatMap(road => road.features.map(feature => ({ ...feature,
    roadId: road.roadId, name: road.name, roadClass: road.roadClass, routeType: road.routeType,
    countyFips: road.countyFips, countyName: road.countyName })))).map(group => [group.roadId, group]));
  return declaration.candidates.filter(entry => !selected || selected.includes(entry.id)).map(entry => {
    const roads = entry.roadIds.filter(roadId => groups.has(roadId)).map(roadId => createRoad(groups.get(roadId), { provenance: null }));
    const candidate = createCandidate({ ...entry, roads });
    return { candidate, roads };
  });
}

function recordFor(corridorId) {
  try { return readJson(RECORD_PATH); } catch { return null; }
}

function log(prefix, message) { console.log(`${prefix.padEnd(18)} ${message}`); }

const corridors = pilotCorridors();
const record = recordFor();
console.log(`Live Investigator verification — ${corridors.length} pilot corridor(s), OpenStreetMap ${useOsm ? 'live' : 'skipped'}`);
console.log(`Declared source capture on file: ${record ? `${record.capturedAt} (${record.schemaVersion})` : 'none'}`);
console.log(`Overpass mirrors in order: ${OVERPASS_MIRRORS.map(mirror => `${mirror.id}${mirror.cors ? ' (CORS)' : ''}`).join(', ')}`);

const capture = { schemaVersion: 'roadnaturalist-access-evidence/1', capturedAt: new Date().toISOString(),
  environment: 'operator/node', corridors: {} };
let drift = 0;

for (const { candidate, roads } of corridors) {
  const probes = PILOT_PROBES_BY_CORRIDOR[candidate.id] ?? [];
  const osmSource = useOsm ? createOsmSource({}) : null;
  const research = createResearchService({ transport: createLiveResearchTransport(), probes });
  const service = createInvestigatorService({ osmSource, research, probes, environment: 'operator/node' });
  console.log(`\n=== ${candidate.id} (${candidate.name}) — ${(corridorGeometry(candidate.geometry).lengthM / 1609.344).toFixed(1)} mi, ${roads.length} road record(s) ===`);
  const started = Date.now();
  const investigation = await service.investigate({ candidate, roads, checkedAt: new Date().toISOString() });
  log('stage', `${investigation.stageSummary.complete} complete, ${investigation.stageSummary.warning} warning, ${investigation.stageSummary.failed} failed (${Date.now() - started} ms)`);
  for (const stage of investigation.stages) log(`  ${stage.id}`, `[${stage.status}] ${stage.summary}`);
  for (const warning of investigation.warnings) log('  warning', `${warning.stage}: ${warning.note}`);

  if (investigation.osm) {
    const osm = investigation.osm;
    log('osm', `status ${osm.status} · ${osm.match ? `${osm.match.matchedWayCount}/${osm.match.candidateWayCount} way(s) within ${osm.match.toleranceM} m · ${(osm.match.matchedFraction * 100).toFixed(1)}% of corridor matched` : 'no match computed'}`);
    log('osm', `mirrors used: ${osm.mirrorsUsed.join(', ') || 'none'} · ways ${osm.ways.length} · barriers mapped ${osm.barriers.length}`);
    for (const failure of osm.failures.slice(0, 4)) log('  osm failure', `${failure.mirror ?? 'transport'}: ${failure.reason}`);
    for (const variant of (osm.nameVariants ?? []).slice(0, 4)) log('  name variant', `${variant.name} (${variant.relation})`);
  }

  for (const result of investigation.research.probes) {
    log('source', `[${result.outcome}] ${result.organization} — ${result.question}`);
    log('  url', `${result.url} (HTTP ${result.searched?.httpStatus ?? 'n/a'}, ${result.searched?.bytes ?? 'n/a'} bytes, ${result.searched?.retrievedAt ?? 'not retrieved'})`);
    if (result.note) log('  note', result.note);
    for (const match of (result.matches ?? [])) log('  quote', `"${match.quote.slice(0, 150)}"`);
  }

  const access = investigation.access;
  log('finding', `${access.finding} — ${access.ruleId}`);
  log('  meaning', access.meaning);
  log('  checked', `evidence checked ${access.evidenceCheckedAt ?? 'date unrecorded'} · evaluated as of ${access.checkedAsOf}`);
  log('  coverage', `${access.coverage.coverage} — ${access.coverage.reason}`);
  log('  affirmative', access.affirmative.map(item => `${item.sourceOrganization}: ${item.claimType}`).join(' | ') || 'none');
  log('  restrictions', access.restrictions.map(item => `${item.claimType} (${item.temporalScope})`).join(' | ') || 'none');
  log('  attention', access.attention.map(item => item.claimType).join(' | ') || 'none');
  for (const contradiction of access.contradictions) log('  contradiction', `${contradiction.kind}: ${contradiction.note}`);
  for (const unresolved of access.unresolved) log('  unresolved', `${unresolved.code}: ${unresolved.text}`);
  for (const qualifier of access.qualifiers) log('  qualifier', qualifier);
  if (access.review) log('  adversarial', `${access.review.concerns.join(', ') || 'no concerns'} — ${access.review.conclusion}`);

  // Drift check against the reviewed capture on file: a source that previously produced evidence but no
  // longer matches its declared phrases has changed, and that is worth seeing before trusting the capture.
  const previous = record?.corridors?.[candidate.id];
  for (const result of investigation.research.probes) {
    const before = previous?.probes?.find(entry => entry.probeId === result.probeId);
    if (!before) continue;
    if (before.outcome === 'EVIDENCE' && result.outcome !== 'EVIDENCE') { drift += 1; log('  DRIFT', `${result.probeId}: capture had evidence, live run reports ${result.outcome}`); }
    for (const evidence of before.evidence ?? []) {
      const live = result.matches?.some(match => match.quote === evidence.quote);
      if (!live) { drift += 1; log('  DRIFT', `${result.probeId}: captured quote no longer found at source — "${evidence.quote.slice(0, 90)}"`); }
    }
  }

  capture.corridors[candidate.id] = {
    checkedAsOf: investigation.checkedAsOf,
    finding: { finding: access.finding, ruleId: access.ruleId, checkedAsOf: access.checkedAsOf, coverage: access.coverage.coverage },
    probes: investigation.research.probes.map(result => ({ probeId: result.probeId, outcome: result.outcome, searched: result.searched, note: result.note,
      evidence: result.evidence })),
    osm: investigation.osm ? { status: investigation.osm.status, retrievedAt: investigation.osm.retrievedAt, osmTimestamp: investigation.osm.osmTimestamp,
      mirrorsUsed: investigation.osm.mirrorsUsed, searchNames: investigation.osm.searchNames, searchBounds: investigation.osm.searchBounds,
      match: { ...investigation.osm.match, ways: investigation.osm.match?.ways?.slice(0, 25) ?? [], waysTruncated: (investigation.osm.match?.ways?.length ?? 0) > 25 },
      nameVariants: investigation.osm.nameVariants, queries: investigation.osm.queries,
      failures: investigation.osm.failures, waySummaries: investigation.osm.waySummaries,
      evidence: investigation.evidence.filter(item => item.sourceOrganization === 'OpenStreetMap contributors') } : null,
  };
}

console.log(`\nDrift findings: ${drift}`);
if (writeRecord) {
  writeFileSync(new URL(RECORD_PATH, ROOT), `${JSON.stringify(capture, null, 1)}\n`);
  console.log(`Wrote reviewed capture: ${RECORD_PATH} (${capture.capturedAt})`);
  // The Worker compares its own fresh reads against a compact baseline of this capture, so the two must be refreshed
  // together: a baseline from an older capture would report drift on every probe.
  const baseline = buildBaselineFromRecord(capture);
  const baselineHeader = [
    '// COMPACT SOURCE-DRIFT BASELINE (GENERATED — do not edit by hand).',
    '//',
    '// Normalized extracted facts from the reviewed operator capture. The Worker compares its own fresh read of a',
    '// source against this; the browser compares a live Worker result against the recorded capture it replays.',
    '// Regenerate together with the capture: npm run verify:investigator:live -- --write-record.',
    '// It carries no page text, no HTML, no credential, and no corridor context.',
  ].join('\n');
  writeFileSync(new URL(BASELINE_PATH, ROOT), `${baselineHeader}\nexport const DRIFT_BASELINE = Object.freeze(${JSON.stringify(baseline, null, 1)});\n\nexport default DRIFT_BASELINE;\n`);
  console.log(`Wrote drift baseline: ${BASELINE_PATH} (${baseline.probes.length} probes)`);
  console.log('Review the diff before committing: the capture is what the browser build replays offline.');
} else {
  console.log(`Capture not written (pass --write-record to update ${RECORD_PATH}).`);
}
console.log('\nThis script verifies the research transport, OpenStreetMap adapter, geometry matching, stage pipeline, and finding guardrails against live sources.');
