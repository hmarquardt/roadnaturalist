#!/usr/bin/env node
/**
 * Deploy the static application to Cloudflare Pages (direct upload, no build).
 *
 *   npm run deploy:pages
 *
 * Production deployment requires a clean `main` checkout whose HEAD is on origin/main, so what is deployed is always
 * a reviewed commit rather than a working tree. The payload is exactly what `stage:pages` produces.
 *
 * The Worker is deployed separately, from worker/:  npm run deploy:worker
 *
 * No credential is read or written here: `wrangler` uses the operator's own logged-in session.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stage } from './stage-pages.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const WRANGLER = 'wrangler@4.135.0';
const PROJECT = 'roadnaturalist';
const BRANCH = 'main';

const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();

const branch = git('branch', '--show-current');
const status = git('status', '--porcelain');
if (branch !== BRANCH) throw new Error(`production deployment runs from ${BRANCH}, not ${branch || 'a detached HEAD'}`);
if (status) throw new Error('production deployment requires a clean checkout: commit and review the changes first');
const head = git('rev-parse', 'HEAD');
// Compare against the remote's current tip rather than a possibly stale local ref, so a checkout that has not fetched
// the latest main cannot publish an older commit as production.
let originTip = null;
try { originTip = execFileSync('git', ['-C', ROOT, 'ls-remote', 'origin', `refs/heads/${BRANCH}`], { encoding: 'utf8' }).trim().split(/\s+/)[0] || null; }
catch { originTip = null; }
if (originTip && originTip !== head) throw new Error(`HEAD (${head.slice(0, 7)}) is not what is on origin/${BRANCH} (${originTip.slice(0, 7)}): push first, then deploy`);

const info = stage();
console.log(`Deploying to Pages project ${PROJECT} (branch ${BRANCH}, commit ${info.commit?.slice(0, 7) ?? 'unknown'})…`);
execFileSync('npx', ['--yes', WRANGLER, 'pages', 'deploy', resolve(ROOT, 'dist'), '--project-name', PROJECT, '--branch', BRANCH,
  ...(info.commit ? ['--commit-hash', info.commit] : []), '--commit-dirty=false'], { cwd: ROOT, stdio: 'inherit' });

const staged = readFileSync(resolve(ROOT, 'dist/deployment.json'), 'utf8').length;
console.log(`Deployed ${info.files.length} file(s). deployment.json is ${staged} bytes and records every staged file hash.`);
