import { corridorGeometry, mergeLineGeometries } from './geometry.js';

export const CANDIDATE_STATUS = Object.freeze({ DISCOVERED: 'discovered', SHORTLISTED: 'shortlisted', REJECTED: 'rejected' });
export const COVERAGE = Object.freeze({ FULL: 'FULL', PARTIAL: 'PARTIAL', NONE: 'NONE', UNKNOWN: 'UNKNOWN' });
export const EVIDENCE_KIND = Object.freeze({ EXPECTED: 'EXPECTED', HISTORICAL: 'HISTORICAL', RECENT: 'RECENT', LOCAL: 'LOCAL', MODELED: 'MODELED', INFERRED: 'INFERRED' });
// Coverage is tracked per dataset. Road-geometry coverage and EPA ecological coverage are
// separate dimensions; one failing never becomes the other's answer.
export const COVERAGE_DATASET = Object.freeze({
  ROAD_GEOMETRY: 'road-geometry',
  EPA_LEVEL3: 'epa-ecoregions-or-l3',
  EPA_LEVEL4: 'epa-ecoregions-or-l4',
  WETLANDS: 'wetlands',
  HYDROGRAPHY: 'hydrography',
  OCCURRENCE: 'occurrence',
  ACCESS_VERIFICATION: 'access-verification',
});
export const DEFAULT_CANDIDATE_ACCESS = Object.freeze({ status: 'UNVERIFIED', note: 'Road Naturalist has not established public, legal, or practical access.' });

const statuses = new Set(Object.values(CANDIDATE_STATUS));
const coverageValues = new Set(Object.values(COVERAGE));
const evidenceKinds = new Set(Object.values(EVIDENCE_KIND));

export function createCoverage() {
  return Object.freeze(Object.fromEntries(Object.values(COVERAGE_DATASET)
    .map(id => [id, Object.freeze({ coverage: COVERAGE.UNKNOWN, reason: 'Not yet analyzed' })])));
}

export function setDatasetCoverage(coverage, datasetId, { coverage: value, reason = null }) {
  if (!Object.values(COVERAGE_DATASET).includes(datasetId)) throw new TypeError(`Unknown coverage dataset: ${datasetId}`);
  if (!coverageValues.has(value)) throw new TypeError('Unknown coverage value');
  return Object.freeze({ ...coverage, [datasetId]: Object.freeze({ coverage: value, reason }) });
}


export function createCandidate(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string' || !raw.name) throw new TypeError('Candidate requires id and name');
  if (!statuses.has(raw.status)) throw new TypeError('Unknown candidate status');
  const roads = raw.roads ?? [];
  if (!Array.isArray(roads)) throw new TypeError('Candidate roads must be an array');
  if (!roads.length && !raw.geometry) throw new TypeError('Candidate needs road geometry or a geometry');
  const geometry = roads.length ? mergeLineGeometries(roads.map(road => road.geometry)) : raw.geometry;
  const corridor = corridorGeometry(geometry);
  const evidence = raw.evidence ?? [];
  if (!Array.isArray(evidence) || !evidence.every(validEvidence)) throw new TypeError('Evidence requires kind, statement, provenance, and coverage');
  const access = raw.access ?? DEFAULT_CANDIDATE_ACCESS;
  if (!validAccess(access)) throw new TypeError('Access needs a status and note');
  return Object.freeze({
    ...raw,
    geometry: corridor.geometry,
    access: Object.freeze({ ...access }),
    roads: Object.freeze([...roads]),
    evidence: evidence.map(item => Object.freeze({ ...item, provenance: Object.freeze({ ...item.provenance }) })),
    corridor: Object.freeze({
      lengthM: corridor.lengthM,
      bounds: corridor.bounds,
      roadIds: Object.freeze(roads.map(road => road.id)),
      roadCount: roads.length,
      sourceFeatureIds: Object.freeze(roads.flatMap(road => road.sourceFeatureIds ?? [])),
      sourceFeatureCount: roads.reduce((total, road) => total + (road.composition?.sourceFeatureCount ?? road.sourceFeatureIds?.length ?? 0), 0),
      partCount: roads.reduce((total, road) => total + (road.composition?.partCount ?? 1), 0),
      sourceCounties: Object.freeze([...new Set(roads.map(road => road.county?.name).filter(Boolean))]),
      maxUnresolvedGapM: maximum(roads.map(road => road.composition?.maxUnresolvedGapM)),
    }),
    coverage: raw.coverage ?? createCoverage(),
  });
}

export function setCandidateStatus(candidate, status) {
  if (!statuses.has(status)) throw new TypeError('Unknown candidate status');
  return createCandidate({ ...candidate, status });
}

export function setCandidateCoverage(candidate, datasetId, entry) {
  return createCandidate({ ...candidate, coverage: setDatasetCoverage(candidate.coverage ?? createCoverage(), datasetId, entry) });
}

function validEvidence(item) { return item && evidenceKinds.has(item.kind) && typeof item.statement === 'string' && item.statement && coverageValues.has(item.coverage) && item.provenance && typeof item.provenance.source === 'string' && item.provenance.source; }
function validAccess(access) { return access && typeof access.status === 'string' && access.status && typeof access.note === 'string' && access.note; }
function maximum(values) { const present = values.filter(value => Number.isFinite(value)); return present.length ? Math.max(...present) : null; }
