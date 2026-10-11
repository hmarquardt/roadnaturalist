import test from 'node:test';
import assert from 'node:assert/strict';

import { IDENTITY_STAGE, REPRESENTATIVE_IDENTITY, identityEvidenceProblems, identityStagePayload,
  parseIdentityEvidence, recordIdentityEvidence, representativeExercised, representativePayload }
  from '../src/discovery/identity-evidence.js';

// A payload exactly as the promotion path emits it: the representative corridor, promoted although the windowed
// reconstruction gave the same road a different generated id.
const IDENTITY = Object.freeze({ corridorName: 'River Rd', derivedId: 'drv1-river-rd-c226-s1',
  reconstructedId: 'drv1-river-rd-c7-s1', sourceFeatureCount: 9, segmentIndex: 1, segmentCount: 3,
  geometryDriftM: Object.freeze({ derivedToSource: 0, sourceToDerived: 0 }) });
const PAYLOAD = identityStagePayload({ identity: IDENTITY, evidenceLevel: 'Source-backed' });
const line = payload => `STAGE ${IDENTITY_STAGE} ${JSON.stringify(payload)}`;

test('the emitted payload keeps counts and booleans, and never a feature-id array', () => {
  assert.equal(PAYLOAD.idsDiffer, true);
  assert.equal(PAYLOAD.identityBasis, 'source_feature_ids_exact');
  assert.equal(PAYLOAD.sourceFeatureMatch, 'exact');
  assert.equal(PAYLOAD.sourceFeatureCount, 9);
  assert.deepEqual(PAYLOAD.geometryDriftM, { derivedToSource: 0, sourceToDerived: 0 });
  assert.ok(!('sourceFeatureIds' in PAYLOAD), 'the record is a summary, not the evidence itself');
});

test('the identity stage is parsed from the browser output it was printed in', () => {
  const text = ['noise', line(PAYLOAD), 'more noise'].join('\n');
  const parsed = parseIdentityEvidence(text);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.payload.derivedId, REPRESENTATIVE_IDENTITY.derivedId);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(identityEvidenceProblems(parsed, { required: true }), []);
});

test('a missing identity stage fails the record when the representative corridor was exercised', () => {
  const report = 'DETAIL_PRODUCTION ' + JSON.stringify({ place: 'Princeton, IN', corridor: 'River Rd' });
  const parsed = parseIdentityEvidence(report);
  assert.equal(representativeExercised(report), true, 'the run did exercise the representative corridor');
  assert.equal(parsed.count, 0);
  assert.match(identityEvidenceProblems(parsed, { required: true }).join(' '), /no sourceEvidence:identity line/);
  // A run that never touched the case is not failed for missing evidence, which keeps the rule honest.
  assert.deepEqual(identityEvidenceProblems(parsed, { required: false }), []);
  assert.equal(representativeExercised('DETAIL_PRODUCTION ' + JSON.stringify({ corridor: 'Some Other Rd' })), false);
});

test('malformed evidence fails closed instead of being read as an absence', () => {
  const parsed = parseIdentityEvidence(`STAGE ${IDENTITY_STAGE} {not json`);
  assert.equal(parsed.count, 0);
  assert.match(parsed.problems.join(' '), /not readable JSON/);
  assert.match(identityEvidenceProblems(parsed, { required: false }).join(' '), /not readable JSON/);
});


test('differing ids with exact source identity are accepted; so are matching ids', () => {
  assert.deepEqual(identityEvidenceProblems(parseIdentityEvidence(line(PAYLOAD)), { required: true }), []);
  const same = identityStagePayload({ identity: { ...IDENTITY, reconstructedId: IDENTITY.derivedId,
    corridorName: 'NW Example Rd' }, evidenceLevel: 'Source-backed' });
  assert.equal(same.idsDiffer, false);
  // Generic corridors may reconstruct to their own build id; the contract is identity, not divergence.
  assert.deepEqual(identityEvidenceProblems(parseIdentityEvidence(line(same)), { required: false }), []);
});

test('a weaker identity basis or a source mismatch is rejected', () => {
  for (const [field, value, pattern] of [
    ['identityBasis', 'name_and_geometry_proximity', /does not rest on source-feature identity/],
    ['sourceFeatureMatch', 'partial', /does not record an exact source-feature match/],
    ['sourceFeatureCount', 0, /records no source feature count/],
    ['sourceEvidence', 'Precomputed source metrics', /does not record source-backed evidence/],
  ]) {
    const broken = { ...PAYLOAD, [field]: value };
    const problems = identityEvidenceProblems(parseIdentityEvidence(line(broken)), { required: false });
    assert.ok(problems.some(problem => pattern.test(problem)), `${field}=${value} must be refused: ${problems}`);
  }
});

test('geometry drift beyond the metre contract is rejected, in either direction', () => {
  for (const key of ['derivedToSource', 'sourceToDerived']) {
    const broken = { ...PAYLOAD, geometryDriftM: { ...PAYLOAD.geometryDriftM, [key]: 1.5 } };
    assert.match(identityEvidenceProblems(parseIdentityEvidence(line(broken)), { required: false }).join(' '),
      new RegExp(`geometry drift ${key} is 1.5 m, beyond the 1 m contract`));
  }
  // Exactly at the contract is inside it, as the corridor verifier itself treats it.
  const edge = { ...PAYLOAD, geometryDriftM: { derivedToSource: 1, sourceToDerived: 1 } };
  assert.deepEqual(identityEvidenceProblems(parseIdentityEvidence(line(edge)), { required: false }), []);
});

test('the representative corridor must actually diverge for the record to prove the contract', () => {
  const sameId = { ...PAYLOAD, reconstructedId: PAYLOAD.derivedId, idsDiffer: false };
  assert.match(identityEvidenceProblems(parseIdentityEvidence(line(sameId)), { required: true }).join(' '),
    /reconstructed under its own build id/);
  // And if only a different corridor ran, the representative evidence is missing, which is also a failure.
  const other = identityStagePayload({ identity: { ...IDENTITY, corridorName: 'Other Rd',
    derivedId: 'drv1-other-rd-c1-s1' }, evidenceLevel: 'Source-backed' });
  assert.match(identityEvidenceProblems(parseIdentityEvidence(line(other)), { required: true }).join(' '),
    /no identity evidence was recorded for drv1-river-rd-c226-s1/);
});

test('the recorded block is the representative payload, summarised', () => {
  const other = identityStagePayload({ identity: { ...IDENTITY, corridorName: 'Other Rd',
    derivedId: 'drv1-other-rd-c1-s1' }, evidenceLevel: 'Source-backed' });
  const state = parseIdentityEvidence([line(other), line(PAYLOAD)].join('\n'));
  const block = recordIdentityEvidence({ payload: representativePayload(state) });
  assert.equal(block.derivedId, REPRESENTATIVE_IDENTITY.derivedId);
  assert.equal(block.reconstructedId, 'drv1-river-rd-c7-s1');
  assert.equal(block.idsDiffer, true);
  assert.equal(block.sourceFeatureCount, 9);
  assert.deepEqual(block.geometryDriftM, { derivedToSource: 0, sourceToDerived: 0 });
  assert.ok(JSON.stringify(block).length < 400, 'the artefact stays small');
});
