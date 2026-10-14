import { REPRESENTATIVE_RULE } from './outing-plan.js';

// HANDING ONE ROAD TO A NAVIGATION APP.
//
// Road Naturalist does not route. It opens the person's own mapping application at ONE coordinate - the representative
// point this project already uses for planning - and that application does whatever it does with it. No directions are
// fetched, no route is stored, no travel time is estimated, and nothing here knows or claims anything about driving
// between two points. The link is an ordinary URL: it is built from numbers, and it is the person's own tap that opens
// it.
export const NAVIGATION_DESTINATION_NOTE = 'Navigation opens a representative point on the road in your mapping app. '
  + 'It is not an access, parking or road-condition recommendation.';
export const NAVIGATION_VERIFY_NOTE = 'Verify access, road conditions and where you can safely stop.';

// WHICH POINT ON THE ROAD, SAID IN WORDS. The rule is Outing v1's, unchanged: the measured point associated with the
// road's own search context when there is one, otherwise the deterministic halfway point along its geometry. A road has
// one representative point, and this is the same one the plan's separations are measured from.
export const REPRESENTATIVE_RULE_LABEL = Object.freeze({
  [REPRESENTATIVE_RULE.MEASURED]: 'the point your search measured on this road',
  [REPRESENTATIVE_RULE.MIDPOINT]: 'the halfway point along this road',
});

// Five decimals is about a metre: as precise as a representative point on a road should claim to be.
const COORDINATE_DECIMALS = 5;

// The destination for one plan member, or null when the road has no usable representative point. Only finite, in-range
// numbers leave here, so nothing a person typed - a road name, a note - can ever reach a URL.
export function navigationDestination(member) {
  const point = member?.representative ?? null;
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) return null;
  const [lon, lat] = point;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return Object.freeze({ lat, lon,
    rule: member?.representativeRule === REPRESENTATIVE_RULE.MEASURED ? REPRESENTATIVE_RULE.MEASURED
      : REPRESENTATIVE_RULE.MIDPOINT });
}

export function coordinateText(destination) {
  return `${destination.lat.toFixed(COORDINATE_DECIMALS)},${destination.lon.toFixed(COORDINATE_DECIMALS)}`;
}

// The applications a person may already have. Each is an ordinary documented URL that takes a destination; none of them
// is called by this code, and Road Naturalist never sees what happens next.
export const NAVIGATION_PROVIDERS = Object.freeze([
  Object.freeze({ key: 'google', label: 'Google Maps',
    url: destination => `https://www.google.com/maps/dir/?api=1&destination=${coordinateText(destination)}` }),
  Object.freeze({ key: 'apple', label: 'Apple Maps',
    url: destination => `https://maps.apple.com/?daddr=${coordinateText(destination)}` }),
]);

// Every handoff a road offers, or none when it has no representative point - in which case the interface says so rather
// than opening an app at a place nobody measured.
export function navigationLinks(member) {
  const destination = navigationDestination(member);
  if (!destination) return Object.freeze([]);
  return Object.freeze(NAVIGATION_PROVIDERS.map(provider => Object.freeze({ key: provider.key, label: provider.label,
    url: provider.url(destination), rule: destination.rule })));
}

export function navigationDestinationLabel(destination) {
  if (!destination) return null;
  return `${coordinateText(destination)} - ${REPRESENTATIVE_RULE_LABEL[destination.rule]}`;
}
