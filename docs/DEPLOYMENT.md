# Production deployment

Road Naturalist is a static application plus one Cloudflare Worker. Both are deployed from this repository: there is
no build step, no bundler, and no dashboard-only configuration that the repository cannot reproduce.

## 1. Topology

```text
roadnaturalist.com  (and www.roadnaturalist.com)
      Cloudflare Pages project: roadnaturalist
      static site: index.html, assets/, src/, data/            <- npm run deploy:pages

api.roadnaturalist.com
      Cloudflare Worker: roadnaturalist-investigator           <- npm run deploy:worker
      GET /api/investigator/probes
      GET /api/investigator/probes/:probeId
```

The browser loads the app from `roadnaturalist.com` and asks the Worker at `api.roadnaturalist.com`. They are separate
origins, which is deliberate: the API is a fixed allow-list of declared sources with its own CORS list, cache, rate
limits, and logs, and it can be redeployed without republishing the site. The Worker is the only backend Road
Naturalist has, it belongs to Road Naturalist alone, and it holds no credential.

Why not `roadnaturalist.com/api/...`? A Worker route on the same hostname as a Pages custom domain is an ordering
coupling between two deployments, and it hides an error-prone path in which a route/custom-domain conflict serves the
site's HTML where the API should answer. A dedicated hostname is one declarative line in `worker/wrangler.toml`
(`custom_domain = true`), Cloudflare owns the DNS record and certificate, and the boundary stays independently
verifiable. CORS is the price, and it is already the project's model.

## 2. Cloudflare resources in use

| Resource | Name | Notes |
| --- | --- | --- |
| Worker | `roadnaturalist-investigator` | source: `worker/`; one new version per deploy |
| Worker custom domain | `api.roadnaturalist.com` | declared in `worker/wrangler.toml`; DNS record + certificate created by Cloudflare |
| Worker smoke host | `roadnaturalist-investigator.hmarquardt.workers.dev` | `workers_dev = true`; useful for a first check |
| Pages project | `roadnaturalist` | direct upload from `dist/`; production branch `main`; live at `https://roadnaturalist.pages.dev` |
| Pages custom domains | `roadnaturalist.com`, `www.roadnaturalist.com` | attached to the Pages project; **pending a DNS record** — see §8 |
| Zone | `roadnaturalist.com` | already in the account that owns the domain |

Nothing else is used or needed: no KV, no D1, no R2, no queue, no Durable Object, no cron trigger, no secret. Fruiting
Forecast and the CFLab workers are separate and are not touched by anything here.

## 3. Configuration

Worker variables (`worker/wrangler.toml`, both optional and both public):

| Variable | Value | Meaning |
| --- | --- | --- |
| `INVESTIGATOR_ALLOWED_ORIGINS` | `https://roadnaturalist.com,https://www.roadnaturalist.com,https://roadnaturalist.pages.dev,http://localhost:8000,http://127.0.0.1:8000` | exact browser origins allowed to call the API |
| `INVESTIGATOR_CACHE` | `on` | `off` bypasses the source cache while reviewing a page by hand |

Browser configuration (`src/app/config.js`, checked in, no build step):

1. `window.ROADNATURALIST_WORKER_URL` — explicit override (tests; a local Worker).
2. `PRODUCTION_BOUNDARY` (`https://api.roadnaturalist.com`) on any deployed origin, so production needs no manual
   global.
3. nothing on a local origin (`localhost`, `127.0.0.1`, `file:`), so local development replays the reviewed capture
   unless you point the override at a local Worker.

No secret exists anywhere in this path. The sources are public pages.

## 4. Deploy

The Worker:

```sh
npm run deploy:worker            # cd worker && npx wrangler@4.135.0 deploy
```

The Worker has no dependency on the app: deploy it whenever `worker/` or the shared declarations change. `wrangler`
reports the version id and the endpoints, including whether the custom domain was applied.

The site (requires a clean `main` checkout whose HEAD is the same as `origin/main`, so what is live is always a
reviewed commit):

```sh
npm run stage:pages              # validates and stages dist/ (no upload)
npm run deploy:pages             # stages, then uploads to the Pages project
```

The staged payload includes the investigator probe catalog and its schema
(`data/investigator/probe-catalog.json`, `probe-catalog.schema.json`), because the browser Investigator loads them as
modules; `stage:pages` refuses to stage a payload without them. Catalog validation is a separate, offline step:
`npm run validate:probes`.

`stage:pages` fails the deployment rather than shipping a broken payload: every stylesheet/icon/script referenced by
`index.html`, every relative `import` in the `src/` module graph, and every dataset in `data/manifest.json` must be
present, and a staged dataset whose byte length disagrees with the manifest is a failure. `dist/` is gitignored and is
only ever replaced when it carries the `deployment.json` marker this script writes.

Order when both change: `npm test`, `npm run test:e2e`, commit, push, `npm run deploy:worker`, `npm run deploy:pages`.

## 5. Verify

```sh
npm run verify:investigator:worker                  # local mode: the same handler served on 127.0.0.1
INVESTIGATOR_WORKER_URL=https://api.roadnaturalist.com npm run verify:investigator:worker    # deployed mode
npm run verify:production:browser                   # a real browser against roadnaturalist.com
npm run verify:investigator:live                    # the operator path, including the capture refresh
```

The deployed-mode run reports, per probe: HTTP result, cache state, extraction, drift against the committed baseline,
and then coverage and the deterministic finding per corridor. The production browser run reports the same through the
real UI and asserts that no official source was contacted by the browser itself.

Bounded smoke checks against the deployed API (no high-volume traffic; the cache absorbs repeats):

```sh
API=https://api.roadnaturalist.com
curl -s   "$API/api/investigator/probes" | head -c 300
curl -s   "$API/api/investigator/probes/wc-roads-cornelius-advisory" | head -c 300
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/investigator/probes/not-a-declared-probe"                      # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/api/investigator/probes/wc-roads-cornelius-advisory"        # 405
curl -s -D - -o /dev/null -H 'Origin: https://roadnaturalist.com' "$API/api/investigator/probes" | grep -i access-control
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example' "$API/api/investigator/probes"          # 403, no CORS header
```

## 6. Local development

```sh
npm run dev                                  # http://127.0.0.1:8000 — recorded capture, no Cloudflare access needed
cd worker && npx wrangler@4.135.0 dev        # a real local Worker on 127.0.0.1:8787
```

To use the local Worker from the local app, set the override before the app loads:

```js
window.ROADNATURALIST_WORKER_URL = 'http://127.0.0.1:8787';
```

The local origin is already in the Worker's allow-list. `npm test` and `npm run test:e2e` never contact Cloudflare or a
county site: the Worker is exercised in-process with a stubbed fetch, and the browser tests stub the boundary.

## 7. Runtime behaviour in production

* Official-source research goes to the Worker; the browser never reads a county page directly.
* The Worker caches normalized page text per source URL, with a per-probe TTL (closure/status 15 minutes, project page
  6 hours, jurisdiction or funding document 24 hours) and reports `retrievedAt` (source read), `cachedAt`, and
  `cacheStatus`. Failures are never cached.
* Retrieval mode is visible per source and in the panel: `LIVE`, `CACHE`, `RECORDED`, `DEFERRED`.
* If the boundary cannot answer a single source — including a refused origin on a Pages preview deployment — the app
  replays the reviewed capture, says so, and reports coverage `PARTIAL` rather than pretending a fresh check happened.
* Access-verification coverage reaches `FULL` when every declared source answered and the OpenStreetMap stage
  completed. Coverage describes whether the research completed, never what it supports.

## 8. Current state of `roadnaturalist.com` (2026-09-26)

Deployed and verified:

* the Worker `roadnaturalist-investigator` answers at `https://api.roadnaturalist.com` (custom domain), and
  `INVESTIGATOR_WORKER_URL=https://api.roadnaturalist.com npm run verify:investigator:worker` reported 14/14 probes
  with drift `UNCHANGED`, no failures, 496 kB read from the sources against 15.4 kB returned, and a repeat pass served
  entirely from the Worker cache;
* the application is deployed to the Pages project `roadnaturalist` and serves from
  `https://roadnaturalist.pages.dev`, including the GeoParquet datasets and the `_headers` policy;
* a browser on that host resolved the Worker from `PRODUCTION_BOUNDARY` with no manual global and, for all three pilot
  corridors, read every declared source through the deployed boundary with **zero capture replays** and coverage
  `FULL`:

| Corridor | Finding | Coverage | Retrieval (repeat run) |
| --- | --- | --- | --- |
| NW Cornelius Pass Rd | `RESTRICTED OR CLOSED` (R3) | `FULL` | 6 from the Worker cache, 0 replayed |
| NW Springville Rd | `PROBABLE_PUBLIC` (R7) | `FULL` | 2 live, 2 from the Worker cache, 0 replayed |
| NW Susbauer Rd | `RESTRICTED OR CLOSED` (R4) | `FULL` | 4 from the Worker cache, 0 replayed |

A cold pass in the same browser run showed the live reads themselves ("3 live, 1 from the worker cache" and "4
source(s) read live through the Worker boundary"), and the browser never contacted an official source directly.


The one outstanding step is DNS for the two Pages custom domains, which this session's Cloudflare credentials were not
permitted to change:

```text
GET /accounts/<account>/pages/projects/roadnaturalist/domains
  roadnaturalist.com      status pending   verification_data.error_message "CNAME record not set"
  www.roadnaturalist.com  status pending   verification_data.error_message "CNAME record not set"
POST /zones/<roadnaturalist.com zone>/dns_records -> Authentication error (this token has zone:read, not DNS:edit)
```

The zone still carries the older proxied records for the apex and `www` that point at an origin which no longer serves
anything (`https://roadnaturalist.com` times out; `https://www.roadnaturalist.com` answers 525 from the edge). Cloudflare
creates the DNS record for a Worker custom domain itself (`api.roadnaturalist.com` needed nothing manual), but a Pages
custom domain expects the hostname to point at the project.

Fix it once, with either:

1. **Dashboard** — Cloudflare dashboard → Workers & Pages → `roadnaturalist` → Custom domains → add
   `roadnaturalist.com` and `www.roadnaturalist.com`. The dashboard performs the DNS change with your own permissions
   and replaces the stale apex/`www` records with the project's CNAME; or
2. **API with a DNS-capable token** — a token that has `Zone → DNS → Edit` for `roadnaturalist.com` (in addition to
   `Account → Cloudflare Pages → Edit`), then
   `POST /accounts/<account>/pages/projects/roadnaturalist/domains` with `{"name":"roadnaturalist.com"}` and the same
   for `www`, replacing the existing A/AAAA records with a proxied CNAME to `roadnaturalist.pages.dev`.

Until then the production application is reachable at `https://roadnaturalist.pages.dev`, which is in the Worker's
origin allow-list, and the API is already live at `https://api.roadnaturalist.com`. Nothing else has to change after
the records are fixed: the app resolves its boundary from the deployed origin, and no code or configuration depends on
the hostname.


   unless you point the override at a local Worker.

No secret exists anywhere in this path. The sources are public pages.
