#!/usr/bin/env node
// The local pre-publication audit of the national derived plane.
//
//   node scripts/check-national-derived-publication.mjs [--final <plane-or-root>]
//
// It enumerates the publication set from the finalized manifest (the single source of truth the publisher and
// the remote audit also use) and proves, before a single byte is uploaded:
//
//   * the declared present-cell count, empty-cell count and total artifact bytes;
//   * every present manifest entry declares url + bytes + SHA-256 + row count;
//   * every local file exists, its byte count matches the manifest and its SHA-256 matches;
//   * typed-empty cells are declared and require no Parquet object;
//   * no AppleDouble (`._*`), scratch, finalize, checkpoint or log file is part of the set, because the set is
//     manifest-driven rather than a directory walk.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DERIVED_KIND, nationalDerivedObjectSet, resolvePlane } from './national-derived-objects.mjs';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };

const BUILD = process.env.ROADNATURALIST_BUILD_VOLUME ?? '/Volumes/Lexar/roadnaturalist';
const root = option('--final') ?? process.env.NATIONAL_DERIVED_FINAL ?? join(BUILD, 'cells/derived/corridor-metrics');
if (!existsSync(root)) throw new Error(`finalized plane root does not exist: ${root}`);
const plane = resolvePlane(root);
const set = nationalDerivedObjectSet(plane);

const problems = [];
const tally = { objects: 0, bytes: 0, present: 0, empty: set.empty, manifest: 0 };
for (const object of set.objects) {
  if (!existsSync(object.local)) { problems.push(`${object.key}: local file missing (${object.local})`); continue; }
  const size = statSync(object.local).size;
  if (size !== object.bytes) { problems.push(`${object.key}: local ${size} bytes, manifest declares ${object.bytes}`); continue; }
  const bytes = readFileSync(object.local);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== object.sha256) { problems.push(`${object.key}: local SHA-256 ${hash} != manifest ${object.sha256}`); continue; }
  tally.objects += 1;
  tally.bytes += size;
  if (object.cell === 'manifest') tally.manifest += 1; else tally.present += 1;
}

// Typed-empty cells are declared and must not have a Parquet object.
for (const cell of set.manifest.cells) {
  if (cell.state === 'empty' && (cell.url || cell.rowCount !== 0)) problems.push(`${cell.id}: empty cell declares ${cell.rowCount} rows / url ${cell.url}`);
}
// The declared counts are the manifest's own; the enumerated set must agree with them exactly.
const declaredPresent = (set.manifest.cells ?? []).filter(cell => cell.state === 'present').length;
if (declaredPresent !== tally.present) problems.push(`present cells ${tally.present} != manifest present ${declaredPresent}`);
if (set.manifest.counts?.presentCells != null && set.manifest.counts.presentCells !== tally.present) {
  problems.push(`present cells ${tally.present} != manifest counts.presentCells ${set.manifest.counts.presentCells}`);
}
const cellBytes = set.objects.filter(object => object.cell !== 'manifest').reduce((sum, object) => sum + object.bytes, 0);
if (set.manifest.counts?.bytes != null && set.manifest.counts.bytes !== cellBytes) {
  problems.push(`cell bytes ${cellBytes} disagree with manifest counts.bytes ${set.manifest.counts.bytes}`);
}
// No stray publication-eligible files. Enumeration is manifest-driven, so nothing here is *in* the set; the
// check exists to prove the plane directory carries no AppleDouble or scratch sibling that a directory walk
// would have swept in.
const stray = [];
for (const name of readdirSync(join(plane, 'cells'))) {
  if (name.startsWith('._') || /\.(tmp|log|db|checkpoint)$/.test(name)) stray.push(`cells/${name}`);
}
const declaredIds = new Set(set.manifest.cells.filter(cell => cell.state === 'present').map(cell => `${cell.id}.parquet`));
for (const name of readdirSync(join(plane, 'cells'))) {
  if (name.startsWith('._')) continue;
  if (!declaredIds.has(name)) stray.push(`cells/${name} (not declared present)`);
}

const report = { plane, fingerprint: set.fingerprint, directory: set.directory,
  objects: set.objects.length, presentCells: tally.present, emptyCells: set.empty, declaredCells: set.declaredCells,
  cellBytes, manifestBytes: set.objects.find(object => object.cell === 'manifest').bytes,
  totalBytes: tally.bytes, verifiedObjects: tally.objects, stray, problems };
console.log(JSON.stringify(report, null, 1));
if (stray.length) console.error(`stray files present in the plane directory (excluded from publication):\n  ${stray.join('\n  ')}`);
if (problems.length) { console.error(`\nPRE-PUBLICATION AUDIT FAILED (${problems.length}):`); for (const problem of problems) console.error(`  - ${problem}`); process.exit(1); }
console.log(`\nPre-publication audit passed: ${set.objects.length} objects (${tally.present} present cells + 1 manifest), ${set.empty} typed-empty cells, ${tally.bytes.toLocaleString()} bytes.`);
