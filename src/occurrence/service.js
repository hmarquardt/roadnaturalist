import { COVERAGE } from '../domain/corridor.js';

// Normalized records are the only occurrence shape exposed to the application.
// A source's obscured coordinates can establish regional context, never LOCAL evidence.
export function normalizeOccurrence(record) {
  if (!record?.source || !record?.sourceRecordId || !record?.taxon) throw new TypeError('Occurrence needs source, sourceRecordId, and taxon');
  const precision = record.locationPrecision ?? 'unknown';
  if (!['exact', 'obscured', 'regional', 'unknown'].includes(precision)) throw new TypeError('Unknown location precision');
  return Object.freeze({ source: record.source, sourceRecordId: record.sourceRecordId, taxon: record.taxon, scientificName: record.scientificName ?? null, commonName: record.commonName ?? null, taxonomicGroup: record.taxonomicGroup ?? null, observedAt: record.observedAt ?? null, location: precision === 'exact' ? record.location ?? null : null, locationPrecision: precision, quality: record.quality ?? null, provenance: record.provenance ?? null, distanceToCorridorM: precision === 'exact' ? record.distanceToCorridorM ?? null : null, ecoregion: record.ecoregion ?? null });
}

export function createOccurrenceService(adapters = {}) {
  return {
    async getNearby({ source, corridor, radiusM, dateRange, taxa } = {}) {
      if (!adapters[source]) return { coverage: COVERAGE.UNKNOWN, records: [], reason: `${source ?? 'Occurrence'} adapter is not connected` };
      const result = await adapters[source].getNearby({ corridor, radiusM, dateRange, taxa });
      return { ...result, records: result.records.map(normalizeOccurrence) };
    }
  };
}
