// A SOURCE-EVIDENCE REQUEST HAS A REAL TERMINAL BOUNDARY.
//
// The panel races its work against a timeout, and the timeout used to reject a promise while the work it raced kept
// running. The request token protected the writes that happened to go through the settle helper, but the
// orchestration also promoted candidates, resolved ecology and habitat, and emitted the identity record by calling
// the store directly. A run that had already timed out could therefore still move the corridor back to
// source-backed, which is precisely what "terminal" must forbid.
//
// This module is that boundary. A run is created with an identity (the corridor it owns), a timeout and an
// AbortSignal, and it is *closed* exactly once - by the timeout, by supersession, by completion, or by failure. Every
// stage that mutates visible state asks `isCurrent()` first, and `runSourceEvidence` checks ownership again after
// each await, because a write that sneaks in after an await that outlived the run is the bug this exists to stop.
//
// Work that cannot be aborted is allowed to finish: a DuckDB query in a browser cannot be cancelled, and pretending
// otherwise would be a lie. What is guaranteed is that its *result* is discarded, never written.
export const SOURCE_EVIDENCE_TIMEOUT_MS = () => Number(globalThis.__RN_SOURCE_TIMEOUT_MS ?? 120000);

export function createSourceEvidenceRun({ id, timeoutMs = SOURCE_EVIDENCE_TIMEOUT_MS(), isOwner = () => true,
  setTimer = setTimeout, clearTimer = clearTimeout, abortController = null } = {}) {
  const controller = abortController ?? new AbortController();
  let state = 'running';
  let timer = null;
  const listeners = [];
  const run = {
    id,
    signal: controller.signal,
    timedOut: false,
    get state() { return state; },
    get finished() { return state !== 'running'; },
    // Ownership: still running, not aborted, and still the corridor this corridor's request token names.
    isCurrent() {
      return state === 'running' && !controller.signal.aborted && isOwner();
    },
    // The one place a run stops. The first terminal reason wins, so a late failure cannot overwrite a timeout and a
    // stale run cannot close a newer one.
    close(next) {
      if (state !== 'running') return false;
      state = next;
      if (timer) { clearTimer(timer); timer = null; }
      controller.abort();
      for (const listener of listeners) listener(next);
      return true;
    },
    onClose(listener) { listeners.push(listener); return run; },
  };
  const limit = Number(timeoutMs);
  if (Number.isFinite(limit) && limit > 0) {
    timer = setTimer(() => {
      if (run.close('timeout')) run.timedOut = true;
    }, limit);
  }
  return run;
}

// THE SEQUENCE, WITH OWNERSHIP CHECKED AT EVERY MUTATION BOUNDARY.
//
// `steps` are the application's own operations. A mutating step is only *called* while this run owns the corridor,
// and its result is only kept while ownership still holds afterwards. A run that has lost ownership returns without
// touching anything, and a run that fails closes itself as failed or unavailable before the terminal state is
// written - so the terminal write belongs to the run that produced it and never to a stale one.
export async function runSourceEvidence({ run, steps, onStage = () => {} }) {
  const { id } = run;
  const stage = (name, detail = {}) => onStage(name, detail);
  const apply = async (label, mutate) => {
    if (!run.isCurrent()) { stage('discarded', { id, step: label }); return false; }
    const value = await mutate();
    if (!run.isCurrent()) { stage('discarded:late', { id, step: label }); return false; }
    stage(label, { id });
    return value === undefined ? true : value;
  };
  try {
    if (!await apply('loading', () => steps.loading())) return run.state;
    stage('start', { id, corridor: steps.corridorName ?? null });
    const built = await steps.reconstruct();
    if (!run.isCurrent()) { stage('discarded:late', { id, step: 'reconstruct' }); return run.state; }
    stage('roads:done', { id, features: built?.features?.length ?? null });
    if (!await apply('promote-roads', () => steps.promote({ roads: true }, built))) return run.state;
    if (!await apply('ecology', () => steps.ecology(built))) return run.state;
    if (!await apply('habitat', () => steps.habitat(built))) return run.state;
    if (!await apply('promote-levels', () => steps.promote(steps.levels(), built))) return run.state;
    // The identity record is evidence that a run *completed*, so it is emitted inside the same boundary that closed
    // the success path: a timed-out or superseded run can never leave one behind.
    if (!await apply('identity', () => steps.identity(built))) return run.state;
    run.close('ready');
    return run.state;
  } catch (error) {
    const terminal = error?.rawUnavailable ? 'unavailable' : 'failed';
    // Only the run that actually failed writes the terminal state; a stale run's rejection is discarded, and the
    // panel keeps whatever the run that owns the corridor has already said.
    if (run.close(terminal)) {
      await steps.terminal({ error, unavailable: terminal === 'unavailable', run });
    }
    return run.state;
  }
}
