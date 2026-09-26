# Regional discovery data: decision record

## Decision before implementation

The target is an arbitrary bounded search, up to a 50-mile radius, with 1 km road-buffer analysis. The current 25 × 18 km pilot proves the SQL but requires its complete road, NWI and NHD extracts on every discovery run. Six options were considered:

| Approach | Fit for Road Naturalist |
| --- | --- |
| Larger county/state files | Simple publication, but small viewports would transfer unrelated roads and habitat. A state NWI file is especially unsuitable. |
| Fixed spatial cells | Bounds and 1 km halo select only nearby bytes. Works across counties and HU8s; requires explicit feature deduplication and road continuity. |
| County/HU8/EPA partitions | Useful source-ingestion boundaries, poor query boundaries: arbitrary windows straddle them and partition sizes vary sharply. |
| Source/admin → spatial cells | Retains pinned county/HU8/state inputs for ingestion and emits a common spatial query grid. Selected. |
| Worker-side discovery | Avoids client GIS data but introduces a second compute runtime, query cost and deployment complexity. The existing Investigator Worker cannot run DuckDB server-side as-is. Reconsider only if measured browser limits demand it. |
| Browser-side partitioned DuckDB | Reuses proven deterministic SQL, static hosting and local reproduction. Selected with the hybrid build above. |

Use a 0.2° longitude × 0.2° latitude anchored grid for this Oregon vertical slice. At 45.6° N a cell is roughly 15.5 × 22.2 km. IDs encode the southwest grid indices, so they are reproducible and human-debuggable. The grid is a storage index; the road corridor remains the domain unit. Whole source features are replicated into every cell their geometry intersects and are deduplicated by `(county_fips, source_feature_id, part)` for roads, `source_feature_id` for NWI, and `(layer, source_feature_id)` for NHD before analysis. The county key matters: the pinned county archives contain ten `source_feature_id`/`part` collisions across their boundary. This preserves original geometry and avoids seam slivers. The build records a road-name-to-cell index; selection includes every cell containing a selected name before composition, preserving cross-cell road continuity and IDs within the published region. Its overfetch cost will be measured.

For roads, select cells intersecting the requested bounds, then close over the road-name cell index. For habitat, expand requested bounds by at least 1,000 m before selecting cells. The halo is applied to selection, never to the candidate's canonical geometry. An absent required artifact, digest mismatch or query failure is `UNKNOWN`, not zero. A search extending beyond published regional coverage is `NONE` or `PARTIAL` according to overlap. Every manifest cell has a declared state, including explicitly empty cells.

Keep the small manifest on the application host; immutable versioned GeoParquet belongs on a Road Naturalist R2 data origin for production. Local development uses the same manifest and paths with a different asset base. Verified bytes are registered once per browser session. Persistent cache and derived metrics are deferred until timings show they help. EPA's small Oregon statewide files remain whole and are shared by all regional runs. Discovery and promoted-corridor habitat detail use the selected regional partitions through the established GIS service boundary.

## Published vertical slice

The source window is `[-123.16, 45.46, -122.68, 45.73]`, west of Portland, overlapping the original pilot. The offered regional search is inset to `[-123.14, 45.48, -122.70, 45.71]` so its 1 km habitat halo remains inside the published source window. The cells are 3 columns × 2 rows (`x284..286`, `y677..678`). A smaller arbitrary bounds object can use the same catalog and service without another data build. This first source window is about 37 × 30 km; it is a genuine multi-cell proof, not a 50-mile-radius release.

`data/regional/manifest.json` (schema 2) is the spatial catalog. Its dataset entries declare version, format, schema, CRS, source dataset and source agency; each cell declares ID, bounds, present/empty state, feature count, URL, byte count and SHA-256. The catalog also declares the source window, 1 km maximum analysis distance, grid, normalization version, and road-name-to-cell/bounds index. EPA Oregon Level III/IV remain the existing statewide GeoParquet files in `data/manifest.json`: at 0.46 and 2.25 MB, splitting them would add complexity without helping this region. The regional catalog is served by Pages; `assetBaseUrl` points immutable partition paths to `https://data.roadnaturalist.com/`. On localhost the base resolves to `./data/`; selection, digests and SQL are identical.

| Dataset | Unique rows | Stored rows | Replicated rows | Cells | Exact bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| TIGER roads | 11,322 | 11,531 | 209 | 6 | 2,938,482 |
| NWI wetlands | 7,480 | 7,614 | 134 | 6 | 6,269,100 |
| NHD hydrography | 13,465 | 13,634 | 169 | 6 | 15,679,995 |
| Total | | | | 18 | 24,887,577 |

The cell count is deliberately small for the first release. The fixed grid can continue outside this window, but a 50-mile disk would select many more cells and road groups. Road group closure overfetches: even the 7 × 7 km viewport selects four road cells because full same-name groups must be present before composition. This is measured and preferable to silently cutting roads at a tile seam; an offline road-unit index is the next way to reduce it. `roadNameBounds` narrows the manifest closure to groups whose overall bounds intersect the search. A very common name may still have disconnected components over a broad area.

The source window itself is a separate boundary from the cell seams. The pinned regional reader includes road features from the declared window and does not prove that a named road is complete beyond that outer edge. Corridor habitat coverage is marked `PARTIAL` where its buffer leaves the source window, but future builds should add a road ingestion margin and explicit outer-edge road-continuity validation before treating near-edge road composition as complete.

## Build and review

The pinned sources and exact source digests remain in `data/manifest.json`, [roads](ROADS.md) and [habitat](HABITAT.md): TIGER/Line 2025 county ROADS for Washington/Multnomah; May 2026 Oregon NWI GeoPackage; December 2023 NHD HR HU8 `17090010` and `17090012`. `scripts/build-regional.py` invokes the established source readers once per source window, verifies their pinned archives, normalizes/clips them once to the regional source window, then replicates complete normalized features to intersecting cells and writes Zstd GeoParquet. NWI selection uses the source GeoPackage R-tree, avoiding a fresh 1.9 GB ZIP parse for each tile. The regional output is owned by Road Naturalist; the reference projects are read only. Geometry is EPSG:4326 WKB with GeoParquet metadata; area and distance analysis remains EPSG:5070.

```sh
npm run build:regional       # requires pinned archives under /tmp/rn-habitat-sources and /tmp/roadnaturalist-road-sources
npm run verify:regional      # every cell: byte count, digest, CRS, validity, bounds, schema, unique source keys
npm run verify:geometry      # shared analytical repair regression
node scripts/audit-regional-remote.mjs  # optional read-only R2 GET/SHA/CORS/Range audit
npm run stage:pages          # validates local files but excludes regional Parquet from Pages payload
```

The builder reuses the pilot readers and does not modify pilot artifacts. New publishes must use a new version prefix (`or-portland-west-v2`, etc.) if bytes change: remote paths are treated as immutable. Validate local artifacts, upload each to the Road Naturalist bucket with `application/vnd.apache.parquet` and `Cache-Control: public, max-age=31536000, immutable`, audit all remote bytes, then update the catalog. Do not overwrite a published key with different bytes. A production browser smoke check must precede any Pages deployment that exposes a new catalog. `npm run deploy:pages` was **not** run in this task.

The verifier found ten road `(source_feature_id, part)` collisions across the two county archives. Road deduplication therefore includes `county_fips`. It also proves all replicated NWI and NHD keys have identical geometry, so the GIS layer's `row_number() ... PARTITION BY` relation removes the exact whole-feature replicas before area, length and count queries. Cells never clip a feature at their own boundary; only the overall source window is clipped for NWI/NHD. A road crossing cell boundaries is composed after the selected road cells are unioned. The road-name closure ensures all published pieces of that name are loaded; group component and segment IDs derive from the reconstructed geometry, not tile IDs.

## Runtime and coverage

`src/discovery/regional-catalog.js` validates and selects cells. Road cells intersect the requested bounds, followed by name-group closure. Habitat cells intersect the requested bounds padded by 1,000 m using the shared conservative padding helper. `src/gis/service.js` fetches and checks every required cell, registers each verified buffer once per session, and gives road, wetland and hydro queries a logical deduplicated relation. The analysis SQL remains in `src/gis/`, and discovery still performs zero iNaturalist, eBird, Overpass or Investigator requests. EPA runs through the existing statewide GIS path. Promoted candidates retain their regional catalog reference so detailed habitat and overlay analysis use the same regional cells.

All required regional cells are verified before a result is published. `FULL` means the search and its habitat halo lie inside the declared source region and all selected artifacts were verified/read; it does not mean that NWI maps every actual wetland. A composed road can extend beyond the search box: each corridor's habitat coverage is separately downgraded to `PARTIAL` when its own 1 km buffer leaves the published region. `PARTIAL` otherwise means the requested bounds or halo leaves the published region; `NONE` means the search is outside it; `UNKNOWN` means manifest, fetch, digest, SQL or engine failure prevents a result. Failed data never becomes a zero-wetland or zero-road claim. The current six cells all contain records. Sparse-region all-empty multi-cell queries will need a typed empty relation before this catalog format is extended to such a region; that case is not claimed as working here.

The regional road reader has a 100,000-feature guard. It requests one extra row and reports `UNKNOWN` if the guard is reached, so a truncated road network is never labeled complete.

The browser currently caches verified partition registrations for one session. It uses full GET + byte/SHA validation; R2 supports Range (`206` verified), but direct DuckDB HTTP range reads are not part of the active path because they would bypass this explicit integrity check. Browser HTTP cache may help across sessions, but there is no IndexedDB/OPFS application cache yet. Derived discovery metrics are not cached: they require a key containing road, NWI, NHD, EPA, buffer-profile, segmentation and geometry-repair versions. Once a 50-mile workload is measured, a versioned static derived metrics layer is a better next experiment than an unvalidated Worker DuckDB runtime.

## Cloudflare and scale

The Road Naturalist bucket is `roadnaturalist-data` (Standard class) with the direct custom domain `data.roadnaturalist.com`. The bucket CORS policy is versioned at `config/regional-r2-cors.json`. Its 18 objects were audited byte-for-byte on the public domain: 24,887,577 bytes, matching SHA-256 and CORS, with a `206` Range GET. No Pages deployment and no Investigator Worker change occurred. The analytical partitions and catalog are committed; raw NWI/NHD/TIGER archives remain outside Git. Pages staging excludes the 18 regional Parquet files. The Investigator Worker remains solely for declared research sources. There is no R2 binding to that Worker and no GIS Worker compute.

Cloudflare's [R2 pricing](https://developers.cloudflare.com/r2/pricing/) currently lists 10 GB-month Standard storage, 1 million Class A operations and 10 million Class B operations in the monthly free tier, with free egress. This 24.9 MB/18-object pilot is far below those allowances; future economics are more likely to be driven by request count/cache behavior than storage. Direct custom-domain R2 CORS and its cache caveats follow [Cloudflare's CORS documentation](https://developers.cloudflare.com/r2/buckets/cors/). Edge cache HIT behavior was not measured, so no savings from it are assumed.

## Performance and mode boundary

Performance budgets set for this pass: viewport searches should stay below 10 MB and about 10 seconds on the development machine; this 34 × 26 km regional extent should stay below 30 MB and about 45 seconds once; 25- and 50-mile-radius searches must be measured before being offered as browser options. The actual window is smaller than a 25-mile-radius disk, so no measured 25- or 50-mile performance claim is made.

| Search | Selected cells (road/NWI/NHD) | Transfer | Corridors | Cold browser elapsed | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| 7 × 7 km viewport | 4/1/1 | 4.60 MB | 52 | 5.2 s | DuckDB/Spatial initialization 2.2 s; browser JS heap 76.6 MB. |
| Medium 20 × 17 km extent | 6/4/4 | 22.15 MB | 198 | 22.9 s | DuckDB/Spatial initialization 2.6 s; wetland and hydro batch phases 9.3 and 8.4 s; JS heap 81.4 MB. |
| Regional 34 × 26 km | 6/6/6 | 24.89 MB | 375 | 37.6 s | DuckDB/Spatial initialization 2.4 s; measured batch query 13.2 s; browser JS heap 56.8 MB (does not include WASM memory). |

These are separate cold Chromium contexts on the development machine, measured by `tests/regional.spec.js` after the group-bounds index was added. The regional test includes selection, candidate promotion and detailed analysis, a missing-partition failure, and zero external evidence calls. JavaScript heap numbers are indicative only; Chromium's `performance.memory` omits DuckDB WASM/native allocation and there was no reliable peak process RSS measurement. Repeated searches in one tab reuse registered verified buffers, but cold timings above do not claim a persistent cache benefit.

The instrumented 7 × 7 km run spent 7 ms fetching its manifest, 2 ms selecting cells, 2.36 s preparing partitions (including 2.30 s DuckDB/Spatial initialization), 34 ms fetching 4.60 MB of local Parquet, 3 ms hashing, and 21 ms registering buffers. The 20 × 17 km run spent 6 ms on the manifest, 3 ms on selection, 2.39 s preparing (including 2.28 s initialization), 75 ms fetching 22.15 MB locally, 11 ms hashing, and 20 ms registering. Its wetland and hydrography SQL phases dominated at 9.15 s and 7.96 s. These localhost fetch timings do not predict R2 network transfer time; the browser/R2 check separately verified fetch, CORS, bytes and digest. Render is included in the first UI test's wall-clock time but was not isolated as its own phase.

| Scale | Present decision |
| --- | --- |
| Viewport / approximately 0–10 miles | Browser partitioned DuckDB is comfortable on the tested machine; keep in-session verified-buffer reuse. |
| Approximately 10–20 miles | Browser mode remains usable but should show phase progress; measure lower-end devices and memory before widening the preset. |
| Approximately 25 miles | Not yet demonstrated. An R2 partition catalog alone does not guarantee acceptable latency. |
| 50-mile radius / county+ | Do not offer a blind browser scan yet. First benchmark a real wider source window; likely use immutable precomputed corridor metrics plus browser detail queries, not the Investigator Worker. |

For Fruiting Forecast, the transferable parts were lazy DuckDB-WASM/Spatial, verified buffer registration, GeoParquet, manifest-host versus asset-host separation, R2 custom domain/CORS/Range, and explicit coverage and provenance. We did not copy its single-file runtime, square biological tile domain, OPFS database tables or 64-record IndexedDB cache. Its production notes correctly warned that Range support is distinct from proving efficient DuckDB range reads; Road Naturalist keeps full verified GETs until measured evidence justifies a different integrity path.
