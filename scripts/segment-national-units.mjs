#!/usr/bin/env node
// Stream exact shared-JavaScript road composition and segmentation for offline national component jobs.
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import readline from 'node:readline';
import { composeRoadLines } from '../src/roads/normalize.js';
import { segmentUnit } from '../src/discovery/segment.js';

const output = process.argv[2];
if (!output) throw new Error('output JSONL path required');
const stream = createWriteStream(output);
const counts = { units: 0, eligibleUnits: 0, droppedUnits: 0, corridors: 0, maxSegmentCount: 0,
  totalLengthM: 0, eligibleLengthM: 0, segmentCountDistribution: {}, lengthBands: {} };
const bands = [1609.344, 6437.376, 12874.752, 50000, 100000, 500000, 1000000];
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line) continue;
  const unit = JSON.parse(line);
  const composition = composeRoadLines(unit.sourceLines);
  const segmentation = segmentUnit({ id: unit.id, name: unit.name, geometry: composition.geometry });
  const corridorCount = segmentation.corridors.length;
  counts.units++;
  counts.totalLengthM += composition.lengthM;
  if (segmentation.dropped) counts.droppedUnits++;
  else { counts.eligibleUnits++; counts.corridors += corridorCount; counts.eligibleLengthM += composition.lengthM; }
  counts.maxSegmentCount = Math.max(counts.maxSegmentCount, corridorCount);
  counts.segmentCountDistribution[corridorCount] = (counts.segmentCountDistribution[corridorCount] ?? 0) + 1;
  const band = bands.find(value => composition.lengthM < value) ?? '1000000+';
  counts.lengthBands[band] = (counts.lengthBands[band] ?? 0) + 1;
  const row = JSON.stringify({ id: unit.id, lengthM: Math.round(composition.lengthM * 1000) / 1000,
    corridorCount, sourceFeatureCount: unit.sourceLines.length });
  if (!stream.write(row + '\n')) await once(stream, 'drain');
}
stream.end();
await once(stream, 'finish');
console.log(JSON.stringify(counts));
