# CONUS data factory, Phase 1

## Phase 2A: pinned NWI source plane

The May 2026 FWS state GeoPackage set is frozen in `data/national/nwi-state-lock.json`: all 48 contiguous
states and DC, 49 ZIP archives, **60,502,602,638 compressed bytes** and **128,044,507,136 ZIP-member bytes**.
Every entry has the official URL, archive filename, byte length, SHA-256, Last-Modified, S3 version ID,
GeoPackage member, and download timing. The freezer hashes one archive at a time, records a completed pin
immediately, and deletes its temporary ZIP unless `--keep` is requested. This was necessary on the current
machine: roughly 53 GiB was free before the build, less than the complete compressed source set. An initial
run pinned 47 states and exhausted temporary disk space while downloading Wisconsin; rerunning pinned the
remaining WI/WY entries without rehashing the completed downloads. `npm run freeze:national-wetlands -- --check`
checks the complete lock offline. The source registry points to the lock and the source-schema inventory.
`data/national/nwi-source-schema.json` reads every pinned package's GeoPackage member and counts
**36,979,715 raw source rows** across all 49 CONUS layers; `npm run inspect:national-nwi -- --check`
re-checks that inventory offline from the lock.

The wetland factory lives in `scripts/build-national-wetlands.py`, `national_wetlands.py`, and
`partition-national-wetlands.py`. It uses the Phase-1 `grid-conus-2025.json` unchanged. One state archive is
downloaded and verified against the lock, one GeoPackage member is extracted and verified, and source rows
are normalized in deterministic 100,000-`OBJECTID` chunks. Each chunk checkpoint carries the source digest,
pipeline version, source and output counts, output bytes and SHA-256, and running/complete state. A killed
chunk is rebuilt; completed output is rehashed. The `--cleanup-source` option discards ZIP/GeoPackage files
after validated normalized chunks, leaving resumable normalized checkpoints. The default is one state worker,
configurable to four; measured worker comparisons belong in the Phase-2A benchmark report.

The raw NWI geometry is retained as complete Polygon/MultiPolygon source shapes and transformed from source
EPSG:5070 to EPSG:4326 for GeoParquet. It is not simplified or clipped by cell. The publisher replicates the
whole source feature to each intersecting 0.2° cell and uses `canonical_feature_id` to deduplicate selected
cells. The compact schema carries that key, `NWI_ID`, source state/OBJECTID, all source states for an exact
package copy, Cowardin `ATTRIBUTE`, `WETLAND_TYPE`, `QAQC_CODE`, `ACRES`, bounds, and WKB geometry. Regional
metric semantics remain feature-area sum: two distinct wetland features can overlap and both contribute.

The key policy is `nwi-id-exact-signature-v1`. A nonblank `NWI_ID` shared once per package becomes one
canonical feature only when normalized **source geometry** and the classification/QA fields are exactly
equal. The earliest state by FIPS owns the row. Repeated IDs within a package or across packages with
different source geometry/attributes are kept as distinct package-qualified keys and counted as ambiguous.
Blank IDs are always package-qualified. Geometry equality, overlap ratio, or type alone cannot remove a
feature. The border harness in `scripts/analyze-nwi-borders.py` uses each GeoPackage R-tree for bounded
real-world comparisons; `data/national/nwi-border-analysis.json` records counts and examples by border.

The partition manifest declares all **21,874** national grid cells. Complete coverage permits `present` or
`empty`; a partial build declares every unprocessed cell `unbuilt`, which must never be interpreted as zero
wetlands. A present cell is a SHA-256-verified GeoParquet object under the immutable
`national/wetlands/nwi-state-2026-05-v1/` path. `npm run verify:national-wetlands` audits pins, state/chunk
checkpoints, identity rows, cell declarations, digests, schema, geometry samples, and deterministic manifest
encoding. `npm run benchmark:national-wetlands` captures measured counts, bytes, and timings. Source cache,
extraction, normalized checkpoints, fragments, and publishable objects remain in ignored
`data/national-wetlands-work/`; only the small lock, inventory, manifests, reports, scripts, and docs are
committed. A partial manifest is a build report, not a browser catalog.

The existing Oregon/Washington regional ingestion had a genuine source-copy defect: it prefixed package
local `OBJECTID`, so exact Columbia River NWI copies from both packages were counted twice. A source-level
audit found 20,611 NWI IDs in both published regional packages, 19,966 of them with identical regional
geometry and type. The shared package-copy identity rule now removes only exact cross-package copies before
the regional wetland geometry is clipped/simplified. The corrected regional raw plane is versioned `v3`,
the analysis profile includes this rule, and derived metrics are rebuilt under its new fingerprint. The
feature-area sum rule itself is unchanged, and distinct overlapping mapped polygons are preserved.

The Phase-2A build boundary and measured object distribution are recorded below after representative
normalization, cross-border validation, and cell compaction. Full national wetland publication waits until
EPA, hydrography, and national derived metrics can be verified together; representative cells are uploaded
and audited in the existing `roadnaturalist-data` bucket.

### Measured Phase-2A boundary

The current laptop cannot hold the complete wetland factory output. The pinned ZIPs total **60.503 GB**,
their uncompressed ZIP members total **128.045 GB**, and the disk had only about **53 GiB free** before this phase.
After the road factory and wetland checkpoints, ordinary free space is about **25 GiB**; one extracted large
state temporarily consumes another 5–12 GiB. The builder therefore completed full-state normalization for
**AZ, DC, OR, and WA**, compacted the **AZ/DC** full-state partial plane, and compacted four bounded paired
state validation slices. The remaining **45 states** have no full normalized checkpoint, and **47 states**
have no full-state cell compaction. These are completed counts, not extrapolated national totals. The
committed `data/national/wetland-manifest.json` is a **1,707,132-byte partial build record** with 694 present,
two declared-empty, and 21,178 explicitly unbuilt cells. Its present cells total **2,765,274,542 bytes**;
the 162,913 stored rows represent 150,835 distinct features in those cells (1.0801 rows per feature).
Partial and bounded sample URLs include a digest of the state/selection set, so future complete cells cannot
collide with these immutable R2 objects.

| Validation slice | Raw rows | Canonical rows | Exact copies removed | Ambiguous rows retained | Present cells | Stored rows | GeoParquet bytes | Largest cell |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PNW OR/WA | 34,624 | 28,849 | 5,775 | 440 | 12 | 21,577 | 117,131,850 | 19,569,756 |
| Gulf FL/GA | 69,601 | 64,092 | 5,509 | 364 | 24 | 50,188 | 68,211,307 | 4,607,981 |
| Northeast NY/NJ | 101,424 | 83,245 | 18,179 | 726 | 16 | 58,429 | 129,768,206 | 14,123,108 |
| Arid AZ/DC full-state partial | 188,581 | 188,581 | 0 | 2 | 694 | 162,913 | 2,765,274,542 | 17,758,494 |

The seven bounded border investigations measured **69,700 exact cross-package copies** and **4,506 ambiguous
rows** in their selected windows. The OR/WA window alone found 32,563 exact copies. Conflicting reuse of the
same `NWI_ID` was retained, and geometry-only identity was never used. In the corrected regional footprint,
20,839 exact OR/WA source copies were removed before analytical clipping. The regional feature-area-sum
metric and distinct overlapping wetlands remain intact. Source-level identity is checked before the
regional 1 m geometry simplification; the national raw plane retains unsimplified whole source polygons.

The OR/WA border result was independently re-derived from the full-state normalized OR and WA chunks rather
than from the report: **1,285,527** source-faithful rows (unsimplified geometry digests, before any clipping)
contain **32,563** exact cross-package copies and **2,620** ambiguous rows, and the exact-copy count is
identical to the windowed border figure. That re-derivation also found the sharpest adversarial case present
in the real data: one normalized source geometry digest is shared by **three distinct `NWI_ID`s**, each with a
single row, and **all three are retained** - equal geometry alone is never treated as identity. Neither
package has a blank `NWI_ID` row, so the blank-id path is exercised by the deterministic tests rather than by
this pair. The command that re-derived it is a verification exercise, not part of the committed pipeline; the
committed rule it checks is `nw.duplicate_group_is_safe` plus `nw.canonical_key`.

The four sample benchmarks are committed under `data/national/nwi-benchmark-*.json`. Their median cell sizes
range from **2.61 MB** in the Gulf slice to **7.49 MB** in the Northeast; the sampled p95 is at most **17.00
MB** (PNW). The four published R2 sample objects total **10,802,553 bytes** and each public GET matched its
SHA-256/byte length, GeoParquet content type, immutable cache header, CORS, and HTTP 206 Range response.
They are samples, not a national active catalog. Full publication and browser activation remain gated on a
complete 49-state build and the later ecology/hydro/derived equivalence gates.

Worker concurrency was benchmarked rather than assumed, on one pinned four-package subset (CT, DC, DE, RI:
**278,037,075** compressed source bytes, **306,139** raw rows, **451,746,046** normalized bytes each run,
**8.367 s** shared source preparation). `data/national/nwi-concurrency-benchmark.json` records every run:

| Workers | Invocation s | Wall s | Process CPU s | Peak RSS | Outcome |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 57.286 | **57.477** | 55.021 | **1.258 GB** | fastest, least memory |
| 2 | 64.896 | 65.134 | 81.445 | 1.549 GB | 13% slower than one worker |
| 4 | 60.145 | 60.358 | 80.685 | 1.691 GB | still slower than one worker |

The default stays **one worker**. More workers did not help and cost more: the pinned ZIPs of a large state
are 0.5–4 GB compressed and their GeoPackages 1.6–13 GB, so two or more large states in flight contend for
the same disk on this machine, and each additional worker raised peak memory while consuming more CPU per
second of wall time. The per-worker gain seen here is bounded by the fact that extraction and GeoPackage
reads are disk-bound, not CPU-bound. A larger machine with independent fast storage should re-benchmark the
same pinned subset before any default change; the measured 1/2/4 results above are the local baseline.

Peak RSS is now measured for the normalization workload (**1.258 GB at one worker**), while peak CPU
percentage and end-to-end Phase-2A wall time remain uninstrumented; per-state and partition stage timings are
in the committed machine-readable reports. A full 49-state plane needs a larger disk or an external shard
store. The next run can reuse all valid state/chunk checkpoints and will refuse stale source or output
digests. `npm run verify:national-wetlands` validates the current partial plane and all seven real border
regressions; add `--require-all` to make a complete national plane mandatory.

At the current regional all-habitat rate of 6,244 corridors per 1,231 seconds, 1,420,806 national corridors
would take about **78 hours of single-worker metric work** before national density and I/O effects. That is
only a throughput reference, not a completed wetland intersection benchmark. Sampled wetland cell cost
varies by more than an order of magnitude per feature, so a credible national NWI output-byte estimate
requires additional full states. The previously measured **3.93 GB** national derived-row forecast concerns
the compact *finished metrics*, not raw wetland source polygons or intermediate buffer work.

Road Naturalist's production browser continues to use the Oregon/southwest Washington regional plane. This phase builds a separate national **road** plane; national habitat and derived discovery are later phases. No national road-only search is exposed to users.

## Coverage and source registry

`data/national/source-registry.json` declares the 2025 Census state and county boundary ZIPs with measured bytes and SHA-256, the TIGER/Line 2025 county ROADS archive template, and planned EPA, NWI, and USGS sources. `data/national/tiger2025-county-lock.json` pins the bytes and SHA-256 of all 3,109 downloaded road ZIPs; subsequent normalization refuses source drift. The semantic target is the 48 contiguous states plus District of Columbia. `scripts/build-national-grid.py` reads the actual TIGER state polygons, selects the explicit 49 FIPS codes, and intersects them with the existing 0.2° grid. It does not use a rectangle as a substitute for the states. The county polygons enumerate 3,109 source shards. The resulting pinned `data/national/grid-conus-2025.json` has **21,874 intersecting cells**, of which **20,717** are fully covered by state geometry and **1,157** touch a state edge. A cell in the grid is only a potential data cell: a road cell is populated only when a verified road partition is present. State geometry includes jurisdictional water; the road manifest must still declare genuinely empty cells.

The grid therefore places an upper bound of **21,874 cell objects per dataset** before any layer-specific empties are removed. The state polygons define jurisdictional intersection, including some inland water. They are not an assertion that every intersecting cell contains a road or dry land; each dataset manifest makes that distinction explicitly.

The [Census 2025 Roads National Geodatabase](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-geodatabase-file.2025.html) is listed at 2.1 GB compressed. Its [published record layout](https://www2.census.gov/geo/pdfs/maps-data/data/tiger/tgrshp2025/2025_TIGERLINE_GDB_Record_Layouts.pdf) has `LINEARID`, `FULLNAME`, `RTTYP`, and `MTFCC`, but no county FIPS field. The current regional normalization carries county-scoped identity and provenance. Phase 1 therefore keeps the exact same **county ROADS product** at national scale; no unverified national-geodatabase substitution changes the source. The 41067 national shard was compared against the current regional road cells inside the published window: **13,408 rows, identical keys, IDs, classes, names, and WKB geometry**. This is a direct source-semantic regression, not an inference from matching field names.

The road classes remain `S1200`, `S1400`, and separately preserved `S1500`; named corridor eligibility remains `S1200`/`S1400`. The shared `build-road-network.py` reader and `tiger_sources.py` geometry/normalization functions produce each county shard. The legacy `tiger-2025-or-` prefix remains in `road_id` even outside Oregon because changing it would break current regional identity; a separate identity migration would need its own equivalence and fingerprint decision.

## Stages, checkpoints, and local storage

Use `npm run build:national-grid` after obtaining the pinned Census boundary ZIPs, then `npm run build:national-roads -- --download --workers 2`. The default is **two** concurrent county workers; the configurable cap is eight. Run bounded slices with `--counties 41067,36061,56001`. Source downloads use a temporary `.part` path and are renamed only after completion. Every county job records `pending`, `running`, `complete`, `failed`, or validated `skipped`; a complete job carries source and output SHA-256, bytes, row count, class counts, pipeline version, and wall time. A rerun hashes both files before reuse. A killed `running` job is rebuilt; a stale digest or pipeline version invalidates its output. No timestamp alone can make a job complete.

`npm run partition:national-roads` builds whole-feature county-to-cell fragments in a separate checkpoint stage. Each fragment path includes the normalized input digest. `--finalize` requires all 3,109 county fragment jobs, then compacts each cell into one GeoParquet object, declares every other grid cell `empty`, and writes a deterministic national road manifest. A missing county or corrupt required fragment stops finalization. This keeps `empty`, `missing`, and `failed` distinct. Cell rows carry the complete road geometry, never a clip; a line crossing a seam is replicated. The manifest records cells, bounds, rows, bytes, SHA-256, source vintage, grid digest, and immutable keys under `national/roads/tiger2025-county-v1/`.

`scripts/build-national-components.py` constructs a durable SQLite name index from all normalized shards and checkpoints each of 64 deterministic output buckets. It groups same-name roads by **endpoint distance** before applying the existing duplicate, reversed-link, and 150 m component rules. The spatial bins only narrow candidate comparisons; exact haversine distance decides connectivity. On the three representative counties, all **11,034** names produced identical component structures to the original unindexed implementation. The full index is required before publication. A component cannot join two roads merely because they share “Main St” or a highway name.

The SQLite name index records a digest of the component and partition code it depends on. A code change clears and rebuilds that index from still-valid normalized county shards. Component and segmentation bucket checkpoints separately carry their input digest, the relevant code digests, output digest, bytes, and counts. A killed or stale bucket is rebuilt; a valid one is hashed and reused. The strict verifier and manifest freezer refuse unstamped or stale buckets, so a cached national count cannot silently survive a composition change.

Keep source ZIPs, normalization shards, fragment checkpoints, and publishable road objects in ignored `data/national-work/`; commit only the registry, grid, scripts, small reports, and documentation. The work directory can be relocated with `--work`. `npm run verify:national-roads` checks the grid, registry pins, complete job digests, GeoParquet metadata, row counts, IDs, classes, and optional regional regression. `npm run benchmark:national-roads` writes a machine-readable county report. A complete build should additionally verify final cell geometry, CRS, bounds, ID dedupe, component stability, empty cells, and manifest hashes before any publication.

The first three slices used Washington County, OR (West), New York County, NY (dense East), and Albany County, WY (rural interior). They normalized **23,342** rows from **6,263,032** compressed source bytes to **7,902,053** GeoParquet bytes in **5.074 s** at two workers. A second run validated all checkpoints and skipped all three in **0.005 s**. Their county-to-cell stage produced 63 fragments and 24,593 replicated rows. These small-slice rates are not a national throughput claim.

The full two-worker normalization pass took **1,430.372 s** (23.8 min). Of 3,109 counties, 3,108 completed or validated from earlier checkpoints; one Census URL returned a 608-byte HTML rejection with HTTP 200. A fresh CDN cache key delivered the listed 5,730,091-byte ZIP for Kanawha County, WV (54039), and it normalized in 1.556 s. The downloader now tries a deterministic fresh cache key after a non-ZIP response, and still rejects any bytes that differ from the source lock. All **3,109 counties** are now complete: **16,196,082 TIGER source records**, **14,295,702 normalized source-part rows**, including **14,003,089 S1200/S1400 eligible rows** and **292,613 separately preserved S1500 rows**. The verified source ZIPs total **4,033,268,938 bytes**, and normalized GeoParquet shards total **4,887,025,743 bytes**. The full production-region regression checks all **20 counties and 115,907 regional road rows** with exact keys, IDs, classes, names, and WKB geometry.

The full fragment stage produced **40,654 county-cell fragments** and **14,993,013 replicated rows**. Final compaction wrote **21,135 present road cells** totaling **5,817,231,464 GeoParquet bytes** and declared **739 road cells empty**. The local build manifest is **about 9.6 MB** and covers all 21,874 grid cells. Full verification rehashed every source, normalized shard, and final cell; read the GeoParquet schemas and sampled cell geometry; checked unique logical IDs within every cell; and rechecked the 20-county regional regression.

The national name index contains **2,341,573 distinct normalized names**, **9,255,241 named eligible source rows**, and **7,840,443 connected components**, including **448,692** touching multiple grid cells. The 64 component buckets occupy **2,226,492,281 bytes** and took **2,084.956 seconds of bucket work**. The longest source component is a topologically connected US Hwy 27 chain at **1,334 km** across 21 counties. A high-feature-count example, Eglin Air Force Base, has **515 features** but is confined to a roughly 19 × 22 km Florida area; its 412 km source length describes a local branching network rather than nationwide name closure. There are 99 source components over 500 km and nine over 1,000 km. These figures are source component measurements, not corridor lengths.

National QA exposed a shared corridor-composition bug: the selected source line was cloned for orientation and then removed from the remaining list by cloned-object identity. That removed the last line instead; some large highways repeated links, dropped others, and acquired inflated lengths. The shared composer now removes the selected original and retains unconsumed branches as separate lines. The analysis profile was advanced to version 2; the regional derived plane and all 64 national segmentation buckets must be rebuilt from this change. Source road partitions and component identities are unaffected. The committed exact national corridor count and derived-size forecast are taken only from the rebuilt segmentation checkpoints.
## Phase 2B: national hydrography plane (legacy NHD High Resolution)

### Build volume and the storage boundary (measured)

This machine has **24 GiB free on `/`** (95% used) and **no external build volume** (`/Volumes` holds only the
boot volume and Recovery). That is decisive, and the task's own threshold is 250–300 GB:

* NWI needs **128.0 GB** of uncompressed GeoPackages (60.5 GB compressed) plus normalized chunks, fragments and
  cells: 45 states have no normalized checkpoint and 47 have no full-state compaction.
* NHD HR needs **23.65 GB** compressed for its **2,166 CONUS HU8 units**, and each unit's GDB is larger again
  unpacked. A full national freeze plus normalized plane does not fit here either.

This phase therefore continues from **validated checkpoints** rather than restating the whole source set: NWI
keeps the states it has normalized, and hydro is pinned and built as a bounded set that still covers every CONUS
HUC2 region. What remains is recorded exactly, never estimated. All large artifacts live under the ignored
`data/national-wetlands-work/` and `data/national-hydro-work/` directories; only locks, inventories, manifests,
benchmarks and audit reports are committed. The intended layout on a large volume is
`<build-volume>/roadnaturalist/{sources,work,cells}/{nwi,nhd}`, which is what each tool's `--work` selects.

**Cleanup policy.** Sources, extractions and fragments have different answers. *Source archives* are
reconstructible from the pinned URL and are the only thing `--cleanup-source` removes. *Extractions* (`.gdb`
directories) are removed automatically once a unit's validated normalized output exists. *Fragments* are
reconstructible from normalized outputs with `npm run build:national-hydro --units … --finalize`, so they may be
dropped after a plane's manifest is verified. *Normalized outputs, identity databases, checkpoints, coverage
records and compacted cell artifacts* are **must-keep**: the two national verifiers re-hash them, and deleting
one turns a verified plane back into an unverified one. The same rule was applied to the road factory's
`fragments/` (6.0 GB) and the superseded `or-sw-wa-portland-v2` partitions (0.83 GB) — the 6.8 GB that made this
phase's writes fit. Both are rebuildable (`npm run partition:national-roads`, `npm run build:regional`) and both
national road verifiers were re-run afterwards to prove nothing they read had gone.

### Source decision: legacy NHD HR, staged per HU8

The regional pipeline already reads legacy **NHD High Resolution** from USGS staged **HU8** file geodatabases
(`https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/NHD/HU8/GDB/NHD_H_<huc8>_HU8_GDB.zip`), and the
product is retired: NHD was superseded by 3DHP on 2023-10-01, so freezing the *same* product nationally is the
only way to scale current semantics without changing them. The bucket listing rejected the alternatives:

| Product family | What it is | Why it is not the national input |
| --- | --- | --- |
| `NHD/HU4/GDB/` | **NHDPlus HR** (`NHDPLUS_H_…_HU4_…`), a different lineage | different source semantics and vintage; not what the region reads |
| `NHD/State/` | state staging | a coarser resume unit over the same data |
| `NHD/National/` | the national GDB | one archive: no resumable shard, unbounded download |
| `NHD/HU8/GDB/` | **legacy NHD HR per HU8** | **chosen**: same product as the region, 2,166 CONUS shards, 8 MB median |

Two pins were re-downloaded and re-hashed to prove it: `17090010` (21,056,661 bytes, `9f65000fa8cc…`) and
`17090012` (12,173,295 bytes, `9b24d7dc5fab…`) still match the regional declaration **byte for byte**, so the
national plane consumes exactly the rows the regional metrics already use.


The corrected shared segmentation produced **1,140,129 eligible road units** and **1,420,806 corridors**; **6,700,314 units** fell below the existing minimum. Of the eligible units, **1,053,664** form one corridor, **28,534** form two, and **28,191** form three; the largest segment count is **207**. The 64 per-component segmentation records occupy **689,931,717 bytes** and took **2,981.597 seconds of bucket work**. Each record freezes the component ID, composed length, source-feature count, and deterministic corridor count; full corridor geometry is reconstructed from the raw source features in the next habitat phase. The strict index audit paired all **7,840,443** component and segmentation records, checked stable IDs and source-feature counts, and verified every checkpoint SHA-256 and current pipeline digest.
### Lock, inventory and checkpoint strategy

`data/national/nhd-rhu-hu8-lock.json` pins the units this phase builds (the two regional units plus
median-sized units for every CONUS HUC2 region): URL, bytes, SHA-256, Last-Modified, ETag, ZIP member count,
uncompressed bytes, the `WBDHU8` basin name read from the staged metadata XML, and download timing.
`npm run freeze:national-hydro` pins more units and `--check` validates the lock offline; `--keep` retains
verified archives in the ignored source cache. `data/national/nhd-hr-hu8-inventory.json` is the measured bucket
listing: **2,166 CONUS units, 23,652,050,889 bytes, per-unit sizes and Last-Modified values**, with 220
non-CONUS units excluded (HUC2 19 Alaska, 20 Hawaii/Pacific, 21 Caribbean, 22 territories). A future operator can
see from that file exactly which units remain unpinned.

The checkpoint unit is the **staged extract itself** — a HU8 geodatabase — which is the source's own partition,
so a killed build loses the unit it was working on (seconds to minutes) and never the completed ones. Each unit
checkpoint records source digest, pipeline version, checkpoint key, input rows, output rows, output bytes,
output SHA-256 and status, and a checkpoint is reused only when the source digest and pipeline version match the
lock and the output's bytes, digest and Parquet row count still agree; a stale digest invalidates that unit
alone. Partitioning is checkpointed per unit as well, so identity, replication and compaction all resume.
`--cleanup-source` drops each verified archive after its validated output exists, which is what keeps a national
run's disk footprint at a few units rather than at the whole 23.65 GB source set.

### Source schema (measured across every CONUS region)

Every pinned unit stages the same two contributing layers, and only these two contribute:

| Layer | Member | Geometry | Fields preserved |
| --- | --- | --- | --- |
| `NHDFlowline` | `line` | `MultiLineString` | `permanent_identifier`, `reachcode`, `gnis_name`, `ftype`, `fcode`, `fdate`, `resolution`, `lengthkm`, `visibilityfilter` |
| `NHDWaterbody` | `polygon` | `MultiPolygon` | `permanent_identifier`, `reachcode`, `gnis_name`, `ftype`, `fcode`, `fdate`, `resolution`, `areasqkm`, `visibilityfilter` |

Findings that mattered: `permanent_identifier` is present, non-blank and **unique within every unit
inspected**; the declared CRS is **EPSG:5498** (NAD83 geographic plus a NAVD88 vertical component) whose
horizontal frame is the NAD83 frame the regional build transforms from; geometry is published with **four
ordinates (XYZM)** because flowlines carry a linear measure, so X/Y are preserved exactly and Z/M are dropped
explicitly rather than failing a transform; `WBDHU8`, `WBDHU10` and `WBDHU12` basin polygons are present in the
same geodatabase, which is what makes a typed-empty cell exact rather than assumed; and no unit has produced an
invalid or empty geometry.

### Hydro semantic contract and identity rule

The contract lives in `scripts/national_hydro.py` and is deliberately the regional one, not broadened. Identity
is `(member, permanent_identifier)`. `ftype` alone decides flowing/standing (`334/336/460/558` flowing,
`361/378/390/436/466` standing, otherwise `other`). Geometry is preserved whole and unsimplified; length and
clipped area are measured in EPSG:5070 exactly as the regional build does; a whole feature is replicated into
every intersecting 0.2° cell; and runtime deduplicates by the canonical key. `layer`, `source_feature_id`,
`length_m`, `area_m2`, `feature_type_code` and `water_class` are the fields the current browser metrics read
through `src/gis/habitat-metrics.js`.

Cross-unit identity is fail-closed, in the same shape as `nwi-id-exact-signature-v1`:
**`nhd-permanent-identifier-v1`**. A nonblank `permanent_identifier` collapses to one canonical feature only when
every package copy is exactly one row per unit **and** the signature (reach code, GNIS name, `ftype`, `fcode`,
source length and area, normalized geometry digest) is identical. Repeated ids inside one unit, conflicting
reuse, blank ids, and equal geometry under different ids are all retained and counted; the owner of a collapsed
group is the lowest unit id and every row carries the full `source_units` list. Overlap, adjacency, a shared
name or a touching geometry is never identity: two connected water features that touch remain two features.


The compact committed `data/national/road-manifest.json` is **5,303,147 bytes** and declares all 21,874 cells with bounds, state, feature count, and digest for present cells. `component-manifest.json` and `segmentation-manifest.json` are **17,884** and **49,648 bytes**. Their 64 bucket entries also carry content digests. `npm run verify:national-roads -- --require-all --regional-regression --manifest` checked all 3,109 counties, 21,135 present and 739 empty cells, and the exact 115,907-row regional regression. `npm run verify:national-index` checked the component and corridor linkage.

The local macOS build's measured first normalization pass was **1,430.372 s** at two workers, or about **9,994 normalized rows/s** including network fetch. County fragment work summed to **413.270 s**, component bucket work to **2,084.956 s**, and corrected segmentation bucket work to **2,981.597 s**. These checkpoint times sum to about **115 minutes of measured stage work**, not a full end-to-end wall clock: boundary/source fetch and cell compaction were not timed separately, and QA/retries added time. An observed workspace snapshot was **27 GiB** (3.8 GiB source ZIPs, 4.6 GiB normalized shards, 6.0 GiB fragments, 5.5 GiB road artifacts, 7.5 GiB component/index workspace). That snapshot is not a measured peak. A normalization process snapshot reached **726,960 KiB RSS and 113.2% CPU**; peak RAM and CPU were not instrumented. Use at least roughly **35 GiB free disk** for this layout, with extra headroom for retries and rebuilds. The 4.03 GB source download took place during normalization, so network time cannot be isolated from its 1,430 s wall clock.

## Publication and updates

National objects belong in the existing `roadnaturalist-data` bucket under the immutable `national/roads/tiger2025-county-v1/` path. The current regional keys and catalog stay untouched. `npm run publish:national-roads -- --cells x282_y677,x529_y653,x368_y654 --publish` uploaded representative West, dense East, and rural cells; the public audit matched all three local SHA-256 digests and byte lengths and confirmed GeoParquet content type, immutable caching, CORS, and HTTP 206 Range responses. Their combined payload is **1,894,735 bytes**. Publishing all 21,135 road objects before national habitat and derived metrics are built would spend substantial upload time without enabling national discovery, so the complete immutable catalog is staged locally and the three-cell publication proves the delivery path. The national catalog pointer should switch only after habitat and derived equivalence in a later phase.
### Measured national hydro results (representative 38-unit build)

`npm run build:national-hydro --units … --finalize` built the pinned set end to end and
`npm run verify:national-hydro` re-derived every declaration from the artifacts:

| Measured | Value |
| --- | --- |
| Pinned and built units | 38 of 2,166 CONUS (all 18 HUC2 regions) |
| Source compressed bytes built | 328,283,224 |
| Raw source rows | 440,872 |
| Canonical features | 440,871 |
| Exact cross-unit copies removed | **1** |
| Ambiguous same-id rows retained | 0 |
| Present cells | 1,109 |
| Declared-empty cells | 20,765 |
| Unbuilt cells | 0 (relative to the pinned set) |
| Replicated stored rows | 448,372 (1.017 rows per feature) |
| GeoParquet bytes | 2,875,044,094 |
| Median / p95 / largest cell | 0.41 MB / 20.22 MB / 21.69 MB |
| Cells over 10 / 20 / 50 MB | 102 / 102 / 0 |
| Invalid geometry | 0 |
| Verifier | `verify:national-hydro` green: pins, 38 unit checkpoints, identity re-derivation, 1,109 cell artifacts, typed empties, schema, geometry, deterministic manifest |
| Hydro tests | 13 deterministic tests (`npm run test:national-hydro`) |

The most interesting measurement is the duplicate count. State packages overlap heavily (NWI removed 32,563
OR/WA copies), but HU8 extracts are drainage basins whose features are *assigned* rather than duplicated: across
38 adjacent and distant units only **one** permanent identifier appears in two units with an identical
signature — between **17090010 (Tualatin) and 17090012 (Lower Willamette)**, the regional pair — and no id was
found reused with conflicting geometry. Every row in the plane carries a nonblank `permanent_identifier`
(`blankIdRows: 0`, `ambiguousRows: 0`), so `nhd-permanent-identifier-v1` resolved the whole set to
dataset-issued ids, and the retained-ambiguity path stays a guard rather than a routine outcome. The rule is therefore still needed for
correctness, and its cost is negligible — which is the right shape: identity is not doing bulk deletion, it is
refusing to merge anything it cannot prove is the same row. The 102 cells over 20 MB are not outliers of the
grid: they are dense-lake units (Wisconsin and Minnesota waterbody units) where one cell holds thousands of
small polygons, and they are the cells a future browser-served hydro plane would have to handle deliberately.

### Storage boundary for the full CONUS planes (measured, not estimated)

| Plane | Needed to finish | Available here | State |
| --- | --- | --- | --- |
| NWI cells, 49 states | 128.0 GB of GeoPackages plus fragments | 24 GiB on `/`, no external volume | 4 states normalized; 45 remain |
| NHD cells, 2,166 HU8 units | 23.65 GB compressed plus unpacked GDBs and fragments | same volume | 38 units built; 2,128 remain |

Both planes are resumable: every completed unit is a validated checkpoint, so the remaining work is bounded by
download and normalize time on a machine with the 250–300 GB the task calls for, not by rebuild risk.

### Derived-build readiness

| Input plane | Status | Reason |
| --- | --- | --- |
| Roads | **READY** | 21,135 present and 739 declared-empty CONUS cells built, verified, with the regional regression exact |
| NWI wetlands | **PARTIAL** | Identity rule, factory, verifier and representative slices are complete; the cell plane covers AZ/DC (OR/WA normalized and resumable), and 45 states are blocked on disk |
| Hydrography | **PARTIAL** | Source frozen, contract and identity rule defined, factory and representative slices complete and verified; 2,128 of 2,166 CONUS units remain blocked on disk |
| EPA ecoregions | **PARTIAL** | The planned CONUS Level III/IV entry is still valid (download page live, expected sizes unchanged) but no national artifact has been built; the regional job is per-state and the national semantic comparison is unexamined |

The next national derived-phase task only starts when all four are READY. Nothing in this phase activates
national discovery: the browser still reads the Oregon/south-west Washington regional plane.

### Updated derived-build forecast (labelled estimates)

Measured regional basis is unchanged: 6,244 corridors per 1,231 s of all-habitat work, 2,195 bytes per derived
row, 1.261 replicated rows per corridor. Applied to the measured **1,420,806 national corridors**, and now
corroborated by two national planes rather than by one:

* **stored derived rows**: 1.5–2.2 million (regional ratio 1.79 million);
* **derived GeoParquet**: 3.5–5.5 GB (regional ratio 3.93 GB), plus the raw planes themselves — roads 5.82 GB,
  NWI and hydro raw planes on the order of **tens of GB** each at national scale, given that 38 hydro units alone
  produced 2.87 GB and 2,166 units exist;
* **offline compute**: 60–120 hours single-worker metric work, dominated by corridor × wetland intersections;
* **intermediate disk**: **250–400 GB** for sources, normalized units, fragments and cells together — which is
  why the volume question is the gate, not the algorithm.

Every number above is an estimate except the ones marked measured; the regional ratios they are derived from are
in the benchmark reports.


A source refresh creates a new vintage/digest, invalidates affected county normalization and fragments, produces a new immutable version, passes geometry/equivalence QA, then atomically switches a catalog pointer. Old immutable objects remain available. The county and bucket checkpoints bound rework after a crash. Source fetch should stay at low bounded concurrency to avoid overloading Census; partition and component stages can use separate measured limits.

## Next data phases

**EPA ecoregions.** EPA offers [CONUS Level III and IV shapefiles](https://www.epa.gov/eco-research/level-iii-and-iv-ecoregions-continental-united-states) of roughly 35 MB and 69 MB with state boundaries. Pin both archives and test that their overlap semantics match the current regional EPA layers before switching to national whole-region handling. Their size does not call for the county road shard model.

**NWI wetlands.** Phase 2A pins the complete 49-package May 2026 state GeoPackage source set, freezes an exact cross-package identity rule, and builds checkpointed source and cell stages as described at the top of this document. The 60.5 GB compressed source set exceeds the disk headroom of this laptop when cached together. Source packages are verified, processed one at a time by default, and removed after validated normalization. A full `present`/`empty` catalog requires all 49 state jobs; partial manifests explicitly mark unbuilt cells. The regional v3 correction for exact Columbia River package copies is part of the same semantic work.

**Hydrography.** Freeze a national **legacy NHD High Resolution** snapshot for Phase 2. [USGS still distributes legacy NHD by HU8, HU4, state, and nation](https://www.usgs.gov/3d-hydrography-program/access-3dhp-data-products), while 3DHP is a different, actively updated generation. Migrating to 3DHP during national scaling would change feature and metric semantics and break regional equivalence. Pin bounded HU8 or HU4 archives with digests, dedupe overlap by layer plus source permanent ID, and retain current clipped-length and feature-count definitions. Evaluate 3DHP as a separate migration after the national legacy plane is verified.

**Derived-plane forecast.** The corrected regional derived plane measures **6,244 unique corridors**, **7,875 replicated rows**, and **17,288,410 GeoParquet bytes** (2,195.4 bytes/stored row; 1.261 replicated rows/unique corridor). Applying those observed ratios to the measured **1,420,806 national corridors** suggests roughly **1,791,936 stored rows** and **3.93 GB** of future national derived GeoParquet. This is an estimate: corridor geometry complexity, habitat fields, and cell-crossing frequency vary nationally. The grid caps cell objects at 21,874; actual derived present/empty counts await habitat processing.

**Storage forecast, by layer.** Roads are measured at **5.817 GB publishable GeoParquet**, plus **2.226 GB component records** and **0.690 GB segmentation records** if those index artifacts are published for promotion/rebuild. The national road manifest is **5.3 MB**; component and segmentation manifests together are under **68 KB**. EPA's national Level III/IV source archives are listed at roughly **35/69 MB compressed**; converted artifact size awaits a pinned build. NWI's 49 state downloads span roughly 1 MB–4 GB each and have overlapping coverage; the OR/WA source subtotal is **3.062 GB**, but a defensible CONUS published-byte estimate needs measured state counts and dedupe. Legacy NHD national feature counts and partition bytes likewise await a pinned source inventory. Derived metrics are forecast at **3.93 GB** from the measured corridor count and regional row size. No combined national storage total is asserted until NWI and hydro have actual build measurements.

**Rebuild cost.** New annual road vintages require re-fetching up to 3,109 county ZIPs (the 2025 vintage totaled 4.03 GB), renormalizing changed source shards, rebuilding affected cell fragments and the global name/component closure, and resegmenting affected components. The 2025 local work figures above are the initial laptop benchmark. At the measured overall source-throughput of **2.82 MB/s**, a similarly sized full download-plus-normalization pass would be roughly **24 minutes** on this machine and connection, with separate cell compaction and component/segmentation work. This is a local baseline, not a cloud throughput promise. The three-object R2 trial validates upload semantics but is too small and request-heavy to extrapolate a credible 21,135-object upload duration; defer the bulk PUT cost until publication is needed for national habitat/derived launch.

`data/national/qa-samples.json` pins centers across Pacific Northwest, California, Desert Southwest, Rockies, Great Plains, Midwest, Gulf Coast, Appalachia, Northeast, and Florida. Each sample should check source identities, cross-county/cell seams, common-name components, largest components, corridor geometry and length, typed empties, and eventually raw/derived habitat equivalence. The regional Oregon/Washington regression remains a gate on every national road build.

## Phase 2C: the external build volume (Lexar)

### Volume, and what ExFAT requires of the factories

`/Volumes/Lexar` is a 1 TB external SSD, measured before use as **954 GiB total / 954 GiB free**, writable,
formatted **ExFAT** with a **262,144-byte allocation block**. It is not repartitioned or reformatted; it is the
scratch and build volume, and the repository stays on the boot volume where the committed manifests, source and
tests live. Working root: `/Volumes/Lexar/roadnaturalist/{sources,work,cells,tmp}/{nhd,nwi}`.

Measured characteristics that shaped the code:

| Measured | Result | Consequence for the factories |
| --- | --- | --- |
| Sequential write / read | 883 MB/s write, 8.4 GB/s cached read | no I/O concern; the build is network- and CPU-bound |
| `os.replace` (atomic checkpoint writes) | works | every checkpoint and manifest writer is safe unchanged |
| SQLite `journal_mode=WAL` | works | the identity database stays in WAL mode on the volume |
| DuckDB out-of-core | 20 M-row sort with a 512 MB limit and temp on the volume: 1.2 s | the compaction may spill there |
| 500 small Parquet files | written in 0.5 s | fragment/cell granularity is fine |
| **AppleDouble sidecars** | macOS writes `._name` beside files that carry extended attributes | every directory scan filters dotnames: a sidecar must never be read as a checkpoint or counted as a second file geodatabase. `scripts/build_volume.py:is_data_file` is the shared filter, and the two places that could have been fooled (the hydro extractor's `rglob("*.gdb")` and the wetland partitioner's `glob("*.json")`) now filter explicitly |
| **256 KB allocation block** | every file costs up to 256 KB, so small files waste space | measured waste: the 5.0 GB hydro work tree occupies **9.1 GB** migrated. Acceptable at this scale (a national hydro plane projects to well under 200 GB), and reported rather than hidden |
| no POSIX permissions, no symlinks, no hard links | chmod is ignored; symlinks unavailable | nothing in the factories depends on them; copies are real copies |

`scripts/build_volume.py` also makes the volume the default workspace: `ROADNATURALIST_BUILD_VOLUME` names the root,
`/Volumes/Lexar/roadnaturalist` is used when it is mounted, and the repository-local path is the fallback for a
small run or a test. Every tool still accepts `--work`, which always wins.

### Migration, verified rather than assumed

Both existing boot-volume work trees were copied to the volume and then **proved** faithful, not assumed:

| Tree | Size on boot | On the volume | Proof |
| --- | --- | --- | --- |
| `national-hydro-work` | 5.0 GB | 9.1 GB (sidecars + cluster slack) | all **38** unit checkpoints re-hashed on the volume: 38 verified, 0 problems, and `verify:national-hydro` re-ran green against it |
| `national-wetlands-work` | 16 GB | 19.5 GB | `verify:national-wetlands --states AZ,DC` re-ran green against it: 694 present, 2 typed-empty, 21,178 unbuilt, 188,581 canonical, 2 ambiguous |

After both proofs, the boot-volume copies were deleted, freeing **21 GB** (44 GiB → 65 GiB free on `/`). Nothing
whose recovery status was uncertain was touched: the road factory's source cache and component index stay because
the two national road verifiers read them, and both were re-run afterwards (`verify:national-roads`,
`verify:national-index`) and passed unchanged.

### Measured concurrency for the national pin pass

The hydro lock now covers every CONUS unit of the measured inventory, and pinning is a bounded-concurrency pass:

| Workers | Measured throughput | Wall clock for the pass |
| --- | ---: | --- |
| 1 | ~2.5 MB/s | hours |
| 6 | **6.4–7.2 MB/s** | tens of minutes |

6 workers is ~3× sequential, and the pass is network-bound, so the gain stops there; the default stays 1 for a
small run and the national driver passes `--workers 6`. One truncated response used to abort the whole pass, which
is the wrong failure mode for thousands of independent downloads, so each unit now retries once, records its own
failure, and the pass continues; a re-run resumes from the lock.

### Two findings from extending the source set

**`permanent_identifier` is not one id family.** Unit `17090010` carries 14,515 GUID-shaped permanent identifiers
and **11,337 numeric-shaped** ones (`147814500`, reach code `17090007000745`), and the same mix appears in the
regional plane. NHD High Resolution therefore contains both originally-NHD features and features inherited from
NHDPlus. `nhd-permanent-identifier-v1` is unaffected — it treats the identifier as an opaque stable string, which
is why it works for both — but any future comparison must not assume a GUID shape.

**Partial-plane equivalence is a stricter claim than "the ids match".** Comparing the 38-unit national plane
against the published regional plane initially failed on 119 features. They were not missing: a cell that needs an
unbuilt neighbour is declared `unbuilt` and has no artifact by design, so features whose cells depend on units that
are not built yet cannot be compared. `verify:national-hydro --regional-equivalence` now compares only features in
cells the national plane actually built, asserts identity, classification and source attributes exactly, asserts
that a clipped regional extent never exceeds the whole national feature, and **reports** how many features and
cells were excluded because of unbuilt coverage. Equivalence becomes a whole-plane claim only when the national
plane is complete, which is the same gate roads and wetlands used.
