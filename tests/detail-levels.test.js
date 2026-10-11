import test from 'node:test';
import assert from 'node:assert/strict';
import { DETAIL_LEVEL, EVIDENCE_SOURCE, derivedEvidence, detailEvidence, detailLevelFor, evidenceLabel,
  sourceEvidence, unavailableMessage } from '../src/discovery/evidence.js';
import { promoteDerivedCandidate } from '../src/discovery/lifecycle.js';

// TWO LEVELS OF DETAIL, AND A LINE THAT IS NEVER BLURRED.
//
// A discovered corridor always opens: its precomputed metrics come from the derived row the discovery run already
// loaded, so opening reads no source cell at all. Source-level evidence - the corridor rebuilt from the published
// road network and measured against the published wetland and hydrography cells - is a separate, explicit step,
// offered only while those cells are online. These tests hold both halves: that the derived candidate is built from
// the row without a single fetch, and that no precomputed value can pass as source-backed.
const CORRIDOR = Object.freeze({ id: 'drv1-test-rd-s1', name: 'Test Rd', unitId: 'drv1-test-rd', segmentIndex: 1,
  segmentCount: 2, bounds: [-122.4, 45.0, -122.2, 45.2],
  geometry: { type: 'LineString', coordinates: [[-122.39, 45.05], [-122.21, 45.15]] } });

const RESULT = Object.freeze({ id: 'drv1-test-rd-s1', name: 'Test Rd', lengthM: 1609.344, derived: true,
  road: { id: 'drv1-test-rd', name: 'Test Rd', roadClass: 'S1100', routeType: 'M', countyNames: ['Test County'],
    countyFips: ['41001'], sourceFeatureIds: ['a', 'b'], sourceFeatureCount: 2, segmentation: { index: 1, count: 2 } },
  coverage: { 'road-geometry': { coverage: 'FULL' }, 'road-discovery': { coverage: 'FULL' },
    wetlands: { coverage: 'FULL' }, hydrography: { coverage: 'FULL' },
    'epa-ecoregions-or-l3': { coverage: 'FULL' }, 'epa-ecoregions-or-l4': { coverage: 'FULL' } },
  signals: { wetlands: { intersectsCorridor: true, nearestDistanceM: 34, buffers: [], classes: [] },
    hydrography: { crossingCount: 3, nearestFlowingWaterM: 18, nearestStandingWaterM: 640 } },
  ecology: { level3: { primary: { code: '9', name: 'Willamette Valley', percent: 100 } }, level4: null, transitions: 0 } });

test('the evidence vocabulary names one level per kind of number, and never mixes them', () => {
  assert.equal(evidenceLabel(EVIDENCE_SOURCE.DERIVED), 'Precomputed');
  assert.equal(evidenceLabel(EVIDENCE_SOURCE.SOURCE), 'Source-backed');
  assert.equal(evidenceLabel('nonsense'), 'Precomputed', 'an unknown value is never sold as source-backed');
  assert.deepEqual(derivedEvidence(), { roads: 'derived', ecology: 'derived', wetlands: 'derived', hydrography: 'derived' });
  assert.equal(detailLevelFor(derivedEvidence()), DETAIL_LEVEL.DERIVED);
  // Every plane source-backed is the only thing that makes the detail source-level.
  assert.equal(detailLevelFor(sourceEvidence({ roads: true, ecology: true, wetlands: true, hydrography: true })),
    DETAIL_LEVEL.SOURCE);
  const partial = sourceEvidence({ roads: true, wetlands: true });
  assert.equal(detailLevelFor(partial), DETAIL_LEVEL.DERIVED, 'a partial read is not a source-backed detail');
  assert.equal(partial.hydrography, EVIDENCE_SOURCE.DERIVED);
  assert.deepEqual(detailEvidence({ evidence: partial }).sourceBacked, ['roads', 'wetlands']);
});

test('the unavailable message names the bounded planes and never roads', () => {
  const message = unavailableMessage({ wetlands: ['x1_y1', 'x2_y2'], hydrography: ['x1_y1'] });
  assert.match(message, /3 raw source cells/);
  assert.match(message, /wetlands: 2, hydrography: 1/);
  assert.match(message, /precomputed national analysis values/);
  assert.ok(!/roads/.test(message), 'roads are published nationally and cannot be the reason');
  assert.match(unavailableMessage({ wetlands: ['x1_y1'] }, { detail: true }), /Missing cells: x1_y1/);
  assert.match(unavailableMessage({}), /has not yet been published/);
});

test('a discovered corridor becomes a candidate from the derived row alone, with no fetch', () => {
  const fetches = [];
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    fetches.push(String(input?.url ?? input));
    throw new Error('the derived detail must read nothing from the network');
  };
  try {
    const candidate = promoteDerivedCandidate(RESULT, { corridor: CORRIDOR, derived: { road: RESULT.road },
      derivedVersion: 'conus-2025-v1', provenance: { agency: 'U.S. Census Bureau' },
      sourceEvidence: { status: 'unavailable', message: 'not published', missing: { wetlands: ['x1_y1'] } } });
    assert.equal(fetches.length, 0, 'opening a corridor detail is a local read');
    assert.equal(candidate.detailLevel, DETAIL_LEVEL.DERIVED);
    assert.deepEqual(candidate.evidenceLevels, derivedEvidence());
    assert.equal(candidate.derivedVersion, 'conus-2025-v1');
    assert.equal(candidate.sourceEvidence.status, 'unavailable');
    // The road record is honest about its own geometry: precomputed, not verified in this session.
    assert.equal(candidate.roads.length, 1);
    assert.equal(candidate.roads[0].derived, true);
    assert.equal(candidate.roads[0].evidence.geometry.status, 'derived');
    assert.match(candidate.roads[0].evidence.geometry.statement, /precomputed/i);
    assert.match(candidate.summary, /Test County/, 'a derived road still names its counties');
    assert.ok(candidate.summary.includes('1.0 mi'), candidate.summary);
    assert.equal(candidate.roads[0].composition.corridorSegment.count, 2);
    // The evidence trail says what the metrics are, in as many words.
    const derivedNote = candidate.evidence.find(item => /precomputed/i.test(item.statement));
    assert.ok(derivedNote, 'the trail records that the metrics are precomputed');
    assert.match(derivedNote.provenance.note, /separate, deeper step/);
  } finally { globalThis.fetch = original; }
});

test('a derived candidate still verifies the search context it carries, and refuses a bad one', () => {
  // The context has to agree with the corridor geometry, exactly as a real one does: the centre sits on the
  // corridor's own start point, and the row's distance is the measured one.
  const context = { center: [-122.39, 45.05], radiusMiles: 25, centerLabel: 'Near Test', centerLabelKind: 'near',
    placeId: null, distanceFromCenterM: 0, nearestCenterPoint: [-122.39, 45.05], bearingFromCenterDeg: 0,
    cardinalFromCenter: 'N' };
  const candidate = promoteDerivedCandidate(RESULT, { corridor: CORRIDOR, searchContext: context });
  assert.ok(candidate.searchContext, 'a verified context is kept');
  assert.equal(candidate.searchContext.centerLabel, 'Near Test');
  // A context that disagrees with the corridor beyond the promotion tolerance fails closed, exactly as it does for
  // a source-backed promotion: the level of detail does not relax the geometry check.
  assert.throws(() => promoteDerivedCandidate(RESULT, { corridor: CORRIDOR,
    searchContext: { ...context, center: [0, 0], distanceFromCenterM: 0, nearestCenterPoint: [0, 0] } }),
  /search context/);
});

test('a derived candidate refuses to exist without a corridor row', () => {
  assert.throws(() => promoteDerivedCandidate(RESULT, {}), /needs the corridor row/);
  assert.throws(() => promoteDerivedCandidate(RESULT, { corridor: { id: 'x', name: 'x' } }), /needs the corridor row/);
});

