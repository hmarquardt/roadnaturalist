#!/usr/bin/env node
/**
 * Stage the static application for Cloudflare Pages direct upload.
 *
 *   npm run stage:pages
 *
 * There is no build step and no bundler: the site is exactly the files it already ships (index.html, assets/, src/,
 * data/). This script copies them into dist/, refuses to replace a dist/ it did not create, and checks the payload
 * before it can be uploaded:
 *
 *   * every local stylesheet, icon, and script referenced by index.html is staged;
 *   * every relative `import` in the src/ module graph resolves to a staged file;
 *   * every dataset url in data/manifest.json exists in the staged output.
 *
 * A missing file therefore fails here rather than as a 404 in a deployed browser. It also refuses to stage a GIS
 * dataset whose byte length disagrees with the manifest, because the manifest is what the browser verifies against.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const MARKER = 'deployment.json';
const SITE_ENTRIES = ['index.html', 'assets', 'src', 'data', 'config/pages-headers'];

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? listFiles(join(directory, entry.name))
    : [join(directory, entry.name)]);
}

function assertDistIsOurs() {
  if (!existsSync(DIST)) return;
  if (!existsSync(join(DIST, MARKER))) throw new Error(`refusing to replace ${DIST}: it has no ${MARKER} marker, so it may not be ours`);
  rmSync(DIST, { recursive: true, force: true });
}

function stage() {
  assertDistIsOurs();
  mkdirSync(DIST, { recursive: true });
  for (const entry of SITE_ENTRIES) {
    const source = join(ROOT, entry);
    if (!existsSync(source)) throw new Error(`site entry is missing: ${entry}`);
    const target = join(DIST, entry === 'config/pages-headers' ? '_headers' : entry);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: statSync(source).isDirectory() });
  }

  // A tiny 404 page: Pages serves it for unknown paths instead of a blank response.
  writeFileSync(join(DIST, '404.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found — Road Naturalist</title><h1>Not found</h1><p><a href="/">Road Naturalist</a></p></html>\n');

  const staged = new Set(listFiles(DIST).map(file => relative(DIST, file)));
  const problems = [];

  // 1. index.html references
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const value = match[1];
    if (/^(#|https?:|data:|mailto:)/.test(value)) continue;
    // A site-root path is served by Pages from the staged tree ( '/' -> index.html ).
    const path = value.startsWith('/') ? value.slice(1) : value;
    if (path === '' || path.endsWith('/') ? staged.has(`${path}index.html`) : staged.has(path)) continue;
    if (!path.startsWith('/') && staged.has(path)) continue;
    problems.push(`index.html references ${value}, which is not staged`);
  }

  // 2. the src/ module graph: every relative import must resolve inside dist/
  for (const file of [...staged].filter(name => name.startsWith('src/') && name.endsWith('.js'))) {
    const code = readFileSync(join(DIST, file), 'utf8');
    for (const match of code.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const target = relative(DIST, resolve(join(DIST, dirname(file)), specifier));
      if (!staged.has(target)) problems.push(`${file} imports ${specifier}, which is not staged (${target})`);
    }
  }

  // 3. the data manifest: every dataset must be present with the byte length the browser verifies against
  const manifest = readJson(join(DIST, 'data/manifest.json'));
  for (const dataset of manifest.datasets) {
    const path = `data/${dataset.url}`;
    if (!staged.has(path)) { problems.push(`manifest dataset ${dataset.id} points at ${path}, which is not staged`); continue; }
    const bytes = statSync(join(DIST, path)).size;
    if (bytes !== dataset.bytes) problems.push(`manifest dataset ${dataset.id} declares ${dataset.bytes} bytes but the staged file is ${bytes}`);
  }
  for (const extra of ['data/roads/or-roads-pilot.json', 'data/investigator/or-pilot-access-evidence.json']) {
    if (!staged.has(extra)) problems.push(`${extra} is loaded by the app but was not staged`);
  }

  if (problems.length) {
    // Leave nothing half-built: a dist/ without its marker would block the next attempt, and an incomplete payload
    // must never be deployable.
    rmSync(DIST, { recursive: true, force: true });
    console.error('Staging failed:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const files = [...staged].sort().map(name => { const buffer = readFileSync(join(DIST, name));
    return { path: name, bytes: buffer.length, sha256: sha256(buffer) }; });
  const commit = (() => { try { return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
  const status = (() => { try { return execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
  const info = { project: 'roadnaturalist', commit, dirty: Boolean(status), stagedAt: new Date().toISOString(), files };
  writeFileSync(join(DIST, MARKER), `${JSON.stringify(info, null, 1)}\n`);
  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  console.log(`Staged ${files.length} file(s), ${(bytes / 1024 / 1024).toFixed(2)} MiB into dist/${commit ? ` at commit ${commit.slice(0, 7)}` : ''}${status ? ' (working tree dirty)' : ''}`);
  return info;
}

stage();
export { stage };
