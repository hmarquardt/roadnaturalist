# Road Naturalist

Evidence-led research for biologically interesting road corridors. The pilot corridors use real road-centerline geometry from the U.S. Census Bureau TIGER/Line 2025 ROADS dataset, their EPA Level III/IV ecological context is calculated from real Oregon GIS polygons, and their physical habitat context is calculated from real U.S. Fish & Wildlife Service National Wetlands Inventory wetlands and U.S. Geological Survey hydrography, and their species occurrence evidence comes from public iNaturalist and eBird observations. An Investigator then researches whether each corridor is actually a public road with ordinary motor-vehicle access, from identified sources of stated reliability — live through a small Cloudflare Worker that reads only declared official sources (never a URL a client supplies), or by replaying a reviewed capture when no boundary is configured. Geometry is not access: a mapped road is not a verified public or practical wildlife road cruise, a mapped road/water intersection is not a bridge, a ford, or current water, a public observation is not a prediction that a species is on the road, and an access finding is dated, qualified evidence rather than a legal determination.

## Run locally

Use a local HTTP server because native ES modules and JSON fetches do not work reliably from `file://`:

```sh
npm run dev
```

Open <http://localhost:8000>. Click **Open Oregon road pilot** to load three real Oregon road corridors, retrieve their source road features, resolve EPA ecoregions, analyze mapped wetlands and surface water at 250 m, 500 m, and 1 km, and query public species occurrence sources on demand at 1 km, 5 km, and 10 km. The map is a schematic coordinate grid with pan, zoom, and fit, plus off-by-default habitat and precise-occurrence map layers; it does not yet display a basemap. Occurrence queries are never automatic: they run only when you press the query button, so no biodiversity API is called during load. The same applies to **Access & road status**: it starts at `UNVERIFIED`, and pressing **Run access investigation** runs the seven-stage pipeline, which replays the reviewed operator capture of official sources (a browser cannot read county sites that send no CORS header, so those sources are reported as *deferred* rather than freshly checked), matches OpenStreetMap ways to the corridor geometry, and reports a qualified finding — `VERIFIED PUBLIC`, `PROBABLE PUBLIC`, `UNVERIFIED`, `CONFLICTED`, or `RESTRICTED OR CLOSED` — with its guardrail rule, restrictions, contradictions, unresolved items, evidence dates, and access-verification coverage. A checkbox switches the OpenStreetMap step to a live query. **Export evidence bundle** downloads the versioned corridor evidence bundle as JSON. First GIS use requires network access for the pinned DuckDB-WASM bundle and Spatial extension. The GeoParquet files (ecoregions, roads, wetlands, hydrography) are served locally and verified by byte length and SHA-256 before use.

## Verify

```sh
npm install
npm test
npm run test:e2e
```

Node's test runner covers road, ecoregion, wetland, and hydrography artifacts and digests, geometry composition against real source coordinates, road/corridor provenance, per-dataset and per-buffer coverage semantics, habitat buffer math and units, candidate decisions, and the corridor → EPA/habitat query boundaries — all offline. Playwright checks desktop/mobile layout, the honest degraded state when DuckDB is unavailable, and one focused browser test with real DuckDB Spatial against the checked-in road pilot, EPA, wetland, and hydrography data, including agreement with the Python-side pilot expectations. `scripts/build-habitat.py --verify-artifacts` re-checks the committed habitat artifacts offline. Occurrence tests use captured iNaturalist response fixtures and a documented eBird contract fixture, and prove that obscured observations can never be measured or plotted. Worker tests cover the endpoint's security properties (no client URL, unknown ids refused without contacting anything, redirects off an approved host blocked, oversized or wrongly typed bodies refused, timeouts and throttling reported as failures, no credential or page body returned), its cache and rate limits, and its extraction equivalence with the browser. Investigator tests cover the access vocabulary and evidence shape, all nine finding guardrail rules (including "an anecdotal report never overrides an authoritative restriction" and "community mapping alone cannot reach the strongest state"), freshness and expiry, the advisory and adversarial checks, coverage versus finding, the Overpass adapter and mirror-failure handling, the corridor↔way matching metrics, the versioned bundle and its validation rules, and a fixture-backed run of the real pipeline for all three corridors. The UI tests cover the unverified default, a current closure, a recurring closure, a partly covered corridor, the human review record, bundle export, and a phone-width layout.

Opt-in live verification (network):

```sh
npm run verify:occurrence:live      # source adapters; eBird prints SKIP without EBIRD_API_KEY
npm run verify:occurrence:browser   # full browser pipeline with real requests and real distances
npm run verify:investigator:live    # live official sources + live OpenStreetMap for the access findings
npm run verify:investigator:worker  # the Worker research boundary (DEPLOYED via INVESTIGATOR_WORKER_URL, else the same handler served locally)
```

## Structure and deployment

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ROADS.md](docs/ROADS.md), [docs/ECOREGIONS.md](docs/ECOREGIONS.md), [docs/HABITAT.md](docs/HABITAT.md), [docs/OCCURRENCE.md](docs/OCCURRENCE.md), and [docs/INVESTIGATOR.md](docs/INVESTIGATOR.md). `index.html`, `assets/`, `src/`, and `data/` are the static site; `worker/` is the one backend, implemented and not deployed (see [worker/README.md](worker/README.md)). A future Cloudflare Pages artifact should include only those paths. `scripts/` contains the reproducible offline preparation for both datasets; `worker/` is reserved for a justified secrets/proxy/API service. The canonical production domain is `roadnaturalist.com`; this feature does not deploy or create Cloudflare resources.
