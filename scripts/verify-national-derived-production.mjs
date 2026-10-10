#!/usr/bin/env node
// End-to-end verification of national discovery against the *published* R2 plane, in Node + DuckDB.
//
//   node scripts/verify-national-derived-production.mjs [--radius 25] [--report <path>]
//
// This is the production-facing check that does not need a browser: it resolves the committed national catalog,
// fetches the national derived manifest from the data origin and proves its digest, selects cells with the
// runtime's own `selectDerivedCells`, fetches exactly those cells from R2, proves every byte count and SHA-256,
// and finally loads them in DuckDB and runs the same shape of query the browser runs - counting corridors and
// checking that the ecology, wetland and hydrography columns are populated for geographically distinct centres.
//
// It is deliberately independent of the repository's local build volume: everything it reads comes from
// `https://data.roadnaturalist.com/`, the same objects a production browser reads.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateDerivedManifest } from '../src/discovery/derived-catalog.js';
import { selectDerivedCells } from '../src/discovery/derived-catalog.js';
import { validateNationalDerivedCatalog } from '../src/discovery/national-catalog.js';
import { radiusBounds } from '../src/discovery/search-area.js';
import { assertNationalDerivedCompatibility } from '../src/gis/service.js';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const radiusMiles = Number(option('--radius') ?? 25);
const BUILD = process.env.ROADNATURALIST_BUILD_VOLUME ?? '/Volumes/Lexar/roadnaturalist';
const work = option('--work') ?? join(BUILD, 'work/derived-national-publication/verify');
mkdirSync(work, { recursive: true });
const reportPath = option('--report') ?? join(BUILD, 'work/derived-national-publication/production-verification.json');

const catalog = validateNationalDerivedCatalog(JSON.parse(readFileSync(new URL('../data/national/derived-catalog.json', import.meta.url))));
const base = catalog.assetBaseUrl;

// Six geographically distinct centres, one per region the release must serve.
const CENTERS = [
  { id: 'pnw', name: 'Pacific Northwest', center: [-122.92, 45.595] },
  { id: 'northeast', name: 'Northeast', center: [-71.06, 42.36] },
  { id: 'gulf', name: 'Gulf / Southeast', center: [-90.07, 29.95] },
  { id: 'midwest', name: 'Midwest / Great Lakes', center: [-87.63, 41.88] },
  { id: 'plains', name: 'Great Plains', center: [-96.68, 40.81] },
  { id: 'southwest', name: 'Arid Southwest', center: [-112.07, 33.45] },
];

async function fetchVerified(url, bytes, sha256) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length !== bytes) throw new Error(`${url}: ${body.length} bytes, expected ${bytes}`);
  if (sha256 && createHash('sha256').update(body).digest('hex') !== sha256) throw new Error(`${url}: SHA-256 mismatch`);
  return body;
}

// 1. The manifest, exactly as the browser fetches and gates it.
const manifestStarted = Date.now();
const manifestBytes = await fetchVerified(new URL(catalog.derived.manifestUrl, base).href,
  catalog.derived.manifestBytes, catalog.derived.manifestSha256);
const manifest = validateDerivedManifest(JSON.parse(manifestBytes.toString('utf8')));
assertNationalDerivedCompatibility(manifest, catalog);
const manifestMs = Date.now() - manifestStarted;
console.log(`manifest: ${manifestBytes.length.toLocaleString()} bytes in ${manifestMs} ms, fingerprint ${manifest.analysisFingerprint}`);

// 2. Select and fetch exactly the cells each centre needs, through the runtime's own selection code.
const cases = [];
const fetched = new Map();
for (const entry of CENTERS) {
  const bounds = radiusBounds(entry.center, radiusMiles);
  const selection = selectDerivedCells(manifest, bounds);
  const caseDir = join(work, entry.id);
  rmSync(caseDir, { recursive: true, force: true });
  mkdirSync(caseDir, { recursive: true });
  const files = [];
  const fetchStarted = Date.now();
  for (const cell of selection.present) {
    const url = new URL(cell.url, base).href;
    if (!fetched.has(url)) fetched.set(url, await fetchVerified(url, cell.bytes, cell.sha256));
    const path = join(caseDir, `${cell.id}.parquet`);
    writeFileSync(path, fetched.get(url));
    files.push(path);
  }
  cases.push({ id: entry.id, name: entry.name, center: entry.center, bounds, coverage: selection.coverage,
    cellsSelected: selection.counts.cells, cellsPresent: selection.counts.present, cellsEmpty: selection.counts.empty,
    declaredBytes: selection.bytes, fetchedBytes: files.reduce((sum, path) => sum + readFileSync(path).length, 0),
    files, fetchMs: Date.now() - fetchStarted,
    selectionCells: selection.present.map(cell => ({ id: cell.id, bytes: cell.bytes, rowCount: cell.rowCount })) });
  console.log(`${entry.id}: ${selection.coverage} - ${selection.counts.present}/${selection.counts.cells} cells, `
    + `${(selection.bytes / 1048576).toFixed(2)} MB, fetched in ${cases.at(-1).fetchMs} ms`);
}

// 3. DuckDB reads the same objects with the same query shape the browser's derived reader uses.
const specPath = join(work, 'cases.json');
writeFileSync(specPath, JSON.stringify({ cases: cases.map(entry => ({ id: entry.id, files: entry.files })) }));
const PYTHON = String.raw`
import json, sys, duckdb
spec = json.load(open(sys.argv[1]))
con = duckdb.connect()
out = {}
for case in spec["cases"]:
    files = case["files"]
    if not files:
        out[case["id"]] = {"corridors": 0, "files": 0}
        continue
    rel = "read_parquet([" + ", ".join("'" + path + "'" for path in files) + "])"
    corridors = con.execute("SELECT count(*) FROM (SELECT corridor_id, row_number() OVER (PARTITION BY corridor_id) rn FROM " + rel + ") WHERE rn = 1").fetchone()[0]
    row = con.execute("""SELECT count(*) FILTER (WHERE wetland_area_250_m2 IS NOT NULL),
        count(*) FILTER (WHERE primary_l3_name IS NOT NULL),
        count(*) FILTER (WHERE hydro_crossing_count IS NOT NULL),
        count(*) FILTER (WHERE wetland_type_summary IS NOT NULL),
        count(*) FILTER (WHERE hydro_summary IS NOT NULL),
        count(*) FILTER (WHERE geometry IS NOT NULL),
        round(median(length_m),1)
      FROM """ + rel).fetchone()
    out[case["id"]] = {"files": len(files), "corridors": corridors, "wetlandNonNull": row[0], "ecologyNonNull": row[1],
        "hydroNonNull": row[2], "wetlandTypes": row[3], "hydroNames": row[4], "geometryNonNull": row[5], "medianLengthM": row[6]}
print(json.dumps(out))
`;
const queryStarted = Date.now();
const queryOutput = execFileSync('uv', ['run', '--python', '3.12', '--with', 'duckdb', 'python3', '-c', PYTHON, specPath],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
const queryMs = Date.now() - queryStarted;
const duckdb = JSON.parse(queryOutput.trim().split('\n').at(-1));

const failures = [];
for (const entry of cases) {
  const result = duckdb[entry.id] ?? {};
  entry.duckdb = result;
  entry.duckdbMs = queryMs;
  if (!result.corridors) failures.push(`${entry.id}: DuckDB returned no corridors`);
  if (!result.geometryNonNull) failures.push(`${entry.id}: no readable geometry`);
  if (!result.ecologyNonNull) failures.push(`${entry.id}: no populated ecology field`);
  if (!result.wetlandNonNull && !result.hydroNonNull) failures.push(`${entry.id}: neither wetland nor hydro metrics are populated`);
}
const report = { kind: 'national-derived-production-verification', manifestUrl: catalog.derived.manifestUrl,
  manifestBytes: manifestBytes.length, manifestMs, fingerprint: manifest.analysisFingerprint, radiusMiles,
  distinctCellsFetched: fetched.size, cases, duckdbMs: queryMs, failures, verifiedAt: new Date().toISOString() };
writeFileSync(reportPath, `${JSON.stringify(report, null, 1)}\n`);
console.log(`\nDuckDB (${queryMs} ms) over ${fetched.size} distinct cells:`);
for (const entry of cases) {
  console.log(`  ${entry.id.padEnd(10)} ${entry.coverage.padEnd(7)} corridors=${entry.duckdb?.corridors} `
    + `ecology=${entry.duckdb?.ecologyNonNull} wetland=${entry.duckdb?.wetlandNonNull} hydro=${entry.duckdb?.hydroNonNull} `
    + `geometry=${entry.duckdb?.geometryNonNull} medianLen=${entry.duckdb?.medianLengthM}`);
}
console.log(`report: ${reportPath}`);
if (failures.length) { console.error(`\nPRODUCTION VERIFICATION FAILED:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('\nPRODUCTION VERIFICATION PASSED: the published national derived plane serves all six regions from R2.');

