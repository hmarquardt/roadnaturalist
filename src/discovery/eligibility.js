// Road eligibility for candidate discovery.
//
// The classes and their descriptions come from Appendix E of the TIGER/Line 2025 technical
// documentation ("2025 MAF/TIGER Feature Class Codes (MTFCC) Definitions"), the same pinned source
// this project already reads road geometry from:
//   https://www2.census.gov/geo/pdfs/maps-data/tiger/tgrshp2025/TGRSHP2025_TechDoc_E.pdf
// Descriptions below are shortened quotes; the full text stays in the source document.
//
// This is a discovery filter, not an access finding: an eligible class means "worth proposing as a
// discovery candidate", never "the public may drive this road". Presence in a centerline dataset is
// not evidence of public, legal, or practical access (see src/roads/road.js).

export const DISCOVERY_DISPOSITION = Object.freeze({
  ELIGIBLE: 'ELIGIBLE', // proposed as a discovery road unit
  SEPARATE: 'SEPARATE', // preserved in the extract, deliberately not mixed with normal roads
  EXCLUDED: 'EXCLUDED', // not a discovery target
});

export const ELIGIBILITY_SOURCE = Object.freeze({
  organization: 'U.S. Census Bureau',
  document: 'TIGER/Line 2025 Appendix E: MAF/TIGER Feature Class Codes (MTFCC) Definitions',
  url: 'https://www2.census.gov/geo/pdfs/maps-data/tiger/tgrshp2025/TGRSHP2025_TechDoc_E.pdf',
});

// MTFCC -> disposition and reason. Unlisted codes are EXCLUDED with an unrecognized-class reason, so
// a new TIGER class can never quietly enter discovery.
export const ROAD_CLASS_ELIGIBILITY = Object.freeze({
  S1100: Object.freeze({ disposition: DISCOVERY_DISPOSITION.EXCLUDED, label: 'Primary road',
    definition: 'Limited-access highway that connects to other roads only at interchanges; includes Interstate highways.',
    reason: 'Primary roads are limited-access highways, not cruise roads.' }),
  S1200: Object.freeze({ disposition: DISCOVERY_DISPOSITION.ELIGIBLE, label: 'Secondary road',
    definition: 'Main artery that is not limited access; usually in the U.S., state, or county highway systems.',
    reason: 'Secondary roads are ordinary not-limited-access arteries.' }),
  S1400: Object.freeze({ disposition: DISCOVERY_DISPOSITION.ELIGIBLE, label: 'Local road',
    definition: 'Generally a paved non-arterial street, road, or byway with a single lane in each direction; may be privately or publicly maintained.',
    reason: 'Local neighborhood, rural, and city street roads are the main discovery class.' }),
  S1500: Object.freeze({ disposition: DISCOVERY_DISPOSITION.SEPARATE, label: 'Vehicular trail',
    definition: 'Unpaved dirt trail where a four-wheel drive vehicle is required; found almost exclusively in very rural areas.',
    reason: 'Vehicular trails are preserved in the extract but kept separate from named-road candidates.' }),
  S1630: Object.freeze({ disposition: DISCOVERY_DISPOSITION.EXCLUDED, label: 'Ramp',
    definition: 'Road that allows controlled access from adjacent roads onto a limited-access highway.',
    reason: 'Ramps are interchange connectors, not roads to survey.' }),
  S1640: Object.freeze({ disposition: DISCOVERY_DISPOSITION.EXCLUDED, label: 'Service drive',
    definition: 'Frontage or access road along a thoroughfare or limited-access highway that serves structures or facilities beside it.',
    reason: 'Service drives parallel a highway; they are not independent corridors.' }),
  S1710: Object.freeze({ disposition: DISCOVERY_DISPOSITION.EXCLUDED, label: 'Walkway',
    definition: 'Path used for walking, too narrow for or legally restricted from vehicular traffic.',
    reason: 'Walkways are not vehicular roads.' }),
  S1720: Object.freeze({ disposition: DISCOVERY_DISPOSITION.EXCLUDED, label: 'Stairway',
    definition: 'Pedestrian passageway from one level to another by a series of steps.',
    reason: 'Stairways are not vehicular roads.' }),
  S1730: Object.freeze({ disposition: DISCOVERY_DISPOSITION.EXCLUDED, label: 'Alley',
    definition: 'Service road at the rear of buildings, usually unnamed, used for deliveries.',
    reason: 'Alleys are service roads without addressed frontage.' }),
  S1740: Object.freeze({ disposition: DISCOVERY_DISPOSITION.EXCLUDED, label: 'Private road',
    definition: 'Road usually on private property maintained for access to industrial, ranch, resource-extraction, or similar land use.',
    reason: 'Private service roads are not proposed as discovery candidates.' }),
  S1750: Object.freeze({ disposition: DISCOVERY_DISPOSITION.EXCLUDED, label: 'Internal census road',
    definition: 'Internal U.S. Census Bureau use.',
    reason: 'Internal census roads are not real-world discovery targets.' }),
  S1780: Object.freeze({ disposition: DISCOVERY_DISPOSITION.EXCLUDED, label: 'Parking lot road',
    definition: 'Main travel route for vehicles through a paved parking area.',
    reason: 'Parking-lot roads are not corridors between places.' }),
  S1810: Object.freeze({ disposition: DISCOVERY_DISPOSITION.EXCLUDED, label: 'Winter trail',
    definition: 'Seasonal trail created and marked in snow, traveled by snowmobiles and dog sleds.',
    reason: 'Winter trails are seasonal and not mapped as roads.' }),
  S1820: Object.freeze({ disposition: DISCOVERY_DISPOSITION.EXCLUDED, label: 'Bike path or trail',
    definition: 'Path used for manual or small motorized bicycles, too narrow for or legally restricted from vehicular traffic.',
    reason: 'Bike paths are not vehicular roads.' }),
  S1830: Object.freeze({ disposition: DISCOVERY_DISPOSITION.EXCLUDED, label: 'Bridle path',
    definition: 'Path used for horses, too narrow for or legally restricted from vehicular traffic.',
    reason: 'Bridle paths are not vehicular roads.' }),
});


export const ELIGIBLE_WITHOUT_A_NAME = 'no source road name: a discovery road unit is built from a named road, '
  + 'so this feature is kept in the extract but not proposed';

export function roadClassRule(code) {
  return ROAD_CLASS_ELIGIBILITY[code] ?? null;
}

// One source feature -> an explicit, reviewable eligibility decision.
export function classifyFeature(feature) {
  const code = feature?.roadClass ? String(feature.roadClass) : '';
  const name = String(feature?.name ?? '').trim();
  const rule = roadClassRule(code);
  if (!rule) {
    return Object.freeze({ eligibleForDiscovery: false, disposition: DISCOVERY_DISPOSITION.EXCLUDED,
      eligibilityReason: code ? `unrecognized TIGER road class ${code}: not proposed`
        : 'the source feature carries no road class: not proposed',
      roadClass: code || null, classLabel: null });
  }
  if (rule.disposition !== DISCOVERY_DISPOSITION.ELIGIBLE) {
    return Object.freeze({ eligibleForDiscovery: false, disposition: rule.disposition, eligibilityReason: rule.reason,
      roadClass: code, classLabel: rule.label });
  }
  if (!name) {
    return Object.freeze({ eligibleForDiscovery: false, disposition: DISCOVERY_DISPOSITION.EXCLUDED,
      eligibilityReason: ELIGIBLE_WITHOUT_A_NAME, roadClass: code, classLabel: rule.label });
  }
  return Object.freeze({ eligibleForDiscovery: true, disposition: rule.disposition,
    eligibilityReason: `eligible ${rule.label.toLowerCase()} (${code}) with a source road name`, roadClass: code, classLabel: rule.label });
}

export function eligibilitySummary(features) {
  const counts = new Map();
  for (const feature of features ?? []) {
    const decision = classifyFeature(feature);
    const key = decision.eligibleForDiscovery ? 'ELIGIBLE' : `${decision.disposition}: ${decision.roadClass ?? 'unclassified'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.freeze([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => Object.freeze({ key, count })));
}

export function eligibleClasses() {
  return Object.freeze(Object.entries(ROAD_CLASS_ELIGIBILITY)
    .filter(([, rule]) => rule.disposition === DISCOVERY_DISPOSITION.ELIGIBLE).map(([code]) => code).sort());
}
