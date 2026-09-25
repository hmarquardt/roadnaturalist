import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COVERAGE, COVERAGE_DATASET, EVIDENCE_KIND } from '../src/domain/corridor.js';
import { corridorGeometry } from '../src/domain/geometry.js';
import {
  CORRIDOR_ACCURACY_LIMIT_M, LOCATION_PRECISION, OCCURRENCE_RADII_M, OCCURRENCE_SOURCE,
  SPATIAL_USE, TAXONOMIC_GROUP, normalizeOccurrence, taxonomicGroup,
} from '../src/occurrence/model.js';
import { occurrenceEvidenceKind, recencyWindowFor, summarizeOccurrences, taxaForLens } from '../src/occurrence/summary.js';
import {
  INATURALIST_QUERY, inaturalistQueryParams, normalizeInaturalistRecord, privacyDecision,
} from '../src/occurrence/inaturalist.js';
import { EBIRD_ENDPOINT, EBIRD_RECENT_LIMIT_DAYS, ebirdQueryParams, normalizeEbirdRecord, searchDisk } from '../src/occurrence/ebird.js';
import { createOccurrenceService, searchRegion } from '../src/occurrence/service.js';
import { OCCURRENCE_EVIDENCE_KIND, combineOccurrenceCoverage, summarizeOccurrences as summarizeEvidence } from '../src/occurrence/context.js';
import { createOccurrenceQueries } from '../src/gis/occurrence-query.js';

const inatFixture = JSON.parse(readFileSync(new URL('./fixtures/inaturalist-observations.json', import.meta.url)));
const ebirdFixture = JSON.parse(readFileSync(new URL('./fixtures/ebird-recent-observations.json', import.meta.url)));
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0); // fixed clock: 2026-09-25T12:00:00Z
const CORRIDOR = { type: 'MultiLineString', coordinates: [[[-123.0455, 45.5308], [-123.035, 45.573]]] };

const fixtureRecord = id => inatFixture.records.find(record => record.id === id);
const constructed = name => inatFixture.constructedCases.records.find(record => record.uuid === name);
function normalizeFixture(record) { return normalizeInaturalistRecord(record, { retrievedAt: '2026-09-25T12:00:00.000Z' }); }

test('iNaturalist open observations normalize with precision, taxonomy, and provenance', () => {
  const precise = inatFixture.records.find(record => record.geojson && record.positional_accuracy != null && record.positional_accuracy <= CORRIDOR_ACCURACY_LIMIT_M && !record.obscured);
  const record = normalizeFixture(precise);
  assert.equal(record.source, OCCURRENCE_SOURCE.INATURALIST);
  assert.equal(record.sourceRecordId, String(precise.id));
  assert.equal(record.locationPrecision, LOCATION_PRECISION.PRECISE);
  assert.equal(record.spatialUse, SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED);
  assert.deepEqual(record.location, [precise.geojson.coordinates[0], precise.geojson.coordinates[1]]);
  assert.equal(record.positionalAccuracyM, precise.positional_accuracy);
  assert.equal(record.scientificName, precise.taxon.name);
  assert.equal(record.commonName, precise.taxon.preferred_common_name);
  assert.ok(Object.values(TAXONOMIC_GROUP).includes(record.taxonomicGroup));
  assert.equal(record.observedAt, precise.time_observed_at);
  assert.equal(record.quality, precise.quality_grade);
  assert.equal(record.sourceUrl, precise.uri);
  assert.equal(record.provenance.source, OCCURRENCE_SOURCE.INATURALIST);
  assert.equal(record.provenance.retrievedAt, '2026-09-25T12:00:00.000Z');
  assert.equal(Object.isFrozen(record), true);
  assert.equal(taxonomicGroup('Aves'), TAXONOMIC_GROUP.BIRDS);
  assert.equal(taxonomicGroup('Arachnida'), TAXONOMIC_GROUP.ARACHNIDS);
  assert.equal(taxonomicGroup(null), TAXONOMIC_GROUP.OTHER);
});

test('obscured iNaturalist records never keep a usable location or distance', () => {
  const obscured = inatFixture.records.filter(record => record.obscured || record.geoprivacy === 'obscured' || record.taxon_geoprivacy === 'obscured');
  assert.ok(obscured.length >= 2, 'fixture must include obscured records');
  for (const raw of obscured) {
    const record = normalizeFixture(raw);
    assert.equal(record.locationPrecision, LOCATION_PRECISION.OBSCURED);
    assert.equal(record.spatialUse, SPATIAL_USE.REGIONAL_ONLY);
    assert.equal(record.location, null, 'the published randomized point must not be stored');
    assert.equal(record.distanceToCorridorM, null);
    assert.match(record.spatialExclusionReason, /obscur/i);
    // No field on the normalized record may carry the randomized public coordinate.
    const serialized = JSON.stringify(record);
    const [publicLon, publicLat] = raw.geojson.coordinates;
    assert.equal(serialized.includes(String(publicLon)), false, 'public obscured longitude must not survive normalization');
    assert.equal(serialized.includes(String(publicLat)), false, 'public obscured latitude must not survive normalization');
  }
  // Taxa-level and user-level obscuring are both covered by the fixture.
  assert.ok(obscured.some(record => record.taxon_geoprivacy === 'obscured'));
  assert.ok(obscured.some(record => record.geoprivacy === 'obscured'));
});

test('poor-accuracy, missing-accuracy, and unlocated records stay regional evidence', () => {
  const poor = inatFixture.records.find(record => !record.obscured && record.positional_accuracy != null && record.positional_accuracy > CORRIDOR_ACCURACY_LIMIT_M);
  const poorRecord = normalizeFixture(poor);
  assert.equal(poorRecord.locationPrecision, LOCATION_PRECISION.APPROXIMATE);
  assert.equal(poorRecord.spatialUse, SPATIAL_USE.REGIONAL_ONLY);
  assert.equal(poorRecord.location, null);
  assert.match(poorRecord.spatialExclusionReason, /coarser than/);

  const noAccuracy = inatFixture.records.find(record => !record.obscured && record.positional_accuracy == null);
  const noAccuracyRecord = normalizeFixture(noAccuracy);
  assert.equal(noAccuracyRecord.locationPrecision, LOCATION_PRECISION.APPROXIMATE);
  assert.equal(noAccuracyRecord.spatialUse, SPATIAL_USE.REGIONAL_ONLY);
  assert.match(noAccuracyRecord.spatialExclusionReason, /no positional accuracy/);

  const unlocated = normalizeFixture(constructed('constructed-no-public-location'));
  assert.equal(unlocated.locationPrecision, LOCATION_PRECISION.UNAVAILABLE);
  assert.equal(unlocated.spatialUse, SPATIAL_USE.NOT_SPATIALLY_USABLE);
  assert.equal(unlocated.location, null);
  assert.match(unlocated.spatialExclusionReason, /no public coordinates/);

  // A private geoprivacy record is treated as obscured: the source withholds the position.
  const private_ = normalizeFixture(constructed('constructed-private-geoprivacy'));
  assert.equal(private_.locationPrecision, LOCATION_PRECISION.OBSCURED);
  assert.equal(private_.spatialUse, SPATIAL_USE.REGIONAL_ONLY);
  assert.equal(private_.location, null);

  // Boundary: exactly at the limit is usable, one metre more is not.
  assert.equal(normalizeFixture(constructed('constructed-accuracy-at-limit')).spatialUse, SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED);
  assert.equal(normalizeFixture(constructed('constructed-accuracy-over-limit')).spatialUse, SPATIAL_USE.REGIONAL_ONLY);
});

test('privacy decisions are explicit and a distance can never be attached to a non-precise record', () => {
  assert.equal(privacyDecision({ obscured: true, coordinates: [-122, 45], statedAccuracy: 5 }).spatialUse, SPATIAL_USE.REGIONAL_ONLY);
  assert.equal(privacyDecision({ obscured: false, coordinates: null, statedAccuracy: 5 }).spatialUse, SPATIAL_USE.NOT_SPATIALLY_USABLE);
  assert.equal(privacyDecision({ obscured: false, coordinates: [-122, 45], statedAccuracy: null }).spatialUse, SPATIAL_USE.REGIONAL_ONLY);
  assert.equal(privacyDecision({ obscured: false, coordinates: [-122, 45], statedAccuracy: 4 }).spatialUse, SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED);
  // Attempting to smuggle a distance onto an obscured record fails closed.
  const smuggling = normalizeOccurrence({ source: OCCURRENCE_SOURCE.INATURALIST, sourceRecordId: 'x', scientificName: 'Aves sp',
    locationPrecision: LOCATION_PRECISION.OBSCURED, location: [-122, 45], distanceToCorridorM: 12 });
  assert.equal(smuggling.location, null);
  assert.equal(smuggling.distanceToCorridorM, null);
  assert.throws(() => normalizeOccurrence({ source: 'unknown-source', sourceRecordId: 'x', scientificName: 'Aves sp' }));
  assert.throws(() => normalizeOccurrence({ source: OCCURRENCE_SOURCE.EBIRD, sourceRecordId: 'x', scientificName: 'Aves sp', locationPrecision: 'guessed' }));
  assert.throws(() => normalizeOccurrence({ source: OCCURRENCE_SOURCE.EBIRD, sourceRecordId: 'x' }));
});

test('spatial summaries bucket precise observations and never measure regional evidence', () => {
  const records = [
    { ...normalizeOccurrence({ source: OCCURRENCE_SOURCE.INATURALIST, sourceRecordId: 'a', scientificName: 'Aves a', commonName: 'A', taxonomicGroup: TAXONOMIC_GROUP.BIRDS,
      locationPrecision: LOCATION_PRECISION.PRECISE, location: [-123.04, 45.55], observedAt: '2026-09-20T10:00:00Z', distanceToCorridorM: 120 }), distanceToCorridorM: 120 },
    { ...normalizeOccurrence({ source: OCCURRENCE_SOURCE.INATURALIST, sourceRecordId: 'b', scientificName: 'Aves a', commonName: 'A', taxonomicGroup: TAXONOMIC_GROUP.BIRDS,
      locationPrecision: LOCATION_PRECISION.PRECISE, location: [-123.05, 45.56], observedAt: '2026-08-01T10:00:00Z', distanceToCorridorM: 2600 }), distanceToCorridorM: 2600 },
    { ...normalizeOccurrence({ source: OCCURRENCE_SOURCE.INATURALIST, sourceRecordId: 'c', scientificName: 'Mammalia c', commonName: 'C', taxonomicGroup: TAXONOMIC_GROUP.MAMMALS,
      locationPrecision: LOCATION_PRECISION.PRECISE, location: [-123.06, 45.57], observedAt: '2026-07-01T10:00:00Z', distanceToCorridorM: 8400 }), distanceToCorridorM: 8400 },
    normalizeOccurrence({ source: OCCURRENCE_SOURCE.INATURALIST, sourceRecordId: 'd', scientificName: 'Reptilia d', commonName: 'D', taxonomicGroup: TAXONOMIC_GROUP.REPTILES,
      locationPrecision: LOCATION_PRECISION.OBSCURED, observedAt: '2026-09-24T10:00:00Z' }),
  ];
  const summary = summarizeOccurrences(records, { now: NOW });
  assert.deepEqual(Object.keys(summary.buckets), ['1000', '5000', '10000']);
  assert.equal(summary.buckets[1000].observations, 1);
  assert.equal(summary.buckets[5000].observations, 2);
  assert.equal(summary.buckets[10000].observations, 3);
  assert.equal(summary.buckets[1000].nearestM, 120);
  assert.equal(summary.buckets[1000].uniqueTaxa, 1);
  assert.equal(summary.observations, 4);
  assert.equal(summary.preciseObservations, 3);
  assert.equal(summary.regionalOnlyObservations, 1);
  assert.equal(summary.uniqueTaxa, 3);
  assert.equal(summary.nearestM, 120);
  assert.equal(summary.latestObservedAt, '2026-09-24T10:00:00Z');
  // Repeated observations are counted as observations, never as individuals.
  const birds = summary.taxa.find(taxon => taxon.scientificName === 'Aves a');
  assert.equal(birds.observations, 2);
  assert.deepEqual([...birds.evidence], [EVIDENCE_KIND.LOCAL, EVIDENCE_KIND.RECENT]);
  assert.equal(birds.nearestM, 120);
  const reptile = summary.taxa.find(taxon => taxon.taxonomicGroup === TAXONOMIC_GROUP.REPTILES);
  assert.equal(reptile.regionalOnly, true);
  assert.equal(reptile.nearestM, null);
});

test('temporal windows are fixed-clock, exclusive buckets', () => {
  assert.equal(recencyWindowFor('2026-09-01T00:00:00Z', NOW), 'd30');
  assert.equal(recencyWindowFor('2026-07-15T00:00:00Z', NOW), 'd90');
  assert.equal(recencyWindowFor('2026-01-15T00:00:00Z', NOW), 'd365');
  assert.equal(recencyWindowFor('2024-01-15T00:00:00Z', NOW), 'historical');
  assert.equal(recencyWindowFor(null, NOW), 'unknown');
  const records = ['2026-09-20T00:00:00Z', '2026-08-20T00:00:00Z', '2026-05-20T00:00:00Z', '2020-05-20T00:00:00Z'].map((observedAt, index) => normalizeOccurrence({
    source: OCCURRENCE_SOURCE.EBIRD, sourceRecordId: `t${index}`, scientificName: 'Aves t', taxonomicGroup: TAXONOMIC_GROUP.BIRDS,
    locationPrecision: LOCATION_PRECISION.PRECISE, location: [-123.05, 45.55], observedAt,
  }));
  const summary = summarizeOccurrences(records, { now: NOW });
  assert.equal(summary.recency.d30.observations, 1);
  assert.equal(summary.recency.d90.observations, 1);
  assert.equal(summary.recency.d365.observations, 1);
  assert.equal(summary.recency.historical.observations, 1);
  assert.equal(Object.values(summary.recency).reduce((total, entry) => total + entry.observations, 0), records.length);
  // A record inside the smallest radius is LOCAL evidence; older precise records stay HISTORICAL.
  assert.equal(occurrenceEvidenceKind({ distanceToCorridorM: 400, observedAt: '2020-01-01T00:00:00Z', spatialUse: SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED }, { now: NOW }), EVIDENCE_KIND.LOCAL);
  assert.equal(occurrenceEvidenceKind({ distanceToCorridorM: 4000, observedAt: '2026-09-01T00:00:00Z', spatialUse: SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED }, { now: NOW }), EVIDENCE_KIND.RECENT);
  assert.equal(occurrenceEvidenceKind({ distanceToCorridorM: null, observedAt: '2020-01-01T00:00:00Z', spatialUse: SPATIAL_USE.REGIONAL_ONLY }, { now: NOW }), EVIDENCE_KIND.HISTORICAL);
});

test('taxonomic lenses group normalized groups without reinterpreting source taxonomy', () => {
  const records = [
    normalizeOccurrence({ source: OCCURRENCE_SOURCE.INATURALIST, sourceRecordId: 'b1', scientificName: 'Aves b', sourceTaxonGroup: 'Aves', locationPrecision: LOCATION_PRECISION.PRECISE, location: [-123.05, 45.55], observedAt: '2026-09-20T00:00:00Z' }),
    normalizeOccurrence({ source: OCCURRENCE_SOURCE.INATURALIST, sourceRecordId: 'r1', scientificName: 'Reptilia r', sourceTaxonGroup: 'Reptilia', locationPrecision: LOCATION_PRECISION.PRECISE, location: [-123.05, 45.55], observedAt: '2026-09-20T00:00:00Z' }),
    normalizeOccurrence({ source: OCCURRENCE_SOURCE.EBIRD, sourceRecordId: 'b2', scientificName: 'Aves b', commonName: 'B', taxonomicGroup: TAXONOMIC_GROUP.BIRDS, locationPrecision: LOCATION_PRECISION.PRECISE, location: [-123.05, 45.55], observedAt: '2026-09-19T00:00:00Z' }),
  ];
  const summary = summarizeOccurrences(records, { now: NOW });
  assert.equal(taxaForLens(summary.taxa, 'all').length, 2);
  assert.equal(taxaForLens(summary.taxa, 'birds').length, 1);
  assert.equal(taxaForLens(summary.taxa, 'herps').length, 1);
  assert.equal(taxaForLens(summary.taxa, 'insects').length, 0);
  assert.equal(taxaForLens(summary.taxa, 'unknown-lens').length, 2);
  const bird = taxaForLens(summary.taxa, 'birds')[0];
  assert.deepEqual([...bird.sources], ['ebird', 'inaturalist']);
  assert.equal(bird.observations, 2);
  assert.equal(bird.taxonomicGroup, TAXONOMIC_GROUP.BIRDS);
  const groups = summary.groups.map(entry => entry.group);
  assert.deepEqual(groups, [TAXONOMIC_GROUP.BIRDS, TAXONOMIC_GROUP.REPTILES]);
});

test('the iNaturalist query is bounded, ordered, and credential-free', () => {
  const region = searchRegion([-123.0455, 45.5308, -123.035, 45.573], 1000);
  assert.ok(region.swlat < 45.5308 && region.nelat > 45.573, 'the search region must extend beyond the corridor bounds');
  assert.ok(region.swlng < -123.0455 && region.nelng > -123.035);
  const params = inaturalistQueryParams({ region, qualityGrade: INATURALIST_QUERY.qualityGrade, perPage: INATURALIST_QUERY.maxRecordsPerRegion, page: 1 });
  assert.equal(params.get('quality_grade'), 'research');
  assert.equal(params.get('geo'), 'true');
  assert.equal(params.get('order_by'), 'observed_on');
  assert.equal(params.get('order'), 'desc');
  assert.equal(params.get('per_page'), String(INATURALIST_QUERY.maxRecordsPerRegion));
  assert.ok(params.get('fields').includes('taxon.preferred_common_name'));
  // No credential, key, or token may appear in an iNaturalist request.
  for (const key of ['token', 'api_key', 'apikey', 'key', 'authorization']) assert.equal(params.has(key), false);
  const countParams = inaturalistQueryParams({ region, qualityGrade: 'research', perPage: 0 });
  assert.equal(countParams.get('per_page'), '0');
  assert.equal(countParams.has('fields'), false);
});

test('the eBird boundary needs no credential to stay honest, and the disk covers the corridor', () => {
  const bounds = [-123.0455, 45.5308, -123.035, 45.573];
  const geometry = corridorGeometry({ type: 'MultiLineString', coordinates: [[[bounds[0], bounds[1]], [bounds[2], bounds[3]]]] });
  const disk = searchDisk({ bounds: geometry.bounds, lengthM: geometry.lengthM, radiusM: 10000 });
  assert.ok(disk.distKm >= Math.ceil((geometry.lengthM / 2 + 10000) / 1000));
  assert.ok(disk.distKm <= 50, 'eBird caps the radius at 50 km');
  const params = ebirdQueryParams({ disk, daysBack: 30, maxResults: 200 });
  assert.equal(params.get('back'), '30');
  assert.ok(Number(params.get('back')) <= EBIRD_RECENT_LIMIT_DAYS);
  assert.equal(params.get('maxResults'), '200');
  assert.equal(params.get('sort'), 'obs_dt');
  assert.equal(EBIRD_ENDPOINT, 'https://api.ebird.org/v2/data/obs/geo/recent');
  for (const key of ['key', 'token', 'apiKey']) assert.equal(params.has(key), false);
  const oversized = ebirdQueryParams({ disk, daysBack: 400, maxResults: 200 });
  assert.equal(oversized.get('back'), String(EBIRD_RECENT_LIMIT_DAYS), 'a request beyond the API window is clamped');
});

test('eBird records normalize into the same model and never invent a count', () => {
  assert.ok(ebirdFixture.records.length >= 6);
  const records = ebirdFixture.records.map(raw => normalizeEbirdRecord(raw, { retrievedAt: '2026-09-25T12:00:00.000Z' }));
  const first = records.find(record => record.sourceMetadata.speciesCode === 'rewblu1');
  assert.equal(first.source, OCCURRENCE_SOURCE.EBIRD);
  assert.equal(first.taxonomicGroup, TAXONOMIC_GROUP.BIRDS);
  assert.equal(first.scientificName, 'Agelaius phoeniceus');
  assert.equal(first.commonName, 'Red-winged Blackbird');
  assert.equal(first.count, 12);
  assert.equal(first.observedAt, '2026-09-24T07:15:00');
  assert.equal(first.quality, 'reviewed');
  assert.equal(first.placeGuess, 'Jackson Bottom Wetlands Preserve');
  assert.equal(first.sourceMetadata.locationId, 'L99381');
  // Missing counts are UNKNOWN, never zero.
  const unknownCount = records.find(record => record.sourceMetadata.speciesCode === 'mallar3');
  assert.equal(unknownCount.count, null);
  assert.equal(unknownCount.sourceMetadata.countUnknown, true);
  // Private checklist locations stay regional evidence.
  const privateRecords = records.filter(record => record.sourceMetadata.locationPrivate);
  assert.equal(privateRecords.length, 2);
  for (const record of privateRecords) {
    assert.equal(record.locationPrecision, LOCATION_PRECISION.REGIONAL);
    assert.equal(record.spatialUse, SPATIAL_USE.REGIONAL_ONLY);
    assert.equal(record.location, null);
  }
  // Species codes are distinct from iNaturalist taxon ids, so the two sources never collide.
  const ids = new Set(records.map(record => `${record.source}:${record.sourceRecordId}`));
  assert.equal(ids.size, records.length);
  const exotic = records.find(record => record.sourceMetadata.exoticCategory === 'Established');
  assert.equal(exotic.captive, 'Established');
});

// Deterministic stand-in for api.inaturalist.org: the count endpoints return the requested totals and
// the two record pages return overlapping-but-distinct slices of the captured fixture, as the real
// nested search regions do.
const SMALL_REGION_SWLAT = String(searchRegion([-123.0455, 45.5308, -123.035, 45.573], 1000).swlat);
function inaturalistTransportFromFixture({ records = inatFixture.records, regionTotal = 5000, smallRegionTotal = 500, temporalTotal = 100, fail = null } = {}) {
  const calls = [];
  const transport = async url => {
    calls.push(url);
    if (fail) return { ok: false, status: fail.status ?? 503, json: async () => ({ error: fail.message ?? 'boom' }) };
    const params = new URL(url).searchParams;
    const perPage = Number(params.get('per_page'));
    if (perPage === 0) {
      const total = params.get('d1') ? temporalTotal : params.get('swlat') === SMALL_REGION_SWLAT ? smallRegionTotal : regionTotal;
      return { ok: true, status: 200, json: async () => ({ total_results: total, results: [] }), url };
    }
    const slice = params.get('swlat') === SMALL_REGION_SWLAT ? records.slice(0, 8) : records;
    const total = params.get('swlat') === SMALL_REGION_SWLAT ? smallRegionTotal : regionTotal;
    return { ok: true, status: 200, json: async () => ({ total_results: total, page: 1, per_page: perPage, results: slice }), url };
  };
  transport.calls = calls;
  return transport;
}

function ebirdTransportFromFixture({ records = ebirdFixture.records, fail = null } = {}) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, headers: options?.headers ?? null });
    if (fail) throw new Error(fail);
    return records;
  };
  transport.calls = calls;
  return transport;
}

// Deterministic stand-in for the DuckDB measurement engine: it records what it was asked to measure
// and returns a fixed distance per point, so the pipeline can be tested without geometry.
function fakeMeasure(resolve = null) {
  const seen = [];
  const distanceFor = typeof resolve === 'function' ? resolve : (point, index) => 200 + index * 100;
  const measure = async (corridor, points) => {
    seen.push(...points);
    const map = new Map(points.map((point, index) => [point.id, distanceFor(point, index)]));
    return { distances: map, measured: points.length, skipped: 0, crs: 'EPSG:5070' };
  };
  measure.seen = seen;
  return measure;
}

test('a successful complete iNaturalist query is FULL, including a genuine zero', async () => {
  const transport = inaturalistTransportFromFixture({ regionTotals: {}, temporalTotals: {}, records: [] });
  transport.calls.length = 0;
  const service = createOccurrenceService({ inaturalistTransport: async url => {
    const params = new URL(url).searchParams;
    return { ok: true, status: 200, json: async () => (Number(params.get('per_page')) === 0
      ? { total_results: 0, results: [] }
      : { total_results: 0, results: [] }), url };
  }, measureDistances: fakeMeasure(), now: () => NOW });
  const result = await service.inaturalistSummary(CORRIDOR, { radiiM: OCCURRENCE_RADII_M });
  assert.equal(result.coverage, COVERAGE.FULL);
  assert.equal(result.observations, 0);
  assert.equal(result.uniqueTaxa, 0);
  assert.equal(result.searchRegions.every(region => region.sourceReportedTotal === 0), true);
  assert.equal(result.note, null);
  assert.equal(result.retrieval.truncated, false);
});

test('a capped iNaturalist retrieval is PARTIAL with the truncation explained', async () => {
  const transport = inaturalistTransportFromFixture({ regionTotals: {}, temporalTotals: {} });
  const measure = fakeMeasure();
  const service = createOccurrenceService({ inaturalistTransport: transport, measureDistances: measure, now: () => NOW });
  const result = await service.inaturalistSummary(CORRIDOR, { radiiM: OCCURRENCE_RADII_M });
  assert.equal(result.coverage, COVERAGE.PARTIAL);
  assert.match(result.note, /retrieval budget/);
  assert.match(result.note, new RegExp(String(INATURALIST_QUERY.maxRecordsPerRegion)));
  assert.equal(result.retrieval.truncated, true);
  assert.equal(result.searchRegions[0].recordDetail, true);
  assert.equal(result.searchRegions.at(-1).recordDetail, false);
  assert.equal(result.provenance.truncation.truncated, true);
  assert.equal(result.provenance.authentication, 'none (public read)');
});

test('an iNaturalist failure is UNKNOWN with a reason, never a zero', async () => {
  const service = createOccurrenceService({ inaturalistTransport: inaturalistTransportFromFixture({ fail: { status: 503, message: 'unavailable' } }), measureDistances: fakeMeasure(), now: () => NOW });
  const result = await service.inaturalistSummary(CORRIDOR, { radiiM: OCCURRENCE_RADII_M });
  assert.equal(result.coverage, COVERAGE.UNKNOWN);
  assert.match(result.reason, /HTTP 503/);
  assert.deepEqual(result.records, []);
  assert.equal(result.diagnostics.status, 'unavailable');
  assert.match(result.note, /not evidence that no species were reported/);
});

test('a missing eBird credential is UNKNOWN with a credential reason, never zero', async () => {
  const service = createOccurrenceService({ inaturalistTransport: null, ebirdTransport: null, now: () => NOW });
  const result = await service.ebirdSummary(CORRIDOR, { radiiM: OCCURRENCE_RADII_M });
  assert.equal(result.coverage, COVERAGE.UNKNOWN);
  assert.equal(result.credentialRequired, true);
  assert.match(result.reason, /personal API key/);
  assert.deepEqual(result.records, []);
  assert.equal(result.observations, 0);
  assert.match(result.note, /not evidence that no species were reported/);
  // The aggregate occurrence coverage derives from source states and never becomes zero by default.
  const evidence = summarizeEvidence({ analysisRadiiM: OCCURRENCE_RADII_M, sources: { inaturalist: result, ebird: result } });
  assert.equal(evidence.coverage[COVERAGE_DATASET.OCCURRENCE_INATURALIST], COVERAGE.UNKNOWN);
  assert.equal(evidence.coverage[COVERAGE_DATASET.OCCURRENCE_EBIRD], COVERAGE.UNKNOWN);
  assert.equal(evidence.coverage[COVERAGE_DATASET.OCCURRENCE], COVERAGE.UNKNOWN);
  assert.equal(combineOccurrenceCoverage([COVERAGE.UNKNOWN, COVERAGE.UNKNOWN]), COVERAGE.UNKNOWN);
  assert.equal(combineOccurrenceCoverage([COVERAGE.FULL, COVERAGE.UNKNOWN]), COVERAGE.PARTIAL);
  assert.equal(combineOccurrenceCoverage([COVERAGE.FULL, COVERAGE.FULL]), COVERAGE.FULL);
  assert.equal(combineOccurrenceCoverage([COVERAGE.PARTIAL, COVERAGE.FULL]), COVERAGE.PARTIAL);
});

test('the eBird adapter stays credential-safe and reports what it received', async () => {
  const transport = ebirdTransportFromFixture();
  const measure = fakeMeasure();
  const service = createOccurrenceService({ ebirdTransport: transport, measureDistances: measure, now: () => NOW });
  const result = await service.ebirdSummary(CORRIDOR, { radiiM: OCCURRENCE_RADII_M });
  assert.equal(result.coverage, COVERAGE.FULL);
  assert.equal(result.observations, ebirdFixture.records.length);
  assert.equal(result.observations, 8);
  assert.equal(result.uniqueTaxa, 7, 'two Anna’s Hummingbird reports are one taxon, not one individual');
  assert.equal(result.windowDays, 30);
  assert.match(result.windowLabel, /Last 30 days/);
  assert.match(result.provenance.productScope, /recent observations only/);
  assert.equal(result.provenance.authentication.includes('never sent to the browser'), true);
  assert.equal(transport.calls.length, 1);
  // The credential, if any, travels only in the request header and never in the URL.
  for (const call of transport.calls) {
    assert.equal(call.url.includes('key'), false);
    assert.equal(call.url.includes('token'), false);
    assert.equal(call.url.startsWith('https://api.ebird.org/v2/data/obs/geo/recent?'), true);
  }
  // Private eBird locations never reach the measurement engine.
  assert.equal(measure.seen.length, ebirdFixture.records.filter(record => record.locationPrivate !== true).length);
});

test('the pipeline runs corridor -> adapter -> privacy -> spatial summary -> evidence', async () => {
  const measure = fakeMeasure(() => 200); // every eligible point lands inside the smallest radius
  const service = createOccurrenceService({
    inaturalistTransport: inaturalistTransportFromFixture(), ebirdTransport: ebirdTransportFromFixture(), measureDistances: measure, now: () => NOW,
  });
  const result = await service.analyze(CORRIDOR, { radiiM: OCCURRENCE_RADII_M });
  assert.deepEqual(result.analysisRadiiM, [...OCCURRENCE_RADII_M]);
  assert.equal(result.measuredCrs, 'EPSG:5070');
  const evidence = summarizeEvidence(result);
  assert.equal(evidence.kind, OCCURRENCE_EVIDENCE_KIND);
  assert.equal(evidence.kind, 'SPECIES_OCCURRENCE_EVIDENCE');
  assert.equal(evidence.coverage[COVERAGE_DATASET.OCCURRENCE_INATURALIST], COVERAGE.PARTIAL);
  assert.equal(evidence.coverage[COVERAGE_DATASET.OCCURRENCE_EBIRD], COVERAGE.FULL);
  assert.equal(evidence.coverage[COVERAGE_DATASET.OCCURRENCE], COVERAGE.PARTIAL);
  const inat = evidence.sources.inaturalist;
  assert.equal(inat.source, OCCURRENCE_SOURCE.INATURALIST);
  assert.ok(inat.observations > 0);
  // Only records with a usable precise location were measured; every distance is finite.
  const rawRecords = result.sources.inaturalist.records;
  const measuredRecords = rawRecords.filter(record => record.distanceToCorridorM != null);
  assert.ok(measuredRecords.length > 0);
  assert.ok(measuredRecords.every(record => record.spatialUse === SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED));
  // Obscured fixture records are present but never measured or bucketed as local evidence.
  const obscured = rawRecords.filter(record => record.locationPrecision === LOCATION_PRECISION.OBSCURED);
  assert.ok(obscured.length >= 2);
  assert.ok(obscured.every(record => record.distanceToCorridorM == null));
  // The domain hands out coordinates only for precise public observations.
  assert.equal(inat.points.length, measuredRecords.length);
  assert.ok(inat.points.every(point => Array.isArray(point.location) && Number.isFinite(point.distanceToCorridorM)));
  assert.equal(obscured.some(record => record.location != null), false);
  // All precise records measured at 200 m land in the 1 km bucket; regional-only records do not.
  assert.equal(inat.buckets[1000].observations, measuredRecords.length);
  assert.equal(inat.buckets[10000].observations, measuredRecords.length);
  assert.equal(inat.nearestM, 200);
  assert.ok(inat.regionalOnlyObservations >= 2);
  assert.equal(evidence.sources.ebird.uniqueTaxa, 7);
  assert.ok(evidence.sources.ebird.taxa.every(taxon => taxon.taxonomicGroup === TAXONOMIC_GROUP.BIRDS));
  assert.match(evidence.provenance.privacyRule, /never "observed N m from this road"/);
  assert.equal(evidence.diagnostics.status, 'ready');
});

test('corridor distances are measured with the DuckDB Spatial engine in projected metres', async () => {
  const queries = [];
  const queriesApi = createOccurrenceQueries({ initialize: async () => ({ conn: { query: async sql => { queries.push(sql); return { toArray: () => [{ record_id: 'inaturalist:1', distance_m: 123.456 }, { record_id: 'ebird:S1', distance_m: 4200.0 }] }; } } }) });
  const result = await queriesApi.measureCorridorDistances(CORRIDOR, [
    { id: 'inaturalist:1', coordinates: [-123.04, 45.55] },
    { id: 'ebird:S1', coordinates: [-123.05, 45.56] },
    { id: 'bad id with spaces', coordinates: [-123.04, 45.55] },
    { id: 'inaturalist:2', coordinates: [Number.NaN, 45.55] },
  ]);
  assert.equal(queries.length, 1, 'one set-oriented measurement query');
  const sql = queries[0];
  assert.match(sql, /EPSG:5070/);
  assert.match(sql, /ST_Distance\(/);
  assert.match(sql, /ST_Transform\(ST_Point\(/);
  assert.match(sql, /MULTILINESTRING/);
  assert.equal(sql.includes('bad id'), false, 'unsafe identifiers are never interpolated into SQL');
  assert.equal(sql.includes('NaN'), false);
  assert.equal(result.measured, 2);
  assert.equal(result.skipped, 2);
  assert.equal(result.crs, 'EPSG:5070');
  assert.equal(result.distances.get('inaturalist:1'), 123.456);
  // Measurement is bounded: a huge point set is truncated rather than sent as one giant statement.
  const many = Array.from({ length: 900 }, (_, index) => ({ id: `inaturalist:${index}`, coordinates: [-123.04, 45.55] }));
  const capped = await queriesApi.measureCorridorDistances(CORRIDOR, many);
  assert.equal(capped.measured, 800);
  assert.equal(capped.skipped, 100);
});

test('cached results are reused within the freshness window and reported as cached', async () => {
  const transport = inaturalistTransportFromFixture();
  let clock = NOW;
  const service = createOccurrenceService({ inaturalistTransport: transport, measureDistances: fakeMeasure(), now: () => clock, clock: () => clock });
  const first = await service.inaturalistSummary(CORRIDOR, { radiiM: OCCURRENCE_RADII_M });
  const requestCount = transport.calls.length;
  assert.ok(requestCount > 0 && requestCount <= 10, `bounded request count, saw ${requestCount}`);
  clock += 60 * 1000;
  const second = await service.inaturalistSummary(CORRIDOR, { radiiM: OCCURRENCE_RADII_M });
  assert.equal(transport.calls.length, requestCount, 'a cached corridor query makes no new requests');
  assert.equal(second.diagnostics.cached, true);
  assert.equal(second.observations, first.observations);
  assert.equal(service.cache.size(), 1);
  // After the freshness window the request is repeated.
  clock += 16 * 60 * 1000;
  await service.inaturalistSummary(CORRIDOR, { radiiM: OCCURRENCE_RADII_M });
  assert.ok(transport.calls.length > requestCount);
});

test('one analyst-corridor analysis keeps its external request budget small', async () => {
  const transport = inaturalistTransportFromFixture();
  const service = createOccurrenceService({ inaturalistTransport: transport, ebirdTransport: ebirdTransportFromFixture(), measureDistances: fakeMeasure(), now: () => NOW });
  const result = await service.analyze(CORRIDOR, { radiiM: OCCURRENCE_RADII_M });
  // 3 region counts + 1 all-grades count + 3 temporal counts + 1 local-recent count + 2 record pages
  assert.equal(transport.calls.length, 10);
  assert.equal(result.diagnostics.requests.inaturalist, 10);
  assert.equal(result.diagnostics.requests.ebird, 1);
  assert.equal(result.sources.inaturalist.diagnostics.requests, 10);
  assert.equal(result.sources.ebird.diagnostics.requests, 1);
});
