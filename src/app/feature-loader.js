// LAZY FEATURE BOUNDARIES.
//
// A feature that ordinary use does not need is loaded when somebody asks for it, and not before. This loader is the
// whole of that mechanism, and it is deliberately thin because a dynamic import can do exactly three things:
//
//   * succeed — and then it is remembered, so every later request reuses the loaded module instead of fetching and
//     re-initialising it again;
//   * still be in flight — a second request while the first is loading awaits the same load rather than starting a
//     second one;
//   * fail — a dropped chunk, a blocked module, a server that answered with the wrong thing. The failure is reported
//     to the caller and the loader does *not* remember it: the next request tries again. A first attempt that failed
//     must not poison the feature for the rest of the session, which is what caching the rejected promise would do.
//
// Nothing here touches the document or the network by itself; the caller supplies the load, so the semantics above can
// be tested without a browser.
export function createFeatureLoader({ load, name = 'feature' } = {}) {
  if (typeof load !== 'function') throw new TypeError('A feature loader needs a load function');
  let module = null;
  let inFlight = null;
  let failures = 0;
  let lastFailure = null;
  return Object.freeze({
    name,
    loaded: () => module !== null,
    failureCount: () => failures,
    lastFailure: () => lastFailure,
    load() {
      if (module) return Promise.resolve(module);
      if (!inFlight) {
        inFlight = Promise.resolve()
          .then(() => load())
          .then(loaded => {
            if (!loaded) throw new Error(`The ${name} feature loaded nothing`);
            module = loaded;
            lastFailure = null;
            return loaded;
          })
          .catch(error => {
            failures += 1;
            lastFailure = error;
            // Forget the attempt so the next request can try again; the failure itself is the caller's to report.
            inFlight = null;
            throw error;
          });
      }
      return inFlight;
    },
  });
}
