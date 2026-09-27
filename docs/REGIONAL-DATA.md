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

The builder reuses the pilot readers and does not modify pilot artifacts. New publishes must use a new version prefix (`or-portland-west-v2`, etc.) if bytes change: remote paths are treated as immutable. Validate local artifacts, upload each to the Road Naturalist bucket with `application/vnd.apache.parquet` and `Cache-Control: public, max-age=31536000, immutable`, audit all remote bytes, then update the catalog. Do not overwrite a published key with different bytes. A production browser smoke check must precede any Pages deployment that exposes a new catalog. The wider window (`or-sw-wa-portland-v2`) went through the same path: the catalog was verified locally with `npm run verify:regional`, **381 objects / 826 MiB** were published to the existing `roadnaturalist-data` bucket under immutable versioned keys with `application/vnd.apache.parquet` and `Cache-Control: public, max-age=31536000, immutable`, and the public read-only audit (`npm run audit:regional:remote`) re-read and SHA-256 checked every object over `https://data.roadnaturalist.com/`: **381 objects, 866,158,057 bytes, every digest and CORS header valid, and a Range GET answering 206**. No other Cloudflare resource was touched and the Investigator Worker was not deployed. The frontend was **not** redeployed in this pass, so production still
serves the previous catalog (which continues to point at its own published objects, all of which still audit
clean); the wider catalog goes live with the next `npm run deploy:pages`, and `npm run stage:pages` already
validates the full local artifact set while keeping regional Parquet out of the Pages payload. The wider partitions are served from R2 rather than committed to Git; `npm run build:regional` rebuilds them from the pinned sources in about three minutes, and `npm run verify:regional` reviews the committed catalog structure when the local copies are absent.

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

| Scale | Decision after the wider-window benchmarks (see the final section) |
| --- | --- |
| Viewport / approximately 0–10 miles | **Superseded.** The final section shows a 10-mile *radius* search at 91 s cold once the cells are complete for a two-state window: this row was a claim about a narrow window, not about a radius. |
| Approximately 10–20 miles | Superseded by the same measurement; the binding cost is buffered habitat analysis, not the browser's data plane. |
| Approximately 25 miles | **Measured and not offerable raw**: 202 MB selected, stopped by the feature guard in 4.2 s. |
| 50-mile radius / county+ | **Measured and not offerable raw**: 769 MB / ~724k features selected. Immutable derived corridor metrics are the measured next step, not the Investigator Worker. |

For Fruiting Forecast, the transferable parts were lazy DuckDB-WASM/Spatial, verified buffer registration, GeoParquet, manifest-host versus asset-host separation, R2 custom domain/CORS/Range, and explicit coverage and provenance. We did not copy its single-file runtime, square biological tile domain, OPFS database tables or 64-record IndexedDB cache. Its production notes correctly warned that Range support is distinct from proving efficient DuckDB range reads; Road Naturalist keeps full verified GETs until measured evidence justifies a different integrity path.

## Wider window and the real scale benchmarks

The first slice was too small to say anything about 25- or 50-mile searches, so the source window was
widened to `[-124.05, 44.75, -121.77, 46.42]` (about 180 x 180 km) around the original pilot. The window is
published as **`or-sw-wa-portland-v2`**; the earlier slice stays published as
`data/regional/manifest-or-portland-west-v1.json` so its measurements remain reproducible and its objects
remain auditable. `data/regional/manifest.json` is now the wider region.

What the wider window required, all from the same pinned products:

| Dimension | First slice | Wider window |
| --- | --- | --- |
| TIGER/Line county ROADS archives | 2 (Oregon) | 20 (14 Oregon, 6 Washington) |
| NWI state extracts | Oregon | Oregon **and Washington** |
| NHD HR HU8 basins | 2 | 23 |
| Working grid (0.2 degrees) | 6 cells | 130 cells |
| Partition objects | 18 | 381 (124 road, 130 wetland, 127 hydrography) |
| Partition bytes | 24.9 MB | 826 MiB |

Washington is not optional: the pilot sits about 3 km from the Columbia River, so *any* 50-mile disk around
it crosses into Washington, and an Oregon-only wetland extract would report a silent zero for those
corridors. For the same reason EPA ecoregions are now built for both states
(`epa-ecoregions-wa-l3/l4`, from the same EPA per-state source as Oregon) and *a level is answered from the
union of its declared layers*: a corridor on either side of the river finds its ecoregion instead of a
state-line gap. That union is used by the discovery batch and by the detailed corridor panel alike.

Empty cells are first-class: `x279_y676..680` and `x291_y682` hold no road features, and three cells hold no
hydrography, because they are almost entirely Pacific Ocean. A selected cell the catalog declares
valid-and-empty produces a **typed empty relation** built from the catalog's declared column schema, so a
search that only covers ocean cells returns zero measured features with the cells covered - not a SQL
failure, not UNKNOWN, and not a missing table. A cell declared *present* whose object is missing or has the
wrong digest is still a failure.

Build (measured, one pass over each source; `data/regional/build-or-sw-wa-portland-v2.json`):

| Phase | Time |
| --- | --- |
| verify pinned archives | 2.0 s |
| read 20 TIGER county archives | 6.5 s |
| read 2 NWI state GeoPackages (R-tree per state) | 81 s |
| read 23 NHD HU8 basins | 40 s |
| partition into 130 cells x 3 datasets | 48 s |
| **total** | **177 s** |

Cell membership is decided in one indexed pass (an STRtree over the 0.2 degree cells) instead of a
rows x cells scan, and a logical feature that two adjacent NHD basins both carry is kept once, in basin
code order, so the published dataset is exactly one row per logical feature.

### Committed benchmark scenarios

`data/regional/benchmarks.json` fixes the scenarios; `data/discovery/search-areas.json` exposes the same
three to the interface. All three are **concentric** on one centre so that scale comparisons differ only in
radius, and all three are inside the published window with room for the 1 km habitat halo and for a road
group crossing a cell boundary:

| Scenario | Radius | Centre | Bounds |
| --- | --- | --- | --- |
| `small-10mi` | 10 mi | -122.92, 45.595 | `[-123.1266, 45.4494, -122.7134, 45.7406]` |
| `medium-25mi` | 25 mi | -122.92, 45.595 | `[-123.4365, 45.2310, -122.4035, 45.9590]` |
| `large-50mi` | 50 mi | -122.92, 45.595 | `[-123.9530, 44.8671, -121.8870, 46.3229]` |

Radius semantics are explicit: the bounding box selects cells (a cell grid can only be intersected by a
box), and the **disk** decides which composed corridors are inside the search - a unit is kept only when
some part of its road lies within the radius, measured with the domain's haversine distance. Habitat is
selected by the box padded by the 1 km analysis distance, and corridor habitat coverage is marked PARTIAL
when a corridor and its buffer leave the published window.

`npm run benchmark:regional` drives the three scenarios in a real browser. Each scenario is measured twice:
once in a fresh Chromium context (COLD: no partition registered yet) and once more in the same page (WARM:
the same verified buffers are reused). It prints `REGIONAL_BENCHMARK` JSON lines and writes
`/tmp/regional-benchmark.json`.

### What the raw browser path measured

Measured on the development machine by `npm run benchmark:regional` (one Chromium context per scenario, cold
then warm in the same page). Localhost serves the partitions, so transfer is near-free here; the numbers are
therefore dominated by DuckDB work, which is what a real R2 transfer would add to rather than replace.

| Scenario | Selected cells (road/NWI/NHD) | Catalog bytes | Transferred | Corridors | COLD | WARM |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 10-mile radius | 58 / 6 / 6 | 77.2 MB | 77.2 MB | 421 | **91.0 s** | **88.3 s** |
| 25-mile radius | 70 / 28 / 28 | 202.3 MB | - | - | stopped by the feature guard at 4.2 s | 0.8 s |
| 50-mile radius | 110 / 88 / 88 | 768.9 MB | - | - | stopped by the feature guard at 5.9 s | 0.9 s |

The 10-mile cold run in phases:

| Phase | Time |
| --- | --- |
| manifest load | 7 ms |
| partition selection (with bounded name closure) | 6 ms |
| fetch 77.2 MB (localhost) | 237 ms |
| SHA-256 verification of every byte | 47 ms |
| DuckDB/WASM registration (70 buffers) | 33 ms |
| road query | 5,072 ms |
| named-road composition (6,390 units from 94,554 features) | 1,235 ms |
| segmentation (421 corridors) | 34 ms |
| discovery batch, total | 84,657 ms |
| - validate 3,519 · buffers 695 · prepare 4,407 · **wetlands 61,762** · hydrography 16,276 · hydroTypes 589 · level3 1,036 · level4 569 ms | |
| result shaping | 3 ms |
| **total** | **91,014 ms** |

Warm repeats are almost as slow (88.3 s against 91.0 s) even though data preparation falls from 2.8 s to
6 ms and 70 partitions are served from the session cache. **The cost is the analysis, not the transfer**: the
wetland pass alone is 61.8 s of the 91 s. The 25- and 50-mile radii never reach analysis: the road reader's
100,000-feature ceiling stops them in about 5 s with a typed empty answer rather than a crash, which is the
correct production behaviour and also proof that neither radius is offerable as a raw browser search.

Geometry work still behaves at scale: of the 421 corridors in the 10-mile run, 20 needed the shared
analytical-geometry repair and 2 stayed unbufferable, all of which were reported per corridor.

Memory: JavaScript heap after the 10-mile run was 227.9 MiB (`performance.memory.usedJSHeapSize`),
against 168.8 MiB for the runs that stopped early. The number excludes DuckDB WASM/native allocation, and
no reliable peak process RSS measurement was available in this harness, so no peak figure is claimed. The
registered partition buffers are the transferred bytes (77.2 MB for the 10-mile run), each held once per
session.

### Road-name closure overfetch, measured

Closure is bounded by cell adjacency: a name that repeats in unrelated places must not pull every cell that
shares it. The bound cut the pathological case down (for the 10-mile search it now skips 1,770 name-cell
pairs) but the remaining overfetch is still material and is caused by **common street names repeating in
*adjacent* cells** - every town on a highway has a 3rd St, and adjacency cannot tell those apart:

| Scenario | Base road cells | Closure-added | Added bytes | Share of road bytes |
| --- | ---: | ---: | ---: | ---: |
| 10-mile radius | 6 | 52 | 23.4 MB | +372% over the 6.3 MB the box selects |
| 25-mile radius | 24 | 46 | 17.4 MB | +160% over 10.9 MB |
| 50-mile radius | 88 | 22 | 1.5 MB | +6% over 25.4 MB |

The largest single offenders in the 10-mile run were `3rd-st` (12 extra cells, 4.8 MB), `ne-5th-ave`
(4 cells, 3.3 MB), `ne-11th-ave` (3 cells, 3.1 MB) and `4th-st` (6 cells, 2.8 MB). The consequence is visible
in the run itself: 94,554 road features were composed to produce 421 corridors inside a 10-mile disk.

That is the overfetch the previous slice flagged as "to be measured", and the measurement says it is **not
acceptable**: it more than quadruples the road bytes and it multiplies composition cost. The smallest safe
fix is to record, at build time, the **connected components of each multi-cell name** (the same 150 m
endpoint rule the browser composes with) and close only over the component that touches the search. That
keeps whole roads whole - which is the only reason to close at all - without loading a same-named street on
the far side of the region. It is a build-side index change, not an analysis change, and it is a prerequisite
for any radius search to be cheap.

### Classification and the derived-metrics decision

Budgets were fixed before the numbers (COMFORTABLE <= 10 s cold, USABLE >10 s and <=25 s, SLOW >25 s and
<=45 s, UNSUITABLE RAW >45 s). Nothing below was adjusted afterwards.

| Scale | Raw cold | Classification |
| --- | ---: | --- |
| 10-mile radius | 91.0 s | **UNSUITABLE RAW** |
| 25-mile radius | stopped at 4.2 s by the feature guard (202 MB selected) | **UNSUITABLE RAW** |
| 50-mile radius | stopped at 5.9 s by the feature guard (769 MB selected) | **UNSUITABLE RAW** |

**Derived metrics are triggered**, by both stated conditions: the 25-mile raw path exceeds 25 s (it cannot
even start), and the 50-mile raw path is impractical by a wide margin. Two measured causes, in order of size:

1. **Per-corridor buffered analysis.** The wetland pass is 61.8 s for a 10-mile search; hydrography is
   another 16.3 s. This is exactly the work a derived artifact would precompute, and it is the reason warm
   repeats are no faster than cold ones.
2. **Road-name closure overfetch**, which quadruples road bytes and multiplies composition cost for small
   searches (above).

A third, structural cause is cell granularity: at 0.2 degrees a single cell is ~15.5 x 22.2 km, so a 10-mile
disk is already served by whole cells whose habitat content is 46 MB. Finer cells would cut transfer, but the
partition scheme was deliberately left alone for this measurement, and derived metrics answer the same
problem without touching it.

### The derived artifact this measurement called for

Not implemented in this pass. The measurement is what was missing, and it is now in hand; the design below is
what the numbers point at, and building it is the next feature rather than a second architecture.

* **Granularity**: one compact GeoParquet per published cell, holding the *discovery result rows* for the
  corridors whose geometry intersects that cell. No geometry is required to browse, so a row is roughly
  300-600 bytes; a 50-mile disk would move single-digit megabytes instead of 769 MB.
* **Columns** (per row): corridor id, name, road unit id, bounds, canonical length, road class, counties,
  wetland `intersects`/`nearest`/`area250`/`area500`/`area1000`/feature counts/top type, hydrography
  crossing count/nearest flowing/nearest standing/flowline length within 1 km/waterbody area, ecology primary
  Level III and IV plus ecoregion count, and per-dimension coverage. No occurrence evidence, no Investigator
  evidence, no access finding, no user state.
* **Fingerprint**: the catalog declares a deterministic analysis fingerprint over the road source version,
  composition version, segmentation profile, geometry-repair version, each habitat dataset version, the
  ecoregion versions, the analysis buffer profile and the derived schema version. A run whose loaded versions
  do not reproduce the fingerprint fail closed: stale metrics are never used because a corridor
  id happens to match.
* **Hybrid path**: derived partitions answer browsing, filtering, sorting and selection. Selecting or
  promoting a corridor loads the raw cells it needs through the existing service boundary, so the detailed
  deterministic analysis and the evidence trail stay the source of truth, and the derived layer can never
  become the only representation of the underlying data.
* **Equivalence**: a deterministic sample of corridors is compared between derived rows and a live raw run
  (wetland intersection, area at 250 m and 1 km, crossing count, nearest flowing water, primary ecoregion,
  coverage) within the existing tolerances; a cache that shifts discovery semantics is not acceptable.

### Batch and detailed habitat equivalence (found broken, now fixed)

The first wider-window pass recorded a real divergence: **618.35 ha** in the discovery batch against
**765.63 ha** in the detailed panel for the same corridor, about 24%, with 236 wetland features in the
detail. It is fixed. The cause was not a metric definition, and the diagnosis is worth recording because it
is exactly the failure mode the equivalence harness now guards against.

Stage by stage, in the order the checklist asks:

* **Partition selection did not contribute.** Both paths measured `wetlands-or-sw-wa-portland-v2`, the same
  six selected cells and the same number of partitions (verified in the capture's provenance block).
* **Replicated-feature dedupe did not contribute.** Both paths read the same deduplicated relation, and the
  per-feature stage records unique source feature ids whose sums equal the aggregates.
* **Buffer construction did not differ.** With the corridor's own geometry, a controlled single-corridor
  experiment returned the same wetland areas at every distance from the batch and from the detailed panel
  (for a 1,742 m corridor: 7,999.491 / 18,747.911 / 199,546.320 m2), the same feature counts (2 / 3 / 14),
  the same nearest mapped wetland (152.453 m), the same coverage, and the same dataset provenance.
* **The first divergent stage was promotion.** `promoteDiscoveryResult` rebuilt the candidate from the
  *whole composed road group* of the surveyed row, while the row itself describes one contiguous **segment**
  of that group. Promoting corridor 2 of 3 therefore measured a longer road: the classic "one path rebuilds
  the corridor from a different feature set" failure. The pilot path had the same latent behaviour; its test
  happened to promote a single-segment road, which is why the pilot's equality assertion never caught it.

Two smaller defects of the same "one definition" class were fixed at the same time:

* the batch's coverage statement compared a **projected** extent with a **geographic** corridor
  (`c.geom_4326`), so its per-corridor `corridorInside` flag was wrong. Coverage is now built from one pair of
  expressions for both paths.
* the metric expressions (clipped area, clipped length, distinct feature count, coverage predicates) now live
  in `src/gis/habitat-metrics.js` and are used by the set-oriented batch, the detailed panel, and the
  offline derived build. `tests/habitat-metrics.test.js` asserts that the statements each path issues really
  contain those shared expressions.

The fix: a promoted corridor's road record keeps the composed group's provenance (source feature ids, road
ids, class, county) but takes the **corridor's canonical geometry** (`corridorRoad` in `src/roads/road.js`),
and `src/app/main.js` passes the corridor it was asked to promote. The shared analytical-geometry boundary
prepares exactly the geometry the survey row was measured with, so batch and detail agree by construction.

The equivalence command's own output on the committed capture:

```text
Regional GIS equivalence

Corridors checked      8 of 550 surveyed
FULL                   8
Repaired corridors     25
Overlapping NWI pairs  872 within the sampled 1 km buffers

Wetland metrics        PASS
Hydrography metrics    PASS
Ecology metrics        PASS
Geometry provenance    PASS
Batch composition      PASS
Promotion identity     PASS
Per-feature stage      PASS

0 unexplained divergences
```

Evidence, all committed:

* `npm run verify:regional-equivalence` re-checks a real capture offline (no browser, no network, no 826 MiB
  of partitions): every sampled corridor's batch metrics against its detailed metrics, coverage first,
  geometry provenance, dataset/version/partition identity, promotion identity, and the per-feature stage.
  It exits non-zero on any unexplained divergence.
* `npm run capture:regional-equivalence` regenerates that fixture in a real browser
  (`tests/regional-equivalence.json` records the corridor, its composed unit - the geometry that used to be
  measured - and both paths' metrics, so the original failure stays reproducible).
* the regional Playwright test asserts the promoted panel equals the survey row again: it now prints
  `618.35 ha` in both places where it used to print `618.35 ha` and `765.63 ha`.

One observation from the capture that is not yet explained and is recorded rather than hidden: the
*survey-level* coverage summary of the published-edge strip (`[-124.05, 44.75, -123.90, 44.88]`, a
capture-only area) reports `UNKNOWN`, while the corridor sampled from it is measured consistently from both
paths and reports `PARTIAL` at the same distances. Corridor-level coverage, which is what any metric is
gated on, agrees; the summary's own combination at the window edge deserves a follow-up look.

### Overlapping mapped wetlands: the chosen definition

NWI polygons do overlap, and the wider window makes that visible: the capture found **872 overlapping mapped
wetland feature pairs** inside the sampled corridors' 1 km buffers, mostly because the window now reads the
Oregon *and* Washington state extracts, which both cover the Columbia River corridor. Road Naturalist keeps
the **feature-area sum** - each mapped feature contributes the area of its own geometry clipped to the buffer -
and therefore counts an overlapping pair twice. The reading is the interface's own: "Mapped wetland within
250 m / 1 km" plus the feature count beside it answers "how much mapped wetland is recorded around this
corridor", not "how much ground is wetland". A spatial-union area would be a different and stronger claim: it
would silently assume the mapped inventory is complete and non-overlapping, which NWI is not, and it would
change every committed pilot expectation. The double count across a state line is the one place where this
definition is visibly generous, and it is recorded rather than smoothed over.

## Road closure by connected component, not by name

Name-only closure was the measured overfetch: every town on a highway has a 3rd St, so a 10-mile search
selected 58 road cells where 6 were needed. The window is now indexed by **road connected component** - one
named road in one place, built from the same normalization the browser composes with (exact and reversed
duplicates collapse, endpoint proximity at the runtime's own 150 m, connected components, stable
`drv1-<name-key>[-c<n>]` ids). `scripts/road_components.py` mirrors `src/discovery/units.js`;
`tests/road-components.test.js` recomposes real published source features with the real browser modules and
asserts the same components, ids, membership and determinism under shuffled input.

| Scenario | Base road cells | Closure cells (names) | Closure cells (components) | Closure bytes (names) | Closure bytes (components) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10-mile radius | 6 | 52 (58 total) | **26** (32 total) | 23.4 MB | **13.5 MB** |
| 25-mile radius | 24 | 46 (70 total) | **27** (51 total) | 17.4 MB | **11.6 MB** |
| 50-mile radius | 88 | 22 (110 total) | **6** (94 total) | 1.5 MB | **0.5 MB** |

The window holds **61,447 components**; **2,601** span more than one cell and are published (949,748 bytes at
`regional/components-or-sw-wa-portland-v2.json`, declared in the catalog with its byte count and SHA-256 and
verified on load). The main catalog shrank from 1.24 MB to **177 KB**, because the name index it used to carry
is gone. The components that still add cells are long roads that genuinely continue (`US Hwy 26`, `US Hwy 30`,
`State Hwy 6`, `US Hwy 101`), not common street names: the test asserts no numbered street name appears among
a scenario's largest closure contributors. A catalog without the component index (the first published slice)
keeps name closure bounded by cell adjacency, so its measurements stay reproducible.

Measured on real data while building the index: `US Hwy 26` publishes 41 pieces, 18 of which are
divided-carriageway duplicates that collapse into **one** component, while `3rd St` is **50** unrelated
components. The same check also showed that the composed geometry of that highway measures about 447 km from
about 231 km of source line, because composition follows every published piece including ramps and stubs; the
component index therefore records the sum of a component's own source lines as a diagnostic and never as
corridor identity or as a metric.

## Analysis profile and fingerprint

`data/regional/analysis-profile.json` freezes the semantics a derived artifact would bake in, and
`src/discovery/analysis-fingerprint.js` builds it from the values the runtime actually uses (the constants are
imported, never restated) and reduces it to canonical JSON, then SHA-256. Current fingerprint:
`41b574f0651a22e00fc505cf4c41c87800065fdc1b7ff6e20e70ea6002895b5f`.

That value moved once during this work, which is the machinery doing its job: removing a doubled source
traversal before the engine probe (below) changes which line the metrics describe, so it is recorded in the
profile as `analyticalGeometry.duplicateSegmentsBeforeProbe` and every artifact built under the previous
fingerprint is refused by a browser that computes the new one.

It covers the region version and bounds, the road dataset version plus a digest over every published road
partition, the component-index digest and join tolerance, the composition tolerance and reversed-link ratio,
the segmentation constants and id prefix, the repair methods and acceptance tolerances, the wetland and
hydrography dataset versions and partition digests, every declared ecoregion dataset version and digest, the
analysis distances, the catalog's halo distance, and the metric-semantic versions (wetland area, clipped
length, feature counts, coverage, and the sorted first 40 hydrography names). It deliberately excludes timestamps, deployment ids, asset origins and user
state, and `tests/analysis-fingerprint.test.js` proves both directions: every material change above invalidates
the fingerprint, while reordering partitions, moving the asset origin, or passing deployment metadata does not.
`node scripts/write-analysis-profile.mjs --check` fails if the committed profile is not current, and the test
suite asserts the same thing.

A derived manifest carries the fingerprint it was built with; a browser whose own fingerprint differs
reports derived discovery as unavailable (`analysis version mismatch`) rather than showing numbers computed
under different rules.

## Derived corridor metrics: what is built

The plane described below is now built, published under `derived/corridor-metrics/<analysis-fingerprint>/`, and
used by default for regional radius discovery. The build pipeline, the schema, the fingerprint gate, the runtime
path, promotion verification, and the verifiers are all in place; the sections under "Build and verification"
name the commands. The list that follows the implementation notes is the original design contract, unchanged.

Build: `npm run build:derived` (`scripts/build-derived.py`).

```
regional road partitions (raw, immutable)
  -> source features              the runtime's own dedupe key: (county_fips, source_feature_id, part)
  -> corridor composition         node scripts/compose-derived-corridors.mjs -> src/discovery/units.js,
                                  src/discovery/segment.js: the modules the browser composes with
  -> analytical geometry          canonical geometry, else the shared point-preserving repair ladder
  -> habitat metrics              the shared expressions from src/gis/habitat-metrics.js
  -> derived rows
  -> 0.2 degree cells             whole rows replicated into every cell their geometry intersects
  -> GeoParquet + manifest        digest per cell, analysis fingerprint in the manifest
```

Corridor identity is not re-derived: the ids are the ones `segmentUnit` mints, so a derived row is the corridor
`runDiscovery` would have built from the same window. Only the metric statements are re-expressed, and they are
composed from the shared expressions the runtime exports (feature-area-sum wetlands, clipped-length and
feature-count hydrography, Level III/IV overlap with the 99.5% FULL rule, per-distance coverage against the
published extent), which `verify:derived-equivalence` checks against a live raw batch.

Metrics are measured in spatial chunks (100 corridors) with the habitat relations restricted to the chunk's
padded box, so a 6,440-corridor window is a sequence of neighbourhood jobs rather than one cross join. The
chunk restriction is a bounding-box prefilter of the kind the runtime already applies per corridor.

### Derived schema (one row per corridor)

```
corridor_id road_component_id road_unit_id name normalized_name geometry bounds length_m
road_length_m tiger_class counties county_names road_ids road_classes source_feature_ids
segment_index segment_count geometry_repaired geometry_repair_method
primary_l3_code primary_l3_name primary_l3_percent primary_l4_code primary_l4_name primary_l4_percent
l3_count l4_count transition_count ecology_coverage
wetland_intersects wetland_nearest_m wetland_area_250_m2 wetland_area_500_m2 wetland_area_1000_m2
wetland_count_250 wetland_count_500 wetland_count_1000 wetland_type_summary
hydro_crossing_count hydro_nearest_flowing_m hydro_nearest_standing_m hydro_flowline_length_1000_m
hydro_waterbody_area_1000_m2 hydro_summary
coverage coverage_wetlands_250 coverage_wetlands_500 coverage_wetlands_1000
coverage_hydro_250 coverage_hydro_500 coverage_hydro_1000 analysis_fingerprint
```

`geometry` is the canonical corridor geometry (EPSG:4326), which is what the map, the exact-radius test and
promotion compare against; `geometry_repaired`/`geometry_repair_method` record whether the offline analysis used
a repair. No occurrence, access, Investigator, annotation, or user state is stored.

### Built state (`or-sw-wa-portland-v2`, 2026-09-27)

The whole published region is now built, and the numbers are the ones the artifacts actually carry:

| Fact | Value |
| --- | --- |
| Analysis fingerprint | `41b574f0651a22e00fc505cf4c41c87800065fdc1b7ff6e20e70ea6002895b5f` |
| Corridors (unique) | 6,440 |
| Repaired analysis geometry | 718 corridors via `remove-duplicate-segments` (see below) |
| Stored rows (after replication) | 8,060 over 1,620 replicated rows and 1,511 multi-cell corridors |
| Cells | 130 (118 present, 12 declared empty) |
| GeoParquet bytes | 17,039,103 (16.25 MiB), 2,114 bytes per stored row average |
| Manifest | `data/derived/corridor-metrics/<fingerprint>/manifest.json`, 50,996 bytes, SHA-256 `961161f30c0dcb9f23472639fe7c666c59bb9fecae27f9287d26b091cab28172` |
| Build cost | 14.8 minutes wall (65 chunks; analytical 10.7 s, metrics 871.0 s, write 6.5 s) |
| Build engine | native DuckDB Spatial, `PRAGMA memory_limit='2GB'`, spill directory under `DERIVED_WORK` |

Repair provenance records the shared ladder's decision, and the build applies two rules so that the geometry it
analyses is the geometry the browser analyses:

* `remove-duplicate-segments` applies whenever the canonical corridor really contains duplicate segments: 718
  of the 6,440 corridors do. DuckDB-WASM refuses to buffer those geometries and the runtime repairs them, so
  analysing the canonical line offline would report a degenerate length — measured at up to 43% too long on the
  equivalence sample (`drv1-n-amherst-st-s1`: 3,740.8 m canonical against 2,112.0 m analytical), which moves
  every corridor-length-based metric (ecology percentages) and every corridor-line intersection (hydrography
  crossings). The first equivalence capture found exactly those corridors and nothing else.
* the shared engine probe covers the remaining rungs (`split-repeated-vertices`, `node-self-intersections`),
  which rewrite a line without changing its length: the native engine can buffer a geometry DuckDB-WASM refuses,
  so those rungs are taken only when the native engine also refuses the line without them. The native engine
  refused no corridor in this build. The derived hydrography name summary retains the same first 40 sorted
  distinct names as the browser batch; that material summary rule is in the analysis fingerprint.

The rebuilt artifacts passed `verify:derived` (including 96 distinct PARTIAL-coverage corridors),
`verify:derived-equivalence` (264 shared corridors, zero divergences, six raw detailed checks), and
`verify:regional-equivalence` (nine batch/detailed corridors, zero unexplained divergences). The equivalence
capture compares only corridors whose full 1 km analysis bounds fit the raw survey's selected habitat cells;
raw survey cells around a search box do not cover a long road corridor that continues beyond that box.
Promotion and detailed analysis select raw habitat around the chosen corridor itself.
The committed capture also checks two northern edge corridors against raw detailed GIS: one FULL (with matching
1 km wetland area and hydrography length) and one PARTIAL (with matching coverage at the boundary).

### Derived radius benchmark

The committed `data/regional/derived-benchmarks.json` measures each radius in a fresh browser page with HTTP
cache disabled. Times include data loading, filtering, sorting, the bounded table, and bounded SVG map.

| Radius | Selected metric bytes | Loaded / unique / disk corridors | Cold | Warm | Classification |
| --- | ---: | ---: | ---: | ---: | --- |
| 10 mi | 1,820,060 | 1,286 / 1,192 / 368 | 2.79 s | 0.13 s | COMFORTABLE |
| 25 mi | 6,102,562 | 3,466 / 2,931 / 2,238 | 1.38 s | 0.36 s | COMFORTABLE |
| 50 mi | 15,749,806 | 7,797 / 6,325 / 5,158 | 1.93 s | 0.81 s | COMFORTABLE |

The 25- and 50-mile table and map draw at most 400 corridors, while the total count stays visible. The measured
JS heap was 61 MB; 50-mile table render took 6 ms and map drawing 12 ms cold. The benchmark observed zero
iNaturalist, eBird, Overpass, or Investigator Worker requests during all six discovery passes.

The same browser harness run against production Pages and the public R2 origin (recorded in
`data/regional/derived-production-benchmarks.json`) measured 3.47 s, 3.54 s, and
8.76 s cold at 10, 25, and 50 miles; warm times were 0.13 s, 0.35 s, and 0.81 s. All six passes were
COMFORTABLE and made zero external evidence requests. The deployed regional preset also promoted a FULL
corridor: the 250 m wetland area was 618.35 ha in both the derived row and raw detailed GIS, with no raw
partition requested before promotion.

### Runtime path

```
search radius -> derived manifest -> fingerprint check -> select cells by search box -> fetch + verify digest
  -> register buffers -> query rows (dedupe by corridor_id) -> exact disk test -> results -> map
```

`src/discovery/regional-catalog.js` reads the catalog, `src/discovery/derived-catalog.js` validates the derived
manifest and applies the fingerprint gate, `src/gis/derived-query.js` reads and shapes the rows, and
`src/discovery/run.js` filters by the actual search disk (`minDistanceToLineM`) so a radius search never becomes
a square search. Derived cells need no 1 km halo: each row already carries complete metrics. A fingerprint
mismatch or a missing artifact reports why the precomputed layer is unavailable; it never falls back to the raw
regional path automatically, because a clear error beats a 90-second freeze.

One deliberate difference in *selection* is worth stating, because it is visible: the derived path keeps a
corridor when the corridor itself lies in the search region (its bounds intersect the search box, and for a
radius search the corridor crosses the disk), while the raw path keeps every corridor of a composed unit whose
bounds reach the search region. Both refuse to turn a radius into a square; the derived rule is the narrower,
per-corridor reading of "corridors are kept only where the road crosses the disk", and the equivalence capture
records the difference (`presence`) rather than asserting it away — including the check that every
derived-only corridor really does lie in the search box.

### Promotion

Promotion rebuilds the corridor from the raw regional partitions (closure + the same composure modules), checks
the id and geometry (<= 1 m drift) against the row the person selected, and refuses the promotion with
`promotion verification failed: ...` when the reconstruction disagrees. The candidate is then built from the
reconstructed raw corridor, so the detailed panel measures raw source geometry and reads raw regional habitat
partitions - precomputed values are never detailed evidence.

### Build and verification commands

```
npm run build:derived                 # offline build (uv + duckdb + shapely + pyarrow + pyproj)
npm run verify:derived                 # offline: structural + geometric review of the built cells
npm run verify:derived-equivalence     # offline: manifest + fingerprint + captured derived/raw comparison
npm run verify:regional-equivalence    # unchanged: batch vs detailed
npm run capture:derived-equivalence    # opt-in: capture a real derived-vs-raw comparison
npm run benchmark:derived              # opt-in: 10/25/50-mile derived benchmarks
```

### How the offline build stays the runtime's own queries

Two details are what keep a derived row the corridor the browser would have built, rather than a lookalike:

- **Buffers are materialised once per chunk**, exactly as `src/gis/discovery-query.js` does in `prepareBuffers`:
  the metric statements clip against that buffer relation (`b.geom`), never against an inlined
  `ST_Buffer(c.geom, d.distance_m)`. Inlining recomputes a buffer for every feature pair, which is both a
  different query and a memory amplifier (it exhausted the engine's ceiling before this was fixed).
- **Cells are real GeoParquet**, written with the same `geo` metadata the raw partitions carry (WKB,
  `geometry_types`, EPSG:4326, bbox) and read back through DuckDB Spatial with the same
  `ST_GeometryType`/`ST_CRS`/`ST_IsValid` checks before the cell is accepted. A plain WKB column named
  `geometry` is only a BLOB: `ST_XMin` and `ST_AsGeoJSON`, which the runtime reads cells with, refuse it.

The build's scratch directory is `/tmp/roadnaturalist-derived` (override with `DERIVED_WORK`). Everything in it
is derived from committed inputs, so losing it to a reboot costs a recomposition and never correctness; the
shared metric expressions are re-exported from `src/gis/habitat-metrics.js` for every build rather than cached.


## Derived corridor metrics: the original design contract


The measurement above is why this layer exists, and the correctness work before it is why it was safe to
build: batch and detailed habitat agree on a real capture, the wetland semantics is a documented feature-area
sum, coverage is compared before metrics, pool closure is component-based, and the analysis profile pins the
semantics a derived build must freeze. **It is now built, published and consumed**; the numbered list below is
the contract it satisfies, kept as the record of what each part is for.

1. **Corridor rows.** One compact GeoParquet partition per 0.2-degree derived cell, holding whole derived
   corridor rows replicated into every cell they intersect (deduplicated at runtime by `corridor_id`): corridor
   and unit ids, name, geometry, bounds, length, TIGER class, counties, source feature ids, segment index and
   count, repair provenance, ecology (primary L3/L4 with percentages, counts, transitions), wetlands
   (intersects, nearest, area and feature counts at 250/500/1000 m, type summary), hydrography (crossings,
   nearest flowing and standing, flowline length and waterbody area at 1 km, named/type summary), per-dimension
   coverage, and the analysis fingerprint. No occurrence, Investigator, access, annotation or user state.
2. **Build.** `regional road source -> component index -> units -> segmentation -> analytical geometry ->
   shared metric definitions -> derived rows -> spatial replication -> GeoParquet -> manifest -> digest`. The
   corridor set must be composed with the same modules the browser uses; the metrics must come from
   `src/gis/habitat-metrics.js`, so the offline build cannot quietly become a third definition.
3. **Runtime.** Select derived cells by the search box, verify digests, register buffers, deduplicate by
   corridor id, apply the exact disk test, then filter, sort and map from the loaded rows. Derived metric
   partitions need no 1 km halo (each row already carries complete metrics), while raw promotion keeps the
   normal halo rules.
4. **Promotion.** Reconstruct the corridor from raw partitions, verify id and geometry against the derived
   row, and fail closed (`promotion verification failed`) rather than trusting the cache; then load raw habitat
   partitions for the detailed analysis, which stays the source of truth.
5. **Publication.** `derived/corridor-metrics/<analysis-fingerprint>/cells/<cell>.parquet` plus a manifest, on
   the existing `roadnaturalist-data` plane, immutable and digest-audited like the raw partitions.
6. **Verification.** `npm run verify:derived-equivalence` comparing derived rows against raw batch and detailed
   metrics on a deterministic real sample, alongside the existing `verify:regional-equivalence`.

### Scale recommendation (this pass)

| Scale | Recommendation |
| --- | --- |
| 10-mile radius | Derived browsing is COMFORTABLE at 2.79 s cold, versus 91 s cold for raw discovery. |
| 25-mile radius | Derived browsing is COMFORTABLE at 1.38 s cold. Raw selected 202 MB and stopped at the road-feature guard. |
| 50-mile radius | Derived browsing is COMFORTABLE at 1.93 s cold, selecting 15.75 MB. Raw selected 769 MB and stopped at the guard. |
| Any radius | The partition grid, the manifest, coverage semantics and the shared geometry-repair boundary are sound at this scale and stay as they are. The blocker is analysis cost and closure overfetch, not the data plane. |
