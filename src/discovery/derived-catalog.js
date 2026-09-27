import { COVERAGE } from '../domain/corridor.js';
import { boundsCoverage, intersects } from './regional-catalog.js';

// The derived corridor-metrics catalog.
//
// Derived partitions hold the deterministic discovery result for every corridor in a published regional
// window, so browsing a regional radius no longer re-runs the buffered analysis for every corridor. They are
// an acceleration layer, not a second truth: each row carries the canonical corridor geometry, and promotion
// reconstructs that corridor from the raw partitions and verifies it before any detailed analysis runs.
//
// The manifest is only usable when its analysis fingerprint matches the semantics the running code implements.
// A mismatch is reported as an unavailable derived layer with a reason - never as stale numbers, and never as
// an automatic 90-second raw fallback.
export const DERIVED_KIND = 'road-derived-corridor-metrics';

export function validateDerivedManifest(manifest) {
  if (manifest?.kind !== DERIVED_KIND || manifest.schemaVersion !== 1) throw new TypeError('Not a derived corridor-metrics manifest');
  if (!/^[a-f0-9]{64}$/.test(manifest.analysisFingerprint ?? '')) throw new TypeError('Derived manifest carries no analysis fingerprint');
  if (!manifest.region?.bounds || !Array.isArray(manifest.region.bounds) || manifest.region.bounds.length !== 4) {
    throw new TypeError('Derived manifest declares no published region');
  }
  if (!manifest.grid?.kind || !Array.isArray(manifest.grid.origin) || !(manifest.grid.stepLon > 0) || !(manifest.grid.stepLat > 0)) {
    throw new TypeError('Derived manifest declares no partition scheme');
  }
  if (!Array.isArray(manifest.cells) || !manifest.cells.length) throw new TypeError('Derived manifest declares no cells');
  const ids = new Set();
  for (const cell of manifest.cells) {
    if (typeof cell.id !== 'string' || ids.has(cell.id) || !Array.isArray(cell.bounds) || cell.bounds.length !== 4
      || !cell.bounds.every(Number.isFinite) || !['present', 'empty'].includes(cell.state)
      || !Number.isSafeInteger(cell.rowCount)) throw new TypeError(`Invalid derived cell ${cell?.id ?? 'unknown'}`);
    if (cell.state === 'present' && !(typeof cell.url === 'string' && Number.isSafeInteger(cell.bytes)
      && /^[a-f0-9]{64}$/.test(cell.sha256 ?? '') && cell.rowCount > 0)) {
      throw new TypeError(`Invalid derived artifact ${cell.id}`);
    }
    if (cell.state === 'empty' && (cell.url || cell.rowCount !== 0)) throw new TypeError(`Invalid empty derived cell ${cell.id}`);
    ids.add(cell.id);
  }
  return manifest;
}

// The fingerprint gate. `expected` is the fingerprint the running code computes from the published data
// plane; anything else fails closed with a reason the interface can show.
export function derivedAvailability(manifest, expectedFingerprint) {
  if (!manifest) return { available: false, reason: 'No derived corridor metrics are published for this region.' };
  if (manifest.analysisFingerprint !== expectedFingerprint) {
    return { available: false, expected: expectedFingerprint ?? null, published: manifest.analysisFingerprint,
      reason: 'Precomputed discovery metrics were built for different analysis rules (analysis version mismatch), '
        + 'so they are not shown. The raw regional data is still available for a narrowed search.' };
  }
  return { available: true, reason: null, fingerprint: manifest.analysisFingerprint };
}

export function selectDerivedCells(manifest, bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)
    || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new TypeError('Derived search needs ordered finite bounds');
  const region = manifest.region.bounds;
  // The corridor row already carries complete metrics for its whole corridor, so selection is the search box
  // itself: no analysis halo is needed here (raw detailed promotion keeps its own halo rules).
  const coverage = boundsCoverage(bounds, region);
  const cells = manifest.cells.filter(cell => intersects(cell.bounds, bounds));
  const present = cells.filter(cell => cell.state === 'present');
  return Object.freeze({ coverage,
    reason: coverage === COVERAGE.FULL ? null : coverage === COVERAGE.NONE
      ? 'Search is outside the published derived coverage.'
      : 'Search extends beyond the published derived coverage.',
    bounds, publishedBounds: region, cells, present,
    counts: { cells: cells.length, present: present.length, empty: cells.length - present.length },
    bytes: present.reduce((total, cell) => total + cell.bytes, 0) });
}
