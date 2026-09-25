import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidate, setCandidateStatus, setCandidateCoverage, createCoverage, setDatasetCoverage, COVERAGE, COVERAGE_DATASET } from '../src/domain/corridor.js';
import { createStore } from '../src/state/store.js';
import { createGisService } from '../src/gis/service.js';
import { normalizeOccurrence, createOccurrenceService } from '../src/occurrence/service.js';
import { createResearchPlan, STAGES } from '../src/investigator/workflow.js';
import { corridorGeometry, corridorWkt } from '../src/domain/geometry.js';
import { summarizeLevel, combineCoverage } from '../src/gis/ecoregion-result.js';
import { validateManifest } from '../src/services/manifest.js';
import { summarizeEcoregions } from '../src/ecology/context.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const raw = { id: 'c1', name: 'Test corridor', status: 'discovered', geometry: { type: 'LineString', coordinates: [[-122, 45], [-121.9, 45.1]] }, evidence: [{ kind: 'INFERRED', statement: 'Test hypothesis', coverage: 'UNKNOWN', provenance: { source: 'test' } }] };

test('candidate requires geometry and provenance; decisions retain evidence', () => {
  const candidate = createCandidate(raw);
  const shortlisted = setCandidateStatus(candidate, 'shortlisted');
  assert.equal(shortlisted.status, 'shortlisted');
  assert.equal(candidate.status, 'discovered');
  assert.equal(shortlisted.evidence[0].provenance.source, 'test');
  assert.throws(() => createCandidate({ ...raw, geometry: { type: 'Point', coordinates: [0, 0] } }));
  assert.throws(() => createCandidate({ ...raw, evidence: [{ kind: 'LOCAL', statement: 'Unattributed', coverage: 'FULL' }] }));
});

test('store publishes candidate selection, coverage, and decision changes', () => {
  const store = createStore(); const states = [];
  store.subscribe(state => states.push(state));
  store.loadPilot({ pilotId: 'pilot', candidates: [createCandidate(raw)] });
  store.decide('c1', 'rejected');
  store.setCoverage('c1', COVERAGE_DATASET.ROAD_GEOMETRY, { coverage: COVERAGE.FULL, reason: null });
  assert.equal(states.length, 4);
  assert.equal(store.getState().selectedId, 'c1');
  assert.equal(store.getState().pilotLoaded, true);
  assert.equal(store.getState().candidates[0].status, 'rejected');
  assert.equal(store.getState().candidates[0].coverage[COVERAGE_DATASET.ROAD_GEOMETRY].coverage, COVERAGE.FULL);
  assert.throws(() => store.select('missing'));
});

test('candidate coverage keeps datasets separate and unknown by default', () => {
  const candidate = createCandidate(raw);
  assert.deepEqual(Object.keys(candidate.coverage).sort(), Object.values(COVERAGE_DATASET).sort());
  assert.equal(candidate.coverage[COVERAGE_DATASET.WETLANDS].coverage, COVERAGE.UNKNOWN);
  assert.equal(candidate.coverage[COVERAGE_DATASET.ACCESS_VERIFICATION].coverage, COVERAGE.UNKNOWN);
  const updated = setCandidateCoverage(candidate, COVERAGE_DATASET.EPA_LEVEL3, { coverage: COVERAGE.FULL, reason: null });
  assert.equal(updated.coverage[COVERAGE_DATASET.EPA_LEVEL3].coverage, COVERAGE.FULL);
  assert.equal(updated.coverage[COVERAGE_DATASET.ROAD_GEOMETRY].coverage, COVERAGE.UNKNOWN);
  assert.equal(candidate.coverage[COVERAGE_DATASET.EPA_LEVEL3].coverage, COVERAGE.UNKNOWN);
  assert.throws(() => setDatasetCoverage(createCoverage(), 'unknown-dataset', { coverage: COVERAGE.FULL }));
  assert.throws(() => setDatasetCoverage(createCoverage(), COVERAGE_DATASET.WETLANDS, { coverage: 'MAYBE' }));
});

test('unconnected GIS and occurrence are unknown, not zero', async () => {
  const gis = createGisService();
  assert.equal((await gis.queryCorridor(createCandidate(raw))).coverage, COVERAGE.UNKNOWN);
  assert.equal((await gis.getCoverage('wetlands', createCandidate(raw))).status, COVERAGE.UNKNOWN);
  const occurrences = createOccurrenceService();
  assert.deepEqual((await occurrences.getNearby({ source: 'ebird' })).records, []);
  assert.equal((await occurrences.getNearby({ source: 'ebird' })).coverage, COVERAGE.UNKNOWN);
});

test('obscured occurrence cannot carry precise location or road distance', () => {
  const record = normalizeOccurrence({ source: 'inaturalist', sourceRecordId: '1', taxon: 'Bird', locationPrecision: 'obscured', location: [-122, 45], distanceToCorridorM: 4 });
  assert.equal(record.location, null);
  assert.equal(record.distanceToCorridorM, null);
  assert.equal(record.locationPrecision, 'obscured');
});

test('research plan preserves the staged Investigator vocabulary', () => {
  const plan = createResearchPlan(createCandidate(raw));
  assert.equal(plan.candidateId, 'c1');
  assert.deepEqual(plan.stages.map(stage => stage.id), [...STAGES]);
  assert.ok(plan.stages.every(stage => stage.status === 'pending'));
});

test('corridor geometry derives bounds and length for lines and multiline roads', () => {
  const line = corridorGeometry(raw.geometry);
  assert.deepEqual(line.bounds, [-122, 45, -121.9, 45.1]);
  assert.ok(line.lengthM > 13000 && line.lengthM < 14000);
  const multi = corridorGeometry({ type: 'MultiLineString', coordinates: [raw.geometry.coordinates, [[-121.8, 45.2], [-121.7, 45.3]]] });
  assert.ok(multi.lengthM > line.lengthM);
  assert.match(corridorWkt(multi.geometry), /^MULTILINESTRING/);
  assert.throws(() => corridorGeometry({ type: 'LineString', coordinates: [[-122, 45], [-122, 45]] }), /positive length/);
});

test('primary and multiple ecoregions follow route-length overlap', () => {
  const level = summarizeLevel([{ code: '3', name: 'Willamette Valley', overlapM: 400 }, { code: '1', name: 'Coast Range', overlapM: 600 }], 1000);
  assert.equal(level.coverage, COVERAGE.FULL);
  assert.equal(level.primary.code, '1');
  assert.equal(level.spansMultiple, true);
  assert.equal(level.intersections[1].percent, 40);
  assert.equal(combineCoverage(level, level), COVERAGE.FULL);
  const context = summarizeEcoregions({ coverage: COVERAGE.FULL, level3: level, level4: level, spansMultiple: true, provenance: { dataset: 'EPA' } });
  assert.equal(context.kind, 'ECOLOGICAL_CONTEXT');
  assert.equal(context.label, 'Coast Range');
  assert.equal(context.provenance.dataset, 'EPA');
});

test('coverage separates outside scope, partial overlap, and failure', async () => {
  const none = summarizeLevel([], 1000);
  const partial = summarizeLevel([{ code: '1', name: 'Coast Range', overlapM: 300 }], 1000);
  assert.equal(none.coverage, COVERAGE.NONE);
  assert.equal(partial.coverage, COVERAGE.PARTIAL);
  assert.equal(combineCoverage(none, none), COVERAGE.NONE);
  assert.equal(combineCoverage(partial, none), COVERAGE.PARTIAL);
  assert.equal(combineCoverage({ coverage: COVERAGE.FULL }, { coverage: COVERAGE.UNKNOWN }), COVERAGE.PARTIAL);
  assert.equal(combineCoverage({ coverage: COVERAGE.NONE }, { coverage: COVERAGE.UNKNOWN }), COVERAGE.UNKNOWN);
  const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url)));
  const failed = createGisService({ manifest, engineFactory: async () => { throw new Error('extension unavailable'); } });
  const result = await failed.getEcoregions(raw.geometry);
  assert.equal(result.coverage, COVERAGE.UNKNOWN);
  assert.equal(result.diagnostics.status, 'unavailable');
  assert.match(result.diagnostics.reason, /extension unavailable/);
});

test('manifest declares real GeoParquet data, provenance, and matching digests', () => {
  const manifest = validateManifest(JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url))));
  const ecoregions = manifest.datasets.filter(dataset => dataset.type === 'ecoregions');
  assert.deepEqual(ecoregions.map(item => item.level), [3, 4]);
  for (const dataset of ecoregions) {
    const bytes = readFileSync(new URL(`../data/${dataset.url}`, import.meta.url));
    assert.equal(bytes.byteLength, dataset.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), dataset.sha256);
    assert.equal(dataset.source.agency, 'U.S. Environmental Protection Agency');
    assert.match(dataset.source.url, /or_eco_l[34]\.zip$/);
    assert.ok(dataset.featureCount > 0);
  }
  assert.throws(() => validateManifest({ schemaVersion: 1, datasets: [{ id: 'bad' }] }));
  assert.throws(() => validateManifest({ schemaVersion: 1, datasets: [] }));
});

test('one failed EPA level preserves the other as partial evidence', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url)));
  const l3 = readFileSync(new URL('../data/gis/epa-or-l3-2012.parquet', import.meta.url));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('l3-2012')) return new Response(l3);
    throw new Error('Level IV fetch failed');
  };
  try {
    const engineFactory = async () => ({
      db: { registerFileBuffer: async () => {} },
      conn: { query: async sql => ({ toArray: () => sql.startsWith('SELECT ST_Length') ? [{ length_m: 1000 }] : [{ code: '1', name: 'Coast Range', overlap_m: 1000 }] }) }
    });
    const gis = createGisService({ manifest, engineFactory });
    const result = await gis.getEcoregions(raw.geometry);
    assert.equal(result.coverage, COVERAGE.PARTIAL);
    assert.equal(result.level3.coverage, COVERAGE.FULL);
    assert.equal(result.level4.coverage, COVERAGE.UNKNOWN);
    assert.match(result.diagnostics.reason, /Level IV fetch failed/);
    assert.equal((await gis.getCoverage('epa-ecoregions-or-l3', raw.geometry)).status, COVERAGE.FULL);
  } finally { globalThis.fetch = oldFetch; }
});
