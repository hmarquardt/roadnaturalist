// THE INVESTIGATOR'S PUBLIC FEATURE BOUNDARY.
//
// Everything the application needs from the Investigator is re-exported from this one module, so the ordinary
// application never names Investigator internals: it loads this boundary, once, when somebody asks for access
// research, and the whole feature arrives with it. The internals stay free to move — a module that is renamed,
// split or merged is a change inside the Investigator, not a change to the application.
//
// This module is never in the ordinary application's static import graph. `tests/investigator-boundary.test.js`
// walks that graph and fails if anything under src/investigator/ becomes reachable from src/app/main.js again.
export { createInvestigatorService } from './service.js';
export { RETRIEVAL_MODE, createWorkerResearchTransport, probeAvailability, retrievalModeCounts } from './worker-transport.js';
export { buildProbeBaseline, baselineIndex, compareProbeEvidence, summarizeDrift } from './drift.js';
export { createResearchService, createRecordedTransport, createLiveResearchTransport } from './research.js';
export { BROWSER_MIRRORS, createOsmSource, createRecordedOsmSource } from './osm.js';
export { PILOT_PROBES_BY_CORRIDOR } from './sources.js';
export { buildCorridorBundle } from './bundle.js';

// The reviewed operator capture the Investigator replays. The *name* of Investigator data belongs inside the feature,
// so the ordinary application shell never has to know where it lives - it is handed this URL when the feature loads.
export const ACCESS_EVIDENCE_URL = new URL('../../data/investigator/or-pilot-access-evidence.json', import.meta.url);
