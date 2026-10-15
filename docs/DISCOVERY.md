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

## Choose a location, find roads, read five recommendations

The panel answers one question first - *where should I search?* - and once it has been answered it stops asking it.

```
BEFORE A RUN - the page's own heading, one sentence, and the ordinary path

  Find roads worth exploring.
  Choose a place, find the roads nearby worth a closer look, and see the mapped natural features behind each one.

  01 / Discovery                                    Find a place ......... [ Use my location ]
                                                    Near Princeton, IN · within 10 mi
                                                    [ Find roads ]
                                                    > Advanced search          <- declared areas, coordinates, radius

AFTER A RUN - the form has done its job, so it becomes a summary

  01 / Discovery
  Princeton, IN · within 10 mi · 396 roads considered          [ Change location ]
  > Find roads somewhere else                        <- the same place finder, Use my location and Find roads
       > Advanced search                             <- coordinates, map picker, radius, declared areas
  Recommended
       Best road-naturalist drives within 10 miles
       #1 Best overall   US Hwy 380  ...  [ Show on map ] [ More details ] [ Save ]
       #2 ... #5
  the selected road's own detail (when a card is chosen)
  > Explore all results                              <- coverage internals, filters, sort, the full table
```

**Measured, at 390 x 844.** Before a run the intro is **219 px**, the `Find roads` button's bottom edge is at **604 px**, and the
collapsed `Advanced search` row is **46 px** - the primary action is on the first screen, with the page at the top. After a run
the compact summary is **85 px** and, with the page still at the very top, the recommendation heading is at **569 px** and
`#1 Best overall` is at **707 px**: the answer is in the first viewport without a single scroll, and the search form that produced
it is gone. The long-form prose that used to stand in front of the panel - what the project is, what it measures, what it does
not know - now lives in **About this workspace**, one click from the header, which is where a person looks for it.

**Change location is not Advanced search.** It reopens the ordinary path - a place name, this device's location, `Find roads` -
with the current definition already in it, and it never shows a latitude field to somebody moving from Princeton to Evansville.
Advanced search stays where it was, one level further in, and holds the declared search areas, the exact coordinates, the map
picker, the radius and its presets. The controls are built once and moved, never re-created: there is no second draft, and
choosing the next location does not touch the recommendations already on screen.

**One focus move, and no more.** When a run completes and the recommendation heading is already on screen, focus goes there once
(`preventScroll`), so a keyboard or screen-reader user lands on the answer instead of at the button they pressed; when the heading
is off screen nothing is focused, because moving a page a person is reading - or a camera they are looking at - is worse than
leaving the answer where it is. Intermediate phases never move focus, and re-renders never move it again.

**The answer above the machinery.** What was searched is stated once, in three short pieces (where, how wide, how many roads) and
nowhere else: the panel does not repeat the count, the coordinates, the cell counts, the megabytes, the phase timings or the
coverage vocabulary in the ordinary flow. Those are `Explore all results` material, and the one limitation that matters is stated
as a consequence in plain words (see the coverage section below).

**What is on the ordinary path.** The place finder, **Use my location** (one position, used as the centre, with its privacy
line), where the search currently is, what radius it assumes, recent searches when there are any, and **Find roads**. That
is the whole first screen of the panel: at 390 x 844 the ordinary path is **317 px** from the panel's top, the primary
action sits at the bottom of the first screen, and the collapsed `Advanced search` row is 46 px. The page's own intro
section is what still occupies the first 556 px on a phone - see the note at the end of this document.

**What is one deliberate click away, unchanged and complete.** `Advanced search` holds the declared search areas (the
pilot window, the partitioned regional window, the benchmark radius scenarios), exact latitude/longitude with *Set centre*,
*Set centre on map*, the radius slider with its numeric field and the 5/10/25/50-mile presets, and the active-search
statement with the coverage vocabulary (`FULL`/`PARTIAL`/`NONE`/`UNKNOWN`). `Explore all results` holds the coverage banner
and the run's diagnostics, the filters, the sort control, the full measured table, the sort explanation and the segmented
road note. **No capability was removed, and no default changed:** the radius is still the 10 miles this product already
defaulted to, and the table still leads with `exploration-order-v1`.

**The disclosure is a real control.** `<details>`/`<summary>`, so keyboard activation works (Enter or Space), the collapsed
content is genuinely absent from the tab order rather than hidden by CSS, and the state is written on the click itself. That
last part is a defect this pass fixed: the `toggle` event is *queued*, so a re-render between a person's click and that
event used to rebuild the section closed - a lost click.

**Nothing important is behind a disclosure.** A failed search, a search that cannot overlap the published coverage, a
promotion that was refused, a stale result set (`These results are from the previous search…`), the no-results state and
the plain-language coverage consequence all stay in the ordinary flow. Only diagnostics are hidden.

**Coverage jargon becomes a consequence.** A healthy search says nothing technical: the recommendation section states
`Found 396 roads in this search.` When the data is incomplete the panel says what it means for the answer - *Some
environmental data is unavailable here, so recommendations may use fewer signals* (PARTIAL), *No published environmental
data covers this search area, so no recommendations can be made from it* (NONE), or *This search area's data coverage could
not be determined…* (UNKNOWN) - and the FULL/PARTIAL/NONE vocabulary, the reasons and the run's diagnostics stay under
`Explore all results`.

**The primary action says what it does.** The button reads **Find roads**. It used to read *Discover roads*, which was the
panel's own name for the machinery; a person pressing it is asking for roads. `Advanced search` and `Explore all results`
say what they hold; `Recommended`, `Best overall` and `How recommendations work` are the only vocabulary the ordinary path
uses, and the ranking's own names (`exploration-order-v1`, `naturalist-interest-v2`) appear nowhere in it.

**Searching somewhere else is still one click.** `Change location` in the recommendation section brings the search surface
into view and puts the cursor in the place field, and the compact search controls stay directly above the recommendations.

**Selecting a road needs no disclosure.** The selected corridor's detail panel sits between the cards and
`Explore all results`, so choosing a recommendation (or `More details`) shows what that road measured without opening the
full result set. `Show on map` is the primary card action and is still the ordinary discovery selection: one selection
state, no camera movement, no fit.

## Recommendations first, the workbench second

A search answers with a small ranked set of **recommendation cards**: the top five roads in the recommendation order, each
with one short verdict and two or three reasons in plain English, above everything else.

**The order is the evaluated one.** The cards are the prefix of `rankExploration` - the same
`exploration-order-v1` the table leads with, over the same centre and radius - and nothing in the card layer ranks
anything. A committed browser gate compares the five cards against the committed evaluation artifact for Princeton,
Portland and Phoenix (`southwest-dry`), so the surface cannot drift from the order the evaluation measured.

**One best overall, and no fake precision.** The first card is marked `#1 Best overall`; the rest are `#2`–`#5`. When the
next road is within `NEAR_TIE_POINTS` (the evaluation's own `nearTieInterval` of one point) the card says so in words -
*Close call: the next road is near-equal on the same measurements* / *Another strong option: near-equal to #1 on the same
measurements* - rather than letting a fraction of a point read as a verdict. No decimal score is ever the headline; the
score travels as a data attribute a reader can check.

**Every sentence is produced by a measurement.** `src/discovery/recommendation.js` is pure, deterministic and reads only
the components `naturalistInterest` already computed:

| Component band | Verdict | Reason, with the number it came from |
|---|---|---|
| wetland ≥ 60 and water ≥ 60 | `Wetland and water corridor` | `Mapped wetland crosses the road, 127 ha within 250 m` · `Frequent water crossings: 14 mapped` |
| wetland ≥ 60 | `Wetland-rich corridor` | `18 ha of mapped wetland within 250 m` |
| water ≥ 60 | `Water and crossings` | `Flowing water 120 m away` |
| ecological variety ≥ 60 | `Habitat transition zone` | `Crosses 3 mapped ecoregions with 1 transition` |
| both ≥ 35 | `Wetland and water nearby` | … |
| all below 15 | `Limited mapped context` | `Nearest mapped wetland 4200 m away` · `No mapped crossing or nearby water` |
| nothing measured | `Context not measured here` | no reason at all, and `Not measured here: mapped wetland, mapped water and ecological variety` |

The bands are the same 60 / 35 / 15 thresholds the rest of the interface already uses for a component value, so a verdict
can never disagree with the number the detail panel shows. A component that was **not measured** produces no claim about it
and no reason; a component that was measured and found nothing nearby produces a factual line rather than praise. A card
never says *wildlife*, *scenic*, *guaranteed* or *abundance*: none of those is measured by anything here, and a committed
gate asserts the absence in all three regions.

**A distance-flavoured verdict was considered and deliberately left out.** `Strong nearby option` cannot honestly fire:
the score is a weighted mean of the measured components, so a road whose components are all below the moderate band cannot
score in the strong band, and a road that does score strongly already has a habitat verdict above it. Proximity is still
stated - `1.2 mi from the search center`, and the near-tie sentence - but it is a fact, not a category.

**Actions reuse what exists.** `Show on map` and the road's own name both make the *ordinary* discovery selection
(`selectDiscovery`), the same one the table row and a map click make: one selection state, exactly one corridor emphasised
on the map, and no camera movement and no fit. `Save` is the existing promotion, so a recommended road becomes an ordinary
saved road through exactly the path the detail panel's own control runs, and a road already kept reads `Saved`. There is no
`Take me there`: navigation in this project is built from a *plan member's* representative point (field mode), and a
discovery result has no representative point, so nothing is invented for a card.

**Fewer than five, or none.** The cards are however many the search produced - one card if there is one, none if there are
none - and the panel states the count instead of padding the layout. A dismissed road is never recommended (dismissing it
is an explicit judgement about that search); if every corridor was dismissed the section says so and the table below is
unchanged.

**A declared area has no centre, so it has no distance.** The heading becomes `Top roads in this search area`, no card
shows a distance, and the order is the centreless fallback the exploration order already documents.

**The workbench is untouched.** Filters, the sort control, the full table, the coverage notes, the segmented-road note and
the detail panel are all exactly where they were, under `Explore all results`. If the person sorts by something else, the
recommendation section says so in one line (*The full results below are ordered by Road name. The recommendations above
always use the recommendation order.*) rather than letting two lists disagree silently. Nothing is hidden, and Pass 1
removes no capability.

**Verify it:**

```sh
npm test                          # the focused tests: top five, labels, reasons, missing data, near ties, selection
npm run verify:recommendations    # the browser gate: Princeton, Portland, Phoenix, a phone, and a centreless area
```

## The two orderings: `naturalist-interest-v2` and `exploration-order-v1`

Discovery's sorts were, until now, all raw measured values. `Naturalist interest` is the first ordering that is a
*model*, so it is implemented as one pure module (`src/discovery/ranking.js`), versioned, and explained in the panel
rather than asserted. It answers "how interesting is the mapped context around this road?" and does **not** change
with where the search was made.

`Exploration order` is a **different question and a different family**: "which roads should I consider first from
*where I searched*?" It is `naturalistInterest - penalty(distanceFromCentre / requestedRadius)`, implemented in
`src/discovery/exploration-order.js`, and it consumes the interest score rather than changing it. The penalty is
bounded (six points with the selected transform), so distance settles near-ties and can never bury a clearly more
interesting road, and it is normalized by the radius the search asked for, so 20 miles in a 50-mile search is not
treated as 20 miles in a 25-mile search. A search with no centre - a declared box - has no distance, and the order
falls back to the interest score. See `docs/EXPLORATION-ORDER-EVALUATION.md`.

**The results table leads with `Exploration order`.** It is the product default because a search is a request to find
roads worth considering *from where the person searched*; `Naturalist interest` is offered beside it as the
centre-independent view, and every factual sort is unchanged. A declared box search has no centre, so the default
there reduces to the interest order and the results line says exactly that rather than implying a distance.

**Version boundary.** `naturalist-interest-v1` was evaluated across eight U.S. regions while the derived reader
reported every corridor as two ecoregions with no transitions, so its ecological-variety component was a constant.
The weights and transforms never changed; the version is `v2` because the corrected ecology *inputs* move the order,
and an already-evaluated version must not quietly come to mean something else. v1's evidence is frozen at
`data/ranking/naturalist-interest-v1-evaluation.json`; v2's is at
`data/ranking/naturalist-interest-v2-evaluation.json` (see `docs/RANKING-DECISION.md`).

**Inputs.** Only measurements the discovery analysis already made, so ranking costs no raw read of any plane:
wetland `nearestM` / `area250M2` / `area500M2` / `area1000M2` / `intersectsCorridor`; hydrography `crossingCount` /
`nearestFlowingM` / `nearestStandingM` / `flowlineLength1000M`; ecology `ecoregionCount` / `transitions`; and each
plane's coverage state. The ecology counts come from whichever side knows them: a raw run reads its intersection
list, while a derived run reads the row's stored `l3_count`, `l4_count` and `transition_count`. Only the *primary*
region's name is stored, so the result reports the count of distinct regions (Level III and IV counted separately)
and the primary region - never a fabricated list of duplicates. An absent count is unknown, not one.

**Transforms.** Every quantity is bounded before it is weighted: `saturate(v, half) = v / (v + half)` gives
diminishing returns (half credit at 10 ha within 250 m, 30 ha within 500 m, 100 ha within 1 km, 3 crossings, 1 extra
ecoregion, 2 transitions, 5 km of flowline), and `proximity(d, scale) = 1 / (1 + d / scale)` decays distance
(0.5 at 250 m for wetlands, 200 m for flowing water, 400 m for standing water). Twenty crossings are therefore not
twenty times one, and 100 ha of wetland is not ten times 10 ha.

**Weights.** `wetland 0.45`, `water 0.35`, `ecologicalVariety 0.20`. Wetland is weighted `0.4/0.25/0.15` across the
250 m/500 m/1 km buffers plus `0.2` proximity; water is `0.4` crossings, `0.3` flowing, `0.15` standing, `0.15`
flowline; variety is `0.6` extra ecoregions, `0.4` transitions. The score is a weighted mean over the components
that were measured, scaled to 0-100.

**Missing data.** A component whose coverage is absent is omitted from the mean, named in `missing`, and reported
through `evidenceFraction` — an unmeasured wetland never reads as "no wetland". A corridor with no covered component
has `score: null` and orders last.

**Not a prediction.** Length is deliberately *not* scored (a long corridor gains nothing for intersecting more
habitat); the wording everywhere is "exploration order", never a wildlife probability, a recommendation, or an
access or safety statement, and each corridor's panel carries the standing note that says so.

## The planning map: decision, and what is deliberately not built yet

The current `src/map/corridor-map.js` is a fitted SVG schematic with no basemap and a viewport that resets on
redraw. It is not suitable for planning and will be replaced behind a narrow interface rather than extended.

**Decision: Leaflet 1.9.4, vendored.** Reasons: it is small and mature, handles raster basemap tiles plus GeoJSON
line overlays at the candidate counts a 25-mile search produces (hundreds, not millions), needs no WebGL, and can be
pinned and vendored into the repository so the runtime has no CDN dependency. MapLibre GL is rejected *for now*: its
vector-tile pipeline is capability we do not need, with a larger bundle, a WebGL requirement, and more to vendor.
The decision is revisitable if candidate counts or cartography demands it; it is recorded here so the next slice
starts from a decision rather than a debate.

**Basemap:** OpenStreetMap raster tiles with visible attribution, behind a one-line provider setting so the source
is replaceable, and degrade-tolerant by design: if tiles fail, corridor geometry, the candidate list and the
analysis are unaffected — basemap failure is a visualization problem, never a discovery failure.

**Not built in this slice, and named as the immediate next work:** the adapter (`src/map/geo-view.js`) with
list↔map selection synchronisation and viewport ownership (fit on a new search, on Fit results, on Fit selected;
preserve on selection, sort, filter, overlay and evidence changes), the geographic rendering of candidate geometry,
the search centre and *requested radius* (never the processing bbox), saved-road descriptors passed in by the state
layer rather than read from storage, the score rendered by weight/opacity rather than colour alone, and the browser
verification that measures render and selection timings at the maximum displayed candidate count.

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
"Use my location"──┘
```

* **Centre.** `Set centre on map` turns the map into a picker: a click or tap places the centre (a drag still
  pans, and a road click is still a road click), and Enter with the map focused places it at the middle of the
  current view. The labelled **Latitude**/**Longitude** fields are the non-map alternative and take the same
  input the URL does. **Use my location** asks the browser for its position, once, after a click - see
  [Use my location](#use-my-location). A chosen centre can always be changed by choosing again.
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

## Use my location

The centre can also be the browser's own position. It is one more way to answer *where*, and it changes nothing
else about a search:

```
"Use my location"  ->  navigator.geolocation.getCurrentPosition  ->  lon/lat  ->  the same validated definition
                                  (after a click, once)                              at the radius already chosen
```

* **User gesture only.** The permission prompt appears when a person presses the button, and never before: not on
  load, not when the discovery panel opens, not when a search or a candidate is restored from this device. A shared
  link cannot cause it, because a link carries only coordinates.
* **One position, on request.** `getCurrentPosition` once per click - never `watchPosition`, never a timer, never
  background tracking. Pressing the button again asks for a current-enough fix.
* **Conservative options.** `{ enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }`. A road-search
  centre is not turn-by-turn navigation: letting the browser answer from WiFi or cell rather than demanding a
  satellite fix is faster and kinder to the battery, a 15-second bound means the control always comes back, and
  accepting a fix up to a minute old avoids paying for a new one. The options never reach the search.
* **The radius is the person's.** A location changes the centre and nothing else: 25 miles stays 25 miles, and the
  reported accuracy never widens or narrows it.
* **The accuracy is stated, and it is the browser's.** The panel says `Search centre set from this device's
  location. Browser location accuracy: about 120 m.` - a sentence about the fix, never about the place label
  beside it. It is presentation only: it does not persist, does not reach the URL, and does not appear on result
  rows.
* **No search runs by itself.** The centre appears, the coverage preview is computed with the chosen radius, and
  nothing happens until **Find roads** is pressed - exactly like a place, a map click or typed coordinates.
* **No geocoder, and no snapping.** The centre stays exactly where the browser put it, rounded to the same five
  decimal places every other centre uses. A nearby published place is only a *label* (`Near Hillsboro, OR`, from
  the local gazetteer, within ten miles); with no place nearby the centre is labelled by its coordinates. No
  reverse-geocoding request is made, and nothing about the position is sent anywhere: not to a geocoder, not to
  the Investigator Worker, not to an occurrence source, not to a server that records where you are.
* **Nothing special afterwards.** The definition is the ordinary one, so the URL is `?lat=…&lon=…&r=…` with no
  marker for how it was chosen, the last search is remembered on this device like any other, and a promoted
  candidate carries the same verified search context (`7.0 mi N of Near Forest Grove, OR`) as a typed centre.
* **Every refusal is a sentence.** Declining the prompt (`Location permission was not granted…`), a device that
  cannot answer (`Your device could not determine a location…`), a timeout (`…did not report a location in time…`)
  and a browser without the API (`This browser cannot report a location…`) each say what happened and leave the
  place finder, the map picker and the coordinate fields exactly as they were. A browser without the API simply
  does not show the button.
* **The latest choice wins.** A fix that arrives after someone has picked a place, clicked the map or typed
  coordinates is discarded rather than overwriting the newer, explicit centre (`createLocationRequest`).
* **Measured.** The application's own work after the browser answers - validation, the gazetteer lookup, the URL
  write and the accuracy line - is about **0.05 ms** (2 000 iterations of the whole post-fix path, 93 ms total,
  real 387-place gazetteer). The wait for a fix is the browser's, and is never reported as application time.

### Saved roads: the collection a person keeps

A promoted corridor is saved on this device. **Saved roads** is where that collection lives, and where a person
arranges it: a favorite flag, a note in their own words, a deterministic order, and a fact-by-fact comparison of
two or three roads. None of it is evidence, and none of it changes a measurement.

```
promote a corridor  ->  Saved roads: favorite · note · sort · filter  ->  compare two or three  ->  remove
```

* **One annotation per saved road.** `userMeta` is stored *beside* the candidate record, never inside the
  candidate: `{ favorite, note, savedAt, updatedAt }`. The candidate model built by the domain stays exactly what
  it was, so nothing downstream - a filter, a sort, a finding, the evidence bundle - can mistake a note for a
  fact. A note is labelled *My notes*, and the panel says plainly that it is the person's own annotation and not
  evidence.
* **Favorite** is one boolean, one word, one meaning: keep this road near the top of the saved list. It is not a
  rating, a tier, or a score, and it never affects discovery or a candidate's facts.
* **Notes** are bounded at 2 000 characters, keep their line breaks, drop control characters, and are rendered as
  text - never as markup. They are written on a short debounce (600 ms) and flushed on blur, so typing is not a
  write per keystroke; the status line says `Saved on this device` only when the write happened, and says
  `Not saved on this device: …` when it did not.
* **Saved date.** A road saved for the first time records when it was saved; re-promoting the same road keeps the
  original date and the annotation, and a road kept from an earlier version of the storage format shows
  `Saved date unknown` rather than a date invented during migration.
* **Migration.** The candidate entry is versioned. This build writes version 2 (candidate facts plus `userMeta`)
  and reads version 1 as well: a version 1 collection migrates in memory with default metadata, is never rewritten
  by a read, and is written in the current format on the next durable change - favoriting, noting, saving or
  removing a road. A version this build does not know is left untouched on disk, and a record that cannot be read
  is still discarded on its own.
* **Sorting and filters.** Name, saved date (newest first, an unknown date last), favorites first, and distance
  from the road's own original search centre (nearest first, and a road with no centre last). Filters: all,
  favorites, has notes. There is no "best" sort, because Road Naturalist does not rank roads.
* **Comparison.** Two or three saved roads, as a table of facts: road, length, road class, status, favorite,
  saved date, a note preview, durable coverage, and the row that matters most here - **From original search
  centre** - because two saved roads may have been found from different centres and their distances do not share
  an origin. Session measurements (ecoregion, wetlands, hydrography, occurrence, access) appear only when this
  session actually measured them; otherwise the cell says `Not measured this session`, `Unknown` or `None mapped`.
  A restored candidate is not a candidate with zeros. The selection is interface state, never persisted, at most
  three, and a fourth attempt is refused with the reason shown. Nothing in the table is a verdict: no winner, no
  score, no colour that means better.
* **Removal.** Removing a saved road removes its card, its note, its favorite flag and its comparison slot, and
  rewrites the entry without it. The annotation belongs to the road, so there are no orphan metadata keys.
* **Device-local, and quiet.** Notes and favorites never leave this device: not to R2, not to the Investigator,
  not to an occurrence source, not to a geocoder, and not into the evidence bundle, which stays a record of
  evidence and provenance. Opening the saved collection - including after a reload - reads nothing: 0 R2, 0
  derived cells, 0 raw partitions, 0 external calls. Detailed analysis is still an explicit action for a restored
  road, and a comparison says so until it runs.
* **Measured size.** A published record is 7-28 KB (mean ~11 KB) and a 2 000-character note adds about 2 KB, so a
  hundred roads each carrying a maximum-length note is roughly 1.1-1.5 MB on top of the entry's own overhead -
  inside a localStorage budget, which is why the cap stays at 100 saved roads. The Node suite prints the measured
  figures (`SAVED_ROADS_SIZE`) for sets of 10, 50 and 100 with and without notes.

## Finding a place by name

The centre can also be named. Typing a place into **Find a place** resolves it to a centre and hands that centre
to the same search definition a map click or a typed coordinate produces:

```
"Princeton, IN"  ->  national gazetteer  ->  Princeton, IN (38.35447, -87.57951)  ->  the radius control  ->  national derived discovery
"47715"          ->  postal-code tier    ->  47715, IN (37.97230, -87.57110)     ->  the radius control  ->  national derived discovery
```

It is a lookup, not a geocoder. There is no street-address search, no live geocoding service, no browser location
permission, and no runtime request to any third party: every name is matched in the browser against committed,
versioned, public-domain government data, and nothing leaves the page.

### What is searchable

| Feature type | Source | Rows (conterminous states) |
| --- | --- | --- |
| Incorporated places (`city`, `town`, `village`, `borough`, `municipality`) | Census 2025 Gazetteer, places | 19,320 |
| Census-designated places (`cdp`) | Census 2025 Gazetteer, places | 12,171 |
| Consolidated city-county governments (Nashville, Louisville, Indianapolis, Carson City …) | Census 2025 Gazetteer, places | 8 |
| Counties and parishes | Census 2025 Gazetteer, counties | 3,109 |
| ZIP Code Tabulation Areas | Census 2025 Gazetteer, ZCTAs | 33,300 |
| Named federal areas (parks, forests, grasslands, refuges, wilderness, seashores, preserves …) | USGS Federal Lands of the United States, 1:1,000,000 | 1,329 |
| Communities the Census place file does not carry | USGS GNIS, populated places | 135,628 |

Population — the Census Bureau's Vintage 2024 estimates for places and counties — is the prominence signal
ranking uses. GNIS contributes no name a Census place already carries: a feature whose normalized name and state
describe a Census place is the same real place, and the build drops it (34,135 such features).

### Sources

| | |
| --- | --- |

### Delivery: three tiers, measured

The dataset is too large for one asset to be loaded on every visit, so it is partitioned by *what a query
needs*, and the partition was chosen from measurement (record counts, bytes, parse and index time, heap) rather
than intuition:

| Tier | Rows | JSON bytes | Compressed | Parse + index | Heap | Loaded |
| --- | --- | --- | --- | --- | --- | --- |
| `core` — places, counties, federal areas | 35,937 | 2.4 MB | 884 KB | ~96 ms | ~19 MB | in the background at start-up, overlapping the manifest |
| `postal` — ZIP Code Tabulation Areas | 33,300 | 2.0 MB | 495 KB | ~49 ms | ~18 MB | the first time a query is a five-digit code |
| `community` — GNIS populated places | 135,628 | 8.6 MB | 2.7 MB | ~218 ms | ~65 MB | the first time the core tier cannot answer |

They are ordinary versioned assets on the same origin as the application, so a browser caches them like any
other file; the community tier yields a frame before it is indexed, so the field can say "Searching every U.S.
place name…" instead of appearing to freeze. A tier that fails to arrive costs the names it would have carried
and nothing else, and the field says so.

### Matching

Normalization is deterministic, applied identically to a query and to every stored name, and written down once in
both languages — the builder emits `data/places/place-normalization-fixture.json`, and the browser is held to it
by a test: Unicode NFKD with combining marks removed, case folded, periods, apostrophes, hyphens and slashes
treated as separators, remaining punctuation dropped, whitespace collapsed, and three documented abbreviation
folds (`st` → `saint`, `mt` → `mount`, `ft` → `fort`). Directional abbreviations are deliberately *not* folded:
`n` already matches `north` by prefix, and folding a single letter would merge names that are not the same.

A trailing state qualifier is taken when something remains to search for — `princeton in`, `cookeville tn`,
`nashville tennessee`, `portland oregon` — so `new york` is a place, not a state with an empty name. A five-digit
query is a postal code.

Matching runs in tiers, in this order, and the best tier that matches wins:

1. **zip** — an exact published ZIP Code Tabulation Area
2. **exact** — the whole normalized name, with the state qualifier narrowing it
3. **prefix** — the name starts with the query (`great smoky` → Great Smoky Mountains National Park)
4. **word prefix** — a later word starts with the query (`grove` → Forest Grove, Oak Grove)
5. **one typo** — a single insertion, deletion or substitution, only for queries of at least five characters and
   only when the first character already matches (`princetn` → Princeton; `millboro` → nothing)

Inside a tier the order is deterministic and explainable: an administrative division yields to a place, then
**population** (so `evansville` leads with Evansville, Indiana and `springfield` with Springfield, Missouri),
then a place this device chose recently, then distance to the centre already on screen, then the shorter name,
then the name, the state and the id. Counties last within a tier is deliberate: a county is a division rather
than a place, so a bare name that is both means the place — `yellowstone` is the national park, not the Montana
county — and typing the division's own word (`orange county`, `gibson county indiana`) matches it exactly and is
unaffected. No fuzzy match can outrank an exact one, and two runs on the same input always produce the same
list. At most eight results are offered, each with what separates it from its namesakes:

```
Princeton, IN — Gibson County        Springfield, MO — Greene County
Princeton, NJ — Mercer County        Yellowstone National Park, WY — National park
47715, IN — Vanderburgh County       Gibson County, IN — County

### Behaviour

* Selecting a result sets the **centre** and nothing else: the radius control keeps the radius it had, the map
  moves its centre marker and radius preview, the coordinate fields and the coverage line update, and the URL is
  rewritten. The chosen place is a *label* beside a search, never the search itself.
* Selecting a place never starts a search, and reads no metric cell. Choose the radius, then press **Discover
  roads**.
* The search a place produces is the search its coordinates produce: the definition centre is the published
  interior point, the bounds come from the same `radiusBounds`, and the same national derived cells are selected
  (`tests/national-place-gazetteer.test.js` asserts both, against the real national manifest when it is on the
  machine).
* The URL stays coordinate-based (`?lat=…&lon=…&r=…`). A place is presentation: a recent search may be labelled
  `Princeton, IN · 25 mi`, `Near Forest Grove, OR · 10 mi` for a centre that was picked or typed, or
  `38.3545, -87.5795 · 25 mi` when no published place is close enough.
* Coverage semantics are unchanged: a place inside the conterminous states reports FULL, and a centre outside
  them reports PARTIAL or NONE exactly as a typed coordinate there does. No published place is outside the
  coverage, because the derived plane covers exactly the conterminous states and a place that could never return
  a corridor is not offered.
* The field is a labelled combobox with a listbox of options: mouse and touch select, ArrowDown/ArrowUp move the
  active option, Enter chooses it, Escape closes the list and keeps the text, and Tab closes it. It is usable
  without the map at all, and it works at 390 px.

### Known limitations

* The conterminous states only. Alaska, Hawaii, Puerto Rico and the territories are not offered, because the
  national derived corridor-metrics plane does not cover them: a published place there could never return a
  result, and the field says so rather than presenting a dead end.
* No street addresses and no runtime geocoding. An address-shaped query matches nothing, and there is no
  external fallback service — by design, so that no search depends on a third party being up, reachable, or
  willing. Adding one would be a separate, deliberate decision.
* The place is the published **interior point**, not a road, an entrance or a parking place.
* A county with a handful of incorporated places is offered by its county record, and the county record's centre
  is the county's published interior point — useful for "what is around here", not a statement about a town.
* Census-designated places carry no population in the estimates file, so they sort below incorporated places in
  the same tier. They are matched by name, not by prominence.

### The regional pilot artifact

`data/places/or-sw-wa-portland-places.json` — the 387-place Oregon/South-Washington list the pilot shipped — is
still committed and still verified (`npm run build:places`, `npm run check:places`, `npm run verify:places`,
`scripts/build-places.py`), together with its schema-1 reader tests. It is the record of how the place finder
behaved in one window, and the reason the two schemas are both readable: schema 1 is that regional list, schema 2
is the national tiers above. Production discovery reads the national tiers.

```

A county says `County`; a postal code names its state and the county holding its largest part; a protected area
names the kind of area it is. Three Springfields stay three places, told apart by state and county.

| Agencies | U.S. Census Bureau (gazetteer, ZCTA relationship, population estimates); U.S. Geological Survey (federal lands, GNIS) |
| Licence | Public domain (U.S. Government work), every source |
| Pinned by | archive and member SHA-256 digests in `scripts/build-national-places.py`; a build that cannot verify a source refuses to run rather than publishing a list nobody can reproduce |
| Cadence | annual (gazetteer, population estimates), decennial (ZCTA relationship), irregular (federal lands), continuous (GNIS) |
| Commands | `npm run build:places:national`, `npm run check:places:national`, `npm run verify:places:national` |

## Detailed promotion from published raw regions

Discovery runs on the derived corridor-metrics plane and always will: it is 2.68 GB, published everywhere, and
answered in a couple of seconds. **Detailed** analysis is different. Opening a discovered corridor into habitat
evidence rebuilds it from the raw road network and measures mapped wetlands and hydrography around it — which
means the raw national planes: roads 5.8 GB, hydrography 26.6 GB, and **wetlands 156.4 GB**, about 189 GB
together. Publishing that to answer a question about one road is the wrong trade, so it is not published. What is
published is a **bounded region** — a rectangle of the raw planes' own 0.2° cells, for the roads a requested area
actually needs and the habitat cells its 1 km analysis buffer reaches — and coverage grows only where someone
asked to go deeper.

## Roads are national; wetlands and hydrography grow where people explore

The raw planes are no longer one shape, because publishing them all one way is not the cheapest honest answer:

| plane | state | why |
| --- | --- | --- |
| derived corridor metrics | **READY everywhere** | 2.68 GB, the discovery payload, published once |
| roads | **READY everywhere** | 5.82 GB — about 2 % of the raw lake, for all 21,135 cells |
| ecoregions | **READY everywhere** | two whole-CONUS EPA layers (37.6 + 85.8 MB), published once |
| wetlands | **PARTIAL, on demand** | 156.4 GB — published where people actually explore |
| hydrography | **PARTIAL, on demand** | 26.6 GB — published where people actually explore |

Roads were the one plane whose *bounded* publication created a refusal class: a promoted corridor's id was
composed over the whole national road network, so rebuilding it needs every cell its **named road component**
occupies, and a bounded region could only close over components inside its own rectangle. A corridor on a long
highway therefore failed for want of a road cell — disproportionate complexity for the cheapest plane in the set.
Publishing the whole road plane removes that class outright: **a promotion can no longer be refused because of
roads**, and the only bounded question left is wetlands and hydrography. Measured (`npm run
measure:national-raw-footprint --global-roads`), a promotion's bounded requirement falls from a median of 5
objects / 16.6 MB to **4 objects / 15.5 MB** (p95 12 / 97.4 MB, worst 12 / 195.3 MB), and — the part that matters —
the failure modes are gone, not the bytes.

### The global roads publication

```
npm run publish:raw-roads          # the whole plane: 21,135 cells, 936 closure tiles, 5.82 GB
npm run audit:raw-roads            # re-audit every object, the closure tiles in full and a digest sample
npm run verify:raw-readiness       # the five statuses above, from the committed index and the origin
npm run measure:national-raw-footprint -- --global-roads   # the bounded requirement, roads excluded
```

Objects go to the planes' **own canonical namespace** — `national/roads/tiger2025-county-v1/roads/<cell>.parquet`
— which bounded regions already referenced, so the existing four region catalogs needed **no rewriting**: they
stay valid, and the runtime simply prefers the global plane where it is declared ready. Two documents travel with
it, both immutable and digest-pinned:

* `national/roads/tiger2025-county-v1/publication.json` — every cell's byte count and digest, the 739 typed-empty
  cells, and a directory of the closure tiles. Fetched once per promotion, never during discovery.
* `national/roads/tiger2025-county-v1/components/<tile>.json` — one 1° tile of the road-component closure: which
  named roads cross that tile and every cell each occupies. Tens of kilobytes, digest-pinned by `publication.json`.

The publisher enumerates the set from the **manifest**, not from a directory scan, verifies all 21,135 local
artifacts against the manifest's byte counts and digests before uploading anything, is idempotent and resumable
(an object already online with the right length is reused; re-running resumes), refuses to overwrite an immutable
key, and writes the readiness declaration **only after** the remote audit passes.

### Readiness, and what "partial" means

`data/national/raw-regions.json` carries a `globalPlanes` block beside its bounded regions:

```json
"globalPlanes": {
  "roads": { "state": "READY", "version": "tiger2025-county-v1",
             "presentCells": 21135, "emptyCells": 739, "objects": 22072, "bytes": 5863401000,
             "pathPrefix": "national/roads/tiger2025-county-v1/roads/",
             "publicationUrl": "national/roads/tiger2025-county-v1/publication.json",
             "publicationBytes": 5103900, "publicationSha256": "…",
             "closure": { "cellSpan": 5, "prefix": "national/roads/tiger2025-county-v1/components/", "tiles": 936 } },
  "ecoregions": { "state": "READY", "levels": { "l3": {…}, "l4": {…} } }
}
```

It is version- **and** digest-aware. A runtime that needs a roads version other than the one declared is told
nothing is ready and refuses rather than substituting a different road network; a publication whose digest does
not match the index is refused before it is parsed. Bounded wetlands and hydrography are `PARTIAL` by design: a
release is not failed by them, and the release chain reports them separately from the derived plane's readiness.

### The component model is kept; only its publication role changed

A corridor's road component is still the thing that must be rebuilt in full, and the closure is still what makes the
corridor the same road. What changed is where that relationship comes from: a globally published tile rather than a
bounded region's own document. The four seeded regions keep their `road-components.json` — they are still what a
reader without the global plane uses — while a reader with it reads the tiles instead. The publication budget
(`--max-closure-cells`) still applies when a *bounded region* publishes its own roads, which is now only for
backwards compatibility.

### Reading a global plane: the declaration travels with the reader

Two raw planes are published everywhere and declared once in `globalPlanes` — roads and ecoregions. Both are *global*
in the runtime sense, not merely in the index: the declaration is threaded explicitly into the scope that reads them
(`searchArea.globalRoads`, `searchArea.globalEcoregions`), validated at the index boundary and again when the scope
is prepared, and each declared artifact carries the asset base it is read from. So the whole-CONUS ecology layers
resolve to `data.roadnaturalist.com/national/epa-conus-l3.parquet` and `…-l4.parquet` from their own declaration,
whatever publication a reader happens to have prepared, and a reader that was given no declaration *refuses* rather
than asking the application's own origin for a file it has never served. Byte count, SHA-256 and version are
verified before anything is registered, exactly as for a bounded cell.

Bounded planes stay bounded: wetlands and hydrography are published where people explore, and a region catalog never
restates the global layers.

### Rollback and recovery

Nothing is ever overwritten. A new roads publication writes a new version directory, and the committed index is
the single switch between them: to roll back, restore the previous `globalPlanes` entry (or set `state` to
`PARTIAL`, which withdraws the availability claim without touching a byte of data). An interrupted publication is
resumed by re-running the same command; the checkpoint under the build volume says what has been verified, and the
origin is always re-checked before anything is recorded as online.

### A thinner wetlands serving layer: evaluated, measured, and not adopted

Wetland traffic is the last concentrated cost in a promotion: the p95 is about 97 MB and, after roads became
global, essentially all of it is wetlands. The canonical plane is 21,811 cells / 156.36 GB, with a median cell of
4.6 MB but a p95 of 20.3 MB, a p99 of 54.9 MB and a **largest cell of 188 MB** (3,330 cells over 10 MB, 264 over
50 MB, 36 over 100 MB — and those over 25 MB hold only 24.9 % of the plane's bytes, so this is a *traffic* problem,
not a storage one). Two serving layouts were built from finalized canonical cells and measured against the 172
corridor corpus; both are implemented, and neither is deployed:

```bash
uv run --python 3.12 --with duckdb --with pyarrow python3 scripts/prototype-wetlands-serving.py --corridors 12
uv run --python 3.12 --with duckdb --with pyarrow python3 scripts/serve-wetlands.py --verify 6
```

**Candidate 1 — finer fixed subcells with whole features replicated by bounding box.** Exact by construction: the
reader prefilters on `min_lon/max_lon/min_lat/max_lat` and dedupes `count(DISTINCT source_feature_id)`, so a layout
that puts each feature in every subcell its *box* intersects answers identically. Measured on the corpus it saves
**only 17 %** (826.9 MB against 998.2 MB of canonical cells) and costs **1.8× (0.1°) to 3.5× (0.05°) the storage**,
because in wetland country one feature is often a whole floodplain and its box covers most of the cell.

**Candidate 2 — geometry clipped to 0.1° and 0.05° subcells.** This is where the bytes are: **10.2 %** of canonical
at 0.1° and **4.3 %** at 0.05°, with the worst sampled corridor falling from 180.6 MB to 7.2 MB and 1.7 MB
respectively, in 13 tiles. It is also **not equivalent**, and that is why it is not adopted. Comparing the reader's
own SQL — the same `ST_Intersection`/`ST_Area`/`count(DISTINCT …)` statements `src/gis/habitat-query.js` runs —
over canonical cells and over serving tiles for seven real corridors gave **2 equal, 5 different**: missing
`source_feature_id`s in two of them, and area deltas up to **14.1 km²** (median 6.4 × 10³ m²). Two causes, both
inherent to cutting: the canonical geometry is measured after projecting to EPSG:5070, so a cut made in EPSG:4326
puts a straight line where the projection has a curve, and the difference lands *inside* the buffer whenever a tile
boundary crosses it; and `ST_Intersection` on very large NWI polygons loses parts outright.

**Conclusion.** Under the two rules this project holds — exact semantics, and verify-every-byte-before-use (a
partial HTTP range read cannot be checked against a digest, so the serving layer would have to give up that check)
— the wetland promotion cost is the price of re-measuring from source, and the measured target of 10–20 MB at p95
is not reachable. The canonical 0.2° plane therefore stays the serving layer: bounded wetland cells remain exactly
what they are, whole-cell, digest-verified, and cached immutably. A serving layer that *is* equivalent may be
narrower than either candidate but is not cheaper: the fetch is floored by the features whose bounding box reaches
the corridor, which is what the reader's own prefilter already asks for.

The verifier stays in the tree as the standing gate for any future attempt: a serving layer must answer the
reader's statements identically for geographically distinct corridors
(`data/national/verification/wetlands-serving-equivalence.json`) before it can be published, and the prototype
records are kept beside it (`wetlands-serving-prototype.json`, `-clipped.json`). Nothing about the current
production path changed, and no canonical or serving wetland object was published.

### What one promotion costs, measured

`npm run measure:national-raw-footprint` samples real corridors out of the derived plane in all six national
regions and applies the runtime's own selection rules (a road promotion reads every cell the corridor's *road
component* occupies; wetlands and hydrography are padded by the analysis distance exactly as `paddedBounds` does).
The first row is what a promotion *reads*; the second is what it still requires to be **published**, now that roads
are national (`--global-roads`):

| | median | p95 | worst sampled |
| --- | --- | --- | --- |
| Objects read (all planes) | 5 | 12 | 18 |
| Bytes read (all planes) | 16.6 MB | 99.3 MB | 198.7 MB |
| **Objects to publish (bounded)** | **4** | **12** | **12** |
| **Bytes to publish (bounded)** | **15.5 MB** | **97.4 MB** | **195.3 MB** |
| Roads (read, never published per corridor) | 1.8 MB | 4.8 MB | 11.2 MB |
| Wetlands | 14.9 MB | 86.2 MB | 180.6 MB |
| Hydrography | 1.9 MB | 11.9 MB | 29.0 MB |

Road components span a median of two cells (p95 six, p99 eleven), which is what keeps the road part small; the
wetland plane is what makes a promotion heavy, and it is why the lake stays offline. By region, the medians run
from 6.1 MB (Southwest) to 85.9 MB (Gulf/Southeast, which is wetland country). Ecoregions are the one input that
is not per cell: EPA publishes them as whole-CONUS layers (37.6 MB Level III and 85.8 MB Level IV), published once
and shared by every region.


### The publication unit, the layout and the index

* **Unit:** one cell per plane, at the coordinates the national planes were already partitioned by. No second
  spatial scheme is invented, and the objects are uploaded under the planes' *own canonical keys*
  (`national/roads/tiger2025-county-v1/roads/x449_y642.parquet`, `national/wetlands/…`, `national/hydro/…`), so
  the identity a cell carries is the identity its manifest published.
* **Region:** a rectangle of those cells, published together because the reader's catalog contract is a rectangle.
  Its catalog is an ordinary region catalog — the same shape `data/regional/manifest.json` has, read by the same
  reader, validated by the same validator — at `raw/<region>/<version>/manifest.json`, with every cell of the
  rectangle listed as `present` (published), `empty` (a measured zero) or `unpublished` (inside the rectangle, not
  online). It also carries the region's road-component closure (`road-components.json`) and its digests.
* **Index:** `data/national/raw-regions.json`, committed and staged with the application. It lists every region
  with its version, bounds, catalog URL and digests, per-plane counts, and — the part that makes refusal instant —
  the **ids of the cells it published**. The runtime answers "is the raw source for this corridor online?" from
  that one small document, before fetching a catalog or an object, and never by probing object URLs one at a time.
* **Closure:** a promoted corridor's id was composed over the whole national road network, so its road component's
  cells — not just the cells under the corridor — must be online, or the composed road is a different road. The
  publisher closes over components within a budget (`--max-closure-cells`, default 64) and *reports* the ones it
  left out; the reader then refuses a corridor on such a component with the cell count rather than composing half a
  highway. `scripts/build-national-raw-closure.py` builds the component → cells relationship from the derived
  plane, which is the same relationship the runtime closes over.

### Commands

```
npm run build:national-raw-closure        # component -> cells, from the derived plane (build volume)
npm run measure:national-raw-footprint    # the table above, from the real planes
npm run publish:national-raw -- --region princeton-in --bounds -87.66,38.29,-87.49,38.43 --label "Princeton, Indiana"
npm run audit:national-raw                # re-fetch each region's catalog, components and a sample cell
```

The publisher refuses to run without the build volume, refuses a local artifact whose bytes or digest disagree with
the manifest that declares it, never overwrites an object at an immutable key (a conflicting length is a failure,
not a silent replacement), verifies what it uploaded before recording anything, is idempotent (an object already
online with the right length is reused, not re-uploaded — re-publishing a whole region moves three small
documents) and is resumable (a checkpoint per region version under the build volume). `--dry-run` prints exactly
what would be uploaded; `--publish-ecoregions` publishes only the two CONUS layers.

### When the raw source is not there

```
Detailed analysis is not yet available for this corridor because 3 raw source cells (wetlands: 2, hydrography: 1)
have not been published. National discovery is unaffected.
```

That sentence is produced from the committed index alone: the corridor's box has no region, or a region exists and
does not list one of the cells the reader would select. Either way nothing is fetched, the refusal names what is
missing, and discovery — the search that produced the corridor — is untouched. A corridor whose *road component*
reaches outside the published region is refused the same way once the region's component index has answered, which
is one small document later and still before any cell is read.

### What is online today

The whole national road plane (21,135 cells, 936 closure tiles, 5.82 GB) and the two CONUS ecoregion layers
(123.4 MB), plus four seeded bounded regions published 2026-10-10 — `princeton-in` (Indiana), `evansville-in`,
`nashville-tn` and `portland-or` — holding 367 objects / 475.8 MB, of which the roads are now already online. The
bounded increment is what grows with use: a repeat promotion in the same area reuses every cell, so the working set
converges on where people actually explore rather than on the size of the lake (clustered usage saturates around
0.6 GB of bounded cells for the measured corridor pool; the scattered upper bound is 16.7 GB at 1,000 promotions
against a 188.9 GB lake).

## Two levels of detail, and a line that is never blurred

Every discovered corridor is worth opening, and what it opens *with* is stated rather than implied.

**Corridor metrics — precomputed.** Selecting a corridor and promoting it builds an ordinary candidate from the
derived row the discovery run already loaded: the corridor geometry the national build composed, the road's name,
class, counties and segment position, the wetland areas at 250/500/1000 m with their feature counts and nearest
distance, the stream crossings and nearest flowing and standing water, and the primary Level III and IV ecoregions.
Nothing is fetched to show any of it, which is why the panel opens instantly and why it works in every corner of the
country — including the overwhelming majority of it where no bounded wetland or hydrography cell has ever been
published. These values are not estimates and they are not a re-measurement: the build measured them from the same
source datasets and the immutable derived plane stores them, so the panel says exactly that, and the road record
carries a third geometry claim of its own (`GEOMETRY PRECOMPUTED`) rather than borrowing "verified".

**Source-level evidence — explicit and optional.** `View source evidence` is a separate button, and it is the only
thing that reads raw source cells. It rebuilds the corridor from the published national road network, verifies it
against the row to within a metre, then reads the published bounded wetland and hydrography cells; ecology comes
from the globally published CONUS layers. When those cells are online the panel switches to `Source-backed` and
shows the freshly measured sections beneath the metrics. When they are not, nothing fails: the metrics stay on
screen and the panel says *"Source-level evidence has not yet been published for this corridor: 4 raw source cells
(wetlands: 2, hydrography: 2) are missing. The metrics shown are the precomputed national analysis values."* — with
the missing planes counted in a `<details>`, never the raw cell ids in the open.

**Two identities, and why they are not the same string.** A derived corridor is identified in the product by the id
the build published — `drv1-<normalized-name>-c<N>-s<M>` — and that id is immutable: it is what URLs, saved
candidates and the derived plane itself refer to. It is *not* what a reconstruction is verified against. The
builder composes every road name across the whole nation and numbers that name's connected components in order
(`scripts/build-national-derived.py` walks `components.each_name`), so `c<N>` is a national ordinal. A promotion
reads a handful of cells, composes the same name over far fewer features and numbers those components again — so the
same physical road legitimately lands under a different ordinal. Measured in production: promoting
`drv1-river-rd-c226-s1` composed 18,964 units over 31,086 features and never contained that id, while the road
itself was in front of it.

Verification therefore uses the row's **`source_feature_ids`** — the TIGER/Line features of one connected component
of one normalized name, source-grounded and identical in the build and at runtime — together with the row's segment
index and count. The reconstruction must compose a unit whose source feature set is *exactly* the row's (not a
superset: an extra feature is a different road group; not a subset: a missing feature is an incomplete road), the
segment count must agree, the requested segment must exist, and that segment's geometry must match the row's to
within a metre, checked in both directions. Two composed units satisfying one row is ambiguity, and ambiguity fails
closed rather than being resolved by taking the first match. That is strictly stronger than comparing a generated
string: it checks membership, segmentation and geometry. The build id travels beside the reconstruction as
provenance (`verifyDerivedPromotion` returns it as `derivedId`) and is never rewritten.

**The contract, in one line:** `corridor_id` identifies the immutable derived build row; raw reconstruction is
verified independently by source-feature membership, segment semantics and geometry equivalence, so a windowed
reconstruction may carry a different generated component ordinal. One real divergence of that kind -
`drv1-river-rd-c226-s1` rebuilt under another ordinal and promoted anyway - is kept as `identityEvidence` in
`data/national/verification/derived-publication-status.json`, written by the release recorder from the browser
run's own `sourceEvidence:identity` line. A release whose browser gate exercised that corridor but cannot show the
evidence fails to record itself as passed rather than claiming the contract it did not demonstrate.

**Why this shape and not a thinner serving layer.** The canonical 0.2° NWI plane is 156 GB and one cell can be 188
MB, which is what made a serving layer attractive; it was built and measured twice and rejected both times (see
"Measured: a thinner wetlands serving layer, evaluated and rejected") — clipping is not equivalent, and replication
does not save enough to matter. What the investigation *did* establish is that the useful detail already exists in
the derived plane, exactly, for every corridor. So the canonical cells stay the authoritative evidence, the derived
row becomes the honest everyday answer, and the two are labelled differently wherever they appear: `Precomputed`
and `Source-backed`, one term each, everywhere, with no "live", no "estimated", and "verified" reserved for the
digest checks it belongs to.

Opening a corridor detail therefore costs **zero raw object requests** — the availability answer is one small
committed index, the geometry and metrics are already in memory — and a corridor the country has never published
raw wetland coverage for is still worth the click.

```bash
# what one corridor needs published, when the source step says it is missing
node scripts/publish-national-raw.mjs --region <slug> --bounds minLon,minLat,maxLon,maxLat --dry-run
```

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

### Promotion keeps the orientation

A corridor promoted out of a radius search keeps the centre it was found from, named as it was named at the time,
and the measured relationship between that centre and the nearest point of the promoted corridor. The candidate
detail panel shows it beside the corridor identity, before any evidence section:

```text
Where this corridor was found
4.2 mi NW of Near Vernonia, OR
  Search centre        Near Vernonia, OR · 45.5400, -123.1700
  Distance from centre 4.2 mi NW straight line
  Found in             25 mi radius search
  Bearing from centre  315° true
Straight-line distance from the search centre to the nearest point of this corridor — not a driving distance, and not a ranking.
```

* **Historical, not live.** The context is a snapshot taken when the road was promoted
  (`candidate.searchContext`). Moving the search centre, changing the radius, choosing another place, or running a
  new search never rewrites a candidate that was already promoted, and a promotion reads the *run's* centre and
  radius rather than whatever the controls say later.
* **Presentation, not evidence.** It is not a GIS input: it changes no metric, no coverage state, no occurrence or
  access behaviour, and the analysis fingerprint cannot depend on it. `tests/promotion-context.test.js` asserts
  that a promotion carrying a context and a promotion without one differ by exactly that one field.
* **Labelled the way it was labelled.** An explicit choice stays explicit (`Hillsboro, OR`), an inferred label
  stays inferred (`Near Vernonia, OR`, with the Census place id kept as presentation provenance), and a centre no
  published place is near is described by its coordinates. The coordinates remain the authoritative centre and are
  always shown beside the label.
* **Verified against the promoted corridor.** Promotion already reconstructs the raw corridor and verifies the row
  against it; the same check is repeated for the context. The distance, the nearest point and the bearing are
  re-derived from the corridor that is about to be published — with the same geometry primitive the search used —
  and the discovery row's values are what they are checked against. A disagreement beyond the corridor tolerance
  (1 m, the same `PROMOTION_MAX_DRIFT_M` the geometry check uses) **fails the promotion closed** with the reason in
  the panel, rather than carrying an orientation that describes some other road. The values that are kept are the
  re-derived ones, so a candidate always describes the corridor it carries.
* **Optional.** A candidate promoted from a declared window (no centre), a pilot corridor, and any candidate built
  before this feature simply carry no search context and render exactly as before: the field is `null`, not a
  guess. A search context is only ever built when a centre actually measured the corridor.
* **Kept with the candidate.** A promoted corridor is written to this device, so its search context comes back
  after a reload — the same centre, the same label, the same measurement. See
  [Candidates are kept on this device](#candidates-are-kept-on-this-device).
* **Not exported.** The evidence bundle deliberately excludes it — see
  [below](#why-the-evidence-bundle-carries-no-search-context).
* **On the map.** Selecting a promoted candidate draws its search centre, the nearest point of that corridor and
  the dashed line between them, for that corridor only.

### Why the evidence bundle carries no search context

The corridor evidence bundle carries corridor facts and their provenance: identity, geometry reference, measured
ecology/habitat/occurrence summaries, access evidence, the qualified finding. The search centre is device-local
browsing history — where a person happened to search — not a fact about the corridor, and a recipient of a bundle
has no search to place it in. Adding it would also put a location claim into a document that deliberately
minimizes coordinates (corridor coordinates are opt-in via `includeGeometry`). The bundle therefore exports
nothing about the search that found the corridor, `src/investigator/bundle.js` says so where the decision lives,
and `tests/promotion-context.test.js` pins it.

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

### Candidates are kept on this device

A corridor a person promotes is something they keep, so it is written to this device and still there after a
reload: the same candidate, the same corridor, the same verified search context, the same status. No account, no
server, no cloud state, no cross-device sync.

One versioned `localStorage` entry (`roadnaturalist.candidates.v1`) holds the durable candidate state and is
written only when a person promotes, decides, re-measures or removes a candidate:

| Persisted | Not persisted |
| --- | --- |
| candidate id, name, status, summary | the per-candidate analysis results: ecology, habitat, occurrence, the access investigation and a human review (owned by their own store slices, re-derived by explicit actions) |
| road records (with their provenance and source feature ids) and the corridor geometry | discovery state: candidates, marks, the last search (each has its own entry) |
| coverage per dataset, and the candidate's own evidence and questions | interface state: selection, filters, overlays, transient errors |
| the verified search context (centre, label, place id, radius, distance, bearing) | the pilot corridors themselves (they come back from their own button) |
| `planningContext`: the dozen measurements the corridor's own Naturalist interest was computed from (wetland proximity and area, water crossings, ecoregion counts and transitions), with the ranking version and when they were recorded | the datasets themselves: no geometry, no source archive, no national extract |

* **Validated on read.** `localStorage` is untrusted: every record is re-validated through the same domain
  constructor that built it, coverage is rebuilt through the domain validator, the search context goes
  through `storedSearchContext`, and `planningContext` goes through `storedPlanningContext`. A record that cannot
  be read is left out **on its own** with its reason — the candidate list reports how many and why — while the rest
  load. The entry is never silently rewritten by a read. A snapshot that is unusable is dropped rather than
  believed, and **losing the measurements never costs the road**: it restores as a saved candidate that says its
  score was not recorded. `planningContext` is an optional addition to an unchanged schema version 2, because the
  reader already validates the fields it reads — a road saved before it existed reads exactly as it did, with no
  snapshot, rather than as a road whose score is zero.
* **Versioned from day one.** An entry with a different `kind`, an unparsable entry, or a future schema version is
  ignored and left byte-for-byte untouched, with the reason shown in the candidate list. A migration is written
  explicitly when the model changes, never guessed.
* **Capped.** 100 candidates (~0.9 MB with measured records; worst case ~2.8 MB). At the cap the next save is
  **refused** with the reason in the panel — nothing a person chose to keep is evicted to make room. The remedy
  is removal.
* **Removable.** `Remove candidate` (with a confirmation step) takes the candidate and its session results off
  this device and rewrites the entry without it. It removes this device's copy of the candidate and nothing else:
  not the source data, not the discovery artefacts, not another candidate.
* **Honest about failure.** A blocked browser, a full quota or a failed write never fails a promotion: the
  candidate is real in this session and the panel says it was not saved on this device, with the reason.
* **Analysis is explicit after a restore.** A restored candidate comes back with its corridor, coverage, evidence
  and search context — not with measurements. Its panel says so and offers **Run detailed analysis**; boot never
  reads the ecoregion extract, the raw regional partitions or anything else on its own.
* **Kept local.** The search centre a stored candidate carries is the search centre the person chose; it stays in
  this browser's storage, is never sent anywhere, and is **never** written into the evidence bundle that exists
  for sharing corridor evidence (see
  [Why the evidence bundle carries no search context](#why-the-evidence-bundle-carries-no-search-context)).

Measured cost (Chromium, real records of 9–10 KB): 10 candidates — 92 KB, 0.5 ms to parse and validate; 50 —
460 KB, 2.3 ms; 100 — 919 KB, 4.2 ms, with the boot-to-rendered time unchanged within noise (31–39 ms across all
sizes).

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

`src/discovery/lifecycle.js` keeps three states: `DISCOVERED`, `PROMOTED`, `DISMISSED`. Marks are persisted
beside the device-local search records (`src/discovery/persistence.js`: versioned `localStorage` entries,
device-local, discarded when unreadable or blocked). Promotion rebuilds the corridor with the ordinary
`createRoad` / `createCandidate` builders, so a promoted corridor is a **normal candidate**: the same
ecology, habitat, occurrence, access, and evidence-bundle behaviour, and no second kind of detailed
candidate.

Promotion also carries the **search context** when the corridor came from a radius search: the centre it was found
from, how that centre was named, and the straight-line distance and direction from it to the nearest point of the
promoted corridor (`src/discovery/search-context.js`). It is snapshot presentation metadata — historical, optional,
verified against the promoted corridor at promotion time — and it is not an input to anything measured. See
[Promotion keeps the orientation](#promotion-keeps-the-orientation).

A promoted corridor is also **written to this device** (`src/state/candidate-persistence.js`, one versioned
entry): identity, roads and geometry, coverage, status, the candidate's own evidence and the verified search
context. The pilot corridors are not written — they come back from their own button — and the per-candidate
analysis results are not written either, because they are owned by their own slices and re-derived by explicit
actions. See [Candidates are kept on this device](#candidates-are-kept-on-this-device).

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
* `tests/promotion-context.test.js` — the promotion search context: the snapshot, the derived-versus-raw
  verification, the refusals, the optional/absent cases, and the bundle exclusion
* `src/state/candidate-persistence.js`, `tests/candidate-persistence.test.js`,
  `tests/candidate-persistence.spec.js` — the device-local candidate store: the versioned entry, per-record
  validation and isolation, the cap and the refusals, removal, and the promote → reload → restore loop in a
  browser
* `src/discovery/persistence.js` — the device-local discovery entries: discovery marks, the last search, the search
  history, and the ordering someone deliberately chose. The sort preference is written only by an explicit sort
  change, so a *missing* preference keeps following the product default while an explicit one is restored on load;
  an obsolete or hand-edited value is ignored. `tests/sort-preference.test.js` and
  `tests/sort-preference-map.spec.js` cover both halves of that
* `src/discovery/geolocation.js`, `tests/geolocation.test.js`, `tests/geolocation.spec.js` — the browser's
  position as one more search centre: the conservative options, the canonical definition and radius it produces,
  the accuracy line, every refusal (declined, unavailable, timed out, unsupported), the latest-choice-wins token,
  and the browser loop from a granted fix through promotion, reload and restore with no location request
* `assets/css/discovery.css`, `src/ui/discovery.js` — the discovery workspace

See also [docs/ROADS.md](ROADS.md) for the road sources, [docs/HABITAT.md](HABITAT.md) for the habitat
extracts and buffered definitions, [docs/ECOREGIONS.md](ECOREGIONS.md) for the ecoregion layers, and
[docs/INVESTIGATOR.md](INVESTIGATOR.md) for the access workflow a promoted corridor enters.

## Outings: a plan made from saved roads

Saved roads can be gathered into an **outing** - an ordered plan with a title, an optional date, your own note, a checklist and a status. The order is the sequence the person chose with *Move up* / *Move down*; nothing is optimised, ranked, routed, or given a travel time, and the map draws no connecting line. An outing holds references to saved candidates rather than copies of road facts, so a favorite or a note changed here is what a plan shows. Plans live in their own versioned device-local entry (`roadnaturalist.outings.v1`), capped at 50 plans of 10 roads, restored with zero network requests, and removed without touching a single saved road. Full detail: `docs/OUTINGS.md`.
