import { EVIDENCE_KIND } from '../domain/corridor.js';

// One normalized occurrence model is the only thing the rest of Road Naturalist sees. Source
// payloads (iNaturalist, eBird) stop at the adapters.
//
// Occurrence evidence is not habitat suitability and not a prediction. A public report proves that
// someone publicized an observation at some place and time; it does not prove that the organism is
// on the road, that it is there now, or that it is likely to be seen.

export const OCCURRENCE_SOURCE = Object.freeze({ INATURALIST: 'inaturalist', EBIRD: 'ebird' });
export const SOURCE_LABELS = Object.freeze({ [OCCURRENCE_SOURCE.INATURALIST]: 'iNaturalist', [OCCURRENCE_SOURCE.EBIRD]: 'eBird' });

// How precise the public location is, as the source itself presents it.
export const LOCATION_PRECISION = Object.freeze({
  PRECISE: 'precise',          // public point with accuracy the source states and we accept
  APPROXIMATE: 'approximate',  // public point, but accuracy is poor or not stated
  OBSCURED: 'obscured',        // the source publishes a randomized or withheld position
  REGIONAL: 'regional',        // only a place-level location is exposed
  UNAVAILABLE: 'unavailable',  // no public location at all
});

// What the app may do with that location. Only CORRIDOR_DISTANCE_ALLOWED records are measured
// against a corridor or drawn as a point.
export const SPATIAL_USE = Object.freeze({
  CORRIDOR_DISTANCE_ALLOWED: 'CORRIDOR_DISTANCE_ALLOWED',
  REGIONAL_ONLY: 'REGIONAL_ONLY',
  NOT_SPATIALLY_USABLE: 'NOT_SPATIALLY_USABLE',
});

export const TAXONOMIC_GROUP = Object.freeze({
  BIRDS: 'birds', MAMMALS: 'mammals', REPTILES: 'reptiles', AMPHIBIANS: 'amphibians', FISH: 'fish',
  INSECTS: 'insects', ARACHNIDS: 'arachnids', MOLLUSKS: 'mollusks', PLANTS: 'plants', FUNGI: 'fungi', OTHER: 'other',
});
export const TAXONOMIC_GROUP_LABELS = Object.freeze({
  birds: 'Birds', mammals: 'Mammals', reptiles: 'Reptiles', amphibians: 'Amphibians', fish: 'Fish',
  insects: 'Insects', arachnids: 'Arachnids', mollusks: 'Mollusks', plants: 'Plants', fungi: 'Fungi', other: 'Other',
});
// UI lenses group normalized groups; they never reinterpret source taxonomy.
export const TAXON_LENSES = Object.freeze([
  Object.freeze({ id: 'all', label: 'All', groups: Object.freeze(Object.values(TAXONOMIC_GROUP)) }),
  Object.freeze({ id: 'birds', label: 'Birds', groups: Object.freeze([TAXONOMIC_GROUP.BIRDS]) }),
  Object.freeze({ id: 'mammals', label: 'Mammals', groups: Object.freeze([TAXONOMIC_GROUP.MAMMALS]) }),
  Object.freeze({ id: 'herps', label: 'Herps', groups: Object.freeze([TAXONOMIC_GROUP.REPTILES, TAXONOMIC_GROUP.AMPHIBIANS]) }),
  Object.freeze({ id: 'insects', label: 'Insects', groups: Object.freeze([TAXONOMIC_GROUP.INSECTS, TAXONOMIC_GROUP.ARACHNIDS]) }),
  Object.freeze({ id: 'plants', label: 'Plants', groups: Object.freeze([TAXONOMIC_GROUP.PLANTS]) }),
  Object.freeze({ id: 'fungi', label: 'Fungi', groups: Object.freeze([TAXONOMIC_GROUP.FUNGI]) }),
]);

// Evidence search distances around the corridor. They are evidence radii, not biological thresholds.
export const OCCURRENCE_RADII_M = Object.freeze([1000, 5000, 10000]);
// An open iNaturalist point is only allowed into corridor-distance analysis when the source states an
// accuracy at least this good; half of the smallest evidence radius keeps the claim meaningful.
export const CORRIDOR_ACCURACY_LIMIT_M = 500;

// Recency buckets are mutually exclusive, so counting a record in one bucket never hides it from
// another. Source-reported counts are the cumulative windows the API supports and are labelled
// separately ("reported in the last N days").
export const RECENCY_WINDOWS = Object.freeze([
  Object.freeze({ id: 'd30', days: 30, label: 'Last 30 days', maxDays: 30, evidence: EVIDENCE_KIND.RECENT }),
  Object.freeze({ id: 'd90', days: 90, label: '31 to 90 days ago', maxDays: 90, evidence: EVIDENCE_KIND.RECENT }),
  Object.freeze({ id: 'd365', days: 365, label: '91 to 365 days ago', maxDays: 365, evidence: EVIDENCE_KIND.RECENT }),
  Object.freeze({ id: 'historical', days: null, label: 'Older than 365 days', maxDays: null, evidence: EVIDENCE_KIND.HISTORICAL }),
]);

export const PRIVACY_RULE = 'Only a public location that the source presents as precise may be measured against a corridor or plotted. '
  + 'Obscured, approximate, region-level, and withheld locations stay regional evidence: they can support "reported somewhere in this search region" and never "observed N m from this road".';

export const SOURCE_TAXON_MAP = Object.freeze({
  Aves: TAXONOMIC_GROUP.BIRDS, Mammalia: TAXONOMIC_GROUP.MAMMALS, Reptilia: TAXONOMIC_GROUP.REPTILES,
  Amphibia: TAXONOMIC_GROUP.AMPHIBIANS, Actinopterygii: TAXONOMIC_GROUP.FISH, Insecta: TAXONOMIC_GROUP.INSECTS,
  Arachnida: TAXONOMIC_GROUP.ARACHNIDS, Mollusca: TAXONOMIC_GROUP.MOLLUSKS, Plantae: TAXONOMIC_GROUP.PLANTS,
  Fungi: TAXONOMIC_GROUP.FUNGI, Protozoa: TAXONOMIC_GROUP.OTHER, Animalia: TAXONOMIC_GROUP.OTHER,
  Chromista: TAXONOMIC_GROUP.OTHER, Bacteria: TAXONOMIC_GROUP.OTHER,
});

export function taxonomicGroup(sourceGroup) {
  if (!sourceGroup) return TAXONOMIC_GROUP.OTHER;
  return SOURCE_TAXON_MAP[sourceGroup] ?? TAXONOMIC_GROUP.OTHER;
}

const precisionValues = new Set(Object.values(LOCATION_PRECISION));
const spatialUseValues = new Set(Object.values(SPATIAL_USE));
const sourceValues = new Set(Object.values(OCCURRENCE_SOURCE));

function point(value, label) {
  if (value == null) return null;
  const coordinates = value?.type === 'Point' ? value.coordinates : Array.isArray(value) ? value : null;
  if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite)) throw new TypeError(`${label} must be [longitude, latitude]`);
  const [lon, lat] = coordinates;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new TypeError(`${label} is outside the world`);
  return Object.freeze([lon, lat]);
}

export function normalizeOccurrence(raw) {
  if (!raw || !sourceValues.has(raw.source)) throw new TypeError('Occurrence needs a known source');
  if (raw.sourceRecordId == null || String(raw.sourceRecordId) === '') throw new TypeError('Occurrence needs a sourceRecordId');
  const scientificName = raw.scientificName ?? (typeof raw.taxon === 'string' ? raw.taxon : null);
  const commonName = raw.commonName ?? null;
  if (!scientificName && !commonName) throw new TypeError('Occurrence needs at least one taxon name');
  const locationPrecision = raw.locationPrecision ?? LOCATION_PRECISION.UNAVAILABLE;
  if (!precisionValues.has(locationPrecision)) throw new TypeError(`Unknown location precision: ${locationPrecision}`);
  const spatialUse = raw.spatialUse ?? defaultSpatialUse(locationPrecision);
  if (!spatialUseValues.has(spatialUse)) throw new TypeError(`Unknown spatial use: ${spatialUse}`);
  const measured = spatialUse === SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED;
  // A non-precise record can carry no usable point, so a distance can never leak from one.
  const location = measured ? point(raw.location, 'Occurrence location') : null;
  if (measured && !location) throw new TypeError('A corridor-distance occurrence needs a location');
  const taxonId = raw.taxonId == null ? null : String(raw.taxonId);
  const group = raw.taxonomicGroup ?? taxonomicGroup(raw.sourceTaxonGroup);
  return Object.freeze({
    source: raw.source, sourceRecordId: String(raw.sourceRecordId), sourceUrl: raw.sourceUrl ?? null,
    taxonId, scientificName, commonName, taxonomicGroup: group, sourceTaxonGroup: raw.sourceTaxonGroup ?? null,
    taxonRank: raw.taxonRank ?? null, sourceTaxonId: raw.sourceTaxonId ?? null,
    observedAt: raw.observedAt ?? null, observedOn: raw.observedOn ?? null, observedTimeZone: raw.observedTimeZone ?? null,
    location, locationPrecision, spatialUse,
    positionalAccuracyM: finiteOrNull(raw.positionalAccuracyM),
    publicAccuracyM: finiteOrNull(raw.publicAccuracyM),
    spatialExclusionReason: measured ? null : (raw.spatialExclusionReason ?? defaultExclusionReason(locationPrecision)),
    quality: raw.quality ?? null, captive: raw.captive ?? null, count: finiteOrNull(raw.count),
    distanceToCorridorM: measured ? finiteOrNull(raw.distanceToCorridorM) : null,
    placeGuess: raw.placeGuess ?? null,
    sourceMetadata: Object.freeze({ ...(raw.sourceMetadata ?? {}) }),
    provenance: Object.freeze({ ...(raw.provenance ?? {}) }),
  });
}

export function defaultSpatialUse(precision) {
  return precision === LOCATION_PRECISION.PRECISE ? SPATIAL_USE.CORRIDOR_DISTANCE_ALLOWED : SPATIAL_USE.REGIONAL_ONLY;
}

function defaultExclusionReason(precision) {
  if (precision === LOCATION_PRECISION.OBSCURED) return 'The source publishes an obscured position for this observation.';
  if (precision === LOCATION_PRECISION.APPROXIMATE) return 'The public position is not precise enough for a corridor-distance claim.';
  if (precision === LOCATION_PRECISION.REGIONAL) return 'The source exposes only a place-level location.';
  if (precision === LOCATION_PRECISION.UNAVAILABLE) return 'The source exposes no public location.';
  return null;
}

function finiteOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
