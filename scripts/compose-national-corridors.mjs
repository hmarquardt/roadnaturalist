#!/usr/bin/env node
/**
 * Offline national corridor composition for the derived corridor-metrics plane.
 *
 *   node scripts/compose-national-corridors.mjs <corridors.ndjson>   (units.ndjson on stdin)
 *
 * Input is the same unit stream the committed national segmentation used
 * (scripts/build-national-segments.py -> scripts/segment-national-units.mjs): one JSON object per composed
 * national component, carrying the deduped source lines from the national name index. This script applies
 * the *real* shared modules - composeRoadLines (src/roads/normalize.js) and segmentUnit
 * (src/discovery/segment.js) - so a national derived corridor is the corridor the browser would compose
 * from the same published source features. It emits full corridor records (geometry, bounds, provenance)
 * instead of the segmentation's count-only records.
 *
 * The runtime's analytical-geometry boundary removes a doubled traversal before probing
 * (src/gis/analytical-geometry.js); the same point-preserving rung is applied here and recorded, so the
 * metrics are measured on the geometry the browser would measure. Corridors the native engine still
 * refuses are handled by the build's shard stage through the shared repair ladder.
 */
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import readline from 'node:readline';
import { composeRoadLines } from '../src/roads/normalize.js';
import { segmentUnit } from '../src/discovery/segment.js';
import { removeDuplicateSegments } from '../src/domain/line-repair.js';
import { ANALYSIS_GEOMETRY_METHOD, acceptAnalyticalGeometry, measureAnalyticalChange }
  from '../src/domain/analytical-geometry.js';

const [outputPath] = process.argv.slice(2);
if (!outputPath) {
  console.error('usage: compose-national-corridors.mjs <corridors.ndjson>  (units.ndjson on stdin)');
  process.exit(2);
}

const wkt = geometry => geometry.type === 'LineString'
  ? `LINESTRING(${geometry.coordinates.map(point => point.join(' ')).join(',')})`
  : `MULTILINESTRING(${geometry.coordinates.map(line => `(${line.map(point => point.join(' ')).join(',')})`).join(',')})`;

const stream = createWriteStream(outputPath);
const counts = { units: 0, composed: 0, corridors: 0, duplicateRepairs: 0, duplicateRefused: 0 };
const push = async row => {
  if (!stream.write(JSON.stringify(row) + '\n')) await once(stream, 'drain');
};

for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line) continue;
  const unit = JSON.parse(line);
  const composition = composeRoadLines(unit.sourceLines);
  const segmentation = segmentUnit({ id: unit.id, name: unit.name, geometry: composition.geometry });
  counts.units += 1;
  counts.composed += composition.lengthM ?? 0;
  const countyByFeature = new Map((unit.featureMeta ?? []).map(entry => [String(entry.sourceFeatureId), entry.countyFips]));
  for (const corridor of segmentation.corridors) {
    let analysis = { geometry: corridor.geometry, repaired: false, method: ANALYSIS_GEOMETRY_METHOD.NONE };
    const dedupe = removeDuplicateSegments(corridor.geometry);
    if (dedupe.removedSegmentCount > 0) {
      const metrics = measureAnalyticalChange(corridor.geometry, dedupe.geometry);
      const verdict = acceptAnalyticalGeometry(metrics);
      if (verdict.accepted) {
        analysis = { geometry: dedupe.geometry, repaired: true, method: ANALYSIS_GEOMETRY_METHOD.DUPLICATE_SEGMENTS };
        counts.duplicateRepairs += 1;
      } else {
        counts.duplicateRefused += 1;
      }
    }
    await push({ id: corridor.id, name: corridor.name ?? unit.name, nameKey: unit.nameKey,
      componentId: unit.id, unitId: unit.id, componentIndex: unit.componentIndex, componentCount: unit.componentCount,
      segmentIndex: corridor.segmentIndex, segmentCount: corridor.segmentCount, parts: corridor.parts,
      lengthM: corridor.lengthM, bounds: corridor.bounds, unitLengthM: composition.lengthM,
      geometry: wkt(corridor.geometry), analysisGeometry: analysis.repaired ? wkt(analysis.geometry) : null,
      geometryRepaired: analysis.repaired, geometryRepairMethod: analysis.method,
      sourceFeatureIds: unit.sourceFeatureIds, featureCount: unit.featureCount,
      counties: unit.counties,
      sourceFeatureKeys: unit.sourceFeatureIds.map(feature => ({ countyFips: countyByFeature.get(String(feature)) ?? null,
        sourceFeatureId: String(feature) })) });
    counts.corridors += 1;
  }
}
stream.end();
await once(stream, 'finish');
console.log(JSON.stringify({ units: counts.units, corridors: counts.corridors,
  duplicateRepairs: counts.duplicateRepairs, duplicateRefused: counts.duplicateRefused,
  composedLengthM: Math.round(counts.composed * 1000) / 1000 }));
