import { corridorGeometry } from './geometry.js';

export const CANDIDATE_STATUS = Object.freeze({ DISCOVERED: 'discovered', SHORTLISTED: 'shortlisted', REJECTED: 'rejected' });
export const COVERAGE = Object.freeze({ FULL: 'FULL', PARTIAL: 'PARTIAL', NONE: 'NONE', UNKNOWN: 'UNKNOWN' });
export const EVIDENCE_KIND = Object.freeze({ EXPECTED: 'EXPECTED', HISTORICAL: 'HISTORICAL', RECENT: 'RECENT', LOCAL: 'LOCAL', MODELED: 'MODELED', INFERRED: 'INFERRED' });

const statuses = new Set(Object.values(CANDIDATE_STATUS));
const coverageValues = new Set(Object.values(COVERAGE));
const evidenceKinds = new Set(Object.values(EVIDENCE_KIND));

export function createCandidate(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string' || !raw.name) throw new TypeError('Candidate requires id and name');
  if (!statuses.has(raw.status)) throw new TypeError('Unknown candidate status');
  const corridor = corridorGeometry(raw.geometry);
  const evidence = raw.evidence ?? [];
  if (!Array.isArray(evidence) || !evidence.every(validEvidence)) throw new TypeError('Evidence requires kind, statement, provenance, and coverage');
  return Object.freeze({ ...raw, geometry: corridor.geometry, corridor: { lengthM: corridor.lengthM, bounds: corridor.bounds }, evidence: evidence.map(item => Object.freeze({ ...item, provenance: Object.freeze({ ...item.provenance }) })) });
}
function validEvidence(item) { return item && evidenceKinds.has(item.kind) && typeof item.statement === 'string' && item.statement && coverageValues.has(item.coverage) && item.provenance && typeof item.provenance.source === 'string' && item.provenance.source; }

export function setCandidateStatus(candidate, status) {
  if (!statuses.has(status)) throw new TypeError('Unknown candidate status');
  return createCandidate({ ...candidate, status });
}
