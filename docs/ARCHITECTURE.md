# Road Naturalist architecture

Road Naturalist finds **road corridors** worth researching for wildlife exploration. A corridor is a named candidate with a stable ID, road geometry, status, evidence trail, access finding, and unresolved questions. Future analysis divides that line into segments and evaluates buffers (for example 250 m, 500 m, 1 km) against habitat, water, terrain, protected land, and ecological regions. Tiles and partitions are storage details, not the domain object.

## Runtime boundaries

| Layer | Owns | Current state |
| --- | --- | --- |
| `src/app`, `src/state`, `src/ui` | Bootstrap, selection/decisions, DOM rendering | Working sample slice |
| `src/map` | Corridor geometry display and map interaction | Dependency-free schematic map; replaceable adapter |
| `src/domain` | Candidate, coverage, evidence contracts | Validated model and status transitions |
| `src/gis` | Dataset open, corridor spatial query, coverage, ecoregion intersection | Lazy DuckDB-WASM/Spatial provider for EPA Oregon Level III/IV |
| `src/ecology` | Ecoregion context and later ecological priors | Coverage-aware GIS-to-domain context boundary |
| `src/occurrence` | Source adapters and normalized occurrence records | Adapter contract and privacy normalization |
| `src/investigator` | Staged research, review, questions, guide assembly | Stage vocabulary and pending plan only |
| `src/services` | Manifest and later backend client | Local manifest loader |
| `data`, `scripts` | Manifests/fixtures and offline preparation | Two small EPA Oregon GeoParquet layers; synthetic corridor fixture |
| `worker` | Future Cloudflare API boundary | Documented, no deployed service |

The browser remains a static ES-module application. No runtime framework or build step is required. Source-specific records do not reach UI components. DuckDB-WASM and Spatial initialize only after corridor ecology is requested; the engine and SQL stay inside `src/gis`. AI remains outside the running app.

## Evidence and authority

Deterministic GIS/data results are authoritative for spatial relationships, dataset coverage, occurrence facts, and scores. Every future analytical result should include dataset ID/version, source URL or citation, build method, query parameters, timestamp where relevant, and the calculation used. Results distinguish `FULL`, `PARTIAL`, `NONE`, and `UNKNOWN` coverage. For the EPA pilot, `FULL` means both levels cover at least 99.5% of the requested line; `PARTIAL` means some but not all, including one resolved level when the other fails; `NONE` means a successful query found no line overlap with either Oregon layer; `UNKNOWN` means analysis could not produce a reliable conclusion. A successful query with zero features differs from a failed or absent dataset. The sample's habitat, occurrence, and access coverage remain `UNKNOWN`.

Evidence kinds include `EXPECTED` (ecological prior), `HISTORICAL`, `RECENT`, `LOCAL` (precision supports a corridor), `MODELED` (deterministic output), and `INFERRED` (analyst interpretation). These are claim classes, not interchangeable strength grades. EPA Level III/IV ecoregions will be intersected with corridor geometry and used as context/prior, never proof of a local species record. iNaturalist and eBird adapters should return normalized records with source ID, taxon, observation time, quality, precision, provenance, ecoregion, and distance only where defensible. Obscured coordinates are stripped from normalized location and cannot produce a road-distance claim.

The Investigator may discover candidates, research sources, identify contradictions, explain results, and challenge recommendations. It must cite findings and keep its proposals distinct from deterministic outputs. It cannot assign official access status, GIS facts, occurrence records, coverage, or spatial scores. Status decisions and rejected candidates should remain in a portable research trail. The current `shortlist`/`reject` controls demonstrate candidate decisions but do not imply verified suitability.

## Data plane and Cloudflare

Current path: EPA GIS → offline Python preparation in `scripts/` → versioned GeoParquet and manifest → local static files → verified browser fetch and in-session buffer reuse → lazy DuckDB-WASM + Spatial corridor queries. The same manifest URL can later point to immutable R2 objects. Data may be geographically partitioned for byte-range efficiency. Manifests should describe bytes, SHA-256, schema, source vintage, coverage, and verified-empty results. R2 CORS must allow the app origin and `Range` requests, and expose `Content-Range`/`Accept-Ranges`; validate this before release. Fruiting Forecast currently verifies full downloaded asset bytes; Road Naturalist should test actual range behavior before depending on partial reads. A bounded persistent cache is future work when datasets grow. User-owned research artifacts, if added, need an explicit retention/export policy separate from cache.

Cloudflare Pages can serve the static application at `roadnaturalist.com`. A Worker belongs in `worker/` only when required for API secrets, CORS/proxying, external-data caching, or Investigator calls. Offline ingestion is a build process, not a browser or Worker request. No D1 or account database is justified now; this is not a field-observation recorder. Keep secrets off the client and do not move deterministic corridor analysis to a Worker without a measured reason.

## Reference decisions

From **Fruiting Forecast**: keep static-first deployment, Leaflet's lesson that map is a replaceable view, DuckDB-WASM/Spatial and Parquet as a proven analytical path, immutable R2 data and digest-bearing manifests, bounded browser caches, explicit degraded/coverage states, deterministic scoring separate from optional AI, EPA ecological context, source provenance, and browser/Python testing. Its app currently concentrates UI, scoring, GIS, API clients, storage, and optional OpenRouter in `index.html` (927 dense lines); Road Naturalist keeps those as modules. Its square tiles and hunt/collecting domain are not adopted as Road Naturalist concepts. We also do not carry over its mushroom profiles, weather scoring, persistent DuckDB tables, analytics, or operational record database.

From the **Wildlife Road Cruise Investigator**: keep the sequence of geography → landscape → discovery → triage → road research → wildlife → verification → mapped geometry → ranking → QA, plus source registry, candidate rejection trail, unresolved questions, access checks, adversarial review, route guide, and portable JSON. Its `guide/routes/research` package is a useful export idea. Its current direct browser OpenRouter calls, local key, model-supplied component scores, neutral fill for missing scores, and single-file state/UI are not the authority model for Road Naturalist. Overpass-matched geometry is a useful verification technique, but partial/unresolved matches must remain explicit. The `fieldReports` placeholder in its export is not a Road Naturalist observation database.

## Next extension points

1. Add one authoritative road/corridor source and a small real pilot area. Store segment IDs and source geometry provenance.
2. Add one habitat layer in the versioned manifest, using the existing lazy GIS provider and explicit coverage contract.
3. Add deterministic corridor metrics and score traces with coverage before connecting occurrence APIs or AI.
4. Add source-specific occurrence adapters and privacy tests, then staged Investigator research and a versioned portable guide schema.

The sample corridor is synthetic. It demonstrates application wiring and makes no real-world recommendation.
