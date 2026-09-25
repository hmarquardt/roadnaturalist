export function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.datasets)) throw new TypeError('Invalid data manifest');
  for (const dataset of manifest.datasets) {
    if (!dataset.id || !dataset.version || dataset.format !== 'GeoParquet' || !dataset.url || !Number.isSafeInteger(dataset.bytes) || !/^[0-9a-f]{64}$/.test(dataset.sha256) || dataset.crs !== 'EPSG:4326' || !dataset.source?.agency || !dataset.source?.url || !dataset.scope?.bbox) throw new TypeError(`Invalid dataset entry: ${dataset.id ?? 'unnamed'}`);
  }
  return manifest;
}

const DEFAULT_URL = new URL('../../data/manifest.json', import.meta.url);
let defaultPromise;

export async function loadManifest(url = DEFAULT_URL) {
  if (url === DEFAULT_URL) {
    defaultPromise ??= fetchManifest(url).catch(error => { defaultPromise = null; throw error; });
    return defaultPromise;
  }
  return fetchManifest(url);
}

async function fetchManifest(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Manifest unavailable: HTTP ${response.status}`);
  const manifest = await response.json();
  return validateManifest(manifest);
}
