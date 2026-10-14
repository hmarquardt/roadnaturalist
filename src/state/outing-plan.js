import { boundsOf, haversineM, linesOf, vertexCount } from '../domain/geometry.js';
import { naturalistInterest } from '../discovery/ranking.js';
import { explorationOrder } from '../discovery/exploration-order.js';
import { storedSearchContext } from '../discovery/search-context.js';
import { METRES_PER_MILE } from '../discovery/search-area.js';
import { savedRoadRows } from './saved-roads.js';
import { storedPlanningContext } from './planning-context.js';

// AN OUTING, READ AS A PLAN: THE ROADS, THEIR OWN FACTS, AND THE GAP BETWEEN EACH PAIR.
//
// Everything here is derived from what is already stored - the saved road's own geometry, the measurements its score
// was computed from, and the search context its promotion verified. Nothing is fetched, nothing is measured again,
// and nothing is optimised: the order is the person's, and the separation between two consecutive roads is a straight
// line between two representative points, labelled as exactly that.
export const OUTING_SEPARATION_LABEL = 'Straight-line planning distance: approximate geographic separation between '
  + 'the roads themselves - not a driving distance, a travel time, or a route.';
export const OUTING_PLAN_NOTE = 'Distances between roads are approximate geographic separation between the roads '
  + 'themselves. Road Naturalist does not know whether these roads connect, are public or are passable, and it has '
  + 'not calculated a drive.';

// THE REPRESENTATIVE POINT OF A ROAD, in one documented rule:
//   1. the point the promotion measured against the person's own search centre, when the search had one - it is a
//      real, measured point on the road, and it is the same point the road's own distance was measured to;
//   2. otherwise half way along the road's composed geometry - deterministic, always on the road, and independent of
//      how many vertices a source happened to publish.
export function representativePoint(geometry, searchContext = null) {
  const nearest = searchContext?.nearestCenterPoint ?? null;
  if (Array.isArray(nearest) && nearest.length === 2 && nearest.every(Number.isFinite)) {
    return Object.freeze([Number(nearest[0]), Number(nearest[1])]);
  }
  return geometryMidpoint(geometry);
}

// WHICH OF THE TWO RULES PRODUCED THE POINT, so a plan can say where its own point came from - the separations it
// measures and the coordinate a navigation app is handed are the same point, and it is named once.
export const REPRESENTATIVE_RULE = Object.freeze({ MEASURED: 'measured-search-context', MIDPOINT: 'geometry-midpoint' });

export function representativeRule(geometry, searchContext = null) {
  const nearest = searchContext?.nearestCenterPoint ?? null;
  if (Array.isArray(nearest) && nearest.length === 2 && nearest.every(Number.isFinite)) return REPRESENTATIVE_RULE.MEASURED;
  return geometryMidpoint(geometry) ? REPRESENTATIVE_RULE.MIDPOINT : null;
}

export function geometryMidpoint(geometry) {
  const lines = linesOf(geometry);
  let total = 0;
  for (const line of lines) for (let index = 1; index < line.length; index++) total += haversineM(line[index - 1], line[index]);
  if (!(total > 0)) return null;
  let remaining = total / 2;
  for (const line of lines) {
    for (let index = 1; index < line.length; index++) {
      const leg = haversineM(line[index - 1], line[index]);
      if (leg <= 0) continue;
      if (remaining <= leg) {
        const t = remaining / leg;
        return Object.freeze([line[index - 1][0] + (line[index][0] - line[index - 1][0]) * t,
          line[index - 1][1] + (line[index][1] - line[index - 1][1]) * t]);
      }
      remaining -= leg;
    }
  }
  const last = lines[lines.length - 1] ?? [];
  return last.length ? Object.freeze([last[last.length - 1][0], last[last.length - 1][1]]) : null;
}

export function straightLineM(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second)) return null;
  if (!first.every(Number.isFinite) || !second.every(Number.isFinite)) return null;
  return haversineM(first, second);
}

// The saved roads an outing may reference, resolved once so the workspace and the map cannot disagree about which
// roads a plan has.
export function savedRoadsById(state) {
  return new Map(savedRoadRows(state).map(row => [String(row.candidate.id), row]));
}

// THE WORDS A DISTANCE BETWEEN TWO ROADS IS ALLOWED TO USE. One function, so the phrasing cannot drift between the list
// and anything else that shows it: a straight line between two roads is called a straight line, and it is never called a
// drive, a travel time or a route - because Road Naturalist has measured none of those and knows none of them.
export function separationLine(leg, { toName = 'the next road' } = {}) {
  if (!leg || leg.miles == null) {
    return `Geographic separation to ${toName} is not available here, because one of the two roads has no representative point.`;
  }
  return `≈ ${leg.miles.toFixed(1)} mi straight-line planning distance to ${toName}.`;
}

function member(roadId, index, entry) {
  const stop = index + 1;
  if (!entry) {
    return Object.freeze({ roadId, stop, resolved: false, name: null, geometry: null, representative: null,
      representativeRule: null,
      lengthM: null, naturalistInterest: null, interestVersion: null, explorationScore: null, explorationBasis: null,
      explorationRadiusMiles: null, distanceFromSearchCentreM: null, searchContext: null, favorite: false, note: '',
      intersectsWetland: null, crossingCount: null, ecoregionTransitions: null, recordedAt: null,
      unavailableReason: 'This road is not saved on this device any more.' });
  }
  const candidate = entry.candidate;
  const searchContext = storedSearchContext(candidate.searchContext);
  const planning = storedPlanningContext(candidate.planningContext);
  const interest = planning ? naturalistInterest(planning) : null;
  const radiusM = searchContext?.radiusMiles ? searchContext.radiusMiles * METRES_PER_MILE : null;
  // THE EXPLORATION ORDER IS PER MEMBER AND AGAINST ITS OWN SEARCH: each saved road carries the centre and radius of
  // the search that found it, so a plan assembled from two searches shows each road's own order rather than
  // pretending one centre describes them all. With no centre, no radius, or no kept measurements there is no order to
  // show, and the interest score stands alone.
  const order = planning ? explorationOrder({ ...planning, distanceFromCenterM: searchContext?.distanceFromCenterM },
    { radiusM }) : null;
  return Object.freeze({ roadId, stop, resolved: true, name: candidate.name ?? null,
    geometry: candidate.geometry ?? null, representative: representativePoint(candidate.geometry, searchContext),
    // THE RULE THAT PRODUCED THE POINT travels with it, so a plan can say where its own point came from, and the field
    // view can hand the same point to a navigation app without inventing a second one.
    representativeRule: representativeRule(candidate.geometry, searchContext),
    lengthM: candidate.corridor?.lengthM ?? null,
    naturalistInterest: interest?.score ?? null, interestVersion: interest?.version ?? null,
    // The two full results travel with the member, so the map's own card and the workspace read the same numbers from
    // the same computation rather than recomputing a second one that could disagree.
    interest, exploration: order,
    explorationScore: order?.score ?? null,
    explorationBasis: order ? (order.distanceFraction == null ? 'interest-only' : 'with-search-centre') : null,
    explorationRadiusMiles: searchContext?.radiusMiles ?? null,
    distanceFromSearchCentreM: searchContext?.distanceFromCenterM ?? null, searchContext,
    favorite: entry.meta?.favorite === true, note: entry.meta?.note ?? '',
    intersectsWetland: planning?.signals?.wetlands?.intersectsCorridor ?? null,
    wetlandArea250M2: planning?.signals?.wetlands?.area250M2 ?? null,
    crossingCount: planning?.signals?.hydrography?.crossingCount ?? null,
    ecoregionCount: planning?.ecology?.ecoregionCount ?? null,
    ecoregionTransitions: planning?.ecology?.transitions ?? null,
    recordedAt: planning?.recordedAt ?? null, unavailableReason: null });
}

function summarize(members) {
  const resolved = members.filter(entry => entry.resolved);
  const scores = resolved.map(entry => entry.naturalistInterest).filter(Number.isFinite);
  const geometry = resolved.length
    ? { type: 'MultiLineString', coordinates: resolved.flatMap(entry => linesOf(entry.geometry)) } : null;
  const bounds = geometry ? boundsOf(geometry) : null;
  const spanM = bounds ? straightLineM([bounds[0], bounds[1]], [bounds[2], bounds[3]]) : null;
  return Object.freeze({
    roads: members.length, resolved: resolved.length, unresolved: members.length - resolved.length,
    vertices: resolved.reduce((total, entry) => total + vertexCount(entry.geometry), 0),
    bounds, spanM, spanMiles: spanM == null ? null : spanM / METRES_PER_MILE,
    scored: scores.length,
    interestMin: scores.length ? Math.min(...scores) : null,
    interestMax: scores.length ? Math.max(...scores) : null,
    intersectsMappedWetland: resolved.filter(entry => entry.intersectsWetland === true).length,
    waterCrossings: resolved.reduce((total, entry) => total + (Number.isFinite(entry.crossingCount) ? entry.crossingCount : 0), 0),
    transitionCorridors: resolved.filter(entry => Number.isFinite(entry.ecoregionTransitions) && entry.ecoregionTransitions > 0).length,
  });
}

// The whole plan: members in the person's chosen order, the straight-line leg between each consecutive pair, and the
// measured facts about the collection. No composite score is computed anywhere in here.
export function outingPlan({ outing = null, savedRoads = null } = {}) {
  if (!outing) return null;
  const roads = savedRoads ?? new Map();
  const members = (outing.roadIds ?? []).map((roadId, index) => member(roadId, index, roads.get(String(roadId)) ?? null));
  const legs = [];
  for (let index = 1; index < members.length; index++) {
    const metres = straightLineM(members[index - 1].representative, members[index].representative);
    legs.push(Object.freeze({ fromId: members[index - 1].roadId, toId: members[index].roadId, metres,
      miles: metres == null ? null : metres / METRES_PER_MILE }));
  }
  return Object.freeze({ id: outing.id, title: outing.title, members: Object.freeze(members),
    legs: Object.freeze(legs), summary: summarize(members) });
}

// The map's view of a plan: the roads that resolve, in the person's order, each carrying the stop it holds and the
// facts its own card states. A member that cannot be resolved is left off the map rather than drawn from a guess - the
// workspace is where it is reported. `selectionDomain` is left to the caller, because which collection a click routes
// to is the application's business, not the map's.
export function outingMapRoads(plan, { selectionDomain = null } = {}) {
  if (!plan) return [];
  return plan.members.filter(entry => entry.resolved && entry.geometry).map(entry => Object.freeze({
    id: entry.roadId, name: entry.name, geometry: entry.geometry, stop: entry.stop, of: plan.members.length,
    selectionDomain,
    distanceFromCenterM: entry.distanceFromSearchCentreM,
    // The leader is the same measured pair a promoted candidate draws: the search centre its own search used, and the
    // point on this road nearest to it. An outing member promoted without a centre simply has no leader.
    searchCenter: entry.searchContext?.center ?? null,
    nearestCenterPoint: entry.searchContext?.nearestCenterPoint ?? null,
    ranking: entry.interest ? { score: entry.interest.score, version: entry.interest.version,
      components: entry.interest.components } : null,
    exploration: entry.exploration ? { score: entry.exploration.score } : null,
  }));
}

