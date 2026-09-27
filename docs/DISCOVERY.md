# Candidate discovery

The discovery workspace also offers the partitioned Portland west region. It uses the same road-unit, segmentation, batch GIS, coverage and promotion modules as the original pilot; only the data resolution step differs. The spatial catalog selects required road-group cells and 1 km halo habitat cells from versioned GeoParquet on R2 (or local static files). Source features are deduplicated before analysis, and any missing required partition aborts the survey with `UNKNOWN` coverage. See [regional data](REGIONAL-DATA.md) for the exact layout, build and performance decision.

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

The same declaration carries the **published region** (`publishedRegion`), the bounds the derived
corridor-metrics plane covers, so the interface can say what a centre will do before anything is fetched.

## Interactive search: choose a centre, choose a radius

Discovery is not limited to the declared windows. The search area control offers a **custom radius search**
alongside them, and its definition is a plain value: a centre and a radius in whole statute miles from 1 to 50.

```
choose a centre                    choose a radius                 search
map click / tap  ─┐
lat, lon fields  ─┼─► { center, radiusMiles } ─► radius search area ─► derived discovery
preset / recent  ─┤        (validated)            (same catalog and
shared URL       ─┘                               required datasets)
```

* **Centre.** `Set centre on map` turns the map into a picker: a click or tap places the centre (a drag still
  pans, and a road click is still a road click), and Enter with the map focused places it at the middle of the
  current view. The labelled **Latitude**/**Longitude** fields are the non-map alternative and take the same
  input the URL does. A chosen centre can always be changed by choosing again.
* **Radius.** A slider and a number field (both labelled), with 5/10/25/50-mile stops. Moving the slider
  previews the disk and starts nothing; releasing it commits a radius. There is no continuous search: changing
  the centre or the radius marks the results on screen as belonging to the previous search, and a person
  starts the next one.
* **Preview.** The map draws the chosen centre, the requested radius, the bounding box the cells are selected
  with, and the published region outline. It is a visual aid only: inclusion stays the exact geographic radius
  test in `src/discovery/run.js`, and no geometry is read from the drawing.
* **Coverage.** `FULL`, `PARTIAL`, `NONE`, or `UNKNOWN` is stated on screen (as text, and before the search
  runs) from the published region. PARTIAL is a warning about where the data reaches, never a claim that
  nothing is there; NONE disables the search with the reason rather than answering it emptily. The radius is
  never silently shrunk to fit the available data.
* **Presets and recents.** Selecting a declared radius scenario, or one of the last searches, simply fills the
  centre and radius and uses the same path; there is no separate preset discovery logic.
* **Sharing.** The definition is written to the URL as `?lat=…&lon=…&r=…`, so a link reloads the same search;
  a link never runs one by itself. Invalid parameters are reported and ignored rather than executed.
* **Remembering.** The last chosen search and up to eight recent searches live in two small versioned
  localStorage entries on this device. No account, no cloud state, no saved trips.

The summary under the coverage banner reports the search that produced the results: its radius and centre, the
corridors found, the metric cells loaded and their bytes, and the stage timings. Coordinates are shown; there
is no reverse geocoding, no place names, no browser location permission, and no address search in this pass.

Because the road window and the habitat window are the same rectangle, a corridor inside it can reach
FULL discovery coverage. A corridor whose 1 km buffer leaves the window reports PARTIAL for that
distance, and a corridor whose geometry the analysis engine cannot buffer reports UNKNOWN. Missing
coverage is never rendered as zero habitat.

## Finding a place by name

The centre can also be named. Typing a place into **Find a place** resolves it to a centre and hands that
centre to the same search definition a map click or a typed coordinate produces:

```
"Hillsboro"  ->  local gazetteer  ->  Hillsboro, OR (45.5268, -122.93539)  ->  the radius control  ->  derived discovery
```

It is a lookup, not a geocoder. There is no street-address search, no live geocoding service, no browser
location permission, and no landmark or feature search: a few hundred named places are matched in the
browser, in a fraction of a millisecond, and nothing leaves the page.

### Source

| | |
| --- | --- |
| Agency | U.S. Census Bureau |
| Dataset | 2025 Gazetteer Files — Places (national) |
| Source archive | `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_place_national.zip` |
| Published | 2025-09-10 (member file date 2025-09-08) |
| Archive digest | 1,214,053 bytes, SHA-256 `49644173a453469d9bd77fb7a493b027f87567e209edaf2078aac7543ac2ee29` |
| Member | `2025_Gaz_place_national.txt`, 3,288,984 bytes, SHA-256 `15f4977a010cc42308f4d5ddc5e19f26ef63fc035f20745333a14b78aa08d3fa` |
| Licence | Public domain (U.S. Government work) |
| Vintage | The same Census vintage the pinned TIGER/Line 2025 road geometry comes from |

### What a place is here

Places are the Census Bureau's own legal and statistical places, by LSAD code, and nothing else:

| LSAD | Class | Shown as |
| --- | --- | --- |
| 25 | `city` | City |
| 43 | `town` | Town |
| 57 | `cdp` | Census-designated place |

The build refuses to guess: a row is kept only when the published `NAME` carries exactly the class suffix
its LSAD implies, and when `FUNCSTAT` matches that class's status (active legal entity for a city or town,
statistical entity for a CDP). Unincorporated communities, post-office names, streams, peaks, schools,
churches, roads and buildings are **not** in this dataset and are not searched.

### Scope

The gazetteer covers the published regional coverage plus a margin wide enough for the largest search the
interface offers (50 statute miles):

| | |
| --- | --- |
| Published region | `[-124.05, 44.75, -121.77, 46.42]` |
| Window rectangle | `[-125.11284, 44.02205, -120.70716, 47.14795]` (published region ± 0.727946° latitude, ± 1.062840° longitude, evaluated at the window's most poleward latitude) |
| Inclusion rule | inside the rectangle **and** within 50 miles of the published region |
| Places | 387 (234 Oregon, 153 Washington: 172 cities, 9 towns, 206 CDPs) |
| Artifact | `data/places/or-sw-wa-portland-places.json`, 57,249 bytes, SHA-256 `7c07b18b686896683abee953f482f41ac545663f7c975c9792ee74298f744d24` |

The rectangle is only the outer bound; the rule is the distance, so every place in the artifact can reach
published coverage with a search of at most 50 miles. A place whose own search could never reach the region
is not offered at all — it could not return a corridor at any radius, and the interface does not present dead
ends. A place outside the published region is deliberately **kept** when it can reach it: the search is
reported PARTIAL and the outside is never read as empty.

### Identity and disambiguation

The place id is the Census Bureau's own 7-digit place GEOID, which encodes the state FIPS prefix; a name is
never an identifier. Two places can share a name, and the result list shows what separates them:

```
Toledo, OR            Toledo, WA            Fairview, OR                Fairview, OR
City                  City                  City                        Census-designated place
```

### Matching

Normalization is deterministic and applied identically to a query and to every stored name: Unicode NFKD
with combining marks removed, case folded, periods, apostrophes, hyphens and slashes treated as separators,
remaining punctuation dropped, whitespace collapsed, and two documented abbreviation folds (`st` → `saint`,
`mt` → `mount`) so that "St. Helens" and "Saint Helens" are the same query and the same place. Nothing else
is rewritten, and no alias list is invented.

Matching runs in tiers, in this order, and stops at the first tier that matches:

1. **exact** normalized name
2. **prefix** of the name (`hills` → Hillsboro)
3. **word prefix** of any later word (`grove` → Forest Grove, Oak Grove)
4. **one typo** — a single insertion, deletion or substitution, only for queries of at least five characters
   and only when the first character already matches (`hilsboro` → Hillsboro; `millboro` → nothing)

A trailing state qualifier (`toledo wa`, `toledo, washington`, `toledo oregon`) narrows the match instead of
being part of the name. A query shorter than **three characters** is refused rather than guessed at; the
minimum is measured against this list (at two characters five prefixes already fill the capped list and the
mean result count is 3.2; at three characters no prefix exceeds six and the mean is 1.4). At most eight
results are returned, ordered by name length and then alphabetically — there is no score, no popularity
ranking, and no wild guess for a short or unrelated query. An address-shaped query matches nothing and says so
plainly.

### Behaviour

* Selecting a result sets the **centre** and nothing else: the radius control keeps the radius it had, the map
  moves its centre marker and radius preview, the coordinate fields and the coverage line update, and the URL
  is rewritten.
* Selecting a place never starts a search. Choose the radius, then press **Discover roads**.
* The search a place produces is the search its coordinates produce: the definition centre is the published
  five-decimal interior point, the bounds come from the same `radiusBounds`, the same metric cells are
  selected, and the same exact-radius test decides which corridors are results
  (`tests/place-gazetteer.test.js` asserts the derived result rows are equal).
* The URL stays coordinate-based (`?lat=…&lon=…&r=…`). A place is presentation: a recent search may be
  labelled `Hillsboro, OR · 25 mi`, `Near Forest Grove, OR · 10 mi` for a centre that was picked or typed, or
  `45.5268, -122.9354 · 25 mi` when no published place is close enough. Nothing about running or sharing a
  search depends on the gazetteer.
* Coverage semantics are unchanged: a place outside the published region reports PARTIAL or NONE exactly as a
  typed coordinate there does, and the radius is never reduced to fit the data.
* The field is a labelled combobox with a listbox of options: mouse and touch select, ArrowDown/ArrowUp move
  the active option, Enter chooses it, Escape closes the list and keeps the text, and Tab closes it. It is
  usable without the map at all.

### Commands

```
npm run build:places                # fetch the pinned archive and rebuild the artifact (stdlib Python, no GIS stack)
npm run check:places                # re-derive from the cached archive and compare bytes with the committed artifact
npm run verify:places               # offline: source, window, ids, classes, counts and the places the tests use
npm run verify:places:production    # opt-in: the deployed place search, promotion, PARTIAL/NONE, zero external calls
```

### Known limitations

* Only incorporated places and census-designated places are searchable. A named community that is not a
  Census place is not found, and the interface says so rather than guessing at a nearby name.
* The centre is the published **interior point**: a search centre, not a road, an entrance or a parking place.
* The list is regional and versioned. It is rebuilt from a new pinned vintage by changing the digests in
  `scripts/build-places.py`, never by hand-editing the artifact.

## Search context: the centre's name, and where each road lies

Two presentation facts are derived from the centre a person chose. Both are measured, both are local, and
neither can change what a search returns (`src/discovery/search-context.js`).

### The centre's label

| Priority | What the panel shows | Where it comes from |
| --- | --- | --- |
| 1 | `Hillsboro, OR` | the place a person chose from the gazetteer (explicit, authoritative) |
| 2 | `Near Vernonia, OR` | the nearest published place, when one is within 10 miles (inferred) |
| 3 | `Centre: 46.2800, -121.8800` | the coordinates, which are the search |

* The wording is deliberately modest: the gazetteer holds Census **interior points**, not downtown addresses,
  entrances or population centres, so a picked centre is **near** a place, never inside it.
* The inferred label is only attached when a place is close. Against the committed artifact (387 places,
  median nearest-neighbour spacing 3.0 mi, p90 6.9 mi) a uniform grid inside the published region is 5.2 mi
  from its nearest place at the median, 9.4 mi at p75, 14.4 mi at p90 and 24.6 mi at worst, so **10 miles**
  labels about 77% of in-region centres and leaves the rest to their coordinates. A centre 25 miles from a
  town is never described as "near" it.
* The centre is never moved. A map pick keeps the coordinate the click landed on, a typed coordinate keeps
  what was typed, the URL stays `?lat=…&lon=…&r=…`, and the place never snaps a search or appears in a link.
* `place` (explicit) and `near` (inferred) are stored separately beside the definition. Only `place` is
  written to the recent-search list; `near` is regenerated from the gazetteer on every render, so a stale
  label can never describe a search it does not belong to.
* The lookup is a linear scan over a few hundred places (~0.03 ms per query, measured). No index, no network,
  no reverse geocoding, no location permission, no popularity weighting, and ties resolve by name, then state,
  then Census GEOID, so the same centre always produces the same label.

### Distance and direction from the centre

Every result of a radius search carries four measured values:

| Field | Meaning |
| --- | --- |
| `distanceFromCenterM` | straight-line metres from the centre to the nearest point of this corridor |
| `nearestCenterPoint` | that point, as `[longitude, latitude]` |
| `bearingFromCenterDeg` | initial great-circle bearing from the centre to that point, in `[0, 360)` |
| `cardinalFromCenter` | the 8-point compass direction of that bearing (`N`, `NE`, …) |

* The distance is the minimum over the corridor's segments and vertices — not the centroid, the midpoint, the
  first coordinate or the bounding-box centre. A road running through the centre reports `<0.1 mi`.
* It is the **same measurement the exact-radius search decided with**: `closestPointOnLineM` returns the
  distance and the point in one pass, `minDistanceToLineM` is that value, and the run keeps a corridor when
  `distanceFromCenterM <= radiusM`. There is no second geometry implementation for display, so a shown
  distance can never disagree with the radius that admitted the corridor.
* The bearing runs from the centre to the nearest point, so it describes the direction of the nearest part of
  the road, not a heading along it. Below 10 m the direction is not meaningful and is left out rather than
  invented; the distance still shows.
* The compass is a sector rule, not a tuning: `N` is `[337.5°, 22.5°)`, `NE` is `[22.5°, 67.5°)`, and so on.
* Statute miles, the unit the radius is chosen in: `0.8 mi`, `4.2 mi`, `8.4 mi NW`, `17.6 mi`, `<0.1 mi`.
* This is **straight-line distance and orientation: not driving distance, and not a ranking**. No route
  distance, no travel time, no road-quality measure, no recommendation.
* A declared box search has no centre, so all four fields are `null` and the column shows `—`.
* The raw path keeps its pre-existing unit rule for inclusion (a corridor of an admitted composed unit is
  present even when that corridor lies beyond the disk — the difference the equivalence capture records), so a
  raw result may report a distance larger than the requested radius. The derived plane, which is what
  production runs, selects per corridor, and its reported distance is always within the radius.

### Where it appears

* **Result table** — a `From center` column beside `Length` with the distance and compass point
  (`8.4 mi NW`), carrying the straight-line explanation as its tooltip. It survives at 390 px, where the
  ecoregion column is the one that collapses.
* **Selected corridor** — a `From search center` row with the distance, the compass point and the numeric
  bearing, followed by the sentence that says what it is not.
* **Search summary** — the radius line names the centre the way the panel does
  (`25-mile radius search · Near Vernonia, OR`), and the run's own centre stays in the quiet line below it as
  `centre 45.5400, -123.1700`. A summary that outlives its search is labelled from *that* run's centre, never
  from a newer draft centre.
* **Map** — selecting a corridor draws one dashed line from the centre to the nearest point of that road.
  Only the selected corridor gets one: thousands of distance lines would say something else entirely.
* **Sorting** — `Distance from center` is an explicit sort beside the others, ascending, with an unmeasured
  distance sorted last. It is not the default and not a recommendation; the display default of the table is
  unchanged.

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

Raw regional road-cell selection closes over the published **road component index** rather than over names. A
component is one named road in one place, built from the same normalization and 150 m endpoint rule this layer
composes with, so a common street name in an unrelated town can no longer pull its cells into the search. The
index is declared in the catalog with its byte count and SHA-256 and verified on load; a catalog without one
(the first published slice) keeps its name index, bounded by cell adjacency. Measured effect on the committed
scenarios: 10-mile closure 52 cells / 23.4 MB -> 26 cells / 13.5 MB, 25-mile 46 / 17.4 MB -> 27 / 11.6 MB,
50-mile 22 / 1.5 MB -> 6 / 0.5 MB, with long continuing highways - not street names - as the remaining
contributors. See [regional data](REGIONAL-DATA.md).

The semantics a derived corridor-metrics artifact would freeze are pinned in
`data/regional/analysis-profile.json` and hashed into an analysis fingerprint by
`src/discovery/analysis-fingerprint.js`. Nothing derived is served yet; when it is, a manifest whose
fingerprint does not match the current rules must report derived discovery as unavailable rather than show
stale numbers.

The measurement definitions are the ones detailed corridor analysis already uses
(`src/gis/habitat-result.js`, `src/gis/ecoregion-result.js`): the same measurement CRS, the same
neighbourhood pads (`paddedBounds`), and the same per-distance coverage rule. The metric *expressions*
(clipped area, clipped length, distinct feature count, and the coverage predicates) live in one shared
module, `src/gis/habitat-metrics.js`; `tests/habitat-metrics.test.js` asserts that the statements both paths
issue actually contain them, so the batch and the detailed panel cannot drift apart. Playwright asserts that the
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

### Known limits of this boundary

* **Canonical road length still counts a doubled traversal twice.** Repair removes the duplicate from the
  *analytical* geometry only; the canonical corridor keeps the doubled leg, because changing what the
  interface reports as road length for existing corridors is a separate, reviewable decision about source
  truth, not a geometry-robustness fix. The difference is now explicit per corridor in
  `removedDuplicateLengthM` and `lengthDeltaM`.
* **Rungs 2 and 3 have no production caller yet.** They exist for self-touching and self-crossing lines and
  are exercised by node tests, `npm run verify:geometry`, and future extracts; the eight real failures all
  need rung 1 only.
* **GEOS overlay operations on two nearly identical buffers can still throw** (`found non-noded
  intersection`), which is why the repair decision is made by buffer probes and never by comparing buffer
  polygons. Road Naturalist does not compute buffer differences anywhere in the running application.
* **A repair is per corridor, not per radius.** If one radius is refused, the corridor is measured with the
  repaired geometry at every requested distance, so a corridor never reports a mix of geometries.

Operators can re-run the whole check offline, with no network, in about a second:

```bash
npm run verify:geometry            # per-corridor table: rung, removed traversal, length and displacement
npm run verify:geometry -- --json  # the same facts, machine-readable
```


## Discovery signals

Every result carries raw measured values with their units (`src/discovery/signals.js`):

* **road** — length, TIGER class, counties, source feature count, composition, segmentation
* **from the centre** (radius searches only) — the straight-line distance to the nearest point of the
  corridor, that point, and the bearing and 8-point compass direction toward it. Null for a declared box
  search. See [search context](#search-context-the-centres-name-and-where-each-road-lies).
* **ecology** — primary Level III and IV, distinct ecoregion codes, transitions, coverage
* **wetlands** — intersects the corridor, nearest, area within 250 m / 500 m / 1 km, feature counts, types
* **hydrography** — mapped crossings, nearest flowing and standing water, flowline length and waterbody
  area within 1 km, named waters

Sorts are explicit: road name, length, distance from the center, nearest wetland, wetland area within 250 m,
wetland area within 1 km, mapped crossings, ecoregion transitions, distinct ecoregions. The default order
(wetland area within 250 m, descending) is a **display default**, labelled as such in the interface: it is not
a ranking and not a statement that the first road is better than the last — and neither is sorting by
distance, which orders by one measured value like every other sort. Filters are a length range,
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

A promoted corridor is the **corridor**, not the road group it belongs to. A long named road becomes several
contiguous analysis corridors, so promotion hands `promoteDiscoveryResult` the corridor that was selected and
the candidate's road record takes that corridor's canonical geometry (`corridorRoad` in `src/roads/road.js`)
while keeping the composed group's provenance: source feature ids, road ids, class, county, and the segment
index and count in its geometry evidence. Without that, promoting corridor 2 of 3 would measure all three and
the detailed panel would disagree with the survey row that produced it. See
[regional data](REGIONAL-DATA.md) for the measured divergence this fixed and
`npm run verify:regional-equivalence` for the offline check.

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

## Scaling status

The original pilot still reads a 1.2 MiB network extract, holds about 5,298 source features and
proposes 127 corridors. Regional discovery now selects spatial road, wetland and hydrography
GeoParquet partitions from a catalog, includes a 1 km habitat halo, deduplicates replicated features,
and composes road names across cell seams. A 34 × 26 km browser run measured 375 corridors in about
38 seconds. See [regional data](REGIONAL-DATA.md) for the build, measured smaller extents, R2 layout,
coverage semantics and the decision to defer 50-mile searches until a wider benchmark. Persistent
browser storage, derived metrics and Worker-side GIS remain unimplemented and require measurement.

## Files

* `src/discovery/` — constants, eligibility, units, segment, coverage, signals, filter, lifecycle,
  persistence, search-area, **search-definition** (the centre/radius model, coverage classification, URL
  state and recent searches), **place-gazetteer** (the local name lookup and the nearest-place inference),
  **search-context** (the centre's label, and the distance/bearing of a corridor from the centre), run
* `src/domain/geometry.js` — `closestPointOnLineM` / `minDistanceToLineM` (the one distance primitive the
  radius test and the reported context share), `initialBearingDeg`, `cardinalDirection`
* `src/domain/line-repair.js`, `src/domain/analytical-geometry.js` — the point-preserving repair ladder and
  its impact/acceptance policy
* `src/gis/analytical-geometry.js` — the shared preparation boundary used by the survey, detailed habitat
  analysis, and ecoregion overlap
* `src/gis/discovery-query.js` — the set-oriented batch analysis
* `scripts/verify-geometry.mjs`, `tests/geometry-repair.test.js`,
  `tests/fixtures/discovery-geometry-failures.json` — the offline geometry check and its regression record
* `data/discovery/search-areas.json` — declared search areas and the published region
* `data/gis/or-roads-network-2025.parquet` — the bounded road-network extract
* `scripts/build-road-network.py`, `scripts/tiger_sources.py` — the offline extraction
* `tests/discovery.test.js`, `tests/discovery.spec.js`, `tests/fixtures/or-roads-network.summary.json`
* `tests/search-definition.test.js`, `tests/search-center.spec.js`, `tests/search-production.spec.js` — the
  interactive centre/radius model, its browser interaction, and the deployed search verification
* `tests/search-context.test.js`, `tests/search-context.spec.js` — the nearest-place inference, the distance
  and bearing geometry, the exact-radius invariant, and the browser behaviour of the labels, the column, the
  sort and the 390 px layout
* `assets/css/discovery.css`, `src/ui/discovery.js` — the discovery workspace

See also [docs/ROADS.md](ROADS.md) for the road sources, [docs/HABITAT.md](HABITAT.md) for the habitat
extracts and buffered definitions, [docs/ECOREGIONS.md](ECOREGIONS.md) for the ecoregion layers, and
[docs/INVESTIGATOR.md](INVESTIGATOR.md) for the access workflow a promoted corridor enters.
