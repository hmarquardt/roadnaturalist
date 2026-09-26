import { COVERAGE, COVERAGE_DATASET, createCandidate, createCoverage, setDatasetCoverage } from '../domain/corridor.js';
import { createRoad, groupRoadFeatures } from '../roads/road.js';
import { DEFAULT_TOLERANCE_M } from '../roads/normalize.js';
import { coverageFlag } from './filter.js';

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

export function promoteDiscoveryResult(result, { features = [], provenance = null, toleranceM = DEFAULT_TOLERANCE_M, dataCatalogUrl = null } = {}) {
  const members = features.filter(feature => result.road.sourceFeatureIds.includes(String(feature.sourceFeatureId)));
  if (!members.length) throw new TypeError(`Promotion needs the source features of ${result.id}`);
  const groups = groupRoadFeatures(members);
  const roads = groups.map(group => createRoad(group, { provenance, toleranceM }));
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
  return createCandidate({
    id: result.id, name: result.name, status: 'discovered', roads, coverage, dataCatalogUrl,
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

function promotionSummary(result, roads) {
  const miles = result.lengthM / 1609.344;
  const counties = roads.map(road => road.county?.name).filter(Boolean).map(name => name.replace(/, Oregon$/, ''));
  return [`${miles.toFixed(1)} mi`, `discovered corridor`, counties.join(' / ')].filter(Boolean).join(' · ');
}
