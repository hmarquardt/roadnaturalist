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
| Pages project | `roadnaturalist` | direct upload from `dist/`; production branch `main` |
| Pages custom domains | `roadnaturalist.com`, `www.roadnaturalist.com` | attached to the Pages project |
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

   unless you point the override at a local Worker.

No secret exists anywhere in this path. The sources are public pages.
