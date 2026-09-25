# Species occurrence evidence (iNaturalist and eBird)

Road Naturalist's occurrence layer reports what people have publicly reported near a road corridor:

> Which organisms have actually been publicly reported in the ecological vicinity of this road, how
> recent are those reports, and how strong is the spatial evidence?

It is **not** habitat suitability, abundance, probability, or a prediction. A public observation
record proves that someone publicized an observation at some place and time. It does not prove that an
organism is on the road, that it is there now, or that it is likely to be seen.

The pipeline:

```text
real corridor (TIGER/Line) → 1 km / 5 km / 10 km search regions
        ↓
iNaturalist adapter            eBird adapter (credential-safe transport)
        ↓                        ↓
        one normalized occurrence model (src/occurrence/model.js)
        ↓ privacy + positional-accuracy filter
        ↓ DuckDB Spatial distance measurement in EPSG:5070
        ↓ deterministic spatial / temporal / taxonomic summaries
        ↓ per-source coverage + provenance
SPECIES OCCURRENCE EVIDENCE (separate from PHYSICAL HABITAT EVIDENCE)
```

## 1. Sources

| Source | Product | Auth | Used for |
| --- | --- | --- | --- |
| iNaturalist | public observations API **v2** (`https://api.inaturalist.org/v2/observations`) | none (public read) | all taxa, recent and historical as available |
| eBird | public API v2 **recent observations** (`https://api.ebird.org/v2/data/obs/geo/recent`) | personal API key (`X-eBirdApiToken` header) | recent bird reports only |

**Why iNaturalist v2.** The v1 endpoint returns the same records but about **12.4 MB per 200
observations** because it ignores `fields`; v2 supports a field projection, so the same 200 records
cost about **156 KB**. v2 also returns `total_results`, honours `quality_grade`, `d1`/`d2`, `acc`,
`per_page` (max 200) and `order_by=observed_on`, and sends `access-control-allow-origin: *`, so the
browser can call it directly without a proxy. No authentication is used because public reads do not
need one.

**Why the eBird public API and not the Basic Dataset.** The public API is a bounded recent-observation
service (`back` limited to 30 days, `maxResults` capped, ≤50 km radius). That matches this layer's
scope: recent documented bird evidence near a corridor. The eBird Basic Dataset, Status & Trends
rasters, and any nationwide historical ingestion are deliberately **out of scope** here and are
documented as a possible future bulk path (section 12).

## 2. iNaturalist privacy rules (foundational)

The source decides obscuring; Road Naturalist decides what may then be measured:

| Source state | Normalized `locationPrecision` | `spatialUse` | Coordinates kept |
| --- | --- | --- | --- |
| open, stated accuracy ≤ 500 m | `precise` | `CORRIDOR_DISTANCE_ALLOWED` | yes |
| open, stated accuracy > 500 m | `approximate` | `REGIONAL_ONLY` | **no** |
| open, no stated accuracy | `approximate` | `REGIONAL_ONLY` | **no** (precision unverified) |
| `obscured`, `geoprivacy: obscured`, or `taxon_geoprivacy: obscured` (and iNaturalist `private`) | `obscured` | `REGIONAL_ONLY` | **no** |
| no public point at all | `unavailable` | `NOT_SPATIALLY_USABLE` | **no** |

The public randomized point of an obscured observation is **never stored** in the normalized record,
never measured, and never plotted. Tests assert that neither the coordinate values nor any distance
can survive normalization for an obscured record, and that a distance attached to a non-precise
record is dropped rather than trusted.

Why drop rather than flag the obscured point: the published position is randomized inside a cell up to
tens of kilometres across (iNaturalist reported `public_positional_accuracy` of 26–27 km in this
pilot). Keeping it would invite exactly the claim the domain forbids: *"observed 180 m from this
road"*. What is preserved instead is the reason the record was excluded
(`spatialExclusionReason`), the source's own flags, and the stated accuracies.

**Positional-accuracy limit.** `CORRIDOR_ACCURACY_LIMIT_M = 500` — half of the smallest evidence
radius. A 1 km-accuracy point cannot support a "within 1 km of this road" claim, and an unstated
accuracy cannot be assumed good. Records excluded this way still contribute **regional** evidence
(they count toward region totals, taxa, and recency) but never to corridor distances.

## 3. eBird credential architecture

eBird requires a personal API key. Road Naturalist therefore never ships one to the browser:

```text
browser          occurrence service with ebirdTransport = null
                 → eBird reports UNKNOWN with “requires a personal API key” (never 0 species)
local dev/CI     scripts/verify-occurrence-live.mjs reads EBIRD_API_KEY from the environment and sends
                 it only in the X-eBirdApiToken request header
production       a reviewed server-side boundary (Cloudflare secret, see worker/README.md) supplies the
                 same transport shape; no key ever reaches the page
```

The transport is injected (`createOccurrenceService({ ebirdTransport })`), so the adapter, its query
construction, its normalization, and its coverage semantics are fully testable offline with fixtures.
`npm run verify:occurrence:live` detects the environment variable: without it, eBird prints **SKIP** and
the command still exits 0; with it, one bounded query is issued and the returned shape is validated.
The key is never printed, never logged, and never placed in a URL, in provenance, or in a fixture.

**eBird spatial semantics.** A public (non-private) checklist location is treated as `precise` at
checklist scale because eBird exposes no positional-accuracy field; a checklist marked
`locationPrivate` is `regional` and is never measured or plotted. A count reported as `X` by the
observer is `null` (UNKNOWN) — never zero. Search is a disk centred on the corridor midpoint with
`dist = ceil((corridorLength / 2 + radius) / 1 km)`, which by the triangle inequality contains the
whole corridor neighbourhood; the disk and the requested window are recorded in provenance.

## 4. Search regions and radii

`OCCURRENCE_RADII_M = [1000, 5000, 10000]` around the corridor. They are **evidence search
distances, not biological thresholds**: 1 km is very local evidence, 5 km nearby landscape evidence,
10 km broader occurrence context.

iNaturalist takes a bounding box, so each radius defines a **search region** = corridor bounds
expanded by that many metres (latitude and longitude padded separately with a conservative
metres-per-degree factor). Region membership is a *query* fact, not a distance claim. The true
distance from each eligible observation to the corridor is computed separately in DuckDB Spatial
(`ST_Distance` between the point and the corridor, both transformed to **EPSG:5070**), so distances
never come from the bounding box.

## 5. Temporal windows

Recency buckets are mutually exclusive and computed from the record's own timestamp:

| Bucket | Meaning |
| --- | --- |
| `d30` | last 30 days |
| `d90` | 31–90 days ago |
| `d365` | 91–365 days ago |
| `historical` | older than 365 days |

Source-reported totals use the cumulative windows the API supports (`d1 = now − N days`) and are
labelled “reported in the last N days” to keep them distinct from the exclusive buckets. Every
normalized record keeps its full observation timestamp, so other windows can be added later without a
re-ingest. No seasonal biological inference is drawn: *“observed in April in previous years”* is a
fact this layer can report; *“therefore likely now”* is out of scope.

## 6. Taxonomy

Source taxonomy is preserved (`sourceTaxonGroup`, `sourceTaxonId`, `taxonRank`) and normalized into one
of: `birds`, `mammals`, `reptiles`, `amphibians`, `fish`, `insects`, `arachnids`, `mollusks`, `plants`,
`fungi`, `other`. iNaturalist contributes `iconic_taxon_name`; eBird records are birds by construction.
Anything unmapped becomes `other` rather than being forced into false precision. UI lenses (`All`,
`Birds`, `Mammals`, `Herps`, `Insects`, `Plants`, `Fungi`) are groups of normalized groups, defined in
the model, never in the UI.

## 7. Retrieval, caching, and etiquette

Per corridor the iNaturalist analysis issues **10 requests**:

| Request | Purpose |
| --- | --- |
| 3 × `per_page=0` counts (1/5/10 km, research grade) | source-reported totals per search region (≈60 B each) |
| 1 × `per_page=0` count (1 km, all grades) | how much of the local record is not research grade |
| 3 × `per_page=0` counts with `d1` (30/90/365 days, 10 km) | source-reported recency totals |
| 1 × `per_page=0` count with `d1` (30 days, 1 km) | local recent activity |
| 2 × `per_page=200` record pages (1 km, 5 km, `order_by=observed_on desc`) | bounded detail: taxa, recency, distances |

* **Bounded pagination.** One page per region, capped at 200 records, most recent first. A truncated
  retrieval is recorded as `truncated: true` and forces coverage `PARTIAL` — a capped response is
  never presented as complete.
* **Concurrency limit** 3 in-flight requests; **timeout** 20 s per request (`AbortSignal.timeout`).
* **No retry storm.** A failed request is recorded as a query failure; the source either reports
  `UNKNOWN` (nothing succeeded) or `PARTIAL` with the failure named (some succeeded).
* **Cache.** In-session, keyed by source + radii + corridor bounds, TTL 15 minutes. A repeated
  analysis of the same corridor makes no new request (measured: 0 ms). No distributed or persistent
  cache is introduced; a future release may add a reviewed server-side cache.

## 8. Coverage semantics

Two occurrence datasets join the existing coverage dimensions, plus an aggregate that is derived from
them:

```text
occurrence-inaturalist   FULL | PARTIAL | UNKNOWN
occurrence-ebird         FULL | PARTIAL | UNKNOWN
occurrence               derived: FULL only if both are FULL, UNKNOWN only if both are UNKNOWN, PARTIAL otherwise
```

| State | Meaning |
| --- | --- |
| `FULL` | every requested query completed and the retrieval was complete for what was requested (a region with 0 reported observations is a genuine zero) |
| `PARTIAL` | the source reported more records than the bounded retrieval returned, or some requests failed while others succeeded |
| `UNKNOWN` | the source could not be queried at all, or a credential is missing; the reason is preserved |

`NONE` is not used for occurrence: a source that cannot answer is `UNKNOWN`, and a successful query
that finds nothing is `FULL` with zero observations. **A missing source never becomes “0 species
nearby”.**

Depth matters as much as state, so every source summary also reports its retrieval depth
(`400 records — capped at 200 per search region, most recent first`) and distinguishes
**source-reported totals** (exact for the query) from **retrieved record counts** (a bounded sample).
Corridor-distance bucket counts are therefore labelled *“at least”*: every retrieved record exists in
the full set, so the bucket count is a lower bound, never a population estimate.

## 9. Provenance

Each source summary keeps: source id and label, product and endpoint, authentication mode, retrieval
timestamp, quality grade, radii, temporal window, the canonical query strings (no credentials), the
search-region bounds, the result counts (`requests`, `retrieved`, source-reported totals), truncation
flags, the privacy and spatial-filter rules, the measurement CRS, and the normalization version.
Per-record traceability is `sourceRecordId` (iNaturalist observation id / eBird `subId:speciesCode:obsDt`
style composite) plus the record's `sourceUrl`. Credentials never appear in provenance because none
exist for iNaturalist and the eBird key is header-only and never echoed.

## 10. What this evidence does and does not prove

* It **does** establish: N public observations were reported inside a stated region and window; of the
  retrieved records, M carry a public location precise enough to place them within X metres of the
  corridor; the taxa involved; how recent they are.
* It **does not** establish abundance (repeated reports of one individual remain separate
  observations), occupancy, breeding status, current presence, accessibility, or likelihood of
  observation. Observer effort is uneven and location-biased — this pilot's 10 km regions contain
  between 47,786 and 168,303 reported observations, which measures **public reporting density** more
  than wildlife density.
* It does not merge sources: an iNaturalist bird record and an eBird bird record are independent
  evidence with independent provenance, compared through the normalized model but never deduplicated
  by similarity.

## 11. Performance (measured, Chromium, local static server)

| Measurement | Value |
| --- | --- |
| External requests per corridor (iNaturalist) | 10 (8 count responses ≈60 B each + 2 record pages ≈156 KB each) |
| Payload per corridor | ≈0.32 MB |
| First analysis per corridor (live) | 2.3–3.3 s |
| Repeat analysis of the same corridor (cached) | 0 ms, 0 requests |
| Distance measurement (DuckDB, 217 points, one query) | 96 ms |
| Initial app load impact | **none** — occurrence queries are triggered only by the user |
| Full browser suite | 6 Playwright tests, 41.7 s serial |

No occurrence data is written to `data/`, committed, or bundled: the layer is API → cache → normalized
evidence, and only the small deterministic fixtures under `tests/fixtures/` are version-controlled.

## 12. Verification and regeneration

```sh
# offline, deterministic (routine)
npm test                       # normalization, privacy, spatial, temporal, coverage, integration
npm run test:e2e               # stubbed-source UI, degraded behaviour, real DuckDB measurement

# opt-in live (network)
npm run verify:occurrence:live      # source adapters and normalization against the public APIs
npm run verify:occurrence:browser   # full browser pipeline with real requests and real distances
```

`verify:occurrence:live` prints a per-corridor report (region totals, retrieval depth, buckets,
recency, groups, top taxa) and prints **SKIP** for eBird when `EBIRD_API_KEY` is absent. It is the only
place outside the browser that talks to these APIs, and it is never part of `npm test`.

## 13. Where future layers fit

| Layer | Status | Note |
| --- | --- | --- |
| `EXPECTED` (ecoregion/habitat plausibility) | partially present | EPA ecoregions and physical habitat evidence already exist as separate kinds |
| `HISTORICAL` / `RECENT` / `LOCAL` | implemented here | per-record evidence kinds plus recency buckets |
| Historical occurrence archive (eBird Basic Dataset, GBIF) | not implemented | would need a reviewed bulk pipeline and partitioning, not a browser download |
| Seasonal / phenological summaries | not implemented | the data model keeps full timestamps so windows can be added without re-ingestion |
| `MODELED` (deterministic model output) | not implemented | must stay a separate evidence kind |
| `INFERRED` (analysis or AI interpretation) | not implemented | may never masquerade as a source fact |
