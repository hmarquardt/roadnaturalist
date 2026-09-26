// BOUNDED CACHE FOR OFFICIAL-SOURCE READS.
//
// Official county and agency servers should not see a request every time somebody switches corridor. This cache
// keeps one entry per SOURCE URL, holding what the Worker actually needs next time: the normalized page text (never
// raw HTML) plus the retrieval metadata. Because the key is the URL, two probes that read the same page cost one
// upstream request, and the entry is stored with the strictest TTL among the probes that read it, so a status page
// can never be served from a day-old entry.
//
// Freshness is explicit rather than inferred from HTTP headers: an entry carries `fetchedAt` and `expiresAt`, and a
// read past `expiresAt` reports EXPIRED so the caller refetches. Failures are never cached.
//
// The store is injected (a Cache-like object with match/put/delete). In the Worker that is `caches.default`; in
// tests it is a fake. When no store exists the cache reports BYPASS and the Worker still works, just less politely
// to the upstream server.
export const CACHE_STATUS = Object.freeze({ MISS: 'MISS', HIT: 'HIT', EXPIRED: 'EXPIRED', BYPASS: 'BYPASS', UNCACHEABLE: 'UNCACHEABLE' });
export const MAX_CACHED_TEXT_BYTES = 262144;   // 256 KB of normalized text is far more than any pilot page

// A key space that can never collide with a real request: the .invalid TLD cannot resolve.
export const cacheKeyFor = sourceUrl => `https://investigator-source-cache.invalid/page?url=${encodeURIComponent(sourceUrl)}`;

export function createProbeCache({ store = null, clock = () => new Date() } = {}) {
  const enabled = Boolean(store && typeof store.match === 'function' && typeof store.put === 'function');
  async function read({ sourceUrl }) {
    if (!enabled) return Object.freeze({ status: CACHE_STATUS.BYPASS, entry: null, reason: 'no cache store is bound in this runtime' });
    let response = null;
    try { response = await store.match(cacheKeyFor(sourceUrl)); } catch (error) { return Object.freeze({ status: CACHE_STATUS.BYPASS, entry: null, reason: `cache read failed: ${error.message}` }); }
    if (!response) return Object.freeze({ status: CACHE_STATUS.MISS, entry: null, reason: null });
    let entry = null;
    try { entry = JSON.parse(await response.text()); } catch (error) { return Object.freeze({ status: CACHE_STATUS.MISS, entry: null, reason: `cached entry was unreadable: ${error.message}` }); }
    if (!entry?.expiresAt || new Date(entry.expiresAt).getTime() <= clock().getTime()) {
      return Object.freeze({ status: CACHE_STATUS.EXPIRED, entry, reason: 'the cached copy is past its declared freshness' });
    }
    return Object.freeze({ status: CACHE_STATUS.HIT, entry, reason: null });
  }
  async function write({ sourceUrl, entry, ttlSeconds }) {
    if (!enabled) return null;
    if (!entry?.text || entry.text.length > MAX_CACHED_TEXT_BYTES) return Object.freeze({ status: CACHE_STATUS.UNCACHEABLE, reason: 'the normalized page text is larger than the cache cap' });
    const fetchedAt = entry.fetchedAt ?? clock().toISOString();
    const stored = { ...entry, sourceUrl, ttlSeconds, fetchedAt, cachedAt: clock().toISOString(),
      expiresAt: new Date(new Date(fetchedAt).getTime() + ttlSeconds * 1000).toISOString() };
    try {
      await store.put(cacheKeyFor(sourceUrl), new Response(JSON.stringify(stored), { headers: { 'Content-Type': 'application/json',
        // The Cache API is used as a store keyed by URL; freshness is enforced by `expiresAt` above, and this header
        // keeps any incidental cache behaviour aligned with the declared TTL.
        'Cache-Control': `max-age=${ttlSeconds}` } }));
      return Object.freeze({ status: CACHE_STATUS.MISS, reason: null, cachedAt: stored.cachedAt, expiresAt: stored.expiresAt });
    } catch (error) { return Object.freeze({ status: CACHE_STATUS.UNCACHEABLE, reason: `cache write failed: ${error.message}` }); }
  }
  async function remove({ sourceUrl }) {
    if (!enabled || typeof store.delete !== 'function') return false;
    try { return await store.delete(cacheKeyFor(sourceUrl)); } catch { return false; }
  }
  return Object.freeze({ enabled, read, write, remove, keyFor: cacheKeyFor });
}
