# Road Naturalist

First survey an area for candidate corridors, then research the ones worth a closer look. **Discover roads** surveys the bounded Oregon pilot window from a real TIGER/Line 2025 road-network extract: it keeps the ordinary vehicular road classes, composes named roads, divides long ones into contiguous analysis corridors, and measures road, mapped-wetland, surface-water, and ecoregion facts for every corridor in one batched GIS pass — filterable, sortable, and explicitly covered, with no score, no ranking, and no recommendation. Promoting a corridor turns it into a normal candidate. The pilot corridors use real road-centerline geometry from the U.S. Census Bureau TIGER/Line 2025 ROADS dataset, their EPA Level III/IV ecological context is calculated from real Oregon GIS polygons, and their physical habitat context is calculated from real U.S. Fish & Wildlife Service National Wetlands Inventory wetlands and U.S. Geological Survey hydrography, and their species occurrence evidence comes from public iNaturalist and eBird observations. An Investigator then researches whether each corridor is actually a public road with ordinary motor-vehicle access, from identified sources of stated reliability — live in production through a small Cloudflare Worker that reads only declared official sources (never a URL a client supplies), with a reviewed capture as the fallback. Geometry is not access: a mapped road is not a verified public or practical wildlife road cruise, a mapped road/water intersection is not a bridge, a ford, or current water, a public observation is not a prediction that a species is on the road, and an access finding is dated, qualified evidence rather than a legal determination.

## Run locally

Use a local HTTP server because native ES modules and JSON fetches do not work reliably from `file://`:

```sh
npm run dev
```

Open <http://localhost:8000>. Click **Discover roads** to survey the bounded Oregon pilot area: the workspace reports discovery coverage, proposes the corridors it found, and lets you filter, sort, inspect one, and **Promote candidate** into the ordinary candidate list — no occurrence API and no access research happens during discovery. Then click **Open Oregon road pilot** to load three real Oregon road corridors, retrieve their source road features, resolve EPA ecoregions, analyze mapped wetlands and surface water at 250 m, 500 m, and 1 km, and query public species occurrence sources on demand at 1 km, 5 km, and 10 km. The map is a schematic coordinate grid with pan, zoom, and fit, plus off-by-default habitat and precise-occurrence map layers; it does not yet display a basemap. Occurrence queries are never automatic: they run only when you press the query button, so no biodiversity API is called during load. The same applies to **Access & road status**: it starts at `UNVERIFIED`, and pressing **Run access investigation** runs the seven-stage pipeline, which reads each declared official source through the Worker boundary (live, then cached) when one is configured — as it is in production — matches OpenStreetMap ways to the corridor geometry, and reports a qualified finding — `VERIFIED PUBLIC`, `PROBABLE PUBLIC`, `UNVERIFIED`, `CONFLICTED`, or `RESTRICTED OR CLOSED` — with its guardrail rule, restrictions, contradictions, unresolved items, evidence dates, and access-verification coverage. Locally, with no boundary configured, each source instead replays the reviewed operator capture and says so; either way, a source that could not be re-checked is never presented as freshly checked. A checkbox switches the OpenStreetMap step to a live query. **Export evidence bundle** downloads the versioned corridor evidence bundle as JSON. First GIS use requires network access for the pinned DuckDB-WASM bundle and Spatial extension. The GeoParquet files (ecoregions, roads, wetlands, hydrography) are served locally and verified by byte length and SHA-256 before use.

The **Portland west region (partitioned)** option surveys a larger real Oregon window through the spatial catalog. It selects road and habitat cells plus a 1 km analysis halo, reports partition count and transferred size, then uses the existing discovery, promotion and detailed habitat flow. Local development serves the same versioned files from `data/regional/` that production serves from `data.roadnaturalist.com`. See [regional data architecture](docs/REGIONAL-DATA.md) for the build, provenance and measured limits.

## Verify

```sh
npm install
npm test
npm run test:e2e
npm run verify:regional
npm run verify:geometry
```

Node's test runner covers road, ecoregion, wetland, and hydrography artifacts and digests, geometry composition against real source coordinates, road/corridor provenance, per-dataset and per-buffer coverage semantics, habitat buffer math and units, candidate decisions, and the corridor → EPA/habitat query boundaries — all offline. Discovery tests cover road eligibility, duplicate and reversed-link collapse, named-road units, contiguous segmentation and stable ids, the set-oriented batch analysis (statement shape and row mapping), discovery coverage semantics, filters and explicit sorts, the lifecycle and promotion into the ordinary candidate pipeline, the offline extraction summary the browser is checked against, and that no discovery code path can reach an occurrence or Investigator source. Playwright checks desktop/mobile layout, the honest degraded state when DuckDB is unavailable, a real discovery run (counts, filters, sorts, selection, map, promotion, batch-versus-detailed agreement, and zero external requests), and one focused browser test with real DuckDB Spatial against the checked-in road pilot, EPA, wetland, and hydrography data, including agreement with the Python-side pilot expectations. `scripts/build-habitat.py --verify-artifacts` re-checks the committed habitat artifacts offline. Occurrence tests use captured iNaturalist response fixtures and a documented eBird contract fixture, and prove that obscured observations can never be measured or plotted. Worker tests cover the endpoint's security properties (no client URL, unknown ids refused without contacting anything, redirects off an approved host blocked, oversized or wrongly typed bodies refused, timeouts and throttling reported as failures, no credential or page body returned), its cache and rate limits, and its extraction equivalence with the browser. Investigator tests cover the access vocabulary and evidence shape, all nine finding guardrail rules (including "an anecdotal report never overrides an authoritative restriction" and "community mapping alone cannot reach the strongest state"), freshness and expiry, the advisory and adversarial checks, coverage versus finding, the Overpass adapter and mirror-failure handling, the corridor↔way matching metrics, the versioned bundle and its validation rules, and a fixture-backed run of the real pipeline for all three corridors. The UI tests cover the unverified default, a current closure, a recurring closure, a partly covered corridor, the human review record, bundle export, and a phone-width layout.

Opt-in live verification (network):

```sh
npm run verify:occurrence:live      # source adapters; eBird prints SKIP without EBIRD_API_KEY
npm run verify:occurrence:browser   # full browser pipeline with real requests and real distances
npm run verify:investigator:live    # live official sources + live OpenStreetMap for the access findings
npm run verify:investigator:worker  # the Worker research boundary (DEPLOYED via INVESTIGATOR_WORKER_URL, else the same handler served locally)
npm run verify:production:browser   # the deployed app in a real browser, against the deployed Worker and real sources
npm run validate:probes            # the investigator probe catalog: schema, semantics, Worker policy, capture/baseline
npm run verify:geometry            # offline: the shared analytical-geometry repair boundary against the real failures
npm run investigator:refresh       # validate the catalog, retrieve declared sources, rewrite the capture + drift baseline
npm run build:regional             # rebuild regional GeoParquet from pinned local source archives
node scripts/audit-regional-remote.mjs # read-only public R2 SHA/CORS/Range audit
```

## Structure and deployment

Regional analytical GeoParquet lives in the Road Naturalist-owned `roadnaturalist-data` R2 bucket at `data.roadnaturalist.com`. Pages carries the spatial catalog but does not stage the regional Parquet files. The Investigator Worker remains a separate research service and does not proxy GIS data.

The Investigator's declared official sources are a reviewed data catalog
(`data/investigator/probe-catalog.json`, with a committed JSON Schema) that both the browser Investigator and the
deployed Worker load through one loader, so adding a corridor's sources is a data review: `npm run validate:probes`
checks the catalog, the Worker's host allow-list, and the recorded evidence offline. Worker fetch policy — allowed
hosts, byte caps, timeouts, redirects, and cache lifetimes — stays server-side and cannot be set from the catalog.

Both halves deploy from this repository with no build step: `npm run deploy:pages` (Cloudflare Pages project `roadnaturalist`, for `roadnaturalist.com`) and `npm run deploy:worker` (Worker `roadnaturalist-investigator`, for `api.roadnaturalist.com`). [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) has the topology, configuration, commands, verification, and local-development story.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/ROADS.md](docs/ROADS.md), [docs/DISCOVERY.md](docs/DISCOVERY.md), [docs/ECOREGIONS.md](docs/ECOREGIONS.md), [docs/HABITAT.md](docs/HABITAT.md), [docs/OCCURRENCE.md](docs/OCCURRENCE.md), and [docs/INVESTIGATOR.md](docs/INVESTIGATOR.md). `index.html`, `assets/`, `src/`, and `data/` are the static site, deployed to the Cloudflare Pages project `roadnaturalist` for `roadnaturalist.com`; `worker/` is the one backend, deployed as the Worker `roadnaturalist-investigator` at `api.roadnaturalist.com`, which reads only declared official sources so the browser never needs CORS access to a county site. Both deploy from this repository with `npm run deploy:pages` and `npm run deploy:worker`; [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) holds the topology, configuration, commands, and verification steps. `scripts/` contains the reproducible offline preparation for the datasets, the deploy staging, and the opt-in live checks.
