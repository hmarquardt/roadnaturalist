## Outings: a plan made from roads you saved

An outing is an ordered list of saved roads plus planning notes. It is a record of *your* plan, not a route
Road Naturalist calculated.

```text
Saved roads
    ↓  choose several
Create outing
    ↓
name / optional date
the road order you choose
your outing notes
your checklist
    ↓
planned exploration
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
name, length, habitat context, search context, favorite flag, candidate note. An outing stores references and
resolves them against the saved collection on the spot, so changing a favorite or a note in Saved roads is
immediately visible in every plan that uses that road.

**The order is yours.** The roads are reordered with labelled *Move up* / *Move down* buttons that name the road
they move, and the list shown on screen and numbered `1. 2. 3.` is exactly that sequence. Nothing here computes,
optimises or recommends an order: no distance between roads, no travel time, no turn-by-turn directions, no
"best route", no ETA. Road Naturalist does not know how you will drive between two roads, and the workspace never
implies that it does. There is no route line on the map either — an outing's roads are drawn as the same saved
geometries, and a road in the open outing is emphasised, with nothing connecting them.

**Creating one.** In *Saved roads*, tick **Add to an outing** on the roads you want (a selection separate from
**Compare**, because comparing is a temporary factual side-by-side and planning is a durable plan), then press
**Create outing**. A road can belong to any number of outings; every `Add a saved road` control only offers roads
that are already saved on this device, and a plan holds at most 10 roads.

**Storage and honesty.** Outings live in their own versioned device-local entry,
`roadnaturalist.outings.v1`:

```json
{ "kind": "roadnaturalist-outings", "version": 1, "savedAt": "…", "outings": [] }
```

The entry is validated as untrusted input: a record that is not a usable outing is skipped with its reason and
never costs the valid ones, an unknown version is reported and left byte-for-byte untouched, a full device (50
outings) refuses another plan rather than evicting one, and a device where the write fails says *Not saved on this
device* while the session keeps working. Reloading saved roads and outings reads this device only: 0 network
requests — no derived partition, no R2, no iNaturalist, no eBird, no Overpass, no Investigator, no geocoder and no
geolocation — until you explicitly ask for one.

**Removing things.** *Remove outing* removes the plan and nothing else: every road stays saved, with its favorite
and its note. Removing a **road** that plans point at is never silent: the confirmation says how many outings use
it and offers *Remove everywhere* (the road leaves Saved roads and those plans) or *Keep road*. An outing's note
and checklist are yours, device-local, plain text, bounded, and never sent anywhere — no analytics, no Worker, no
R2, no occurrence service, no geocoder. There is no GPX or navigation export, and an outing is planning rather
than evidence, so it never touches the Investigator evidence bundle.

**Caps, measured.** One outing with five roads, a note and ten checklist items is about 1 KB of JSON, so fifty
outings are a few tens of kilobytes — small beside a single candidate record (7–28 KB). The limits are bounded
deliberately: 50 outings, 10 roads, 4,000 note characters, 20 checklist items of 120 characters.
