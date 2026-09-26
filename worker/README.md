# The Road Naturalist Worker boundary

This directory holds the one backend the project has: a Cloudflare Worker that reads **declared public official
sources** for the Investigator, so the browser does not need CORS access to a county web site.

Deployed production endpoints (see `docs/DEPLOYMENT.md` for the full topology):

```text
https://api.roadnaturalist.com          custom domain, declared in wrangler.toml
https://roadnaturalist-investigator.hmarquardt.workers.dev    workers_dev smoke host
```

```text
browser  ──GET /api/investigator/probes/:probeId──▶  Worker  ──GET <declared URL>──▶  county / agency page
   ▲                                                    │
   └──────────── normalized facts + diagnostics ────────┘        (never the page)
```

## 1. Endpoints

| Method | Path | Answer |
| --- | --- | --- |
| `GET` | `/api/investigator/probes` | the declared probe ids and their public sources. Contacts no source |
| `GET` | `/api/investigator/probes/:probeId` | one normalized probe result for that declared source |
| `OPTIONS` | either path | CORS preflight (204) |
| anything else | — | 404, or 405 for a non-read method |

A probe result is the contract the browser transport (`src/investigator/worker-transport.js`) already expects:

```json
{
  "probeId": "wc-cornelius-bridge-project",
  "status": "EVIDENCE | NO_RELEVANT_EVIDENCE | FAILED",
  "organization": "Washington County Land Use & Transportation",
  "sourceClass": "TIER_1_AUTHORITATIVE",
  "sourceUrl": "https://www.washingtoncountyor.gov/lut/projects/cornelius-pass-road-bridge-rock-creek",
  "stage": "contradiction-search", "kind": "closure", "title": "…", "question": "…", "appliesTo": "Cornelius Pass Road",
  "retrievedAt": "2026-09-26T12:00:00.000Z",
  "publishedAt": null,
  "facts": [
    { "claimType": "TEMPORARY_CLOSURE", "quote": "Road closure has been extended to October 7, 2026",
      "claimValue": "full closure for bridge replacement", "summary": "…", "claimStrength": "stated",
      "corridorPart": "bridge over Rock Creek, north of Germantown Road", "scope": "CORRIDOR_PART",
      "effectiveFrom": "2026-07-15", "effectiveUntil": "2026-10-07", "recurrence": null }
  ],
  "drift": { "state": "UNCHANGED", "digest": "fnv1a-…", "baselineDigest": "fnv1a-…", "baselineCapturedAt": "…", "added": [], "removed": [], "note": "…" },
  "cacheStatus": "MISS | HIT | BYPASS | UNCACHEABLE",
  "diagnostics": [ { "code": "cache", "message": "…" } ],
  "meta": { "requestId": "…", "probeId": "…", "sourceHost": "…", "durationMs": 512, "upstreamDurationMs": 498,
    "upstreamBytes": 45414, "cacheStatus": "MISS", "cacheReason": null, "extractionStatus": "4_facts",
    "httpStatus": 200, "sourceTextBytes": 3056, "redirects": 0, "attempts": 1, "answeredAt": "…", "cachedAt": null,
    "normalizedBytes": 1180, "worker": "roadnaturalist-investigator-worker/1",
    "policy": { "ttlSeconds": 21600, "maxBytes": 524288, "timeoutMs": 15000 } }
}
```

`retrievedAt` is when the **source** was read, never when this Worker answered, so a cached answer cannot look fresh.
`X-Normalized-Bytes` carries the exact size of the response body.

**A failed source is an HTTP 200 answer.** The endpoint worked; the source did not, and the result says so
(`status: FAILED` plus `diagnostics`). HTTP 429 from this Worker means the *caller* was rate limited, which is a
different statement — the diagnostics say which.

## 2. What this endpoint deliberately cannot do

* **No client-supplied URL.** A request carries a probe id. `worker/investigator/registry.js` is the only thing that
  can turn an id into a URL, and it is built from committed declarations plus committed policy.
* **No arbitrary outbound request.** `worker/investigator/policies.js` holds a static host allow-list; the registry
  refuses to build a probe whose host is not in it. URLs must be `https`, default port, canonical, credential-free,
  ASCII host, not an IP literal, not `localhost`/`.internal`/`.local`, no query string, no fragment.
* **No redirect off an approved destination.** Requests use `redirect: 'manual'`; at most one redirect is followed,
  and only to the same host under the same path prefix. Anything else is `redirect_blocked` — a failure, not a fetch.
* **No passthrough proxy.** Only extracted facts, drift, diagnostics, and metadata are returned. Raw HTML and
  normalized page text never leave the Worker (they are not even included in the cache entry's response).
* **No credential, header, or method from the client.** The Worker sends `Accept`, `Accept-Language`, and a
  User-Agent, and only `GET`. No cookie, token, or forwarding header is ever sent upstream. There is no secret in
  this Worker because none is needed.
* **No LLM.** Extraction is exact substring matching on normalized page text, sharing the rule set in
  `src/investigator/research.js`. Findings are computed in the browser by the existing guardrails.

## 3. The probe registry

Declarations (public URLs and the verbatim phrases that count as a fact) live in
`src/investigator/probes/or-pilot.js`, shared with the browser so the two sides cannot disagree. This Worker adds
*policy* — never URLs — in `worker/investigator/policies.js`:

| Host | Byte cap | Timeout | Default TTL | Accepted content types |
| --- | --- | --- | --- | --- |
| `www.washingtoncountyor.gov` | 512 kB | 15 s | 6 h | `text/html`, `application/xhtml+xml`, `text/plain` |
| `www.wc-roads.com` | 512 kB | 15 s | 15 min | `text/html`, `application/xhtml+xml` |
| `multco.us` | 512 kB | 15 s | 24 h | `text/html`, `application/xhtml+xml`, `text/plain` |
| `content.govdelivery.com` | 512 kB | 15 s | 24 h | `text/html`, `application/xhtml+xml`, `text/plain` |

Per-probe TTLs come from the probe's kind (a closure notice 15 minutes, a project page 6 hours, a jurisdiction or
funding document 24 hours) and can be overridden per probe. Declaring a new source is a reviewed code change:
pin the URL the source actually serves (a path that 301-redirects elsewhere will be refused by the redirect guard),
pin the verbatim phrases, and add the probe id to the drift baseline by regenerating the capture (section 7).

## 4. Cache and freshness

`worker/investigator/cache.js` stores **one entry per source URL** holding the normalized page text plus retrieval
metadata (never HTML, never the response). Because the key is the URL, two probes that read the same page cost one
upstream read; the entry is stored with the strictest TTL among the probes that read it, so a status page can never
be served from a day-old entry. Freshness is enforced by explicit `fetchedAt`/`expiresAt` fields and reported as
`cacheStatus` (`MISS`, `HIT`, `EXPIRED` → refetch, `BYPASS` when no store is bound, `UNCACHEABLE` when the page is
larger than the 256 kB text cap). **Failures are never cached.** In the Worker the store is `caches.default`; with
`INVESTIGATOR_CACHE=off` it is disabled.

Measured on the pilot: a cold pass over three corridors reads 11 pages (496 kB) and returns 15.4 kB of facts to the
browser; a repeat pass serves 6 probes from cache in 12 ms with no upstream request.

## 5. Rate limiting and deduplication

`worker/investigator/ratelimit.js` keeps two per-isolate sliding windows: 30 requests/minute per client (checked on
every request, cached or not) and 6 upstream reads/minute per source (checked only when a cache miss would touch the
source). Simultaneous identical requests are deduplicated through a single-flight map, so ten browsers clicking at
once produce one upstream read. A refused request is `429 RATE_LIMITED` (client) or
`429 SOURCE_BUDGET_EXHAUSTED` (source) with `Retry-After`; neither reaches the county server.

Because Cloudflare runs many isolates, this is a floor on abuse, not a global quota. The stronger control is an
account-level rate limiting rule on the route, which requires a Cloudflare account decision this repository does not
make.

## 6. Origins, observability

The CORS allow-list is committed in `worker/investigator/handler.js` and can be overridden per deployment with
`INVESTIGATOR_ALLOWED_ORIGINS`:

```text
https://roadnaturalist.com
https://www.roadnaturalist.com
http://localhost:8000        (local development)
http://127.0.0.1:8000        (local development and the Playwright suite)
```

A request from an unlisted origin is refused with `403 ORIGIN_NOT_ALLOWED` and no CORS header. A request with no
`Origin` header (a script, a smoke test) is served. The wildcard is never used. Responses carry
`Access-Control-Allow-Methods: GET, OPTIONS`, an expose list for `X-Request-Id`/`X-Worker-Version`, and
`Cache-Control: public, max-age=60` for successful answers (`no-store` for failures, so a failure is never
browser-cached).

One JSON line is logged per event (`probe_served`, `source_failed`, `source_drift`, `client_rate_limited`,
`source_budget_exhausted`, `unknown_probe`, `origin_refused`, `not_found`, `unhandled_error`) with `requestId`,
`probeId`, `sourceHost`, `status`, `durationMs`, `upstreamBytes`, `cacheStatus`, `extractionStatus`, and `driftState`.
Page content, credentials, and user data are never logged.

## 7. Local development, verification, deployment

```sh
npm test                                # includes tests/worker.test.js: the endpoint's security and behaviour
npm run verify:investigator:worker      # live sources through the boundary
npm run verify:investigator:live        # the operator path: sources + Overpass + drift, and the capture refresh
```

`tests/worker.test.js` runs the real handler in Node with a stubbed fetch, so the SSRF guards, byte caps,
content-type checks, redirect rules, cache, rate limits, deduplication, drift states, extraction equivalence, and
response contract are all covered offline.

`verify:investigator:worker` has two modes and says which it used:

* **DEPLOYED** — with `INVESTIGATOR_WORKER_URL` set (for example `https://api.roadnaturalist.com`), it requests every
  declared probe from the real Worker and reports HTTP result, extraction, cache state, drift against the committed
  baseline, coverage, and the deterministic finding.
* **LOCAL** — with no URL configured, it serves the same handler over `127.0.0.1` in-process and exercises it
  end-to-end against the real sources. It prints the exact deployment step it skipped.

Deploying this Worker, which is reproducible from this directory alone:

```sh
npm run deploy:worker      # from the repository root: cd worker && npx wrangler@4.135.0 deploy
```

`wrangler.toml` is the whole deployment: worker name, `compatibility_date`, the two optional variables, `workers_dev`,
and the `api.roadnaturalist.com` custom domain (`custom_domain = true`, so Cloudflare owns that DNS record and
certificate). No KV, no D1, no R2, no secret. After a deploy, verify the live boundary:

```sh
INVESTIGATOR_WORKER_URL=https://api.roadnaturalist.com npm run verify:investigator:worker
```

The app does not need its own configuration change to follow a redeploy: production resolves the boundary from
`PRODUCTION_BOUNDARY` in `src/app/config.js`, and only overrides it if `window.ROADNATURALIST_WORKER_URL` is set.

## 8. Occurrence credentials (documented need, not implemented)

eBird requires a personal API key on every request. Road Naturalist does not ship that key to the browser, so the
browser occurrence service is constructed with `ebirdTransport: null` and eBird reports `UNKNOWN` with a credential
reason instead of a zero result. When live eBird evidence is wanted in the deployed app, this Worker is the intended
boundary: hold the key as a secret, expose one bounded endpoint that accepts a corridor midpoint and recent-window
parameters, call eBird's `/v2/data/obs/geo/recent` with the key in the `X-eBirdApiToken` header, and return only the
normalized record shape. The browser must never receive the key, and the endpoint must keep the same bounded request
budget and truncation reporting the browser adapter already implements. Until that boundary is reviewed and
deployed, eBird stays UNKNOWN in the browser and `scripts/verify-occurrence-live.mjs` (Node, `EBIRD_API_KEY`) is the
only live eBird path.
