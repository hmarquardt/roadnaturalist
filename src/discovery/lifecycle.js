import { RANKING_VERSION, naturalistInterest } from './ranking.js';
import { COVERAGE, COVERAGE_DATASET, createCandidate, createCoverage, setDatasetCoverage } from '../domain/corridor.js';
import { corridorRoad, createRoad, groupRoadFeatures } from '../roads/road.js';
import { DEFAULT_TOLERANCE_M } from '../roads/normalize.js';
import { coverageFlag } from './filter.js';
import { PROMOTION_MAX_DRIFT_M } from './promotion.js';
import { verifyPromotionSearchContext } from './search-context.js';
import { DETAIL_LEVEL, derivedEvidence, detailLevelFor } from './evidence.js';
import { derivedRoad } from '../roads/road.js';
import { planningContextFrom } from '../state/planning-context.js';

// THE LAST STEP OF EVERY PROMOTION, in one place, so both levels finish a candidate the same way: the search
// context is verified against the corridor this promotion actually publishes, and the measurements the score came
// from are kept beside it. A candidate that no longer remembers its own numbers cannot be scored inside an outing
// months later, so the few numbers ARE saved - not the datasets, not the geometry, just what was measured.
function finishPromotion(candidate, result, { searchContext = null, at = null } = {}) {
  const verified = verifyPromotionSearchContext(searchContext, candidate.geometry, { toleranceM: PROMOTION_MAX_DRIFT_M });
  if (!verified.ok) throw new Error(`search context: ${verified.reason}`);
  const planningContext = planningContextFrom(result, { rankingVersion: RANKING_VERSION,
    at: at ?? new Date().toISOString() });
  return createCandidate({ ...candidate, ...(verified.context ? { searchContext: verified.context } : {}),
    ...(planningContext ? { planningContext } : {}) });
}

// Discovery lifecycle: a discovered candidate is either left alone, promoted into the ordinary
// candidate pipeline, or dismissed. Promotion is a real promotion: it builds the same road records and
// candidate object the hand-declared pilot corridors use, so ecology, habitat, occurrence, access, and
// evidence bundles all work on it without a second code path. A promoted corridor needs no Investigator
// probe entry; with no declared sources its access stays UNVERIFIED.
export const DISCOVERY_STATUS = Object.freeze({ DISCOVERED: 'DISCOVERED', PROMOTED: 'PROMOTED', DISMISSED: 'DISMISSED' });
const STATUSES = new Set(Object.values(DISCOVERY_STATUS));

export const NO_DECLARED_SOURCES = 'No reviewed research sources are declared for this corridor.';
export const DISCOVERY_ACCESS_NOTE = `${NO_DECLARED_SOURCES} Road Naturalist has not established public, legal, or practical access.`;

export function normalizeMarks(raw) {
  const marks = {};
  for (const [id, status] of Object.entries(raw ?? {})) {
    if (typeof id === 'string' && id && STATUSES.has(status) && status !== DISCOVERY_STATUS.DISCOVERED) marks[id] = status;
  }
  return marks;
}

export function statusFor(marks, id) {
  return marks?.[id] ?? DISCOVERY_STATUS.DISCOVERED;
}

export function applyMarks(results, marks) {
  return results.map(result => Object.freeze({ ...result, status: statusFor(marks, result.id) }));
}

export function markDiscovery(marks, id, status) {
  const next = { ...marks };
  if (status === DISCOVERY_STATUS.DISCOVERED) delete next[id]; else next[id] = status;
  return next;
}

export function promoteDiscoveryResult(result, { features = [], provenance = null, toleranceM = DEFAULT_TOLERANCE_M,
  dataCatalogUrl = null, corridor = null, searchContext = null, derived = null, derivedVersion = null,
  sourceEvidence = null, evidenceLevels = null, at = null } = {}) {
  const members = features.filter(feature => result.road.sourceFeatureIds.includes(String(feature.sourceFeatureId)));
  if (!members.length) throw new TypeError(`Promotion needs the source features of ${result.id}`);
  const groups = groupRoadFeatures(members);
  // The candidate is the corridor, not the road group it belongs to. A discovery row describes one
  // contiguous segment, so its road record takes the corridor's canonical geometry while keeping the
  // composed group's provenance; the batch survey and the detailed panel then prepare and measure the same
  // geometry. When no corridor is supplied (a caller promoting a whole hand-declared road) the composed
  // group is used exactly as before.
  const roads = corridor
    ? [corridorRoad(dominantGroup(groups), corridor, { provenance, toleranceM })]
    : groups.map(group => createRoad(group, { provenance, toleranceM }));
  const flag = coverageFlag(result);
  let coverage = createCoverage();
  const entries = [
    [COVERAGE_DATASET.ROAD_GEOMETRY, { coverage: flag, reason: 'Road geometry comes from the bounded discovery network extract.' }],
    [COVERAGE_DATASET.DISCOVERY, { coverage: flag, reason: 'This corridor was found by candidate discovery, not hand-declared.' }],
    [COVERAGE_DATASET.WETLANDS, result.coverage[COVERAGE_DATASET.WETLANDS]],
    [COVERAGE_DATASET.HYDROGRAPHY, result.coverage[COVERAGE_DATASET.HYDROGRAPHY]],
    [COVERAGE_DATASET.EPA_LEVEL3, { coverage: result.ecology.level3?.coverage ?? COVERAGE.UNKNOWN, reason: null }],
    [COVERAGE_DATASET.EPA_LEVEL4, { coverage: result.ecology.level4?.coverage ?? COVERAGE.UNKNOWN, reason: null }],
    [COVERAGE_DATASET.ACCESS_VERIFICATION, { coverage: COVERAGE.NONE, reason: 'No access verification has been performed for this candidate.' }],
  ];
  for (const [datasetId, entry] of entries) coverage = setDatasetCoverage(coverage, datasetId, entry);
  const candidate = createCandidate({
    id: result.id, name: result.name, status: 'discovered', roads, coverage, dataCatalogUrl,
    derived, derivedVersion, evidenceLevels: evidenceLevels ?? derivedEvidence(),
    detailLevel: detailLevelFor(evidenceLevels ?? derivedEvidence()),
    sourceEvidence: sourceEvidence ?? { status: 'unknown', message: null, missing: null },
    summary: promotionSummary(result, roads),
    evidence: [
      { kind: 'MODELED', coverage: flag,
        statement: `Candidate discovery proposed this corridor from ${result.road.sourceFeatureCount} TIGER/Line 2025 road feature(s) `
          + `named ${result.name}${result.road.segmentation.count > 1
            ? `, divided into ${result.road.segmentation.count} contiguous discovery corridors (this is corridor ${result.road.segmentation.index})` : ''}.`,
        provenance: { source: 'Road Naturalist candidate discovery', method: 'Name-normalized road composition, contiguous segmentation, set-oriented GIS analysis',
          note: 'Discovery is a screening step: it measured road, wetland, hydrography, and ecoregion facts. It is not a wildlife claim.' } },
      { kind: 'INFERRED', coverage: flag,
        statement: 'This corridor was surfaced by deterministic discovery signals, so it is worth a closer look — not a finding about habitat quality, species, or access.',
        provenance: { source: 'Road Naturalist candidate discovery', method: `Discovery signals: ${signalNote(result)}` } },
    ],
    questions: ['Is this road publicly accessible, and under what restrictions?'],
  });
  // SEARCH CONTEXT AND THE MEASUREMENTS THE SCORE CAME FROM, finished in one shared step: the context is verified
  // against the corridor this promotion actually publishes, and the numbers behind the interest score are kept beside
  // it. A context that disagrees beyond the corridor tolerance fails the promotion closed (the caller reports why)
  // rather than being silently carried or silently dropped; a run with no centre carries no context at all.
  //
  // The tolerance is the promotion geometry tolerance: a derived row is verified to within a metre of the raw
  // corridor it was reconstructed from, and the minimum distance from a point to a line is 1-Lipschitz in that
  // drift, so a legitimate promotion can never fail this check.
  return finishPromotion(candidate, result, { searchContext, at });
}

// THE DERIVED CANDIDATE. A discovered corridor becomes an ordinary candidate from the derived row alone: its
// geometry is the precomputed corridor, its road record says the geometry is precomputed, and its evidence levels
// say every plane is derived. No raw cell is fetched, so this succeeds everywhere the derived plane is published -
// which is everywhere discovery runs. The source-backed level is a separate, explicit action
// (promoteDiscoveryResult, below), and a candidate that has only ever been derived is never presented as if its
// wetlands and hydrography had been re-read.
export function promoteDerivedCandidate(result, { corridor = null, derived = null, derivedVersion = null,
  dataCatalogUrl = null, searchContext = null, provenance = null, sourceEvidence = null, at = null } = {}) {
  if (!corridor?.geometry) throw new TypeError(`A derived candidate needs the corridor row of ${result.id}`);
  const roads = [derivedRoad(corridor, result.road ?? {}, { derivedVersion, provenance })];
  const flag = coverageFlag(result);
  let coverage = createCoverage();
  // The derived row's own coverage, whatever datasets it declares. A national row and a regional one do not name
  // the same ecoregion datasets, and a row that declares none is still a corridor: the fallback is the row's own
  // discovery coverage, never a fabricated FULL.
  const declared = result.coverage ?? {};
  const entry = (datasetId, reason) => declared[datasetId] ?? { coverage: flag, reason };
  const entries = [
    [COVERAGE_DATASET.ROAD_GEOMETRY, { coverage: flag, reason: 'Road geometry is the precomputed national analysis corridor.' }],
    [COVERAGE_DATASET.DISCOVERY, { coverage: flag, reason: 'This corridor was found by candidate discovery, not hand-declared.' }],
    [COVERAGE_DATASET.WETLANDS, entry(COVERAGE_DATASET.WETLANDS, null)],
    [COVERAGE_DATASET.HYDROGRAPHY, entry(COVERAGE_DATASET.HYDROGRAPHY, null)],
    [COVERAGE_DATASET.EPA_LEVEL3, entry(COVERAGE_DATASET.EPA_LEVEL3, null)],
    [COVERAGE_DATASET.EPA_LEVEL4, entry(COVERAGE_DATASET.EPA_LEVEL4, null)],
  ];
  for (const [datasetId, entry] of entries) coverage = setDatasetCoverage(coverage, datasetId, entry);
  const candidate = createCandidate({
    id: result.id, name: result.name, status: 'discovered', roads, coverage, dataCatalogUrl,
    derived, derivedVersion, summary: promotionSummary(result, roads), detailLevel: DETAIL_LEVEL.DERIVED,
    evidenceLevels: derivedEvidence(),
    sourceEvidence: sourceEvidence ?? { status: 'unknown', message: null, missing: null },
    evidence: [
      { kind: 'MODELED', coverage: flag,
        statement: `Candidate discovery proposed this corridor from ${result.road.sourceFeatureCount} TIGER/Line 2025 road feature(s) `
          + `named ${result.name}${result.road.segmentation.count > 1
            ? `, divided into ${result.road.segmentation.count} contiguous discovery corridors (this is corridor ${result.road.segmentation.index})` : ''}.`,
        provenance: { source: 'Road Naturalist candidate discovery', method: 'Name-normalized road composition, contiguous segmentation, set-oriented GIS analysis',
          note: 'Discovery is a screening step: it measured road, wetland, hydrography, and ecoregion facts. It is not a wildlife claim.' } },
      { kind: 'MODELED', coverage: flag,
        statement: 'The corridor metrics shown for this corridor are precomputed: the national analysis build measured '
          + 'them from the same source datasets and stored them in the derived plane. They are not estimates, and they '
          + 'were not re-measured in this session.',
        provenance: { source: 'National derived corridor-metrics plane', method: 'Precomputed corridor metrics',
          note: 'Source-level wetland and hydrography evidence is a separate, deeper step that reads the published raw cells.' } },
      ...rankingEvidence(result),
    ],
    questions: ['Is this road publicly accessible, and under what restrictions?'],
  });
  return finishPromotion(candidate, result, { searchContext, at });
}

// WHY THIS ROAD SURFACED, AND WHAT IT IS NOT.
//
// The exploration order is shown as its own evidence entry so the panel explains the ordering rather than asserting
// it: the score, the fraction of the order that was actually measured, one sentence per component derived from that
// component's own values, and the standing statement that this is context - not wildlife, access, safety or a
// verdict about the road.
function rankingEvidence(result) {
  const ranking = naturalistInterest(result);
  if (ranking.score == null) {
    return [{ kind: 'MODELED', coverage: COVERAGE.UNKNOWN,
      statement: `Naturalist interest is not computed for this corridor: no measured physical context is covered `
        + `(${ranking.missing.join(', ')}), so it is ordered last rather than scored as though nothing were there.`,
      provenance: { source: 'Road Naturalist exploration order', method: ranking.version,
        note: 'Missing measurements are never treated as zero.' } }];
  }
  const measured = ranking.missing.length
    ? `Measured from ${Math.round(ranking.evidenceFraction * 100)}% of the order's evidence; ${ranking.missing.join(', ')} `
      + 'is not covered here and is left out of the mean rather than counted as zero.'
    : 'Measured from every component of the order.';
  return [{ kind: 'MODELED', coverage: ranking.missing.length ? COVERAGE.PARTIAL : COVERAGE.FULL,
    statement: `Naturalist interest ${ranking.score} / 100 - ${ranking.explanation.join('; ')}.`,
    provenance: { source: 'Road Naturalist exploration order', method: ranking.version,
      note: `${measured} An exploration heuristic built from mapped physical context: it is not a wildlife `
        + 'prediction, an access or safety statement, or a claim that this road is better than another.' } }];
}

function signalNote(result) {
  const wetlands = result.signals.wetlands;
  const hydro = result.signals.hydrography;
  return [
    `wetland nearest ${wetlands.nearestM == null ? 'unknown' : `${Math.round(wetlands.nearestM)} m`}`,
    `wetland area within 250 m ${Math.round(wetlands.area250M2)} m²`,
    `mapped water crossings ${hydro.crossingCount}`,
    `ecoregion transitions ${result.ecology.transitions}`,
  ].join(', ');
}

// The composed group that best describes the corridor: most source features first, road id as a stable
// tie-break. A name that spans a county boundary has one group per county-scoped road id.
function dominantGroup(groups) {
  if (!groups.length) throw new TypeError('Promotion needs at least one road group');
  return [...groups].sort((a, b) => b.features.length - a.features.length || a.roadId.localeCompare(b.roadId))[0];
}

function promotionSummary(result, roads) {
  const miles = result.lengthM / 1609.344;
  const counties = roads.flatMap(road => road.county?.name ? [road.county.name] : (road.countyNames ?? []))
    .filter(Boolean).map(name => name.replace(/, Oregon$/, ''));
  return [`${miles.toFixed(1)} mi`, `discovered corridor`, counties.join(' / ')].filter(Boolean).join(' · ');
}
