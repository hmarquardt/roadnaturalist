# Road Naturalist

Evidence-led research for biologically interesting road corridors. The sample road is synthetic, but its EPA Level III/IV ecological context is calculated from real Oregon GIS polygons. It is not a road or wildlife recommendation.

## Run locally

Use a local HTTP server because native ES modules and JSON fetches do not work reliably from `file://`:

```sh
npm run dev
```

Open <http://localhost:8000>. Click **Open sample corridor** to exercise the vertical slice and load its EPA context. The map is a schematic coordinate grid with pan, zoom, and fit; it does not yet display a basemap. First GIS use requires network access for the pinned DuckDB-WASM bundle and Spatial extension. The Oregon GeoParquet files are served locally.

## Verify

```sh
npm install
npm test
npm run test:e2e
```

Node's test runner covers candidate geometry, coverage, manifest digests, and occurrence boundaries. Playwright checks desktop/mobile UI offline under simulated GIS unavailability and runs one focused browser test with real DuckDB Spatial and the checked-in EPA data.

## Structure and deployment

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ECOREGIONS.md](docs/ECOREGIONS.md). `index.html`, `assets/`, `src/`, and `data/` are the static site. A future Cloudflare Pages artifact should include only those paths. `scripts/` contains the reproducible offline EPA preparation; `worker/` is reserved for a justified secrets/proxy/API service. The canonical production domain is `roadnaturalist.com`; this feature does not deploy or create Cloudflare resources.
