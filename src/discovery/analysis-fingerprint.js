import { ANALYSIS_DISTANCES_M } from '../gis/habitat-result.js';
import { ANALYSIS_GEOMETRY_METHOD, ANALYSIS_GEOMETRY_TOLERANCE } from '../domain/analytical-geometry.js';
import { HABITAT_METRIC_DEFINITION } from '../gis/habitat-metrics.js';
import { DISCOVERY_ID_PREFIX, JOIN_TOLERANCE_M, MAX_CORRIDOR_M, MIN_CORRIDOR_M, TARGET_CORRIDOR_M } from './constants.js';
import { REVERSED_LINK_LENGTH_RATIO } from '../roads/normalize.js';

// The analysis profile: the discovery semantics a derived artifact freezes.
//
// Derived corridor metrics are only trustworthy while they describe the *current* rules. So the profile is
// built from the values the runtime actually uses (never from a second copy of the constants), reduced to a
// canonical JSON document and hashed. The hash is the artifact's identity: a published derived manifest
// carries the fingerprint it was built with, and a browser whose own fingerprint differs reports the derived
// layer as unavailable instead of showing numbers computed under different rules.
//
// The inputs are semantics only. Build timestamps, Pages deployment ids, R2 origins and user state are
// deliberately absent: rebuilding the same rules from the same data must produce the same fingerprint.
export const ANALYSIS_PROFILE_VERSION = 1;
// Bumped by hand whenever the derived row shape changes; it is part of the fingerprint, so an old artifact
// can never be mistaken for a current one.
export const DERIVED_SCHEMA_VERSION = 1;

const METRIC_SEMANTICS = Object.freeze({
  wetlandArea: 'feature-area-sum-v1',
  hydrographyLength: 'clipped-length-sum-v1',
  habitatCounts: 'distinct-contributing-features-v1',
  coverage: 'extent-per-distance-v1',
  hydroNames: 'sorted-distinct-first-40-v1',
});

// The digest of a published dataset's partitions: sorted cell ids with their content digests, hashed. It
// covers every published byte of a dataset without hashing a list of thousands of URLs into the fingerprint.
async function partitionDigest(dataset) {
  const entries = (dataset.partitions ?? []).map(part => `${part.id}:${part.sha256 ?? (part.state === 'empty' ? 'empty' : 'unknown')}`).sort();
  return sha256Hex(entries.join('\n'));
}

function canonicalize(value) {
  // Canonical JSON: object keys sorted, arrays kept in order, no whitespace. Two builds of the same inputs
  // produce byte-identical text, which is what makes the digest meaningful.
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

export function canonicalJson(value) {
  return canonicalize(value);
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// The profile document: exactly the semantics, with dataset versions and digests supplied by the caller.
export async function analysisProfile({ regionalCatalog = null, manifest = null, roadComponents = null } = {}) {
  const datasets = new Map((manifest?.datasets ?? []).map(dataset => [dataset.id, dataset]));
  const regional = new Map((regionalCatalog?.datasets ?? []).map(dataset => [dataset.id, dataset]));
  const describe = async (id, source = datasets) => {
    const entry = source.get(id);
    if (!entry) return { id, version: null, digest: null };
    return { id, version: entry.version ?? null, digest: entry.sha256 ?? await partitionDigest(entry) };
  };
  const ecoregions = (manifest?.datasets ?? []).filter(dataset => dataset.id.startsWith('epa-ecoregions-'))
    .map(dataset => ({ id: dataset.id, version: dataset.version ?? null, digest: dataset.sha256 ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    kind: 'road-discovery-analysis-profile',
    profileVersion: ANALYSIS_PROFILE_VERSION,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    region: regionalCatalog ? { version: regionalCatalog.version, bounds: regionalCatalog.region?.bounds ?? null } : null,
    roadSource: regionalCatalog ? await describe('roads', regional) : null,
    roadComponents: regionalCatalog?.roadComponentsSha256
      ? { digest: regionalCatalog.roadComponentsSha256, joinToleranceM: JOIN_TOLERANCE_M,
          multiCellComponents: regionalCatalog.roadComponents?.multiCell ?? null }
      : (roadComponents ? { digest: await sha256Hex(canonicalJson(roadComponents.components ?? [])),
          joinToleranceM: JOIN_TOLERANCE_M, multiCellComponents: roadComponents.components?.length ?? null } : null),
    composition: { toleranceM: JOIN_TOLERANCE_M, reversedLinkLengthRatio: REVERSED_LINK_LENGTH_RATIO },
    segmentation: { idPrefix: DISCOVERY_ID_PREFIX, minCorridorM: MIN_CORRIDOR_M,
      targetCorridorM: TARGET_CORRIDOR_M, maxCorridorM: MAX_CORRIDOR_M },
    analyticalGeometry: { methods: Object.values(ANALYSIS_GEOMETRY_METHOD),
      // A doubled source traversal is removed before the engine probe (see src/gis/analytical-geometry.js):
      // which line the metrics describe is part of the analysis rules, not of the engine, so it belongs here.
      duplicateSegmentsBeforeProbe: true,
      tolerance: { maxDisplacementM: ANALYSIS_GEOMETRY_TOLERANCE.maxDisplacementM,
        maxBoundsDeltaDeg: ANALYSIS_GEOMETRY_TOLERANCE.maxBoundsDeltaDeg,
        minLengthRatio: ANALYSIS_GEOMETRY_TOLERANCE.minLengthRatio } },
    habitat: regionalCatalog ? { wetlands: await describe('wetlands', regional),
      hydrography: await describe('hydrography', regional) } : null,
    ecology: ecoregions,
    // The habitat halo the catalog declares is part of the coverage rule: it decides whether a search region
    // counts as fully covered, so it belongs in the fingerprint even though it is a selection constant.
    maxAnalysisDistanceM: regionalCatalog?.maxAnalysisDistanceM ?? null,
    analysisDistancesM: [...ANALYSIS_DISTANCES_M],
    metrics: { ...METRIC_SEMANTICS, wetlandDefinition: HABITAT_METRIC_DEFINITION.area },
  };
}

export async function analysisFingerprint(options = {}) {
  const profile = options.profile ?? await analysisProfile(options);
  return { profile, fingerprint: await sha256Hex(canonicalJson(profile)) };
}
