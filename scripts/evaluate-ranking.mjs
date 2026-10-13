#!/usr/bin/env node
// Evaluate `naturalist-interest-v1` against the display default (`wetlandArea250`) across diverse U.S. regions.
//
//   node scripts/evaluate-ranking.mjs [--radius 25] [--top 10] [--centers princeton,portland,...]
//                                     [--derived-dir <dir>] [--out <json>] [--md <md>]
//
// The run uses ONLY the published national derived corridor-metrics plane (the same rows the browser's derived
// discovery reads): it selects cells with the runtime's own `selectDerivedCells`, reads them in DuckDB, and feeds
// the rows through the SAME result builder and ranking modules the application uses (`runDiscovery` ->
// `naturalistInterest`). No raw GIS plane is read, and no occurrence or source-evidence path is touched.
//
// The analysis itself lives in `src/discovery/ranking-evaluation.js`; this script only acquires rows and prints.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectDerivedCells, validateDerivedManifest } from '../src/discovery/derived-catalog.js';
import { validateNationalDerivedCatalog } from '../src/discovery/national-catalog.js';
import { radiusBounds, requestedRadiusM } from '../src/discovery/search-area.js';
import { queryDerivedCorridors } from '../src/gis/derived-query.js';
import { runDiscovery } from '../src/discovery/run.js';
import { RANKING_VERSION } from '../src/discovery/ranking.js';
import { DEFAULT_DISTANCE_TRANSFORM, DISTANCE_TRANSFORMS, EXPLORATION_ORDER_VERSION, TRANSFORM_KEYS }
  from '../src/discovery/exploration-order.js';
import { evaluateExplorationRegion, evaluateRegion, explorationEvaluationArtifact,
  rankingEvaluationArtifact } from '../src/discovery/ranking-evaluation.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argOf = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const radiusMiles = Number(argOf('--radius') ?? 25);
const topN = Number(argOf('--top') ?? 10);
const derivedDir = argOf('--derived-dir') ?? process.env.ROADNATURALIST_DERIVED_DIR
  ?? '/Volumes/Lexar/roadnaturalist/cells/derived/corridor-metrics';

// The eight contexts the evaluation spans. Centres are fixed and recorded in the artifact, so a run is reproducible.
const ALL_CENTERS = [
  { id: 'princeton-in', name: 'Princeton, IN', center: [-87.5675, 38.3553] },
  { id: 'evansville-in', name: 'Evansville, IN', center: [-87.5347, 37.9877] },
  { id: 'nashville-tn', name: 'Nashville, TN', center: [-86.7850, 36.1718] },
  { id: 'portland-or', name: 'Portland, OR', center: [-122.6500, 45.5369] },
  { id: 'gulf-coastal', name: 'Gulf coastal wetlands (Houma, LA)', center: [-90.7195, 29.5958] },
  { id: 'southwest-dry', name: 'Arid Southwest (Phoenix, AZ)', center: [-112.0740, 33.4484] },
  { id: 'plains', name: 'Great Plains (Omaha, NE)', center: [-95.9370, 41.2565] },
  { id: 'northeast', name: 'Northeast (Boston, MA)', center: [-71.0589, 42.3601] },
];
const only = (argOf('--centers') ?? '').split(',').filter(Boolean);
const CENTERS = only.length ? ALL_CENTERS.filter(entry => only.includes(entry.id)) : ALL_CENTERS;
if (!CENTERS.length) throw new Error(`no centre matches --centers ${argOf('--centers')}`);

const outPath = argOf('--out') ?? join(ROOT, 'data/ranking/naturalist-interest-v2-evaluation.json');
const mdPath = argOf('--md') ?? join(ROOT, 'docs/RANKING-EVALUATION-V2.md');
// An earlier evaluation to diff against (the same regions, an earlier ranking version). It isolates the effect of
// one input change from a weight change, because nothing else differs between the two runs.
const comparePath = argOf('--compare') ?? null;
// The distance-aware exploration order: its own artifact, its own report, and the transform selected for it.
const orderOutPath = argOf('--order-out') ?? join(ROOT, 'data/ranking/exploration-order-v1-evaluation.json');
const orderMdPath = argOf('--order-md') ?? join(ROOT, 'docs/EXPLORATION-ORDER-EVALUATION.md');
const orderCandidates = (argOf('--candidates') ?? '').split(',').filter(Boolean);
const CANDIDATES = orderCandidates.length ? orderCandidates : TRANSFORM_KEYS;
for (const key of CANDIDATES) if (!DISTANCE_TRANSFORMS[key]) throw new Error(`unknown distance transform: ${key}`);
const SELECTED_TRANSFORM = argOf('--transform') ?? DEFAULT_DISTANCE_TRANSFORM;
if (!DISTANCE_TRANSFORMS[SELECTED_TRANSFORM]) throw new Error(`unknown --transform ${SELECTED_TRANSFORM}`);
// STATED BEFORE THE RESULTS ARE SEEN, so the choice of transform is judged against a rule rather than a preference.
const SUCCESS_CRITERIA = Object.freeze({
  portlandRimBiasReduced: 'Portland top-10 median distance falls materially from its naturalist-interest value (24.2 mi)',
  distanceImprovesMostRegions: 'the median top-10 distance falls in at least 5 of 8 regions',
  interestRetentionHigh: 'mean naturalist-interest score of the top 10 falls by no more than ~2 points in every region',
  strongRoadsSurvive: 'the naturalist-interest #1 stays inside the exploration top 10 in every region',
  noCenterHugging: 'the top 10 is not dominated by roads at the centre: its mean interest stays within the retention rule',
  nearTiesResolveTowardNearer: 'among near-tied pairs (within 1 interest point) where the nearer road scores lower, the nearer road is preferred more often than not',
  deterministic: 'the same results and radius always produce the same order',
});

// One DuckDB query, run through the project's `uv` convention (the same tool the offline verifiers use). The SQL
// is the runtime's own derived-corridor SELECT, so the rows are exactly what a browser would read.
const DUCKDB_RUNNER = `
import json, sys, duckdb
sql = sys.stdin.read()
con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")
cur = con.execute(sql)
cols = [d[0] for d in cur.description]
rows = cur.fetchall()
def default(o):
    try: return float(o)
    except Exception: return str(o)
print(json.dumps([dict(zip(cols, r)) for r in rows], default=default))
`;
function duckdbQuery(sql) {
  const output = execFileSync('uv', ['run', '--python', '3.12', '--with', 'duckdb', 'python3', '-c', DUCKDB_RUNNER],
    { input: sql, encoding: 'utf8', maxBuffer: 1 << 30, timeout: 900000 });
  return JSON.parse(output.trim().split('\n').at(-1));
}

// The published national derived plane, resolved from the committed catalog and read from the local build volume.
const catalog = validateNationalDerivedCatalog(JSON.parse(readFileSync(join(ROOT, 'data/national/derived-catalog.json'), 'utf8')));
const planeDir = join(derivedDir, catalog.derived.analysisFingerprint);
const manifestPath = join(planeDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  throw new Error(`the national derived plane is not on this machine: ${manifestPath}\n`
    + `pass --derived-dir <dir> or set ROADNATURALIST_DERIVED_DIR (the plane is a build artifact, not committed)`);
}
const manifest = validateDerivedManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
if (manifest.analysisFingerprint !== catalog.derived.analysisFingerprint) {
  throw new Error(`the local derived plane is ${manifest.analysisFingerprint}, the catalog pins ${catalog.derived.analysisFingerprint}`);
}
const cellPath = id => join(planeDir, 'cells', `${id}.parquet`);

// One DuckDB "engine", so the runtime's own `queryDerivedCorridors` builds the SQL and the runtime's own result
// builders consume the rows - the only substitution is where the bytes come from (a local file, not a fetch).
const engine = { conn: { query: sql => ({ toArray: () => duckdbQuery(sql) }) } };

function gisFor(selection) {
  const files = selection.present.map(cell => cellPath(cell.id));
  const scope = {
    derived: true, selection, fingerprint: manifest.analysisFingerprint,
    manifest: { cells: manifest.cells.length, present: selection.counts.present, empty: selection.counts.empty,
      counts: manifest.counts ?? null, region: manifest.region, semantics: manifest.semantics ?? null },
    timing: Object.freeze({ registeredCells: files.length }),
    provenance: Object.freeze({ source: 'Precomputed national derived corridor metrics',
      analysisFingerprint: manifest.analysisFingerprint, regionVersion: catalog.version,
      derivedSchemaVersion: manifest.derivedSchemaVersion,
      method: 'Deterministic discovery metrics computed offline from the published regional partitions',
      note: 'The evaluation reads the derived plane only; promotion and raw planes are out of scope.' }),
    async queryDerivedCorridors() { return queryDerivedCorridors(engine, files); },
  };
  return { async prepareDerivedSearch() { return scope; } };
}

const regions = [];
const samples = [];
for (const entry of CENTERS) {
  const bounds = radiusBounds(entry.center, radiusMiles);
  const selection = selectDerivedCells(manifest, bounds);
  const searchArea = { id: entry.id, name: entry.name, kind: 'radius', center: entry.center, radiusMiles,
    catalogUrl: catalog.derived.manifestUrl, catalogType: 'national' };
  const started = Date.now();
  const run = await runDiscovery({ gis: gisFor(selection), searchArea });
  const region = evaluateRegion({ id: entry.id, name: entry.name, center: entry.center, radiusMiles,
    results: run.results, topN });
  regions.push(region);
  // The exploration evaluation needs the results themselves and the radius the run actually used, so the same rows
  // feed both evaluations rather than a second read.
  samples.push({ id: entry.id, name: entry.name, center: entry.center, radiusMiles,
    radiusM: requestedRadiusM(run.searchArea) ?? radiusMiles * 1609.344, results: run.results });
  const summary = [region.id.padEnd(15), `${region.searched}`.padStart(6), 'corridors',
    `${region.comparison.overlap}/${topN}`.padStart(6), 'overlap',
    `top score ${region.comparison.interest[0]?.interestScore ?? 'n/a'}`].join('  ');
  console.log(`${summary}  (${Date.now() - started} ms)`);
}

const previous = comparePath ? JSON.parse(readFileSync(resolve(ROOT, comparePath), 'utf8')) : null;
const artifact = rankingEvaluationArtifact({ regions, radiusMiles, topN, generatedAt: new Date().toISOString(),
  previous,
  derivedPlane: { fingerprint: manifest.analysisFingerprint, catalogVersion: catalog.version,
    cells: manifest.cells.length, presentCells: manifest.counts?.presentCells ?? null } });

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(artifact, null, 1)}\n`);
writeFileSync(mdPath, renderMarkdown(artifact));
console.log(`\nranking: ${RANKING_VERSION}   baseline: ${artifact.baselineKey}   radius: ${radiusMiles} mi   top: ${topN}`);
console.log(`mean overlap ${artifact.summary.meanOverlap}/${topN}   (min ${artifact.summary.minOverlap}, max ${artifact.summary.maxOverlap})`);
console.log(`artifact: ${outPath}`);
console.log(`summary:  ${mdPath}`);

// ---------------------------------------------------------------- the distance-aware exploration order
// The same eight regions and the same rows, ordered a second way: naturalist interest adjusted by distance from the
// search centre. Every candidate transform is measured on every region, so the choice is made from numbers.
const explorationRegions = samples.map(sample => evaluateExplorationRegion({ ...sample, topN,
  candidates: CANDIDATES, selectedCandidate: SELECTED_TRANSFORM }));
const explorationArtifact = explorationEvaluationArtifact({ regions: explorationRegions, radiusMiles, topN,
  candidates: CANDIDATES, selectedCandidate: SELECTED_TRANSFORM, generatedAt: new Date().toISOString(),
  successCriteria: SUCCESS_CRITERIA, baselineKey: artifact.baselineKey, derivedPlane: artifact.derivedPlane });
mkdirSync(dirname(orderOutPath), { recursive: true });
writeFileSync(orderOutPath, `${JSON.stringify(explorationArtifact, null, 1)}\n`);
writeFileSync(orderMdPath, renderOrderMarkdown(explorationArtifact, artifact));
console.log('');
console.log(`exploration order ${EXPLORATION_ORDER_VERSION}  interest ${RANKING_VERSION}  selected ${SELECTED_TRANSFORM}`);
for (const key of CANDIDATES) {
  const candidate = explorationArtifact.summary.byCandidate[key];
  console.log(`  ${key.padEnd(10)} overlap ${candidate.meanOverlap}/${topN}  median dist ${candidate.meanMedianDistanceBefore}`
    + ` -> ${candidate.meanMedianDistanceAfter} mi  interest ${candidate.meanInterestDelta} (worst ${candidate.worstInterestDelta})`
    + `  top-1 kept ${candidate.topInterestRetainedInTop10}/${candidate.regions}  near-tie ${candidate.nearTieShare}`);
}
console.log(`artifact: ${orderOutPath}`);
console.log(`summary:  ${orderMdPath}`);


// The human-readable half. Every number comes from the same artifact, so the two never disagree.
function renderMarkdown(artifact) {
  const rowsTable = rows => ['| # | road | id | score | evid | wet | water | variety | dist mi |', '|---|---|---|---|---|---|---|---|---|']
    .concat(rows.map(row => `| ${row.rank} | ${row.name ?? ''} | ${row.corridorId} | ${row.interestScore ?? 'n/a'} | `
      + `${row.evidenceFraction} | ${row.components.wetland ?? 'n/a'} | ${row.components.water ?? 'n/a'} | `
      + `${row.components.ecologicalVariety ?? 'n/a'} | ${row.distanceFromCenterMi ?? 'n/a'} |`));
  const shortId = id => String(id).replace(/^drv1-/, '');
  const lines = [];
  lines.push(`# Ranking evaluation: \`${artifact.rankingVersion}\` vs \`${artifact.baselineKey}\``);
  lines.push('');
  lines.push(`Generated ${artifact.generatedAt}. Derived plane \`${artifact.derivedPlane?.fingerprint ?? 'n/a'}\` `
    + `(catalog ${artifact.derivedPlane?.catalogVersion ?? 'n/a'}), radius ${artifact.radiusMiles} mi, top ${artifact.topN}.`);
  lines.push('');
  lines.push('Every number is produced by the application\'s own result builder and ranking modules over the published '
    + 'national derived plane; no raw GIS plane and no source-evidence step is involved. The tables are generated by '
    + '`scripts/evaluate-ranking.mjs`, and the machine-readable form of this document sits beside it in '
    + '`data/ranking/`.');
  lines.push('');
  lines.push('## Cross-region summary');
  lines.push('');
  lines.push('| region | corridors | overlap with default | median dist (mi) | default median dist (mi) |');
  lines.push('|---|---|---|---|---|');
  for (const region of artifact.regions) {
    const o = region.observations;
    lines.push(`| ${region.name} | ${region.searched} | ${region.comparison.overlap}/${artifact.topN} | `
      + `${o.distance.interestMedianMi ?? 'n/a'} | ${o.distance.baselineMedianMi ?? 'n/a'} |`);
  }
  lines.push('');
  lines.push(`Mean overlap across regions: **${artifact.summary.meanOverlap}/${artifact.topN}** `
    + `(min ${artifact.summary.minOverlap}, max ${artifact.summary.maxOverlap}).`);
  lines.push('');
  lines.push(`Findings: mean top wetland-component saturation **${artifact.summary.meanTopWetlandSaturation}**; `
    + `regions where the ecological-variety component is CONSTANT `
    + `**${artifact.summary.regionsWithConstantVariety}/${artifact.summary.regionCount}**; `
    + `zero-overlap regions: ${artifact.summary.regionsWithZeroOverlap.length ? artifact.summary.regionsWithZeroOverlap.join(', ') : 'none'}.`);
  lines.push('');
  const vs = artifact.comparisonToPrevious;
  if (vs) {
    lines.push(`## Vs \`${vs.previousVersion}\``);
    lines.push('');
    lines.push(`Mean top-${vs.topN} overlap against the previous evaluation: **${vs.meanOverlap}/${vs.topN}**. `
      + 'Only the ecology input differs between the two runs, so a road that entered or left a top did so because its '
      + 'ecological context is now measured rather than because a weight moved.');
    lines.push('');
    lines.push('| region | overlap | ecology distinct values (was → now) | transitions max (was → now) |');
    lines.push('|---|---|---|---|');
    for (const region of vs.regions) {
      lines.push(`| ${region.id} | ${region.overlap}/${vs.topN} | ${region.previousEcologyDistinct} → ${region.currentEcologyDistinct} `
        + `| ${region.previousTransitionsMax} → ${region.currentTransitionsMax} |`);
    }
    lines.push('');
    for (const region of vs.regions) {
      if (!region.entered.length && !region.exited.length) continue;
      lines.push(`- **${region.id}** entered: ${region.entered.length ? region.entered.join(', ') : 'nothing'}; `
        + `exited: ${region.exited.length ? region.exited.join(', ') : 'nothing'}`);
    }
    lines.push('');
  }
  for (const region of artifact.regions) {
    lines.push(`## ${region.name}`);
    lines.push('');
    lines.push(`Center \`[${region.center.join(', ')}]\`, radius ${region.radiusMiles} mi, ${region.searched} corridors.`);
    lines.push('');
    lines.push(`### Top ${artifact.topN} under \`naturalist-interest-v1\``);
    lines.push('');
    lines.push(...rowsTable(region.comparison.interest));
    lines.push('');
    lines.push('### Promoted by the heuristic (not in the measured-baseline top)');
    lines.push('');
    lines.push(region.comparison.promoted.length
      ? region.comparison.promoted.map(row => `- ${row.name} (${shortId(row.corridorId)}) score ${row.interestScore}, `
        + `wet ${row.components.wetland} water ${row.components.water} variety ${row.components.ecologicalVariety}`).join('\n')
      : '_none_');
    lines.push('');
    lines.push('### Demoted by the heuristic (in the measured-baseline top, out of the heuristic top)');
    lines.push('');
    lines.push(region.comparison.demoted.length
      ? region.comparison.demoted.map(row => `- ${row.name} (${shortId(row.corridorId)}) wet-250 ${row.wetlandArea250M2} m², `
        + `score ${row.interestScore}`).join('\n')
      : '_none_');
    lines.push('');
    const o = region.observations;
    lines.push('### Observations');
    lines.push('');
    lines.push(`- wetland domination: overlap ${o.wetlandDomination.overlapWithBaseline}, `
      + `median wetland component ${o.wetlandDomination.topWetlandComponentMedian}, `
      + `saturated (≥80) share ${o.wetlandDomination.shareWetlandSaturated}`);
    lines.push(`- hydrography: median crossings ${o.hydroDomination.crossingMedianTop} `
      + `(baseline ${o.hydroDomination.crossingMedianBaseline}), water-only roads ${o.hydroDomination.waterDominated.length}`);
    lines.push(`- ecology: multiple-ecoregion share ${o.ecology.shareMultipleEcoregions}, `
      + `transitions share ${o.ecology.shareWithTransitions}, variety-only roads ${o.ecology.varietyDominant.length}, `
      + `variety distinct values ${o.ecology.varietyDistinctValues}${o.ecology.varietyConstant ? ' (CONSTANT)' : ''}, `
      + `transitions max ${o.ecology.transitionsMax}`);
    lines.push(`- dry region: wetland scarce ${o.dryRegion.wetlandScarce}, distinct top scores ${o.dryRegion.distinctTopScores}, `
      + `top spread ${o.dryRegion.topSpread} (baseline ${o.dryRegion.baselineTopSpread})`);
    lines.push(`- missing data: partial-evidence results ${o.missingData.resultsWithPartialEvidence} `
      + `(${o.missingData.shareOfResults}), in top ${o.missingData.topWithPartialEvidence.length}`);
    lines.push(`- distance: v1 median ${o.distance.interestMedianMi} mi (max ${o.distance.interestMaxMi}), `
      + `baseline median ${o.distance.baselineMedianMi} mi (max ${o.distance.baselineMaxMi})`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}


// The exploration-order report. It never restates the interest numbers: both come from the same artifacts.
function renderOrderMarkdown(order, interest) {
  const lines = [];
  lines.push(`# Exploration order: \`${order.orderVersion}\` over \`${order.interestVersion}\``);
  lines.push('');
  lines.push(`Generated ${order.generatedAt}. Derived plane \`${order.derivedPlane?.fingerprint ?? 'n/a'}\`, `
    + `radius ${order.radiusMiles} mi, top ${order.topN}, near-tie interval ${order.nearTieInterval} interest point.`);
  lines.push('');
  lines.push('**Two different numbers.** `naturalistInterest` scores the mapped environmental context around a '
    + 'corridor and does not change with the search centre. `explorationOrder` is that score minus a bounded '
    + 'distance penalty, normalized by the radius the search asked for, so the list leads with roads it is '
    + 'practical to consider first. The interest score is never relabelled as the order, and the order never '
    + 'changes it.');
  lines.push('');
  lines.push('## Success criteria, stated before the results');
  lines.push('');
  for (const [key, text] of Object.entries(order.successCriteria ?? {})) lines.push(`- **${key}** — ${text}`);
  lines.push('');
  lines.push('## The candidate transforms, measured on the same eight regions');
  lines.push('');
  lines.push('| transform | cap | mean overlap with interest top | mean median distance before → after (mi) | regions closer | mean interest delta | worst interest delta | interest #1 kept in top 10 | near-tie resolved toward nearer |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const candidate of order.candidates) {
    const c = order.summary.byCandidate[candidate.key];
    lines.push(`| ${candidate.key}${candidate.key === order.selectedCandidate ? ' **(selected)**' : ''} | ${candidate.cap} `
      + `| ${c.meanOverlap}/${order.topN} | ${c.meanMedianDistanceBefore} → ${c.meanMedianDistanceAfter} `
      + `| ${c.regionsDistanceReduced}/${c.regions} | ${c.meanInterestDelta} | ${c.worstInterestDelta} `
      + `| ${c.topInterestRetainedInTop10}/${c.regions} | ${c.nearTieShare} (${c.nearTiePairs} pairs) |`);
  }
  lines.push('');
  lines.push(`Selected: **${order.selectedCandidate}**. Interest baseline for comparison:`);
  lines.push('');
  lines.push('| region | searched | overlap with default | median dist, interest top (mi) |');
  lines.push('|---|---|---|---|');
  for (const region of interest.regions) {
    lines.push(`| ${region.name} | ${region.searched} | ${region.comparison.overlap}/${order.topN} `
      + `| ${region.observations.distance.interestMedianMi} |`);
  }
  lines.push('## Regions under the selected transform');
  lines.push('');
  for (const region of order.regions) {
    const candidate = region.candidates[order.selectedCandidate];
    const m = candidate.metrics;
    lines.push(`### ${region.name}`);
    lines.push('');
    lines.push(`Center \`[${region.center.join(', ')}]\`, radius ${region.radiusMiles} mi, ${region.searched} corridors. `
      + `Overlap with the interest top: **${candidate.overlap}/${order.topN}**.`);
    lines.push('');
    lines.push(`Distance: median ${m.distanceFrom.median} → **${m.distanceAfter.median}** mi, mean ${m.distanceFrom.mean} → `
      + `**${m.distanceAfter.mean}**, p90 ${m.distanceFrom.p90} → **${m.distanceAfter.p90}**, max ${m.distanceFrom.max} → `
      + `**${m.distanceAfter.max}**. Interest: top-10 mean ${m.interestTopMean} → **${m.orderTopMean}** `
      + `(delta ${m.interestDelta}, retained ${Math.round((m.interestRetainedRatio ?? 0) * 100)}%). `
      + `Interest #1 kept in top 3/5/10: ${m.topInterestRetained.inTop3}/${m.topInterestRetained.inTop5}/${m.topInterestRetained.inTop10}. `
      + `Near-tie pairs ${m.nearTie.tension}, resolved toward the nearer road ${m.nearTie.resolvedTowardNearer} `
      + `(share ${m.nearTie.share}).`);
    lines.push('');
    lines.push('| # | road | interest | exploration | dist mi | fraction of radius | penalty |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const row of region.selected.order) {
      lines.push(`| ${row.rank} | ${row.name ?? ''} | ${row.interestScore ?? 'n/a'} | ${row.explorationScore ?? 'n/a'} `
        + `| ${row.distanceFromCenterMi ?? 'n/a'} | ${row.distanceFraction ?? 'n/a'} | ${row.distancePenalty ?? 'n/a'} |`);
    }
    lines.push('');
    lines.push(`Entered the top: ${candidate.promoted.length ? candidate.promoted.join(', ') : 'nothing'}`);
    lines.push('');
    lines.push(`Left the top: ${candidate.demoted.length ? candidate.demoted.join(', ') : 'nothing'}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

