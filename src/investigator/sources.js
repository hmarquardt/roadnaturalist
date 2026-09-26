// THE OREGON PILOT RESEARCH PLAN.
//
// Two reviewable things live here:
//
//   1. deriveAuthorities() — which organizations *might* control this road, derived from the corridor's own
//      deterministic facts (county, road class, route type). This is a starting point for research, recorded
//      as a derived fact with its basis. Road Naturalist never assumes an authority from geography alone, and
//      it never turns "we did not find a source" into a statement about the road.
//   2. PILOT_PROBES — the declared sources and the verbatim phrases each probe looks for. A probe's fact is
//      only evidence when the phrase is present in what the source actually served, so every quote in the
//      Investigator is a substring of a retrieved document, never typed from memory.
//
// The phrases below were read from the live pages and then verified against the served HTML/JSON by
// scripts/verify-investigator-live.mjs (see data/investigator/or-pilot-access-evidence.json for the capture
// date). Re-running the script re-checks each phrase at its source and reports drift.
import { CLAIM_STRENGTH, EVIDENCE_SCOPE, RECURRENCE, SOURCE_CLASS } from './access.js';
import { PROBE_KIND, PROBE_STAGE, createProbe } from './research.js';

export const AUTHORITY_ROLE = Object.freeze({
  COUNTY_ROAD_AUTHORITY: 'county-road-authority',
  STATE_TRANSPORTATION: 'state-transportation-agency',
  MUNICIPAL: 'municipal',
  LAND_MANAGER: 'land-manager',
  UNKNOWN: 'unknown',
});

// Authorities are candidates, not findings: each entry says which deterministic fact put it on the list.
export function deriveAuthorities(roads = []) {
  if (!Array.isArray(roads)) throw new TypeError('Authority discovery needs the corridor roads');
  const authorities = [];
  const counties = [...new Set(roads.map(road => road.county?.name).filter(Boolean))];
  for (const county of counties) {
    const short = county.replace(/, Oregon$/, '').replace(/ County$/, '');
    authorities.push(Object.freeze({ id: `county:${slug(short)}`, name: `${short} County road authority`, short, role: AUTHORITY_ROLE.COUNTY_ROAD_AUTHORITY,
      basis: `The corridor's TIGER/Line road records name ${county}; that county is a possible road authority and is a starting point for research, not a source statement about this road.`, derived: true }));
  }
  const routeTypes = [...new Set(roads.map(road => road.routeType?.value?.code).filter(Boolean))];
  const roadClasses = [...new Set(roads.map(road => road.roadClass?.value?.code).filter(Boolean))];
  const stateLike = routeTypes.some(code => ['I', 'U', 'S'].includes(code)) || roadClasses.some(code => code === 'S1100');
  if (stateLike) authorities.push(Object.freeze({ id: 'state:odot', name: 'Oregon Department of Transportation', short: 'ODOT', role: AUTHORITY_ROLE.STATE_TRANSPORTATION,
    basis: `The corridor's source road attributes include route type ${routeTypes.join('/') || 'n/a'} and road class ${roadClasses.join('/') || 'n/a'}, which can indicate a state or federal route; the agency itself is confirmed only by evidence.`, derived: true }));
  authorities.push(Object.freeze({ id: 'city:unknown', name: 'Municipal authority (not established)', short: 'city', role: AUTHORITY_ROLE.MUNICIPAL,
    basis: 'No municipal-boundary dataset is loaded, so Road Naturalist does not assume a city is involved.', derived: false }));
  authorities.push(Object.freeze({ id: 'land-manager:unknown', name: 'Land-management agency (not established)', short: 'land manager', role: AUTHORITY_ROLE.LAND_MANAGER,
    basis: 'No land-management dataset is loaded, so Road Naturalist does not infer an agency from geography.', derived: false }));
  return authorities;
}

export const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// The pilot corridors this catalog covers. A probe limited to `corridorIds` runs only for those corridors.
export const PILOT_CORRIDOR_IDS = Object.freeze(['or-roads-cornelius-pass-rd', 'or-roads-springville-rd', 'or-roads-susbauer-rd']);

const COUNTY_WA = 'Washington County Land Use & Transportation';
const COUNTY_MULT = 'Multnomah County Transportation';
const ODOT = 'Oregon Department of Transportation';

// Probe catalog. `authority` ties each probe to a derived authority (or to a county service of one), so the
// authority-discovery stage is auditable: a probe whose authority was not derived is reported as such.
export const PILOT_PROBES = Object.freeze([
  // ---- Cornelius Pass Rd: who says this road is public? --------------------------------------------
  createProbe({
    id: 'odot-cornelius-transfer', stage: PROBE_STAGE.ACCESS_RESEARCH, kind: PROBE_KIND.AUTHORITY,
    organization: ODOT, authority: 'state:odot', sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'state agency bulletin',
    title: 'Cornelius Pass Road Jurisdictional Transfer Complete (ODOT bulletin, March 1 2021)',
    url: 'https://content.govdelivery.com/accounts/ORDOT/bulletins/2c218b2',
    question: 'Does an authoritative source state that this road is a public road?',
    appliesTo: 'NW Cornelius Pass Road',
    corridorIds: ['or-roads-cornelius-pass-rd'],
    facts: [
      { find: 'NW Cornelius Pass Road between U.S. 30 and U.S. 26 is a state highway as of Monday, March 1 after a jurisdictional transfer from Multnomah County and Washington County.',
        claimType: 'PUBLIC_ROAD', claimValue: 'state highway OR 127', claimStrength: CLAIM_STRENGTH.STATED, scope: EVIDENCE_SCOPE.CORRIDOR,
        summary: 'ODOT states that NW Cornelius Pass Road between U.S. 30 and U.S. 26 became a state highway on March 1 2021, transferred from Multnomah and Washington counties.' },
      { find: 'As a state highway, the road will be subject to ODOT standards for design and maintenance',
        claimType: 'ROAD_MAINTAINED', claimValue: 'ODOT design and maintenance standards', claimStrength: CLAIM_STRENGTH.STATED, scope: EVIDENCE_SCOPE.CORRIDOR,
        summary: 'ODOT states the road is subject to ODOT standards for design and maintenance.' },
    ],
  }),
  createProbe({
    id: 'wc-cornelius-bridge-project', stage: PROBE_STAGE.CONTRADICTION_SEARCH, kind: PROBE_KIND.CLOSURE,
    organization: COUNTY_WA, authority: 'county:washington', sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'county project page',
    title: 'Cornelius Pass Road Bridge at Rock Creek Replacement (Washington County project page)',
    url: 'https://www.washingtoncountyor.gov/lut/projects/cornelius-pass-road-bridge-rock-creek',
    question: 'Is any part of this road closed, gated, or restricted right now, and who controls it?',
    appliesTo: 'Cornelius Pass Road',
    corridorIds: ['or-roads-cornelius-pass-rd'],
    facts: [
      { find: 'Road closure has been extended to October 7, 2026', claimType: 'TEMPORARY_CLOSURE', claimValue: 'full closure for bridge replacement',
        claimStrength: CLAIM_STRENGTH.STATED, scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'bridge over Rock Creek, north of Germantown Road',
        effectiveFrom: '2026-07-15', effectiveUntil: '2026-10-07', windowQuote: 'Road closure has been extended to October 7, 2026',
        summary: 'Washington County states the full road closure for the Rock Creek bridge replacement is extended to October 7 2026.' },
      { find: 'Jurisdiction of Cornelius Pass Road has transferred to ODOT, and is now OR 127.', claimType: 'LAND_MANAGER', claimValue: 'ODOT (OR 127)',
        claimStrength: CLAIM_STRENGTH.STATED, scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'the OR 127 section',
        summary: 'Washington County states jurisdiction of Cornelius Pass Road transferred to ODOT and the road is now OR 127.' },
      { find: 'Once complete, the bridge will be transferred to ODOT for all future maintenance.', claimType: 'LAND_MANAGER', claimValue: 'ODOT (future maintenance)',
        claimStrength: CLAIM_STRENGTH.STATED, scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'the new Rock Creek bridge',
        summary: 'Washington County states the replacement bridge will be transferred to ODOT for future maintenance.' },
      { find: 'No trucks are allowed on Old Cornelius Pass Road.', claimType: 'ROAD_NAME_VARIANT', claimValue: 'Old Cornelius Pass Road',
        claimStrength: CLAIM_STRENGTH.STATED, scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'Old Cornelius Pass Road (a separate road used as the detour)',
        summary: 'The county detour notice restricts trucks on Old Cornelius Pass Road, which is not the corridor: a similarly named but different road. The restriction does not apply to NW Cornelius Pass Rd.' },
    ],
  }),
  createProbe({
    id: 'wc-cornelius-closure-news', stage: PROBE_STAGE.CONTRADICTION_SEARCH, kind: PROBE_KIND.CLOSURE,
    organization: COUNTY_WA, authority: 'county:washington', sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'county news release',
    title: 'Safety and Freight Improvements: Cornelius Pass Road Bridge Replacement at Rock Creek (July 9 2026)',
    url: 'https://www.washingtoncountyor.gov/lut/news/2026/07/09/safety-and-freight-improvements-cornelius-pass-road-bridge-replacement-rock-creek',
    question: 'Which exact section of the road is closed, and for how long?',
    appliesTo: 'Cornelius Pass Road (OR-127)',
    corridorIds: ['or-roads-cornelius-pass-rd'],
    facts: [
      { find: 'Cornelius Pass Road (OR-127) will be closed between Germantown Road and Kaiser Road from July 15 to October 7, 2026',
        claimType: 'TEMPORARY_CLOSURE', claimValue: 'full closure between Germantown Road and Kaiser Road', claimStrength: CLAIM_STRENGTH.STATED,
        scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'between Germantown Road and Kaiser Road',
        effectiveFrom: '2026-07-15', effectiveUntil: '2026-10-07', windowQuote: 'from July 15 to October 7, 2026',
        summary: 'Washington County states Cornelius Pass Road (OR-127) is closed between Germantown Road and Kaiser Road from July 15 to October 7 2026, with detours in place.' },
    ],
  }),
  createProbe({
    id: 'wc-roads-cornelius-advisory', stage: PROBE_STAGE.CONTRADICTION_SEARCH, kind: PROBE_KIND.CLOSURE,
    organization: 'Washington County Road Closures & Traffic Advisories (wc-roads.com)', authority: 'county:washington',
    sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'county road-status service',
    title: 'Road Closures & Traffic Advisories (current advisory list)',
    url: 'https://www.wc-roads.com/',
    question: 'Does the county road-status service list a current restriction on this road?',
    appliesTo: 'Cornelius Pass Road',
    corridorIds: ['or-roads-cornelius-pass-rd'],
    facts: [
      { find: 'Cornelius Pass Road From/To: At Rock Creek (View Detour Map) Impact: Road closure Reason: Bridge replacement Schedule: From: 07/15/2026 To: 10/07/2026 Use alternate route',
        claimType: 'TEMPORARY_CLOSURE', claimValue: 'road closure at Rock Creek', claimStrength: CLAIM_STRENGTH.STATED,
        scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'at Rock Creek',
        effectiveFrom: '2026-07-15', effectiveUntil: '2026-10-07', windowQuote: 'To: 10/07/2026',
        summary: 'The county advisory list carries a current road closure on Cornelius Pass Road at Rock Creek for bridge replacement, 07/15/2026 to 10/07/2026.' },
    ],
  }),
  createProbe({
    id: 'mc-cornelius-rcip', stage: PROBE_STAGE.ACCESS_RESEARCH, kind: PROBE_KIND.AUTHORITY,
    organization: COUNTY_MULT, authority: 'county:multnomah', sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'county capital plan',
    title: 'Multnomah County Roads Capital Improvement Plan — project rankings (last reviewed December 3 2024)',
    url: 'https://multco.us/info/rcip-project-rankings',
    question: 'Does the other county that names this road still treat it as a road it maintains?',
    appliesTo: 'NW Cornelius Pass Road',
    corridorIds: ['or-roads-cornelius-pass-rd'],
    facts: [
      { find: 'NW Cornelius Pass Road: Highway 30 - Skyline Boulevard', claimType: 'ROAD_MAINTAINED', claimValue: 'ranked county road project',
        claimStrength: CLAIM_STRENGTH.STATED, scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'Highway 30 – Skyline Boulevard (Multnomah County section)',
        summary: 'Multnomah County lists NW Cornelius Pass Road (Highway 30 – Skyline Boulevard) among the road projects in its Roads Capital Improvement Plan.' },
      { find: 'NW Cornelius Pass Road: Skyline Boulevard - County Line', claimType: 'ROAD_MAINTAINED', claimValue: 'ranked county road project',
        claimStrength: CLAIM_STRENGTH.STATED, scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'Skyline Boulevard – county line (Multnomah County section)',
        summary: 'Multnomah County lists NW Cornelius Pass Road (Skyline Boulevard – County Line) among the road projects in its Roads Capital Improvement Plan.' },
    ],
  }),
  createProbe({
    id: 'wc-mstip-cornelius-roadsafety', stage: PROBE_STAGE.ACCESS_RESEARCH, kind: PROBE_KIND.ROAD_STATUS,
    organization: COUNTY_WA, authority: 'county:washington', sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'county funding program',
    title: 'Multnomah/Washington County MSTIP 3f funding allocation',
    url: 'https://www.washingtoncountyor.gov/lut/mstip-3f-funding-allocation',
    question: 'Does the county funding program name this road?',
    appliesTo: 'Cornelius Pass Road',
    corridorIds: ['or-roads-cornelius-pass-rd'],
    facts: [
      { find: 'Cornelius Pass Road', claimType: 'PUBLIC_ROAD', claimValue: 'funded county road project', scope: EVIDENCE_SCOPE.CORRIDOR_PART,
        summary: 'The county funding program names Cornelius Pass Road.' },
    ],
  }),
]);

// ---- Springville Rd: two counties, one named road ------------------------------------------------
export const SPRINGVILLE_PROBES = Object.freeze([
  createProbe({
    id: 'wc-springville-phase4', stage: PROBE_STAGE.ACCESS_RESEARCH, kind: PROBE_KIND.ROAD_STATUS,
    organization: COUNTY_WA, authority: 'county:washington', sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'county project page',
    title: 'Springville Road Phase 4 (Joss Avenue to PCC Rock Creek), Washington County',
    url: 'https://www.washingtoncountyor.gov/lut/projects/springville-road-phase-4',
    question: 'Does the county describe this road as part of its own street system, and for which section?',
    appliesTo: 'Springville Road', corridorIds: ['or-roads-springville-rd'],
    facts: [
      { find: 'Springville Road Phase 4 is the middle and final section of the urban street improvements for Springville Road between 185th Avenue and Kaiser Road.',
        claimType: 'PUBLIC_ROAD', claimValue: 'county street improvement project', claimStrength: CLAIM_STRENGTH.STATED,
        scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: '185th Avenue to Kaiser Road (North Bethany urban section)',
        summary: 'Washington County states that its Springville Road Phase 4 project is the final section of urban street improvements for Springville Road between 185th Avenue and Kaiser Road.' },
      { find: 'Funding source: North Bethany County Service District for Roads (NBCSDR)',
        claimType: 'ROAD_MAINTAINED', claimValue: 'county service district for roads', claimStrength: CLAIM_STRENGTH.STATED,
        scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: '185th Avenue to Kaiser Road',
        summary: 'Washington County states the Springville Road improvements are funded by the North Bethany County Service District for Roads.' },
    ],
  }),
  createProbe({
    id: 'wc-springville-improvements-news', stage: PROBE_STAGE.ACCESS_RESEARCH, kind: PROBE_KIND.ROAD_STATUS,
    organization: COUNTY_WA, authority: 'county:washington', sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'county news release',
    title: 'Celebrate Springville Road Improvements! (April 2 2026)',
    url: 'https://www.washingtoncountyor.gov/index.php/lut/news/2026/04/02/celebrate-springville-road-improvements',
    question: 'Which section of this road is maintained by the county, and when did that work finish?',
    appliesTo: 'Springville Road', corridorIds: ['or-roads-springville-rd'],
    facts: [
      { find: 'Improvements to Springville Road were supported by the North Bethany County Service District for Roads',
        claimType: 'ROAD_MAINTAINED', claimValue: 'county service district for roads', claimStrength: CLAIM_STRENGTH.STATED,
        scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: '185th Avenue to Kaiser Road',
        summary: 'Washington County states the Springville Road improvements were supported by the North Bethany County Service District for Roads, and describes four completed phases.' },
      { find: 'The work improved Springville Road from 185th Avenue intersection to Kaiser Road in four phases:',
        claimType: 'PUBLIC_ROAD', claimValue: 'county street improvement project', claimStrength: CLAIM_STRENGTH.STATED,
        scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: '185th Avenue to Kaiser Road',
        summary: 'Washington County states the completed work improved Springville Road from the 185th Avenue intersection to Kaiser Road.' },
    ],
  }),
  createProbe({
    id: 'mc-springville-rcip', stage: PROBE_STAGE.ACCESS_RESEARCH, kind: PROBE_KIND.AUTHORITY,
    organization: COUNTY_MULT, authority: 'county:multnomah', sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'county capital plan',
    title: 'Multnomah County Roads Capital Improvement Plan — project rankings (last reviewed December 3 2024)',
    url: 'https://multco.us/info/rcip-project-rankings',
    question: 'Does the other county that this road runs into list it as one of its roads?',
    appliesTo: 'NW Springville Road', corridorIds: ['or-roads-springville-rd'],
    facts: [
      { find: 'NW Springville Road: City of Portland line to Washington County line',
        claimType: 'ROAD_MAINTAINED', claimValue: 'ranked county road project', claimStrength: CLAIM_STRENGTH.STATED,
        scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'City of Portland line to Washington County line (Multnomah County section)',
        summary: 'Multnomah County lists NW Springville Road (City of Portland line to Washington County line) among the road projects in its Roads Capital Improvement Plan.' },
    ],
  }),
  createProbe({
    id: 'wc-roads-springville-advisory', stage: PROBE_STAGE.CONTRADICTION_SEARCH, kind: PROBE_KIND.CLOSURE,
    organization: 'Washington County Road Closures & Traffic Advisories (wc-roads.com)', authority: 'county:washington',
    sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'county road-status service',
    title: 'Road Closures & Traffic Advisories (current advisory list)',
    url: 'https://www.wc-roads.com/',
    question: 'Does the county road-status service list any current restriction on this road?',
    appliesTo: 'Springville Road', corridorIds: ['or-roads-springville-rd'],
    facts: [
      { find: 'Springville Road', claimType: 'TEMPORARY_CLOSURE', claimValue: 'listed road closure', scope: EVIDENCE_SCOPE.CORRIDOR_PART,
        summary: 'The county advisory list carries an entry naming Springville Road.' },
    ],
  }),
]);

// ---- Susbauer Rd: a rural county road with flood gates --------------------------------------------
export const SUSBAUER_PROBES = Object.freeze([
  createProbe({
    id: 'wc-flooding-susbauer', stage: PROBE_STAGE.ACCESS_RESEARCH, kind: PROBE_KIND.CLOSURE,
    organization: COUNTY_WA, authority: 'county:washington', sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'county road-maintenance page',
    title: 'Flooding and Winds (Washington County road maintenance)',
    url: 'https://www.washingtoncountyor.gov/lut/road-maintenance/flooding-winds',
    question: 'Does the county document a recurring closure or gate on this road, and who maintains it?',
    appliesTo: 'Susbauer Road', corridorIds: ['or-roads-susbauer-rd'],
    facts: [
      { find: 'Susbauer and Fern Hill roads both flood often during heavy rainfall.',
        claimType: 'SEASONAL_CLOSURE', claimValue: 'recurring high-water flooding', claimStrength: CLAIM_STRENGTH.STATED,
        scope: EVIDENCE_SCOPE.CORRIDOR, recurrence: RECURRENCE.HIGH_WATER,
        recurrenceQuote: 'Susbauer and Fern Hill roads both flood often during heavy rainfall.',
        summary: 'Washington County states Susbauer and Fern Hill roads both flood often during heavy rainfall, and explains that its barricades close a road while high-water signs alone do not.' },
      { find: 'We have installed permanent, manual-locking flood gates on both these roads.',
        claimType: 'ROAD_MAINTAINED', claimValue: 'county-installed permanent flood gates', claimStrength: CLAIM_STRENGTH.STATED,
        scope: EVIDENCE_SCOPE.CORRIDOR,
        summary: 'Washington County states it installed permanent, manual-locking flood gates on Susbauer Road and manages its high-water closures. Road Naturalist reads county-installed, county-operated infrastructure as affirmative county-maintenance evidence (a derived reading of this source statement).' },
      { find: 'The gates on Susbauer Road are south of Hornecker Road and north of Long Road.',
        claimType: 'GATE_REPORTED', claimValue: 'permanent manual-locking flood gates', claimStrength: CLAIM_STRENGTH.STATED,
        scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'south of Hornecker Road and north of Long Road',
        summary: 'Washington County states the flood gates on Susbauer Road are south of Hornecker Road and north of Long Road.' },
    ],
  }),
  createProbe({
    id: 'wc-susbauer-flood-closure-news', stage: PROBE_STAGE.CONTRADICTION_SEARCH, kind: PROBE_KIND.CLOSURE,
    organization: COUNTY_WA, authority: 'county:washington', sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'county news release',
    title: 'Flood gates closed on Fern Hill and Susbauer roads; use alternate routes (December 30 2022)',
    url: 'https://www.washingtoncountyor.gov/lut/news/flood-gates-closed-fern-hill-and-susbauer-roads-use-alternate-routes-0',
    question: 'Has this road actually been closed, how, and does the source say it happens again?',
    appliesTo: 'Susbauer Road', corridorIds: ['or-roads-susbauer-rd'],
    facts: [
      { find: 'Susbauer is closed between Long and Hornecker roads.', claimType: 'SEASONAL_CLOSURE', claimValue: 'closed for high water',
        claimStrength: CLAIM_STRENGTH.STATED, scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'between Long and Hornecker roads',
        recurrence: RECURRENCE.HIGH_WATER, recurrenceQuote: 'Both roads frequently flood during periods of heavy rain.',
        summary: 'Washington County states Susbauer Road was closed between Long and Hornecker roads for high water, and that both roads frequently flood during heavy rain.' },
      { find: 'The flood gates at Fern Hill and Susbauer roads are closed due to high water.', claimType: 'GATE_REPORTED', claimValue: 'flood gates closed',
        claimStrength: CLAIM_STRENGTH.STATED, scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'flood gates',
        summary: 'Washington County states the flood gates at Fern Hill and Susbauer roads are closed due to high water and that all travelers must use alternate routes.' },
    ],
  }),
  createProbe({
    id: 'wc-mstip-susbauer', stage: PROBE_STAGE.ACCESS_RESEARCH, kind: PROBE_KIND.ROAD_STATUS,
    organization: COUNTY_WA, authority: 'county:washington', sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'county funding program',
    title: 'Multnomah/Washington County MSTIP 3f funding allocation',
    url: 'https://www.washingtoncountyor.gov/lut/mstip-3f-funding-allocation',
    question: 'Does a county funding program name this road as a county road with a funded project?',
    appliesTo: 'Susbauer Road', corridorIds: ['or-roads-susbauer-rd'],
    facts: [
      { find: 'Wren Road/Susbauer Road intersection', claimType: 'ROAD_MAINTAINED', claimValue: 'funded county intersection project',
        claimStrength: CLAIM_STRENGTH.STATED, scope: EVIDENCE_SCOPE.CORRIDOR_PART, corridorPart: 'Wren Road/Susbauer Road intersection',
        summary: 'The county funding allocation lists a Wren Road/Susbauer Road intersection improvement, naming Susbauer Road as part of the county road system.' },
    ],
  }),
  createProbe({
    id: 'mc-roads-susbauer', stage: PROBE_STAGE.ACCESS_RESEARCH, kind: PROBE_KIND.AUTHORITY,
    organization: COUNTY_MULT, authority: 'county:multnomah', sourceClass: SOURCE_CLASS.TIER_1_AUTHORITATIVE, sourceType: 'county roads overview',
    title: 'Our Roads (Multnomah County road maintenance)',
    url: 'https://multco.us/info/our-roads',
    question: 'Does the neighbouring county, which maintains its own roads, name this road?',
    appliesTo: 'Susbauer Road', corridorIds: ['or-roads-susbauer-rd'],
    facts: [
      { find: 'Susbauer Road', claimType: 'PUBLIC_ROAD', claimValue: 'county-maintained road', scope: EVIDENCE_SCOPE.CORRIDOR_PART,
        summary: 'Multnomah County names Susbauer Road as one of the roads it maintains.' },
    ],
  }),
]);

// One catalog for the pilot, plus a lookup by corridor.
export const PILOT_PROBES_BY_CORRIDOR = Object.freeze(Object.fromEntries(PILOT_CORRIDOR_IDS.map(id => [id,
  Object.freeze([...PILOT_PROBES, ...(id === 'or-roads-springville-rd' ? SPRINGVILLE_PROBES : id === 'or-roads-susbauer-rd' ? SUSBAUER_PROBES : [])].filter(probe => !probe.corridorIds || probe.corridorIds.includes(id)))])));
