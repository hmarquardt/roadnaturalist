import { OUTING_STATUS, isRoadVisited, roadProgress, visitedAt } from './outings.js';
import { METRES_PER_MILE } from '../discovery/search-area.js';
import { separationLine } from './outing-plan.js';

// THE FIELD VIEW OF ONE OUTING: the same plan, read the way a person reads it while standing next to the car.
//
// It is a VIEW, not a second plan: it reads the persisted outing, the persisted progress and the saved roads, derives
// which road is current, and hands the interface what to show. Nothing here measures, tracks or contacts anything, and
// nothing is stored here that is not already stored on the outing.
export const FIELD_MODE_NOTE = 'Field mode helps you work through the roads you saved for this outing.';

// WHICH ROAD IS CURRENT, in one documented rule:
//   1. the road the person explicitly chose, while it is still in the plan;
//   2. otherwise the first road they have not visited;
//   3. otherwise the first road in their order.
// Nothing here plans an itinerary: the order is the person's, and this only decides where to stand in it.
export function currentFieldRoadId({ outing = null, roadIds = [], selectedId = null } = {}) {
  const order = roadIds.length ? roadIds : (outing?.roadIds ?? []);
  if (!order.length) return null;
  if (selectedId && order.includes(selectedId)) return selectedId;
  const unvisited = order.find(roadId => !isRoadVisited(outing?.roadState, roadId));
  return unvisited ?? order[0];
}

// ONE PLAN, READ FOR THE FIELD. Every road keeps its place in the person's order whether or not it can be resolved right
// now: an unresolvable road is a stop in the plan that the workspace cannot describe, not a road that has gone away.
export function fieldView({ outing = null, plan = null, selectedId = null } = {}) {
  if (!outing || !plan) return null;
  const order = plan.members.map(member => member.roadId);
  const currentId = currentFieldRoadId({ outing, roadIds: order, selectedId });
  const index = currentId ? order.indexOf(currentId) : -1;
  const current = index >= 0 ? plan.members[index] : null;
  const leg = index >= 0 ? (plan.legs[index] ?? null) : null;
  const nextMember = index >= 0 ? (plan.members[index + 1] ?? null) : null;
  return Object.freeze({ id: outing.id, title: outing.title, date: outing.date ?? null,
    status: outing.status ?? OUTING_STATUS.PLANNED, notes: outing.notes ?? '',
    checklist: outing.checklist ?? Object.freeze([]),
    progress: roadProgress(outing),
    roads: Object.freeze(plan.members.map((member, position) => Object.freeze({ roadId: member.roadId,
      stop: position + 1, name: member.name, resolved: member.resolved, current: member.roadId === currentId,
      visited: isRoadVisited(outing.roadState, member.roadId),
      visitedAt: visitedAt(outing.roadState, member.roadId) }))),
    currentId, current, index,
    previousId: index > 0 ? order[index - 1] : null,
    nextId: index >= 0 && index + 1 < order.length ? order[index + 1] : null,
    // The gap to the next road in the person's own order, in the same words the workspace uses for it.
    legToNext: nextMember ? Object.freeze({ toId: nextMember.roadId, toName: nextMember.name, metres: leg?.metres ?? null,
      miles: leg?.miles ?? null, text: separationLine(leg, { toName: nextMember.name ?? 'the next road' }) }) : null });
}

// THE FACTS A ROAD OFFERS IN THE FIELD, from what is already stored. Each line names what it measured, and a value that
// was never recorded says so - never zero, and never a fresh analysis merely because the field view opened.
export function fieldFacts(member) {
  if (!member?.resolved) return Object.freeze([]);
  const lines = [Object.freeze({ key: 'interest', label: 'Naturalist interest',
    value: Number.isFinite(member.naturalistInterest) ? `${member.naturalistInterest}` : 'not recorded' })];
  if (Number.isFinite(member.explorationScore) && member.explorationScore !== member.naturalistInterest) {
    lines.push(Object.freeze({ key: 'order', label: 'Exploration order',
      value: `${member.explorationScore}${Number.isFinite(member.explorationRadiusMiles)
        ? ` within ${member.explorationRadiusMiles} mi of its search centre` : ''}` }));
  }
  const hectares = member.wetlandArea250M2 == null ? null : member.wetlandArea250M2 / 10_000;
  lines.push(Object.freeze({ key: 'wetland', label: 'Wetlands within 250 m',
    value: hectares == null ? 'not recorded' : `${hectares.toFixed(1)} ha` }));
  lines.push(Object.freeze({ key: 'crossings', label: 'Mapped water crossings',
    value: Number.isFinite(member.crossingCount) ? `${member.crossingCount}` : 'not recorded' }));
  const ecoregions = member.ecoregionCount;
  const transitions = member.ecoregionTransitions;
  lines.push(Object.freeze({ key: 'ecoregions', label: 'Ecoregions',
    value: !Number.isFinite(ecoregions) && !Number.isFinite(transitions) ? 'not recorded'
      : `${Number.isFinite(ecoregions) ? ecoregions : 'an unrecorded number of'} ecoregion${ecoregions === 1 ? '' : 's'}`
        + ` / ${Number.isFinite(transitions) ? transitions : 'an unrecorded number of'} transition${transitions === 1 ? '' : 's'}` }));
  if (Number.isFinite(member.lengthM)) {
    lines.push(Object.freeze({ key: 'length', label: 'Length', value: `${(member.lengthM / METRES_PER_MILE).toFixed(1)} mi` }));
  }
  return Object.freeze(lines);
}
