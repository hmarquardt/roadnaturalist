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
import { radiusBounds } from '../src/discovery/search-area.js';
import { queryDerivedCorridors } from '../src/gis/derived-query.js';
import { runDiscovery } from '../src/discovery/run.js';
import { RANKING_VERSION } from '../src/discovery/ranking.js';
import { evaluateRegion, rankingEvaluationArtifact } from '../src/discovery/ranking-evaluation.js';

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

