# Road Naturalist

Evidence-led research for biologically interesting road corridors. The pilot corridors use real road-centerline geometry from the U.S. Census Bureau TIGER/Line 2025 ROADS dataset, their EPA Level III/IV ecological context is calculated from real Oregon GIS polygons, and their physical habitat context is calculated from real U.S. Fish & Wildlife Service National Wetlands Inventory wetlands and U.S. Geological Survey hydrography. Geometry is not access: a mapped road is not a verified public or practical wildlife road cruise, and a mapped road/water intersection is not a bridge, a ford, or current water.

## Run locally

Use a local HTTP server because native ES modules and JSON fetches do not work reliably from `file://`:

```sh
npm run dev
```

Open <http://localhost:8000>. Click **Open Oregon road pilot** to load three real Oregon road corridors, retrieve their source road features, resolve EPA ecoregions, and analyze mapped wetlands and surface water at 250 m, 500 m, and 1 km. The map is a schematic coordinate grid with pan, zoom, and fit, plus an off-by-default habitat-layer toggle; it does not yet display a basemap. First GIS use requires network access for the pinned DuckDB-WASM bundle and Spatial extension. The GeoParquet files (ecoregions, roads, wetlands, hydrography) are served locally and verified by byte length and SHA-256 before use.

## Verify

```sh
npm install
npm test
npm run test:e2e
```

Node's test runner covers road, ecoregion, wetland, and hydrography artifacts and digests, geometry composition against real source coordinates, road/corridor provenance, per-dataset and per-buffer coverage semantics, habitat buffer math and units, candidate decisions, and the corridor → EPA/habitat query boundaries — all offline. Playwright checks desktop/mobile layout, the honest degraded state when DuckDB is unavailable, and one focused browser test with real DuckDB Spatial against the checked-in road pilot, EPA, wetland, and hydrography data, including agreement with the Python-side pilot expectations. `scripts/build-habitat.py --verify-artifacts` re-checks the committed habitat artifacts offline.

## Structure and deployment

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ROADS.md](docs/ROADS.md), [docs/ECOREGIONS.md](docs/ECOREGIONS.md), and [docs/HABITAT.md](docs/HABITAT.md). `index.html`, `assets/`, `src/`, and `data/` are the static site. A future Cloudflare Pages artifact should include only those paths. `scripts/` contains the reproducible offline preparation for both datasets; `worker/` is reserved for a justified secrets/proxy/API service. The canonical production domain is `roadnaturalist.com`; this feature does not deploy or create Cloudflare resources.
