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

data.roadnaturalist.com
      R2 bucket: roadnaturalist-data                            <- immutable regional GeoParquet
      manifest remains on Pages; the browser reads selected objects directly
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
| Pages custom domains | `roadnaturalist.com`, `www.roadnaturalist.com` | attached to the Pages project and resolving; `roadnaturalist.com` is the canonical host for crawlers — see §9 |
| Zone | `roadnaturalist.com` | already in the account that owns the domain |
| R2 bucket | `roadnaturalist-data` | Standard class; immutable regional analytical GeoParquet only |
| R2 custom domain | `data.roadnaturalist.com` | direct object delivery, CORS policy at `config/regional-r2-cors.json` |

No other Cloudflare primitive is used or needed: no KV, no D1, no queue, no Durable Object, no cron trigger, no secret. Fruiting
Forecast and the CFLab workers are separate and are not touched by anything here.

The first regional release has 18 versioned R2 objects (24,887,577 bytes). Their public GET bytes, SHA-256, Pages-origin CORS and Range response were audited with `node scripts/audit-regional-remote.mjs`. `npm run stage:pages` validates the local object bytes against the catalog and excludes those Parquet files from the Pages payload. On localhost only the asset base changes to `./data/`; all selection, digest and GIS code remains the same. Publish any changed object under a new catalog version and audit it before a Pages release. The Investigator Worker does not proxy R2 or run DuckDB.

The immutable **derived corridor-metrics plane** lives on the same bucket and the same origin, under
`derived/corridor-metrics/<analysis-fingerprint>/` (`cells/<cell>.parquet` plus `manifest.json`). Its local path
is the published path — `data/derived/corridor-metrics/<fingerprint>/…` — so a browser on localhost reads exactly
the objects production reads. `npm run publish:regional` publishes the raw partitions *and* the derived plane
(one manifest object plus one object per present cell), and `npm run audit:regional:remote` audits both, checking
bytes, SHA-256, Pages-origin CORS, immutable cache-control, content type (`application/json` for the manifest,
`application/vnd.apache.parquet` for cells) and a Range `206` on a Parquet object of each plane. A fingerprint
directory is written once: a rebuilt plane is a new fingerprint directory, never an overwrite, and no prior
regional partition is deleted. `npm run stage:pages` validates the derived manifest and every present cell in the
local checkout and then excludes the cell objects from the Pages payload, exactly as it does for the raw
partitions; the 50 KB manifest itself is small enough to stay with the catalog, and the catalog's
`derived.manifestUrl` is what the browser fetches from R2. To publish a derived-only release without touching
raw regional objects, use `npm run publish:regional -- --derived-only --concurrency 6` and
`npm run audit:regional:remote -- --derived-only`.

The **national derived plane** is published to the same bucket and origin under the same shape -
`derived/corridor-metrics/<analysis-fingerprint>/` with one manifest object and one object per present cell -
and is the production discovery payload. Publish it with `npm run publish:national-derived -- --rate 4`
(resumable, checkpointed, idempotent), audit it with `npm run audit:national-derived:remote`, and verify the
published plane end to end with `npm run verify:national-derived:production` (six regions, real R2 objects,
DuckDB) plus `RUN_NATIONAL_PRODUCTION=1 npm run verify:national-derived:browser` (a real browser against R2).
Production discovery resolves it through `data/national/derived-catalog.json`, a small reviewed pointer
generated by `scripts/freeze-national-derived-catalog.mjs` and staged to Pages by `npm run stage:pages` (the
rest of `data/national/` stays out of the payload). Each search area declares the catalog it loads and its
type (`catalogType`), and the runtime validates a fetched catalog with that type's contract and only that one -
a national pointer is never read as a regional catalog and never coerced into the regional schema. The raw
national roads/wetlands/hydrography planes are not published: derived discovery needs only the derived plane,
and detailed promotion keeps reading the regional raw cells and fails closed where they are not published.
Rollback is additive - the regional catalog and its derived plane are untouched, so pointing
`interactiveRadiusArea` back at `regional-10mi` (or reverting that one commit) restores the previous discovery
plane without deleting any published object.

The whole release is one fail-closed chain:

```sh
npm run release:national-derived                                  # publish, audit, verify, deploy, browser-check, record
npm run release:national-derived -- --skip-publication --skip-audit
```

Each stage stops the chain on failure, and the browser gate is a gate: a non-zero production browser check
prints `CHAIN FAILED at production browser verification`, records the browser cutover as failed, and exits
non-zero - it never prints `CHAIN COMPLETE` and never records a passed browser verification. Before any browser
verdict the chain runs a **settle gate**: the deployed origin must serve the exact staged bytes of
`src/gis/service.js`, the catalog-selection modules, the national pointer and the declaration. That gate exists
because the first cutover's browser check ran inside the window where Pages still served the previous release's
frontend while the new national pointer was already live, so a national search was validated as a regional
catalog. `data/national/verification/derived-publication-status.json` (written by
`scripts/record-national-release-status.mjs`) keeps the two gates separate - R2 publication, verified by
re-fetching every published object, and browser cutover, verified by a real browser resolving that plane - so a
browser failure can never be recorded as a data failure, or the reverse.

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
npm run deploy:pages             # validates, stages, uploads, and names the command that verifies it
npm run verify:pages:release     # the settle gate: the origin must serve exactly the staged bytes
```

`deploy:pages` accepts a detached HEAD only when that HEAD is still exactly `origin/main` (a CI checkout of a push to
main), requires a clean tree, and refuses to run at all when `origin/main` cannot be read: a release must always be
able to say which commit it published. It authenticates with `CLOUDFLARE_API_TOKEN` when the environment sets one and
otherwise with the operator's logged-in `wrangler` session; it never reads or prints a credential itself.

The crawler files (`robots.txt`, `sitemap.xml`) and the homepage metadata are staged with the page and are gated by
`scripts/seo.mjs`: `stage:pages` refuses to build a payload whose canonical URL, meta description, Open Graph tags,
`WebApplication` JSON-LD, robots directives or sitemap disagree, or whose `_headers` stops marking the Pages
hostnames `noindex`. §9 describes the contract and the release procedure that applies it.

The staged payload includes the investigator probe catalog and its schema
(`data/investigator/probe-catalog.json`, `probe-catalog.schema.json`), because the browser Investigator loads them as
modules; `stage:pages` refuses to stage a payload without them. Catalog validation is a separate, offline step:
`npm run validate:probes`.

The discovery workspace adds three payloads of its own: the bounded road-network extract
(`data/gis/or-roads-network-2025.parquet`, a manifest dataset like the others), the declared search areas
(`data/discovery/search-areas.json`, which also declares the published region a chosen search centre is
classified against), and the discovery modules under `src/discovery/`. `stage:pages` refuses to stage
a payload without the search-area declaration, and the manifest byte check covers the extract. The national place
gazetteer is a fourth: three versioned assets loaded by path like the declaration — the core tier the workspace
loads in the background (`data/places/national-places.json`, 2.4 MB), and the postal-code and community tiers it
fetches the first time a query needs one (`national-places-zip.json`, 2.0 MB; `national-places-communities.json`,
8.6 MB). `stage:pages` refuses to stage a payload that lacks any of them, and it fails the deployment when a tier
is not a schema-2 national gazetteer, names the wrong tier, disagrees with its build report by byte or by row,
does not share one dictionary with the other tiers, or carries no populated places, counties, postal codes and
communities. The release chain settles the core and postal tiers at the deployed origin before any browser
verdict, so a browser written against one version and data from another cannot pass unnoticed. Nothing else about
them is special — they are static data on Pages, not R2 objects and not a Worker concern.

`stage:pages` fails the deployment rather than shipping a broken payload: every stylesheet/icon/script referenced by
`index.html`, every relative `import` in the `src/` module graph, and every dataset in `data/manifest.json` must be
present, and a staged dataset whose byte length disagrees with the manifest is a failure. `dist/` is gitignored and is
only ever replaced when it carries the `deployment.json` marker this script writes.

The raw region index (`data/national/raw-regions.json`) is the second small Pages file: `stage:pages` validates it with the runtime's own contract, stages it, and fails a release whose regions point at a derived catalog. It is what lets a promotion answer "is the raw source for this corridor online?" from one committed document instead of probing object URLs, and it is deliberately separate from the derived plane: partial raw coverage is a growing working set, never a failed discovery release. `npm run audit:national-raw` re-fetches every published region's catalog, its component closure and a sample cell, and reports anything that disagrees.

Order when both change: `npm test`, `npm run test:e2e`, commit, push, `npm run deploy:worker`, `npm run deploy:pages`.

The regional data planes are published and audited before a Pages release that reads them:

```sh
npm run verify:geometry                  # the shared repair ladder is still exact
npm run verify:regional-equivalence      # batch == detailed on the raw plane
npm run build:derived                    # only if the road network or the analysis semantics changed
npm run verify:derived                   # structural + geometric review of the built cells
npm run capture:derived-equivalence      # opt-in: capture a real derived-vs-raw-vs-detailed comparison
npm run verify:derived-equivalence       # derived == batch == detailed, offline, deterministic
npm run publish:regional -- --derived-only --concurrency 6  # immutable derived objects only
npm run audit:regional:remote -- --derived-only              # public bytes, digest, CORS, type and Range
npm run benchmark:derived                # opt-in: measured 10/25/50-mile derived discovery
```

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

### The browser-test server

`npm run test:e2e` serves the repository root from a threaded Python HTTP server on `127.0.0.1:8000`, started by the
Playwright configuration. Three details make that server's lifecycle deterministic, because a browser test that
runs against a half-dead origin fails as a mystery rather than as an error:

* **Threaded.** The application fetches many files at once (modules, GeoParquet extracts, regional partitions), and
  `python3 -m http.server` answers one request at a time: a page that navigates away mid-download leaves it writing
  to a dead socket, and every later request waits behind that one. `ThreadingHTTPServer` serves each connection on
  its own thread, as the real host does.
* **Its log goes to a file** (`test-server.log`, not committed), not to the runner's pipe. A run that is killed
  leaves the server alive, and a server whose stdout is a dead pipe raises `BrokenPipeError` on every log line -
  which is what turned an orphan into one that answered `ERR_EMPTY_RESPONSE` to everything, including the module
  requests a page needs to boot.
* **Health is checked with a URL, not a port.** `port: 8000` only asks whether something is listening, so a stale
  server that accepted connections and answered nothing was silently reused and every test then failed later as
  "element not found". The configuration waits for `http://127.0.0.1:8000/data/manifest.json`, so an unhealthy
  server stops the run before the first test:

  ```text
  Error: Process from config.webServer was not able to start. Exit code: 1
  ```

  A stale server is therefore never silently accepted. Kill it (`pkill -f ThreadingHTTPServer`) and run again, or
  inspect `test-server.log` to see what it was asked for.


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

**Update (2026-10-27).** Both custom domains now resolve and serve the Pages project: `https://roadnaturalist.com/`
and `https://www.roadnaturalist.com/` answer 200, and the bytes at the apex are identical to the Pages deployment and
to the commit under review (sha256 comparison). `roadnaturalist.com` is therefore the canonical host in the crawler
files, and the Pages hostnames are marked `X-Robots-Tag: noindex` (§9) so one page is not indexed twice.


## 9. Releasing the static site, and the crawler contract

The static site is released from a reviewed commit and verified afterwards from the canonical domain. Two paths run
the same gates: the manual command and the GitHub Actions workflow. The manual one stays the authority when the
workflow is unavailable.

### Manual release

```sh
npm test                                              # includes tests/seo.test.js: the crawler contract
npm run stage:pages                                   # validates and stages dist/ (no upload)
node scripts/verify-pages-release.mjs --staged        # the staged payload is self-consistent
git push origin main                                  # deploy:pages refuses a HEAD that is not origin/main
npm run deploy:pages                                  # uploads exactly the staged payload
npm run verify:pages:release                          # settle gate against https://roadnaturalist.com
node scripts/verify-pages-release.mjs --origin https://roadnaturalist.pages.dev
```

`verify:pages:release` polls `/`, `/robots.txt` and `/sitemap.xml` until they match the staged bytes — Pages serves
the previous deployment for a short window after an upload, so a single sample would describe the previous release —
then checks five application files the same way, the served content types, the crawler contract applied to the bytes
that were served, and `X-Robots-Tag` on the host that was asked. It never reports success for a partial match.

### What the crawler contract requires

| File | Requirement |
| --- | --- |
| `index.html` | one `<title>`; one canonical `https://roadnaturalist.com/`; one 50–300 character meta description; `robots: index, follow`; `og:type`, `og:site_name`, `og:url`, `og:title`, `og:description`, `twitter:card`, `twitter:title`, `twitter:description` |
| `index.html` JSON-LD | exactly one block, valid JSON, `@context` schema.org, `@type` `WebApplication`, `url` the canonical URL, `name` Road Naturalist, a description and an `applicationCategory`, `isAccessibleForFree: true`; never an invented `aggregateRating`, `review` or `ratingValue` |
| `robots.txt` | `User-agent: *`, `Allow: /`, only `/data/` disallowed, exactly one `Sitemap: https://roadnaturalist.com/sitemap.xml` |
| `sitemap.xml` | XML declaration, sitemap namespace, one `<loc>` per page (currently only the canonical root), every `<loc>` https on the canonical host with no query or fragment |
| `_headers` | `https://:project.pages.dev/*` and `https://:version.:project.pages.dev/*` carry `X-Robots-Tag: noindex`, so the canonical domain is the only indexable host |

There is one page, so the sitemap has one URL. Nothing on the site rates, reviews or prices itself, so the structured
data does not either. Both rules are enforced rather than documented only: `tests/seo.test.js` mutilates each of them
and asserts the gate fails, and `stage:pages` applies the same contract to `dist/` before anything can upload.

`dist/deployment.json` (the marker that lets `stage:pages` replace a `dist/` it created) is uploaded with the rest of
the payload, so it is publicly readable: it records file paths, sizes, digests, the commit and the artifact-verification
mode, never a credential.

### Automatic release from GitHub Actions (`deploy-pages.yml`)

On every push to `main` the workflow requires the deployment secret, installs the test runner, runs `npm test`,
stages the payload, verifies it offline, deploys with `npm run deploy:pages`, and then runs both settle gates
(`roadnaturalist.com` and `roadnaturalist.pages.dev`). It is a direct upload to the same Pages project: no second
project, no Git integration, no DNS change, and nothing that touches the Worker or the R2 data plane.

| Secret | Scope |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | a Cloudflare API token with `Account → Cloudflare Pages → Edit` for this account only — no `Zone → DNS`, no Workers, no R2, so a leaked release token cannot change DNS, the Worker or the data plane |
| `CLOUDFLARE_ACCOUNT_ID` | optional; the account that owns the Pages project (`b1aa310aa0a1638d72b8b086a21e557c`) |

Create the token in the dashboard (My Profile → API Tokens → Create Token → custom token), then
`gh secret set CLOUDFLARE_API_TOKEN --repo hmarquardt/roadnaturalist`, and re-run the workflow. Until the secret
exists the workflow fails at its first step with an explicit message: a push to `main` that cannot deploy is
reported, never skipped silently.

The guarantees the workflow preserves, and the one difference:

* the deployable commit is the pushed `main` commit and the working tree must be clean (`deploy:pages`);
* the uploaded payload is exactly what `stage:pages` produced, with every file digest recorded in `deployment.json`;
* production must serve exactly those bytes before the run can be green;
* **difference** — a CI checkout has no local GIS artifact plane (`.parquet` is gitignored and published to R2), so
  `stage:pages --published-artifacts` moves that gate from local bytes to the published objects: every declared
  object must be online with the declared length and content type, plus a four-object digest sample. The mode is
  recorded in `deployment.json` as `artifactVerification`, and full byte-level auditing of that plane remains
  `npm run audit:regional:remote`. Without the flag, a checkout missing those files fails exactly as before.

`verify:pages:release` does not verify browser behaviour. Application startup, map initialisation and representative
discovery stay with the opt-in browser gates in §5 and the `RUN_*_PRODUCTION` specs, run against the deployed origin.

### Rolling back

Pages keeps every deployment (`npx wrangler@4.135.0 pages deployment list --project-name roadnaturalist`), and the
dashboard can roll back to any of them. `deploy:pages` will not publish an older commit as production — it requires
HEAD to be `origin/main` — so the reviewed rollback is `git revert <commit>`, push, and let the release publish the
revert like any other commit.

