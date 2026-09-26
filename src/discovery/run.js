import { COVERAGE } from '../domain/corridor.js';
import { minDistanceToLineM } from '../domain/geometry.js';
import { ANALYSIS_DISTANCES, MAX_SEARCH_FEATURES, MAX_RESULT_ROWS } from './constants.js';
import { eligibleClasses, eligibilitySummary } from './eligibility.js';
import { buildDiscoveryUnits } from './units.js';
import { segmentUnit } from './segment.js';
import { buildDiscoveryResult } from './signals.js';
import { summarizeDiscoveryCoverage } from './coverage.js';
import { applyMarks } from './lifecycle.js';
import { contains, intersects } from './regional-catalog.js';
import { isRadiusSearchArea, resolveSearchArea } from './search-area.js';
import { paddedBounds } from '../gis/habitat-result.js';

// One discovery run: read the bounded road network for the search area, build discovery road units,
// segment the long ones, measure every corridor in one set-oriented GIS pass, and publish results with
// their coverage. Nothing here touches an occurrence API or the Investigator: discovery is a bounded,
// deterministic screening pass, and deeper evidence stays an explicit later step.

export async function runDiscovery({ gis, searchArea: declared, marks = {}, eligibility = eligibleClasses(), limit = MAX_SEARCH_FEATURES,
  onProgress = () => {} } = {}) {
  // The declared area may be a radius scenario; resolving it here is what gives the run its bounds and its
  // disk, so a "25-mile radius" search is both selected and filtered as one region.
  const searchArea = resolveSearchArea(declared);
  if (!searchArea?.bbox) throw new TypeError('Discovery needs a search area with bounds');
  const started = performance.now();
  const radiusSearch = isRadiusSearchArea(searchArea);
  const regional = searchArea.catalogUrl ? await gis.prepareRegionalSearch(searchArea, { onProgress }) : null;
  const dataService = regional ?? gis;
  onProgress('Composing road corridors…');
  // The regional road reader has its own guard (MAX_REGIONAL_ROWS); a benchmark can raise it explicitly to
  // measure the wall instead of the guard, and production keeps the declared ceiling.
  const roadQuery = await dataService.queryRoadNetwork({ bbox: searchArea.bbox, roadClasses: eligibility,
    limit: regional ? (searchArea.maxFeatures ?? 100000) : limit });
  const roadQueryMs = Math.round(performance.now() - started);
  const features = roadQuery.features ?? [];
  const base = { searchArea, roadQuery, diagnostics: { roadQueryMs, datasetErrors: roadQuery.diagnostics?.reason ? [roadQuery.diagnostics.reason] : [] } };
  if (roadQuery.coverage === COVERAGE.UNKNOWN || roadQuery.coverage === COVERAGE.NONE) {
    // A failed or empty read of a bounded extract is never "no candidate roads exist here".
    return { ...base, status: 'unavailable', results: [], coverage: summarizeDiscoveryCoverage({ roadQuery, searchArea }),
      raw: { features: [], units: [], corridors: [] } };
  }

  const unitsStarted = performance.now();
  const built = buildDiscoveryUnits(features);
  // Corridor inclusion follows the requested search region, not the rectangle a cell grid has to be
  // selected with: a radius search keeps a unit only when some part of its road lies inside the disk.
  // The distance uses the domain's haversine measurement, so the boundary is accurate to well under a
  // metre at 50 miles rather than to the equirectangular approximation.
  const insideSearch = unit => {
    if (!regional) return true;
    if (!intersects(unit.bounds, searchArea.bbox)) return false;
    if (!radiusSearch) return true;
    return minDistanceToLineM(searchArea.center, unit.geometry) <= searchArea.radiusM;
  };
  const relevantUnits = built.units.filter(insideSearch);
  const unitsMs = Math.round(performance.now() - unitsStarted);
  const segmentsStarted = performance.now();
  const corridors = [];
  let droppedShortUnits = 0;
  for (const unit of relevantUnits) {
    const segmented = segmentUnit(unit);
    if (!segmented.corridors.length) { droppedShortUnits += 1; continue; }
    for (const corridor of segmented.corridors) corridors.push({ unit, corridor, segmentation: segmented.segmentation });
  }
  const segmentationMs = Math.round(performance.now() - segmentsStarted);

  const analysisStarted = performance.now();
  onProgress(`Analyzing ${corridors.length} corridors…`);
  const analysis = await dataService.analyzeDiscovery(corridors.map(entry => ({ id: entry.corridor.id, geometry: entry.corridor.geometry })));
  const analysisMs = Math.round(performance.now() - analysisStarted);
  const buildStarted = performance.now();
  const roadState = roadQuery.coverage;
  const results = applyMarks(corridors.map(entry => buildDiscoveryResult({ unit: entry.unit, corridor: entry.corridor,
    metrics: regional ? regionalCorridorMetrics(analysis.corridors[entry.corridor.id], entry.corridor.bounds,
      regional.selection.publishedBounds, regional.selection.maxAnalysisDistanceM) : analysis.corridors[entry.corridor.id],
    roadState, provenance: roadQuery.provenance,
    analysisDistancesM: ANALYSIS_DISTANCES })), marks);
  const buildMs = Math.round(performance.now() - buildStarted);
  const coverage = summarizeDiscoveryCoverage({ roadQuery, searchArea, results,
    searchCoverage: regional ? { coverage: regional.selection.coverage, reason: regional.selection.reason } : null,
    eligibility: built.blocked, diagnostics: { droppedShortUnits } });
  return {
    ...base,
    status: 'ready', results,
    coverage,
    eligibility: eligibilitySummary(features),
    diagnostics: {
      ...base.diagnostics,
      roadQueryMs, unitsMs, segmentationMs, analysisMs, buildMs,
      totalMs: Math.round(performance.now() - started),
      datasetErrors: analysis.diagnostics.datasetErrors ?? [],
      partitionSelection: regional?.selection ?? null,
      partitionClosure: regional?.selection?.closure ?? null,
      partitionTimingMs: regional?.timing ?? null,
      searchShape: radiusSearch ? { kind: 'radius', center: searchArea.center, radiusMiles: searchArea.radiusMiles, radiusM: searchArea.radiusM }
        : { kind: 'bbox' },
      counts: Object.freeze({ features: features.length, eligibleUnits: relevantUnits.length, corridors: corridors.length,
        droppedShortUnits, displayed: Math.min(results.length, MAX_RESULT_ROWS),
        unbufferableCorridors: analysis.diagnostics.unbufferableCorridors?.length ?? 0,
        repairedCorridors: analysis.diagnostics.repairedCorridors?.length ?? 0 }),
      batch: Object.freeze({ status: analysis.diagnostics.status, reason: analysis.diagnostics.reason,
        queryMs: analysis.diagnostics.queryMs, phaseMs: analysis.diagnostics.phaseMs ?? {},
        unbufferableCorridors: Object.freeze([...(analysis.diagnostics.unbufferableCorridors ?? [])]),
        repairedCorridors: Object.freeze([...(analysis.diagnostics.repairedCorridors ?? [])]),
        analyticalGeometry: analysis.diagnostics.analyticalGeometry ?? null }),
      note: 'Discovery measured the road network, wetlands, hydrography, and ecoregions once per dataset for every corridor in the search area.',
    },
    // The source features are kept so a promoted corridor can be rebuilt as an ordinary candidate
    // without re-reading the extract.
    raw: { features, units: built.units, corridors },
  };
}

// Road-name composition may extend beyond the requested search box. A complete search-box halo
// therefore does not prove complete habitat coverage for every resulting corridor.
export function regionalCorridorMetrics(metrics, corridorBounds, publishedBounds, maxAnalysisDistanceM = 1000) {
  if (!metrics || contains(publishedBounds, paddedBounds(corridorBounds, maxAnalysisDistanceM))) return metrics;
  const reason = 'The corridor and its 1 km habitat buffer leave published regional coverage.';
  const partial = layer => layer?.coverage === COVERAGE.UNKNOWN || layer?.coverage === COVERAGE.NONE ? layer
    : { ...layer, coverage: COVERAGE.PARTIAL, reason };
  return { ...metrics, wetlands: partial(metrics.wetlands), hydrography: partial(metrics.hydrography) };
}
