// RATE LIMITING AND REQUEST DEDUPLICATION.
//
// Two things are protected: this Worker (from a browser looping on the endpoint) and the county or agency server
// behind it (from this Worker). The client budget is checked on every request, cached or not; the upstream budget is
// checked only when a request would actually touch the source, because a cache hit costs the source nothing.
//
// The limiter is per isolate and bounded: Cloudflare runs many isolates, so it is a floor on abuse, not a global
// quota. An account-level rate limiting rule (documented in worker/README.md) is the stronger control and is
// deliberately not invented here.
export const RATE_LIMIT_DEFAULTS = Object.freeze({
  client: Object.freeze({ windowMs: 60000, max: 30 }),
  source: Object.freeze({ windowMs: 60000, max: 6 }),
  maxClients: 2048,
});

export function createRateLimiter({ clock = () => new Date(), client = RATE_LIMIT_DEFAULTS.client, source = RATE_LIMIT_DEFAULTS.source,
  maxClients = RATE_LIMIT_DEFAULTS.maxClients } = {}) {
  const clients = new Map();
  const sources = new Map();
  const nowMs = () => clock().getTime();

  function slide(buckets, key, windowMs, max) {
    const at = nowMs();
    const hits = (buckets.get(key) ?? []).filter(stamp => at - stamp < windowMs);
    if (hits.length >= max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (at - hits[0])) / 1000));
      buckets.set(key, hits);
      return Object.freeze({ allowed: false, retryAfterSeconds, remaining: 0 });
    }
    hits.push(at);
    buckets.set(key, hits);
    return Object.freeze({ allowed: true, retryAfterSeconds: 0, remaining: max - hits.length });
  }

  function prune() {
    const at = nowMs();
    const windowMs = Math.max(client.windowMs, source.windowMs);
    for (const buckets of [clients, sources]) {
      for (const [key, hits] of buckets) {
        const fresh = hits.filter(stamp => at - stamp < windowMs);
        if (fresh.length) buckets.set(key, fresh); else buckets.delete(key);
      }
    }
    while (clients.size > maxClients) { const oldest = clients.keys().next().value; clients.delete(oldest); }
  }

  return Object.freeze({
    clientBudget: client, sourceBudget: source,
    checkClient: clientKey => { prune(); return Object.freeze({ scope: 'client', key: clientKey, ...slide(clients, clientKey, client.windowMs, client.max) }); },
    checkSource: sourceKey => { prune(); return Object.freeze({ scope: 'source', key: sourceKey, ...slide(sources, sourceKey, source.windowMs, source.max) }); },
    size: () => Object.freeze({ clients: clients.size, sources: sources.size }),
  });
}

// Simultaneous identical requests share one upstream fetch instead of racing each other.
export function createSingleFlight() {
  const inflight = new Map();
  return Object.freeze({
    size: () => inflight.size,
    async run(key, work) {
      if (inflight.has(key)) return inflight.get(key);
      const promise = (async () => work())().finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },
  });
}
