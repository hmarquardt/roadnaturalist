# Road Naturalist

Evidence-led research for biologically interesting road corridors. The pilot corridors use real road-centerline geometry from the U.S. Census Bureau TIGER/Line 2025 ROADS dataset, and their EPA Level III/IV ecological context is calculated from real Oregon GIS polygons. Geometry is not access: a mapped road is not a verified public or practical wildlife road cruise.

## Run locally

Use a local HTTP server because native ES modules and JSON fetches do not work reliably from `file://`:

```sh
npm run dev
```

Open <http://localhost:8000>. Click **Open Oregon road pilot** to load three real Oregon road corridors, retrieve their source road features and resolve EPA ecoregions. The map is a schematic coordinate grid with pan, zoom, and fit; it does not yet display a basemap. First GIS use requires network access for the pinned DuckDB-WASM bundle and Spatial extension. The Oregon GeoParquet files (ecoregions and roads) are served locally and verified by byte length and SHA-256 before use.

## Verify

```sh
npm install
npm test
npm run test:e2e
```

Node's test runner covers road-source artifacts and digests, geometry composition against real source coordinates, road/corridor provenance, coverage semantics, candidate decisions, and the real corridor → EPA query boundary — all offline. Playwright checks desktop/mobile layout, the honest degraded state when DuckDB is unavailable, and one focused browser test with real DuckDB Spatial, the checked-in road pilot, and the checked-in EPA data.

## Structure and deployment

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ROADS.md](docs/ROADS.md), and [docs/ECOREGIONS.md](docs/ECOREGIONS.md). `index.html`, `assets/`, `src/`, and `data/` are the static site. A future Cloudflare Pages artifact should include only those paths. `scripts/` contains the reproducible offline preparation for both datasets; `worker/` is reserved for a justified secrets/proxy/API service. The canonical production domain is `roadnaturalist.com`; this feature does not deploy or create Cloudflare resources.
