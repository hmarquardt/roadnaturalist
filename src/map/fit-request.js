// ONE FIT PER COMPLETED SEARCH, ASKED FOR AT COMPLETION AND SPENT WHEN THE GEOMETRY IS DRAWN.
//
// The map must fit the results of a new search exactly once, and nothing else may move the camera. Inferring that
// from rendering state - "this combination of state changed, so fit" - is how the previous attempt failed: the
// condition was already false by the time there was geometry to fit, and the camera never moved.
//
// So the request is made where a run *completes*, and carries that completion's identity. It is then consumed once,
// at the first moment the completed search has geometry on the map. A request with no geometry stays pending rather
// than being spent on an empty map, and nothing else in the application can request one: selection, sorting,
// saving, promoting and analysis updates have no access to this and cannot move the camera by accident.
export function createFitRequests() {
  let pending = null;
  return {
    // A completed search asks for one fit. The identity is what distinguishes one completed search from the next.
    request(completionIdentity = 'completed-search') {
      pending = completionIdentity ?? 'completed-search';
      return true;
    },
    pending: () => pending,
    // Spent only when there is geometry to fit; returns whether *this* call is the one that should fit.
    consume({ hasGeometry = false } = {}) {
      if (pending == null || !hasGeometry) return false;
      pending = null;
      return true;
    },
    // A search that failed or was refused has no results to fit, so it withdraws any request it might have made.
    cancel() { pending = null; return true; },
  };
}
