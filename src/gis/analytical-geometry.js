// The single shared boundary between canonical corridor geometry and buffered spatial operations.
//
// Discovery, detailed habitat analysis, and ecoregion overlap all ask this one module what geometry to
// use, so a corridor repaired during a survey cannot suddenly fail when it is promoted and analysed in
// detail. The decision itself is pure (src/domain/analytical-geometry.js); this layer only asks the
// spatial engine to confirm that the chosen candidate is actually acceptable, because a repair function
// returning something is not evidence that the requested query works.
//
// Cost model: a corridor whose canonical geometry already buffers is probed exactly as before and
// repairs nothing (the fast path). Only a corridor whose canonical geometry is refused pays for the
// ladder, and every rung is a pure-JavaScript rewriting of the same coordinates.

import { corridorGeometry, corridorWkt } from '../domain/geometry.js';
import { ANALYSIS_GEOMETRY_METHOD, ANALYSIS_GEOMETRY_TOLERANCE, UNREPAIRABLE_GEOMETRY_REASON,
  canonicalAnalysis, describeGeometryForAnalysis, repairCandidates } from '../domain/analytical-geometry.js';
import { ANALYSIS_DISTANCES_M } from './habitat-result.js';

// The buffers a candidate must be able to support. Both the survey and the detailed analysis pass the
// same requested distances, which is what makes their decisions identical for the same corridor.
const IDENTIFIER = /^[a-z0-9][a-z0-9-]*$/;

export function createAnalyticalGeometryQueries({ initialize, record = () => {} }) {
  const project = wkt => `ST_Transform(ST_GeomFromText('${wkt}'), 'EPSG:4326', 'EPSG:5070', always_xy := true)`;
  const bufferList = distancesM => distancesM.map(distance => `ST_Buffer(geom, ${Number(distance)})`).join(', ');
  // A GEOS refusal is information about one corridor; anything else (a missing spatial extension, a
  // broken dataset, a binder error) is an infrastructure failure and must stay loud instead of being
  // relabelled as a geometry problem.
  const GEOMETRY_REFUSAL = /TopologyException|found non-noded intersection|assigned depths|Could not create|IllegalArgument|Self-intersection|GEOS/i;
  const isGeometryRefusal = error => GEOMETRY_REFUSAL.test(String(error?.message ?? error));

  // Probe a candidate as a standalone statement. A GEOS refusal is caught and returned; any other error
  // is rethrown so the caller reports it as the dataset or engine failure it is.
  async function probeCandidate(engine, wkt, distancesM) {
    const started = performance.now();
    try {
      await engine.conn.query(`SELECT ${bufferList(distancesM)} FROM (SELECT ${project(wkt)} AS geom) AS candidate`);
      return { usable: true, error: null, ms: Math.round(performance.now() - started) };
    } catch (error) {
      if (!isGeometryRefusal(error)) throw error;
      return { usable: false, error: error.message, ms: Math.round(performance.now() - started) };
    }
  }

  // Probe the canonical geometry where a caller already stores it (discovery keeps every corridor in one
  // temp table), so the fast path costs exactly what it cost before repair existed.
  async function probeStoredGeometry(engine, { table, id, geomColumn = 'geom', distancesM }) {
    const started = performance.now();
    try {
      await engine.conn.query(`SELECT ${distancesM.map(distance => `ST_Buffer(${geomColumn}, ${Number(distance)})`).join(', ')}`
        + ` FROM ${table} WHERE id = '${id}'`);
      return { usable: true, error: null, ms: Math.round(performance.now() - started) };
    } catch (error) {
      if (!isGeometryRefusal(error)) throw error;
      return { usable: false, error: error.message, ms: Math.round(performance.now() - started) };
    }
  }

  function entryFor({ id, selection, probe, attempts, repairMs, geometry }) {
    const analytical = geometry ?? selection.geometry;
    const repaired = selection.method !== ANALYSIS_GEOMETRY_METHOD.NONE;
    return Object.freeze({
      id, geometry: analytical, wkt: corridorWkt(analytical),
      repaired, repairMethod: selection.method, repairs: selection.repairs, metrics: selection.metrics,
      usable: true, reason: null,
      geometryForAnalysis: describeGeometryForAnalysis({ repaired, method: selection.method, metrics: selection.metrics, repairs: selection.repairs }),
      diagnostics: Object.freeze({ status: 'prepared', attempts: Object.freeze(attempts), probeMs: probe.ms, repairMs }),
    });
  }

  function unavailableFor({ id, attempts, repairMs, rejection }) {
    return Object.freeze({
      id, geometry: null, wkt: null, repaired: false, repairMethod: ANALYSIS_GEOMETRY_METHOD.NONE, repairs: null, metrics: null,
      usable: false, reason: UNREPAIRABLE_GEOMETRY_REASON, rejection: rejection ?? null,
      geometryForAnalysis: describeGeometryForAnalysis({ repaired: false, method: ANALYSIS_GEOMETRY_METHOD.NONE }),
      diagnostics: Object.freeze({ status: 'unavailable', attempts: Object.freeze(attempts), probeMs: null, repairMs }),
    });
  }

  // Prepare one corridor. Canonical geometry first; then the ladder, in order, stopping at the first
  // candidate that both the metric gate and the engine accept.
  async function prepareAnalyticalGeometry({ engine = null, id, geometry, distancesM = ANALYSIS_DISTANCES_M, probeCanonical = null }) {
    const resolved = engine ?? await initialize();
    const canonical = canonicalAnalysis(geometry);
    const attempts = [];
    const canonicalProbe = probeCanonical ? await probeCanonical() : await probeCandidate(resolved, corridorWkt(canonical.geometry), distancesM);
    if (canonicalProbe.usable) {
      attempts.push(Object.freeze({ method: ANALYSIS_GEOMETRY_METHOD.NONE, accepted: true, usable: true, reason: null }));
      return entryFor({ id, selection: canonical, probe: canonicalProbe, attempts, repairMs: 0 });
    }
    attempts.push(Object.freeze({ method: ANALYSIS_GEOMETRY_METHOD.NONE, accepted: true, usable: false, reason: canonicalProbe.error }));
    const repairStarted = performance.now();
    const candidates = repairCandidates(geometry);
    for (const selection of candidates) {
      if (!selection.accepted) {
        attempts.push(Object.freeze({ method: selection.method, accepted: false, usable: false, reason: selection.rejection }));
        continue;
      }
      const probe = await probeCandidate(resolved, corridorWkt(selection.geometry), distancesM);
      attempts.push(Object.freeze({ method: selection.method, accepted: true, usable: probe.usable, reason: probe.error }));
      if (probe.usable) return entryFor({ id, selection, probe, attempts, repairMs: Math.round(performance.now() - repairStarted) });
    }
    const repaired = candidates.length === 0
      ? 'no point-preserving repair applied to this geometry, so only the canonical line was tried.'
      : 'every accepted repair candidate was still refused by the analysis engine.';
    return unavailableFor({ id, attempts, repairMs: Math.round(performance.now() - repairStarted), rejection: repaired });
  }

  // Batch preparation. `probeCanonical(corridor, id)` lets a caller probe against its own table; without
  // it every candidate is probed as a standalone statement.
  async function prepareAnalyticalGeometries({ engine = null, corridors = [], distancesM = ANALYSIS_DISTANCES_M, probeCanonical = null } = {}) {
    const started = performance.now();
    const resolved = engine ?? await initialize();
    const geometries = new Map();
    const methods = {};
    const repairedIds = [];
    const unusableIds = [];
    let probeMs = 0;
    let repairMs = 0;
    for (const corridor of corridors) {
      const requested = corridor?.geometry ?? corridor;
      const id = corridor?.id ?? `anonymous-${geometries.size}`;
      if (corridor?.id && !IDENTIFIER.test(id)) throw new TypeError(`Invalid analytical geometry id: ${id}`);
      corridorGeometry(requested);
      const entry = await prepareAnalyticalGeometry({ engine: resolved, id, geometry: requested, distancesM,
        probeCanonical: probeCanonical ? () => probeCanonical(corridor, id) : null });
      geometries.set(id, entry);
      methods[entry.repairMethod] = (methods[entry.repairMethod] ?? 0) + 1;
      probeMs += entry.diagnostics.probeMs ?? 0;
      repairMs += entry.diagnostics.repairMs ?? 0;
      if (entry.repaired) repairedIds.push(id);
      if (!entry.usable) unusableIds.push(id);
    }
    return {
      geometries, repairedIds: Object.freeze(repairedIds), unusableIds: Object.freeze(unusableIds), unusableReason: UNREPAIRABLE_GEOMETRY_REASON,
      diagnostics: Object.freeze({ corridorCount: corridors.length, repairedCount: repairedIds.length, unusableCount: unusableIds.length,
        methods: Object.freeze(methods), probeMs, repairMs, prepareMs: Math.round(performance.now() - started),
        tolerance: ANALYSIS_GEOMETRY_TOLERANCE }),
    };
  }

  return { prepareAnalyticalGeometry, prepareAnalyticalGeometries, probeCandidate, probeStoredGeometry };
}
