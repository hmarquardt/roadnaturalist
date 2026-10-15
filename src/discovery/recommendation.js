import { naturalistInterest } from './ranking.js';
import { DEFAULT_DISTANCE_TRANSFORM, explorationOrder, rankExploration } from './exploration-order.js';
import { formatContextDistance } from './search-context.js';

// RECOMMENDATIONS: THE SAME MEASUREMENTS, SAID AS AN ANSWER.
//
// Discovery measures a corridor once and everything else reads that measurement. This module turns the top of the
// exploration order into a small ranked set of cards a person can read in a few seconds: a rank, one short verdict, two
// or three reasons in plain English, and the facts that make it usable (how far, how long).
//
// Three properties, and they are the whole point:
//
//   * NO NEW DATA AND NO NEW MATHS. The order is `rankExploration` - the evaluated, versioned exploration order - and
//     every reason is read from the components `naturalistInterest` already computed. This module ranks nothing itself,
//     changes no weight, and reads no plane.
//   * EVIDENCE-BASED COPY ONLY. A card may say a road has mapped wetland because the wetland component was measured and
//     is high; it may never say a road is good for wildlife, scenic, or worth the drive for reasons the data does not
//     contain. A component that was not measured produces no claim about it - not a claim of absence.
//   * HONEST ABOUT NEAR-TIES. The order is a strict sequence, but "first" is not "far better": when the next road is
//     within the interval the published evaluation itself calls a near tie, the card says so instead of pretending the
//     gap is meaningful.
//
// It is still an exploration heuristic. A recommendation here means "worth considering first on these measurements", and
// the note beside the cards says exactly that.
export const RECOMMENDATION_LIMIT = 5;

// THE NEAR-TIE INTERVAL IS THE EVALUATION'S OWN. `data/ranking/exploration-order-v1-evaluation.json` reports
// `nearTieInterval: 1`, so a gap of less than one point is the same gap the published evaluation already treats as a
// near tie. Reusing it keeps the card copy and the evaluation from disagreeing about what "close" means.
export const NEAR_TIE_POINTS = 1;

// The word a person sees. The machinery underneath is `exploration-order-v1`, and it stays underneath.
export const RECOMMENDED_TERM = 'Recommended';

export const RECOMMENDATION_HEADING_CENTERED = 'Best road-naturalist drives near this search';
export const RECOMMENDATION_HEADING_AREA = 'Top roads in this search area';

export const RECOMMENDATION_NOTE = 'These are the first roads in the recommendation order: mapped wetland, water and '
  + 'ecological variety around each corridor, with a small, bounded preference for roads nearer your search centre. It is '
  + 'an exploration order built from measurements, not a wildlife prediction, an access or safety statement, or a claim '
  + 'that one road is better than another.';

// The boundary between the answer and the workbench. Everything the application could always do is still below it.
export const ADVANCED_HEADING = 'Explore all results';
export const ADVANCED_NOTE = 'The full result set, with every measured column, the filters and the sort control. Nothing '
  + 'here is removed by the recommendations above: they are the first five roads in one order over the same measurements.';

export const BEST_OVERALL_LABEL = 'Best overall';

// The heading follows the search: a centred search can honestly say "near this search", a declared box has no centre to
// be near, so it says where the roads are instead of inventing a distance.
export function recommendationHeading({ hasCenter = false } = {}) {
  return hasCenter ? RECOMMENDATION_HEADING_CENTERED : RECOMMENDATION_HEADING_AREA;
}

export function recommendationRankText(rank) {
  if (!Number.isFinite(rank) || rank < 1) return null;
  return rank === 1 ? `#1 ${BEST_OVERALL_LABEL}` : `#${rank}`;
}

// THE REASONS, BUILT FROM THE COMPONENTS' OWN DETAIL. Each one carries the measured number it is describing, so a card
// can be checked against the detail panel: the sentence and the figure come from the same measurement. A component that
// was measured but found nothing nearby produces a factual line instead - "no mapped wetland within 1 km" is a
// measurement, not a judgement, and it is the honest thing to show when there is nothing to praise.
const COMPONENT_WORDS = Object.freeze({ wetland: 'mapped wetland', water: 'mapped water',
  ecologicalVariety: 'ecological variety' });

const hectares = areaM2 => Math.round(Number(areaM2 ?? 0) / 10_000);
const kilometres = lengthM => (Number(lengthM ?? 0) / 1000).toFixed(1);

function wetlandReason(component) {
  const detail = component.detail;
  if (detail.intersectsCorridor) {
    return hectares(detail.area250M2) >= 1
      ? `Mapped wetland crosses the road, ${hectares(detail.area250M2)} ha within 250 m`
      : 'Mapped wetland crosses the road';
  }
  if (hectares(detail.area250M2) >= 1) return `${hectares(detail.area250M2)} ha of mapped wetland within 250 m`;
  if (hectares(detail.area500M2) >= 1) return `${hectares(detail.area500M2)} ha of mapped wetland within 500 m`;
  if (hectares(detail.area1000M2) >= 1) return `${hectares(detail.area1000M2)} ha of mapped wetland within 1 km`;
  if (Number.isFinite(detail.nearestM)) return `Nearest mapped wetland ${Math.round(detail.nearestM)} m away`;
  return 'No mapped wetland within the analysed distances';
}

function waterReason(component) {
  const detail = component.detail;
  if (detail.crossingCount >= 3) return `Frequent water crossings: ${detail.crossingCount} mapped`;
  if (detail.crossingCount >= 1) return `${detail.crossingCount} mapped water crossing${detail.crossingCount === 1 ? '' : 's'}`;
  if (Number.isFinite(detail.nearestFlowingM) && detail.nearestFlowingM <= 200) {
    return `Flowing water ${Math.round(detail.nearestFlowingM)} m away`;
  }
  if (Number.isFinite(detail.nearestStandingM) && detail.nearestStandingM <= 400) {
    return `Standing water ${Math.round(detail.nearestStandingM)} m away`;
  }
  if (Number(detail.flowlineLength1000M ?? 0) >= 1000) return `${kilometres(detail.flowlineLength1000M)} km of mapped flowline within 1 km`;
  return 'No mapped crossing or nearby water';
}

function varietyReason(component) {
  const detail = component.detail;
  if (detail.transitions >= 1 && detail.ecoregionCount != null) {
    return `Crosses ${detail.ecoregionCount} mapped ecoregions with ${detail.transitions} transition${detail.transitions === 1 ? '' : 's'}`;
  }
  if (detail.ecoregionCount != null && detail.ecoregionCount >= 2) return `Spans ${detail.ecoregionCount} mapped ecoregions`;
  // One ecoregion, no transitions: real, but not a reason this road leads an order, and a negative sentence about it
  // would only pad the card. Nothing is said.
  return null;
}

const REASON_BUILDERS = Object.freeze([
  Object.freeze({ key: 'wetland', build: wetlandReason }),
  Object.freeze({ key: 'water', build: waterReason }),
  Object.freeze({ key: 'ecologicalVariety', build: varietyReason }),
]);

// A reason is POSITIVE when its component is strong or moderate; anything below that is a factual note about what was
// measured, and those are only used when nothing positive exists to say.
function reasonsFor(model) {
  const positive = [];
  const factual = [];
  for (const { key, build } of REASON_BUILDERS) {
    const component = model.components?.[key];
    if (!component?.measured) continue;
    const text = build(component);
    if (!text) continue;
    (component.value >= MODERATE ? positive : factual).push({ key, value: component.value, text });
  }
  positive.sort((left, right) => right.value - left.value
    || REASON_BUILDERS.findIndex(entry => entry.key === left.key) - REASON_BUILDERS.findIndex(entry => entry.key === right.key));
  const chosen = positive.length ? positive : factual;
  return Object.freeze(chosen.slice(0, 3).map(entry => Object.freeze({ key: entry.key, text: entry.text })));
}

// WHAT WAS NOT MEASURED, SAID PLAINLY. A corridor whose habitat coverage is partial is ordered on the signals that were
// measured; the card says so rather than letting a low score read as an absence of habitat.
function cautionFor(model) {
  const missing = (model.missing ?? []).filter(key => COMPONENT_WORDS[key]).map(key => COMPONENT_WORDS[key]);
  if (!missing.length) return null;
  const list = missing.length === 1 ? missing[0]
    : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  return `Not measured here: ${list}. This road's order uses the signals that were measured.`;
}

// THE NEAR-TIE SENTENCE. The order is a sequence; the language must not turn a fraction of a point into a verdict.
function noteFor({ rank, score, aboveScore, nextScore }) {
  const within = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < NEAR_TIE_POINTS;
  if (rank === 1 && within(score, nextScore)) {
    return 'Close call: the next road is near-equal on the same measurements.';
  }
  if (rank > 1 && within(score, aboveScore)) {
    return `Another strong option: near-equal to #${rank - 1} on the same measurements.`;
  }
  return null;
}

// value (`CONTEXT_LABELS` in ranking.js): 60 and above is strong, 35 and above is moderate, 15 and above is some. A label
// can therefore never disagree with the number the detail panel shows for the same component.
const STRONG = 60;
const MODERATE = 35;
const SOME = 15;

const componentValue = (interest, name) => {
  const component = interest?.components?.[name];
  return component?.measured ? component.value : null;
};

// ONE SHORT VERDICT, in the order the evidence is most specific: wetland and water together, then each on its own, then
// ecological variety, then the honest minimum.
//
// WHY THERE IS NO DISTANCE-FLAVOURED LABEL. A label like "strong nearby option" was considered and left out, because it
// cannot honestly fire: the score IS a weighted mean of the measured components, so a road whose components are all below
// the moderate band cannot score in the strong band, and any road that does score strongly already has a habitat label
// above. Placing a distance label earlier would only replace the more informative sentence with the less informative one.
// Proximity is still said - as a fact, in `distanceText`, and in the near-tie sentence - but it is not a category.
export function recommendationLabel(result, { interest = null } = {}) {
  const model = interest ?? naturalistInterest(result);
  const wetland = componentValue(model, 'wetland');
  const water = componentValue(model, 'water');
  const variety = componentValue(model, 'ecologicalVariety');
  if (wetland == null && water == null && variety == null) return 'Context not measured here';
  if (wetland >= STRONG && water >= STRONG) return 'Wetland and water corridor';
  if (wetland >= STRONG) return 'Wetland-rich corridor';
  if (water >= STRONG) return 'Water and crossings';
  if (variety >= STRONG) return 'Habitat transition zone';
  if (wetland >= MODERATE && water >= MODERATE) return 'Wetland and water nearby';
  if (variety >= MODERATE && (wetland >= MODERATE || water >= MODERATE)) return 'Habitat variety nearby';
  if (wetland >= MODERATE) return 'Mapped wetland along the road';
  if (water >= MODERATE) return 'Mapped water along the road';
  if (variety >= MODERATE) return 'Crosses more than one ecoregion';
  if (wetland >= SOME || water >= SOME || variety >= SOME) return 'Some mapped context';
  // A road whose measured context is all low is not interesting for its context, and saying so is more useful than a
  // label that implies something the measurements do not support.
  const measured = [wetland, water, variety].filter(value => value != null).length;
  return measured ? 'Limited mapped context' : 'Context not measured here';
}

// ONE CARD'S WORTH OF MEANING, from one result. `order` may be passed in (the list computes it once); without it the
// exploration order is computed here, so `recommendationSummary(result)` is a complete answer on its own.
export function recommendationSummary(result, { rank = 1, order = null, radiusM = null,
  transform = DEFAULT_DISTANCE_TRANSFORM, aboveScore = null, nextScore = null } = {}) {
  const interest = naturalistInterest(result);
  const exploration = order ?? explorationOrder(result, { radiusM, transform });
  const score = exploration?.score ?? null;
  return Object.freeze({
    rank,
    best: rank === 1,
    rankText: recommendationRankText(rank),
    label: recommendationLabel(result, { interest }),
    reasons: reasonsFor(interest),
    caution: cautionFor(interest),
    note: noteFor({ rank, score, aboveScore, nextScore }),
    // The two facts that make a card usable rather than interesting. A search with no centre has no distance, and this
    // is `null` there - never a guess, and never "0 mi".
    distanceText: result?.distanceFromCenterM == null ? null : `${formatContextDistance(result.distanceFromCenterM)} from the search center`,
    lengthText: result?.lengthM == null ? null : `${formatContextDistance(result.lengthM)} of road`,
    // Carried so a test (and the card's own DOM) can check a sentence against the measurement behind it.
    score, interestScore: interest.score, evidenceFraction: interest.evidenceFraction,
    components: Object.freeze({ wetland: componentValue(interest, 'wetland'), water: componentValue(interest, 'water'),
      ecologicalVariety: componentValue(interest, 'ecologicalVariety') }),
    missing: interest.missing,
  });
}

// THE TOP OF THE ORDER, AS CARDS. The order itself is `rankExploration` and nothing here touches it: this selects a
// prefix and asks for one summary each, with the score of the road above and below so the near-tie sentence can be honest.
export function recommendations(results, { radiusM = null, transform = DEFAULT_DISTANCE_TRANSFORM,
  limit = RECOMMENDATION_LIMIT } = {}) {
  const ranked = rankExploration(results, { radiusM, transform }).slice(0, Math.max(0, limit));
  return Object.freeze(ranked.map((entry, index) => {
    const summary = recommendationSummary(entry.result, { rank: index + 1, order: entry.order,
      aboveScore: index > 0 ? ranked[index - 1].order.score : null,
      nextScore: index + 1 < ranked.length ? ranked[index + 1].order.score : null });
    return Object.freeze({ result: entry.result, order: entry.order, summary });
  }));
}

