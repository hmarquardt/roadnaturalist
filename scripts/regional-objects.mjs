// The objects the regional catalog declares on the data origin, in one place.
//
// Publishing and auditing must enumerate exactly the same set, derived from the catalog itself, or a declared
// object can go missing while every existing check still passes. That is not hypothetical: the version-3 road
// component index is declared in the catalog with its bytes and SHA-256, the browser refuses to search without
// it (`src/gis/service.js` throws on a mismatch), and it was never published - so regional promotion failed in
// production while both `publish:regional` and `audit:regional:remote` reported success, because neither
// enumerated it. The catalog declaration is the authority; every declared object must be published and audited.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const PARQUET_TYPE = 'application/vnd.apache.parquet';
export const JSON_TYPE = 'application/json';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const digest = buffer => createHash('sha256').update(buffer).digest('hex');

// Every object the catalog puts on the data origin: the raw partitions of each declared dataset, the road
// component index, and the immutable derived corridor-metrics plane (its manifest plus each present cell).
// `derivedOnly` narrows the set to the derived plane, for a re-publish of that plane alone.
export function regionalObjectSet(catalog, { derivedOnly = false } = {}) {
  const objects = [];
  for (const dataset of derivedOnly ? [] : catalog.datasets ?? []) {
    for (const part of dataset.partitions) {
      if (part.state === 'empty') continue;
      objects.push({ key: part.url, local: `data/${part.url}`, bytes: part.bytes, sha256: part.sha256,
        type: PARQUET_TYPE, plane: 'regional', dataset: dataset.id, cell: part.id });
    }
  }
  if (!derivedOnly && catalog.roadComponentsUrl) {
    objects.push({ key: catalog.roadComponentsUrl, local: `data/${catalog.roadComponentsUrl}`,
      bytes: catalog.roadComponentsBytes, sha256: catalog.roadComponentsSha256, type: JSON_TYPE,
      plane: 'regional', dataset: 'road-components', cell: 'index' });
  }
  if (catalog.derived) {
    const local = `data/${catalog.derived.localPath}`;
    const bytes = readFileSync(local);
    objects.push({ key: catalog.derived.manifestUrl, local, bytes: bytes.length, sha256: digest(bytes),
      type: JSON_TYPE, plane: 'derived', dataset: 'derived-corridor-metrics', cell: 'manifest' });
    const manifest = JSON.parse(bytes);
    for (const cell of manifest.cells) {
      if (cell.state === 'empty') continue;
      objects.push({ key: cell.url, local: `data/${cell.url}`, bytes: cell.bytes, sha256: cell.sha256,
        type: PARQUET_TYPE, plane: 'derived', dataset: 'derived-corridor-metrics', cell: cell.id });
    }
  }
  return objects;
}
