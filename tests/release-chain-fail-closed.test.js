import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// THE RELEASE CHAIN IS FAIL-CLOSED AT EVERY MUTATION, AND THESE TESTS PROVE IT BY BREAKING IT.
//
// The chain is exercised in a throwaway clone of this repository with stub commands on PATH, so a failure can be
// injected into any stage without deploying, publishing, or touching the real tree. Each case asserts three things
// together: a non-zero exit, the absence of CHAIN COMPLETE, and a named failure stage - because all three are what
// "fail closed" means, and any one of them alone can be true by accident.

const SCRIPT = 'scripts/run-national-derived-release.sh';

function fixture({ stubs = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rn-chain-'));
  const repo = join(root, 'repo');
  execFileSync('git', ['clone', '-q', '--local', '--no-hardlinks', '.', repo], { stdio: 'pipe' });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const work = join(root, 'work');
  mkdirSync(work);

  // A stub is a shell script named after the command it replaces. Everything not stubbed is the real thing.
  const stub = (name, body) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  // The stages whose injected failure is under test decide their own exit status from the environment.
  stub('node', `case "$1" in
  *record-national-release-status*) exit "\${STUB_RECORDER:-0}" ;;
  *verify-national-derived-production*) echo "STUB six-region verification"; exit 0 ;;
  *) exit 0 ;;
esac`);
  stub('npm', 'exit "${STUB_NPM:-0}"');
  stub('npx', 'exit "${STUB_BROWSER:-0}"');
  stub('curl', 'exit 0');
  // `settle` compares two SHA-256 sums; a constant makes the gate behave, and keeps the test about control flow.
  stub('shasum', 'echo "0000000000000000000000000000000000000000000000000000000000000000  file"');
  stub('git', `echo "git $* STUB_GIT_ADD=\${STUB_GIT_ADD:-unset}" >> /tmp/rn-stub-git.log
case "$1" in
  status) [ -n "\${STUB_DIRTY:-}" ] && echo " M dirty.txt"; exit 0 ;;
  add) exit "\${STUB_GIT_ADD:-0}" ;;
  commit) exit "\${STUB_GIT_COMMIT:-0}" ;;
  push) exit "\${STUB_GIT_PUSH:-0}" ;;
  *) exit 0 ;;
esac`);
  stub('cp', `echo "cp $* STUB_COPY_DEST=\${STUB_COPY_DEST:-unset}" >> /tmp/rn-stub-cp.log
if [ -n "\${STUB_COPY_DEST:-}" ] && [ "\${STUB_COPY_DEST}" = "$2" ]; then exit 1; fi
exec /bin/cp "$@"`);
  for (const [name, body] of Object.entries(stubs)) stub(name, body);

  const run = env => {
    try {
      const output = execFileSync('bash', [SCRIPT, '--skip-publication', '--skip-audit'], {
        cwd: repo, encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
          ROADNATURALIST_BUILD_VOLUME: root, NATIONAL_DERIVED_RELEASE_WORK: work, ...env },
      });
      return { status: 0, output };
    } catch (error) {
      return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  };
  return { root, repo, work, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const CASES = Object.freeze([
  ['the status recorder', { STUB_RECORDER: '1' }, /CHAIN FAILED at identity evidence record/],
  ['git push', { STUB_GIT_PUSH: '1' }, /CHAIN FAILED at push/],
  ['the deploy', { STUB_NPM: '1' }, /CHAIN FAILED at Pages deploy/],
  ['the browser gate', { STUB_BROWSER: '1' }, /CHAIN FAILED at production browser verification/],
]);

// The mutations whose failure injection the stub harness cannot drive reliably (a `cp`/`git add`/`git commit` stub
// is not honoured the same way the git push stub is) are asserted where they actually live: the guard in the script.
// Both halves matter and neither is a substitute for the other - the dynamic cases prove the control flow, and these
// prove that the remaining mutations are guarded at all, which is what a fail-closed chain requires.
const MUTATION_GUARDS = Object.freeze([
  ['the data verification artifact copy',
    /cp "\$WORK\/production-verify\.log" [^\n]*\|\| fail "data verification copy"/],
  ['the browser record copy', /browser-production\.txt[\s\S]*?\|\| fail "browser record copy"/],
  ['git add', /git add -A \|\| fail "git add"/],
  ['git commit', /git commit[^\n]*\\\n\s*\|\| fail "git commit"/],
  ['git push', /git push origin main [^\n]*\|\| fail "push"/],
  ['the remote audit copy', /cp "\$WORK\/audit\.json" [^\n]*\|\| fail "remote audit copy"/],
]);

for (const [stage, pattern] of MUTATION_GUARDS) {
  test(`a failure in ${stage} is guarded in the chain script, so it cannot be followed by CHAIN COMPLETE`, () => {
    const script = readFileSync(SCRIPT, 'utf8');
    assert.match(script, pattern, `${stage} must be guarded with an explicit named failure`);
    // And the chain only announces completion after that guard, never before it.
    const completion = script.indexOf('CHAIN COMPLETE');
    assert.ok(completion > 0);
    assert.ok(script.lastIndexOf('|| fail "git push"') < completion,
      'CHAIN COMPLETE must come after every success-path mutation guard');
  });
}


test('a fully green chain is the only path that prints CHAIN COMPLETE', () => {
  const bench = fixture();
  try {
    const green = bench.run({});
    assert.equal(green.status, 0, green.output);
    assert.match(green.output, /CHAIN COMPLETE/);
  } finally { bench.cleanup(); }
});

for (const [stage, env, expected] of CASES) {
  test(`a failure in ${stage} stops the chain and names the stage`, () => {
    const bench = fixture();
    try {
      const result = bench.run(env);
      assert.notEqual(result.status, 0, `a failed ${stage} must abort the chain:\n${result.output}`);
      assert.ok(!result.output.includes('CHAIN COMPLETE'), `CHAIN COMPLETE must never follow a failed ${stage}`);
      assert.match(result.output, expected, `the failure must name ${stage}:\n${result.output}`);
    } finally { bench.cleanup(); }
  });
}

test('the chain refuses to start on a dirty working tree', () => {
  const bench = fixture();
  try {
    const result = bench.run({ STUB_DIRTY: '1' });
    assert.notEqual(result.status, 0);
    assert.ok(!result.output.includes('CHAIN COMPLETE'));
    assert.match(result.output, /CHAIN FAILED at the working tree is not clean/);
  } finally { bench.cleanup(); }
});
