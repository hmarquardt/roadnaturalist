# Physical habitat analysis (wetlands and hydrography)

Road Naturalist's first habitat analysis answers a narrow factual question for a real road corridor:

> What mapped wetlands and mapped surface-water features lie on and around this corridor, and how
> far away are they?

It reports **physical habitat evidence**. It is not species occurrence, not habitat quality, not a
wildlife score, not a route ranking, and not access. A mapped road/water intersection is a geometric
crossing; it is not a bridge, a ford, current water, or a safe stopping place.

```text
real candidate corridor (TIGER/Line 2025)
        ↓  EPSG:5070 buffer: on/intersecting, 250 m, 500 m, 1 km
wetland GIS (USFWS NWI)  +  hydrography GIS (USGS NHD)
        ↓  set-oriented DuckDB Spatial queries
coverage per requested distance + provenance
        ↓
deterministic habitat metrics (PHYSICAL HABITAT EVIDENCE)
        ↓
Habitat context panel + optional map layers
```

## 1. Source selection

### Wetlands — U.S. Fish & Wildlife Service, National Wetlands Inventory (selected)

* Agency / product: U.S. Fish and Wildlife Service, National Wetlands Inventory (NWI), Oregon state
  GeoPackage download (`OR_geopackage_wetlands.zip`). The FWS recommends web services for display
  and the downloadable state/HUC8 products for GIS analysis.
* Distribution: <https://documentst.ecosphere.fws.gov/wetlands/data/State-Downloads/OR_geopackage_wetlands.zip>
  (1,934,005,929 bytes, SHA-256 `ae6a75e7945943ce517350f8165ec6dd936c75fea7118a9cdabf765d816954a5`,
  served copy last modified 2026-05-04; NWI is republished in May and October each year).
* Feature class read: `OR_Wetlands` (674,153 statewide features in this release).
* Source CRS: the GeoPackage's own `srs_id 300001` definition — `NAD_1983_Albers`, which PROJ
  identifies as **EPSG:5070**. The full WKT is recorded as `source.sourceCrsDefinition`.
* Source attributes kept: `ATTRIBUTE` (raw Cowardin code, e.g. `PEM1A`), `WETLAND_TYPE` (the source's
  own human label, e.g. *Freshwater Emergent Wetland*), `QAQC_CODE`, `ACRES`, `NWI_ID`,
  plus the NWI project name and imagery year for each feature.
* Licensing: public domain (U.S. Government work).

**Rejected alternatives**

* The NWI ArcGIS REST map service
  (`https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0`)
  is the authoritative display/query service, but it is a joined map service: measured paging for a
  0.32° × 0.17° window returned about 300 features per 19–38 s with a maximum of 1,000 records per
  request. Extracting ~5,200 features would take many minutes and cannot be byte-pinned. The pinned
  state GeoPackage is faster, deterministic, and legally identical, so the service is not used.
* Oregon/Washington state agency hydrography or wetland layers are not federal products and were not
  adopted for a first federal-coverage pilot.
* Third-party GeoParquet mirrors of NWI (for example on Source Cooperative) are convenient but are
  not the authoritative publisher; they are not used.
* OpenStreetMap is deliberately not used as a habitat-data source. It remains useful later for
  Investigator verification of geometry and access.

### Hydrography — U.S. Geological Survey, NHD High Resolution (selected, with a documented caveat)

Inspected state of USGS distribution (September 2026):

* **NHD, WBD and NHDPlus HR were retired on 2023-10-01.** USGS no longer maintains them.
* **3DHP (3D Hydrography Program) is the current program.** Its products are quarterly-refreshed web
  services and an annual downloadable product.
* Measured access to 3DHP for a bounded pilot window ([-123.10, 45.50, -122.70, 45.70]):
  the only staged download intersecting the window is **CONUS-wide** (`3dhp_all_CONUS_…_GDB.zip`,
  12.6 GB in FY25, 12.5 GB in FY26); the service at
  `https://hydro.nationalmap.gov/arcgis/rest/services/3DHP_all/MapServer` responded to a
  `returnCountOnly` request in ~60 s and returned **HTTP 504** for envelope queries that requested
  geometry, so it cannot produce a bounded multi-thousand-feature extract reliably.

**Decision:** the pilot pins the last published **NHD High Resolution HU8 staged extracts** covering
this window, because it is the same authoritative agency, the same feature model that 3DHP inherits
(`FType`/`FCode`/`GNIS_Name`, flowlines and waterbodies), it is small, static, byte-pinnable and
readable offline in under a second, and the alternative cannot be bounded or pinned:

| HU8 | Name | URL | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| 17090010 | Tualatin | `.../NHD/HU8/GDB/NHD_H_17090010_HU8_GDB.zip` | 21,056,661 | `9f65000fa8ccdee7b8eaa8e68e9f5feb6b68daa69c79452590ec2ac64d6c90c4` |
| 17090012 | Lower Willamette | `.../NHD/HU8/GDB/NHD_H_17090012_HU8_GDB.zip` | 12,173,295 | `9b24d7dc5fab0ab3b3c5a482c2cb8ad32cf3e111b17a7b6e81f7bb3ac99cc813` |

Base URL: `https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/NHD/HU8/GDB/`.
The manifest records `source.productStatus` (retired 2023-10-01) and `source.successorProduct`
(3DHP) so the limitation travels with the data. Upgrading to 3DHP is a data-plane change: the
normalizer maps whichever source field names appear (`ftype`/`FType`, `gnis_name`/`gnisidlabel`) onto
canonical columns, and everything downstream reads the canonical column names.

* Source attributes kept: `permanent_identifier`, `ftype` (+ a documented label), `fcode`,
  `gnis_name`, `fdate` (per-feature date), `resolution`, `lengthkm`, `areasqkm`.
* Source CRS: EPSG:4269 (NAD83 geographic), transformed to EPSG:4326 for storage.
* Licensing: public domain (U.S. Government work).

## 2. Source limitations

* **NWI is not a current-condition or jurisdictional layer.** It is compiled from imagery of
  different dates. In this window the contributing projects carry imagery years 1975, 1981, 1982 and
  2009, and each feature records its own project and imagery year. Mapped wetlands may have been
  drained, filled, or created since. NWI also excludes some small and artificial features by design.
* **NHD is retired and its features are dated.** The extract's features carry source dates from
  2005-11-04 to 2022-02-22. NHD represents mapped hydrography at 1:24,000 scale; small ditches and
  ephemeral channels are unevenly mapped, and culverts are not modeled as crossings.
* **Both datasets describe mapping, not the ground.** Absent features mean "not mapped in this
  dataset", never "not present".
* **A geometric crossing is not an engineering structure.** NHD flowlines cross road centerlines
  wherever water is mapped crossing the road; the datasets do not distinguish bridges, culverts,
  fords, or seasonal flow.
* **Names are source names.** `gnis_name` values come from GNIS via NHD; unnamed features are common
  (most crossings in this pilot are unnamed).

## 3. Bounded geography and coverage extent

Nothing national or statewide is shipped to the browser. The two habitat datasets are bounded to the
recorded analytical window:

```text
window      [-123.070, 45.505, -122.750, 45.670]
margin      1500 m around the pilot corridor extent
statewide   674,153 NWI features in Oregon (4.10 GB GeoPackage)
shipped     5,248 NWI features + 4,963 NHD flowlines + 329 NHD waterbodies
```

The window is checked by `scripts/build-habitat.py`: every pilot corridor, buffered by the largest
requested analysis distance, must lie inside the window (tightest measured margin 2,643 m). Coverage
is therefore reported **against this extent**, not against the road centerline.

## 4. Analysis distances

`ON / INTERSECTING`, `250 m`, `500 m`, `1000 m` — analytical buffers around the canonical corridor,
not biological thresholds. `ANALYSIS_DISTANCES_M` in `src/gis/habitat-result.js` is the single source
of truth; the queries, the domain result, the UI, and the tests all read it, so other distances can
be added without redesign.

## 5. Preparation pipeline

```text
pinned source archive (SHA-256 verified, cached outside Git)
        ↓  bounded extraction of the analytical window
normalize  (clip, simplify, round, reproject, classify, label)
        ↓  validate (counts, geometry types, validity, units, digests)
GeoParquet for the browser + manifest entry
```

`scripts/build-habitat.py` builds both datasets in one documented pass:

1. `verify_window()` fails the build if a corridor's largest buffer leaves the window.
2. `fetch()` verifies each pinned archive's SHA-256 (and byte length) and downloads it only with
   `--download`; archives stay in `/tmp`, never in Git.
3. **Wetlands.** The narrow-window selection uses the GeoPackage's own R-tree spatial index
   (`rtree_OR_Wetlands_Shape`) through Python's built-in `sqlite3`, so no GDAL is required and no
   statewide scan happens. GeoPackage geometry blobs are decoded (GP header + WKB), then clip,
   simplify, reproject, round, bounds and area are computed in one set-oriented DuckDB Spatial query.
   Each feature's NWI project and imagery year are resolved by point-in-polygon lookup against
   `OR_Wetlands_Project_Metadata` (simplified by 25 m and prepared for speed).
4. **Hydrography.** DuckDB Spatial reads the pinned HU8 File Geodatabases (`NHDFlowline`,
   `NHDWaterbody`), clips to the window, simplifies, reprojects EPSG:4269 → EPSG:4326, and measures
   length and area in EPSG:5070 — all inside single SQL statements.
5. `write_geoparquet()` writes GeoParquet 1.1 with CRS/bbox metadata, then re-reads the file and
   asserts row count, non-null/valid/non-empty geometry, and CRS `EPSG:4326`.
6. `update_manifest()` rewrites `data/manifest.json`, preserving every dataset it does not build.

Geometry treatment (recorded per dataset as `scope.geometryTreatment`): clip to the analytical
window, simplify with `preserve_topology` at **1 m** in EPSG:5070, round coordinates to 1e-6 degrees
(≈0.1 m), measure in EPSG:5070. Simplification changes total mapped wetland area by about −0.1%
relative to the unsimplified source and total flowline length by about −0.1%; clipping does not
affect any metric inside the recorded window.

### Regeneration

```sh
uv run --with duckdb --with pyproj --with shapely --with pyarrow --with numpy \
  python3 scripts/build-habitat.py --download --verify --corridors

# offline check of the committed artifacts (digests, DuckDB readability, expectations)
uv run --with duckdb --with pyproj --with shapely --with pyarrow --with numpy \
  python3 scripts/build-habitat.py --verify-artifacts
```

* `--download` fetches the pinned archives into `--cache` (default `/tmp/roadnaturalist-habitat-sources`).
* `--verify` runs the synthetic spatial-math fixtures (below) and prints them.
* `--corridors` measures the three real pilot corridors and rewrites
  `tests/fixtures/habitat-pilot-expectations.json`.

Generated files contain no wall-clock timestamps, so rebuilds from the same pinned sources are
byte-identical: a deterministic rebuild reproduced wetland digest `b8f9c05f…` and hydrography digest
`a4a08b19…` exactly.

## 6. Dataset schemas

`data/gis/nwi-wetlands-pilot.parquet` — GeoParquet, EPSG:4326, MultiPolygon, 5,248 rows, 3,385,175 bytes,
SHA-256 `b8f9c05f2e34891ee3f096bc33689d961ae3a86f5752c8b167fec8c2dc8efdd8`:

| Column | Meaning |
| --- | --- |
| `source_feature_id` | GeoPackage `OBJECTID` (stable within this pinned release) |
| `attribute` | raw NWI Cowardin code (`PEM1A`, `R4SBC`, …) |
| `wetland_type` | source human label (`Freshwater Emergent Wetland`, `Riverine`, …) |
| `system_code`, `system_label` | Cowardin system letter and name (`P`, `Palustrine`) |
| `qaqc_code`, `source_acres`, `nwi_id` | remaining source attributes, unreinterpreted |
| `source_project_name`, `source_image_year` | NWI project and imagery year for this feature |
| `area_m2` | area of the stored geometry, measured in EPSG:5070 |
| `min_lon`…`max_lat` | stored bounds, used for the bounding-box prefilter |
| `geometry` | MultiPolygon WKB in EPSG:4326 |

`data/gis/nhd-hydrography-pilot.parquet` — GeoParquet, EPSG:4326, MultiLineString + MultiPolygon,
5,292 rows (4,963 flowlines, 329 waterbodies), 5,187,442 bytes, SHA-256
`a4a08b19b42fbad45bdc92842f93a3ecd41a101d506c17e8717fb030340acf48`:

| Column | Meaning |
| --- | --- |
| `layer` | `flowline` or `waterbody` |
| `source_feature_id` | NHD `permanent_identifier` |
| `source_hu8`, `source_hu8_name` | basin the feature came from |
| `feature_type_code`, `feature_type_label` | NHD `ftype` and its documented label (`460` → `Stream/River`) |
| `feature_code` | NHD `fcode` (perennial/intermittent/ephemeral detail) |
| `water_class` | `flowing` (`ftype` 334, 336, 460, 558), `standing` (361, 378, 390, 436, 466), or `other` |
| `name` | NHD `gnis_name` or empty |
| `source_feature_date`, `resolution` | per-feature NHD date and resolution |
| `source_length_km`, `source_area_km2` | source-reported attributes |
| `length_m`, `area_m2` | measured on the stored geometry in EPSG:5070 |
| `min_lon`…`max_lat` | stored bounds for the prefilter |
| `geometry` | MultiLineString or MultiPolygon WKB in EPSG:4326 |

Dataset-level provenance (agency, product, vintage, archive URLs, digests, CRS, method, coverage
extent, geometry treatment) lives in the manifest entry, not repeated on every row — the GIS layer
builds the runtime provenance object from the manifest.

## 7. GIS and DuckDB method

`src/gis/habitat-query.js` extends the existing GIS provider; no second analytical engine exists and
SQL stays inside `src/gis`. All habitat SQL is set-oriented: one query per concern, never one query
per feature.

* Corridor and window are projected with `ST_Transform(…, 'EPSG:4326', 'EPSG:5070', always_xy := true)`.
  Geometry is never tagged with `ST_SetCRS`/`ST_SetSRID`, because the pinned DuckDB-WASM spatial build
  tags coordinates through `ST_Transform` only (and rejects `window` as a CTE name — the CTE is
  `extent`).
* Buffers are `ST_Buffer(corridor, distance_m)` in EPSG:5070; wetland area is
  `ST_Area(ST_Intersection(wetland, buffer))`; flowline length is
  `ST_Length(ST_Intersection(flowline, buffer))`; waterbody area is `ST_Area(…)`; distances are
  `ST_Distance(…, corridor)` in meters.
* Every metric query is prefixed with a bounding-box prefilter against the extract's stored
  `min_lon…max_lat` bounds (padded by 1.1 × the largest requested distance, computed with a
  conservative meters-per-degree factor). The pad is a proof, not a heuristic: a feature whose bounds
  lie outside the padded corridor bounds is farther than the pad, so anything measured inside the
  pad is exact.
* Nearest-feature queries use that same proof as a two-stage path: measure the neighbourhood first,
  and only when it cannot show a feature inside the largest requested distance does the query fall
  back to a full-extract scan. The reported nearest distance is always the true nearest feature
  within the dataset.
* CRS assumptions are documented in `src/gis/habitat-query.js` and repeated in the manifest.
  EPSG:5070 (NAD83 Conus Albers) is the metric CRS the ecoregion layer already uses. For this window
  its scale distortion is under 0.1% at 1 km scale (fixture: a 1 km buffer measures 312.14 ha against
  the 314.16 ha of a perfect circle, a 0.64% difference caused by polygon approximation, not by the
  projection).

### What "crossing" means

A **mapped crossing** is a mapped NHD flowline that intersects the canonical road corridor in two
dimensions. The count is the number of distinct NHD flowline features that intersect, and each entry
carries the source feature ID, name, feature type, water class, and the intersection length.

A crossing does **not** establish a bridge, a culvert, a ford, public or legal access, current water
presence, water depth, safe stopping, or wildlife activity. Road Naturalist says so in the domain
(`CROSSING_CAVEAT`) and in the UI.

## 8. Coverage semantics

Coverage is tracked per dataset (`wetlands`, `hydrography` — independent of `road-geometry`,
`epa-ecoregions-or-l3/l4`, `occurrence`, and `access-verification`) and, for these buffered datasets,
**per requested distance**:

| State | Meaning |
| --- | --- |
| `FULL` | the query succeeded and every requested buffer lies inside the dataset's coverage extent |
| `PARTIAL` | the query succeeded, but the extract does not cover the whole analysis region (outer-buffer metrics may under-count) |
| `NONE` | the query succeeded and the corridor's analysis region is outside this extract — metrics are unknown here, *not* zero |
| `UNKNOWN` | the dataset could not be fetched, verified, loaded, or queried; metrics are absent and the reason is preserved |

A successful query that finds nothing inside a fully covered buffer is a real **zero with `FULL`
coverage** — the only case in which Road Naturalist reports zero habitat. These states are never
flattened: `src/gis/habitat-result.js` decides coverage from explicit containment rows
(`ST_Contains(window_extent, ST_Buffer(corridor, distance))`) rather than from the presence of
features, and both the Node tests and the browser tests assert UNKNOWN/PARTIAL/NONE paths separately.

## 9. Provenance

Each habitat result carries a provenance object built from the manifest: dataset id, product name,
version, agency, vintage, publication date, reference and documentation URLs, license, artifact
digest, geometry CRS, source CRS, measurement CRS, pipeline version, normalization method, coverage
extent, simplification tolerance, and the source product status (for example, NHD's retirement and
its 3DHP successor). Feature-level traceability is the `source_feature_id` on each crossing and
class, plus the dataset digest. The UI shows concise source labels and hides the rest behind a
`Source & method` disclosure.

## 10. Real pilot results (deterministic, not ranked)

Measured from the committed artifacts; `ON/intersecting` is reported as "corridor intersects a mapped
feature" rather than as 0 m. Wetland areas are mapped wetland area inside each buffer, not buffer
area.

| Corridor | Wetland ≤250 m | Wetland ≤1 km | Intersects wetland | Crossings | Flowline ≤250 m | Waterbody ≤1 km | Nearest standing water |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NW Cornelius Pass Rd | 15.70 ha (54) | 165.13 ha (227) | yes | 26 | 24.19 km | 11.07 ha | 381.2 m |
| NW Springville Rd | 9.59 ha (33) | 160.44 ha (136) | yes | 5 | 16.23 km | 6.52 ha | 5.9 m |
| NW Susbauer Rd | 4.05 ha (24) | 35.26 ha (117) | yes | 5 | 5.86 km | 2.55 ha | 67.0 m |

Coverage is `FULL` for both datasets at all three distances on all three corridors. Wetland
composition differs by corridor and matches the EPA context already in the app: Cornelius Pass Rd
spans the Coast Range foothills with 53.86 ha of *Riverine* wetland and 62.74 ha of
*Freshwater Forested/Shrub* wetland inside 1 km; Springville Rd is riverine-dominated (101.69 ha of
Riverine inside 1 km); Susbauer Rd sits on the Prairie Terraces with the least wetland and only
34.20 km of flowline inside 1 km. The analysis therefore differentiates landscapes rather than
producing one flat profile, without ranking them.

## 11. UI and map

* A **Habitat context** panel section shows `PHYSICAL HABITAT EVIDENCE`, the nearest mapped wetland
  (or "corridor intersects a mapped wetland"), wetland area and feature counts within 250 m / 500 m /
  1 km with per-distance coverage when it is not `FULL`, the source wetland types with their areas,
  mapped crossing count, nearest flowing water, nearest standing water, flowline length and waterbody
  area per buffer, nearby named waters, and a `Source & method` disclosure. Distances render in meters
  or kilometers, areas in hectares or square meters.
* The **Data coverage** panel lists `Wetlands` and `Hydrography` alongside the existing dimensions.
* The map has one restrained, off-by-default **Habitat layers** toggle. When enabled it draws the
  1 km analysis buffer outline, wetlands within 250 m of the selected corridor, and flowlines within
  250 m (≤400 + ≤400 features). The road stays the top layer, and the layers are removed when the
  toggle is switched off or another corridor is selected.
* The section is clearly labelled `PHYSICAL HABITAT EVIDENCE`; species occurrence remains unimplemented
  and is tracked as its own coverage dimension.

## 12. Tests

| Check | Where |
| --- | --- |
| manifest provenance, digests, bounded coverage metadata, geometry treatment | `tests/habitat.test.js` |
| committed artifacts match manifest bytes + digest and are GeoParquet | `tests/habitat.test.js` |
| buffer areas/counts, ordering, units, empty-but-covered zero | `tests/habitat.test.js` |
| FULL / PARTIAL / NONE / UNKNOWN coverage, zero-vs-error, per-distance states | `tests/habitat.test.js` |
| dataset fetch failure, query failure, and outside-extract behaviour through the GIS service | `tests/habitat.test.js` |
| domain framing, units, crossing caveat, coverage mapping | `tests/habitat.test.js` |
| pilot expectations fixture consistency | `tests/habitat.test.js` |
| real corridor → wetland query → hydrography query → habitat result → UI, overlay toggle, and browser-vs-Python agreement | `tests/app.spec.js` (real DuckDB-WASM Spatial) |
| artifacts readable by DuckDB Spatial, valid geometry, CRS, corridor metrics reproduce expectations | `scripts/build-habitat.py --verify-artifacts` |
| synthetic spatial-math fixtures (7.8 m distance, 1 km buffer area, 0.01° square area, intersection yes/no, 0.01° line length) | `scripts/build-habitat.py --verify` |

`tests/fixtures/habitat-pilot-expectations.json` is generated by the Python pipeline and compared
against the browser result (0.5% tolerance on areas and lengths, exact on counts and coverage), so the
two independent DuckDB paths must agree for every pilot corridor.

## 13. Measured performance (Chromium, local server, DuckDB-WASM 1.30.0)

| Measurement | Value |
| --- | --- |
| DuckDB-WASM + Spatial initialization | ~2.2–2.4 s |
| First road query / later road queries | 0.4 s / 3–8 ms |
| Wetland analysis per corridor | 0.89 s (1.35 s before the prefilter and two-stage proximity) |
| Hydrography analysis per corridor | 1.52 s (2.85 s before) |
| Combined habitat analysis per corridor | 2.38 s |
| Habitat map overlay (1 km buffer + 250 m features) | 2.89 s, only when toggled on |
| Page load → habitat panel visible (pilot click path) | ~6.4 s |
| Browser GIS footprint | 28,918 B roads + 475,469 B EPA L3 + 2,253,981 B EPA L4 + 3,385,175 B wetlands + 5,187,442 B hydrography ≈ 11.3 MB |

**Scalability finding.** The wetland artifact is 88% geometry and the hydrography artifact 94%
geometry, stored as WKB in GeoParquet. One 0.32° × 0.17° window of Oregon's 674,153 statewide NWI
features (4.10 GB GeoPackage) already costs 3.4 MB simplified, and the window's 4,963 NHD flowlines
cost 5.2 MB. Shipping bounded GeoParquet to the browser therefore scales with corridor *area*, not
corridor count: it is fine for a pilot of a few roads, and will not scale to a regional or statewide
corridor set. When that happens, the plan is R2 partitioning by window plus range/tile requests (or a
Worker-side query) and, secondarily, a persistent browser cache — not larger single artifacts.
Reducing the 1 m simplification tolerance would trade accuracy for bytes and is deliberately not
done now.

## 14. What these metrics do not prove

* they do not score habitat, rank corridors, or predict wildlife, amphibians, or any species;
* they do not establish species occurrence, breeding, or movement (a separate, unimplemented coverage
  dimension);
* they do not establish access, legality, road surface, traffic, or stopping safety;
* they do not establish that a mapped crossing is a bridge, culvert, or ford, nor that water is
  currently present;
* they do not establish land ownership, protection status, or management intent;
* they do not replace wetland delineation, jurisdictional determinations, or field survey.

## 15. Pattern for future habitat datasets (land cover, terrain, public land, habitat edge)

1. Pin the authoritative artifact (agency, product, vintage, bytes, SHA-256) and put it in the manifest.
2. Bound the extraction to a recorded window with a stated margin, and assert that every requested
   buffer lies inside it at build time.
3. Normalize into a small, typed GeoParquet in EPSG:4326: source feature id, source attributes, a
   human label where the source defines one, measured values in EPSG:5070, and stored bounds for
   prefilters.
4. Report coverage per requested distance from an explicit containment test, never from the presence
   of features, and keep it independent of the other datasets' coverage.
5. Extend `src/gis/habitat-query.js` (or add a sibling module) with set-oriented SQL, prefix every
   metric query with the bounds prefilter, and return plain rows plus a provenance object built from
   the manifest.
6. Summarize into the shared habitat result shape (`status → buffers/classes/crossings → coverage →
   provenance`), then into domain evidence via `src/habitat/context.js`; the UI stays independent of
   SQL and DuckDB rows.
7. Add fixtures for the spatial math, coverage cases, and one real corridor-to-UI test, and record
   measured size and timing so the scaling decision stays evidence-based.
