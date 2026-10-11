import { corridorGeometry } from '../domain/geometry.js';
import { known, notProvided, unknown } from '../domain/attributes.js';
import { composeRoadLines, DEFAULT_TOLERANCE_M } from './normalize.js';

// A road is the normalized geometry of one source road, not a route and not a source row.
// GEOMETRY VERIFIED means the line comes from identified source data. It says nothing about
// legal or practical access, which stays ACCESS UNVERIFIED until the Investigator verifies it.
// A road spanning a county boundary becomes two county-scoped road records (TIGER/Line has no
// road-level id); a candidate corridor composes them in src/domain/corridor.js. See docs/ROADS.md.

export const ROAD_GEOMETRY_STATUS = Object.freeze({ VERIFIED: 'verified', PARTIAL: 'partial', UNRESOLVED: 'unresolved',
  DERIVED: 'derived' });
export const ROAD_ACCESS_STATUS = Object.freeze({ VERIFIED: 'verified', PROBABLE: 'probable', UNVERIFIED: 'unverified' });
export const ROAD_GEOMETRY_STATEMENT = 'Road geometry comes from identified source data.';
// A third claim, for a geometry nobody re-read in this session: measured by the national build, stored in the
// derived plane, and never presented as a fresh verification.
export const ROAD_GEOMETRY_DERIVED_STATEMENT = 'Road geometry is the precomputed national analysis corridor: it comes from the national build, not from a source cell read in this session.';
export const ROAD_ACCESS_STATEMENT = 'Road Naturalist has not established public, legal, or practical access.';
export const ROAD_ACCESS_CAVEAT = 'Presence in a road centerline dataset is not evidence of legal public access or of a practical wildlife road cruise.';

// TIGER/Line MTFCC road classes. Labels describe the source classification only.
const ROAD_CLASS_LABELS = Object.freeze({
  S1100: 'Primary road', S1200: 'Secondary road', S1400: 'Local road', S1500: 'Vehicular trail',
  S1630: 'Ramp', S1640: 'Service drive', S1710: 'Walkway', S1720: 'Stairway', S1730: 'Alley',
  S1740: 'Private road', S1750: 'Internal census road',
});

// TIGER/Line RTTYP route types.
const ROUTE_TYPE_LABELS = Object.freeze({ I: 'Interstate', U: 'U.S. highway', S: 'State highway', C: 'County route', M: 'Common name', O: 'Other' });

export function roadClassAttribute(code) {
  if (!code) return notProvided('The source road feature carries no road class.');
  const label = ROAD_CLASS_LABELS[code];
  return label ? known({ code, label }, 'Source road classification.') : unknown(`Unrecognized source road class ${code}.`);
}

export function routeTypeAttribute(code) {
  if (!code) return notProvided('The source road feature carries no route type.');
  const label = ROUTE_TYPE_LABELS[code];
  return label ? known({ code, label }, 'Source route type.') : unknown(`Unrecognized source route type ${code}.`);
}

export function groupRoadFeatures(features) {
  if (!Array.isArray(features) || !features.length) return [];
  const groups = new Map();
  for (const feature of features) {
    if (!feature?.roadId) throw new TypeError('Road feature needs a road id');
    if (!groups.has(feature.roadId)) {
      groups.set(feature.roadId, {
        roadId: feature.roadId, name: feature.name ?? null, roadClass: feature.roadClass ?? null,
        routeType: feature.routeType ?? null, countyFips: feature.countyFips ?? null,
        countyName: feature.countyName ?? null, features: [],
      });
    }
    groups.get(feature.roadId).features.push(feature);
  }
  return [...groups.values()];
}

// A promoted discovery corridor is one contiguous segment of a composed road group, not the whole group.
// Its road record keeps the composed group's provenance (which source features and road ids the road is
// made of) but takes the corridor's own canonical geometry, so the candidate measures exactly the corridor
// a person selected. Canonical means unchanged: the shared analytical-geometry boundary prepares the
// geometry for analysis afterwards, exactly as it did for the survey row the corridor came from. Without
// this, promoting corridor 2 of 3 would silently measure all three.
export function corridorRoad(group, corridor, { provenance = null, toleranceM = DEFAULT_TOLERANCE_M } = {}) {
  if (!corridor?.geometry) throw new TypeError('Corridor road needs the promoted corridor geometry');
  const measured = corridorGeometry(corridor.geometry);
  if (!measured.geometry || !Number.isFinite(measured.lengthM) || measured.lengthM <= 0) {
    throw new TypeError('Corridor road needs a usable corridor geometry');
  }
  const road = createRoad(group, { provenance, toleranceM });
  return Object.freeze({
    ...road, geometry: measured.geometry, bounds: measured.bounds, lengthM: measured.lengthM,
    evidence: Object.freeze({ ...road.evidence,
      geometry: Object.freeze({ ...road.evidence.geometry,
        corridorSegment: Object.freeze({ index: corridor.segmentIndex ?? 1, count: corridor.segmentCount ?? 1,
          method: 'contiguous vertices along the composed unit' }) }) }),
  });
}

export function createRoad(group, { provenance = null, toleranceM = DEFAULT_TOLERANCE_M } = {}) {
  if (!group?.roadId || !group?.name) throw new TypeError('Road requires a road id and a name');
  if (!Array.isArray(group.features) || !group.features.length) throw new TypeError('Road requires at least one source feature');
  const sourceFeatureIds = group.features.map(feature => String(feature.sourceFeatureId));
  const composition = composeRoadLines(
    group.features.map(feature => ({ sourceFeatureId: feature.sourceFeatureId, coordinates: featureCoordinates(feature) })),
    { toleranceM });
  const { lengthM, bounds } = corridorGeometry(composition.geometry);
  return Object.freeze({
    id: group.roadId, name: group.name, geometry: composition.geometry, lengthM, bounds,
    composition: composition.composition,
    roadClass: roadClassAttribute(group.roadClass),
    routeType: routeTypeAttribute(group.routeType),
    surface: notProvided('The selected road source publishes no surface information.'),
    access: unknown('No access metadata has been evaluated for this road.'),
    sourceFeatureIds,
    county: group.countyFips ? Object.freeze({ fips: group.countyFips, name: group.countyName ?? null }) : null,
    evidence: Object.freeze({
      geometry: Object.freeze({
        status: composition.composition.partCount > 1 ? ROAD_GEOMETRY_STATUS.PARTIAL : ROAD_GEOMETRY_STATUS.VERIFIED,
        statement: ROAD_GEOMETRY_STATEMENT,
        sourceFeatureCount: sourceFeatureIds.length,
        composition: composition.composition,
      }),
      access: Object.freeze({ status: ROAD_ACCESS_STATUS.UNVERIFIED, statement: ROAD_ACCESS_STATEMENT, note: ROAD_ACCESS_CAVEAT }),
    }),
    provenance: roadProvenance(group, sourceFeatureIds, provenance, composition.composition),
  });
}

// Geometry evidence and access evidence are different claims. A verified line never implies access.
export const ROAD_GEOMETRY_LABEL = Object.freeze({ verified: 'GEOMETRY VERIFIED', partial: 'GEOMETRY PARTIAL',
  unresolved: 'GEOMETRY UNRESOLVED', derived: 'GEOMETRY PRECOMPUTED' });
export const ROAD_ACCESS_LABEL = Object.freeze({ verified: 'ACCESS VERIFIED', probable: 'ACCESS PROBABLE', unverified: 'ACCESS UNVERIFIED' });

export function roadEvidenceSummary(roads) {
  if (!Array.isArray(roads) || !roads.length) throw new TypeError('Evidence summary needs at least one road');
  const statuses = roads.map(road => road.evidence.geometry.status);
  const geometry = statuses.includes(ROAD_GEOMETRY_STATUS.UNRESOLVED) ? ROAD_GEOMETRY_STATUS.UNRESOLVED
    : statuses.includes(ROAD_GEOMETRY_STATUS.PARTIAL) ? ROAD_GEOMETRY_STATUS.PARTIAL
      : statuses.every(status => status === ROAD_GEOMETRY_STATUS.DERIVED) ? ROAD_GEOMETRY_STATUS.DERIVED
        : ROAD_GEOMETRY_STATUS.VERIFIED;
  return Object.freeze({
    geometry: Object.freeze({ status: geometry, label: ROAD_GEOMETRY_LABEL[geometry], statement: ROAD_GEOMETRY_STATEMENT }),
    access: Object.freeze({ status: ROAD_ACCESS_STATUS.UNVERIFIED, label: ROAD_ACCESS_LABEL[ROAD_ACCESS_STATUS.UNVERIFIED],
      statement: ROAD_ACCESS_STATEMENT, note: ROAD_ACCESS_CAVEAT }),
  });
}

function featureCoordinates(feature) {
  if (feature?.geometry?.type === 'LineString') return feature.geometry.coordinates;
  return feature?.geometry?.coordinates ?? feature?.coordinates;
}

function roadProvenance(group, sourceFeatureIds, provenance, composition) {
  return Object.freeze({
    organization: provenance?.agency ?? null, dataset: provenance?.dataset ?? null,
    datasetId: provenance?.datasetId ?? null,
    datasetVersion: provenance?.datasetVersion ?? null, vintage: provenance?.vintage ?? null,
    referenceUrl: provenance?.referenceUrl ?? null, documentationUrl: provenance?.documentationUrl ?? null,
    license: provenance?.license ?? null, datasetDigest: provenance?.datasetDigest ?? null,
    retrievedAt: provenance?.retrievedAt ?? null, sourcePublicationDate: provenance?.publicationDate ?? null,
    sourceFeatureIds: Object.freeze(sourceFeatureIds), countyFips: group.countyFips ?? null, countyName: group.countyName ?? null,
    sourceAttributes: Object.freeze({ name: group.name, roadClass: group.roadClass ?? null, routeType: group.routeType ?? null }),
    sourceCrs: provenance?.sourceCrs ?? null, crs: provenance?.geometryCrs ?? 'EPSG:4326',
    sourceArchives: Object.freeze((provenance?.sources ?? []).map(source => Object.freeze({ ...source }))),
    normalization: Object.freeze({
      pipelineVersion: provenance?.pipelineVersion ?? null, method: provenance?.method ?? null,
      composition: composition.method, toleranceM: composition.toleranceM,
    }),
  });
}

// A road record for a corridor whose geometry comes from the derived plane, not from a fresh reconstruction.
//
// Same shape as a composed road, different claim: the geometry is precomputed by the national analysis build, so
// its evidence status says exactly that instead of borrowing "verified" - nothing in this session re-verified it -
// and its provenance names the derived plane (and the source datasets the build pinned) rather than a re-read
// archive. This is what makes a corridor openable where the raw wetland and hydrography cells have never been
// published, without dressing precomputed values as source-backed evidence.
export function derivedRoad(corridor, unit = {}, { derivedVersion = null, provenance = null } = {}) {
  if (!corridor?.geometry) throw new TypeError('A derived road needs the corridor geometry from the derived row');
  const measured = corridorGeometry(corridor.geometry);
  if (!measured.geometry || !Number.isFinite(measured.lengthM) || measured.lengthM <= 0) {
    throw new TypeError('A derived road needs a usable corridor geometry');
  }
  const sourceFeatureIds = (unit.sourceFeatureIds ?? []).map(String);
  const countyNames = (unit.countyNames ?? []).map(String);
  const countyFips = (unit.countyFips ?? []).map(String).sort();
  const composition = Object.freeze({ method: 'precomputed: composed during the national analysis build',
    toleranceM: null, partCount: null, usedFeatureCount: sourceFeatureIds.length, maxUnresolvedGapM: null });
  return Object.freeze({
    id: corridor.unitId ?? unit.id ?? corridor.id, name: corridor.name ?? unit.name ?? null,
    geometry: measured.geometry, bounds: measured.bounds, lengthM: measured.lengthM,
    composition: Object.freeze({ ...composition, corridorSegment: Object.freeze({
      index: corridor.segmentIndex ?? 1, count: corridor.segmentCount ?? 1,
      method: 'contiguous vertices along the composed unit' }) }),
    roadClass: roadClassAttribute(unit.roadClass ?? null), routeType: routeTypeAttribute(unit.routeType ?? null),
    surface: notProvided('The selected road source publishes no surface information.'),
    access: unknown('No access metadata has been evaluated for this road.'),
    sourceFeatureIds, county: null,
    countyNames, countyFips,
    evidence: Object.freeze({
      geometry: Object.freeze({ status: ROAD_GEOMETRY_STATUS.DERIVED, statement: ROAD_GEOMETRY_DERIVED_STATEMENT,
        sourceFeatureCount: sourceFeatureIds.length, composition }),
      access: Object.freeze({ status: ROAD_ACCESS_STATUS.UNVERIFIED, statement: ROAD_ACCESS_STATEMENT,
        note: ROAD_ACCESS_CAVEAT }),
    }),
    provenance: Object.freeze({
      organization: provenance?.agency ?? 'Road Naturalist',
      dataset: 'National derived corridor-metrics plane',
      datasetId: 'road-derived-corridor-metrics', datasetVersion: derivedVersion,
      vintage: null, referenceUrl: null, documentationUrl: null, license: null, datasetDigest: null,
      retrievedAt: null, sourcePublicationDate: null, sourceFeatureIds: Object.freeze(sourceFeatureIds),
      countyFips: countyFips[0] ?? null, countyName: countyNames[0] ?? null,
      sourceAttributes: Object.freeze({ name: corridor.name ?? unit.name ?? null, roadClass: unit.roadClass ?? null,
        routeType: unit.routeType ?? null }),
      sourceCrs: null, crs: 'EPSG:4326', sourceArchives: Object.freeze([]),
      normalization: Object.freeze({ pipelineVersion: null, method: 'precomputed corridor metrics', composition }),
      derived: true,
    }),
    derived: true,
  });
}
