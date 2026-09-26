# Candidate discovery

Road Naturalist used to begin with three hand-selected roads. Discovery is the step before that: it
surveys a **bounded area**, proposes **road corridors** that carry physical and ecological
characteristics worth a closer look, and lets a person promote one into the ordinary candidate
workflow.

Discovery is **candidate generation**. It is not wildlife prediction, not a ranking, not a
recommendation, and it never decides what is "best". It measures facts and states its coverage.

```
search area -> bounded road network -> eligible road units -> deterministic segmentation
     -> one set-oriented GIS pass (wetlands, hydrography, ecoregions)
     -> filter / sort / inspect -> promote -> normal candidate -> existing evidence workflow
```

## What discovery is not

* **Not a score.** There is no wildlife value, likelihood, biodiversity index, or "best road". Every
  column is one measured value in its own unit, and every sort names the dimension it orders by.
* **Not access research.** Presence in a road centerline dataset is not evidence of public, legal, or
  practical access. A discovered corridor reports `ACCESS UNVERIFIED` and, once promoted, its access
  panel says no reviewed source is declared for it.
* **Not species evidence.** Discovery calls no occurrence API. Occurrence evidence is an explicit
  deeper-analysis step after promotion.
* **Not national coverage.** The pilot window is one bounded extract; the interface never claims more.

## Search area

`data/discovery/search-areas.json` declares the areas discovery may survey. A search area is accepted
only when it lies inside **every** dataset it requires (road network, wetlands, hydrography, both EPA
ecoregion levels); the loader fails closed otherwise (`src/discovery/search-area.js`). The pilot window
is `-123.07, 45.505, -122.75, 45.67`: the same bounded window the road, wetland, hydrography, and
ecoregion extracts were built for, about 25 km by 18 km west of Portland, Oregon.

Because the road window and the habitat window are the same rectangle, a corridor inside it can reach
FULL discovery coverage. A corridor whose 1 km buffer leaves the window reports PARTIAL for that
distance, and a corridor whose geometry the analysis engine cannot buffer reports UNKNOWN. Missing
coverage is never rendered as zero habitat.

## Road eligibility

Eligibility is an explicit, reviewable table (`src/discovery/eligibility.js`) built from Appendix E of
the TIGER/Line 2025 technical documentation — the same pinned source the road geometry comes from. The
published definitions and the reason for each decision are in the module; the summary:

| MTFCC | Published class | Disposition |
| --- | --- | --- |
| S1200 | Secondary road | **ELIGIBLE** — not-limited-access artery |
| S1400 | Local neighborhood road, rural road, city street | **ELIGIBLE** — the main discovery class |
| S1500 | Vehicular trail (4WD) | **SEPARATE** — kept in the extract, never mixed into named-road candidates |
| S1100 | Primary road (limited access) | excluded |
| S1630 | Ramp | excluded |
| S1640 | Service drive (frontage road) | excluded |
| S1710 / S1720 | Walkway / stairway | excluded |
| S1730 | Alley | excluded |
| S1740 | Private road (industrial, ranch, resource access) | excluded |
| S1750 | Internal Census Bureau road | excluded |
| S1780 | Parking lot road | excluded |
| S1810 / S1820 / S1830 | Winter trail / bike path / bridle path | excluded |

Any unlisted class is excluded with an `unrecognized TIGER road class` reason, so a new TIGER class can
never quietly enter discovery. An eligible feature with no source road name is kept in the extract and
not proposed, with that reason recorded. This is a **discovery filter, not an access finding**.

## Source features to discovery road units

A discovery road unit is one named road in one place (`src/discovery/units.js`):

1. eligible features are grouped by the normalized road name (`NW Cornelius Pass Rd` and
   `nw  cornelius pass rd` are one key);
2. exact and nearly-reversed duplicates collapse — the same rules as `src/roads/normalize.js`, reused
   through `dedupeSourceLines`;
3. connected components are found with the composition tolerance (150 m): features whose endpoints are
   within tolerance join, and a larger gap starts a second unit for the same name;
4. each component is composed with `composeRoadLines`, so the unit carries ordered geometry, reported
   gaps, source feature ids, counties, road classes, and the composition method.

No connector geometry is ever invented across a real gap. A unit whose source retraces a stretch
measures the composed line, which is the same length definition the application uses everywhere else.

## Long roads and segmentation

`src/discovery/segment.js` divides a unit longer than `MAX_CORRIDOR_M` (8 mi) into contiguous analysis
corridors of about `TARGET_CORRIDOR_M` (4 mi) each:

```
segments = 1 if length <= 8 mi else max(2, round(length / 4 mi))
```

Cuts land on source vertices along the composed geometry, segments tile the unit exactly (no gap, no
overlap), and they never bridge a reported gap. A unit shorter than `MIN_CORRIDOR_M` (1 mi) is not
proposed, and the run reports how many units were dropped for that reason.

These thresholds are analysis and interface units, **not ecological truths**: a corridor is a length of
road a person can inspect. Measured on the pilot window: 5,300 extracted features → 4,046 named road
units → 3,929 units below 1 mi → **127 discovery corridors** in the browser (121 by the offline summary;
see *Two implementations* below). Three units are long enough to be segmented.

## Discovery identity

Ids are deterministic and readable: `drv1-<road-name-key>[-c<component>]-s<segment>` — for example
`drv1-nw-cornelius-pass-rd-s1`. The same source extract and the same rules produce the same ids; page
reloads and regenerated artifacts do not change them. A name with several disconnected components keeps
its main unit id and numbers the others (`-c2`), and every unit carries a segment index (`-s1`), so
promotion, marks, and persistence address a stable corridor rather than a position in a list.

## Batch GIS analysis

`src/gis/discovery-query.js` measures every corridor in **one pass per dataset**, not one round trip per
corridor:

| Step | What it does |
| --- | --- |
| corridor table | every discovery corridor inserted once, with its own neighbourhood pads |
| projection | one `ST_Transform` into EPSG:5070 for the corridors, once |
| buffer table | one buffer per corridor per requested distance (250 m, 500 m, 1 km), computed once |
| extracts | the wetland and hydrography extracts are projected into temp tables once per run |
| wetlands | buffered intersection area and feature counts per distance, nearest mapped wetland, corridor intersection, class inventory |
| hydrography | mapped crossings on the corridor line, nearest flowing and standing water, flowline length and waterbody area per distance, waterbody names and types |
| ecoregions | Level III and IV overlap length per corridor, summarized with the same function the detailed analysis uses |
| coverage | `ST_Contains(extent, buffer)` per corridor per distance |

The measurement definitions are the ones detailed corridor analysis already uses
(`src/gis/habitat-result.js`, `src/gis/ecoregion-result.js`): the same measurement CRS, the same
neighbourhood pads (`paddedBounds`), and the same per-distance coverage rule. Playwright asserts that the
batch values equal the per-corridor values for the same geometry after promotion.

Two real-data limitations are reported rather than hidden:

* **Unbufferable geometry is repaired, or it fails closed.** Some TIGER centerlines make GEOS fail with
  `TopologyException: assigned depths do not match` at specific buffer radii (8 of 127 corridors in this
  window). Each corridor is probed individually, and a refused corridor goes through the shared
  analytical-geometry repair ladder (next section). A corridor that no accepted repair rescues returns
  UNKNOWN habitat coverage with that reason while its non-buffer signals are still measured, so the run
  stays usable instead of failing every other corridor.


## Analytical geometry repair

Three geometry roles are kept distinct, because conflating them is how a repair becomes a silent data
change:

| Role | What it is | Who owns it |
| --- | --- | --- |
| source geometry | TIGER/Line vertices as published | never modified by this application |
| **canonical corridor geometry** | the composed, deduped, segmented corridor: what the map draws and what reported road length comes from | `src/roads`, `src/discovery/units.js`, `src/discovery/segment.js` |
| **analytical geometry** | the geometry actually handed to buffered spatial operations | `src/gis/analytical-geometry.js` |

Normally `analytical == canonical`. When the engine refuses the canonical geometry, the analytical one is
a **point-set-preserving rewriting** of it and the relationship is recorded per corridor in
`provenance.geometryForAnalysis` (`repaired`, `method`, `canonicalLengthM`, `analyticalLengthM`,
`lengthDeltaM`, `displacementM`, `removedDuplicateLengthM`, vertex and part counts).

### Verified cause

The committed fixture `tests/fixtures/discovery-geometry-failures.json` holds all eight real failures with
their geometry, source feature ids, failing radii, the original GEOS message, and every repair variant that
was tried. What it shows:

* every one is `ST_IsValid = true` but `ST_IsSimple = false`: the line visits points of its own path twice;
* the retraced stretches are **exact duplicates** (the same vertex pair, usually reversed) or revisits of
  the same vertex — not the 2.5–18 m near-parallel digitizations that the retraced *shape* looks like
  before the coordinates are inspected;
* so the failure is not a property of the road and not a matter of precision: GEOS's offset-curve builder
  assigns side depths per input edge and cannot resolve a depth conflict where the line overlaps itself.

Repairs that were measured and **rejected**: `ST_Node` (also fixes buffering, but dissolves near-duplicate
parallel digitizations: length −14%…−49%, and up to 5,093 m² of buffered area moved one-sided),
`ST_SimplifyPreserveTopology(0.1 m)` (fixes only 5 of 8, and moves geometry), `ST_RemoveRepeatedPoints`,
`ST_MakeValid`, and per-segment decomposition (worse: 35 refusals instead of 11, with its own area changes).
The measurements for each are in the fixture's `repairTrials`.


### Repair ladder (`src/domain/line-repair.js`)

| Rung | Operation | Effect on the geometry |
| --- | --- | --- |
| 1 | `remove-duplicate-segments` | drops a segment whose unordered vertex pair was already traversed; the twin copy still covers exactly those points |
| 2 | rung 1 + `split-repeated-vertices` | subdivides at any vertex the path already visits |
| 3 | rung 1 + node self-intersections | inserts vertices where the line genuinely meets itself (crossing, touch, collinear overlap), then splits into simple runs |

Every rung is **subdivision or exact-duplicate removal only**. No vertex moves, no gap closes, no part of a
MultiLineString is joined to another, no branch disappears, no road is straightened, and no vertex is
invented: rung 3 inserts a point that lies on an existing segment, and only where two segments truly
coincide within 1 nm, so a 1 cm near miss is left as a near miss. In this window rung 1 is what all eight
need, which is why a run reports `remove-duplicate-segments` for 8 corridors and `none` for the other 119.

Length along the traversal does change when a doubled traversal stops being counted twice (−359 m to
−2,671 m for these corridors). That delta is **reported**, never hidden, and it is the only reason reported
road length and analytical length can differ: the interface keeps reporting canonical road length.

### Acceptance gate (fail closed)

`src/domain/analytical-geometry.js` rejects a candidate unless it passes all of:

* maximum displacement ≤ **0.05 m**, sampled symmetrically over vertices *and* segment midpoints of both
  geometries, so removing a segment that is not exactly duplicated shows up immediately;
* extent change ≤ 1e-6 degrees (≈0.11 m);
* at least 50% of the canonical traversal length kept.

These are engineering tolerances about numerical robustness, not ecological assumptions: TIGER/Line
centreline positional accuracy is measured in metres, so 5 cm is noise, while a repair that needed more
would be a different road. All shipped rungs measure **0 m displacement**, so the gate can only fire on a
repair that should not ship.

A candidate is used only when the engine actually performs the requested operation on it: the probe runs
the same `ST_Buffer` distances the analysis needs, per corridor, and reports failure per corridor. A
candidate the metric gate likes but the engine still refuses stays UNKNOWN — a function returning a
geometry is never treated as evidence that the requested query works.

### One boundary, every caller

`src/gis/analytical-geometry.js` is the single implementation. `src/gis/discovery-query.js` probes the
canonical geometry through the corridor table it already has (so the fast path costs what it always cost)
and rewrites only the repaired corridors' rows; `src/gis/habitat-query.js` prepares once per corridor and
hands the same decision to wetlands and hydrography; `src/gis/service.js` uses it for ecoregion overlap
too, so a repaired corridor's ecology agrees with its habitat metrics. Because the survey and the detailed
analysis request the same distances, they reach the same decision for the same corridor, which Playwright
asserts after promotion.

Policy for operations that do not need repair:

* **buffers, buffer coverage, buffer intersections** — prepared analytical geometry (this module);
* **ecoregion overlap length** — prepared analytical geometry, so it matches the batch;
* **occurrence distance to a corridor** (`src/gis/occurrence-query.js`) — canonical geometry. Measured: a
  point-to-line distance never failed for any of the eight, and a duplicated traversal cannot change a
  minimum distance. Privacy rules are untouched.

Operators can re-run the whole check offline, with no network, in about a second:

```bash
npm run verify:geometry            # per-corridor table: rung, removed traversal, length and displacement
npm run verify:geometry -- --json  # the same facts, machine-readable
```


## Discovery signals

Every result carries raw measured values with their units (`src/discovery/signals.js`):

* **road** — length, TIGER class, counties, source feature count, composition, segmentation
* **ecology** — primary Level III and IV, distinct ecoregion codes, transitions, coverage
* **wetlands** — intersects the corridor, nearest, area within 250 m / 500 m / 1 km, feature counts, types
* **hydrography** — mapped crossings, nearest flowing and standing water, flowline length and waterbody
  area within 1 km, named waters

Sorts are explicit: road name, length, nearest wetland, wetland area within 250 m, wetland area within
1 km, mapped crossings, ecoregion transitions, distinct ecoregions. The default order (wetland area
within 250 m, descending) is a **display default**, labelled as such in the interface: it is not a
ranking and not a statement that the first road is better than the last. Filters are a length range,
road class, mapped-wetland relation, maximum nearest-wetland distance, minimum mapped crossings, and
ecoregion. Everything filters and sorts locally after one discovery run.

## Coverage semantics

`src/discovery/coverage.js` reports three dimensions per result (road network, wetlands, hydrography)
and one run-level summary:

* **FULL** — the dataset covers the whole requested region for every requested distance;
* **PARTIAL** — some buffers leave the extract, with the affected distances named;
* **NONE** — the region is outside this bounded extract (a fact, not a zero);
* **UNKNOWN** — the dataset failed, or the corridor geometry could not be prepared for the requested query
  and no accepted repair rescued it, with the reason.

Repair never upgrades a failed measurement into a confident one: the coverage state comes from whether the
requested query actually ran on the accepted analytical geometry, not from whether a repair function
returned something. In the pilot window after repair there is no geometry-driven UNKNOWN left: 108 of 127
corridors are FULL for wetlands and hydrography, 16 are PARTIAL (the extract does not reach the widest
buffer), 3 are NONE (outside the extract), and none are UNKNOWN.

The run-level coverage is the worst of its dimensions, and the panel lists how many corridors have full
habitat coverage, how many source features were outside the eligible classes, and how many short units
were dropped. A failed or empty road-network read is `unavailable`, never "no roads here".

## Candidate lifecycle and promotion

`src/discovery/lifecycle.js` keeps three states: `DISCOVERED`, `PROMOTED`, `DISMISSED`. Marks are the
only persisted discovery state (`src/discovery/persistence.js`: one versioned `localStorage` entry,
device-local, discarded when unreadable or blocked). Promotion rebuilds the corridor with the ordinary
`createRoad` / `createCandidate` builders, so a promoted corridor is a **normal candidate**: the same
ecology, habitat, occurrence, access, and evidence-bundle behaviour, and no second kind of detailed
candidate.

Promotion does not require an Investigator probe entry. With none declared, the access panel states
`No reviewed research sources are declared for this corridor` and the finding stays `UNVERIFIED`.

## Performance (measured, pilot window, Chromium)

| Step | Time |
| --- | --- |
| road-network query (5,298 features; first call includes DuckDB init) | ~3.1–3.8 s (query itself ~0.5 s) |
| named-road composition (4,046 units) | ~80 ms |
| segmentation (127 corridors) | ~15 ms |
| batch GIS analysis (cold datasets) | 13.2 s (~104 ms per corridor, geometry preparation included) |
| geometry preparation (127 corridors: 127 canonical probes + 8 repairs) | 794 ms (probes 544 ms, repair 252 ms) |
| repeat batch | ~11.8 s |
| whole discovery run in the interface | ~15 s |

Batch phases from one repaired run: validate 1,022 ms · buffers 289 ms · prepare 1,428 ms · wetlands
5,310 ms · hydrography 5,739 ms · hydroTypes 127 ms · level3 329 ms · level4 245 ms · routeLengths 1 ms.
The validate phase is the per-corridor probe that already existed; repair itself measured 252 ms for the
eight corridors, and the 119 corridors that need no repair pay no repair work at all. A repaired run
measures *faster* end to end than the previous failing run (13.2 s against 16.7 s) because eight corridors
stop throwing inside the batch passes.

For comparison, the *detailed* per-corridor habitat analysis measures ~2.3 s per corridor on the same
geometry, so one batch pass is roughly 25× cheaper per corridor and does not multiply external traffic.


## Two implementations, one set of expectations

`scripts/build-road-network.py` computes the same extraction offline with an independent implementation
(the pinned archives, the same class filter, the same window) and writes
`tests/fixtures/or-roads-network.summary.json`: feature counts, unit count, class counts, excluded
classes, the three pilot roads, and the corridor count under the same thresholds. Node tests assert the
manifest entry, the fixture, the thresholds, and the search-area declarations agree with the browser
constants; Playwright asserts the browser reproduces the structural numbers exactly (5,298 eligible
features, 4,046 units) and the corridor count within 15%.

The residual difference (127 in the browser vs 121 offline) is **a threshold effect, not a defect**: the
offline probe sums source-feature lengths while the browser measures the composed corridor geometry, so
units whose source retraces a stretch measure longer in the browser and a handful of units within metres
of the 1-mile boundary fall on either side. Duplicate collapsing also breaks equal-length ties on the
source feature id in the browser. Both implementations are deterministic; neither is "the" answer to a
boundary case.

## Scaling: what would have to change

Measured limits first: the browser reads a 1.2 MiB network extract, holds ~5,298 features and 127
corridors in memory, and completes one bounded regional query in ~15 s. To move from this window to a
county, a 50-mile radius, or regional use:

1. **Partition the road extract** — one Parquet file per county or per analysis window with a small
   spatial manifest, so a run reads only the overlapping partitions.
2. **Partition habitat the same way**, keyed to the same windows, so buffers never cross a partition
   boundary silently; coverage semantics already assume the extract's recorded extent.
3. **Prune earlier** — query by the requested area *and* the eligible classes (already done) and stop at
   a bounded feature budget instead of transferring a whole window.
4. **Parquet row-group strategy** — sort rows by a coarse grid cell and keep row-group statistics so
   DuckDB's zone maps skip most of the file for a small area.
5. **Cache derived metrics** — discovery metrics are a pure function of (geometry, dataset versions), so
   a content-addressed cache (browser-side for hot areas, or object storage behind the Worker) would make
   repeat runs cheap.
6. **Consider Worker-side analysis** — if a run must cover a whole county, remote DuckDB behind the
   existing Worker boundary is the natural home (it already owns bounded upstream reads), but that needs
   a measured reason first and moves analysis off the deterministic browser path.
7. **Persistent browser storage** — an OPFS-backed DuckDB with the extract registered once would remove
   repeated transfers on repeat visits.

None of this is implemented yet; it is what the measurements above point at.

## Files

* `src/discovery/` — constants, eligibility, units, segment, coverage, signals, filter, lifecycle,
  persistence, search-area, run
* `src/domain/line-repair.js`, `src/domain/analytical-geometry.js` — the point-preserving repair ladder and
  its impact/acceptance policy
* `src/gis/analytical-geometry.js` — the shared preparation boundary used by the survey, detailed habitat
  analysis, and ecoregion overlap
* `src/gis/discovery-query.js` — the set-oriented batch analysis
* `scripts/verify-geometry.mjs`, `tests/geometry-repair.test.js`,
  `tests/fixtures/discovery-geometry-failures.json` — the offline geometry check and its regression record
* `data/discovery/search-areas.json` — declared search areas
* `data/gis/or-roads-network-2025.parquet` — the bounded road-network extract
* `scripts/build-road-network.py`, `scripts/tiger_sources.py` — the offline extraction
* `tests/discovery.test.js`, `tests/discovery.spec.js`, `tests/fixtures/or-roads-network.summary.json`
* `assets/css/discovery.css`, `src/ui/discovery.js` — the discovery workspace

See also [docs/ROADS.md](ROADS.md) for the road sources, [docs/HABITAT.md](HABITAT.md) for the habitat
extracts and buffered definitions, [docs/ECOREGIONS.md](ECOREGIONS.md) for the ecoregion layers, and
[docs/INVESTIGATOR.md](INVESTIGATOR.md) for the access workflow a promoted corridor enters.

