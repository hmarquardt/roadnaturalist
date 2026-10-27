#!/usr/bin/env node
/**
 * Verify that a Pages origin serves exactly the payload staged in dist/.
 *
 *   npm run verify:pages:release                                  # production, https://roadnaturalist.com
 *   node scripts/verify-pages-release.mjs --origin https://roadnaturalist.pages.dev
 *   node scripts/verify-pages-release.mjs --staged                # offline: the staged payload only
 *   node scripts/verify-pages-release.mjs --attempts 24 --interval 5
 *
 * It is the settle gate for a release, not a smoke test. A status other than 200, a content type other than the
 * one the site declares, one byte that differs from the staged file, a crawler file that points at another
 * hostname, a JSON-LD block that does not parse, or a staged payload whose digests disagree with deployment.json
 * all fail. Pages keeps serving the previous deployment for a short window after a release, so the crawl targets
 * are polled until they match this build rather than sampled once - a verification run inside that window would
 * otherwise describe the previous release.
 *
 * The same three files are checked by `scripts/stage-pages.mjs` before anything can upload, and offline by
 * `tests/seo.test.js`. This script is the only one of the three that talks to the network.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CRAWLER_FILES, validatePreviewNoindex, validateSeo } from './seo.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const MARKER = 'deployment.json';
// The three crawl targets: the page, and the two files a crawler reads beside it.
const TARGETS = [
  { path: '/', file: 'index.html', type: /^text\/html$/i },
  { path: '/robots.txt', file: 'robots.txt', type: /^text\/plain$/i },
  { path: '/sitemap.xml', file: 'sitemap.xml', type: /^(?:application|text)\/xml$/i },
];
// Application files the payload must also have settled, so "the page is new" cannot be true while the modules or
// the discovery pointer beside it are still the previous release.
const SAME_ORIGIN_FILES = ['src/app/main.js', 'data/manifest.json', 'data/national/derived-catalog.json',
  'data/discovery/search-areas.json', 'data/places/national-places.json'];

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const delay = ms => new Promise(resolve_ => setTimeout(resolve_, ms));

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function stagedText(name) {
  return existsSync(join(DIST, name)) ? readFileSync(join(DIST, name), 'utf8') : '';
}

// The staged payload must be internally consistent before the network is consulted: every file the marker lists
// is present with its recorded digest, the payload is a clean commit, and the crawler contract holds locally.
function inspectStaged() {
  const problems = [];
  if (!existsSync(join(DIST, MARKER))) return { marker: null, problems: ['dist/deployment.json is missing: run npm run stage:pages first'] };
  const marker = JSON.parse(readFileSync(join(DIST, MARKER), 'utf8'));
  if (marker.project !== 'roadnaturalist') problems.push(`the staged payload belongs to project ${marker.project}`);
  if (marker.dirty) problems.push('the staged payload records a dirty working tree: stage and deploy a reviewed commit');
  let head = null;
  try { head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { head = null; }
  if (head && marker.commit !== head) {
    problems.push(`the staged payload is at commit ${String(marker.commit).slice(0, 7)}, HEAD is ${head.slice(0, 7)}`);
  }
  for (const entry of marker.files ?? []) {
    const path = join(DIST, entry.path);
    if (!existsSync(path)) { problems.push(`${entry.path} is recorded in deployment.json but missing from dist/`); continue; }
    const buffer = readFileSync(path);
    if (buffer.length !== entry.bytes || sha256(buffer) !== entry.sha256) problems.push(`${entry.path} does not match its staged digest`);
  }
  for (const name of CRAWLER_FILES) {
    if (!(marker.files ?? []).some(file => file.path === name)) problems.push(`${name} is not in the staged payload`);
  }
  problems.push(...validateSeo({ html: stagedText('index.html'), robots: stagedText('robots.txt'), sitemap: stagedText('sitemap.xml') }));
  problems.push(...validatePreviewNoindex(stagedText('_headers')));
  return { marker, problems };
}

async function request(url) {
  const separator = url.includes('?') ? '&' : '?';
  const response = await fetch(`${url}${separator}rn-verify=${Date.now().toString(36)}`,
    { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }, signal: AbortSignal.timeout(30000) });
  return { status: response.status, type: (response.headers.get('content-type') ?? '').split(';')[0].trim(),
    robots: (response.headers.get('x-robots-tag') ?? '').toLowerCase(), body: Buffer.from(await response.arrayBuffer()) };
}

// Poll until the origin serves this build's bytes. Returns the attempt that settled and the last response.
async function settle(url, want, attempts, intervalMs) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { last = await request(url); }
    catch (error) { last = { status: 0, type: '', robots: '', body: Buffer.alloc(0), error: error.message }; }
    if (last.status === 200 && last.body.length === want.length && sha256(last.body) === want.sha256) {
      return { settled: true, response: last, attempt };
    }
    if (attempt < attempts) await delay(intervalMs);
  }
  return { settled: false, response: last, attempt: attempts };
}

async function main() {
  const origin = option('origin', 'https://roadnaturalist.com').replace(/\/+$/, '');
  const attempts = Number(option('attempts', 12));
  const intervalMs = Number(option('interval', 5)) * 1000;
  const stagedOnly = process.argv.includes('--staged');

  const { marker, problems } = inspectStaged();
  if (problems.length) {
    console.error('The staged payload is not releasable:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Staged payload: commit ${String(marker.commit).slice(0, 7)}, ${marker.files.length} file(s), `
    + `artifact plane ${marker.artifactVerification}.`);
  if (stagedOnly) { console.log('Staged payload verified. Nothing was deployed or fetched.'); return; }

  const failures = [];
  const served = {};
  for (const target of TARGETS) {
    const staged = marker.files.find(file => file.path === target.file);
    const result = await settle(`${origin}${target.path}`, { length: staged.bytes, sha256: staged.sha256 }, attempts, intervalMs);
    if (!result.settled) {
      const last = result.response ?? {};
      failures.push(`${target.path} did not settle on the staged bytes in ${result.attempt} attempt(s) `
        + `(last: HTTP ${last.status}, ${last.body?.length ?? 0} bytes, ${last.error ?? last.type ?? 'no content type'})`);
      continue;
    }
    if (!target.type.test(result.response.type)) {
      failures.push(`${target.path} is served as ${result.response.type || 'no content type'}, expected ${target.type}`);
    }
    served[target.file] = result.response;
    console.log(`  ${target.path} 200 ${result.response.type} ${staged.bytes} bytes, sha256 ${staged.sha256.slice(0, 12)}…`);
  }

  for (const file of SAME_ORIGIN_FILES) {
    const staged = (marker.files ?? []).find(entry => entry.path === file);
    if (!staged) { failures.push(`${file} is not in the staged payload but is checked live`); continue; }
    const result = await settle(`${origin}/${file}`, { length: staged.bytes, sha256: staged.sha256 }, Math.min(attempts, 4), intervalMs);
    if (!result.settled) failures.push(`/${file} does not serve the staged bytes`);
  }
  if (!SAME_ORIGIN_FILES.some(file => failures.some(problem => problem.startsWith(`/${file}`)))) {
    console.log(`  ${SAME_ORIGIN_FILES.length} application file(s) serve the staged bytes`);
  }

  // The crawl targets are validated from the bytes the origin served, not from disk: what a crawler reads is the
  // only thing that matters, and the canonical domain must be the same whatever host was asked.
  if (served['index.html'] && served['robots.txt'] && served['sitemap.xml']) {
    failures.push(...validateSeo({ html: served['index.html'].body.toString('utf8'),
      robots: served['robots.txt'].body.toString('utf8'), sitemap: served['sitemap.xml'].body.toString('utf8') }));
  }
  // The Pages hostnames must not be indexable; the canonical domain must be.
  const host = new URL(origin).hostname;
  const indexRobots = served['index.html']?.robots ?? '';
  if (host.endsWith('.pages.dev') && !indexRobots.includes('noindex')) {
    failures.push(`${host} is a Pages hostname but is not served X-Robots-Tag: noindex`);
  }
  if (host === 'roadnaturalist.com' && indexRobots.includes('noindex')) {
    failures.push(`${host} is the canonical domain but is served X-Robots-Tag: noindex`);
  }

  if (failures.length) {
    console.error(`Pages release verification failed for ${origin}:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Pages release verified: ${origin} serves commit ${String(marker.commit).slice(0, 7)} exactly `
    + `(${marker.files.length} staged file(s), crawler files, metadata and JSON-LD).`);
}

await main();
