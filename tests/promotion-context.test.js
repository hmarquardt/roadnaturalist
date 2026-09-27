import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COVERAGE, COVERAGE_DATASET, createCandidate } from '../src/domain/corridor.js';
import { corridorContextFromCenter, contextDirection, formatContextDirection, pendingSearchContext, runCenterPresentation,
  searchContextLine, storedSearchContext, verifyPromotionSearchContext, CENTER_LABEL_KIND, SEARCH_CONTEXT_KIND } from '../src/discovery/search-context.js';
import { validatePlaceGazetteer } from '../src/discovery/place-gazetteer.js';
import { validateSearchAreas } from '../src/discovery/search-area.js';
import { buildDiscoveryResult } from '../src/discovery/signals.js';
import { buildDiscoveryUnits } from '../src/discovery/units.js';
import { segmentUnit } from '../src/discovery/segment.js';
import { promoteDiscoveryResult } from '../src/discovery/lifecycle.js';
import { verifyDerivedPromotion } from '../src/discovery/promotion.js';
import { minDistanceToLineM } from '../src/domain/geometry.js';
import { buildCorridorBundle, validateBundle } from '../src/investigator/bundle.js';

// SEARCH CONTEXT ON PROMOTION.
//
// A corridor promoted out of a radius search keeps the orientation it was chosen with. These tests hold the
// three promises that makes: the context is a snapshot of the *run* (not of whatever the controls say later), it
// is verified against the corridor the promotion actually publishes, and it is presentation only — a candidate
// without one (a pilot corridor, a promotion from a declared window) is exactly as valid.
const MI = 1609.344;
const LON_PER_M = 1 / (111320 * Math.cos(45.5 * Math.PI / 180));
const declaration = validateSearchAreas(JSON.parse(readFileSync(new URL('../data/discovery/search-areas.json', import.meta.url))),
  JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url))));
const gazetteer = validatePlaceGazetteer(JSON.parse(readFileSync(new URL('../data/places/or-sw-wa-portland-places.json', import.meta.url))),
  { region: declaration.publishedRegion });
const CENTER = [-122.9, 45.55];

function line(lengthM, { lon = -123, lat = 45.5, segments = 10 } = {}) {
  return Array.from({ length: segments + 1 }, (_, index) => [lon + lengthM * index / segments * LON_PER_M, lat]);
}

function feature(overrides = {}) {
  return { roadId: 'tiger-2025-or-41067-example-rd', name: 'NW Example Rd', roadClass: 'S1400', routeType: 'M',
    countyFips: '41067', countyName: 'Washington County, Oregon', sourceFeatureId: 'f1',
    geometry: { type: 'LineString', coordinates: line(3000) }, ...overrides };
}

// The smallest measured-signal block a real run always carries: a coverage state per buffer distance for each
// layer. A run without metrics cannot reach promotion, so the fixture mirrors what the batch analysis returns.
function metrics() {
  const states = Object.fromEntries([250, 500, 1000].map(distance =>
    [distance, { covered: true, corridorInside: false, coverage: COVERAGE.FULL }]));
  return {
    wetlands: { coverage: COVERAGE.FULL, reason: null, perDistance: states, coverageByDistance: states,
      buffers: { 250: { areaM2: 0, lengthM: 0, featureCount: 0, breakdown: [] } },
      classes: [], nearestDistanceM: 420, intersectsCorridor: false, corridorFeatureCount: 0 },
    hydrography: { coverage: COVERAGE.FULL, reason: null, perDistance: states, coverageByDistance: states,
      buffers: { 1000: { areaM2: 0, lengthM: 0, featureCount: 0, breakdown: [] } }, crossings: [],
      crossingCount: 0, nearestFlowingWaterM: 200, nearestStandingWaterM: null, corridorFlowlineCount: 0,
      types: [], names: [] },
    ecology: { coverage: COVERAGE.FULL, spansMultiple: false,
      level3: level('3', 'Willamette Valley'), level4: level('3a', 'Portland/Vancouver Basin') },
  };
}

function level(code, name) {
  return { coverage: COVERAGE.FULL, primary: { code, name, overlapM: 3000, percent: 100 },
    intersections: [{ code, name, overlapM: 3000, percent: 100 }] };
}

// One discovery result the way the run builds it: the corridor, its measured signals, and the centre context the
// radius search measured.
function discoveryResult({ corridor, unit, features, fromCenter }) {
  const built = unit ? { unit } : buildDiscoveryUnits(features ?? [feature()]);
  const resolvedUnit = unit ?? built.units[0];
  const resolvedCorridor = corridor ?? segmentUnit(resolvedUnit).corridors[0];
  return buildDiscoveryResult({ unit: resolvedUnit, corridor: resolvedCorridor, metrics: metrics(),
    roadState: COVERAGE.FULL, provenance: { datasetId: 'or-roads-network-pilot' }, analysisDistancesM: [250, 500, 1000],
    fromCenter: fromCenter === undefined ? corridorContextFromCenter(CENTER, resolvedCorridor.geometry) : fromCenter });
}

function examplePlace(name, state) {
  return gazetteer.places.find(place => place.name === name && place.state === state);
}

function contextFor(result, overrides = {}) {
  return pendingSearchContext({ center: CENTER, radiusMiles: 25, centerLabel: 'Near Vernonia, OR',
    centerLabelKind: CENTER_LABEL_KIND.NEAR_PLACE, placeId: examplePlace('Vernonia', 'OR').id,
    distanceFromCenterM: result.distanceFromCenterM, nearestCenterPoint: result.nearestCenterPoint,
    bearingFromCenterDeg: result.bearingFromCenterDeg, cardinalFromCenter: result.cardinalFromCenter, ...overrides });
}

// ------------------------------------------------------------------ the snapshot

test('a promotion context snapshots the run: centre, label, radius, and the measured relationship', () => {
  const context = pendingSearchContext({ center: CENTER, radiusMiles: 10, centerLabel: 'Hillsboro, OR',
    centerLabelKind: CENTER_LABEL_KIND.EXPLICIT_PLACE, placeId: '4133416', distanceFromCenterM: 6759.2,
    nearestCenterPoint: [-122.88, 45.55], bearingFromCenterDeg: 315.4, cardinalFromCenter: 'NW' });
  assert.equal(context.kind, SEARCH_CONTEXT_KIND);
  assert.deepEqual([...context.center], CENTER);
  assert.equal(context.centerLabel, 'Hillsboro, OR');
  assert.equal(context.centerLabelKind, CENTER_LABEL_KIND.EXPLICIT_PLACE);
  assert.equal(context.placeId, '4133416');
  assert.equal(context.radiusMiles, 10);
  assert.equal(context.distanceFromCenterM, 6759.2);
  assert.deepEqual([...context.nearestCenterPoint], [-122.88, 45.55]);
  assert.equal(context.bearingFromCenterDeg, 315.4);
  assert.equal(context.cardinalFromCenter, 'NW');
  assert.equal(context.verification, null, 'the snapshot is unverified until a corridor is published');
  assert.equal(searchContextLine(context), '4.2 mi NW of Hillsboro, OR');
  assert.ok(Object.isFrozen(context) && Object.isFrozen(context.center) && Object.isFrozen(context.nearestCenterPoint));
});

test('a snapshot copies the centre it is given and cannot be rewritten afterwards', () => {
  const center = [-122.9, 45.55];
  const nearest = [-122.88, 45.55];
  const context = pendingSearchContext({ center, radiusMiles: 25, centerLabel: 'Near Vernonia, OR',
    centerLabelKind: CENTER_LABEL_KIND.NEAR_PLACE, distanceFromCenterM: 1000, nearestCenterPoint: nearest,
    bearingFromCenterDeg: 90, cardinalFromCenter: 'E' });
  center[0] = -100;
  nearest[1] = 0;
  assert.deepEqual([...context.center], [-122.9, 45.55], 'the context does not alias the search state');
  assert.deepEqual([...context.nearestCenterPoint], [-122.88, 45.55]);
  assert.throws(() => { context.center[0] = -100; }, TypeError);
  assert.throws(() => { context.centerLabel = 'somewhere else'; }, TypeError);
});

test('a context is only built when a search centre actually measured the corridor', () => {
  const complete = { center: CENTER, radiusMiles: 25, centerLabel: 'Near Vernonia, OR',
    centerLabelKind: CENTER_LABEL_KIND.NEAR_PLACE, distanceFromCenterM: 1000, nearestCenterPoint: [-122.88, 45.55],
    bearingFromCenterDeg: 90, cardinalFromCenter: 'E' };
  assert.ok(pendingSearchContext(complete));
  assert.equal(pendingSearchContext({ ...complete, center: null }), null, 'a declared box search has no centre');
  assert.equal(pendingSearchContext({ ...complete, nearestCenterPoint: null }), null);
  assert.equal(pendingSearchContext({ ...complete, distanceFromCenterM: null }), null);
  assert.equal(pendingSearchContext({ ...complete, distanceFromCenterM: Number.NaN }), null);
  assert.equal(pendingSearchContext({ ...complete, distanceFromCenterM: -1 }), null);
  assert.equal(pendingSearchContext(), null);
  // A missing radius, label or bearing is kept as absent rather than invented.
  const sparse = pendingSearchContext({ center: CENTER, distanceFromCenterM: 1000, nearestCenterPoint: [-122.88, 45.55] });
  assert.equal(sparse.radiusMiles, null);
  assert.equal(sparse.placeId, null);
  assert.equal(sparse.bearingFromCenterDeg, null);
  assert.equal(sparse.cardinalFromCenter, null);
  assert.equal(sparse.centerLabelKind, CENTER_LABEL_KIND.COORDINATES, 'an unnamed centre is labelled by its coordinates');
  assert.equal(sparse.centerLabel, '45.5500, -122.9000');
});

test('a stored context is validated defensively and anything unusable is discarded', () => {
  const good = pendingSearchContext({ center: CENTER, radiusMiles: 25, centerLabel: 'Near Vernonia, OR',
    centerLabelKind: CENTER_LABEL_KIND.NEAR_PLACE, distanceFromCenterM: 1000, nearestCenterPoint: [-122.88, 45.55],
    bearingFromCenterDeg: 90, cardinalFromCenter: 'E' });
  assert.deepEqual(storedSearchContext(good), good);
  assert.equal(storedSearchContext(undefined), null, 'an old candidate has no context, and that is valid');
  assert.equal(storedSearchContext(null), null);
  assert.equal(storedSearchContext({}), null);
  assert.equal(storedSearchContext({ ...good, center: ['north', 45] }), null);
  assert.equal(storedSearchContext({ ...good, nearestCenterPoint: [1] }), null);
  assert.equal(storedSearchContext({ ...good, distanceFromCenterM: '6759' }), null);
  assert.equal(storedSearchContext({ ...good, distanceFromCenterM: -5 }), null);
  assert.equal(storedSearchContext({ ...good, centerLabel: '' }), null);
  assert.equal(storedSearchContext({ ...good, centerLabel: 'x'.repeat(200) }), null);
  assert.equal(storedSearchContext({ ...good, centerLabelKind: 'somewhere' }).centerLabelKind, CENTER_LABEL_KIND.COORDINATES,
    'an unknown label kind falls back to the coordinates vocabulary rather than inventing one');
  assert.equal(searchContextLine(null), '');
  assert.equal(contextDirection(good), '0.6 mi E');
  assert.equal(contextDirection(null), 'Not measured');
  assert.equal(formatContextDirection(good), 'Not measured', 'the record shape is mapped by contextDirection, not guessed at');
});

// ------------------------------------------------------------------ the run's own presentation

test('the run is named from its own centre, not from whatever the controls say later', () => {
  const vernonia = examplePlace('Vernonia', 'OR');
  const hillsboro = examplePlace('Hillsboro', 'OR');
  const draftPlace = { id: hillsboro.id, label: 'Hillsboro, OR' };
  // The labels a person chose still describe the centre the run used: they are kept exactly.
  const same = runCenterPresentation({ center: vernonia.center, place: draftPlace, definitionCenter: vernonia.center, gazetteer });
  assert.equal(same.label, 'Hillsboro, OR');
  assert.equal(same.kind, CENTER_LABEL_KIND.EXPLICIT_PLACE);
  assert.equal(same.placeId, hillsboro.id);
  // The draft centre moved on: the labels of the draft no longer describe this run, so the run's own centre is
  // labelled from the gazetteer and the draft place is not carried onto it.
  const moved = runCenterPresentation({ center: vernonia.center, place: draftPlace, definitionCenter: [-123.17, 45.54], gazetteer });
  assert.equal(moved.label, 'Near Vernonia, OR');
  assert.equal(moved.kind, CENTER_LABEL_KIND.NEAR_PLACE);
  assert.equal(moved.placeId, vernonia.id);
  // An inferred label that still describes the run's centre is kept as it was shown.
  const inferred = runCenterPresentation({ center: vernonia.center, near: { label: 'Near Vernonia, OR', distanceM: 2200, id: vernonia.id },
    definitionCenter: vernonia.center, gazetteer });
  assert.equal(inferred.label, 'Near Vernonia, OR');
  assert.equal(inferred.kind, CENTER_LABEL_KIND.NEAR_PLACE);
  assert.equal(inferred.placeId, vernonia.id);
  // No gazetteer and no labels: the coordinates, which are still the search.
  const bare = runCenterPresentation({ center: vernonia.center, definitionCenter: vernonia.center });
  assert.equal(bare.kind, CENTER_LABEL_KIND.COORDINATES);
  assert.equal(bare.label, '45.8640, -123.1836');
  assert.equal(runCenterPresentation({ center: null }), null);
  assert.equal(runCenterPresentation({}), null);
});

// ------------------------------------------------------------------ carrying it onto a candidate

test('promotion carries the search context and keeps the measured relationship the run reported', () => {
  const result = discoveryResult({});
  const candidate = promoteDiscoveryResult(result, { features: [feature({ geometry: result.geometry })],
    provenance: { agency: 'U.S. Census Bureau' }, searchContext: contextFor(result) });
  const context = storedSearchContext(candidate.searchContext);
  assert.ok(context, 'the promoted candidate carries its search context');
  assert.deepEqual([...context.center], CENTER);
  assert.equal(context.centerLabel, 'Near Vernonia, OR');
  assert.equal(context.centerLabelKind, CENTER_LABEL_KIND.NEAR_PLACE);
  assert.equal(context.radiusMiles, 25);
  // The promoted corridor is the corridor the search measured, so the relationship survives promotion exactly.
  assert.ok(Math.abs(context.distanceFromCenterM - result.distanceFromCenterM) < 1e-6);
  assert.ok(Math.abs(context.bearingFromCenterDeg - result.bearingFromCenterDeg) < 1e-9);
  assert.equal(context.cardinalFromCenter, result.cardinalFromCenter);
  assert.ok(Math.abs(context.verification.distanceDeltaM) < 1e-6);
  assert.ok(Math.abs(context.verification.nearestPointDeltaM) < 1e-6);
  assert.equal(context.verification.toleranceM, 1);
  assert.equal(searchContextLine(candidate.searchContext), `${contextDirection(context)} of Near Vernonia, OR`);
  // The candidate's own geometry is what the kept values describe.
  const measured = corridorContextFromCenter(context.center, candidate.geometry);
  assert.ok(Math.abs(measured.distanceM - context.distanceFromCenterM) < 1e-6);
  assert.equal(measured.cardinal, context.cardinalFromCenter);
});

test('a promotion with no context, an explicit place, or coordinates keeps working', () => {
  const result = discoveryResult({});
  const features = [feature({ geometry: result.geometry })];
  const plain = promoteDiscoveryResult(result, { features });
  assert.equal(plain.searchContext, null, 'a candidate without a search context is a valid candidate');
  assert.equal(storedSearchContext(plain.searchContext), null);
  const hillsboro = examplePlace('Hillsboro', 'OR');
  const explicit = promoteDiscoveryResult(result, { features, searchContext: pendingSearchContext({ center: CENTER, radiusMiles: 10,
    centerLabel: 'Hillsboro, OR', centerLabelKind: CENTER_LABEL_KIND.EXPLICIT_PLACE, placeId: hillsboro.id,
    distanceFromCenterM: result.distanceFromCenterM, nearestCenterPoint: result.nearestCenterPoint,
    bearingFromCenterDeg: result.bearingFromCenterDeg, cardinalFromCenter: result.cardinalFromCenter }) });
  assert.equal(explicit.searchContext.centerLabel, 'Hillsboro, OR');
  assert.equal(explicit.searchContext.centerLabelKind, CENTER_LABEL_KIND.EXPLICIT_PLACE);
  assert.equal(explicit.searchContext.placeId, hillsboro.id);
  assert.equal(explicit.searchContext.radiusMiles, 10);
  // A centre with no gazetteer place near it is described by its coordinates, and the straight-line wording is
  // the same one the discovery row uses. The measurement is the one that centre actually produced.
  const far = [-121.88, 46.28];
  const farMeasured = corridorContextFromCenter(far, result.geometry);
  const coordinateOnly = promoteDiscoveryResult(result, { features,
    searchContext: pendingSearchContext({ center: far, radiusMiles: 25, centerLabel: '46.2800, -121.8800',
      centerLabelKind: CENTER_LABEL_KIND.COORDINATES, distanceFromCenterM: farMeasured.distanceM,
      nearestCenterPoint: farMeasured.nearestPoint, bearingFromCenterDeg: farMeasured.bearingDeg,
      cardinalFromCenter: farMeasured.cardinal }) });
  assert.equal(coordinateOnly.searchContext.centerLabelKind, CENTER_LABEL_KIND.COORDINATES);
  assert.equal(coordinateOnly.searchContext.placeId, null);
  assert.equal(storedSearchContext(coordinateOnly.searchContext).centerLabel, '46.2800, -121.8800');
});

// ------------------------------------------------------------------ derived against raw

// The app's own promotion path for a precomputed row: reconstruct the raw corridor, verify it reproduces the
// row, then carry the context. The same primitive measures both sides, so this is a real cross-check and not a
// second implementation of the distance.
function derivedPromotionCase(features, { segmentIndex = 1, center = CENTER, radiusMiles = 25, repaired = false } = {}) {
  const unit = buildDiscoveryUnits(features).units[0];
  const corridor = segmentUnit(unit).corridors[segmentIndex - 1];
  const derived = { id: corridor.id, name: corridor.name, geometry: corridor.geometry, geometry_repaired: repaired };
  const verified = verifyDerivedPromotion({ derived, features });
  const measured = corridorContextFromCenter(center, derived.geometry);
  const result = discoveryResult({ unit, corridor, fromCenter: measured });
  const candidate = promoteDiscoveryResult(result, { features: verified.features, corridor: verified.corridor,
    searchContext: pendingSearchContext({ center, radiusMiles, centerLabel: 'Near Vernonia, OR',
      centerLabelKind: CENTER_LABEL_KIND.NEAR_PLACE, distanceFromCenterM: measured.distanceM,
      nearestCenterPoint: measured.nearestPoint, bearingFromCenterDeg: measured.bearingDeg, cardinalFromCenter: measured.cardinal }) });
  return { candidate, derived, verified, measured };
}

function assertContextMatchesPromotedCorridor(candidate, { center = CENTER } = {}) {
  const context = storedSearchContext(candidate.searchContext);
  assert.ok(context, 'the promoted candidate carries a verified search context');
  const raw = corridorContextFromCenter(center, candidate.geometry);
  assert.ok(Math.abs(context.distanceFromCenterM - raw.distanceM) < 1e-6,
    `the carried distance is the promoted corridor's own measurement (${context.distanceFromCenterM} vs ${raw.distanceM})`);
  assert.ok(Math.abs(haversine(context.center, context.nearestCenterPoint) - raw.distanceM) < 1e-6,
    'the carried nearest point is at the carried distance');
  assert.ok(minDistanceToLineM(context.nearestCenterPoint, candidate.geometry) < 1e-6,
    'the carried nearest point lies on the promoted corridor');
  assert.equal(raw.cardinal, context.cardinalFromCenter);
  assert.ok(context.verification.distanceDeltaM <= context.verification.toleranceM);
  return { context, raw };
}

function haversine(from, to) {
  const rad = Math.PI / 180;
  const dLat = (to[1] - from[1]) * rad, dLon = (to[0] - from[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(from[1] * rad) * Math.cos(to[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

test('an ordinary corridor reports the same relationship from its derived row and its raw reconstruction', () => {
  // A corridor north of the centre: the distance is not a rounding case, and the direction is a real one.
  const { candidate, verified } = derivedPromotionCase([feature({ geometry: { type: 'LineString', coordinates: line(3000, { lon: -122.93, lat: 45.58 }) } })]);
  assert.equal(verified.driftM, 0, 'the raw composition reproduces the row exactly in this fixture');
  const { context, raw } = assertContextMatchesPromotedCorridor(candidate);
  assert.ok(context.distanceFromCenterM > 0 && context.distanceFromCenterM < 25 * MI);
  assert.ok(raw.distanceM > 0);
  assert.equal(context.cardinalFromCenter, raw.cardinal);
});

test('a segmented road carries the context of the segment that was promoted, not of the road', () => {
  const long = feature({ geometry: { type: 'LineString', coordinates: line(24000, { lon: -122.93, lat: 45.55, segments: 40 }) } });
  const unit = buildDiscoveryUnits([long]).units[0];
  const segments = segmentUnit(unit).corridors;
  assert.ok(segments.length > 2, `a 15-mile road is segmented into several corridors, found ${segments.length}`);
  const middle = derivedPromotionCase([long], { segmentIndex: 2 });
  assert.equal(middle.candidate.roads.length, 1, 'promotion publishes the corridor, not the whole road group');
  const { context } = assertContextMatchesPromotedCorridor(middle.candidate);
  // A different segment of the same road is a different distance from the same centre: the context follows the
  // corridor that was promoted.
  const first = derivedPromotionCase([long], { segmentIndex: 1 });
  assert.notEqual(first.candidate.id, middle.candidate.id);
  assert.ok(Math.abs(first.candidate.searchContext.distanceFromCenterM - context.distanceFromCenterM) > 100,
    'the two segments measure differently, so the carried context is not a road-group context');
  assertContextMatchesPromotedCorridor(first.candidate);
});

test('a cross-cell corridor composes its features and still verifies the context', () => {
  // The same named road in one county, delivered as two pieces that meet at a junction - the composition case a
  // cell seam produces. The corridor spans both, and the context describes the corridor, not either piece.
  const west = feature({ sourceFeatureId: 'w1', geometry: { type: 'LineString', coordinates: line(3000, { lon: -122.96, lat: 45.55 }) } });
  const east = feature({ sourceFeatureId: 'e1', roadId: 'tiger-2025-or-41067-example-rd-2',
    geometry: { type: 'LineString', coordinates: line(3000, { lon: -122.96 + 3000 * LON_PER_M, lat: 45.55 }) } });
  const unit = buildDiscoveryUnits([west, east]).units[0];
  assert.equal(unit.sourceFeatureIds.length, 2, 'the composition joined both pieces into one unit');
  const { candidate, verified } = derivedPromotionCase([west, east]);
  assert.equal(verified.driftM, 0);
  assert.ok(candidate.corridor.lengthM > 5000, 'the promoted candidate is the composed corridor');
  assertContextMatchesPromotedCorridor(candidate);
});

test('a row whose analytical geometry needed repair still reports the same corridor context', () => {
  // Repair happens to the geometry used for analysis. The context is measured on the canonical corridor, so a
  // repaired row and an unrepaired row describe the same relationship, and no repair tolerance leaks into it.
  const hairpin = feature({ geometry: { type: 'LineString', coordinates: [...line(1500, { lon: -122.93, lat: 45.55 }),
    ...line(1500, { lon: -122.93 + 1500 * LON_PER_M, lat: 45.55 }).reverse()] } });
  const plain = derivedPromotionCase([hairpin], { repaired: false });
  const repaired = derivedPromotionCase([hairpin], { repaired: true });
  assert.equal(plain.candidate.searchContext.distanceFromCenterM, repaired.candidate.searchContext.distanceFromCenterM);
  assert.deepEqual([...plain.candidate.searchContext.nearestCenterPoint], [...repaired.candidate.searchContext.nearestCenterPoint]);
  assert.equal(plain.candidate.searchContext.bearingFromCenterDeg, repaired.candidate.searchContext.bearingFromCenterDeg);
  assertContextMatchesPromotedCorridor(repaired.candidate);
});

// ------------------------------------------------------------------ failure behaviour

test('a context that no longer matches the promoted corridor fails the promotion closed', () => {
  const result = discoveryResult({});
  const features = [feature({ geometry: result.geometry })];
  const good = contextFor(result);
  // A wrong distance is the plainest disagreement: the row measured something the corridor does not support.
  assert.throws(() => promoteDiscoveryResult(result, { features, searchContext: { ...good, distanceFromCenterM: good.distanceFromCenterM + 50 } }),
    /search context: the promoted corridor is .* from the search centre, but the discovery row measured/);
  // A nearest point that is not on the promoted corridor (a stale measurement, or a different road).
  const offRoad = [result.nearestCenterPoint[0] + 1000 * LON_PER_M, result.nearestCenterPoint[1]];
  assert.throws(() => promoteDiscoveryResult(result, { features, searchContext: { ...good, nearestCenterPoint: offRoad } }),
    /nearest point recorded for this corridor is .* from the promoted corridor/);
  // A direction that points somewhere else entirely.
  assert.throws(() => promoteDiscoveryResult(result, { features,
    searchContext: { ...good, bearingFromCenterDeg: (good.bearingFromCenterDeg + 180) % 360 } }),
    /the direction to the promoted corridor differs by/);
  // The context of one corridor offered to another corridor: the distances cannot agree, so this is refused too.
  const elsewhere = feature({ sourceFeatureId: 'z1', geometry: { type: 'LineString', coordinates: line(2000, { lon: -122.4, lat: 45.2 }) } });
  const other = discoveryResult({ features: [elsewhere] });
  assert.throws(() => promoteDiscoveryResult(other, { features: [elsewhere], searchContext: good }), /search context: /);
  // The verification reports the same refusals without throwing, which is what the caller decides on.
  const rejected = verifyPromotionSearchContext({ ...good, distanceFromCenterM: good.distanceFromCenterM + 50 }, result.geometry);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.context, null);
  assert.match(rejected.reason, /discovery row measured/);
  // An unmeasurable geometry cannot confirm a context either.
  const unmeasurable = verifyPromotionSearchContext(good, { type: 'LineString', coordinates: [] });
  assert.equal(unmeasurable.ok, false);
  assert.match(unmeasurable.reason, /could not be measured/);
  // Nothing was published by the refusals above: a refused promotion produces no candidate at all.
  assert.ok(result.distanceFromCenterM > 0);
});

test('a promotion with no centre, and a candidate built before this feature, both stay valid', () => {
  // A declared window search measures no centre, so the result carries none and the candidate carries none.
  const result = discoveryResult({ fromCenter: null });
  assert.equal(result.distanceFromCenterM, null);
  const candidate = promoteDiscoveryResult(result, { features: [feature({ geometry: result.geometry })], searchContext: null });
  assert.equal(candidate.searchContext, null);
  assert.equal(storedSearchContext(candidate.searchContext), null);
  assert.equal(searchContextLine(candidate.searchContext), '');
  // A context offered for a run that measured nothing is refused rather than attached (the centre is not known).
  assert.equal(pendingSearchContext({ center: null, radiusMiles: 25, distanceFromCenterM: 10, nearestCenterPoint: [-122.9, 45.55] }), null);
  // The pilot path builds candidates directly, and an old candidate has no field at all.
  const pilot = createCandidate({ id: 'pilot-1', name: 'Pilot Rd', status: 'discovered', geometry: result.geometry });
  assert.equal(pilot.searchContext, null);
  const legacy = { ...pilot };
  delete legacy.searchContext;
  assert.equal(legacy.searchContext, undefined);
  assert.equal(storedSearchContext(legacy.searchContext), null, 'an old candidate renders with no context and no failure');
  assert.equal(searchContextLine(legacy.searchContext), '');
});

test('carrying a context changes nothing but the context, and a later search cannot rewrite it', () => {
  const result = discoveryResult({});
  const features = [feature({ geometry: result.geometry })];
  const plain = promoteDiscoveryResult(result, { features });
  const carried = promoteDiscoveryResult(result, { features, searchContext: contextFor(result) });
  assert.deepEqual(Object.keys(carried).sort(), Object.keys(plain).sort());
  const withoutContext = candidate => { const { searchContext, ...rest } = JSON.parse(JSON.stringify(candidate)); return rest; };
  assert.equal(JSON.stringify(withoutContext(carried)), JSON.stringify(withoutContext(plain)),
    'coverage, evidence, roads, geometry and summary are untouched by the search context');
  assert.equal(carried.coverage[COVERAGE_DATASET.WETLANDS].coverage, plain.coverage[COVERAGE_DATASET.WETLANDS].coverage);
  // A later search is a different search: it produces its own context and leaves the promoted one alone.
  const laterCenter = [-123.17, 45.54];
  const laterMeasured = corridorContextFromCenter(laterCenter, result.geometry);
  const later = promoteDiscoveryResult(result, { features, searchContext: pendingSearchContext({ center: laterCenter, radiusMiles: 10,
    centerLabel: 'Near Forest Grove, OR', centerLabelKind: CENTER_LABEL_KIND.NEAR_PLACE, distanceFromCenterM: laterMeasured.distanceM,
    nearestCenterPoint: laterMeasured.nearestPoint, bearingFromCenterDeg: laterMeasured.bearingDeg, cardinalFromCenter: laterMeasured.cardinal }) });
  assert.deepEqual([...carried.searchContext.center], CENTER);
  assert.equal(carried.searchContext.radiusMiles, 25);
  assert.equal(carried.searchContext.centerLabel, 'Near Vernonia, OR');
  assert.deepEqual([...later.searchContext.center], laterCenter);
  assert.equal(later.searchContext.radiusMiles, 10);
  assert.notDeepEqual([...later.searchContext.nearestCenterPoint], [...carried.searchContext.nearestCenterPoint]);
});

test('the evidence bundle deliberately carries no search context', () => {
  const result = discoveryResult({});
  const candidate = promoteDiscoveryResult(result, { features: [feature({ geometry: result.geometry })], searchContext: contextFor(result) });
  const bundle = buildCorridorBundle({ candidate, roads: candidate.roads });
  const text = JSON.stringify(bundle);
  assert.equal(text.includes('searchContext'), false, 'the bundle is corridor evidence, not browsing history');
  assert.equal(text.includes('Near Vernonia, OR'), false);
  assert.equal(text.includes('distanceFromCenterM'), false);
  assert.equal(validateBundle(bundle).valid, true, 'and it still validates');
});
