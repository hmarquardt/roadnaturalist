# Road centerline pilot (Oregon)

This is the first real **road geometry** dataset in Road Naturalist. It replaces the synthetic
sample corridor: corridors now carry geometry from an identified public source, and the same GIS
service that resolves EPA ecoregions also retrieves those road features.

```text
U.S. Census Bureau TIGER/Line 2025 ROADS (pinned county archives)
        ↓  source verification (SHA-256, expected road/county feature counts)
        ↓  bounded extraction (5 named roads, 2 counties, one bounding box)
        ↓  normalization (CRS, vertex hygiene, one WKB LineString row per source feature)
        ↓  validation (GeoParquet round-trip, DuckDB read-back, geometry type)
data/gis/or-roads-pilot-2025.parquet + data/manifest.json + tests fixture snapshot
        ↓  browser GIS service (DuckDB-WASM + Spatial, byte length + SHA-256 verified)
        ↓  source-feature composition (src/roads) → normalized road → candidate corridor
        ↓  existing EPA Level III/IV query → coverage, provenance, map, evidence UI
```

## What this pilot proves, and what it does not

Proves: real traceable road geometry, a repeatable ingestion/normalization path, a canonical
map-library-independent road model, explicit geometry provenance, real Level III/IV context for a
real road, and explicit road-data coverage semantics.

Does **not** prove, and must not be read as claiming:

* **legal or practical access** — a road in a centerline dataset is mapped, not necessarily public;
* surface, condition, traffic, gates, closures, or seasonality — the source publishes none of these;
* that the road is a good wildlife road cruise, or that any species is present.

```text
ROAD EXISTS / GEOMETRY  ≠  LEGAL PUBLIC ACCESS  ≠  SAFE / PRACTICAL ROAD CRUISE
```

## Source decision

| Candidate source | Assessment | Decision |
| --- | --- | --- |
| **U.S. Census Bureau TIGER/Line 2025 ROADS** (`tl_2025_<county>_roads.zip`) | Federal public-domain road centerlines, county-partitioned, stable URLs, `LINEARID`/`FULLNAME`/`MTFCC`/`RTTYP` attributes, NAD83 (EPSG:4269), archives small enough to pin by digest | **Selected** |
| Oregon DOT / Oregon GEOHub road inventory | Authoritative for state jurisdiction and roadway attributes, but distributed through ArcGIS REST paging and interactive downloads; harder to pin offline by digest in a reviewable way | Deferred |
| OSM / Overpass | Rich tags, useful later for the Investigator's adversarial geometry and access checks, but community-sourced; not authoritative government data and not a legal access record | Not used in this pilot |

TIGER/Line was chosen because it is an official U.S. government road-centerline product that can be
pinned, verified, extracted offline, and reviewed deterministically. Where Road Naturalist later
needs surface, access, or condition information, OSM/Overpass and agency sources can contribute
*additional evidence* with their own provenance — never silently relabeled as authoritative.

### Limitations of the source

* TIGER/Line is a geographic/statistical road centerline product, not an official legal road
  register. It carries no surface, condition, gate, closure, or access-right attribute.
* `MTFCC` classifies carriageway type (for example `S1400` local road, `S1740` private road),
  not drivability or legality for a wildlife cruise.
* Roads are digitized per county and split into multiple features at junctions; one real road can
  appear as several features and cross county lines.
* Names reflect Census/address conventions, not local signage.
* The archives are republished annually; the pinned digests below will fail loudly after a
  republication, which is the intended behaviour.

## Pilot geography and roads

Two Oregon counties on the Tualatin Mountains / Willamette Valley boundary, inside the EPA Oregon
extract that the ecoregion pilot covers. Extraction window: `[-123.10, 45.50, -122.70, 45.70]`.

| Road record id | Road | County | Source features | Composed length |
| --- | --- | --- | --- | --- |
| `tiger-2025-or-41067-nw-cornelius-pass-rd` | NW Cornelius Pass Rd | Washington | 4 | 9,100.5 m |
| `tiger-2025-or-41051-nw-cornelius-pass-rd` | NW Cornelius Pass Rd | Multnomah | 1 | 7,876.1 m |
| `tiger-2025-or-41067-nw-springville-rd` | NW Springville Rd | Washington | 1 | 3,333.9 m |
| `tiger-2025-or-41051-nw-springville-rd` | NW Springville Rd | Multnomah | 3 | 6,325.7 m |
| `tiger-2025-or-41067-nw-susbauer-rd` | NW Susbauer Rd | Washington | 1 | 4,804.7 m |

Candidates declared in `data/roads/or-roads-pilot.json`:

* **NW Cornelius Pass Rd** (both counties, 5 source features, 10.55 mi) — exercises multi-county
  composition and duplicate-link handling.
* **NW Springville Rd** (both counties, 4 source features, 6.00 mi) — exercises source gaps: two
  parts with a 122 m resolved junction join and a 246 m gap that stays unresolved.
* **NW Susbauer Rd** (1 source feature, 2.99 mi) — the simple case: one feature, one county, one
  connected part.

## Ingestion and normalization pipeline

`scripts/build-roads.py` (offline, no production resource touched) performs:

1. **Source verification** — each county archive is downloaded (or supplied with `--archive`) and its
   SHA-256 must equal the pinned digest in the script.
2. **Bounded extraction** — features whose `FULLNAME` matches a declared pilot road *and* whose
   vertices fall inside the pilot bounding box. Multi-part shapes split into one row per part.
3. **Normalization** — consecutive duplicate vertices are dropped, geometry is validated, the source
   NAD83 (EPSG:4269) coordinates are transformed to EPSG:4326 with `always_xy`, and each feature part
   becomes one WKB `LineString` row with its source attributes and provenance columns.
4. **Validation** — PyArrow read-back (rows, no null geometry, `geo` metadata) and DuckDB read-back
   (`count`, distinct roads, `ST_NPoints`, all geometries `LINESTRING`).
5. **Publishing** — Zstd GeoParquet, the manifest entry, and the deterministic Node test snapshot.

Regenerate (source archives are cached in `/tmp`, never committed):

```sh
uv run --with pyshp --with pyproj --with pyarrow --with duckdb --with shapely \
  python3 scripts/build-roads.py --download --verify-ecoregions
```

`--verify-ecoregions` prints the EPA Level III/IV overlap of the pilot roads against the checked-in
ecoregion GeoParquet, as a read-only cross-check of the browser path.

Pinned source archives (public domain, U.S. Government work; not committed):

| County | URL | SHA-256 | Published |
| --- | --- | --- | --- |
| Washington (41067) | `https://www2.census.gov/geo/tiger/TIGER2025/ROADS/tl_2025_41067_roads.zip` | `fda13013515689b57a500462db9b19bdd4dc0c3a70d341eec7eb9f7d7c42eea7` | 2025-09-22 |
| Multnomah (41051) | `https://www2.census.gov/geo/tiger/TIGER2025/ROADS/tl_2025_41051_roads.zip` | `30ae0afe1a0bb6685da281b8ad97fc708876b61e9bfc7c1f0f96118d33d3cb92` | 2025-09-22 |

The build is deterministic: artifacts contain no wall-clock timestamps, so regenerating from the
same pinned sources produces byte-identical parquet and an unchanged digest. `retrievedAt` is added
at read time by the browser GIS service and is never baked into an artifact.

## Source road features vs roads vs candidates

Three distinct concepts, deliberately not collapsed:

| Concept | Example | Where it lives |
| --- | --- | --- |
| **Source road feature** | one TIGER/Line record (`LINEARID 110501873033`, MTFCC `S1400`) | parquet row, `source_feature_id` |
| **Normalized road** | `tiger-2025-or-41051-nw-springville-rd` — composed, deduplicated, gaps reported | `src/roads/road.js` |
| **Candidate corridor** | `or-roads-springville-rd` — one or more roads, evidence, questions, coverage | `src/domain/corridor.js` |

A road is keyed by **county extract + road name + source class**, because TIGER/Line has no
road-level identifier. A real road crossing a county line therefore becomes two road records
(Cornelius Pass and Springville both do), and a candidate composes them. That is deliberate: it
keeps identity deterministic and avoids name-only merging of different roads in adjacent counties.
When a future source provides a road-level ID (for example a state roadway inventory), it replaces
this key — the candidate layer already supports multiple roads, so no refactor is required.

Normalization rules (`src/roads/normalize.js`, pure functions, no map library):

* consecutive and non-finite vertices are dropped; a line needs at least two vertices;
* exact duplicates are removed, including reversed vertex sequences;
* a pair of features that digitizes the same junction link in opposite directions is collapsed to
  the longer one (`NW Cornelius Pass Rd` in Washington County has exactly such a pair, ~61 m);
* features are ordered into a chain with a documented 150 m junction tolerance, and line
  orientation follows the traversal;
* junctions that coincide exactly merge into one canonical line; anything further apart stays a
  separate line and is reported — **no connector geometry is ever invented**;
* the result is a canonical GeoJSON `LineString`/`MultiLineString` with derived length and bounds.

Composition is reported per road as `composition`: source feature count, dropped features,
duplicates removed, collapsed reversed links, line count, connected part count, joined gaps,
largest joined gap, and largest unresolved gap.

## Domain model and attribute states

`src/roads/road.js` produces a frozen road object: `id`, `name`, `geometry`, `lengthM`, `bounds`,
`composition`, `roadClass`, `routeType`, `surface`, `access`, `sourceFeatureIds`, `county`,
`evidence`, `provenance`. The map is only a view of `geometry`.

Fields that the source does not publish are never guessed. `src/domain/attributes.js` distinguishes
`known` (the source states it), `unknown` (not established), `not provided` (this source has no such
field), and `inferred` (derived, must stay visibly unverified). For this pilot: `roadClass` and
`routeType` are `known`; `surface` is `not provided`; `access` is `unknown`.


## Geometry evidence vs access evidence

Every road carries both, as separate claims:

```text
GEOMETRY VERIFIED   Road geometry comes from identified source data.
ACCESS UNVERIFIED   Road Naturalist has not established public, legal, or practical access.
```

`GEOMETRY PARTIAL` marks a road whose source features do not all connect (NW Springville Rd).
Access evidence stays `ACCESS UNVERIFIED` for every pilot road. The vocabulary follows the Wildlife
Road Cruise Investigator (`verified` / `probable` / `unverified`), which owns the future web research,
Overpass examination, and adversarial access checks. Grading geometry confidence in the Investigator
is correct; inventing access here would not be.

## Provenance

Detailed provenance lives in the domain and data layers, not as raw metadata in the primary UI. A
normalized road records: source organization and dataset, dataset id/version/vintage and publication
date, reference and documentation URLs, licence, dataset digest, source feature IDs, county, source
attributes used, original CRS (`EPSG:4269`), normalized CRS (`EPSG:4326`), the ingestion pipeline
version, the normalization method, the composition method and tolerance, the per-county archive URLs
with their SHA-256 values, and the read timestamp. The UI shows a short "Geometry source" line and a
collapsed "Source & method" disclosure.

## Coverage semantics

Road-data coverage is its own dimension (`COVERAGE_DATASET.ROAD_GEOMETRY`), separate from
`epa-ecoregions-or-l3`, `epa-ecoregions-or-l4`, `wetlands`, `occurrence`, and `access-verification`:

* `FULL` — every requested road was returned with at least one source feature;
* `PARTIAL` — some requested roads were returned, others are missing from the extract;
* `NONE` — the query succeeded and no requested road is present in this bounded extract;
* `UNKNOWN` — the road dataset could not be fetched, verified, or queried.

A failed or unavailable road source is **`UNKNOWN`, never `NONE`**: "we could not read the road data"
must never render as "there are no roads here". For this bounded pilot, even a successful `NONE`
means "not in this extract", not "no road on the ground" — the UI states that explicitly. Road
coverage and EPA coverage are reported independently; one failing leaves the other untouched.

## Real EPA results for the pilot corridors

Deterministic overlap of the composed corridor geometry with the checked-in EPA Oregon extract
(`--verify-ecoregions`; the browser produces the same result through DuckDB-WASM):

| Corridor | Level III | Level IV | Coverage |
| --- | --- | --- | --- |
| NW Cornelius Pass Rd (10.55 mi) | Willamette Valley (3) 67.6% + Coast Range (1) 32.4% | Prairie Terraces (3c) primary, plus Volcanics (1d), Valley Foothills (3d), Portland/Vancouver Basin (3a) | `FULL` |
| NW Springville Rd (6.00 mi) | Willamette Valley (3) 74.0% + Coast Range (1) 26.0% | Valley Foothills (3d) primary, plus Volcanics (1d), Prairie Terraces (3c), Portland/Vancouver Basin (3a) | `FULL` |
| NW Susbauer Rd (2.99 mi) | Willamette Valley (3) 100% | Prairie Terraces (3c) 100% | `FULL` |

Level III/IV remain broad ecological context, not species evidence, and EPA boundaries are
approximate at road scale. The ecoregion code is unchanged by this pilot: it receives the real
corridor geometry through the same GIS service path that previously received the synthetic line.

## Measured sizes and performance

| Measure | Value |
| --- | --- |
| Pinned source archives (cached in `/tmp`, not committed) | 2,905,525 + 2,100,943 bytes (5.0 MB) |
| Generated road dataset | `data/gis/or-roads-pilot-2025.parquet`, 28,918 bytes (10 features, 657 vertices, 5 road records) |
| Browser transfer | 28,918 bytes, byte length + SHA-256 verified before use |
| DuckDB-WASM + Spatial init (one-time) | ~2.3-2.5 s |
| First road query (includes artifact download, verify, register) | ~0.4 s |
| Subsequent road query | 2-7 ms |
| EPA Level III + IV analysis of the real corridor | ~0.25-0.32 s |

No optimization is required at this size. The interesting architectural result is that a tiny
GeoParquet artifact, a pinned source, and the existing GIS service were sufficient for the whole
slice; no second GIS path and no browser-side road catalog were needed.

## Tests

`tests/roads.test.js` covers the artifacts (pinned source digests, manifest entry, snapshot
consistency), the geometry rules against real coordinates (duplicate collapse, unresolved gaps, no
invented vertices, order independence), the domain model (provenance survival, attribute states,
candidate composition), road coverage semantics, and the GIS boundary: real road features through
`queryRoads`, provider failures as `UNKNOWN`, and the real composed corridor flowing into the EPA
query. `tests/app.spec.js` runs the pilot in Chromium with real DuckDB-WASM + Spatial and checks the
rendered road facts, ecology, coverage rows, map selection, and mobile layout, while a run with the
DuckDB bundle blocked asserts the honest degraded state. Every Node test is offline: the source
archives are never downloaded during tests.

## Next steps (not in this task)

1. Activate the Investigator's access/geometry verification stage on top of these corridors.
2. Add a second real layer (habitat or hydrography) with its own dataset dimension and coverage.
3. Replace the county+name road key with a road-level source ID when a state inventory is adopted.

