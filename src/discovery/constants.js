// Discovery is candidate generation: it surveys a bounded area and proposes road units that carry
// physical/ecological characteristics worth a closer look. It is not wildlife prediction, not a
// ranking, and not a recommendation. These constants are analysis and interface units, not
// ecological truths: a corridor is a length of road a person can inspect, not a claim about habitat.
// scripts/build-road-network.py mirrors them offline (test-asserted agreement).
export const MIN_CORRIDOR_M = 1609.344; // 1 mi: below this a road is not a useful discovery candidate
export const TARGET_CORRIDOR_M = 6437.376; // 4 mi: the segment length a long road is aimed at
export const MAX_CORRIDOR_M = 12874.752; // 8 mi: a 40-mile road is segmented down to about this
export const JOIN_TOLERANCE_M = 150; // the road-composition tolerance: short junction gaps join
export const ANALYSIS_DISTANCES = Object.freeze([250, 500, 1000]);
export const MAX_SEARCH_FEATURES = 20000; // bounded extract guard, not a national capability
export const MAX_RESULT_ROWS = 400; // displayed discovery rows; the map layer uses the same cap
export const DISCOVERY_ID_PREFIX = 'drv1';
export const SEGMENTED_ROAD_NOTE = 'Discovery corridors are analysis units: the same named road can become several contiguous corridors. '
  + 'They are not ecological units and they say nothing about access.';
