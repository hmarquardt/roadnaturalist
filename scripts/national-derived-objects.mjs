// The objects the national derived corridor-metrics plane puts on the Road Naturalist data origin, in one place.
//
// Publication, the local pre-publication audit and the remote audit must enumerate exactly the same set, or an
// object the manifest declares can go missing while every check still passes. That is not hypothetical: the
// version-3 regional road component index was declared, never published, and both `publish:regional` and
// `audit:regional:remote` reported success because neither enumerated it (see scripts/regional-objects.mjs).
//
// So the *finalized derived manifest is the authority*, not a hand-written file list:
//
//   * the manifest object itself, and
//   * one Parquet object per cell the manifest declares `present` (cells it declares `empty` carry rows 0 and
//     no url, so they contribute no object at all - the declared-but-empty case the schema exists for).
//
// Every path is derived from the manifest's own `analysisFingerprint`, so a rebuilt plane is a new immutable
// directory and can never overwrite a published one. The local file for each object is looked up under the
// finalize directory the manifest was written to (`<final>/<fingerprint>/cells/<cell>.parquet`), which is the
// same path the manifest declares as the object key - the local path *is* the published path.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const PARQUET_TYPE = 'application/vnd.apache.parquet';
export const JSON_TYPE = 'application/json';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const DERIVED_KIND = 'road-derived-corridor-metrics';
export const PREFIX = 'derived/corridor-metrics';

const digest = buffer => createHash('sha256').update(buffer).digest('hex');

// The finalized plane directory: the single `<fingerprint>/manifest.json` under a `--final` root, unless a
// caller names the plane directory directly. A stray AppleDouble or scratch file in the directory is never
// enumerated, because enumeration is driven by the manifest and not by a directory walk.
export function resolvePlane(rootOrPlane) {
  if (existsSync(join(rootOrPlane, 'manifest.json'))) return rootOrPlane;
  const candidates = readdirSync(rootOrPlane, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map(entry => join(rootOrPlane, entry.name))
    .filter(directory => existsSync(join(directory, 'manifest.json')));
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one finalized plane under ${rootOrPlane}, found ${candidates.length}`);
  }
  return candidates[0];
}

// The publication set, derived from the manifest. `manifestBytes` is read once so the manifest object's own
// bytes and digest are the ones on disk, never a restatement.
export function nationalDerivedObjectSet(planeDirectory) {
  const manifestPath = join(planeDirectory, 'manifest.json');
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.kind !== DERIVED_KIND) throw new Error(`${manifestPath} is not a derived corridor-metrics manifest`);
  const fingerprint = manifest.analysisFingerprint;
  if (!/^[a-f0-9]{64}$/.test(fingerprint ?? '')) throw new Error('the manifest carries no analysis fingerprint');
  const directory = `${PREFIX}/${fingerprint}`;
  const objects = [{ key: `${directory}/manifest.json`, local: manifestPath, bytes: manifestBytes.length,
    sha256: digest(manifestBytes), type: JSON_TYPE, plane: 'national-derived', cell: 'manifest' }];
  const ids = new Set();
  let present = 0;
  let empty = 0;
  for (const cell of manifest.cells ?? []) {
    if (typeof cell.id !== 'string' || ids.has(cell.id)) throw new Error(`invalid or duplicate cell ${cell?.id}`);
    ids.add(cell.id);
    if (cell.state === 'empty') {
      if (cell.url || cell.rowCount !== 0) throw new Error(`${cell.id}: an empty cell must declare no url and zero rows`);
      empty += 1;
      continue;
    }
    if (cell.state !== 'present') throw new Error(`${cell.id}: unknown state ${cell.state}`);
    const key = `${directory}/cells/${cell.id}.parquet`;
    if (cell.url !== key) throw new Error(`${cell.id}: manifest url ${cell.url} is not the immutable key ${key}`);
    if (!Number.isSafeInteger(cell.bytes) || !/^[a-f0-9]{64}$/.test(cell.sha256 ?? '')) throw new Error(`${cell.id}: incomplete artifact description`);
    objects.push({ key, local: join(planeDirectory, 'cells', `${cell.id}.parquet`), bytes: cell.bytes,
      sha256: cell.sha256, type: PARQUET_TYPE, plane: 'national-derived', cell: cell.id });
    present += 1;
  }
  return { fingerprint, directory, manifest, manifestPath, manifestBytes, objects, present, empty,
    declaredCells: ids.size };
}
