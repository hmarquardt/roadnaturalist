#!/usr/bin/env node
/**
 * Write the committed analysis profile for the published regional data plane.
 *
 *   node scripts/write-analysis-profile.mjs            # write data/regional/analysis-profile.json
 *   node scripts/write-analysis-profile.mjs --check    # fail if the committed profile is not current
 *
 * The profile is the semantics a derived artifact freezes, reduced to canonical JSON and hashed. It is built
 * from the values the runtime actually uses (src/discovery/analysis-fingerprint.js imports the constants
 * rather than restating them), so it can be regenerated and compared at any time. `--check` is what a test or
 * a release step runs to prove the committed profile still describes the shipped code.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { analysisFingerprint } from '../src/discovery/analysis-fingerprint.js';

const regionalCatalog = JSON.parse(readFileSync('data/regional/manifest.json', 'utf8'));
const manifest = JSON.parse(readFileSync('data/manifest.json', 'utf8'));
const roadComponents = JSON.parse(readFileSync(`data/${regionalCatalog.roadComponentsUrl}`, 'utf8'));
const { profile, fingerprint } = await analysisFingerprint({ regionalCatalog, manifest, roadComponents });
const document = { ...profile, fingerprint };
if (process.argv.includes('--check')) {
  const committed = JSON.parse(readFileSync('data/regional/analysis-profile.json', 'utf8'));
  if (JSON.stringify(committed) !== JSON.stringify(document)) {
    console.error('The committed analysis profile is stale: regenerate it with node scripts/write-analysis-profile.mjs');
    process.exit(1);
  }
  console.log(`Analysis profile is current: fingerprint ${fingerprint}`);
} else {
  writeFileSync('data/regional/analysis-profile.json', `${JSON.stringify(document, null, 1)}\n`);
  console.log(`Wrote data/regional/analysis-profile.json: fingerprint ${fingerprint}`);
}
