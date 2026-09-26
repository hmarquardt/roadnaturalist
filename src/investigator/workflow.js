// INVESTIGATOR STAGES.
//
// The original single-file Wildlife Road Cruise Investigator ran ten stages that mixed discovery, wildlife
// enrichment, geometry building, and ranking. Road Naturalist already owns those as deterministic layers
// (road geometry, EPA ecology, physical habitat, species occurrence), so the Investigator keeps only the
// stages that answer the question those layers cannot: can this road actually be used as a public road?
//
// Retained concepts: a staged, resumable plan; per-stage status and warnings; a source registry; a
// provisional finding followed by an explicit contradiction search and adversarial review; and a portable
// export. Discarded: candidate discovery/triage (this project already has candidate corridors), wildlife
// enrichment (the occurrence layer does it), geometry building (TIGER/Line owns geometry), scoring and route
// ranking, and any stage that would let a model set a finding.

export const STAGE_STATUS = Object.freeze({ PENDING: 'pending', RUNNING: 'running', COMPLETE: 'complete', WARNING: 'warning', FAILED: 'failed', SKIPPED: 'skipped' });

export const STAGE_DEFS = Object.freeze([
  Object.freeze({ id: 'baseline', label: 'Baseline', blurb: 'Load the deterministic evidence that already exists for this corridor', network: false }),
  Object.freeze({ id: 'road-context', label: 'Road context', blurb: 'OpenStreetMap road and access context, matched against the canonical corridor geometry', network: true }),
  Object.freeze({ id: 'authority-discovery', label: 'Authority discovery', blurb: 'Derive which organizations could control this road, and why', network: false }),
  Object.freeze({ id: 'access-research', label: 'Access research', blurb: 'Ask the declared official sources the access questions and keep every answer', network: true }),
  Object.freeze({ id: 'contradiction-search', label: 'Contradiction search', blurb: 'Look deliberately for closures, gates, permits, private status, and disconfirming evidence', network: true }),
  Object.freeze({ id: 'adversarial-review', label: 'Adversarial review', blurb: 'Try to break the provisional finding and record every concern', network: false }),
  Object.freeze({ id: 'finding', label: 'Finding', blurb: 'Qualified access finding from the evidence, with its guardrail rule and freshness', network: false }),
]);

// Ordered stage ids. Kept as the canonical `STAGES` list: there are no stages the plan omits.
export const STAGES = Object.freeze(STAGE_DEFS.map(def => def.id));
const stageIds = new Set(STAGES);

export function stageDef(id) { const def = STAGE_DEFS.find(entry => entry.id === id); if (!def) throw new TypeError(`Unknown investigator stage: ${id}`); return def; }
export const NETWORK_STAGES = Object.freeze(STAGE_DEFS.filter(def => def.network).map(def => def.id));

// A plan is declared before any research happens, so a reader can see what will be attempted and what was
// skipped. Nothing here reaches the network.
export function createResearchPlan(candidate) {
  if (!candidate?.id) throw new TypeError('A research plan needs a candidate');
  return { candidateId: candidate.id,
    stages: STAGE_DEFS.map(def => ({ id: def.id, label: def.label, status: STAGE_STATUS.PENDING, startedAt: null, completedAt: null,
      summary: '', counters: {}, warnings: [], evidenceIds: [], sourceIds: [], error: null })),
    findings: [], unresolvedQuestions: [...(candidate.questions ?? [])] };
}

// Stage records are created and updated by the service only. A stage that could not run says why.
export function startStage(stages, id, { now = () => new Date() } = {}) {
  if (!stageIds.has(id)) throw new TypeError(`Unknown investigator stage: ${id}`);
  return stages.map(stage => stage.id !== id ? stage : { ...stage, status: STAGE_STATUS.RUNNING, startedAt: now().toISOString() });
}

export function finishStage(stages, id, { status = STAGE_STATUS.COMPLETE, summary = '', counters = {}, warnings = [], evidenceIds = [], sourceIds = [], error = null, now = () => new Date() } = {}) {
  if (!stageIds.has(id)) throw new TypeError(`Unknown investigator stage: ${id}`);
  if (!Object.values(STAGE_STATUS).includes(status)) throw new TypeError(`Unknown stage status: ${status}`);
  return stages.map(stage => stage.id !== id ? stage : { ...stage, status, summary, counters, warnings, evidenceIds, sourceIds, error, completedAt: now().toISOString() });
}

export function stageSummary(stages) {
  return Object.freeze({ total: stages.length,
    complete: stages.filter(stage => stage.status === STAGE_STATUS.COMPLETE).length,
    warning: stages.filter(stage => stage.status === STAGE_STATUS.WARNING).length,
    failed: stages.filter(stage => stage.status === STAGE_STATUS.FAILED).length,
    skipped: stages.filter(stage => stage.status === STAGE_STATUS.SKIPPED).length,
    pending: stages.filter(stage => stage.status === STAGE_STATUS.PENDING).length,
    ranNetwork: stages.filter(stage => NETWORK_STAGES.includes(stage.id) && stage.status !== STAGE_STATUS.PENDING).length,
  });
}
