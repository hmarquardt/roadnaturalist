import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCandidate } from '../src/domain/corridor.js';
import { createRoad, groupRoadFeatures } from '../src/roads/road.js';
import { OVERPASS_MIRRORS, OSM_ACCESS_SIGNAL, accessSignalOf, buildOsmBarrierQuery, buildOsmWayQuery, createOsmSource, createRecordedOsmSource, isRoadWay, normalizeOsmBarrier, normalizeOsmWay, overpassBbox } from '../src/investigator/osm.js';
import { ROAD_NAME_RELATION, matchOsmWaysToCorridor, normalizeRoadName, roadNameRelation, sampleLine } from '../src/investigator/osm-match.js';
import { osmSearchNames } from '../src/investigator/service.js';

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const way = (id, name, coordinates, tags = {}) => ({ type: 'way', id, tags: { highway: 'residential', name, ...tags },
  geometry: coordinates.map(([lon, lat]) => ({ lon, lat })) });

function corridorFrom(declarationIndex, roadIdFilter = null) {
  const snapshot = readJson('./fixtures/or-roads-pilot.snapshot.json');
  const declaration = readJson('../data/roads/or-roads-pilot.json');
  const groups = new Map(groupRoadFeatures(snapshot.roads.flatMap(road => road.features.map(feature => ({ ...feature, roadId: road.roadId, name: road.name,
    roadClass: road.roadClass, routeType: road.routeType, countyFips: road.countyFips, countyName: road.countyName })))).map(group => [group.roadId, group]));
  const entry = declaration.candidates[declarationIndex];
  const roads = entry.roadIds.filter(roadId => groups.has(roadId) && (!roadIdFilter || roadIdFilter.includes(roadId))).map(roadId => createRoad(groups.get(roadId)));
  return { candidate: createCandidate({ ...entry, roads }), roads };
}

// ---- access tag interpretation ------------------------------------------------------------------

test('an absent OSM access tag stays absent and is never read as public access', () => {
  const signal = accessSignalOf({ highway: 'secondary', name: 'Northwest Susbauer Road' });
  assert.equal(signal.signal, OSM_ACCESS_SIGNAL.ABSENT);
  assert.deepEqual(signal.keys, []);
  assert.match(signal.note, /not evidence of public access/);
});

test('explicit OSM access values are classified without interpretation', () => {
  assert.equal(accessSignalOf({ access: 'yes' }).signal, OSM_ACCESS_SIGNAL.EXPLICIT_PUBLIC);
  assert.equal(accessSignalOf({ access: 'private' }).signal, OSM_ACCESS_SIGNAL.EXPLICIT_RESTRICTED);
  assert.equal(accessSignalOf({ motor_vehicle: 'no' }).signal, OSM_ACCESS_SIGNAL.EXPLICIT_RESTRICTED);
  assert.equal(accessSignalOf({ access: 'permissive' }).signal, OSM_ACCESS_SIGNAL.EXPLICIT_PERMISSIVE);
  assert.equal(accessSignalOf({ access: 'destination' }).signal, OSM_ACCESS_SIGNAL.EXPLICIT_RESTRICTED);
  // A tag that is present but says nothing about access is reported as present with no public/private value.
  const undecided = accessSignalOf({ vehicle: 'yes' });
  assert.equal(undecided.signal, OSM_ACCESS_SIGNAL.EXPLICIT_PUBLIC);
  assert.equal(accessSignalOf({ bicycle: 'yes' }).signal, OSM_ACCESS_SIGNAL.ABSENT);
});

// ---- normalization --------------------------------------------------------------------------------

test('a normalized OSM way keeps verbatim tags, element identity, and provenance', () => {
  const normalized = normalizeOsmWay(way(123456, 'Northwest Susbauer Road', [[-123.04, 45.54], [-123.0399, 45.5401]],
    { highway: 'secondary', surface: 'asphalt', tracktype: 'grade1', operator: 'Washington County' }),
    { retrievedAt: '2026-09-25T23:54:00.000Z', mirror: 'overpass-api-de', query: '[out:json];', osmTimestamp: '2026-09-25T23:39:05Z' });
  assert.equal(normalized.osmId, '123456');
  assert.equal(normalized.url, 'https://www.openstreetmap.org/way/123456');
  assert.equal(normalized.highway, 'secondary');
  assert.equal(normalized.surface, 'asphalt');
  assert.equal(normalized.tracktype, 'grade1');
  assert.equal(normalized.operator, 'Washington County');
  assert.equal(normalized.tags.surface, 'asphalt');
  assert.equal(normalized.accessSignal.signal, OSM_ACCESS_SIGNAL.ABSENT);
  assert.equal(normalized.geometry.length, 2);
  assert.equal(normalized.provenance.retrievedAt, '2026-09-25T23:54:00.000Z');
  assert.equal(normalized.provenance.osmTimestamp, '2026-09-25T23:39:05Z');
  // Missing tags are absent fields, not inferred values.
  assert.equal(normalized.ownership, null);
  assert.equal(normalized.seasonal, null);
});

test('a mapped barrier keeps its access tag and never implies permission', () => {
  const barrier = normalizeOsmBarrier({ type: 'node', id: 999, lat: 45.54, lon: -123.04, tags: { barrier: 'gate', access: 'no', locked: 'yes' } }, { retrievedAt: '2026-09-25T23:54:00.000Z' });
  assert.equal(barrier.barrier, 'gate');
  assert.equal(barrier.access, 'no');
  assert.equal(barrier.locked, 'yes');
  assert.equal(barrier.url, 'https://www.openstreetmap.org/node/999');
});

test('non-road highway values are separated from roads', () => {
  assert.equal(isRoadWay({ highway: 'primary' }), true);
  assert.equal(isRoadWay({ highway: 'track' }), true);
  assert.equal(isRoadWay({ highway: 'footway' }), false);
  assert.equal(isRoadWay({ highway: 'cycleway' }), false);
  assert.equal(isRoadWay({}), false);
});

// ---- query construction --------------------------------------------------------------------------

test('Overpass queries convert GeoJSON bounds to the (south, west, north, east) order Overpass requires', () => {
  const bounds = [-123.0485, 45.5278, -123.0320, 45.5760];
  assert.equal(overpassBbox(bounds), '45.5278,-123.0485,45.5760,-123.0320');
  const query = buildOsmWayQuery({ bounds, names: ['NW Susbauer Rd', 'Northwest Susbauer Road'] });
  assert.match(query, /way\["highway"\]\["name"~"NW Susbauer Rd\|Northwest Susbauer Road",i\]\(45\.5278,-123\.0485,45\.5760,-123\.0320\)/);
  assert.match(buildOsmBarrierQuery({ bounds }), /node\["barrier"\]\(45\.5278,-123\.0485,45\.5760,-123\.0320\)/);
});

test('search names cover the spellings a different source may use', () => {
  assert.deepEqual(osmSearchNames('NW Susbauer Rd'), ['NW Susbauer Rd', 'Northwest Susbauer Road', 'Susbauer Road']);
  assert.deepEqual(osmSearchNames('NW Cornelius Pass Rd'), ['NW Cornelius Pass Rd', 'Northwest Cornelius Pass Road', 'Cornelius Pass Road']);
});

// ---- geometry matching ---------------------------------------------------------------------------

test('corridor sampling walks each line at the requested interval', () => {
  const samples = sampleLine([[[-123.04, 45.54], [-123.04, 45.56]]], { sampleIntervalM: 25 });
  assert.ok(samples.length > 80 && samples.length < 95);
  assert.deepEqual(samples[0], [-123.04, 45.54]);
});

test('a way on the corridor matches, an offset way does not, and several ways can compose one corridor', () => {
  const corridor = { type: 'LineString', coordinates: [[-123.04, 45.54], [-123.04, 45.56]] };
  const onLine = normalizeOsmWay(way(1, 'Susbauer Road', [[-123.04, 45.5395], [-123.04, 45.5605]]));
  const offset = normalizeOsmWay(way(2, 'Susbauer Road', [[-123.0408, 45.54], [-123.0408, 45.56]]));
  const far = normalizeOsmWay(way(3, 'Far Road', [[-123.06, 45.54], [-123.06, 45.56]]));
  const match = matchOsmWaysToCorridor(corridor, [onLine, offset, far], { sampleIntervalM: 25, toleranceM: 30 });
  assert.equal(match.matchedWayCount, 1);
  assert.equal(match.geometryVerified, true);
  assert.equal(match.matchedFraction, 1);
  assert.ok(match.ways[0].nearestM < 1);
  const halves = [normalizeOsmWay(way(4, 'Susbauer Road', [[-123.04, 45.54], [-123.04, 45.55]])), normalizeOsmWay(way(5, 'Susbauer Road', [[-123.04, 45.55], [-123.04, 45.56]]))];
  const composed = matchOsmWaysToCorridor(corridor, halves, { sampleIntervalM: 25, toleranceM: 30 });
  assert.equal(composed.matchedWayCount, 2);
  assert.equal(composed.geometryVerified, true);
});

test('an unmatched section of the corridor is reported instead of being bridged', () => {
  const corridor = { type: 'LineString', coordinates: [[-123.04, 45.54], [-123.04, 45.56]] };
  const partial = [normalizeOsmWay(way(6, 'Susbauer Road', [[-123.04, 45.54], [-123.04, 45.55]]))];
  const match = matchOsmWaysToCorridor(corridor, partial, { sampleIntervalM: 25, toleranceM: 30 });
  assert.ok(match.matchedFraction > 0.4 && match.matchedFraction < 0.6);
  assert.equal(match.geometryVerified, false);
  assert.ok(match.unmatchedLengthM > 900 && match.unmatchedLengthM < 1200);
  assert.match(match.method, /local equirectangular frame/);
});

test('tolerance is a threshold, not a soft preference', () => {
  const corridor = { type: 'LineString', coordinates: [[-123.04, 45.54], [-123.04, 45.55]] };
  const at20 = [normalizeOsmWay(way(7, 'Susbauer Road', [[-123.0402, 45.54], [-123.0402, 45.55]]))];
  assert.equal(matchOsmWaysToCorridor(corridor, at20, { toleranceM: 30 }).matchedWayCount, 1);
  assert.equal(matchOsmWaysToCorridor(corridor, at20, { toleranceM: 10 }).matchedWayCount, 0);
});

test('no candidate ways yields zero matches rather than an error or an inference', () => {
  const corridor = { type: 'LineString', coordinates: [[-123.04, 45.54], [-123.04, 45.55]] };
  const match = matchOsmWaysToCorridor(corridor, []);
  assert.equal(match.matchedWayCount, 0);
  assert.equal(match.matchedFraction, 0);
  assert.equal(match.geometryVerified, false);
});

test('road name comparison distinguishes spelling, quadrant, and a different road', () => {
  assert.equal(roadNameRelation('NW Cornelius Pass Rd', 'Northwest Cornelius Pass Road'), ROAD_NAME_RELATION.SAME);
  assert.equal(roadNameRelation('NW Cornelius Pass Rd', 'Northeast Cornelius Pass Road'), ROAD_NAME_RELATION.DIRECTION_VARIANT);
  assert.equal(roadNameRelation('NW Cornelius Pass Rd', 'Northwest Old Cornelius Pass Road'), ROAD_NAME_RELATION.CORE_VARIANT);
  assert.equal(roadNameRelation('NW Springville Rd', 'NW Skyline Boulevard'), ROAD_NAME_RELATION.DIFFERENT);
  assert.deepEqual({ ...normalizeRoadName('NW Cornelius Pass Rd') }, { tokens: ['nw', 'cornelius', 'pass', 'rd'], direction: 'nw', core: 'cornelius pass', coreTokens: ['cornelius', 'pass'] });
});

// ---- adapter behaviour ---------------------------------------------------------------------------

function stubTransport(handler) { return async (url, options) => handler(url, options); }

const okBody = { osm3s: { timestamp_osm_base: '2026-09-25T23:39:05Z' }, elements: [way(42, 'Susbauer Road', [[-123.04, 45.54], [-123.04, 45.56]], { highway: 'secondary' })] };

test('the adapter uses the first mirror that answers and records which one it was', async () => {
  const tried = [];
  const source = createOsmSource({ transport: stubTransport(async url => { tried.push(url); if (url.includes('overpass-api.de')) throw new Error('Overpass HTTP 406'); return okBody; }), budget: { maxRequests: 10, minSpacingMs: 0, timeoutMs: 1000, queryTimeoutS: 10 } });
  const result = await source.queryCorridor({ bounds: [-123.0485, 45.5278, -123.0320, 45.5760], names: ['Susbauer Road'] });
  // A mirror that failed but was recovered by the next mirror is a diagnostic, not degraded coverage.
  assert.equal(result.status, 'OK');
  assert.equal(result.ways.length, 1);
  assert.deepEqual(result.mirrorsUsed, ['osm-mail-ru', 'osm-mail-ru']);
  assert.equal(result.failures.length, 0);
  assert.equal(result.mirrorFailures.length, 2);
  assert.match(result.mirrorFailures[0].reason, /406/);
  assert.equal(result.mirrorFailures[0].mirror, 'overpass-api-de');
  assert.equal(tried.length, 4);
});

test('a mirror failure is a failure, never an empty OSM result', async () => {
  const source = createOsmSource({ transport: stubTransport(async () => { throw new Error('Overpass HTTP 429'); }), budget: { maxRequests: 10, minSpacingMs: 0, timeoutMs: 1000, queryTimeoutS: 10 } });
  const result = await source.queryCorridor({ bounds: [-123.0485, 45.5278, -123.0320, 45.5760], names: ['Susbauer Road'] });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.ways.length, 0);
  assert.equal(result.failures.length, OVERPASS_MIRRORS.length * 2);
  assert.ok(result.failures.every(failure => failure.reason === 'Overpass HTTP 429'));
  assert.deepEqual(source.failures().length, OVERPASS_MIRRORS.length * 2);
});

test('repeated queries for the same corridor are served from cache and spend no request budget', async () => {
  let calls = 0;
  const source = createOsmSource({ transport: stubTransport(async () => { calls += 1; return okBody; }), budget: { maxRequests: 10, minSpacingMs: 0, timeoutMs: 1000, queryTimeoutS: 10 } });
  const limit = { bounds: [-123.0485, 45.5278, -123.0320, 45.5760], names: ['Susbauer Road'] };
  await source.queryCorridor(limit);
  const afterFirst = source.requestCount();
  const second = await source.queryCorridor(limit);
  assert.equal(source.requestCount(), afterFirst);
  assert.equal(calls, 2);
  assert.equal(second.status, 'PARTIAL'.replace('PARTIAL', 'OK'));
});

test('the request budget is finite and reported when it is spent', async () => {
  const source = createOsmSource({ transport: stubTransport(async () => okBody), budget: { maxRequests: 1, minSpacingMs: 0, timeoutMs: 1000, queryTimeoutS: 10 } });
  const result = await source.queryCorridor({ bounds: [-123.0485, 45.5278, -123.0320, 45.5760], names: ['Susbauer Road'] });
  assert.ok(['PARTIAL', 'FAILED'].includes(result.status));
  assert.ok(source.failures().some(failure => /budget for this session is spent/.test(failure.reason)));
});

// ---- captured data (offline integration) --------------------------------------------------------

test('a real captured Overpass response normalizes and matches the real corridor geometry', () => {
  const response = readJson('./fixtures/investigator/overpass-cornelius-response.json');
  const { candidate } = corridorFrom(0);
  const ways = response.elements.map(element => normalizeOsmWay(element, { retrievedAt: '2026-09-25T23:54:00.000Z', mirror: 'overpass-api-de', osmTimestamp: response.osm3s.timestamp_osm_base }));
  assert.equal(ways.length, response.elements.length);
  assert.ok(ways.every(item => item.osmId && item.provenance.osmTimestamp === '2026-09-25T23:39:05Z'));
  assert.ok(ways.every(item => item.accessSignal.signal === OSM_ACCESS_SIGNAL.ABSENT));
  const match = matchOsmWaysToCorridor(candidate.geometry, ways);
  assert.equal(match.candidateWayCount, ways.length);
  assert.equal(match.matchedWayCount, ways.length);
  assert.ok(match.matchedFraction > 0.05);
  assert.equal(match.geometryVerified, false);
});

test('a recorded operator capture replays as recorded facts with its own timestamp', async () => {
  const record = { capturedAt: '2026-09-25T23:54:00.000Z', corridors: { c1: { osm: { status: 'OK', retrievedAt: '2026-09-25T23:54:00.000Z', osmTimestamp: '2026-09-25T23:39:05Z',
    mirrorsUsed: ['overpass-api-de'], searchNames: ['Susbauer Road'], searchBounds: [-123.0485, 45.5278, -123.0320, 45.5760], match: { matchedWayCount: 3, candidateWayCount: 4, toleranceM: 30, sampleIntervalM: 25, matchedFraction: 1 },
    nameVariants: [{ name: 'Northwest Susbauer Road', relation: 'SAME' }], queries: [], failures: [], waySummaries: [], evidence: [] } } } };
  const source = createRecordedOsmSource({ record, corridorId: 'c1' });
  const result = await source.queryCorridor({ bounds: [0, 0, 1, 1], names: ['x'] });
  assert.equal(result.status, 'OK');
  assert.equal(result.recorded.capturedAt, '2026-09-25T23:54:00.000Z');
  assert.equal(result.recorded.match.matchedWayCount, 3);
  assert.equal(result.ways.length, 0);
  const missing = await createRecordedOsmSource({ record, corridorId: 'unknown' }).queryCorridor({ bounds: [0, 0, 1, 1], names: ['x'] });
  assert.equal(missing.status, 'FAILED');
  assert.match(missing.failures[0].reason, /no OpenStreetMap context/);
});
