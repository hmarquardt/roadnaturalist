# The Investigator and access verification

Road Naturalist's deterministic layers answer *what is here*: real road geometry, EPA ecological context,
mapped wetlands and hydrography, and publicly reported species occurrences. None of them answers the question a
reader actually asks before driving a road:

> Is this a public road with ordinary motor-vehicle access, who controls it, and is anything restricting it today?

The Investigator researches that question from identified sources, keeps every answer, and reports a **qualified
finding** rather than a yes/no.

```text
DETERMINISTIC BASE
  road geometry (TIGER/Line) · EPA ecoregions · NWI wetlands + NHD hydrography · public occurrence reports
        │
        ▼
portable corridor evidence bundle          (src/investigator/bundle.js, versioned JSON)
        │
        ▼
INVESTIGATOR (src/investigator/service.js, seven stages)
  baseline → road context (OSM) → authority discovery → access research → contradiction search
           → adversarial review → finding
        │
        ▼
qualified access finding + coverage + contradictions + unresolved items
        │
        ▼
explainable candidate state (ACCESS & ROAD STATUS in the UI, `access` in the bundle)
```

This is evidence and verification work. It is **not** routing, navigation, a route ranking, a wildlife score,
or a legal determination.

## 1. Access is not a boolean

`src/investigator/access.js` owns the vocabulary. A finding is one of:

| Finding | Means | Does not mean |
| --- | --- | --- |
| `VERIFIED_PUBLIC` | Strong current evidence from an authoritative source supports ordinary public motor-vehicle use of the corridor as a whole | A legal guarantee, a warranty of passability today, or a statement about every part of the corridor |
| `PROBABLE_PUBLIC` | Consistent evidence supports public access, but it is not authoritative enough, or covers only part of the corridor | Confirmed access |
| `UNVERIFIED` | Road Naturalist has not established public, legal, or practical access. **This is the default** | A negative finding; the road being private |
| `CONFLICTED` | Sources of comparable reliability disagree about the road's status | A decision by Road Naturalist; a person must review it |
| `RESTRICTED_OR_CLOSED` | An authority documents a restriction that is in force or recurs | A permanently private or unusable road |

Restrictions are preserved individually. A temporary construction closure, a seasonal high-water closure, a
permit requirement, a gate, and a private-road claim are different claims with different scopes and dates, and
the UI lists them separately instead of collapsing them into "closed".

## 2. Source reliability

| Class | Examples | Standing |
| --- | --- | --- |
| `TIER_1_AUTHORITATIVE` | state DOT, county road department, land-management agency, official closure notice, the county's own road-status service | Can support `VERIFIED_PUBLIC`; a restriction from this class acts on the finding |
| `TIER_2_INTERMEDIATE` | government-maintained GIS, official road inventory, right-of-way record | Same standing as Tier 1 for this pilot; recorded separately |
| `TIER_3_COMMUNITY` | OpenStreetMap, established road/trail databases | Can never produce `VERIFIED_PUBLIC`; an unrebutted restrictive claim caps the finding at `PROBABLE_PUBLIC` |
| `TIER_4_ANECDOTAL` | trip reports, forums, social media, blogs | Never overrides an authoritative restriction; recorded and shown |

Two rules follow, and both are tested:

* a Tier 4 post saying *"drove it yesterday"* does not override an official closure;
* the absence of an official page about a road is **not** evidence that the road is private.

## 3. Access evidence

Every item (`createAccessEvidence`) is one source statement, normalized and frozen:

```text
id, corridorId
claimType  (PUBLIC_ROAD, PRIVATE_ROAD, MOTOR_VEHICLES_ALLOWED, MOTOR_VEHICLES_RESTRICTED,
            SEASONAL_CLOSURE, TEMPORARY_CLOSURE, PERMIT_REQUIRED, GATE_REPORTED, ROAD_MAINTAINED,
            ROAD_UNMAINTAINED, SURFACE, ROAD_CLASS, LAND_MANAGER, ACCESS_TAG_ABSENT,
            ROAD_NAME_VARIANT, UNKNOWN)
claimValue, effect (AFFIRMATIVE | RESTRICTIVE | ATTENTION | NEUTRAL), stance (supports/contradicts public access)
sourceClass, sourceTier, sourceOrganization, sourceTitle, sourceUrl, sourceType
appliesTo, quote (verbatim), summary, claimStrength (stated | described | unclear)
publishedAt, retrievedAt, effectiveFrom, effectiveUntil, recurrence
geographicScope { scope: CORRIDOR | CORRIDOR_PART | COUNTY_SEGMENT | NOT_APPLICABLE, corridorPart, note }
provenance { method, retrieval }
```

The claim vocabulary is controlled because the effect of a statement decides what it can do to a finding. The
source's own words always travel separately in `quote`, and the *quotes in this build are substrings of what the
source served* — see section 6.

`ATTENTION` claims (a mapped gate, an unmaintained surface, a similarly named road) are surfaced but never decide
a finding. `NEUTRAL` claims (surface, road class, a land manager) are context.

## 4. The seven stages

| Stage | What it does | Network |
| --- | --- | --- |
| `baseline` | Records the deterministic evidence already on hand and what is missing | no |
| `road-context` | Queries OpenStreetMap through Overpass, matches the ways to the canonical corridor, derives access-tag facts and name variants | yes |
| `authority-discovery` | Derives which organizations could control the road, each with its basis, and reports declared sources whose authority was not derived | no |
| `access-research` | Runs the declared access probes and computes a **provisional** finding | yes |
| `contradiction-search` | Runs the declared closure/private/permit/gate probes, deliberately looking for disconfirming evidence | yes |
| `adversarial-review` | Runs the named challenge checks against the provisional finding | no |
| `finding` | Recomputes the finding from all evidence, attaches the review, coverage, and freshness | no |

Each stage records status, summary, counters, warnings, evidence ids, and timestamps. A failed source degrades
coverage and appears in the stage warnings; it never becomes "nothing found".

## 5. Finding rules (deterministic guardrails)

First match wins. `deriveAccessFinding` computes them from evidence fields only; no score, no ranking, and no
model judgement participates.

| Rule | Finding | Condition |
| --- | --- | --- |
| `R1_NO_ACCESS_EVIDENCE` | `UNVERIFIED` | Nothing was retrieved at all |
| `R2_STATUS_CONFLICT` | `CONFLICTED` | Two comparable sources disagree about the road's *status* (public vs private, motor vehicles allowed vs restricted or permit-only) |
| `R3_CURRENT_RESTRICTION` | `RESTRICTED_OR_CLOSED` | An authoritative restriction is in force at the check date |
| `R4_RECURRING_RESTRICTION` | `RESTRICTED_OR_CLOSED` | An authoritative restriction recurs (seasonal or high-water), source-stated |
| `R5_LOWER_TIER_RESTRICTION` | `PROBABLE_PUBLIC` | Authoritative affirmative evidence exists, but an unrebutted community-tier restrictive claim does too |
| `R6_AUTHORITATIVE_WHOLE_CORRIDOR` | `VERIFIED_PUBLIC` | Authoritative affirmative evidence speaks about the corridor as a whole and no restriction acts |
| `R7_AUTHORITATIVE_PART_OF_CORRIDOR` | `PROBABLE_PUBLIC` | Authoritative affirmative evidence covers only part of the corridor |
| `R8_COMMUNITY_ONLY` | `PROBABLE_PUBLIC` | Only community-tier evidence supports public access |
| `R9_NO_DECIDING_EVIDENCE` | `UNVERIFIED` | Evidence exists, but none of it bears on access |

Operational closures and status conflicts are deliberately different: a temporary closure of a public road does
not contradict the claim that the road is public, so it produces `RESTRICTED_OR_CLOSED` with the public-road
evidence still reported as `VERIFIED`. A private-road claim from a comparable source does contradict it, so it
produces `CONFLICTED` and neither side is chosen. A community-mapped restrictive claim with no authoritative
source leaves the finding `UNVERIFIED` and adds an explicit unresolved item
(`COMMUNITY_RESTRICTION_NO_AUTHORITY`).

Several organizations publishing maintenance or authority claims for one road (real for NW Cornelius Pass Rd,
where Multnomah County's capital plan and ODOT's transfer notice both name it) become
`MULTIPLE_AUTHORITY_CLAIMS`: recorded, shown in the UI, and never resolved by preference. That is also an
adversarial check (`AUTHORITY_OVERLAP`).

## 6. Source facts versus conclusions

The system keeps five different things apart:

```text
SOURCE FACT       "Washington County states Susbauer Road has permanent flood gates"
SOURCE CLAIM      "the county's advisory list carries a closure at Rock Creek to 10/07/2026"
DERIVED FACT      "100 of 107 mapped ways lie within 30 m of the corridor; 90.9% of the corridor is matched"
INVESTIGATOR FINDING  "RESTRICTED_OR_CLOSED (R3_CURRENT_RESTRICTION)"
INTERPRETATION    optional annotation text, which cannot set a finding
```

Two mechanisms keep this honest:

* **Probes declare their own facts.** A probe (`src/investigator/sources.js`) names a source, a question, and the
  verbatim phrases that count as a fact. A quote is therefore a substring of the served document — never written
  by a model or by this code. HTML is reduced to text content and whitespace is collapsed before matching, so a
  phrase that spans inline markup still matches; the quote shown is that normalized page text.
* **Narration cannot decide.** `applyNarration` exists so an operator note or a model may attach interpretation,
  and it rejects any citation that is not in the retrieved evidence set (returned as `rejectedCitations`). It has
  no path to changing the finding.

## 7. OpenStreetMap and geometry matching

OpenStreetMap is supporting evidence and an independent context source. TIGER/Line remains the geometry authority:
a mapped way that matches the corridor adds context and never replaces the corridor line.

* `src/investigator/osm.js` builds the Overpass queries, applies a bounded request budget (12 requests, 1.5 s
  minimum spacing, no retry storm), caches per corridor in session, and reports every mirror failure. Mirror order
  is `overpass-api.de` (operator path; needs a User-Agent and sends no CORS header), then `maps.mail.ru` (sends
  `access-control-allow-origin: *`, used by the browser), then a community mirror. A browser uses only CORS-capable
  mirrors, which is why the app also replays a recorded operator run.
* Tags are kept verbatim and nothing is inferred: an absent `access` tag becomes `ACCESS_TAG_ABSENT`, which is
  **neutral** — "OpenStreetMap makes no access statement here", which is neither public access nor a restriction.
  Explicit `access=yes/permissive/private/no` values become their own evidence items.
* Ways without an access tag are aggregated into one evidence item (plus one item per explicit tag), so a hundred
  identical "no tag" items cannot bury the two that say something.
* `src/investigator/osm-match.js` matches ways to the corridor: the corridor is sampled every 25 m, each sample is
  measured against every way segment in one local equirectangular frame centred on the corridor, and a sample
  counts as matched when the nearest segment is within 30 m. Reported metrics: matched fraction, matched length,
  unmatched length, matched way count, mean and maximum nearest distance, and a per-way table. Corridor *decision*
  distances (habitat, occurrence) still use the DuckDB Spatial engine in EPSG:5070; this module only associates two
  vector sources.
* Name differences are recorded, not discarded: `normalizeRoadName` canonicalizes direction spellings (`NW` ==
  `Northwest`) but keeps a genuine quadrant difference (`NE` vs `NW`) and a different road (`Northwest Old
  Cornelius Pass Road`) visible as `DIRECTION_VARIANT` and `CORE_VARIANT`.
* The search names are generated deterministically (`NW Susbauer Rd` → `Northwest Susbauer Road`, `Susbauer Road`)
  because OSM spells the same road differently; the match step, not the query, decides which ways belong.

## 8. Freshness

Access evidence ages much faster than GIS data, so dates are first-class:

| `temporalScope` | Condition | Acts on the finding |
| --- | --- | --- |
| `CURRENT` | an effective window contains the check date, or an official notice without a window is ≤ 365 days old | yes |
| `RECURRING` | the source itself states the condition repeats ("both roads frequently flood during heavy rains") | yes |
| `EXPIRED` | the effective window ended before the check date | no — reported, with a `NOT_CURRENT` contradiction entry |
| `STALE` | older than 365 days with no window and no stated recurrence | no — flagged |
| `UNDATED` | no publication or retrieval date | no — flagged |

The finding exposes `checkedAsOf` (when the evidence was evaluated) and `evidenceCheckedAt` (the newest source
retrieval it used). The UI shows both, and a replayed operator capture is labelled as recorded.

## 9. Coverage is not the finding

`access-verification` coverage says whether the research completed, in four values:

| Coverage | Meaning |
| --- | --- |
| `FULL` | every declared source answered (evidence *or* no relevant evidence) and OpenStreetMap context was retrieved |
| `PARTIAL` | some source failed, some source was deferred to the operator path, or OpenStreetMap was partial |
| `UNKNOWN` | the research could not run at all — no source was asked, or every request failed |
| `NONE` | no access verification has been performed yet (the pilot declaration's initial state) |

So `coverage = PARTIAL` with `finding = PROBABLE_PUBLIC`, or `coverage = FULL` with
`finding = RESTRICTED_OR_CLOSED`, are both legitimate and mean different things. A failed request is never
converted into "no restrictions found": it is reported as a failure with its status and reason, and
`coverage.probeSummary.failures` lists each one.

## 10. Contradictions and adversarial review

`contradictions[]` carries `STATUS_DISAGREEMENT`, `LOWER_TIER_RESTRICTION`, `NOT_CURRENT`, `ACTING_RESTRICTION`, and
`MULTIPLE_AUTHORITY_CLAIMS`, each naming the evidence ids involved. The UI shows them in their own block, above the
supporting evidence, with the statement that a contradiction is never resolved by preference.

`adversarialReview` runs nine named checks against the provisional finding and records an outcome for each:
`ACTING_RESTRICTION`, `NEGATIVE_CASE_CONFIRMED`, `CORRIDOR_PARTIAL`, `SINGLE_ORGANIZATION`, `WEAK_SOURCE_ONLY`,
`STALE_EVIDENCE`, `NAME_VARIANT`, `AUTHORITY_OVERLAP`, `EVIDENCE_ABSENCE`. A concern is recorded as a concern and
never amends the finding silently; the contradiction search runs *before* the review, so a finding that changes
shows `provisionalFinding`, the final `finding`, and `findingChangedByReview`.

## 11. Human review

The UI (and `store.setAccessReview`) records a human finding and annotation beside the automated one:

```text
automated finding (always kept) · human finding · annotation · decidedAt
```

A human review never erases the automated result, a re-run never erases the review, and the bundle carries both.

## 12. The evidence bundle

`buildCorridorBundle` produces one versioned JSON document (`roadnaturalist-corridor-evidence/1`) with
`schemaVersion`, `kind`, `generatedAt`, `corridor`, `geometry`, `ecology`, `habitat`, `occurrence`, `access`,
`investigation`, `coverage`, and `freshness`.

It deliberately excludes:

* credentials, API keys, and any field whose name looks like one (the validator rejects it);
* occurrence records, observation coordinates, wetland polygons, hydrography lines, and mapped way geometry —
  the summarized sections carry counts, coverage, provenance, and at most 12 taxon names per source:
* corridor coordinates, unless the caller passes `includeGeometry: true`, in which case the bundle records that it
  decided to carry them.

`validateBundle` checks the schema version, identity, dates, the presence of a guardrail `ruleId` with each
finding, the forbidden field names, and that no summarized section carries feature-level data. `parseBundle` is the
import path: it parses, validates, and throws with the reasons. The UI exports bundles; importing one is a
documented contract (`parseBundle`) rather than a UI feature in this task.

## 13. The three pilot corridors

The captured operator run that the browser replays lives in
`data/investigator/or-pilot-access-evidence.json` (schema `roadnaturalist-access-evidence/1`). It records, per
corridor, every probe's outcome, its retrieval metadata, the normalized evidence items, and the OpenStreetMap
context. Findings from the capture of **2026-09-26 UTC** (`capturedAt: 2026-09-26T00:02:01.389Z`, 2026-09-25 local):

| Corridor | Finding | Rule | Why |
| --- | --- | --- | --- |
| NW Cornelius Pass Rd | `RESTRICTED_OR_CLOSED` | `R3_CURRENT_RESTRICTION` | ODOT states the road is a state highway (OR 127) since 2021 and it is subject to ODOT maintenance, but Washington County states a full closure between Germantown Road and Kaiser Road for the Rock Creek bridge replacement until 2026-10-07, and the county's own advisory list carries the same closure. A `MULTIPLE_AUTHORITY_CLAIMS` contradiction (ODOT vs Multnomah County's capital plan) is recorded, not resolved |
| NW Springville Rd | `PROBABLE_PUBLIC` | `R7_AUTHORITATIVE_PART_OF_CORRIDOR` | Washington County describes Springville Road as its own street with a completed four-phase improvement between 185th Avenue and Kaiser Road, and Multnomah County lists NW Springville Road (City of Portland line to Washington County line) in its road capital plan; no source covers the corridor as a whole and no restriction was found |
| NW Susbauer Rd | `RESTRICTED_OR_CLOSED` | `R4_RECURRING_RESTRICTION` | Washington County states Susbauer Road and Fern Hill Road both flood often during heavy rainfall and that it installed permanent, manual-locking flood gates on them, is south of Hornecker Road and north of Long Road; a 2022 county notice records an actual closure between Long and Hornecker roads |

None of the three reaches `VERIFIED_PUBLIC`. That is the honest result of the available evidence, not a missing
demo: for Cornelius Pass a current restriction blocks it, for Springville the counties' evidence covers different
sections, and for Susbauer a recurring closure is documented. A corridor with an authoritative whole-corridor
statement and no restriction would reach it (see `R6` in the tests).

Source failures are part of the record, and the script reports them instead of smoothing them over. The capture
committed here answers every declared source (`coverage: FULL` for all three corridors), while earlier runs of the
same script hit a rate-limited `www.washingtoncountyor.gov` request (HTTP 429) and, for Susbauer, an OpenStreetMap
query that failed on every mirror (HTTP 400/406/429). Both appear in those runs as `FAILED` sources with
`access-verification` coverage `PARTIAL` — never as "no restriction found".

## 14. The probe catalog: declared sources as data

The sources the Investigator asks are **data**, not code. One committed file holds every public declaration:

```text
data/investigator/probe-catalog.json          what is declared (reviewable data)
data/investigator/probe-catalog.schema.json   the formal shape of that file
src/investigator/probes/catalog.js            the one loader both sides use
src/investigator/probes/schema-check.js       the small, fail-closed schema checker
```

The catalog declares corridors and probes. A probe names the organization, the source class (tier), the declared
public URL, the question, the corridors it applies to, a logical freshness profile, and the facts:

```json
{ "id": "wc-cornelius-bridge-project", "corridorIds": ["or-roads-cornelius-pass-rd"], "policyProfile": "closure-status",
  "url": "https://www.washingtoncountyor.gov/lut/projects/cornelius-pass-road-bridge-rock-creek",
  "facts": [ { "find": "Road closure has been extended to October 7, 2026", "claimType": "TEMPORARY_CLOSURE",
               "effectiveFrom": "2026-07-15", "effectiveUntil": "2026-10-07", "windowQuote": "Road closure has been extended to October 7, 2026" } ] }
```

**Corridor associations are declarative.** `corridorIds` lists the corridors a probe applies to; a probe that omits it
applies to every corridor in the catalog. One source that genuinely serves several corridors is declared **once** with
two ids (and the validator warns when two probes are byte-identical declarations that should be merged), while a source
read for two corridors with *different* facts stays two probes — that is what the two RCIP and two MSTIP entries are,
and why they are not duplicates.

**Facts stay deterministic.** A fact declares the exact phrase to look for (`find`), the claim it supports, the effect
comes from `claimType` through `access.js` (never declared twice), and the source's own words for a window or a
recurrence must be quoted (`windowQuote`, `recurrenceQuote`) because the extraction checks them against the retrieved
document before the fact counts. There are no prompts, no models, and no instructions in the catalog: the matching
authority remains `extractProbeFacts` in `src/investigator/research.js`.

**What the catalog cannot say.** It cannot name a host that may be fetched, raise a byte cap, change a timeout, allow a
redirect, add a header, choose a method, or set a cache lifetime. `policyProfile` is a *name*
(`closure-status`, `project-page`, `jurisdiction-document`) which `worker/investigator/policies.js` maps to a lifetime
server-side; an unknown name fails closed, and a declared URL on a host that is not in the Worker's allow-list makes the
Worker refuse to build that probe. Declaring a source therefore has two halves: the catalog entry, and — only if the
host is genuinely new — a deliberate allow-list entry in server policy.

**Versioning.** `schemaVersion` is `roadnaturalist-investigator-probes/1`. The loader refuses a version it does not
implement rather than guessing; a future version means teaching the loader the new shape and migrating the file in one
reviewed commit.

### Reviewer workflow: adding or updating a corridor's sources

```sh
# 1. edit data/investigator/probe-catalog.json (source URL, question, verbatim phrases, corridorIds, policy profile)
npm run validate:probes          # schema + semantics + Worker policy + capture/baseline references, offline
npm run test                     # the catalog has its own suite (tests/probe-catalog.test.js)
npm run verify:investigator:worker   # read the sources live: DEPLOYED via INVESTIGATOR_WORKER_URL, else locally
npm run investigator:refresh     # if the evidence should be recorded: rewrite the capture + baseline, report changes
git diff -- data/investigator src/investigator/probes/drift-baseline.js   # read the evidence diff before committing
```

`npm run validate:probes` leads with the probe and the fact that is wrong:

```text
Probe "wc-cornelius-pass-closure":
  fact 2 (TEMPORARY_CLOSURE), field "claimType" must be one of "PUBLIC_ROAD", … ; found "CLOSED_ROADZ"
    /probes/3/facts/2/claimType
```

Warnings (a `CORRIDOR_PART` fact without the source's own words, a probe with no reviewed capture yet, a probe the
catalog dropped while the capture still holds it) are printed but do not fail: they are for a reviewer, not a gate.
`npm run investigator:refresh` validates the catalog first, retrieves the declared probes through the same operator
path, rewrites `data/investigator/or-pilot-access-evidence.json` and `src/investigator/probes/drift-baseline.js`
together, re-validates them, prints what changed per probe, and commits nothing — the diff is the review.

### Capture and drift baseline remain separate artifacts

```text
probe catalog   what is expected (reviewed declarations; drives the refresh)
capture         what was retrieved (historical evidence the browser replays offline)
baseline        the normalized signature of that evidence (what a live read is compared with)
```

The catalog never contains retrieved text and the capture never defines a probe. `checkReviewedArtifacts` cross-checks
the three and reports a missing or stale entry in either direction, so a catalog edit that is not followed by a refresh
is visible immediately.

## 15. The live research boundary (Worker)

A browser cannot read most county sites: they send no CORS header. So live official-source research goes through the
Road Naturalist Worker (`worker/`), which reads **only declared sources** and answers with normalized facts.

```text
browser ──probe id──▶ Worker ──declared URL──▶ official page
   ▲                      │
   └── normalized facts + diagnostics + drift ──┘        (never the page)
```

The whole point is what the boundary **cannot** be asked to do:

* the client sends an id, never a URL (`GET /api/investigator/probes/:probeId`). The registry
  (`worker/investigator/registry.js`) is the only thing that can turn an id into a URL, and it is built from the
  reviewed probe catalog (section 14, loaded by `src/investigator/probes/catalog.js`) plus committed policy
  (`worker/investigator/policies.js`: static host allow-list, byte caps, timeouts, TTLs, accepted content types, and the
  profile → lifetime map);
* `https` only, default port, canonical URL, no credentials in the URL, ASCII host, no IP literal, no
  `localhost`/`.internal`/`.local`, no query string, no fragment — checked before the registry can serve a probe;
* redirects are not followed off the approved destination (`redirect: 'manual'`, at most one hop, same host and same
  path prefix), and a redirect that cannot be read is refused rather than guessed at;
* the response body is capped while streaming, the content type must be one the probe accepts, and the body is
  decoded safely before matching;
* only facts, drift, diagnostics, and metadata are returned — raw HTML never leaves the Worker, and the internal
  cache holds normalized text, not the page;
* no client header, cookie, credential, or method is forwarded, and there is no secret in the Worker at all;
* no model: extraction is the same exact substring rule set the browser uses (`extractProbeFacts`), and the finding is
  still computed by the guardrails in this document.

**Failure handling.** A source that fails is an HTTP 200 answer with `status: FAILED` and diagnostics (a 429 from the
source becomes `throttled`, never "no restrictions found"). HTTP 429 from the Worker itself means the caller was rate
limited; `SOURCE_BUDGET_EXHAUSTED` means the Worker was about to read that source too often this minute. Neither
reaches the county server. Every failure degrades access-verification coverage to `PARTIAL` and stays visible.

**Cache and freshness.** One cache entry per source URL (normalized text plus retrieval metadata) with the strictest
TTL among the probes that read it: a closure/status page 15 minutes, a project page 6 hours, a jurisdiction or
funding document 24 hours. `retrievedAt` is always the source read time, `cachedAt` the time the copy was stored, and
`cacheStatus` says `MISS`/`HIT`/`EXPIRED`/`BYPASS`/`UNCACHEABLE`. Failures are never cached. Measured on the pilot: a cold
pass reads 11 pages (496 kB) and returns 15.4 kB of facts; a repeat pass serves six probes from cache in 12 ms.

**Source drift.** The Worker ships a compact baseline of the reviewed capture
(`src/investigator/probes/drift-baseline.js`, generated with the capture) and compares its own fresh extraction
against it: `UNCHANGED`, `EVIDENCE_CHANGED` (with the facts added and no longer present), `NO_LONGER_MATCHES`,
`SOURCE_UNAVAILABLE`, `NO_BASELINE`. The browser compares a live result against the capture it replays (`drift.recorded`).
Drift is a diagnostic: the facts that are present now decide the finding, and "a changed page is not a changed
finding" is stated in the UI next to the drift.

**Runtime order.** Live Worker (when this build is configured with one and it answers) → reviewed capture (replayed,
marked as replayed and *not re-checked here*) → explicit degraded coverage. A live run in which no source answers falls
back to the capture, and the fallback is recorded in the result (`transportFallback`) and in the note under the panel.
`src/app/config.js` resolves the boundary: an explicit `window.ROADNATURALIST_WORKER_URL` first, then the committed
`PRODUCTION_BOUNDARY` (`https://api.roadnaturalist.com`, the deployed Worker) on any deployed origin, and nothing on a
local origin, so a production host reads its declared sources live while `npm run dev` still replays the capture with
no Cloudflare access. The deployed topology is in `docs/DEPLOYMENT.md`.

The retrieval mode of every source is recorded and shown: `LIVE`, `CACHE`, `RECORDED`, or `DEFERRED`, with
`notReChecked` counting replayed sources this environment could not re-check. Coverage reaches `FULL` only when every
declared source answered and the OpenStreetMap stage completed; a live run that loses a source is `PARTIAL` with the
failure named.

**Re-check.** The existing `Re-check access evidence` action asks the boundary what it declares (no source is
contacted), runs the staged pipeline live, re-runs the contradiction search and adversarial review, recomputes the
finding, and keeps:

* the human review (finding, annotation, timestamp) untouched, with a notice when the automated finding has changed
since it was recorded;
* the previous run as a compact summary (`access.previousRun`) when the new run lost a source or changed the finding,
so good evidence is never replaced by an unexplained blank result.

## 16. Running it

```sh
npm test                        # offline: guardrails, freshness, coverage, OSM adapter and matching, bundle, pipeline
npm run test:e2e                # offline UI: unverified state, restriction/conflict/gap presentation, export, mobile

# opt-in, operator/Node, no credential needed:
npm run verify:investigator:live                     # all three corridors, live sources and live Overpass
npm run verify:investigator:worker                   # the Worker boundary: DEPLOYED if INVESTIGATOR_WORKER_URL is set, otherwise the same handler served locally
npm run validate:probes                            # catalog + schema + Worker policy + capture/baseline, offline
npm run investigator:refresh                       # validate, retrieve, rewrite the capture + baseline, report changes
npm run verify:investigator:live -- --corridors=or-roads-susbauer-rd --no-osm
npm run verify:investigator:live -- --write-record    # refresh the reviewed capture the browser replays
```

The live script fetches every declared source, checks every declared phrase against the served text, queries
Overpass through the same adapter and mirrors the app uses, matches the ways, runs the real pipeline, prints the
finding, restrictions, contradictions, unresolved items, and coverage, and reports **drift** (a captured quote that
is no longer found at its source). Live results do not become fixture truth automatically: the capture is a dated,
reviewable artifact, and re-running the script re-verifies it.

### Test fixtures

| Fixture | What it is |
| --- | --- |
| `tests/fixtures/investigator/source-excerpts.json` | the declared phrases the operator run found in the served pages on 2026-09-25, with the deliberately not-found phrases listed in `absentFacts` so a no-result search stays a no-result search offline |
| `tests/fixtures/investigator/overpass-cornelius-response.json` | a real Overpass response captured on 2026-09-25 local (2026-09-26 UTC), trimmed to ten ways of NW Cornelius Pass Rd |
| `data/investigator/or-pilot-access-evidence.json` | the reviewed operator capture the browser replays, with per-source retrieval metadata |

## 17. What this deliberately does not do

* No route ranking, no "best road", no score combining access with habitat or occurrence
* No navigation or turn-by-turn directions
* No legal advice: `VERIFIED_PUBLIC` means strong current evidence supports ordinary public vehicle access, with
  its sources, dates, and qualifiers shown
* No model in the decision path: guardrails decide, and narration can only annotate
* No new infrastructure and no secret in the browser; a server-held credential (for example for live eBird) stays
  behind the reviewed Worker boundary described in `worker/README.md`
* No nationwide crawling, no bulk road-database ingestion, and no historical occurrence warehouse
