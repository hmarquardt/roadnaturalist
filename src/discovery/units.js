import { corridorGeometry } from '../domain/geometry.js';
import { DEFAULT_TOLERANCE_M, componentGroups, compareSourceLines, composeRoadLines, dedupeSourceLines } from '../roads/normalize.js';
import { DISCOVERY_ID_PREFIX, JOIN_TOLERANCE_M } from './constants.js';
import { classifyFeature } from './eligibility.js';

// Source features -> deterministic discovery road units.
//
// A discovery road unit is one named road in one place: source features are normalized (exact and
// reversed duplicates collapse), joined by endpoint proximity, and split into connected components so
// two unrelated roads that share a name never become one candidate. Nothing is invented across a real
// geometry gap: a gap inside a unit is reported as a gap, and a gap larger than the join tolerance
// starts a second unit for the same name. Stable ids follow from the name and the component order,
// never from a random value.

export function normalizeRoadName(name) {
  const cleaned = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return cleaned.replace(/^-+|-+$/g, '');
}

export function buildDiscoveryUnits(features, { toleranceM = DEFAULT_TOLERANCE_M, joinToleranceM = JOIN_TOLERANCE_M } = {}) {
  const decisions = [];
  const blocked = new Map();
  for (const feature of features ?? []) {
    const decision = classifyFeature(feature);
    if (!decision.eligibleForDiscovery) {
      const key = decision.eligibilityReason;
      blocked.set(key, (blocked.get(key) ?? 0) + 1);
      continue;
    }
    decisions.push({ feature, decision });
  }

  const groups = new Map();
  for (const entry of decisions) {
    const key = normalizeRoadName(entry.feature.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, names: new Map(), features: [] });
    const group = groups.get(key);
    group.names.set(entry.feature.name, (group.names.get(entry.feature.name) ?? 0) + 1);
    group.features.push(entry.feature);
  }

  const units = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    // The displayed name is the most frequent published spelling; ties break on a byte-wise ascending
    // comparison so the choice never depends on locale collation or on feature order.
    const name = [...group.names.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0];
    const deduped = dedupeSourceLines(group.features.map(feature => ({ sourceFeatureId: feature.sourceFeatureId,
      coordinates: featureCoordinates(feature) })), toleranceM);
    const components = componentGroups(deduped.lines, joinToleranceM);
    const ordered = components.map(component => [...component].sort(compareSourceLines));
    ordered.sort((left, right) => compareSourceLines(left[0], right[0]));
    ordered.forEach((component, index) => {
      units.push(createUnit({ key, name, component, index, componentCount: ordered.length, group, toleranceM,
        duplicatesRemoved: deduped.duplicatesRemoved, collapsedReversedLinks: deduped.collapsedReversedLinks,
        sourceFeatureCount: group.features.length }));
    });
  }
  units.sort((a, b) => a.id.localeCompare(b.id));
  return {
    units,
    blocked: Object.freeze([...blocked.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => Object.freeze({ reason, count }))),
    eligibleFeatureCount: decisions.length,
  };
}

function createUnit({ key, name, component, index, componentCount, group, toleranceM, duplicatesRemoved, collapsedReversedLinks, sourceFeatureCount }) {
  const composition = composeRoadLines(component.map(line => ({ sourceFeatureId: line.sourceFeatureId, coordinates: line.coordinates })),
    { toleranceM });
  const sourceFeatureIds = component.map(line => line.sourceFeatureId);
  const byFeatureId = new Map(group.features.map(feature => [String(feature.sourceFeatureId), feature]));
  const members = sourceFeatureIds.map(id => byFeatureId.get(id)).filter(Boolean);
  const counties = [...new Set(members.map(feature => feature.countyFips).filter(Boolean))].sort();
  const countyNames = [...new Set(members.map(feature => feature.countyName).filter(Boolean))];
  const roadClasses = [...new Set(members.map(feature => feature.roadClass).filter(Boolean))].sort();
  const roadIds = [...new Set(members.map(feature => feature.roadId).filter(Boolean))].sort();
  const { geometry, lengthM, bounds } = composition;
  return Object.freeze({
    id: `${DISCOVERY_ID_PREFIX}-${key}${componentCount > 1 ? `-c${index + 1}` : ''}`,
    name, nameKey: key, geometry, lengthM, bounds,
    componentIndex: index + 1, componentCount,
    sourceFeatureIds: Object.freeze(sourceFeatureIds), roadIds: Object.freeze(roadIds),
    countyFips: Object.freeze(counties), countyNames: Object.freeze(countyNames), roadClasses: Object.freeze(roadClasses),
    composition: Object.freeze({
      method: composition.composition.method,
      joinToleranceM: JOIN_TOLERANCE_M,
      sourceFeatureCount,
      usedFeatureCount: sourceFeatureIds.length,
      duplicatesRemoved,
      collapsedReversedLinks,
      lineCount: composition.composition.lineCount,
      partCount: composition.composition.partCount,
      gapsM: composition.composition.gapsM,
      maxResolvedGapM: composition.composition.maxResolvedGapM,
      maxUnresolvedGapM: composition.composition.maxUnresolvedGapM,
    }),
  });
}

function featureCoordinates(feature) {
  const geometry = feature?.geometry;
  // The bounded network extract stores one WKB LineString per source feature part (verified at build
  // time by DuckDB read-back), so anything else is unexpected input rather than a shape to guess at.
  if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) {
    throw new TypeError(`Discovery road features must be GeoJSON LineStrings (feature ${feature?.sourceFeatureId ?? 'unknown'})`);
  }
  return geometry.coordinates;
}

export function unitGeometry(unit) {
  return corridorGeometry(unit.geometry).geometry;
}
