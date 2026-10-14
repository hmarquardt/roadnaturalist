## Outings: a plan made from roads you saved

An outing is an ordered list of saved roads plus planning notes. It is a record of *your* plan, not a route
Road Naturalist calculated.

```text
Saved roads                        a discovered corridor
    ↓  choose several                  ↓  Add to outing (the road is saved first)
Create outing  ←───────────────────────┘
    ↓
name / optional date
the road order you choose
your outing notes
your checklist
    ↓
the plan on the map · fit it when you want · planned exploration
```

What an outing owns:

```text
title
date (optional calendar date, no schedule and no reminder)
status (planned | completed)
roadIds (an ordered list of saved-candidate ids, at most 10)
notes (plain text, at most 4,000 characters)
checklist (at most 20 items, 120 characters each)
createdAt / updatedAt
```

What an outing deliberately does **not** own: any road fact. Saved candidates remain the source of road facts —
name, length, habitat context, search context, favorite flag, candidate note, and the small measurements behind its
Naturalist interest. An outing stores references and resolves them against the saved collection on the spot, so
changing a favorite or a note in Saved roads is immediately visible in every plan that uses that road.

**The order is yours.** The roads are reordered with labelled *Move up* / *Move down* buttons that name the road
they move, and the list shown on screen and numbered `1. 2. 3.` is exactly that sequence. Nothing here computes,
optimises or recommends an order, and the order never changes by itself when a ranking changes. A plan is not
re-sorted, re-scored or "improved" behind your back.

**Creating one.** In *Saved roads*, tick **Add to an outing** on the roads you want (a selection separate from
**Compare**, because comparing is a temporary factual side-by-side and planning is a durable plan), then press
**Create outing**. A road can belong to any number of outings; every `Add a saved road` control only offers roads
that are already saved on this device, and a plan holds at most 10 roads.

**Adding a road while you are still searching.** A discovered corridor has a row and a detail panel like anything
else, and the panel carries **Add to an outing**: choose the plan you mean, or *New outing* and it is named after the
road. An outing references *saved* roads, and the search that found a corridor is not a place to keep one, so adding
a discovered road keeps it first — through exactly the same promotion the **Promote candidate** button runs, with
the same honesty about which level was read — and then adds it. A road already in the chosen outing is not added
twice: the workspace says *That road is already in this outing* instead of quietly duplicating it.

**A plan can span searches.** An outing belongs to you, not to the search that produced its roads. Search Princeton,
add two roads, search Evansville, add a third: the plan holds all three, and each road is read against *its own*
search. That is why a road's own exploration order is shown with the centre and radius it was measured against, and
why a road whose search had no centre shows its Naturalist interest and its stored context rather than an order
that was never measured.

**A road the plan cannot resolve is kept and labelled.** If a road in a plan is no longer in Saved roads, the entry
stays exactly where it is — with its position, and the note that it is not saved on this device any more. It is not
deleted for you, it is not drawn on the map, and no metric is invented for it. The summary counts it as unresolved.

**How far apart two roads are — and what that number is not.** Between two consecutive roads in *your* order the
workspace shows one number, labelled as a **straight-line planning distance: approximate geographic separation**.
It is the great-circle distance between two representative points, one per road:

1. the point the promotion measured against the search centre when the search had one — a real, measured point on
   the road, and the same point the road's own distance from that centre was measured to; otherwise
2. the point half way along the road's composed geometry — deterministic, always *on* the road, and independent of
   how many vertices a source happened to publish.

That number is **not** a drive distance, a travel time, a route distance or an ETA, and the interface says so beside
the list and in the note above it. Road Naturalist does not know whether two roads connect, whether they are public,
whether they are passable, or what order would be quickest — it knows only where the two roads are in the world. A
gap that cannot be computed (a road with no representative point, or a road no longer saved) is reported as *not
available here* rather than as zero.

**Reading a plan.** The workspace summarises the plan from measurements that already exist and names the source of
every line: the approximate geographic span (the straight-line diagonal of the plan's own bounds), the range of
Naturalist interest across the roads whose scores were kept, how many roads overlap a mapped wetland, the total of
mapped water crossings, how many roads cross an ecoregion transition, and how many coordinates the plan draws. There
is **no combined outing score**, no rating and no verdict: the summary never says one plan is better than another.

**The map draws the plan and nothing more.** With an outing open, its roads are drawn in the plan's own style and
under their own role (`data-role="outing"`), each road keeping the identity it is clicked and selected by. A road
that is both a visible discovery result and a plan member is drawn exactly **once**, as a member — never twice, and
never in two styles. There is **no connector between two roads**: no line that could be mistaken for a drive, and no
direction. The sequence is read from the numbered list and from each road's own card (*Road 2 of 4 in this outing*).
The camera belongs to you: adding, removing, reordering and noting never moves it, and **Fit outing** is the one
control that fits the plan's roads, when you press it.

**Field mode: the same plan, read where the road is.** Pressing **Field mode** in the outing's workspace opens a
streamlined view of that plan — the same persisted outing, not a second one — sized for a phone. It shows the plan's
title and date, `2 / 5 roads visited` with a percentage, the current road, and for that road: its name, its saved note,
its favourite state, what it measured (Naturalist interest, wetlands within 250 m, mapped water crossings, ecoregions
and transitions, its length), the straight-line gap to the next road in *your* order, the plan's checklist, and the
plan's notes.

**Which road is current**, in one rule: the road you chose explicitly while it is still in the plan; otherwise the
first road you have not visited; otherwise the first road. **Previous** and **Next** walk your own order and stop at
its ends — nothing wraps around, nothing suggests an order, and no itinerary is computed. Marking the current road
visited advances a *derived* position to the next road you have not visited; a road you chose yourself stays where it
is, and offers **Undo visited**.

**Visited is your mark.** `visited` is stored on the outing as `roadState: { "<roadId>": { visited: true, visitedAt } }`,
so the same saved road can be visited in one plan and unvisited in another, and a road that leaves a plan takes its
progress with it. Nothing infers it: no position is requested, no proximity is measured, no elapsed time is assumed,
and there is no tracking of any kind. Progress is `roads you marked` out of `roads the plan holds` — never miles
driven, never a time remaining, never an ETA, never a percentage of a route.

**Navigation is a handoff, not a route.** Each resolved road offers **Navigate with Google Maps** and **Navigate with
Apple Maps**: ordinary `https://` links built from that road's *representative point* — the same point the plan
measures its separations from, to five decimals (about a metre). Road Naturalist does not call a routing service, does
not fetch directions, and never learns what the app did with the coordinate. The point is a representative point on
the road: it is **not** a parking location, a legal access point, an entrance or the start of the road, and the view
says so: *Navigation opens a representative point on the road in your mapping app. It is not an access, parking or
road-condition recommendation. Verify access, road conditions and where you can safely stop.*

**An unresolvable road keeps its place in the field too.** It is listed with `Road details unavailable`, no Navigate
link is offered, no fact is invented for it — and it can still be marked visited, because you may well have been
there. Previous and Next walk straight past it.

**Show on map** selects the current road (the map's own selection, nothing new), and **Fit current road** uses the
map's existing fit for the selected road. Moving between roads never moves the camera.

**Live location: where you are, relative to the road you are working.** Field mode can optionally show your own
position. **Use my location** asks this browser for it — nothing is requested on page load, and nothing is requested
until that button is pressed. While a reading is live the view says **Location on**, shows the device's own accuracy
(*GPS accuracy ≈ 18 m*) and how far the current road is, and offers **Stop**. Leaving field mode, stopping, or the page
going away all end the watch.

* **One watch, one reading.** A single `watchPosition` serves the whole field session: moving between roads re-measures
  against the same reading and never starts another watch. The reading is replaced by the next one, and there is no
  history — no track, no breadcrumbs, no accumulation of any kind.
* **The distance is to the road itself.** The shortest straight line from your position to the road's *mapped line*
  (a LineString or a MultiLineString), using the same nearest-point primitive the rest of this project measures with —
  not the road's middle, not its bounding box, and not its representative point. Only when a road has no mapped line is
  the representative point used instead, and the sentence then says so.
* **It is proximity, not navigation.** *About 0.4 mi from this road* means exactly that: straight-line proximity to
  the mapped road, not driving distance and not road access. There is no route, no ETA, no turn, no arrival time and no
  road snapping anywhere in it.
* **A coarse fix never claims a precise distance.** When the distance is inside the device's own accuracy the view says
  **Near this road** instead of a number, and otherwise rounds the distance to at least the accuracy the reading came
  with. Being near a road only makes the person's own **Mark visited** button easier to see — it never marks anything:
  visited stays explicit, and no progress changes on its own.
* **The camera is still yours.** A reading arriving, and moving between roads, never move the map. Two explicit moves
  exist: **Center on me** (a pan at your own zoom) and **Fit me + current road** (a fit of the two).
* **Refusals are recoverable and never break the plan.** Permission refused, no fix, and a timeout each say what
  happened and leave the plan fully usable — moving between roads, marking progress, notes, checklist and the
  navigation handoff all keep working. **Use my location** is pressable again to try once more; a refused watch is
  stopped by the app itself, and a device that simply could not fix its position keeps being watched until you stop it.
* **Privacy, and it is true of the code.** The reading lives in this browser's memory for as long as the watch runs:
  it is never written to storage, never attached to an outing, never uploaded, never logged with a coordinate, and it
  is discarded when the watch stops. *Your live location stays in this browser and is not saved with the outing.*

**Recording a trip: the one thing here that keeps a coordinate.** Live location is transient; a **trip** is a record you
deliberately make. Field mode offers **Start recording**, and only that press begins one — nothing is recorded on page
load, on entering field mode, or by turning live location on. While a recording runs you can add a **field note** or a
**sighting** (free text, with the time, the position the trip last recorded and the road you were on), watch the counts
and the recorded length grow, and **Stop recording**. When you stop, the trip freezes the roads you had marked visited
by hand, and *Field trips* (panel 08) shows it — with **Fit recorded track**, **Export GeoJSON** and **Delete**. Live
location and recording share **one** browser watch rather than opening two, and stopping either leaves the other alone.

A trace passing a road never marks it visited, no route is reconstructed and no road is matched to the track. Recorded
trips stay on this device unless you explicitly export them. Full detail: [docs/TRIPS.md](TRIPS.md).

**With no signal.** Everything field mode reads was already written to this device: the plan, its progress, its notes
and checklist, the saved roads and the measurements their scores came from. Working a plan — moving between roads,
marking progress, ticking the checklist, writing notes, reading a road's facts, and measuring how far you are from the
current road — makes **no network request at all**; the proximity is computed locally from the stored geometry. What
still needs a network is the basemap's map tiles and the mapping application you hand a coordinate to; neither is
required to work through a plan, and the field view is fully usable without them.

**Storage and honesty.** Outings live in their own versioned device-local entry,
`roadnaturalist.outings.v1`:

```json
{ "kind": "roadnaturalist-outings", "version": 1, "savedAt": "…", "outings": [] }
```

The entry is validated as untrusted input: a record that is not a usable outing is skipped with its reason and
never costs the valid ones, an unknown version is reported and left byte-for-byte untouched, a full device (50
outings) refuses another plan rather than evicting one, and a device where the write fails says *Not saved on this
device* while the session keeps working. `roadState` (which roads have been visited) is an **optional addition to an
unchanged version 1**: the reader builds every record from the fields it names and validates each one, so a plan
written before progress existed reads exactly as it did — as an unvisited plan — and a plan that carries progress is
read by this build and by any build that ignores a field it does not know. The version is deliberately not bumped:
bumping it would make every existing plan unreadable to an older build for no gain, because nothing about the
contract changed — a plan without progress was always a valid plan. Reloading saved roads and outings reads this
device only: 0 network requests — no derived partition, no R2, no iNaturalist, no eBird, no Overpass, no
Investigator, no geocoder and no geolocation — until you explicitly ask for one.

A plan's *own* numbers need one more thing from storage. An outing may be opened long after the search that found
its roads, so each **saved** road keeps the handful of measurements its Naturalist interest was computed from
(wetland proximity and area, water crossings, ecoregion counts and transitions), beside its verified search context
in `roadnaturalist.candidates.v1`. That is a dozen numbers per road — no geometry, no dataset, no archive — and a
saved road from an earlier build that carries none of them simply reports that its score was not recorded instead
of showing a number nothing measured. Adding, reordering, fitting, selecting, noting and reloading a plan make **no
network request of any kind**.

**Removing things.** *Remove outing* removes the plan and nothing else: every road stays saved, with its favorite
and its note. Removing a **road** that plans point at is never silent: the confirmation says how many outings use
it and offers *Remove everywhere* (the road leaves Saved roads and those plans) or *Keep road*. An outing's note
and checklist are yours, device-local, plain text, bounded, and never sent anywhere — no analytics, no Worker, no
R2, no occurrence service, no geocoder. There is no GPX or navigation export, and an outing is planning rather
than evidence, so it never touches the Investigator evidence bundle.

**Caps, measured.** One outing with five roads, a note and ten checklist items is about 1 KB of JSON, so fifty
outings are a few tens of kilobytes — small beside a single candidate record (7–28 KB). The limits are bounded
deliberately: 50 outings, 10 roads, 4,000 note characters, 20 checklist items of 120 characters.
