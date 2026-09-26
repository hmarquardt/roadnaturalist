// ACCESS EPISTEMOLOGY.
//
// Road Naturalist never reduces access to `accessible = true`. Public access is a qualified claim about
// a road, supported by identified sources of unequal reliability, and it ages differently from GIS
// evidence. This module owns the vocabulary, the evidence shape, the freshness rules, and the
// deterministic finding guardrails. See docs/INVESTIGATOR.md.
//
// Three questions stay separate:
//   * source fact   — a source states something ("county road program describes road X")
//   * derived fact  — Road Naturalist computes something from source facts ("OSM way overlaps 96%")
//   * finding       — what the evidence supports ("public access probable"), produced by rules here
// An interpretation (human or model) may annotate a finding but can never set one.

import { ROAD_NAME_RELATION, roadNameRelation } from './osm-match.js';

export const ACCESS_FINDING = Object.freeze({
  VERIFIED_PUBLIC: 'VERIFIED_PUBLIC',
  PROBABLE_PUBLIC: 'PROBABLE_PUBLIC',
  UNVERIFIED: 'UNVERIFIED',
  CONFLICTED: 'CONFLICTED',
  RESTRICTED_OR_CLOSED: 'RESTRICTED_OR_CLOSED',
});

// What a finding does and does not mean. Rendered verbatim in the UI and carried in the bundle.
export const ACCESS_FINDING_MEANING = Object.freeze({
  [ACCESS_FINDING.VERIFIED_PUBLIC]: 'Strong current evidence from an authoritative source supports ordinary public motor-vehicle use. This is not a legal guarantee, not a warranty of current passability, and not a statement about every part of the corridor.',
  [ACCESS_FINDING.PROBABLE_PUBLIC]: 'Consistent evidence supports public access, but it is not strong enough, is not from an authoritative source, or does not cover the whole corridor.',
  [ACCESS_FINDING.UNVERIFIED]: 'Road Naturalist has not established public, legal, or practical access. This is the default state, and it is not a negative finding.',
  [ACCESS_FINDING.CONFLICTED]: 'Sources disagree about the access status of this road. Road Naturalist does not choose a side; a person must review the evidence.',
  [ACCESS_FINDING.RESTRICTED_OR_CLOSED]: 'Evidence from an authority indicates that ordinary use is restricted, closed, gated, permit-only, or seasonally closed. The restriction itself is preserved, not flattened into "closed".',
});

// Claim vocabulary. Modest and controlled on purpose: a claim type decides the effect a source statement
// has on the public-access question, while the source's own language stays in `quote`.
export const ACCESS_CLAIM = Object.freeze({
  PUBLIC_ROAD: 'PUBLIC_ROAD',
  PRIVATE_ROAD: 'PRIVATE_ROAD',
  MOTOR_VEHICLES_ALLOWED: 'MOTOR_VEHICLES_ALLOWED',
  MOTOR_VEHICLES_RESTRICTED: 'MOTOR_VEHICLES_RESTRICTED',
  SEASONAL_CLOSURE: 'SEASONAL_CLOSURE',
  TEMPORARY_CLOSURE: 'TEMPORARY_CLOSURE',
  PERMIT_REQUIRED: 'PERMIT_REQUIRED',
  GATE_REPORTED: 'GATE_REPORTED',
  ROAD_MAINTAINED: 'ROAD_MAINTAINED',
  ROAD_UNMAINTAINED: 'ROAD_UNMAINTAINED',
  SURFACE: 'SURFACE',
  ROAD_CLASS: 'ROAD_CLASS',
  LAND_MANAGER: 'LAND_MANAGER',
  // Added because this implementation really produces them; both are documented in docs/INVESTIGATOR.md.
  ACCESS_TAG_ABSENT: 'ACCESS_TAG_ABSENT',   // a mapped source carries no explicit access tag at all
  ROAD_NAME_VARIANT: 'ROAD_NAME_VARIANT',   // a source describes a similarly named but different road
  UNKNOWN: 'UNKNOWN',
});

// Effect of a claim on the public-access question. ATTENTION claims are surfaced but never decide.
export const ACCESS_EFFECT = Object.freeze({ AFFIRMATIVE: 'AFFIRMATIVE', RESTRICTIVE: 'RESTRICTIVE', ATTENTION: 'ATTENTION', NEUTRAL: 'NEUTRAL' });
export const ACCESS_STANCE = Object.freeze({ SUPPORTS: 'SUPPORTS_PUBLIC_ACCESS', CONTRADICTS: 'CONTRADICTS_PUBLIC_ACCESS', NEUTRAL: 'NEUTRAL' });

const CLAIM_EFFECTS = Object.freeze({
  [ACCESS_CLAIM.PUBLIC_ROAD]: ACCESS_EFFECT.AFFIRMATIVE,
  [ACCESS_CLAIM.MOTOR_VEHICLES_ALLOWED]: ACCESS_EFFECT.AFFIRMATIVE,
  [ACCESS_CLAIM.ROAD_MAINTAINED]: ACCESS_EFFECT.AFFIRMATIVE,
  [ACCESS_CLAIM.PRIVATE_ROAD]: ACCESS_EFFECT.RESTRICTIVE,
  [ACCESS_CLAIM.MOTOR_VEHICLES_RESTRICTED]: ACCESS_EFFECT.RESTRICTIVE,
  [ACCESS_CLAIM.SEASONAL_CLOSURE]: ACCESS_EFFECT.RESTRICTIVE,
  [ACCESS_CLAIM.TEMPORARY_CLOSURE]: ACCESS_EFFECT.RESTRICTIVE,
  [ACCESS_CLAIM.PERMIT_REQUIRED]: ACCESS_EFFECT.RESTRICTIVE,
  [ACCESS_CLAIM.GATE_REPORTED]: ACCESS_EFFECT.ATTENTION,
  [ACCESS_CLAIM.ROAD_UNMAINTAINED]: ACCESS_EFFECT.ATTENTION,
  [ACCESS_CLAIM.ROAD_NAME_VARIANT]: ACCESS_EFFECT.ATTENTION,
  [ACCESS_CLAIM.SURFACE]: ACCESS_EFFECT.NEUTRAL,
  [ACCESS_CLAIM.ROAD_CLASS]: ACCESS_EFFECT.NEUTRAL,
  [ACCESS_CLAIM.LAND_MANAGER]: ACCESS_EFFECT.NEUTRAL,
  [ACCESS_CLAIM.ACCESS_TAG_ABSENT]: ACCESS_EFFECT.NEUTRAL,
  [ACCESS_CLAIM.UNKNOWN]: ACCESS_EFFECT.NEUTRAL,
});

// Claim types that assert the road's *status* rather than an operational condition. Disagreement about
// status is a CONFLICTED finding; an operational closure is a RESTRICTED_OR_CLOSED finding.
const STATUS_CLAIMS = new Set([ACCESS_CLAIM.PUBLIC_ROAD, ACCESS_CLAIM.PRIVATE_ROAD, ACCESS_CLAIM.MOTOR_VEHICLES_ALLOWED,
  ACCESS_CLAIM.MOTOR_VEHICLES_RESTRICTED, ACCESS_CLAIM.PERMIT_REQUIRED]);
export const OPERATIONAL_CLOSURE_CLAIMS = Object.freeze([ACCESS_CLAIM.TEMPORARY_CLOSURE, ACCESS_CLAIM.SEASONAL_CLOSURE]);

// SOURCE RELIABILITY. Tier 1 is an authority acting in its own jurisdiction; Tier 2 is government-
// maintained data or a right-of-way record; Tier 3 is community/mapped data; Tier 4 is anecdotal.
export const SOURCE_CLASS = Object.freeze({
  TIER_1_AUTHORITATIVE: 'TIER_1_AUTHORITATIVE',
  TIER_2_INTERMEDIATE: 'TIER_2_INTERMEDIATE',
  TIER_3_COMMUNITY: 'TIER_3_COMMUNITY',
  TIER_4_ANECDOTAL: 'TIER_4_ANECDOTAL',
});
export const SOURCE_CLASS_LABELS = Object.freeze({
  [SOURCE_CLASS.TIER_1_AUTHORITATIVE]: 'Tier 1 — authority acting in its own jurisdiction (state DOT, county road department, land-management agency, official closure notice)',
  [SOURCE_CLASS.TIER_2_INTERMEDIATE]: 'Tier 2 — government-maintained data (county/state GIS, official road inventory, right-of-way record)',
  [SOURCE_CLASS.TIER_3_COMMUNITY]: 'Tier 3 — community or secondary mapping (OpenStreetMap, established road/trail databases)',
  [SOURCE_CLASS.TIER_4_ANECDOTAL]: 'Tier 4 — anecdotal web evidence (trip reports, forums, social media, blogs)',
});
const SOURCE_TIER = Object.freeze({
  [SOURCE_CLASS.TIER_1_AUTHORITATIVE]: 1, [SOURCE_CLASS.TIER_2_INTERMEDIATE]: 2,
  [SOURCE_CLASS.TIER_3_COMMUNITY]: 3, [SOURCE_CLASS.TIER_4_ANECDOTAL]: 4,
});
export const tierOf = sourceClass => SOURCE_TIER[sourceClass] ?? null;
export const isAuthoritative = item => { const tier = tierOf(item.sourceClass); return tier != null && tier <= 2; };

// FRESHNESS. Access evidence ages far faster than a road centerline, so no window is invented. A claim
// is CURRENT because the source gives an effective window that contains the check date, because the
// source states that the condition recurs, or because an official notice without a window is recent
// enough (CURRENT_WINDOW_DAYS) to be treated as current. Anything else is STALE and can never decide.
export const CURRENT_WINDOW_DAYS = 365;
export const TEMPORAL_SCOPE = Object.freeze({ CURRENT: 'CURRENT', RECURRING: 'RECURRING', EXPIRED: 'EXPIRED', STALE: 'STALE', UNDATED: 'UNDATED', NOT_APPLICABLE: 'NOT_APPLICABLE' });
export const FRESHNESS_STATE = Object.freeze({ CURRENT: 'CURRENT', RECENT: 'RECENT', STALE: 'STALE', UNDATED: 'UNDATED' });
// Source-stated recurrence: the source itself says the condition repeats, not an inference by us.
export const RECURRENCE = Object.freeze({ SEASONAL: 'seasonal', HIGH_WATER: 'high-water', SNOW: 'snow', FIRE: 'fire', CONSTRUCTION: 'construction', OTHER: 'other' });

// What part of the corridor an item speaks about. CORRIDOR_PART carries the source's own words.
export const EVIDENCE_SCOPE = Object.freeze({ CORRIDOR: 'CORRIDOR', CORRIDOR_PART: 'CORRIDOR_PART', COUNTY_SEGMENT: 'COUNTY_SEGMENT', NOT_APPLICABLE: 'NOT_APPLICABLE' });
// How strong the source's own statement is: an order, a description, or an unclear page.
export const CLAIM_STRENGTH = Object.freeze({ STATED: 'stated', DESCRIBED: 'described', UNCLEAR: 'unclear' });

const claimValues = new Set(Object.values(ACCESS_CLAIM));
const scopeValues = new Set(Object.values(EVIDENCE_SCOPE));
const strengthValues = new Set(Object.values(CLAIM_STRENGTH));

export function claimEffect(claimType) { const effect = CLAIM_EFFECTS[claimType]; if (!effect) throw new TypeError(`Unknown access claim type: ${claimType}`); return effect; }
export function claimStance(claimType) {
  const effect = claimEffect(claimType);
  if (effect === ACCESS_EFFECT.AFFIRMATIVE) return ACCESS_STANCE.SUPPORTS;
  if (effect === ACCESS_EFFECT.RESTRICTIVE) return ACCESS_STANCE.CONTRADICTS;
  return ACCESS_STANCE.NEUTRAL;
}
export const isStatusClaim = claimType => STATUS_CLAIMS.has(claimType);
export const isClosureClaim = claimType => OPERATIONAL_CLOSURE_CLAIMS.includes(claimType);

function nonEmpty(value, field) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Access evidence needs ${field}`); return value; }
function optionalString(value) { return typeof value === 'string' && value.trim() ? value : null; }
function optionalDate(value, field) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Access evidence ${field} is not a date`);
  return date.toISOString();
}

// A normalized access-evidence item. Everything the source said is preserved; nothing about the corridor
// is inferred from the source's silence.
export function createAccessEvidence(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('Access evidence must be an object');
  const claimType = raw.claimType;
  if (!claimValues.has(claimType)) throw new TypeError(`Unknown access claim type: ${claimType}`);
  if (!Object.values(SOURCE_CLASS).includes(raw.sourceClass)) throw new TypeError(`Unknown source class: ${raw.sourceClass}`);
  const evidenceScope = raw.geographicScope?.scope ?? EVIDENCE_SCOPE.NOT_APPLICABLE;
  if (!scopeValues.has(evidenceScope)) throw new TypeError(`Unknown evidence scope: ${evidenceScope}`);
  const claimStrength = raw.claimStrength ?? CLAIM_STRENGTH.DESCRIBED;
  if (!strengthValues.has(claimStrength)) throw new TypeError(`Unknown claim strength: ${claimStrength}`);
  const recurrence = raw.recurrence == null ? null : raw.recurrence;
  if (recurrence != null && !Object.values(RECURRENCE).includes(recurrence)) throw new TypeError(`Unknown recurrence: ${recurrence}`);
  const effectiveFrom = optionalDate(raw.effectiveFrom, 'effectiveFrom');
  const effectiveUntil = optionalDate(raw.effectiveUntil, 'effectiveUntil');
  if (effectiveFrom && effectiveUntil && effectiveUntil < effectiveFrom) throw new TypeError('Access evidence effective window is inverted');
  return Object.freeze({
    id: nonEmpty(raw.id, 'an id'),
    corridorId: nonEmpty(raw.corridorId, 'a corridor id'),
    claimType,
    claimValue: optionalString(raw.claimValue),
    effect: claimEffect(claimType),
    stance: claimStance(claimType),
    // SOURCE FACT: what the source is, and what it said, in its own words.
    sourceClass: raw.sourceClass,
    sourceTier: tierOf(raw.sourceClass),
    sourceOrganization: nonEmpty(raw.sourceOrganization, 'a source organization'),
    sourceTitle: nonEmpty(raw.sourceTitle, 'a source title'),
    sourceUrl: optionalString(raw.sourceUrl),
    sourceType: optionalString(raw.sourceType),
    appliesTo: optionalString(raw.appliesTo),
    quote: nonEmpty(raw.quote, 'a verbatim quote or extract'),
    summary: nonEmpty(raw.summary, 'a summary'),
    claimStrength,
    publishedAt: optionalDate(raw.publishedAt, 'publishedAt'),
    retrievedAt: optionalDate(raw.retrievedAt, 'retrievedAt'),
    effectiveFrom,
    effectiveUntil,
    recurrence,
    geographicScope: Object.freeze({ scope: evidenceScope, corridorPart: optionalString(raw.geographicScope?.corridorPart), note: optionalString(raw.geographicScope?.note) }),
    provenance: Object.freeze({
      method: nonEmpty(raw.provenance?.method ?? 'Operator-reviewed source extraction', 'a provenance method'),
      retrieval: raw.provenance?.retrieval ?? null,
      transport: raw.provenance?.transport ?? null,
    }),
  });
}

export function evidenceAgeDays(item, { checkedAt }) {
  const reference = item.effectiveUntil ?? item.publishedAt ?? item.retrievedAt;
  if (!reference) return null;
  return Math.floor((new Date(checkedAt).getTime() - new Date(reference).getTime()) / 86400000);
}

// Freshness of any item, for display and for stale flagging.
export function freshnessOf(item, { checkedAt }) {
  const ageDays = evidenceAgeDays(item, { checkedAt });
  if (ageDays == null) return Object.freeze({ state: FRESHNESS_STATE.UNDATED, ageDays: null });
  if (ageDays < 0) return Object.freeze({ state: FRESHNESS_STATE.CURRENT, ageDays });
  if (ageDays <= CURRENT_WINDOW_DAYS) return Object.freeze({ state: ageDays <= 90 ? FRESHNESS_STATE.CURRENT : FRESHNESS_STATE.RECENT, ageDays });
  return Object.freeze({ state: FRESHNESS_STATE.STALE, ageDays });
}

// The temporal scope of a restrictive claim: can it act on today's finding, or is it history?
export function temporalScopeOf(item, { checkedAt }) {
  if (item.effect !== ACCESS_EFFECT.RESTRICTIVE) return TEMPORAL_SCOPE.NOT_APPLICABLE;
  const at = new Date(checkedAt).getTime();
  if (item.effectiveFrom || item.effectiveUntil) {
    const from = item.effectiveFrom ? new Date(item.effectiveFrom).getTime() : -Infinity;
    const until = item.effectiveUntil ? new Date(item.effectiveUntil).getTime() : Infinity;
    if (at > until) return TEMPORAL_SCOPE.EXPIRED;
    return at >= from ? TEMPORAL_SCOPE.CURRENT : TEMPORAL_SCOPE.UNDATED;
  }
  if (item.recurrence) return TEMPORAL_SCOPE.RECURRING;
  const freshness = freshnessOf(item, { checkedAt });
  if (freshness.state === FRESHNESS_STATE.CURRENT || freshness.state === FRESHNESS_STATE.RECENT) return TEMPORAL_SCOPE.CURRENT;
  return freshness.state === FRESHNESS_STATE.UNDATED ? TEMPORAL_SCOPE.UNDATED : TEMPORAL_SCOPE.STALE;
}

export const isActingScope = scope => scope === TEMPORAL_SCOPE.CURRENT || scope === TEMPORAL_SCOPE.RECURRING;

// FINDING RULES. Ordered, first match wins, and each rule is a documented statement about evidence —
// never about what someone might conclude. A research or model layer may synthesize evidence and may
// annotate the result, but it cannot reach a state these rules do not allow.
export const FINDING_RULES = Object.freeze([
  Object.freeze({ id: 'R1_NO_ACCESS_EVIDENCE', finding: ACCESS_FINDING.UNVERIFIED,
    statement: "No source evidence about public access, motor-vehicle access, road status, or maintenance was retrieved. This is the default state, not a negative finding." }),
  Object.freeze({ id: 'R2_STATUS_CONFLICT', finding: ACCESS_FINDING.CONFLICTED,
    statement: "Two sources of comparable reliability disagree about the road's status (for example public road vs private road). The disagreement is preserved and no side is chosen." }),
  Object.freeze({ id: 'R3_CURRENT_RESTRICTION', finding: ACCESS_FINDING.RESTRICTED_OR_CLOSED,
    statement: "Evidence from an authority indicates a restriction that is in force at the check date (temporary closure, permit requirement, motor-vehicle restriction, or closed road). A current restriction prevents a VERIFIED_PUBLIC finding." }),
  Object.freeze({ id: 'R4_RECURRING_RESTRICTION', finding: ACCESS_FINDING.RESTRICTED_OR_CLOSED,
    statement: "An authority documents a restriction that recurs (seasonal or high-water closure). The recurrence is preserved as the reason ordinary use is not assured." }),
  Object.freeze({ id: 'R5_LOWER_TIER_RESTRICTION', finding: ACCESS_FINDING.PROBABLE_PUBLIC,
    statement: "Authoritative evidence supports public access, but a community-tier source makes an unrebutted restrictive claim about the same road. Public access stays probable rather than verified, and the claim stays visible." }),
  Object.freeze({ id: 'R6_AUTHORITATIVE_WHOLE_CORRIDOR', finding: ACCESS_FINDING.VERIFIED_PUBLIC,
    statement: "Strong affirmative evidence from an authoritative source speaks about the corridor as a whole and no restriction acts." }),
  Object.freeze({ id: 'R7_AUTHORITATIVE_PART_OF_CORRIDOR', finding: ACCESS_FINDING.PROBABLE_PUBLIC,
    statement: "Affirmative authoritative evidence speaks about only part of the corridor. The covered part is verified; the rest stays unverified, so the corridor finding is probable." }),
  Object.freeze({ id: 'R8_COMMUNITY_ONLY', finding: ACCESS_FINDING.PROBABLE_PUBLIC,
    statement: "Only community-tier evidence (for example OpenStreetMap tags) supports public access. Community mapping cannot produce the strongest state on its own." }),
  Object.freeze({ id: 'R9_NO_DECIDING_EVIDENCE', finding: ACCESS_FINDING.UNVERIFIED,
    statement: "Evidence was retrieved but none of it bears on access, motor-vehicle permission, or road status." }),
]);
const RULE_BY_ID = new Map(FINDING_RULES.map(rule => [rule.id, rule]));
export function findingRule(ruleId) { const rule = RULE_BY_ID.get(ruleId); if (!rule) throw new TypeError(`Unknown finding rule: ${ruleId}`); return rule; }

// Deterministic derivation. Everything that decides the outcome is computed here from evidence fields:
// no score, no ranking, and no model judgement.
export function deriveAccessFinding({ corridorId, corridorName = null, evidence = [], checkedAt, review = null, provisionalFinding = null }) {
  if (!corridorId) throw new TypeError('A finding needs a corridor id');
  if (!checkedAt) throw new TypeError('A finding needs the date the evidence was checked');
  const items = evidence.map(item => (item?.claimType && item.effect ? item : createAccessEvidence(item)));
  const decorated = items.map(item => Object.freeze({ item, temporalScope: temporalScopeOf(item, { checkedAt }), freshness: freshnessOf(item, { checkedAt }) }));
  const affirmative = decorated.filter(entry => entry.item.effect === ACCESS_EFFECT.AFFIRMATIVE);
  const restrictive = decorated.filter(entry => entry.item.effect === ACCESS_EFFECT.RESTRICTIVE);
  const attention = decorated.filter(entry => entry.item.effect === ACCESS_EFFECT.ATTENTION);
  const neutral = decorated.filter(entry => entry.item.effect === ACCESS_EFFECT.NEUTRAL);
  const strongAffirmative = affirmative.filter(entry => isAuthoritative(entry.item));
  const strongRestrictive = restrictive.filter(entry => isAuthoritative(entry.item));
  const actingRestrictive = strongRestrictive.filter(entry => isActingScope(entry.temporalScope));
  const communityRestrictive = restrictive.filter(entry => !isAuthoritative(entry.item));
  const actingCommunityRestrictive = communityRestrictive.filter(entry => isActingScope(entry.temporalScope));
  const statusConflict = strongAffirmative.length ? strongRestrictive.find(entry => isStatusClaim(entry.item.claimType) && isActingScope(entry.temporalScope)) ?? null : null;
  const lowerTierRestriction = strongAffirmative.length ? communityRestrictive.find(entry => isStatusClaim(entry.item.claimType) && isActingScope(entry.temporalScope)) ?? null : null;
  const wholeCorridor = strongAffirmative.some(entry => entry.item.geographicScope.scope === EVIDENCE_SCOPE.CORRIDOR);
  const actingOperational = actingRestrictive.filter(entry => isClosureClaim(entry.item.claimType) && entry.temporalScope === TEMPORAL_SCOPE.CURRENT);
  const actingNonClosure = actingRestrictive.filter(entry => !isClosureClaim(entry.item.claimType));

  let rule;
  // R1 is 'nothing was retrieved'; R9 is 'things were retrieved but none of them decides'. They are different
  // answers and a reader needs to know which one they are looking at.
  if (!items.length) rule = findingRule('R1_NO_ACCESS_EVIDENCE');
  else if (statusConflict) rule = findingRule('R2_STATUS_CONFLICT');
  else if (actingNonClosure.length || actingOperational.length) rule = findingRule('R3_CURRENT_RESTRICTION');
  else if (actingRestrictive.length) rule = findingRule('R4_RECURRING_RESTRICTION');
  else if (strongAffirmative.length && actingCommunityRestrictive.length && lowerTierRestriction) rule = findingRule('R5_LOWER_TIER_RESTRICTION');
  else if (strongAffirmative.length && wholeCorridor) rule = findingRule('R6_AUTHORITATIVE_WHOLE_CORRIDOR');
  else if (strongAffirmative.length) rule = findingRule('R7_AUTHORITATIVE_PART_OF_CORRIDOR');
  else if (affirmative.length) rule = findingRule('R8_COMMUNITY_ONLY');
  else rule = findingRule('R9_NO_DECIDING_EVIDENCE');

  const notActing = restrictive.filter(entry => !isActingScope(entry.temporalScope));
  const organizations = [...new Set(strongAffirmative.map(entry => entry.item.sourceOrganization))];
  const overlaps = authorityOverlaps(strongAffirmative);
  return Object.freeze({
    corridorId, corridorName,
    finding: rule.finding,
    meaning: ACCESS_FINDING_MEANING[rule.finding],
    ruleId: rule.id,
    rule: rule.statement,
    checkedAsOf: new Date(checkedAt).toISOString(),
    evidenceCheckedAt: newestRetrieval(decorated),
    publicRoadEvidence: publicRoadEvidenceLabel(rule, strongAffirmative, affirmative),
    motorVehicleAccess: motorVehicleLabel(rule),
    restrictionsFound: actingRestrictive.length > 0,
    affirmative: Object.freeze(strongAffirmative.map(entry => entry.item)),
    community: Object.freeze(affirmative.filter(entry => !isAuthoritative(entry.item)).map(entry => entry.item)),
    restrictions: Object.freeze(restrictive.map(entry => Object.freeze({ ...entry.item, temporalScope: entry.temporalScope, freshness: entry.freshness }))),
    attention: Object.freeze(attention.map(entry => Object.freeze({ ...entry.item, freshness: entry.freshness }))),
    neutral: Object.freeze(neutral.map(entry => Object.freeze({ ...entry.item, freshness: entry.freshness }))),
    contradictions: Object.freeze([...contradictionsOf({ statusConflict, lowerTierRestriction, notActing, actingRestrictive }), ...overlaps]),
    notActing: Object.freeze(notActing.map(entry => Object.freeze({ ...entry.item, temporalScope: entry.temporalScope, freshness: entry.freshness }))),
    unresolved: Object.freeze([...unresolvedFor({ rule, strongAffirmative, wholeCorridor, lowerTierRestriction, actingCommunityRestrictive, attention, decorated }),
      ...overlaps.map(overlap => Object.freeze({ code: overlap.kind, text: overlap.note }))]),
    qualifiers: Object.freeze(qualifiersOf({ rule, organizations, decorated, actingRestrictive })),
    scope: Object.freeze({ wholeCorridor,
      parts: Object.freeze([...new Set(strongAffirmative.map(entry => entry.item.geographicScope.corridorPart).filter(Boolean))]),
      note: scopeNote(strongAffirmative) }),
    evidenceCounts: Object.freeze({ total: items.length, affirmative: affirmative.length, restrictive: restrictive.length, attention: attention.length, neutral: neutral.length,
      tier1: items.filter(item => tierOf(item.sourceClass) === 1).length, tier2: items.filter(item => tierOf(item.sourceClass) === 2).length,
      tier3: items.filter(item => tierOf(item.sourceClass) === 3).length, tier4: items.filter(item => tierOf(item.sourceClass) === 4).length }),
    organizations: Object.freeze(organizations),
    provisionalFinding,
    findingChangedByReview: provisionalFinding != null && provisionalFinding !== rule.finding,
    review: review ?? null,
  });
}

function newestRetrieval(decorated) {
  const dates = decorated.map(entry => entry.item.retrievedAt ?? entry.item.publishedAt).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

// The affirmative side of the finding, in the UI's words. Deliberately coarse: it describes how the cited
// sources speak about the road, not how good the road is.
// How strong the *affirmative* side is, independent of the finding. A temporary closure does not unmake the
// evidence that the road is public, and a status conflict must not be presented as a verified public road.
function publicRoadEvidenceLabel(rule, strongAffirmative, affirmative) {
  const wholeCorridor = strongAffirmative.some(entry => entry.item.geographicScope.scope === EVIDENCE_SCOPE.CORRIDOR);
  if (rule.finding === ACCESS_FINDING.CONFLICTED) return strongAffirmative.length ? 'DISPUTED' : 'NONE';
  if (wholeCorridor) return 'VERIFIED';
  if (strongAffirmative.length) return 'PARTIAL';
  if (affirmative.length) return 'COMMUNITY ONLY';
  return 'NONE';
}

function motorVehicleLabel(rule) {
  if (rule.finding === ACCESS_FINDING.RESTRICTED_OR_CLOSED) return 'RESTRICTED OR CLOSED';
  if (rule.finding === ACCESS_FINDING.VERIFIED_PUBLIC) return 'VERIFIED';
  if (rule.finding === ACCESS_FINDING.PROBABLE_PUBLIC || rule.finding === ACCESS_FINDING.CONFLICTED) return 'PROBABLE ONLY';
  return 'UNVERIFIED';
}

function contradictionsOf({ statusConflict, lowerTierRestriction, notActing, actingRestrictive }) {
  const list = [];
  if (statusConflict) list.push({ kind: 'STATUS_DISAGREEMENT', evidenceIds: Object.freeze([statusConflict.item.id]),
    note: `A source of comparable reliability claims ${statusConflict.item.claimType} while other sources support public access.` });
  if (lowerTierRestriction) list.push({ kind: 'LOWER_TIER_RESTRICTION', evidenceIds: Object.freeze([lowerTierRestriction.item.id]),
    note: `${lowerTierRestriction.item.sourceOrganization} claims ${lowerTierRestriction.item.claimType}. This is community-tier evidence: it does not override an authoritative source, and it is not dismissed either.` });
  for (const entry of notActing) list.push({ kind: 'NOT_CURRENT', evidenceIds: Object.freeze([entry.item.id]),
    note: `A restriction claim (${entry.item.claimType}) is ${entry.temporalScope.toLowerCase()} and cannot act on this finding.` });
  for (const entry of actingRestrictive) list.push({ kind: 'ACTING_RESTRICTION', evidenceIds: Object.freeze([entry.item.id]),
    note: `${entry.item.sourceOrganization} documents ${entry.item.claimType} (${entry.temporalScope.toLowerCase()})${entry.item.geographicScope.corridorPart ? ` for ${entry.item.geographicScope.corridorPart}` : ''}.` });
  return list.map(entry => Object.freeze(entry));
}

function unresolvedFor({ rule, strongAffirmative, wholeCorridor, lowerTierRestriction, actingCommunityRestrictive, attention, decorated }) {
  const list = [];
  if (rule.id === 'R1_NO_ACCESS_EVIDENCE') list.push({ code: 'NO_SOURCE_RETRIEVED', text: "No access source was retrieved for this corridor. Absence of a source is not evidence that the road is private or closed." });
  if (rule.id === 'R9_NO_DECIDING_EVIDENCE') list.push({ code: 'NO_DECIDING_CLAIM', text: "Sources were retrieved, but none states the road's access status." });
  if (strongAffirmative.length && !wholeCorridor) list.push({ code: 'CORRIDOR_PART_ONLY', text: 'Authoritative evidence covers only part of this corridor; no direct source covers the remainder.' });
  if (!strongAffirmative.length && rule.finding !== ACCESS_FINDING.UNVERIFIED) list.push({ code: 'NO_AUTHORITATIVE_SOURCE', text: 'No authoritative source was retrieved; the finding rests on community-tier evidence.' });
  if (lowerTierRestriction) list.push({ code: 'UNREBUTTED_COMMUNITY_RESTRICTION', text: `${lowerTierRestriction.item.sourceOrganization} claims ${lowerTierRestriction.item.claimType} and no authoritative source rebuts it.` });
  if (!strongAffirmative.length && actingCommunityRestrictive.length) list.push({ code: 'COMMUNITY_RESTRICTION_NO_AUTHORITY', text: `Community-mapped evidence (${[...new Set(actingCommunityRestrictive.map(entry => entry.item.sourceOrganization))].join(', ')}) states ${[...new Set(actingCommunityRestrictive.map(entry => entry.item.claimType))].join(', ')} and no authoritative source was retrieved to confirm or refute it. Access stays UNVERIFIED.` });
  for (const entry of attention.filter(entry => entry.item.claimType === ACCESS_CLAIM.ROAD_NAME_VARIANT)) list.push({ code: 'ROAD_NAME_VARIANT', text: entry.item.summary });
  if (decorated.some(entry => entry.freshness.state === FRESHNESS_STATE.STALE)) list.push({ code: 'STALE_EVIDENCE', text: `Evidence older than ${CURRENT_WINDOW_DAYS} days is flagged stale and did not decide this finding.` });
  if (decorated.some(entry => entry.freshness.state === FRESHNESS_STATE.UNDATED)) list.push({ code: 'UNDATED_EVIDENCE', text: 'At least one cited source has no publication date, so its currency cannot be established.' });
  return list.map(entry => Object.freeze(entry));
}

function qualifiersOf({ rule, organizations, decorated, actingRestrictive }) {
  const list = [];
  if (organizations.length === 1) list.push(`All authoritative affirmative evidence comes from one organization (${organizations[0]}); no independent corroboration was retrieved.`);
  if (!organizations.length && rule.finding === ACCESS_FINDING.PROBABLE_PUBLIC) list.push('No authoritative source was retrieved, so this rests on community-mapped evidence.');
  for (const entry of actingRestrictive) {
    const window = entry.item.effectiveUntil ? `published end date ${entry.item.effectiveUntil.slice(0, 10)}${entry.item.effectiveFrom ? `, start ${entry.item.effectiveFrom.slice(0, 10)}` : ''}`
      : entry.item.recurrence ? `recurs (${entry.item.recurrence})` : 'no stated end date';
    list.push(`Restriction in scope: ${entry.item.claimType}${entry.item.geographicScope.corridorPart ? ` — ${entry.item.geographicScope.corridorPart}` : ''} (${window}).`);
  }
  const stale = decorated.filter(entry => entry.freshness.state === FRESHNESS_STATE.STALE);
  if (stale.length) list.push(`${stale.length} cited item(s) are older than ${CURRENT_WINDOW_DAYS} days and are flagged stale.`);
  list.push('This is what the cited sources published as of the check date. It is not a legal determination and not a warranty of current passability.');
  return list;
}

function scopeNote(strongAffirmative) {
  if (!strongAffirmative.length) return 'No authoritative evidence identifies which part of the corridor it speaks about.';
  const scopes = [...new Set(strongAffirmative.map(entry => entry.item.geographicScope.scope))];
  if (scopes.includes(EVIDENCE_SCOPE.CORRIDOR)) return 'At least one authoritative source speaks about the corridor as a whole.';
  return `Authoritative evidence covers part of the corridor only (${scopes.join(', ').toLowerCase().replace(/_/g, ' ')}).`;
}

// ADVERSARIAL REVIEW. Deliberately asks what would show the provisional finding is wrong. Every check is
// deterministic and produces a recorded outcome; a concern never disappears silently.
export const ADVERSARIAL_CHECKS = Object.freeze([
  Object.freeze({ id: 'ACTING_RESTRICTION', question: 'Is a restriction in force today, and does it survive an expiry check?' }),
  Object.freeze({ id: 'NEGATIVE_CASE_CONFIRMED', question: 'For a restrictive finding, is the restriction documented by a source and scoped, rather than assumed?' }),
  Object.freeze({ id: 'CORRIDOR_PARTIAL', question: 'Does the evidence cover only part of the corridor?' }),
  Object.freeze({ id: 'SINGLE_ORGANIZATION', question: 'Does the whole finding rest on one organization with no independent corroboration?' }),
  Object.freeze({ id: 'WEAK_SOURCE_ONLY', question: 'Does any part of the finding rest only on community or anecdotal evidence?' }),
  Object.freeze({ id: 'STALE_EVIDENCE', question: 'Is any deciding evidence older than the freshness window?' }),
  Object.freeze({ id: 'NAME_VARIANT', question: 'Does any cited source describe a similarly named but different road?' }),
  Object.freeze({ id: 'AUTHORITY_OVERLAP', question: 'Do two organizations both claim to control or maintain this road?' }),
  Object.freeze({ id: 'EVIDENCE_ABSENCE', question: 'Is the finding resting on the absence of a source rather than on a source?' }),
]);

export function adversarialReview({ finding, checkedAt }) {
  if (!finding?.finding) throw new TypeError('Adversarial review needs a provisional finding');
  const acting = finding.restrictions.filter(item => isActingScope(item.temporalScope));
  const checks = [];
  const push = (id, outcome, note, evidenceIds = []) => checks.push(Object.freeze({ id,
    question: ADVERSARIAL_CHECKS.find(check => check.id === id).question, outcome, note, evidenceIds: Object.freeze(evidenceIds) }));
  push('ACTING_RESTRICTION', acting.length ? 'CONCERN' : 'PASS',
    acting.length ? `${acting.length} restriction(s) act on this finding and are reported with their scope and expiry.` : 'No restriction with a current or recurring scope was found.',
    acting.map(item => item.id));
  const restrictiveFinding = finding.finding === ACCESS_FINDING.RESTRICTED_OR_CLOSED;
  push('NEGATIVE_CASE_CONFIRMED', restrictiveFinding ? (finding.ruleId === 'R3_CURRENT_RESTRICTION' || finding.ruleId === 'R4_RECURRING_RESTRICTION' ? 'PASS' : 'UNRESOLVED') : 'NOT_APPLICABLE',
    restrictiveFinding ? 'The restriction comes from the cited source with a computed temporal scope, not from an assumption.' : 'The finding is not restrictive, so no negative case needed confirming.');
  push('CORRIDOR_PARTIAL', finding.scope.wholeCorridor ? 'PASS' : 'CONCERN',
    finding.scope.wholeCorridor ? 'At least one authoritative source speaks about the whole corridor.' : finding.scope.note,
    finding.affirmative.map(item => item.id));
  push('SINGLE_ORGANIZATION', finding.organizations.length === 1 ? 'CONCERN' : finding.organizations.length ? 'PASS' : 'NOT_APPLICABLE',
    finding.organizations.length === 1 ? `Only ${finding.organizations[0]} was retrieved as an authoritative source.` : `${finding.organizations.length} authoritative organization(s) retrieved.`);
  const weakOnly = !finding.affirmative.length && finding.community.length > 0;
  push('WEAK_SOURCE_ONLY', weakOnly ? 'CONCERN' : 'PASS',
    weakOnly ? 'Public access rests on community-tier evidence only.' : 'At least one authoritative source supports the finding.',
    finding.community.map(item => item.id));
  push('STALE_EVIDENCE', finding.notActing.length ? 'CONCERN' : 'PASS',
    finding.notActing.length ? `${finding.notActing.length} restriction item(s) are expired, stale, or undated and could not act on the finding.` : 'No expired or stale restriction was excluded from the decision.',
    finding.notActing.map(item => item.id));
  const variants = finding.attention.filter(item => item.claimType === ACCESS_CLAIM.ROAD_NAME_VARIANT);
  push('NAME_VARIANT', variants.length ? 'CONCERN' : 'PASS', variants.length ? variants.map(item => item.summary).join(' ') : 'No similarly named road appears in the retrieved sources.', variants.map(item => item.id));
  const overlaps = finding.contradictions.filter(entry => entry.kind === 'MULTIPLE_AUTHORITY_CLAIMS');
  push('AUTHORITY_OVERLAP', overlaps.length ? 'CONCERN' : 'PASS', overlaps.length ? overlaps.map(entry => entry.note).join(' ') : 'Only one organization publishes a maintenance or authority claim for this road.',
    overlaps.flatMap(entry => entry.evidenceIds));
  push('EVIDENCE_ABSENCE', finding.ruleId === 'R1_NO_ACCESS_EVIDENCE' ? 'UNRESOLVED' : 'PASS',
    finding.ruleId === 'R1_NO_ACCESS_EVIDENCE' ? 'Nothing was found, which is recorded as UNVERIFIED rather than as evidence that the road is private.' : 'The finding cites at least one source.');
  const concerns = checks.filter(check => check.outcome === 'CONCERN' || check.outcome === 'UNRESOLVED').map(check => check.id);
  return Object.freeze({ checkedAt: new Date(checkedAt).toISOString(), checks: Object.freeze(checks), concerns: Object.freeze(concerns),
    conclusion: concerns.length ? `${concerns.length} adversarial concern(s) recorded. They are shown with the finding and never amend it silently.`
      : 'No adversarial concern was recorded for the provisional finding.' });
}

// A second kind of disagreement: two organizations publishing a maintenance or authority claim for the same
// road, where at least one claim speaks about the corridor as a whole. For a cross-county road this is
// expected; for a road transferred between jurisdictions it can mean one source is stale. It is recorded as
// an unresolved item, never as a silent preference for one organization.
function authorityOverlaps(entries) {
  const claims = entries.filter(entry => entry.item.claimType === ACCESS_CLAIM.ROAD_MAINTAINED && entry.item.geographicScope.scope !== EVIDENCE_SCOPE.NOT_APPLICABLE && entry.item.appliesTo);
  const overlaps = [];
  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const a = claims[left].item, b = claims[right].item;
      if (a.sourceOrganization === b.sourceOrganization) continue;
      if (roadNameRelation(a.appliesTo, b.appliesTo) === ROAD_NAME_RELATION.DIFFERENT) continue;
      if (a.geographicScope.scope !== EVIDENCE_SCOPE.CORRIDOR && b.geographicScope.scope !== EVIDENCE_SCOPE.CORRIDOR) continue;
      overlaps.push(Object.freeze({ kind: 'MULTIPLE_AUTHORITY_CLAIMS', evidenceIds: Object.freeze([a.id, b.id]),
        note: `${a.sourceOrganization} (${sectionOf(a)}) and ${b.sourceOrganization} (${sectionOf(b)}) both publish a road-maintenance or authority claim naming this road. One of them may be out of date; Road Naturalist does not decide which.` }));
    }
  }
  return overlaps;
}

const sectionOf = item => item.geographicScope.corridorPart ?? (item.geographicScope.scope === EVIDENCE_SCOPE.CORRIDOR ? 'whole corridor' : item.geographicScope.scope.toLowerCase().replace(/_/g, ' '));
