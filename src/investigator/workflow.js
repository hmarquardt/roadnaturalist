export const STAGES = Object.freeze(['geography', 'landscape', 'discovery', 'triage', 'road-research', 'wildlife', 'access-verification', 'adversarial-review', 'geometry', 'ranking', 'guide-qa']);

export function createResearchPlan(candidate) {
  return { candidateId: candidate.id, stages: STAGES.map(id => ({ id, status: 'pending' })), findings: [], unresolvedQuestions: [] };
}
