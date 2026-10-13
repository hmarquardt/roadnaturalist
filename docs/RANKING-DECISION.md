# Ranking decision: does `naturalist-interest-v1` deserve to be the default?

**Decision: B — keep `naturalist-interest-v1` optional. The default sort stays `wetlandArea250`.**

**Measurement, not judgement.** The evidence is
`data/ranking/naturalist-interest-v1-evaluation.json`, produced by `scripts/evaluate-ranking.mjs` over the published
national derived corridor-metrics plane (fingerprint `a13a883c…`, 20 862 present cells). Eight geographically
different 25-mile searches, top 10 under each ordering, every road carrying its component values and the raw
measurements behind them. The application's own `runDiscovery`, `naturalistInterest` and `sortResults` produced the
rows; no raw GIS plane and no source-evidence step was read.

## What was compared

| | baseline | candidate |
|---|---|---|
| sort key | `wetlandArea250` (the product default) | `naturalistInterest` |
| meaning | one raw measured value | weighted mean of wetland, water and ecological variety |

Centres (recorded in the artifact, radius 25 mi): Princeton IN, Evansville IN, Nashville TN, Portland OR,
Gulf coastal (Houma LA), Arid Southwest (Phoenix AZ), Great Plains (Omaha NE), Northeast (Boston MA).

## Result: it is a genuinely different order

Mean overlap with the wetland default is **2.63/10** across the eight regions (min 0 Portland, max 5 Nashville).
The model is not a re-spelling of the default. The consistent movement is legible in the components: the roads it
promotes have a *slightly lower* wetland component and a *higher* water component than the roads it demotes.

| region | overlap | promoted roads (examples) | demoted roads (examples) | promoted wetland mean | demoted wetland mean |
|---|---|---|---|---|---|
| Princeton, IN | 4/10 | Co Rd 900, Weyerbacher Rd, State Rd 57 | Billett Ln, River Rd, State Rd 64 | 90.6 | 92.8 |
| Evansville, IN | 1/10 | Co Rd 900, Raben Rd, Spencer Ditch Rd | W River Rd, Mount Vernon Rd, Wabash Rd | 90.0 | 94.9 |
| Nashville, TN | 5/10 | Benders Ferry Rd, Hwy 49 W, Lock 4 Park Rd | Jamestown Rd, Hobson Pike, Cheatham Dam Rd | 84.7 | 88.0 |
| Portland, OR | 0/10 | US Hwy 30, NW Saint Helens Rd, Crown Point Hwy | NW Sauvie Island Rd, NE Marine Dr, Dike Rd | 90.7 | 95.6 |
| Gulf coastal | 3/10 | Gheens Main Rd, Savanne Rd, State Rte 400 | Bayou Sale Rd, Avoca Rd, Falgout Canal Rd | 95.4 | 97.2 |
| Arid Southwest | 3/10 | Estrella Pkwy, N Fort McDowell Rd, Beeline Hwy | Salt River Shore, State Rte 587, Maricopa Rd | 83.9 | 84.5 |
| Great Plains | 2/10 | Joslin Ave, John J Pershing Dr, State Hwy 50 | Desoto Ave, S Shore Dr, Platte River Dr | 84.8 | 89.9 |
| Northeast | 3/10 | Chief Justice Cushing Hwy, Massapoag Ave, State Rte 58 | State Rte 110, Merrimack Ave, Nahant Rd | 91.5 | 92.2 |

The wetland default surfaces the single largest wetland patch wherever it is. The heuristic surfaces the road that
sits in *both* wetland and water context - which is usually a riparian corridor. In Phoenix that is
`N Fort McDowell Rd` (the Salt/Verde confluence) rather than a road beside a golf-course lake; in Portland it is the
Columbia River Gorge instead of the Sauvie Island sloughs. That is the intended behaviour, and it is arguably the
more useful order - but see the distance finding below, which is why Portland is not an unqualified win.

## The eight pathology classes, measured

Every probe is in the artifact under `regions[].observations`. None of the classic failure modes fired; one
data-level defect did.

| class | measurement | verdict |
|---|---|---|
| **Wetland domination** | overlap with the wetland default 2.63/10; mean top wetland-component saturation 0.99; promoted roads carry *lower* wetland than demoted ones | **Not domination.** The heuristic does not re-derive the wetland order; it prefers wetland **and** water. But its top is wetland-saturated everywhere, so wetland is still the spine of the score. |
| **Hydrography domination** | 0 roads surfaced by water alone in any region; median crossings in the top 5–16 vs 1–7 in the baseline | **Not domination.** Crossings and flowline co-vary with wetland; no drainage-only road reached a top. |
| **Ecological-boundary gaming** | 0 variety-dominant roads | **Cannot occur — because the component is dead (see below).** |
| **Dry-region collapse** | Phoenix distinguishes 8 top scores over a 4.7-point spread; overlap 3/10 | **No collapse.** Even the arid region has riparian wetlands (Salt/Verde), and the heuristic differentiates. No region met the "wetland scarce" threshold. |
| **Coastal inflation** | Houma top wetland component 95–97, saturation 1.0, but 8 distinct top scores over 3.4 points; overlap 3/10 | **Saturates but still differentiates.** Not the "everything at the top is identical" failure. |
| **Urban artifacts** | 0 water-only roads; no proxy road surfaced | **Not observed** (the probe is a proxy for built drainage density, and it fired nowhere). |
| **Missing data** | 0 partial-evidence results in any region's top; 0 partial-evidence results at all in these eight windows | **Not observed.** The derived plane carries FULL ecology/wetland/hydro for these regions. |
| **Distance blindness** | see below | **Material in at least one region.** |

## The one real defect: the ecological-variety component is inert

`ecologicalVariety` is **30 for every corridor in every region** (`varietyDistinctValues: 1`,
`varietyConstant: true` in 8/8 regions; `transitionsMax: 0`). One third of the claimed model contributes nothing -
and because a constant only shifts every score equally, it changes no order either. The model in production is
effectively a two-signal blend.

The cause is upstream of the ranking and is fully measurable in the plane. The national derived rows carry
`l3_count`, `l4_count` and `transition_count`, and **262 934 of 1 793 422 rows (14.7%)** intersect more than one
ecoregion (`l3_count > 1` on 76 775 rows; `l4_count > 1` on 262 940). But the derived reader
(`derivedMetrics` → `levelEntry` in `src/gis/derived-query.js`) returns `intersections: [primary]` only, and
`buildDiscoveryResult` derives `ecoregionCount` and `transitions` from the intersection list. So every derived
corridor reports `ecoregionCount = 2` and `transitions = 0`, and the variety component is pinned at
`0.6 · saturate(2 − 1, 1) = 0.3`.

The data to make it live is already published; fixing it needs no GIS rebuild and no new plane. That is the single
best next product task, and it must be re-versioned: making v1's inputs correct changes v1's observable order, and
the guardrail is "do not mutate v1 in place".

## Distance is not in the score, and that is visible

Distance is deliberately absent. The consequence is measurable: the heuristic's top-10 is not systematically worse
than the baseline, but in **Portland** it is far worse for exploration - the median top-10 distance is **22.5 mi**
against the baseline's **6.5 mi**, and the top-10 sits at the rim (max 24.7 of 25 mi). Where the best habitat is at
the edge of the search, the score cannot prefer the near road because it does not know where the person is.

This is a product choice, not a bug. The two models are:

* **habitat-interest score** (today): the score measures environmental context; distance is a separate sort and
  filter. Keep this. A person who cares about travel sorts by "Distance from center".
* **exploration-order score**: the score decays with distance so the list leads with roads worth the drive.

Do **not** add distance to v1. If the product wants an exploration order, it should be a *separate* ordering
(`naturalist-interest-v2`, or an explicit "near and interesting" order) rather than a change to the habitat score -
mixing the two would make the score mean two things at once.

## Recommendation

**B — keep `naturalist-interest-v1` optional.** The evidence for promotion is real (a materially different order,
2.63/10 overlap, that favours riparian corridors over the largest wetland patch, with no classic pathology), but it
is not sufficient:

1. one of its three components is inert in production, so the model is not yet doing what it claims;
2. in wetland-rich regions the top-10 is a near-tie (top spread 1.7–4.7 points), so the very top of the list is not
   a firm statement;
3. distance blindness materially hurts one region (Portland).

All three have clear fixes that are out of scope for a measurement task. Fix the derived ecology plumbing first,
re-run `scripts/evaluate-ranking.mjs`, and promote only if the corrected model is clearly better.

**Default sort: unchanged (`wetlandArea250`).** No ranking weights, transforms or component definitions were
changed; `naturalist-interest-v1` is byte-for-byte the model it was, and no `naturalist-interest-v2` was created.


---

# Update: `naturalist-interest-v2`, after restoring the ecology signal

The defect in the finding above was fixed, and the same eight-region evaluation was re-run. **The recommendation is
still B — keep the exploration order optional — but the reason changed**: ecology is now real and it does move the
order; what still keeps it off the default is distance and top-of-list saturation, not a dead signal.

## The defect, precisely

The published derived row carries `l3_count`, `l4_count` and `transition_count` (built in `scripts/build-derived.py`
as `len(l3 intersections)`, `len(l4 intersections)` and `(l3_count-1)+(l4_count-1)`). The reader did not lose the
values - it never passed them on:

1. `levelEntry` (`src/gis/derived-query.js`) built `intersections: [primary]` - an honest one-entry list, because
   only the primary region's *name* is stored - and used the count only for `spansMultiple`.
2. `derivedMetrics` did not surface the counts as `ecoregionCount`/`transitions`.
3. `buildDiscoveryResult` (`src/discovery/signals.js`) computes both from the intersection list, so it saw a
   one-entry list and reported `ecoregionCount = 2`, `transitions = 0` for every corridor.

So `varietyDistinctValues` was 1 and `transitionsMax` 0 in all eight regions - a **reader-plumbing loss**, not absent
data. The transition count is genuinely present in the plane; `transitionsMax: 0` was the plumbing.

## The fix

`levelEntry` now returns `count` alongside the honest one-entry `intersections` (no fabricated duplicates);
`derivedMetrics` passes `ecoregionCount` and `transitions` through from the stored fields; and
`buildDiscoveryResult` uses an explicitly provided count when one is present and falls back to the intersection list
otherwise, so the raw path is byte-for-byte unchanged.

- **`ecoregionCount` semantics (chosen and tested):** the number of distinct mapped ecoregions, **Level III and
  Level IV counted separately** - `l3_count + l4_count`. This is the field's existing documented meaning
  (`tests/discovery.test.js`: *"distinct Level III and IV codes are counted separately"*) and it is exactly what the
  raw analysis's own intersection list yields, so a derived row and a raw re-measurement of the same corridor now
  agree. `max(l3_count, l4_count)` was considered and **rejected for this step**: it would make the derived path
  disagree with the raw path for the same road and silently redefine a public sortable column ("Distinct
  ecoregions"). The nesting caveat is real and is noted below as a candidate for a *separately measured* future
  change.
- **`transitions` semantics:** the published `transition_count`, surfaced unchanged - real boundary crossings, never
  inferred from `count > 1`.
- **Coverage/missing semantics kept:** an absent count is `null` (unknown), never 1; a stored count of 0 is proof of
  none; ecology coverage that is `UNKNOWN`/`NONE` still leaves the variety component out of the weighted mean
  (`unknown != zero`).

## Versioning

`naturalist-interest-v1` is **frozen** as published evidence (`data/ranking/naturalist-interest-v1-evaluation.json`,
unchanged). The weights and transforms are **unchanged** - correcting the ecology inputs is the only difference -
but the ordering moves, so the version is **`naturalist-interest-v2`**
(`data/ranking/naturalist-interest-v2-evaluation.json`). Nothing about v1's committed evaluation was rewritten, and
no weight was tuned in this step.


## Same eight regions, re-measured

| region | vs default | v1→v2 overlap | variety distinct (v1→v2) | transitions max (v1→v2) | top spread (v1→v2) | v2 median dist |
|---|---|---|---|---|---|---|
| Princeton, IN | 2/10 | 4/10 | 1 → 3 | 0 → 2 | 3.6 → 2.5 | 16.95 mi |
| Evansville, IN | 1/10 | 2/10 | 1 → 3 | 0 → 2 | 4.2 → 3.5 | 17.34 mi |
| Nashville, TN | 6/10 | 6/10 | 1 → 4 | 0 → 3 | 2.8 → 6.0 | 14.75 mi |
| Portland, OR | 0/10 | 2/10 | 1 → 5 | 0 → 4 | 2.3 → 2.9 | 24.2 mi |
| Houma, LA | 1/10 | 6/10 | 1 → 4 | 0 → 5 | 3.4 → 3.5 | 18.4 mi |
| Phoenix, AZ | 5/10 | 8/10 | 1 → 3 | 0 → 2 | 4.7 → 4.9 | 19.3 mi |
| Omaha, NE | 0/10 | 3/10 | 1 → 4 | 0 → 3 | 3.1 → 4.9 | 17.23 mi |
| Boston, MA | 0/10 | 2/10 | 1 → 4 | 0 → 3 | 1.7 → 2.7 | 16.9 mi |

- **Ecology now differentiates.** `varietyDistinctValues` is 3-5 per region (was 1 everywhere);
  `regionsWithConstantVariety` is **0/8** (was 8/8). Mean top-10 overlap against the previous version is **4.13/10**,
  so roughly six of every ten top roads moved **because their ecological context is now measured** - and nothing
  else changed between the runs.
- **It does not dominate.** `varietyDominant` (roads surfaced by ecological variety alone) is **0** in every region,
  wetland saturation stays high (mean 0.95), and no water-only road reaches a top. What enters is a set of
  transition-zone roads with real context in all three planes - Portland's `NE Lucia Falls Rd`, `SW Spring Hill Rd`,
  `NW Cedar Canyon Rd`, `SE Gordon Creek Rd`; the Plains' `US Hwy 34` (5 ecoregions, 3 transitions); Princeton's
  `Co Rd 100 N`.
- **Near-ties improve where they were worst.** Boston's top-10 spread widens 1.7 → 2.7 and Nashville's 2.8 → 6.0.
  Phoenix still has **one** distinct variety value inside its top ten, so ecology alone does not break that region's
  tie - its wetland and water components are already saturated.
- **Boundary-adjacent roads do appear** (`County Line Rd`, `Warrick County Line Rd` in Princeton), and that is a
  genuine, if mildly self-selecting, signal: a road that follows an ecoregion boundary *is* in two ecoregions. They
  are not variety-only, and their variety is capped by the existing transform.

## Does v2 change the recommendation?

No, and the reason is now sharper:

1. **Distance.** Portland's v2 median top-10 distance is **24.2 mi** (v1 22.5, default 6.5) - the model still leads
   with roads at the rim of the search, because distance is deliberately not in the score.
2. **Saturation.** In wetland-rich regions the top ten is still a narrow band (Portland 2.9 points, Boston 2.7,
   Princeton 2.5), and in Phoenix the whole top ten shares one variety value.
3. The ecology signal is now honest, but it is the **third** of three signals and is capped by design; restoring it
   changed *which* roads are surfaced (toward transition zones) without fixing (1) or (2).

**Default sort: unchanged (`wetlandArea250`).** `naturalist-interest-v2` stays optional and is the honest model to
evaluate next.

## Next

With ecology restored, the two questions from v1 stand on their own and must be measured separately: **distance** (a
product decision about whether an exploration order decays with distance) and the **nesting of `ecoregionCount`**
(`max(l3_count, l4_count)` rather than the two-level sum) - neither bundled with a plumbing fix.


---

# Update: `exploration-order-v1` — distance as convenience, layered on the interest score

The v2 evaluation left one measured problem: the interest ordering can lead with roads at the rim of the search
(Portland's median top-10 distance was 24.2 mi in a 25-mile search). Distance is evidence of convenience, not of
environmental interest, so it must not enter the interest score. It is therefore a **separate family** that consumes
it:

```text
explorationOrder = naturalistInterest - penalty(distanceFromCentre / requestedRadius)
```

`naturalist-interest-v2` is untouched - same weights, same transforms, same score - and every exploration row carries
the interest score it adjusted.

## Four transforms, measured before one was chosen

All eight regions, 25-mile radius, top 10, same rows. Full numbers:
`data/ranking/exploration-order-v1-evaluation.json`, `docs/EXPLORATION-ORDER-EVALUATION.md`.

| transform | cap | mean overlap with interest top | mean median distance before → after | regions closer | worst interest delta | interest #1 kept in top 10 / top 3 | worst replacement gap | near-tie resolved toward nearer |
|---|---|---|---|---|---|---|---|---|
| `linear` | 10 | 4.5/10 | 18.13 → 8.44 mi | 8/8 | −2.21 | 7/8 · 4/8 | **5.5** | 0.88 |
| `quadratic` | 10 | 4.63/10 | 18.13 → 9.37 mi | 8/8 | −2.48 | 5/8 · 4/8 | 3.4 | 0.90 |
| `tiered` | 10 | 4.0/10 | 18.13 → 7.46 mi | 8/8 | −2.99 | 5/8 · 3/8 | 3.5 | 0.79 |
| **`gentle`** (selected) | 6 | 6.0/10 | 18.13 → **10.13 mi** | 8/8 | **−1.52** | **7/8 · 6/8** | 3.4 | 0.83 |

## Why `gentle` (quadratic decay, capped at 6 points)

It is the only candidate that satisfies every criterion stated before the results were seen:

1. **Portland's rim bias is materially reduced**: median top-10 distance 24.2 → **10.64 mi**; p90 also falls.
2. **Distance improves in all eight regions** (the rule asked for five).
3. **Interest retention is high**: the worst region gives up **1.52** points of interest (the others −0.2 to −1.0);
   the top-10 mean never falls more than ~2%.
4. **Strong roads survive.** The interest #1 stays in the exploration top 10 in **7 of 8 regions**, and in the top 3
   in 6. The one region where it leaves (Evansville) is the honest case: the interest top-10 there spans only 3.5
   points, and the road that replaces the #1 is **1.9 points behind it** - a near-tie settled by 19 miles of
   convenience, not a strong road buried. The `replacedByGap` column is in the artifact precisely so that claim is
   measurable rather than asserted.
5. **No centre-hugging**: the near roads that rise are genuinely strong (interest 79–82 in Evansville's case), and
   the top-10 mean interest barely moves.
6. **Near-ties settle toward the nearer road** (share 0.83 over the pairs where the nearer road scores lower), mostly
   by construction: the penalty is a function of distance alone, so it can never make a far road look more
   interesting, only less convenient.

The `linear` and `tiered` caps charge their whole price for being anywhere that is not the centre, which is what
produces the largest replacement gaps (5.5 points) and the weakest retention. `quadratic` at cap 10 moves distance
furthest but keeps the interest #1 in only 5 of 8 regions. `gentle` is the smallest bounded change that still halves
the median distance everywhere.

## Sanity at other radii (Portland, Princeton, Phoenix)

| radius | regions closer | worst interest delta | interest #1 kept | near-tie |
|---|---|---|---|---|
| 10 mi | 3/3 | −0.98 | 3/3 | 0.87 |
| 25 mi | 3/3 | −1.52 | 3/3 | 0.87 |
| 50 mi | 3/3 | −0.93 | 3/3 | 0.84 |

The normalization is what makes that consistent: the exploration top-10 lands at **39–65% of the radius** at every
radius, rather than at a fixed number of miles, and in a 10-mile search the term barely moves anything because there
is no rim to correct. The same road is penalized at 20 miles in a 25-mile search (0.8 of the radius) and at 20 miles
in a 50-mile search (0.4) by different, correctly-scaled amounts.

## Recommendation

**B — keep the exploration order optional; do not change the default.** It is now a real, measured improvement to
practical ordering - the rim bias is gone, interest is preserved, and the behaviour is bounded and explainable - but
it is a *different* order from the one the product has shipped, and the product decision (does the table lead with
"most interesting" or "sensible to consider first"?) is a product decision, not a measurement. Both orderings are
offered side by side, and neither is presented as the other.


---

# Decision: `Exploration order` is the default sort

The exploration-order evaluation above clears the bar the v2 evaluation set, so the product default moves: a normal
centre/radius search now leads with **Exploration order**, and **Naturalist interest** stays beside it as the
centre-independent environmental-context view. Every factual sort is unchanged.

**Why, in the measured numbers.** Across the same eight regions the order cuts the median top-10 distance from
18.13 mi to 10.13 mi (8/8 regions closer), keeps **98–100%** of the naturalist-interest quality (worst region −1.52
points), keeps the interest's first road inside the top ten in 7 of 8 regions, and settles near ties toward the
nearer road 83% of the time. Portland - the case that motivated the work - goes from a 24.20 mi median to 10.64 mi.
No centre-hugging, no rim cliff, and no strong-road suppression beyond one honest near tie (Evansville: a 1.9-point
swap inside a 3.5-point band).

**What changed: one constant.** `DEFAULT_SORT` in `src/discovery/filter.js` is the single authoritative default and
now names `explorationOrder`; the store and `sortResults` already read it, so nothing else needed a default. Two
things were deliberately *not* changed:

* **No ranking math.** `naturalist-interest-v2` and `exploration-order-v1` are untouched - same weights, transforms,
  components and distance penalty. Regenerating both evaluations from this code reproduces the committed artifacts
  exactly.
* **The evaluation baseline did not follow the default.** `EVALUATION_BASELINE_SORT` is now its own constant
  (`wetlandArea250`), because the committed v1 and v2 evaluations were measured *against* that baseline and
  re-pointing it would silently rewrite published history.

**A search with no centre.** A declared box/region search has no centre, so the exploration order honestly reduces to
the interest score rather than inventing a distance - and the line under the results says so ("This search declares
no centre, so no distance is considered") instead of implying one.

**Persistence: a choice, not a default.** A deliberate sort choice *is* remembered. It lives in the discovery record
this module already owns (`src/discovery/persistence.js`, the last-search entry) as an optional `preferredSort`
field - no new storage key, and no version bump, because the reader validates the fields it reads and an older
record simply has no preference. Three rules make it a *preference* rather than a snapshot of the default:

* **Written only by an explicit change.** `store.setDiscoverySort` is the only writer, and the sort control is its
  only caller. Initialising, starting a run, finishing a run, selecting a corridor, marking a corridor and restoring
  a search all leave it alone, so a default never becomes a stored decision.
* **Absent means "nobody chose".** With no field - or one naming a sort this build no longer offers - the store
  starts at `DEFAULT_SORT`. A future default change therefore reaches everyone who never picked, and never overrides
  anyone who did.
* **One record, two fields.** The same entry holds the last search and the preferred sort, and each writer keeps the
  other's field: choosing a sort cannot lose the search, and running a search cannot lose the sort. The sort
  belongs to the person, so it is deliberately *not* attached to each search-history entry.

The two halves are proven by `tests/sort-preference.test.js` (absent → default, restored, written only by a choice,
invalid ignored, older record still valid, other records intact, every offered sort round-trips) and by
`tests/sort-preference-map.spec.js` in a browser (fresh session writes nothing, each choice survives a reload, an
obsolete value is ignored). There is still no URL sort.

**Copy.** The two options are named exactly `Exploration order` and `Naturalist interest`, with the meaning of each
said once beside the control (derived from the model's own help text), and the line under the table follows the
active ordering - a heuristic is never described as a measurement, and a measurement is never described as a
heuristic.

