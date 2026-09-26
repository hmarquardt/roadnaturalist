// THE OREGON PILOT RESEARCH PLAN.
//
// Two reviewable things live here:
//
//   1. deriveAuthorities() — which organizations *might* control this road, derived from the corridor's own
//      deterministic facts (county, road class, route type). This is a starting point for research, recorded
//      as a derived fact with its basis. Road Naturalist never assumes an authority from geography alone, and
//      it never turns "we did not find a source" into a statement about the road.
//   2. The declared sources themselves, loaded from the reviewed probe catalog.
//
// The declarations are data, not code: data/investigator/probe-catalog.json holds the public source URLs, the
// questions, and the verbatim phrases that count as facts, described by data/investigator/probe-catalog.schema.json.
// src/investigator/probes/catalog.js validates and normalizes that file, and the Worker loads the very same file, so
// the two sides cannot disagree about what a probe says. This module only adds authority derivation and the
// corridor → probe lookup the pipeline asks for.
//
// Adding or updating a corridor's sources is a reviewed change to the catalog, not to this module.
import { PROBE_CATALOG } from './probes/catalog.js';

export { PROBE_CATALOG };

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

// The corridors the catalog covers. A probe limited to `corridorIds` runs only for those corridors; a probe without
// them applies to every corridor here.
export const PILOT_CORRIDOR_IDS = PROBE_CATALOG.corridorIds;

// The probes for one corridor, in catalog order. A corridor the catalog does not cover has no declared sources, and
// that is reported as no research rather than as an empty result.
export const getProbesForCorridor = corridorId => PROBE_CATALOG.probesForCorridor(corridorId);

export const PILOT_PROBES_BY_CORRIDOR = Object.freeze(Object.fromEntries(PILOT_CORRIDOR_IDS.map(corridorId => [corridorId, getProbesForCorridor(corridorId)])));
