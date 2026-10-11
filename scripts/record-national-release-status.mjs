#!/usr/bin/env node
// Record what has actually been verified about the national derived release.
//
//   node scripts/record-national-release-status.mjs --browser passed [--record <path>]
//   node scripts/record-national-release-status.mjs --browser failed --reason "<why>"
//
// The release has TWO independent gates, and reporting one as the other is exactly the mistake this file exists
// to prevent:
//
//   * the R2 publication - verified by re-fetching every published object and comparing bytes, SHA-256, content
//     type, caching, CORS and the complete remote inventory; and
//   * the browser cutover - verified by a deployed browser resolving that plane through the deployed frontend.
//
// The R2 section is read from the committed remote-audit record rather than restated, so a browser failure can
// never be recorded as a data failure, and a data verification can never be recorded as a browser one. Prior
// browser outcomes are kept as history rather than overwritten.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { identityEvidenceProblems, parseIdentityEvidence, recordIdentityEvidence, representativeExercised,
  representativePayload } from '../src/discovery/identity-evidence.js';

const OUTPUT = 'data/national/verification/derived-publication-status.json';
const AUDIT = 'data/national/verification/derived-publication-remote-audit.json';
const DATA_VERIFICATION = 'data/national/verification/derived-publication-production.txt';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const browser = option('--browser');
if (browser !== 'passed' && browser !== 'failed') throw new Error('--browser passed|failed is required');

const audit = existsSync(AUDIT) ? JSON.parse(readFileSync(AUDIT, 'utf8')) : null;
const previous = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, 'utf8')) : {};
const now = new Date().toISOString();

const history = Array.isArray(previous.browserCutoverHistory) ? [...previous.browserCutoverHistory] : [];
if (previous.browserCutover && previous.browserCutover.status && previous.browserCutover.checkedAt !== now) {
  history.push(previous.browserCutover);
}

const browserRecord = browser === 'passed' ? (option('--record') ?? previous.browserCutover?.record ?? null) : null;
const browserOutput = browserRecord && existsSync(browserRecord) ? readFileSync(browserRecord, 'utf8') : '';

// WHAT A PASSED BROWSER GATE MUST SHOW ABOUT IDENTITY.
//
// The derived id of a corridor is a build identity and may carry a national component ordinal; a windowed
// reconstruction may number the same road differently. That is safe only because verification rests on source
// feature membership, segment position and geometry, so the release records one real divergence rather than the
// claim that ids always agree. If the run exercised the representative corridor and the evidence is missing,
// unreadable, or weaker than the contract, this record refuses to exist - the release fails instead of passing on
// a line it cannot prove.
const identity = parseIdentityEvidence(browserOutput);
const identityProblems = browser === 'passed'
  ? [ ...(browserOutput ? [] : [`the browser record ${browserRecord ?? '(none)'} is missing, so no identity evidence could be read`]),
      ...identityEvidenceProblems(identity, { required: representativeExercised(browserOutput) }) ]
  : [];
if (identityProblems.length) {
  throw new Error('the browser record carries no usable identity evidence:\n  - ' + identityProblems.join('\n  - '));
}

const status = {
  kind: 'national-derived-release-status',
  schemaVersion: 1,
  catalogFingerprint: audit?.fingerprint ?? previous.catalogFingerprint ?? null,
  r2Publication: audit ? { status: 'verified', verifiedAt: audit.auditedAt, record: AUDIT,
    objects: audit.objectsAudited, bytes: audit.bytesVerified, manifestSha256: audit.manifestRemoteSha256,
    inventory: audit.inventory ?? null, failures: audit.failures?.length ?? null }
    : (previous.r2Publication ?? { status: 'unknown', record: null }),
  sixRegionDataVerification: existsSync(DATA_VERIFICATION)
    ? { status: 'passed', record: DATA_VERIFICATION,
      note: 'Node + DuckDB against the published R2 plane: the six regions resolve, load and query.' }
    : (previous.sixRegionDataVerification ?? { status: 'unknown', record: DATA_VERIFICATION }),
  browserCutover: { status: browser, checkedAt: now,
    record: browser === 'passed' ? browserRecord : null,
    reason: browser === 'failed' ? (option('--reason') ?? 'the deployed browser check failed') : null },
  browserCutoverHistory: history,
  identityEvidence: browser === 'passed' ? recordIdentityEvidence({ payload: representativePayload(identity) })
    : (previous.identityEvidence ?? null),
  note: 'Two independent gates. R2 publication is verified by re-fetching every published object; the browser '
    + 'cutover is verified by a real browser resolving that plane through the deployed frontend. Neither is '
    + 'reported as the other, and the R2 verification stays valid across a browser failure.',
};
writeFileSync(OUTPUT, `${JSON.stringify(status, null, 1)}\n`);
console.log(`${OUTPUT}: r2=${status.r2Publication.status} data=${status.sixRegionDataVerification.status} `
  + `browser=${status.browserCutover.status}`);
