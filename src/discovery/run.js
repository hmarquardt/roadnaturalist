import { COVERAGE } from '../domain/corridor.js';
import { ANALYSIS_DISTANCES, MAX_SEARCH_FEATURES, MAX_RESULT_ROWS } from './constants.js';
import { eligibleClasses, eligibilitySummary } from './eligibility.js';
import { buildDiscoveryUnits } from './units.js';
import { segmentUnit } from './segment.js';
import { buildDiscoveryResult } from './signals.js';
import { summarizeDiscoveryCoverage } from './coverage.js';
import { applyMarks } from './lifecycle.js';

// One discovery run: read the bounded road network for the search area, build discovery road units,
// segment the long ones, measure every corridor in one set-oriented GIS pass, and publish results with
// their coverage. Nothing here touches an occurrence API or the Investigator: discovery is a bounded,
// deterministic screening pass, and deeper evidence stays an explicit later step.

export async function runDiscovery({ gis, searchArea, marks = {}, eligibility = eligibleClasses(), limit = MAX_SEARCH_FEATURES } = {}) {
  if (!searchArea?.bbox) throw new TypeError('Discovery needs a search area with bounds');
  const started = performance.now();
  const roadQuery = await gis.queryRoadNetwork({ bbox: searchArea.bbox, roadClasses: eligibility, limit });
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
  const unitsMs = Math.round(performance.now() - unitsStarted);
  const segmentsStarted = performance.now();
  const corridors = [];
  let droppedShortUnits = 0;
  for (const unit of built.units) {
    const segmented = segmentUnit(unit);
    if (!segmented.corridors.length) { droppedShortUnits += 1; continue; }
    for (const corridor of segmented.corridors) corridors.push({ unit, corridor, segmentation: segmented.segmentation });
  }
  const segmentationMs = Math.round(performance.now() - segmentsStarted);

  const analysisStarted = performance.now();
  const analysis = await gis.analyzeDiscovery(corridors.map(entry => ({ id: entry.corridor.id, geometry: entry.corridor.geometry })));
  const analysisMs = Math.round(performance.now() - analysisStarted);
  const buildStarted = performance.now();
  const roadState = roadQuery.coverage;
  const results = applyMarks(corridors.map(entry => buildDiscoveryResult({ unit: entry.unit, corridor: entry.corridor,
    metrics: analysis.corridors[entry.corridor.id], roadState, provenance: roadQuery.provenance,
    analysisDistancesM: ANALYSIS_DISTANCES })), marks);
  const buildMs = Math.round(performance.now() - buildStarted);
  const coverage = summarizeDiscoveryCoverage({ roadQuery, searchArea, results,
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
      counts: Object.freeze({ features: features.length, eligibleUnits: built.units.length, corridors: corridors.length,
        droppedShortUnits, displayed: Math.min(results.length, MAX_RESULT_ROWS),
        unbufferableCorridors: analysis.diagnostics.unbufferableCorridors?.length ?? 0 }),
      batch: Object.freeze({ status: analysis.diagnostics.status, reason: analysis.diagnostics.reason,
        queryMs: analysis.diagnostics.queryMs, phaseMs: analysis.diagnostics.phaseMs ?? {},
        unbufferableCorridors: Object.freeze([...(analysis.diagnostics.unbufferableCorridors ?? [])]) }),
      note: 'Discovery measured the road network, wetlands, hydrography, and ecoregions once per dataset for every corridor in the search area.',
    },
    // The source features are kept so a promoted corridor can be rebuilt as an ordinary candidate
    // without re-reading the extract.
    raw: { features, units: built.units, corridors },
  };
}
