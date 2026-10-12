// THE GEOGRAPHIC MAP'S COMMITTED CONTRACT, IN ONE PLACE.
//
// Two production gates read the same facts about the map - which implementation is running, whether it initialised,
// what search geometry it is drawing, where its camera is - so those facts live here rather than in two DOM models
// that drift apart. Every helper reads only what the application itself publishes: the small read-only diagnostic the
// map factory exposes, and the attributes the map stamps on the geometry it draws. Nothing here reaches into Leaflet.
//
// This module is not a test file: the runner collects `*.spec.js` (Playwright) and `*.test.js` (node --test).
export const MILES_TO_M = 1609.344;

export const mapImplementation = page => page.evaluate(() => globalThis.__RN_MAP?.implementation ?? null);
export const mapAvailable = page => page.evaluate(() => globalThis.__RN_MAP?.available ?? false);
export const searchGeometry = page => page.evaluate(() => globalThis.__RN_MAP?.searchGeometry?.() ?? { center: null, radiusM: null });
// Named with the `Of` suffix because both specs already shadow the bare names locally.
export const cameraOf = page => page.evaluate(() => globalThis.__RN_MAP?.camera?.() ?? null);
export const fitCountOf = page => page.evaluate(() => globalThis.__RN_MAP?.fitCount?.() ?? 0);
export const movementCount = page => page.evaluate(() => globalThis.__RN_MAP?.movements?.() ?? 0);

// The requested search centre as the map draws it: the corridor map marks its own search geometry, so a search centre
// on the map is one marked path - the same fact the schematic renderer used to state with a class of its own.
export const drawnSearchCentre = page => page.locator('#map path[data-role="search-center"]');
