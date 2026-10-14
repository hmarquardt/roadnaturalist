## Trips: what actually happened

An outing is a **plan**. A trip is a **recording**: the GPS track the device reported while you were out, the notes and
sightings you typed, and the roads you marked visited by hand. The two are separate records with separate lifecycles —
one plan can produce several trips, a trip never rewrites its plan, and deleting a trip never touches a plan, a saved
road, a note or a checklist.

```text
Field mode
    ↓  Start recording   (an explicit press, and the only thing that starts anything)
this device's location stream  →  one watch  →  sampling rule  →  the trip's track
    ↓                                          ↓
recorded points                            your notes and sightings
    ↓
Stop recording
    ↓
a completed trip:  Recorded 2h 14m · 31.6 mi recorded GPS track · 428 recorded points ·
                  4 / 5 roads marked visited by hand · 7 field events
    ↓
Field trips (08)  →  open it  ·  fit its track  ·  export GeoJSON  ·  delete it
```

**A recording is only ever started by you.** Nothing is recorded on page load, on entering field mode, or by turning
live location on. While a recording runs, field mode says **Recording** and offers **Stop recording**, and the *Field
trips* panel shows the same recording from anywhere in the workspace — including a **Stop recording** control, so a
recording started in the field can always be stopped.

**One browser watch, two separate choices.** Live location (transient, never stored) and trip recording (deliberately
stored) consume the same device stream through one owner: the first consumer opens the watch, the last one to leave
closes it. Enabling live location while recording opens no second watch, starting a recording while live location is on
opens no second watch, stopping live location leaves a recording running, stopping a recording leaves the live marker
running, and turning both off closes the watch. A refused live location says nothing about whether a recording can still
be made.

### What a trip holds

```json
{
  "id": "trip-…",
  "outingId": "outing-…",          // the plan it was started from, or null
  "outingLabel": "Saturday loop",  // a snapshot, so a historical record explains itself
  "startedAt": "…", "endedAt": "…",
  "status": "recording | completed | interrupted",
  "track": [{ "lon": -122.9, "lat": 45.55, "accuracyM": 8, "recordedAt": "…" }],
  "events": [{ "id": "event-…", "type": "note | sighting", "text": "…", "recordedAt": "…",
               "point": [-122.9, 45.55], "roadId": "…" }],
  "visitedRoadIds": ["…"],         // frozen when the recording stops
  "diagnostics": { "accepted": 428, "skippedSampling": 1190, "skippedPoorAccuracy": 3, "truncated": false },
  "createdAt": "…", "updatedAt": "…"
}
```

Only the plan's id and its label are snapshotted. A trip is not a copy of an outing: no checklist, no road order, no
plan notes. If the plan is later renamed, reordered or deleted, the trip keeps saying what it was recorded against.

**Every point is validated.** Non-finite coordinates, coordinates outside the world, and unusable timestamps are
refused; a missing accuracy is left as `null` rather than invented; nothing is manufactured for a value the device did
not report.

A point carries **only** what this product uses: longitude, latitude, the device's own accuracy and the time. Altitude,
heading and speed are deliberately not stored — nothing here reads them, no screen shows them, and this feature
computes no speed at all. Persisting a value nothing uses would be a liability, not a record.

### The sampling rule

A browser delivers far more callbacks than a road-scale trace needs, so a reading is kept only when it is worth keeping.
A point is recorded when:

1. it is the **first** point of the recording;
2. it has moved at least **100 m** from the last recorded point (however fast the movement); or
3. it has drifted at least **25 m** and at least **15 s** have passed since the last recorded point.

Anything else is skipped and counted. A parked vehicle therefore records **nothing at all**, however long it stands: the
rule is not "a point every fifteen seconds". A highway drive stores roughly one point per 100 m — about 1,800 points for
two hours, which is the measured basis for the storage caps below. This is thinning, not smoothing: no point is moved,
corrected, snapped or matched, and the rule is one function with three named thresholds.

**A fix too poor to place on a road is not recorded.** A reading whose reported accuracy is worse than **250 m** is
refused and counted separately (`skippedPoorAccuracy`), because such a point cannot be placed on a road and would only
add noise. Live location still displays that reading, with its accuracy, exactly as it always did — the honest thing to
do with a bad fix is to show it and not to store it. A reading that carries no position at all is not counted as a
skipped point: it never became a candidate for the track.

**The recorded length** is the sum of the geodesic distances between consecutive *recorded* points: a recorded GPS
track, never a driving distance and never a road mile. A leg longer than **1 km** that would have had to be driven
faster than **360 km/h** is treated as an artefact (a teleport, a resumed session, a GPS glitch): it is excluded from
the length and reported as an *implausible jump* — never removed from the track and never smoothed away. A short
movement between two readings that share a millisecond is still a movement.

### Field events

**Add a field note** and **Add sighting** each capture the time, your text, the position the trip last recorded (or a
live reading with a position, if there is one) and the road you were on. A sighting is the same kind of record with its
own label — free text, no taxonomy, no species picker, no biodiversity API, and no network request of any kind. Both are
bounded (500 characters, 200 events per trip) and both are cleaned of control characters.

A **trip event** is something observed at that moment. A **road note** stays what it always was: durable knowledge
about the road, saved with the road.

### Roads are marked, never inferred

A trace passing along, across or beside a road **does not mark it visited**, and nothing in this feature consults the
track for progress. There is no geofence, no map matching, no road snapping, no automatic trip completion and no
turn-by-turn anything. When a recording stops, the trip freezes the roads you had marked visited in that plan at that
moment — a snapshot of your own acts, not a conclusion about where the trace went.

### Interrupted recordings

A recording is written as it goes, so a reload, a crash or a closed tab loses at most the last few seconds. A trip found
still recording when the page loads again is labelled **Recording interrupted**: every point it had is kept, nothing is
invented for an end, and the panel offers **Finish this recording**, which ends it at the last point that was actually
recorded (or at the moment you finish it, if there were no points at all). It can also simply be deleted. Recorded data
is never discarded silently.

### The summary, and what it refuses to say

```text
Recorded:             2h 14m · 15:04 to 17:18
Recorded GPS track:   31.6 mi
Recorded points:      428 kept · 1190 not needed by the sampling rule · 3 too inaccurate to record
Roads marked visited: 4 / 5 roads in this outing, marked by hand
Field events:         6 notes · 1 sighting
```

Every line is a count or a recorded length. There is **no average speed, no driving time, no fuel, no road miles and no
inference about what the trace means** — and the distance is labelled *recorded GPS track* everywhere it appears.

### Field trips: the history surface

*Field trips* (panel 08) lists recordings newest first: date and time, the plan it was recorded against (or *No outing*),
how long it ran, how long the recorded track is, how many roads you marked visited, and how many events it holds.
Opening one shows its summary, its events (with the road each was taken on, when it is still saved), the roads it
snapshotted, and three controls: **Fit recorded track** (an explicit camera move, like every other fit in this project),
**Export GeoJSON**, and **Delete this recorded trip**.

**Deleting a trip deletes the trip**: its metadata, its points and its events. It does not delete the outing, a saved
road, a durable road note or a checklist, and the confirmation says so. A recording in progress is not affected by
deleting another trip.

### The map

A recording is drawn as its own kind of feature — `data-role="trip-track"` — beneath the roads, in a colour no road in
this application uses. It carries no corridor identity, no outing identity and no trip id in the DOM; it is not
interactive, so it can never take a click from the road it runs along, and the map's corridor hit test never considers
it. It never owns the camera: a new recorded point extends the trace and moves nothing. A trace appears once it has two
points (the map draws lines, and one recorded place is not a line).

### Privacy, and it is different here on purpose

Live location is transient. A recorded trip is not: **coordinates are deliberately written to this device.**

> Recorded trips stay on this device unless you explicitly export them.

* No automatic upload, no network synchronisation, no server, no account.
* No analytics containing coordinates, and no console logging of a track point.
* The only entry that holds a coordinate is the trip entry, and the only way a coordinate leaves this device is a file
you asked for.

**Export is GeoJSON**, written to your device with the same local download convention the evidence bundle uses: an
ordinary `FeatureCollection` containing the track as a `LineString`, every recorded point as a `Point` with its time and
accuracy, every event as a `Point` (or a feature with no geometry when no position was captured), and non-sensitive trip
metadata — with the note that no route was reconstructed and that no distance in it is a driving distance. Nothing is
uploaded, and there is no GPX requirement.

### Offline

Once the page has loaded, recording works offline: sampling and measurement are local, events are local, persistence is
local, and the browser's own geolocation does not need the network. Map tiles may be absent and the external **Navigate**
handoff may be unavailable; neither is required to record a trip, take a note or mark a road visited. The browser gate
runs part of the recording with the network blocked and continues feeding the track.

**What this is not, and it is said plainly in the interface:** recording depends on your browser continuing to provide
location updates. Trip Recording v1 records while the page is active enough for the browser to deliver them. It does not
promise reliable background recording on a locked phone or a suspended tab, and it does not pretend to be a native app.

### Storage, measured

Trips live in their own versioned device-local entry, apart from the outings record, because a track is far larger than
a plan and must never ride inside one:

```json
{ "kind": "roadnaturalist-trips", "version": 1, "savedAt": "…", "trips": [] }
```

The caps are measured rather than guessed: a recorded point is about **93 bytes** of JSON, a two-hour highway drive
through the sampling rule is about **1,800 points and 170 kB**, one recording is capped at **5,000 points** (about
470 kB, over twenty hours of recording — a recording that reaches it is reported as truncated rather than losing data
quietly), the device holds at most **20 trips**, and the whole entry is bounded at **1.5 MB** so it cannot crowd out the
candidate collection this device also keeps. A write that would cross a cap is refused with the reason shown in the
panel — nothing is evicted on your behalf, and removing a trip is your decision.

The entry is validated as untrusted input: every point is re-validated, every event is rebuilt from the fields it names,
a record that cannot be read is skipped with its reason, a duplicate id is refused rather than overwriting a record, and
an unknown version is left byte-for-byte untouched. Restoring trips reads this device only: **0 network requests** — no
derived partition, no R2, no iNaturalist, no eBird, no Overpass, no Investigator, no geocoder and no geolocation until
you press a control that asks for one.

### What this deliberately does not do

No route reconstruction, no road snapping, no matched road ids from GPS, no turn-by-turn, no ETA, no automatic visited
inference, no background-location promise, and no server upload. Trip Recording v1 is a factual GPS recording plus the
events you typed, kept on this device.

### How this is verified

```sh
npm test                        # the focused tests: the track rules, the trip record, the shared watch, the trace on the map
npm run verify:trips            # the browser gate, against the deployed app
npm run verify:trips:local      # the same gate against the working tree (local server on 127.0.0.1:8000)
```

The gate drives a 390×844 phone with a **mocked** device — no real GPS — and checks the whole workflow: nothing is
recorded until the button is pressed, stationary readings are refused by the sampling rule, movement grows the trace,
a position beside an unvisited road marks nothing, notes and sightings capture their own time and place, the recording
continues with the network blocked, stopping produces an honest summary, a reload still has the track, the events and
the visited snapshot, the GeoJSON export is a real file with no other coordinates in it, deleting the trip leaves the
plan intact — and, in both orders, that live location and recording share exactly one browser watch, that stopping
either leaves the other running, and that turning both off clears it.
