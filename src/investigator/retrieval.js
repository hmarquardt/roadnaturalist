// HOW A SOURCE'S ANSWER WAS OBTAINED.
//
// One vocabulary, used by the browser transport, the coverage summary, and the exported bundle, so "live", "from the
// boundary's cache", "replayed from the reviewed capture", and "not run" cannot mean different things in different
// places. `notReChecked` is a flag rather than a fifth mode: a source can be replayed AND not re-checkable here, and
// coverage already reports that condition.
export const RETRIEVAL_MODE = Object.freeze({ LIVE: 'LIVE', CACHE: 'CACHE', RECORDED: 'RECORDED', DEFERRED: 'DEFERRED' });

export function retrievalModeOf(result) {
  const declared = result?.searched?.retrievalMode ?? null;
  if (declared === RETRIEVAL_MODE.LIVE || declared === RETRIEVAL_MODE.CACHE) return declared;
  const outcome = result?.outcome ?? null;
  if (outcome === 'EVIDENCE' || outcome === 'NO_RELEVANT_EVIDENCE') return RETRIEVAL_MODE.RECORDED;
  return RETRIEVAL_MODE.DEFERRED;
}

export function retrievalModeCounts(results = []) {
  const counts = { live: 0, cache: 0, replayed: 0, notRun: 0, notReChecked: 0, total: results.length };
  for (const result of results) {
    const mode = retrievalModeOf(result);
    if (mode === RETRIEVAL_MODE.LIVE) counts.live += 1;
    else if (mode === RETRIEVAL_MODE.CACHE) counts.cache += 1;
    else if (mode === RETRIEVAL_MODE.RECORDED) counts.replayed += 1;
    else counts.notRun += 1;
    if (result?.deferred === true) counts.notReChecked += 1;
  }
  return Object.freeze({ ...counts,
    summary: `${counts.live} live, ${counts.cache} from the worker cache, ${counts.replayed} replayed from the reviewed capture, ${counts.notRun} not run`
      + (counts.notReChecked ? ` (${counts.notReChecked} of the replayed sources could not be re-checked in this environment)` : '') });
}
