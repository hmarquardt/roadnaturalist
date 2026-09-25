# Road Naturalist

Evidence-led research for biologically interesting road corridors. The pilot corridors use real road-centerline geometry from the U.S. Census Bureau TIGER/Line 2025 ROADS dataset, their EPA Level III/IV ecological context is calculated from real Oregon GIS polygons, and their physical habitat context is calculated from real U.S. Fish & Wildlife Service National Wetlands Inventory wetlands and U.S. Geological Survey hydrography, and their species occurrence evidence comes from public iNaturalist and eBird observations. Geometry is not access: a mapped road is not a verified public or practical wildlife road cruise, a mapped road/water intersection is not a bridge, a ford, or current water, and a public observation is not a prediction that a species is on the road.

## Run locally

Use a local HTTP server because native ES modules and JSON fetches do not work reliably from `file://`:

```sh
npm run dev
```

Open <http://localhost:8000>. Click **Open Oregon road pilot** to load three real Oregon road corridors, retrieve their source road features, resolve EPA ecoregions, analyze mapped wetlands and surface water at 250 m, 500 m, and 1 km, and query public species occurrence sources on demand at 1 km, 5 km, and 10 km. The map is a schematic coordinate grid with pan, zoom, and fit, plus off-by-default habitat and precise-occurrence map layers; it does not yet display a basemap. Occurrence queries are never automatic: they run only when you press the query button, so no biodiversity API is called during load. First GIS use requires network access for the pinned DuckDB-WASM bundle and Spatial extension. The GeoParquet files (ecoregions, roads, wetlands, hydrography) are served locally and verified by byte length and SHA-256 before use.

## Verify

```sh
npm install
npm test
npm run test:e2e
```

Node's test runner covers road, ecoregion, wetland, and hydrography artifacts and digests, geometry composition against real source coordinates, road/corridor provenance, per-dataset and per-buffer coverage semantics, habitat buffer math and units, candidate decisions, and the corridor → EPA/habitat query boundaries — all offline. Playwright checks desktop/mobile layout, the honest degraded state when DuckDB is unavailable, and one focused browser test with real DuckDB Spatial against the checked-in road pilot, EPA, wetland, and hydrography data, including agreement with the Python-side pilot expectations. `scripts/build-habitat.py --verify-artifacts` re-checks the committed habitat artifacts offline. Occurrence tests use captured iNaturalist response fixtures and a documented eBird contract fixture, and prove that obscured observations can never be measured or plotted.

Opt-in live verification (network):

```sh
npm run verify:occurrence:live      # source adapters; eBird prints SKIP without EBIRD_API_KEY
npm run verify:occurrence:browser   # full browser pipeline with real requests and real distances
```

## Structure and deployment

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ROADS.md](docs/ROADS.md), [docs/ECOREGIONS.md](docs/ECOREGIONS.md), [docs/HABITAT.md](docs/HABITAT.md), and [docs/OCCURRENCE.md](docs/OCCURRENCE.md). `index.html`, `assets/`, `src/`, and `data/` are the static site. A future Cloudflare Pages artifact should include only those paths. `scripts/` contains the reproducible offline preparation for both datasets; `worker/` is reserved for a justified secrets/proxy/API service. The canonical production domain is `roadnaturalist.com`; this feature does not deploy or create Cloudflare resources.
