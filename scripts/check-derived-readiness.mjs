#!/usr/bin/env node
// Refuse to start the national derived build unless all four source planes are actually READY.
//
//   node scripts/check-derived-readiness.mjs                 # report every plane
//   node scripts/check-derived-readiness.mjs --record hydrography   # run a plane's verifier and record it
//
// The derived build consumes roads x NWI x hydrography x EPA. Whether those planes are ready is a machine
// question, so it is answered from their committed manifests rather than from filenames or from anyone's memory
// of what finished. Two things make the answer trustworthy:
//
//   * structural completeness is read from each manifest (cells declared, unbuilt cells, levels, units/states),
//     so a partial plane fails with the exact counts that show why; and
//   * the verifier gate is a *record*: `--record <plane>` runs that plane's verifier and writes
//     data/national/verification/<plane>.json with the command, exit code, output digest and the digest of the
//     manifest it was run against. The preflight requires a passing record whose manifest digest still matches
//     the manifest on disk, which is what makes a stale verification detectable instead of invisible.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const VERIFICATION_DIR = `${ROOT}data/national/verification`;
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const digestOf = path => sha256(readFileSync(path));

const PLANES = {
  roads: { manifest: 'data/national/road-manifest.json' },
  wetlands: { manifest: 'data/national/wetland-manifest.json' },
  hydrography: { manifest: 'data/national/hydro-manifest.json' },
  ecoregions: { manifest: 'data/national/epa-manifest.json' },
};
// The verifier command per plane. Recorded once and then reused, so a preflight run is cheap and deterministic.
const VERIFIERS = {
  roads: ['npm', ['run', 'verify:national-roads']],
  wetlands: ['npm', ['run', 'verify:national-wetlands', '--', '--require-all']],
  hydrography: ['npm', ['run', 'verify:national-hydro', '--', '--require-all', '--regional-equivalence']],
  ecoregions: ['npm', ['run', 'verify:national-ecoregions', '--', '--require-all']],
};

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index === -1 ? null : args[index + 1]; };

function record(plane) {
  const [command, commandArgs] = VERIFIERS[plane];
  mkdirSync(VERIFICATION_DIR, { recursive: true });
  let exitCode = 0;
  let output = '';
  try {
    output = execFileSync(command, commandArgs, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    exitCode = error.status ?? 1;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  const manifestPath = `${ROOT}${PLANES[plane].manifest}`;
  writeFileSync(`${VERIFICATION_DIR}/${plane}.json`, `${JSON.stringify({ plane,
    command: [command, ...commandArgs].join(' '), exitCode, manifest: PLANES[plane].manifest,
    manifestSha256: existsSync(manifestPath) ? digestOf(manifestPath) : null,
    outputSha256: sha256(Buffer.from(output)), outputTail: output.trim().split('\n').slice(-3).join('\n').slice(0, 600),
    recordedAt: new Date().toISOString() }, null, 1)}\n`);
  console.log(JSON.stringify({ recorded: plane, exitCode }));
  return exitCode;
}

// Structural completeness, read from the manifest itself.
function structural(plane) {
  const { manifest } = PLANES[plane];
  const path = `${ROOT}${manifest}`;
  if (!existsSync(path)) return { state: 'BLOCKED', reasons: [`${manifest} does not exist`] };
  const value = readJson(path);
  const reasons = [];
  if (plane === 'roads') {
    const counts = value.counts ?? {};
    if ((counts.present ?? 0) + (counts.empty ?? 0) !== counts.cells) reasons.push('road cells are not all present or empty');
    if (counts.unbuilt) reasons.push(`roads have ${counts.unbuilt} unbuilt cells`);
    if (!counts.present) reasons.push('roads declare no present cell');
  }
  if (plane === 'wetlands') {
    if (value.buildCoverage !== 'complete') reasons.push(`wetlands are ${value.buildCoverage}`);
    if (value.counts?.unbuilt) reasons.push(`wetlands have ${value.counts.unbuilt} unbuilt cells`);
    if ((value.builtStates ?? []).length !== 49) reasons.push(`wetlands declare ${(value.builtStates ?? []).length} of 49 states`);
  }
  if (plane === 'hydrography') {
    if (value.buildCoverage !== 'complete') reasons.push(`hydrography is ${value.buildCoverage}`);
    if (value.counts?.unbuilt) reasons.push(`hydrography has ${value.counts.unbuilt} unbuilt cells`);
    if ((value.builtUnits ?? []).length !== (value.conusUnits ?? 0)) {
      reasons.push(`hydrography built ${(value.builtUnits ?? []).length} of ${value.conusUnits ?? '?'} CONUS units`);
    }
  }
  if (plane === 'ecoregions') {
    if (value.buildCoverage !== 'complete') reasons.push(`ecoregions are ${value.buildCoverage}`);
    const levels = (value.levels ?? []).join(',');
    if (levels !== '3,4') reasons.push(`ecoregions declare levels ${levels || 'none'}, expected 3,4`);
    for (const [level, entry] of Object.entries(value.artifacts ?? {})) {
      if (!entry.bytes || !entry.sha256) reasons.push(`ecoregion level ${level} declares no digest`);
      if (level === '4' && (entry.featureCount ?? 0) < 500) reasons.push('ecoregion level IV looks truncated');
    }
  }
  return { state: reasons.length ? 'PARTIAL' : 'READY', reasons };
}

// A verification record only counts if it passed and still refers to the manifest on disk.
function verification(plane) {
  const path = `${VERIFICATION_DIR}/${plane}.json`;
  if (!existsSync(path)) return { ok: false, reason: `no verification record; run: --record ${plane}` };
  const entry = readJson(path);
  if (entry.exitCode !== 0) return { ok: false, reason: `the recorded verifier run failed (exit ${entry.exitCode})` };
  const manifestPath = `${ROOT}${PLANES[plane].manifest}`;
  const current = existsSync(manifestPath) ? digestOf(manifestPath) : null;
  if (entry.manifestSha256 !== current) {
    return { ok: false, reason: 'the verification record is stale: the manifest changed after it was recorded' };
  }
  return { ok: true, record: entry };
}

if (option('--record')) {
  const plane = option('--record');
  if (!PLANES[plane]) { console.error(`unknown plane ${plane}; expected ${Object.keys(PLANES).join(', ')}`); process.exit(2); }
  process.exit(record(plane));
}

const report = { planes: {}, ready: true };
for (const plane of Object.keys(PLANES)) {
  const structure = structural(plane);
  const verified = verification(plane);
  const reasons = [...(structure.reasons ?? [])];
  if (!verified.ok) reasons.push(verified.reason);
  const state = reasons.length === 0 ? 'READY' : (structure.state === 'BLOCKED' ? 'BLOCKED' : 'PARTIAL');
  report.planes[plane] = { state, reasons, verifiedAt: verified.record?.recordedAt ?? null };
  if (state !== 'READY') report.ready = false;
}
report.verificationRecords = existsSync(VERIFICATION_DIR) ? readdirSync(VERIFICATION_DIR).length : 0;
console.log(JSON.stringify(report, null, 1));
if (!report.ready) {
  console.error('\nThe national derived build must not start: not all four source planes are READY.');
  for (const [plane, entry] of Object.entries(report.planes)) {
    if (entry.state !== 'READY') console.error(`  ${plane}: ${entry.state} - ${entry.reasons.join('; ')}`);
  }
}
process.exit(report.ready ? 0 : 1);
