#!/usr/bin/env node
/**
 * Deploy the static application to Cloudflare Pages (direct upload, no build).
 *
 *   npm run deploy:pages
 *
 * Production deployment requires a clean checkout whose HEAD is the tip of `origin/main`, so what is deployed is
 * always a reviewed commit rather than a working tree. `main` is the expected branch; a detached HEAD is accepted
 * only because that is what a CI checkout of a push to main looks like, and the commit must still be exactly the
 * published tip. The payload is exactly what `stage:pages` produces.
 *
 * The Worker is deployed separately, from worker/:  npm run deploy:worker
 *
 * Authentication is `CLOUDFLARE_API_TOKEN` from the environment when one is set (the release workflow's repository
 * secret), otherwise the operator's logged-in `wrangler` session. No credential is read, printed or written here.
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
if (status) throw new Error('production deployment requires a clean checkout: commit and review the changes first');
if (branch && branch !== BRANCH) throw new Error(`production deployment runs from ${BRANCH}, not ${branch}`);
const head = git('rev-parse', 'HEAD');
// Compare against the remote's current tip rather than a possibly stale local ref, so a checkout that has not fetched
// the latest main cannot publish an older commit as production. A remote that cannot be read is not permission to
// deploy unproven either: without it nothing can say which commit production is.
let originTip = null;
try { originTip = execFileSync('git', ['-C', ROOT, 'ls-remote', 'origin', `refs/heads/${BRANCH}`], { encoding: 'utf8' }).trim().split(/\s+/)[0] || null; }
catch { originTip = null; }
if (!originTip) throw new Error(`cannot read origin/${BRANCH}: refusing to deploy a commit that cannot be checked against it`);
if (originTip !== head) throw new Error(`HEAD (${head.slice(0, 7)}) is not what is on origin/${BRANCH} (${originTip.slice(0, 7)}): push first, then deploy`);

// A release authenticated by an API token must name the account that owns the project: wrangler's automatic account
// discovery asks for a permission this token deliberately does not have, and a release should fail here with that
// sentence rather than inside wrangler with a stack trace. The local path keeps working: an operator's logged-in
// session resolves its own account.
if (process.env.CLOUDFLARE_API_TOKEN && !process.env.CLOUDFLARE_ACCOUNT_ID) {
  throw new Error('CLOUDFLARE_API_TOKEN is set but CLOUDFLARE_ACCOUNT_ID is not: name the account that owns the '
    + 'Pages project (a CLOUDFLARE_ACCOUNT_ID repository variable, see docs/DEPLOYMENT.md §9)');
}

const info = await stage({
  publishedArtifacts: process.argv.includes('--published-artifacts') || process.env.PAGES_PUBLISHED_ARTIFACTS === '1',
});
console.log(`Deploying to Pages project ${PROJECT} (branch ${BRANCH}, commit ${info.commit?.slice(0, 7) ?? 'unknown'})…`);
console.log(process.env.CLOUDFLARE_API_TOKEN
  ? 'Authenticating with CLOUDFLARE_API_TOKEN from the environment.'
  : 'Authenticating with the logged-in wrangler session.');
execFileSync('npx', ['--yes', WRANGLER, 'pages', 'deploy', resolve(ROOT, 'dist'), '--project-name', PROJECT, '--branch', BRANCH,
  ...(info.commit ? ['--commit-hash', info.commit] : []), '--commit-dirty=false'], { cwd: ROOT, stdio: 'inherit' });

const staged = readFileSync(resolve(ROOT, 'dist/deployment.json'), 'utf8').length;
console.log(`Deployed ${info.files.length} file(s). deployment.json is ${staged} bytes and records every staged file hash.`);
console.log('Verify what production serves with: npm run verify:pages:release');
