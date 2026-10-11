// AN EXPLORATION ORDER BUILT FROM MEASURED PHYSICAL CONTEXT.
//
// This orders roads by how much *mapped physical context* surrounds them: wetland area at the analysis distances,
// proximity to water, mapped crossings, and ecological variety. It is an exploration heuristic, not a claim about
// wildlife, scenery, access or driving conditions - Road Naturalist does not know any of those, and nothing here
// guesses. Every number below comes from a measurement the discovery analysis already made, so ranking costs no raw
// read of any plane and works everywhere discovery works.
//
// Three deliberate properties:
//
//   * DIMINISHING RETURNS. Raw quantities are not added together. 100 ha of wetland is not ten times better than
//     10 ha, and twenty crossings are not twenty times better than one. Every quantity passes through a bounded
//     transform before it is weighted, so one extreme measurement cannot dominate an order.
//   * UNKNOWN IS NOT ZERO. A component whose inputs are not covered is omitted from the weighted mean and named in
//     `missing`, and the result carries `evidenceFraction`. A corridor with partial evidence is never punished for
//     habitat that was simply not measured.
//   * NO ROAD-LENGTH TERM. Long corridors intersect more habitat simply by being long, so length would smuggle a
//     size bias into an order that claims to describe context. Length is reported as context, never scored.
export const RANKING_VERSION = 'naturalist-interest-v1';

// The weights, in one place, so the order is reproducible and a future change is a versioned decision rather than
// tuning drift. Wetland and water context are the two measured physical signals with the widest coverage; ecological
// variety is real but the sparsest and the easiest to game, so it carries the least weight.
export const RANKING_WEIGHTS = Object.freeze({ wetland: 0.45, water: 0.35, ecologicalVariety: 0.2 });

// Bounded transforms, each documented where it is defined. `saturate` is the diminishing-returns curve: value 0 is 0,
// the half-point is where the value equals `half`, and no quantity ever reaches 1 however large it grows.
export function saturate(value, half) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(half) || half <= 0) throw new TypeError('saturate needs a positive half-point');
  return value / (value + half);
}

// Distance decay: 1 at the road, 0.5 at `scale` metres away, asymptotically 0 far away. Rational rather than
// exponential so the shape is easy to reason about at the distances the analysis actually measures.
export function proximity(distanceM, scale) {
  if (!Number.isFinite(distanceM) || distanceM < 0) return 0;
  if (!Number.isFinite(scale) || scale <= 0) throw new TypeError('proximity needs a positive scale');
  return 1 / (1 + distanceM / scale);
}

const HALF = Object.freeze({
  // Wetland area: half credit at 10 ha within 250 m, 30 ha within 500 m, 100 ha within 1 km.
  wetland250: 100_000, wetland500: 300_000, wetland1000: 1_000_000,
  // Crossings: half credit at three. One crossing is already real evidence; a drainage-dense road stops gaining.
  crossings: 3,
  // Hydrography around the corridor: half credit at 5 km of flowline within the 1 km buffer.
  flowline: 5_000,
  // Ecoregions: half credit at one extra region and at two transitions. Capped, because a road that merely follows
  // an ecoregion boundary crosses it repeatedly - a property of the boundary, not of the road.
  extraEcoregions: 1, transitions: 2,
});
const DISTANCE_SCALE = Object.freeze({ flowingM: 200, standingM: 400, nearestWetlandM: 250 });


// The wetland component: nearer buffers carry more of it, because what is within 250 m is context the road is
// inside while the 1 km buffer is neighbourhood. Proximity is a fifth, because "no mapped wetland at all" is itself
// information and must not read as a strong negative.
function wetlandComponent(signals) {
  const wetlands = signals?.wetlands ?? {};
  if (!covered(wetlands.coverage)) return null;
  const value = 0.4 * saturate(wetlands.area250M2, HALF.wetland250)
    + 0.25 * saturate(wetlands.area500M2, HALF.wetland500)
    + 0.15 * saturate(wetlands.area1000M2, HALF.wetland1000)
    + 0.2 * proximity(wetlands.nearestM, DISTANCE_SCALE.nearestWetlandM);
  return { value, detail: { nearestM: wetlands.nearestM ?? null, area250M2: wetlands.area250M2 ?? 0,
    area500M2: wetlands.area500M2 ?? 0, area1000M2: wetlands.area1000M2 ?? 0,
    intersectsCorridor: Boolean(wetlands.intersectsCorridor) } };
}

// The water component: crossings are capped evidence; proximity to flowing and standing water decays with distance;
// the flowline length in the 1 km buffer is the faintest term, because it describes the neighbourhood rather than
// the road.
function waterComponent(signals) {
  const hydro = signals?.hydrography ?? {};
  if (!covered(hydro.coverage)) return null;
  const value = 0.4 * saturate(hydro.crossingCount, HALF.crossings)
    + 0.3 * proximity(hydro.nearestFlowingM, DISTANCE_SCALE.flowingM)
    + 0.15 * proximity(hydro.nearestStandingM, DISTANCE_SCALE.standingM)
    + 0.15 * saturate(hydro.flowlineLength1000M, HALF.flowline);
  return { value, detail: { crossingCount: hydro.crossingCount ?? 0, nearestFlowingM: hydro.nearestFlowingM ?? null,
    nearestStandingM: hydro.nearestStandingM ?? null, flowlineLength1000M: hydro.flowlineLength1000M ?? 0 } };
}

// Ecological variety: how many ecoregions the corridor lies in, and how often it crosses between them, both capped.
function varietyComponent(ecology) {
  if (!covered(ecology?.coverage)) return null;
  const value = 0.6 * saturate(Math.max(0, (ecology.ecoregionCount ?? 1) - 1), HALF.extraEcoregions)
    + 0.4 * saturate(ecology.transitions, HALF.transitions);
  return { value, detail: { ecoregionCount: ecology.ecoregionCount ?? null, transitions: ecology.transitions ?? null,
    level3: ecology.level3?.primary?.name ?? null, level4: ecology.level4?.primary?.name ?? null } };
}


// The sentences the interface shows. They are assembled from the component values themselves, so an explanation can
// never drift from the measurement that produced it - and they are written here, not generated.
function describeWetlands(component) {
  if (!component) return null;
  const { nearestM, area250M2, area500M2, area1000M2, intersectsCorridor } = component.detail;
  if (intersectsCorridor) return `mapped wetland under the corridor, ${hectares(area250M2)} ha within 250 m`;
  if (area250M2 > 0) return `${hectares(area250M2)} ha of mapped wetland within 250 m`;
  if (area500M2 > 0) return `${hectares(area500M2)} ha of mapped wetland within 500 m`;
  if (area1000M2 > 0) return `${hectares(area1000M2)} ha of mapped wetland within 1 km`;
  if (nearestM != null) return `nearest mapped wetland ${Math.round(nearestM)} m away`;
  return 'no mapped wetland within the analysed distances';
}

function describeWater(component) {
  if (!component) return null;
  const { crossingCount, nearestFlowingM, nearestStandingM } = component.detail;
  const parts = [];
  if (crossingCount > 0) parts.push(`${crossingCount} mapped water crossing${crossingCount === 1 ? '' : 's'}`);
  if (nearestFlowingM != null) parts.push(`flowing water ${Math.round(nearestFlowingM)} m away`);
  if (nearestStandingM != null) parts.push(`standing water ${Math.round(nearestStandingM)} m away`);
  if (!parts.length) parts.push('no mapped crossing, flowing or standing water nearby');
  return parts.join(', ');
}

function describeVariety(component) {
  if (!component) return null;
  const { ecoregionCount, transitions, level4 } = component.detail;
  if (ecoregionCount == null) return null;
  const region = level4 ? ` (${level4})` : '';
  if (transitions > 0) {
    return `crosses ${ecoregionCount} ecoregions with ${transitions} transition${transitions === 1 ? '' : 's'}${region}`;
  }
  return `lies in ${ecoregionCount} mapped ecoregion${ecoregionCount === 1 ? '' : 's'}${region}`;
}

// The ranking of one discovery result: its score, its components, what could not be measured, and the sentences the
// interface shows. Everything is derived from the result's own measured signals.
export function naturalistInterest(result) {
  const components = { wetland: wetlandComponent(result?.signals), water: waterComponent(result?.signals),
    ecologicalVariety: varietyComponent(result?.ecology) };
  const missing = Object.entries(components).filter(([, component]) => !component).map(([name]) => name);
  const present = Object.entries(RANKING_WEIGHTS).filter(([name]) => components[name]);
  const presentWeight = present.reduce((total, [, weight]) => total + weight, 0);
  // A weighted mean over the components that were actually measured, so a component with no coverage neither helps
  // nor hurts: it is absent, and `evidenceFraction` says how much of the order was measured.
  const score = presentWeight > 0
    ? 100 * present.reduce((total, [name, weight]) => total + weight * components[name].value, 0) / presentWeight
    : null;
  return Object.freeze({
    version: RANKING_VERSION,
    score: score == null ? null : round1(score),
    evidenceFraction: Math.round(presentWeight * 100) / 100,
    components: Object.freeze(Object.fromEntries(Object.entries(components).map(([name, component]) => [name,
      component
        ? Object.freeze({ value: round1(component.value * 100), weight: RANKING_WEIGHTS[name], measured: true,
          detail: Object.freeze({ ...component.detail }) })
        : Object.freeze({ value: null, weight: RANKING_WEIGHTS[name], measured: false, detail: null })]))),
    missing: Object.freeze([...missing]),
    explanation: Object.freeze([describeWetlands(components.wetland), describeWater(components.water),
      describeVariety(components.ecologicalVariety)].filter(Boolean)),
  });
}

// The order: score first, then name and id, so an order is never ambiguous and never depends on input order.
export function rankResults(results) {
  return [...(results ?? [])].map(result => ({ result, ranking: naturalistInterest(result) }))
    .sort((left, right) => {
      const a = left.ranking.score;
      const b = right.ranking.score;
      if ((a == null) !== (b == null)) return a == null ? 1 : -1;
      if (a != null && b !== a) return b - a;
      return String(left.result.name ?? '').localeCompare(String(right.result.name ?? ''))
        || String(left.result.id).localeCompare(String(right.result.id));
    });
}

// The qualitative labels the list and the map popup use for a component. Defined once, tested, and derived from the
// component's own 0-100 value, so a label can never disagree with the number it describes. An unmeasured component
// says so rather than being labelled "little": absence of measurement is not absence of habitat.
export const CONTEXT_LABELS = Object.freeze([
  Object.freeze({ min: 60, label: 'strong' }),
  Object.freeze({ min: 35, label: 'moderate' }),
  Object.freeze({ min: 15, label: 'some' }),
  Object.freeze({ min: 0, label: 'little mapped' }),
]);

export function contextLabel(value) {
  if (!Number.isFinite(value)) return 'not measured';
  return (CONTEXT_LABELS.find(entry => value >= entry.min) ?? CONTEXT_LABELS[CONTEXT_LABELS.length - 1]).label;
}

const round1 = value => Math.round(value * 10) / 10;
// The evidence fraction is a weight, so it keeps two decimals: rounding it to tenths would report 0.55 as 0.6.
const hectares = areaM2 => Math.round(Number(areaM2 ?? 0) / 10_000);
const covered = state => state === 'FULL' || state === 'PARTIAL';
