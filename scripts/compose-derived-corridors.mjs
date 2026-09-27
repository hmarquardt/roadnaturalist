#!/usr/bin/env node
/**
 * Offline corridor composition and repair candidates for the derived corridor-metrics plane.
 *
 *   node scripts/compose-derived-corridors.mjs compose <features.ndjson> <corridors.ndjson>
 *   node scripts/compose-derived-corridors.mjs repair-candidates <in.json> <out.json>
 *   node scripts/compose-derived-corridors.mjs sql <out.json>
 *
 * `compose` runs the *real* discovery modules (src/discovery/units.js, src/discovery/segment.js) over the
 * published regional road features, so a derived row is the corridor the browser would build from the same
 * data: units are composed from every published piece of a named road in one place, and a long one is divided
 * by the same segmentation profile.
 *
 * `repair-candidates` runs the shared point-preserving repair ladder (src/domain/analytical-geometry.js) for
 * corridors whose canonical geometry the engine refuses to buffer, and reports each candidate's method,
 * geometry and movement metrics. The caller then asks the engine to buffer the candidates in ladder order and
 * keeps the first accepted one, which is exactly what src/gis/analytical-geometry.js does at runtime.
 *
 * `sql` writes the shared habitat metric expressions (src/gis/habitat-metrics.js) so the offline build
 * composes its queries from the definition the runtime uses instead of restating it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildDiscoveryUnits } from '../src/discovery/units.js';
import { segmentUnit } from '../src/discovery/segment.js';
import { repairCandidates } from '../src/domain/analytical-geometry.js';
import { HABITAT_METRIC_DEFINITION, clippedAreaExpression, clippedLengthExpression, featureCountExpression } from '../src/gis/habitat-metrics.js';
import { ANALYSIS_GEOMETRY_METHOD } from '../src/domain/analytical-geometry.js';

const round = (value, digits = 6) => Math.round(Number(value) * 10 ** digits) / 10 ** digits;
const wkt = geometry => geometry.type === 'LineString'
  ? `LINESTRING(${geometry.coordinates.map(point => point.join(' ')).join(',')})`
  : `MULTILINESTRING(${geometry.coordinates.map(line => `(${line.map(point => point.join(' ')).join(',')})`).join(',')})`;
const [command, ...args] = process.argv.slice(2);
const readJsonLines = path => readFileSync(path, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));

if (command === 'compose') {
  const [featurePath, corridorPath] = args;
  const features = readJsonLines(featurePath).map(row => ({ roadId: String(row.road_id), name: row.name ?? null,
    roadClass: row.road_class ?? null, routeType: row.route_type ?? null, countyFips: row.county_fips ?? null,
    countyName: row.county_name ?? null, sourceFeatureId: String(row.source_feature_id), part: Number(row.part),
    // DuckDB's JSON export parses an ST_AsGeoJSON column into a nested value, so accept either form.
    geometry: typeof row.geometry_json === 'string' ? JSON.parse(row.geometry_json) : row.geometry_json }));
  const built = buildDiscoveryUnits(features);
  const corridors = [];
  let droppedUnits = 0;
  for (const unit of built.units) {
    const segmented = segmentUnit(unit);
    if (!segmented.corridors.length) { droppedUnits += 1; continue; }
    for (const corridor of segmented.corridors) {
      corridors.push({ id: corridor.id, name: corridor.name, nameKey: unit.nameKey, unitId: unit.id,
        componentId: unit.id, componentIndex: unit.componentIndex, componentCount: unit.componentCount,
        segmentIndex: corridor.segmentIndex, segmentCount: corridor.segmentCount, parts: corridor.parts,
        lengthM: corridor.lengthM, bounds: corridor.bounds.map(value => round(value, 9)), geometry: corridor.geometry,
        sourceFeatureIds: [...unit.sourceFeatureIds], roadIds: [...unit.roadIds], counties: [...unit.countyFips],
        countyNames: [...unit.countyNames], roadClasses: [...unit.roadClasses],
        unitLengthM: unit.lengthM, composition: { usedFeatureCount: unit.composition.usedFeatureCount,
          duplicatesRemoved: unit.composition.duplicatesRemoved, collapsedReversedLinks: unit.composition.collapsedReversedLinks,
          partCount: unit.composition.partCount, maxUnresolvedGapM: unit.composition.maxUnresolvedGapM } });
    }
  }
  corridors.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(corridorPath, corridors.map(corridor => JSON.stringify(corridor)).join('\n') + '\n');
  console.log(JSON.stringify({ features: features.length, eligibleFeatures: built.eligibleFeatureCount,
    units: built.units.length, droppedUnits, corridors: corridors.length, blocked: built.blocked.slice(0, 6) }));
} else if (command === 'repair-candidates') {
  const [inPath, outPath] = args;
  const request = JSON.parse(readFileSync(inPath, 'utf8'));
  const output = request.map(item => ({
    id: item.id,
    canonical: { wkt: wkt(item.geometry), method: ANALYSIS_GEOMETRY_METHOD.NONE },
    candidates: repairCandidates(item.geometry).map(candidate => ({ method: candidate.method, wkt: wkt(candidate.geometry),
      accepted: candidate.accepted, rejection: candidate.rejection, metrics: candidate.metrics, repairs: candidate.repairs })),
  }));
  writeFileSync(outPath, JSON.stringify(output, null, 1) + '\n');
  console.log(JSON.stringify({ corridors: output.length,
    candidates: output.reduce((total, entry) => total + entry.candidates.length, 0),
    rejectedByTolerance: output.reduce((total, entry) => total + entry.candidates.filter(candidate => !candidate.accepted).length, 0) }));
} else if (command === 'sql') {
  const [outPath] = args;
  // The expressions are exported against the two clip targets the two readers use: the corridor line itself
  // (`c.geom`) and the once-materialised buffer relation (`b.geom`) that both the runtime batch and the offline
  // build create (src/gis/discovery-query.js prepareBuffers). Naming the buffer relation instead of inlining
  // `ST_Buffer(c.geom, d.distance_m)` into every predicate is what keeps the offline queries the batch's own
  // shape - and stops a buffer being recomputed for every feature pair.
  writeFileSync(outPath, JSON.stringify({ definition: HABITAT_METRIC_DEFINITION,
    wetlandArea: clippedAreaExpression('w.geom', 'ST_Buffer(c.geom, d.distance_m)'),
    wetlandCount: featureCountExpression(),
    hydroLength: clippedLengthExpression('f.geom', 'ST_Buffer(c.geom, d.distance_m)'),
    hydroArea: clippedAreaExpression('f.geom', 'ST_Buffer(c.geom, d.distance_m)'),
    hydroCount: featureCountExpression(),
    ecoLength: clippedLengthExpression('e.geom', 'c.geom'),
    wetlandAreaBuffered: clippedAreaExpression('w.geom', 'b.geom'),
    wetlandCountBuffered: featureCountExpression(),
    hydroLengthBuffered: clippedLengthExpression('f.geom', 'b.geom'),
    hydroAreaBuffered: clippedAreaExpression('f.geom', 'b.geom'),
    hydroCountBuffered: featureCountExpression(),
    hydroCrossing: clippedLengthExpression('f.geom', 'c.geom'),
    methods: Object.values(ANALYSIS_GEOMETRY_METHOD) }, null, 1) + '\n');
  console.log(`wrote ${outPath}`);
} else {
  console.error('usage: compose <features.ndjson> <corridors.ndjson> | repair-candidates <in.json> <out.json> | sql <out.json>');
  process.exit(2);
}
