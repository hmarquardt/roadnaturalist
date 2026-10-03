# National derived corridor-metrics plane

The national derived plane applies the Road Naturalist discovery logic to the four verified national raw
planes. It is the same logic the regional derived plane uses (`docs/REGIONAL-DATA.md`), run at CONUS scale with
deterministic shards and per-shard checkpoints.

## Invocation

```sh
# full chain, fail-closed, logs on the build volume (resumes from every completed checkpoint)
ROADNATURALIST_BUILD_VOLUME=/Volumes/Lexar/roadnaturalist bash scripts/run-national-derived.sh

# one stage at a time
npm run build:national-derived -- --stage lookup
npm run build:national-derived -- --stage corridors --buckets 0:11      # 64 deterministic name buckets
npm run build:national-derived -- --stage index
NATIONAL_DERIVED_MEMORY=8GB npm run build:national-derived -- --stage metrics --shard sx-98_sy39
# or --shard-range 0:128; use one metric worker on the 16 GB M2
npm run build:national-derived -- --stage finalize
npm run verify:national-derived
npm run measure:national-derived
```

`scripts/run-national-derived.sh` refuses to start unless `npm run check:derived-readiness` reports all four
source planes READY. A stage that exits non-zero stops the chain; `PIPELINE COMPLETE` is printed only after
finalize, verification and measurement all succeed.

## Stages and determinism

| Stage | Unit | Reuse key |
| --- | --- | --- |
| `lookup` | one process | 3,109 normalized road shard digests |
| `corridors` | 64 name-hash buckets | component-index input digest + shared-code digest |
| `metrics` | 1,534 deterministic 1°×1° shards (`sx<lon>_sy<lat>`) | corridor-index digest + pipeline digest + fingerprint |
| `finalize` | cell at a time | per-cell bytes + SHA-256 in `finalize.json` |

- **Corridor identity is not re-derived.** `scripts/compose-national-corridors.mjs` streams the same per-name
  unit records the committed national segmentation used and applies the shared composition/segmentation
  modules (`src/roads/normalize.js`, `src/discovery/segment.js`). Every bucket is validated **fail-closed**
  against the committed `segmentation-manifest.json`: per-unit corridor counts must be equal as multisets.
  The result is exactly the committed **1,420,806 corridors**.
- **Chunk semantics are the regional builder's.** `scripts/build-national-derived.py` imports the regional
  builder and feeds it the national planes; every metric statement is unchanged, restricted per 25-corridor
  chunk by the same padded bounding box. Corridor assignment to a shard uses the corridor's minimum corner,
  so every corridor is measured exactly once.
- **Whole-row replication.** Each derived row is written into every one of the 21,874 national grid cells its
  geometry intersects, exactly as the runtime selects cells; final cells are GeoParquet with the same `geo`
  metadata contract as the regional plane.

## Consumed contracts (as verified, not restated)

- wetlands: dedupe on `source_feature_id` (`<state>:<objectid>`), feature-area-sum;
- hydrography: dedupe on `(layer, source_feature_id)` with the runtime layer vocabulary `flowline` /
  `waterbody`, clipped-length and clipped-area sums;
- roads: the national normalized shards and name index (`tiger2025-county-v1`);
- ecoregions: the two CONUS artifacts (`epa-conus-2015-v1`), levels 3/4.
- the raw planes are read in place; nothing is rewritten.

### Disclosed identity collision

The committed component-id scheme can mint one `drv1-...` id for two different names (name `co-rd` component
62 and name `co-rd-c62` both become `drv1-co-rd-c62`). The committed segmentation carries 64 such ids; the
corridor plane carries **23** of them among its 1,420,806 corridors. The published id is kept exactly as the
shared segmentation mints it; internally every relation is keyed by a unique work key so two colliding
corridors in one shard can never overwrite each other. The count and examples are declared in
`data/national/corridors/index.json`.

## Disk

All large work lives on the build volume. Sources are read in place (roads 5.82 GB, wetlands 156.36 GB,
hydrography 26.58 GB, ecoregions 0.12 GB). The derived build's own scratch is modest: corridor Parquet
2.11 GB, metrics Parquet and per-shard cell parts of the same order, final cells ≈ 4–6 GB, and bounded
DuckDB spill (8 GB for one metric worker by default). Peak scratch is roughly 25–35 GB,
well inside the 387 GiB that was free when the build started; **no cleanup of raw-plane work trees was
necessary**.

## Representative validation (`data/national/derived-validation.json`)

Six required ecological/geographic conditions were measured before the national run, 14 shards in total
(26,393 corridors, 8,861 s wall):

| Condition | Shard | Corridors | s/corridor |
| --- | --- | ---: | ---: |
| Pacific Northwest | `sx-123_sy45`, `sx-124_sy45` | 4,439 | 0.40 |
| Northeast | `sx-75_sy40` | 5,064 | 0.28 |
| Gulf/Southeast | `sx-83_sy27` | 2,666 | 0.75 |
| Midwest/Great Lakes | `sx-94_sy44` | 4,242 | 0.29 |
| arid Southwest | `sx-113_sy33` | 2,268 | 0.14 |
| Great Plains | `sx-98_sy39` | 2,321 | 0.12 |

This sample is dense-biased; the national projection is 60–120 h single-worker (the forecast). The original
four-worker, 2 GB-per-worker run stopped during stage 3: two wetland aggregations exhausted their per-process
DuckDB limit, while two other workers independently encountered a row-serialization bug for corridors with no
Level III/IV primary ecoregion. The shared row writer now preserves the existing `NONE` coverage semantics by
writing null primary fields and raises an explicit error if an ecology summary is internally inconsistent.
A single-worker 4 GB probe on the previously OOM coastal shard also failed at the DuckDB cap after 644 s;
its peak process RSS was 5.09 GB. The resumed default is one metric worker, two DuckDB threads, and an 8 GB
DuckDB limit on the 16 GB M2 build machine. Existing complete shard checkpoints are digest-validated and
reused. The earlier four-worker wall-time projection does not apply to this configuration.

The same coastal shard (`sx-95_sy29`) completed at 8 GB: 792 corridors in 32 chunks, 906 s shard wall time,
5.83 GB peak process RSS, and 862 MB maximum *post-query sampled* DuckDB buffer use. The sampled value is
not DuckDB's transient query peak; the 4 GB failure established that the query can need more than 3.7 GiB.

The first failed chain left **156 complete shard checkpoints**. Its four failures were `sx-95_sy29` and
`sx-81_sy38` (DuckDB wetland aggregation OOM at 1.8 GiB), plus `sx-123_sy37` and `sx-109_sy48`
(ecoregion-primary serialization). The latter errors were independent of the OOM: `ecology_entry()` returns
a nonempty level summary even when its `intersections` are empty and `primary` is null; the old writer tested
the summary's truthiness and indexed that null primary. No partial failed-shard output is marked complete.
The repaired `sx-109_sy48` shard completed with 346 rows; four corridors have zero Level III and IV
intersections, `ecology_coverage=NONE`, and null primary fields, as intended.

### Regional equivalence (`data/national/derived-regional-equivalence.json`)

All nine shards overlapping the published Oregon/south-west Washington region were compared against the
regional derived plane: **3,313 corridors compared, zero gate failures**.

- corridor geometry/length and primary Level III/IV codes, coverage and ecology coverage: **exact**;
- wetland area sums: p95 relative delta **0.80 %** (gate 2 %); hydrography length/area p95 ≤0.07 %;
- `wetland_intersects` disagreement 2 of 3,313 (0.06 %); count deltas within ±3 for 99.97 % of corridors.

The measured tails are source-geometry differences, each proved by re-measuring both planes from their own
raw cells: the regional plane simplifies mapped wetland geometry (1 m) and can drop a sub-m² sliver at the
1 km ring; one 1000 m count outlier (delta 9) is nine real Washington features that exist in the
byte-identical May 2026 WA package and in the national plane but are **absent from the regional raw
partitions** — a pre-existing regional ingestion gap, recorded here rather than papered over.

## Publication planning

The final plane lives at `<build volume>/cells/derived/corridor-metrics/<fingerprint>/` with the manifest and
cells. Its R2 key shape is `derived/corridor-metrics/<fingerprint>/cells/<cell>.parquet`, the same as the
regional plane, so publication is a copy with immutable caching; no raw national plane needs to be published
for the derived plane to work. Runtime activation (a national catalog pointer) is deliberately not part of
this build.
