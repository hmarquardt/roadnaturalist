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

