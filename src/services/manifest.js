// Dataset entries are declared in data/manifest.json. Type-specific fields are validated here so
// application modules never hard-code a dataset path.
export const DATASET_TYPE = Object.freeze({ ECOREGIONS: 'ecoregions', ROAD_CENTERLINES: 'road-centerlines',
  ROAD_CENTERLINE_NETWORK: 'road-centerlines-network', WETLANDS: 'wetlands', HYDROGRAPHY: 'hydrography' });

export function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.datasets) || !manifest.datasets.length) throw new TypeError('Invalid data manifest');
  for (const dataset of manifest.datasets) validateDataset(dataset);
  return manifest;
}

function validateDataset(dataset) {
  const common = dataset && typeof dataset.id === 'string' && dataset.id && typeof dataset.version === 'string' && dataset.version
    && typeof dataset.type === 'string' && dataset.type && dataset.format === 'GeoParquet' && typeof dataset.url === 'string' && dataset.url
    && Number.isSafeInteger(dataset.bytes) && /^[0-9a-f]{64}$/.test(dataset.sha256) && dataset.crs === 'EPSG:4326'
    && typeof dataset.source?.agency === 'string' && dataset.source.agency && typeof dataset.source?.url === 'string' && dataset.source.url
    && Array.isArray(dataset.scope?.bbox) && dataset.scope.bbox.length === 4 && dataset.scope.bbox.every(Number.isFinite);
  if (!common) throw new TypeError(`Invalid dataset entry: ${dataset?.id ?? 'unnamed'}`);
  if (dataset.type === DATASET_TYPE.ROAD_CENTERLINES) {
    const road = Number.isSafeInteger(dataset.roadCount) && dataset.roadCount > 0 && Number.isSafeInteger(dataset.featureCount) && dataset.featureCount > 0
      && typeof dataset.source?.dataset === 'string' && dataset.source.dataset && typeof dataset.normalization?.method === 'string' && dataset.normalization.method
      && Array.isArray(dataset.scope?.roads) && dataset.scope.roads.length > 0
      && dataset.scope.roads.every(entry => typeof entry.id === 'string' && entry.id && typeof entry.name === 'string' && entry.name)
      && typeof dataset.source?.urls === 'object' && dataset.source.urls && Object.keys(dataset.source.urls).length > 0;
    if (!road) throw new TypeError(`Invalid road dataset entry: ${dataset.id}`);
  }
  if (dataset.type === DATASET_TYPE.ROAD_CENTERLINE_NETWORK) {
    // The discovery network must declare how much it holds, which TIGER classes it kept, how much it
    // left out, and in which CRS distances are measured: discovery coverage claims depend on all four.
    const network = Number.isSafeInteger(dataset.featureCount) && dataset.featureCount > 0
      && Number.isSafeInteger(dataset.roadCount) && dataset.roadCount > 0
      && Number.isSafeInteger(dataset.pointCount) && dataset.pointCount > 0
      && typeof dataset.source?.dataset === 'string' && dataset.source.dataset
      && typeof dataset.normalization?.method === 'string' && dataset.normalization.method
      && typeof dataset.normalization?.measureCrs === 'string' && dataset.normalization.measureCrs
      && typeof dataset.scope?.classes === 'object' && dataset.scope.classes && Object.keys(dataset.scope.classes).length > 0
      && typeof dataset.scope?.excludedClasses === 'object' && dataset.scope.excludedClasses
      && Number.isFinite(dataset.scope?.totalLengthM) && dataset.scope.totalLengthM > 0
      && typeof dataset.source?.urls === 'object' && dataset.source.urls && Object.keys(dataset.source.urls).length > 0;
    if (!network) throw new TypeError(`Invalid road-network dataset entry: ${dataset.id}`);
  }
  if (dataset.type === DATASET_TYPE.WETLANDS || dataset.type === DATASET_TYPE.HYDROGRAPHY) {
    // Buffered habitat datasets must declare their coverage extent, measured CRS, and geometry
    // treatment: coverage claims depend on knowing exactly which analysis region the extract covers.
    const habitat = Number.isSafeInteger(dataset.featureCount) && dataset.featureCount > 0
      && typeof dataset.source?.dataset === 'string' && dataset.source.dataset && dataset.source.sha256
      && typeof dataset.normalization?.method === 'string' && dataset.normalization.method
      && typeof dataset.normalization?.measureCrs === 'string' && dataset.normalization.measureCrs
      && Number.isFinite(dataset.scope?.windowMarginM) && dataset.scope.windowMarginM > 0
      && typeof dataset.scope?.geometryTreatment === 'object' && dataset.scope.geometryTreatment
      && Number.isFinite(dataset.scope.geometryTreatment.simplifiedToleranceM);
    if (!habitat) throw new TypeError(`Invalid habitat dataset entry: ${dataset.id}`);
    if (dataset.type === DATASET_TYPE.HYDROGRAPHY
      && !(dataset.layers?.flowline?.featureCount > 0 && dataset.layers?.waterbody?.featureCount > 0)) {
      throw new TypeError(`Hydrography dataset needs flowline and waterbody layers: ${dataset.id}`);
    }
  }
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
