// COMPACT SOURCE-DRIFT BASELINE (GENERATED — do not edit by hand).
//
// Normalized extracted facts from the reviewed operator capture. The Worker compares its own fresh read of a
// source against this; the browser compares a live Worker result against the recorded capture it replays.
// Regenerate together with the capture: npm run verify:investigator:live -- --write-record.
// It carries no page text, no HTML, no credential, and no corridor context.
export const DRIFT_BASELINE = Object.freeze({
 "schemaVersion": "roadnaturalist-investigator-drift-baseline/1",
 "kind": "investigator-drift-baseline",
 "capturedAt": "2026-09-26T00:02:01.389Z",
 "note": "Normalized extracted facts from the reviewed operator capture. The Worker compares its own fresh fetch against this; it never compares raw pages, and it never changes a finding because a page changed.",
 "probes": [
  {
   "probeId": "odot-cornelius-transfer",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "EVIDENCE",
   "sourceUrl": "https://content.govdelivery.com/accounts/ORDOT/bulletins/2c218b2",
   "factCount": 2,
   "digest": "fnv1a-0a2c7e28",
   "facts": [
    {
     "claimType": "PUBLIC_ROAD",
     "quote": "NW Cornelius Pass Road between U.S. 30 and U.S. 26 is a state highway as of Monday, March 1 after a jurisdictional transfer from Multnomah County and Washington County.",
     "claimValue": "state highway OR 127",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": null,
     "corridorScope": "CORRIDOR"
    },
    {
     "claimType": "ROAD_MAINTAINED",
     "quote": "As a state highway, the road will be subject to ODOT standards for design and maintenance",
     "claimValue": "ODOT design and maintenance standards",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": null,
     "corridorScope": "CORRIDOR"
    }
   ]
  },
  {
   "probeId": "mc-cornelius-rcip",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "EVIDENCE",
   "sourceUrl": "https://multco.us/info/rcip-project-rankings",
   "factCount": 2,
   "digest": "fnv1a-5947f2b1",
   "facts": [
    {
     "claimType": "ROAD_MAINTAINED",
     "quote": "NW Cornelius Pass Road: Highway 30 - Skyline Boulevard",
     "claimValue": "ranked county road project",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": "Highway 30 – Skyline Boulevard (Multnomah County section)",
     "corridorScope": "CORRIDOR_PART"
    },
    {
     "claimType": "ROAD_MAINTAINED",
     "quote": "NW Cornelius Pass Road: Skyline Boulevard - County Line",
     "claimValue": "ranked county road project",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": "Skyline Boulevard – county line (Multnomah County section)",
     "corridorScope": "CORRIDOR_PART"
    }
   ]
  },
  {
   "probeId": "wc-mstip-cornelius-roadsafety",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "NO_RELEVANT_EVIDENCE",
   "sourceUrl": "https://www.washingtoncountyor.gov/lut/mstip-3f-funding-allocation",
   "factCount": 0,
   "digest": "fnv1a-741638a5",
   "facts": []
  },
  {
   "probeId": "wc-cornelius-bridge-project",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "EVIDENCE",
   "sourceUrl": "https://www.washingtoncountyor.gov/lut/projects/cornelius-pass-road-bridge-rock-creek",
   "factCount": 4,
   "digest": "fnv1a-053eb868",
   "facts": [
    {
     "claimType": "LAND_MANAGER",
     "quote": "Jurisdiction of Cornelius Pass Road has transferred to ODOT, and is now OR 127.",
     "claimValue": "ODOT (OR 127)",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": "the OR 127 section",
     "corridorScope": "CORRIDOR_PART"
    },
    {
     "claimType": "LAND_MANAGER",
     "quote": "Once complete, the bridge will be transferred to ODOT for all future maintenance.",
     "claimValue": "ODOT (future maintenance)",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": "the new Rock Creek bridge",
     "corridorScope": "CORRIDOR_PART"
    },
    {
     "claimType": "ROAD_NAME_VARIANT",
     "quote": "No trucks are allowed on Old Cornelius Pass Road.",
     "claimValue": "Old Cornelius Pass Road",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": "Old Cornelius Pass Road (a separate road used as the detour)",
     "corridorScope": "CORRIDOR_PART"
    },
    {
     "claimType": "TEMPORARY_CLOSURE",
     "quote": "Road closure has been extended to October 7, 2026",
     "claimValue": "full closure for bridge replacement",
     "effectiveFrom": "2026-07-15T00:00:00.000Z",
     "effectiveUntil": "2026-10-07T00:00:00.000Z",
     "recurrence": null,
     "corridorPart": "bridge over Rock Creek, north of Germantown Road",
     "corridorScope": "CORRIDOR_PART"
    }
   ]
  },
  {
   "probeId": "wc-cornelius-closure-news",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "EVIDENCE",
   "sourceUrl": "https://www.washingtoncountyor.gov/lut/news/2026/07/09/safety-and-freight-improvements-cornelius-pass-road-bridge-replacement-rock-creek",
   "factCount": 1,
   "digest": "fnv1a-995df273",
   "facts": [
    {
     "claimType": "TEMPORARY_CLOSURE",
     "quote": "Cornelius Pass Road (OR-127) will be closed between Germantown Road and Kaiser Road from July 15 to October 7, 2026",
     "claimValue": "full closure between Germantown Road and Kaiser Road",
     "effectiveFrom": "2026-07-15T00:00:00.000Z",
     "effectiveUntil": "2026-10-07T00:00:00.000Z",
     "recurrence": null,
     "corridorPart": "between Germantown Road and Kaiser Road",
     "corridorScope": "CORRIDOR_PART"
    }
   ]
  },
  {
   "probeId": "wc-roads-cornelius-advisory",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "EVIDENCE",
   "sourceUrl": "https://www.wc-roads.com/",
   "factCount": 1,
   "digest": "fnv1a-31550af0",
   "facts": [
    {
     "claimType": "TEMPORARY_CLOSURE",
     "quote": "Cornelius Pass Road From/To: At Rock Creek (View Detour Map) Impact: Road closure Reason: Bridge replacement Schedule: From: 07/15/2026 To: 10/07/2026 Use alternate route",
     "claimValue": "road closure at Rock Creek",
     "effectiveFrom": "2026-07-15T00:00:00.000Z",
     "effectiveUntil": "2026-10-07T00:00:00.000Z",
     "recurrence": null,
     "corridorPart": "at Rock Creek",
     "corridorScope": "CORRIDOR_PART"
    }
   ]
  },
  {
   "probeId": "wc-springville-phase4",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "EVIDENCE",
   "sourceUrl": "https://www.washingtoncountyor.gov/lut/projects/springville-road-phase-4",
   "factCount": 2,
   "digest": "fnv1a-e05d00e1",
   "facts": [
    {
     "claimType": "PUBLIC_ROAD",
     "quote": "Springville Road Phase 4 is the middle and final section of the urban street improvements for Springville Road between 185th Avenue and Kaiser Road.",
     "claimValue": "county street improvement project",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": "185th Avenue to Kaiser Road (North Bethany urban section)",
     "corridorScope": "CORRIDOR_PART"
    },
    {
     "claimType": "ROAD_MAINTAINED",
     "quote": "Funding source: North Bethany County Service District for Roads (NBCSDR)",
     "claimValue": "county service district for roads",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": "185th Avenue to Kaiser Road",
     "corridorScope": "CORRIDOR_PART"
    }
   ]
  },
  {
   "probeId": "wc-springville-improvements-news",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "EVIDENCE",
   "sourceUrl": "https://www.washingtoncountyor.gov/lut/news/2026/04/02/celebrate-springville-road-improvements",
   "factCount": 2,
   "digest": "fnv1a-c330d031",
   "facts": [
    {
     "claimType": "PUBLIC_ROAD",
     "quote": "The work improved Springville Road from 185th Avenue intersection to Kaiser Road in four phases:",
     "claimValue": "county street improvement project",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": "185th Avenue to Kaiser Road",
     "corridorScope": "CORRIDOR_PART"
    },
    {
     "claimType": "ROAD_MAINTAINED",
     "quote": "Improvements to Springville Road were supported by the North Bethany County Service District for Roads",
     "claimValue": "county service district for roads",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": "185th Avenue to Kaiser Road",
     "corridorScope": "CORRIDOR_PART"
    }
   ]
  },
  {
   "probeId": "mc-springville-rcip",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "EVIDENCE",
   "sourceUrl": "https://multco.us/info/rcip-project-rankings",
   "factCount": 1,
   "digest": "fnv1a-7720f286",
   "facts": [
    {
     "claimType": "ROAD_MAINTAINED",
     "quote": "NW Springville Road: City of Portland line to Washington County line",
     "claimValue": "ranked county road project",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": "City of Portland line to Washington County line (Multnomah County section)",
     "corridorScope": "CORRIDOR_PART"
    }
   ]
  },
  {
   "probeId": "wc-roads-springville-advisory",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "NO_RELEVANT_EVIDENCE",
   "sourceUrl": "https://www.wc-roads.com/",
   "factCount": 0,
   "digest": "fnv1a-741638a5",
   "facts": []
  },
  {
   "probeId": "wc-flooding-susbauer",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "EVIDENCE",
   "sourceUrl": "https://www.washingtoncountyor.gov/lut/road-maintenance/flooding-winds",
   "factCount": 3,
   "digest": "fnv1a-39888769",
   "facts": [
    {
     "claimType": "GATE_REPORTED",
     "quote": "The gates on Susbauer Road are south of Hornecker Road and north of Long Road.",
     "claimValue": "permanent manual-locking flood gates",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": "south of Hornecker Road and north of Long Road",
     "corridorScope": "CORRIDOR_PART"
    },
    {
     "claimType": "ROAD_MAINTAINED",
     "quote": "We have installed permanent, manual-locking flood gates on both these roads.",
     "claimValue": "county-installed permanent flood gates",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": null,
     "corridorScope": "CORRIDOR"
    },
    {
     "claimType": "SEASONAL_CLOSURE",
     "quote": "Susbauer and Fern Hill roads both flood often during heavy rainfall.",
     "claimValue": "recurring high-water flooding",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": "high-water",
     "corridorPart": null,
     "corridorScope": "CORRIDOR"
    }
   ]
  },
  {
   "probeId": "wc-mstip-susbauer",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "EVIDENCE",
   "sourceUrl": "https://www.washingtoncountyor.gov/lut/mstip-3f-funding-allocation",
   "factCount": 1,
   "digest": "fnv1a-8cae6337",
   "facts": [
    {
     "claimType": "ROAD_MAINTAINED",
     "quote": "Wren Road/Susbauer Road intersection",
     "claimValue": "funded county intersection project",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": "Wren Road/Susbauer Road intersection",
     "corridorScope": "CORRIDOR_PART"
    }
   ]
  },
  {
   "probeId": "mc-roads-susbauer",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "NO_RELEVANT_EVIDENCE",
   "sourceUrl": "https://multco.us/info/our-roads",
   "factCount": 0,
   "digest": "fnv1a-741638a5",
   "facts": []
  },
  {
   "probeId": "wc-susbauer-flood-closure-news",
   "capturedAt": "2026-09-26T00:02:01.389Z",
   "outcome": "EVIDENCE",
   "sourceUrl": "https://www.washingtoncountyor.gov/lut/news/flood-gates-closed-fern-hill-and-susbauer-roads-use-alternate-routes-0",
   "factCount": 2,
   "digest": "fnv1a-ab63d0bd",
   "facts": [
    {
     "claimType": "GATE_REPORTED",
     "quote": "The flood gates at Fern Hill and Susbauer roads are closed due to high water.",
     "claimValue": "flood gates closed",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": null,
     "corridorPart": "flood gates",
     "corridorScope": "CORRIDOR_PART"
    },
    {
     "claimType": "SEASONAL_CLOSURE",
     "quote": "Susbauer is closed between Long and Hornecker roads.",
     "claimValue": "closed for high water",
     "effectiveFrom": null,
     "effectiveUntil": null,
     "recurrence": "high-water",
     "corridorPart": "between Long and Hornecker roads",
     "corridorScope": "CORRIDOR_PART"
    }
   ]
  }
 ]
});

export default DRIFT_BASELINE;
