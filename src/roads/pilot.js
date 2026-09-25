import { COVERAGE, COVERAGE_DATASET, createCandidate, createCoverage, setDatasetCoverage } from '../domain/corridor.js';
import { createRoad, groupRoadFeatures } from './road.js';

// Pilot declarations name road ids from the data manifest; the application never hard-codes
// a road-data path, and a road id that this bounded extract does not contain stays unresolved.

export const PILOT_KIND = 'road-candidate-pilot';

export function validatePilot(declaration) {
  if (!declaration || declaration.kind !== PILOT_KIND) throw new TypeError('Not a road candidate pilot declaration');
  if (typeof declaration.datasetId !== 'string' || !declaration.datasetId) throw new TypeError('Pilot needs a dataset id');
  if (!Array.isArray(declaration.candidates) || !declaration.candidates.length) throw new TypeError('Pilot declares no candidates');
  for (const candidate of declaration.candidates) {
    if (typeof candidate.id !== 'string' || !candidate.id || typeof candidate.name !== 'string' || !candidate.name) throw new TypeError('Pilot candidate needs an id and a name');
    if (!Array.isArray(candidate.roadIds) || !candidate.roadIds.length) throw new TypeError(`Pilot candidate needs road ids: ${candidate.id}`);
  }
  return declaration;
}

export function pilotRoadIds(declaration) {
  return [...new Set(validatePilot(declaration).candidates.flatMap(candidate => candidate.roadIds))];
}

export function buildPilotCandidates(declaration, roadQuery, { toleranceM } = {}) {
  validatePilot(declaration);
  const groups = new Map(groupRoadFeatures(roadQuery?.features ?? []).map(group => [group.roadId, group]));
  const provenance = roadQuery?.provenance ?? null;
  const candidates = [];
  const roadsByCandidate = {};
  const unresolved = [];
  for (const entry of declaration.candidates) {
    const missingRoadIds = entry.roadIds.filter(roadId => !groups.has(roadId));
    const roads = entry.roadIds.filter(roadId => groups.has(roadId)).map(roadId => createRoad(groups.get(roadId), { provenance, toleranceM }));
    if (!roads.length) {
      unresolved.push(Object.freeze({ id: entry.id, name: entry.name, missingRoadIds: Object.freeze(missingRoadIds), reason: roadQuery?.reason ?? 'This extract contains no source feature for the declared road ids.' }));
      continue;
    }
    const coverage = setDatasetCoverage(setDatasetCoverage(createCoverage(), COVERAGE_DATASET.ROAD_GEOMETRY, {
      coverage: missingRoadIds.length ? COVERAGE.PARTIAL : COVERAGE.FULL,
      reason: missingRoadIds.length ? `Missing road ids: ${missingRoadIds.join(', ')}` : null,
    }), COVERAGE_DATASET.ACCESS_VERIFICATION, {
      coverage: COVERAGE.NONE, reason: 'No access verification has been performed for this candidate.',
    });
    candidates.push(createCandidate({ ...entry, roads, summary: candidateSummary(roads), coverage,
      evidence: entry.evidence ?? [], questions: entry.questions ?? [] }));
    roadsByCandidate[entry.id] = roads;
  }
  return { candidates, roadsByCandidate, unresolved };
}

export function candidateSummary(roads) {
  const miles = roads.reduce((total, road) => total + road.lengthM, 0) / 1609.344;
  const counties = [...new Set(roads.map(road => road.county?.name).filter(Boolean))].map(county => county.replace(/, Oregon$/, ''));
  const parts = roads.reduce((total, road) => total + road.composition.partCount, 0);
  return [ `${miles.toFixed(1)} mi`, `${roads.length} road${roads.length === 1 ? '' : 's'}`, counties.join(' / '), parts > roads.length ? `${parts} geometry parts` : null ]
    .filter(Boolean).join(' · ');
}

export function roadSourceLabel(roads) {
  const provenance = roads[0]?.provenance;
  if (!provenance?.organization) return 'Source unrecorded';
  return [provenance.organization, provenance.dataset].filter(Boolean).join(' ');
}
