#!/usr/bin/env python3
"""Build the bounded Oregon road-network extract that candidate discovery surveys.

Source: the same pinned U.S. Census Bureau TIGER/Line 2025 county ROADS archives as the road pilot
(scripts/build-roads.py). See docs/DISCOVERY.md for the discovery window, the TIGER feature-class
eligibility rules, and why discovery starts from a bounded network extract instead of hand-picked
road names.

    uv run --with pyshp --with pyproj --with pyarrow --with duckdb --with shapely \
      python3 scripts/build-road-network.py --download

The extract keeps every ROADS feature of a discovery-relevant TIGER feature class whose vertices lie
inside the habitat analysis window, so road coverage and habitat coverage describe the same area.
Features of every other class, and features that leave the window, are counted and recorded in the
manifest rather than silently dropped. No access, surface, traffic, or maintenance claim is inferred.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

from shapely import wkb as shapely_wkb
from shapely.geometry import LineString

from tiger_sources import (COUNTIES, GEOMETRY_CRS, MEASURE_CRS, NETWORK_BBOX, SOURCE_AGENCY, SOURCE_BASE, SOURCE_CRS,
                           SOURCE_DATASET, SOURCE_DOCS, SOURCE_LICENSE, SOURCE_PUBLICATION_DATE, SOURCE_VINTAGE,
                           bounds_of, feature_parts, haversine_endpoint_gap_m, haversine_is_reversed_link,
                           haversine_length_m, open_roads, probe_units, slug, source_archive, unique_lines, within,
                           write_geoparquet)

ROOT = Path(__file__).resolve().parents[1]
DATASET_ID = "or-roads-network-pilot"
DATASET_VERSION = "tiger-2025-net1"
PIPELINE_VERSION = "road-network-extract-v1"
DATASET_SCOPE = "Bounded Oregon road-network extract for candidate discovery (pilot analysis window)"
# TIGER/Line 2025 MTFCC classes the extract keeps, with the published definitions (Appendix E):
#   S1200 Secondary Road              main arteries that are not limited access (US/state/county highways)
#   S1400 Local Neighborhood Road     paved non-arterial street, road, or byway; may be privately maintained
#   S1500 Vehicular Trail (4WD)       unpaved dirt trail where a four-wheel drive vehicle is required
# S1500 is kept so discovery can preserve vehicular trails separately instead of mixing them with
# normal roads; it is not mixed into the named-road candidates (see src/discovery/eligibility.js).
EXTRACT_CLASSES = {
    "S1200": "Secondary road: main artery that is not limited access",
    "S1400": "Local neighborhood road, rural road, or city street",
    "S1500": "Vehicular trail (4WD): unpaved trail requiring a four-wheel drive vehicle",
}
NORMALIZATION = (
    "Select TIGER/Line county ROADS features whose MTFCC is a discovery-relevant class and whose vertices all "
    "lie inside the bounded discovery window; split multi-part shapes into one row per part; drop consecutive "
    "duplicate vertices; keep the published EPSG:4269 coordinates in an EPSG:4326 column; emit one WKB "
    "LineString row per source feature part. Named features keep the county-scoped road id of the road pilot; "
    "unnamed features keep a per-feature road id. Feature and unit lengths use the same spherical formula as the "
    "browser (haversine, mean Earth radius 12,742,000 m), so the offline extraction summary and the browser agree."
)
# Discovery corridor thresholds, mirrored by src/discovery/constants.js (a test asserts agreement).
# They are analysis/UX units, not ecological truths: see docs/DISCOVERY.md.
MIN_CORRIDOR_M = 1609.344
TARGET_CORRIDOR_M = 6437.376
MAX_CORRIDOR_M = 12874.752
PROVENANCE = {
    "source_agency": SOURCE_AGENCY, "source_dataset": SOURCE_DATASET, "source_vintage": SOURCE_VINTAGE,
    "source_publication_date": SOURCE_PUBLICATION_DATE, "source_crs": SOURCE_CRS, "crs": GEOMETRY_CRS,
    "pipeline_version": PIPELINE_VERSION, "normalization": NORMALIZATION,
}


def road_id(county_fips, name, source_feature_id):
    """County-scoped road id: identical to the road pilot's scheme for named features."""
    if name:
        return f"tiger-2025-or-{county_fips}-{slug(name)}"
    return f"tiger-2025-or-{county_fips}-unnamed-{source_feature_id.lower()}"


def read_county(county_fips, archive, tally):
    """Return one row per source feature part of the extractable classes inside the window."""
    county_name = COUNTIES[county_fips][0]
    rows = []
    with open_roads(county_fips, archive) as (reader, fields, _source_crs):
        for record, part_index, coords in feature_parts(reader, fields):
            road_class = str(record.get("MTFCC") or "")
            name = str(record.get("FULLNAME") or "").strip()
            if road_class not in EXTRACT_CLASSES:
                key = road_class or "unclassified"
                tally["excludedClasses"][key] = tally["excludedClasses"].get(key, 0) + 1
                continue
            if not within(NETWORK_BBOX, coords):
                # A feature that only clips the window corner is not part of a complete road unit.
                tally["outsideWindow"] += 1
                continue
            if len(coords) < 2:
                tally["degenerate"] += 1
                continue
            line = LineString(coords)
            if line.is_empty or not line.is_valid or line.length <= 0:
                raise ValueError(f"Invalid geometry for source feature {record['LINEARID']}")
            length_m = haversine_length_m(coords)
            min_lon, min_lat, max_lon, max_lat = bounds_of(coords)
            rows.append({
                "road_id": road_id(county_fips, name, str(record["LINEARID"])), "name": name,
                "road_class": road_class, "route_type": str(record.get("RTTYP") or ""), "county_fips": county_fips,
                "county_name": county_name, "source_feature_id": str(record["LINEARID"]), "part": part_index,
                "point_count": len(coords), "length_m": round(length_m, 3), "min_lon": min_lon, "min_lat": min_lat,
                "max_lon": max_lon, "max_lat": max_lat, "source_url": SOURCE_BASE + COUNTIES[county_fips][1],
                "source_archive_sha256": COUNTIES[county_fips][2], **PROVENANCE, "geometry": line.wkb,
            })
    return rows


def segments_for(length_m):
    """Deterministic discovery segmentation count, mirroring src/discovery/segment.js.

    A named road at or under the maximum stays one corridor; a longer one is divided into about
    ``TARGET_CORRIDOR_M`` pieces, never fewer than two. Half-up rounding matches JavaScript's
    Math.round for positive values (Python's round() is banker's rounding).
    """
    if length_m <= MAX_CORRIDOR_M:
        return 1
    return max(2, math.floor(length_m / TARGET_CORRIDOR_M + 0.5))


def summarize(rows, tally):
    """Counts and composition cross-checks for the manifest and the committed summary fixture."""
    named = [row for row in rows if row["name"]]
    class_counts, county_counts = {}, {}
    lines = []
    for row in rows:
        class_counts[row["road_class"]] = class_counts.get(row["road_class"], 0) + 1
        county_counts[row["county_fips"]] = county_counts.get(row["county_fips"], 0) + 1
        if row["name"]:
            lines.append((slug(row["name"]), [tuple(point) for point in shapely_wkb.loads(row["geometry"]).coords]))
    # The duplicate rules are the browser's (src/roads/normalize.js), metric included, so the offline
    # extraction summary and the browser count the same road units and the same discovery corridors.
    def browser_dedupe(lines):
        return unique_lines(lines, length_fn=haversine_length_m, reversed_link_fn=haversine_is_reversed_link)

    units = probe_units(lines, length_fn=haversine_length_m, gap_fn=haversine_endpoint_gap_m, dedupe_fn=browser_dedupe)
    # One representative unit per name key (a name with several disconnected components has several).
    primary = {name_key: max(entry["unitLengthsM"]) for name_key, entry in units.items() if entry["unitLengthsM"]}
    longest = sorted(primary.items(), key=lambda item: (-item[1], item[0]))
    return {
        "featureCount": len(rows), "roadCount": len({row["road_id"] for row in rows}),
        "pointCount": sum(row["point_count"] for row in rows), "namedFeatureCount": len(named),
        "unnamedFeatureCount": len(rows) - len(named), "totalLengthM": round(sum(row["length_m"] for row in rows), 3),
        "classCounts": dict(sorted(class_counts.items())), "countyFeatureCounts": dict(sorted(county_counts.items())),
        "excludedClassCounts": dict(sorted(tally["excludedClasses"].items())), "outsideWindow": tally["outsideWindow"],
        "units": units, "longestUnits": longest,
    }

def write_summary_fixture(path, stats, digest, pilot_names):
    """Committed expectations the browser discovery run must reproduce (asserted by tests)."""
    units = stats["units"]
    eligible_units = [length for entry in units.values() for length in entry["unitLengthsM"] if length >= MIN_CORRIDOR_M]
    dropped_units = [length for entry in units.values() for length in entry["unitLengthsM"] if length < MIN_CORRIDOR_M]
    corridors = sum(segments_for(length) for length in eligible_units)
    pilot_roads = []
    for name in pilot_names:
        entry = units.get(slug(name))
        lengths = entry["unitLengthsM"] if entry else []
        primary = max(lengths) if lengths else 0.0
        segments = segments_for(primary) if primary >= MIN_CORRIDOR_M else 0
        pilot_roads.append({"name": name, "nameKey": slug(name), "featureCount": entry["featureCount"] if entry else 0,
                            "collapsedDuplicates": entry["collapsedDuplicates"] if entry else 0,
                            "unitCount": len(lengths), "primaryUnitLengthM": round(primary, 3), "segments": segments,
                            "segmentTargetM": round(primary / segments, 3) if segments else None})
    fixture = {
        "kind": "road-network-extract-summary", "datasetId": DATASET_ID, "datasetVersion": DATASET_VERSION,
        "note": "Generated by scripts/build-road-network.py from the pinned TIGER/Line archives. Feature and unit "
                "lengths use the same spherical formula as the browser (haversine, mean Earth radius 12,742,000 m), "
                "so the offline extraction summary and the browser count the same corridors.",
        "sha256": digest, "bbox": list(NETWORK_BBOX), "classes": EXTRACT_CLASSES,
        "featureCount": stats["featureCount"], "roadCount": stats["roadCount"], "pointCount": stats["pointCount"],
        "namedFeatureCount": stats["namedFeatureCount"], "unnamedFeatureCount": stats["unnamedFeatureCount"],
        "totalLengthM": stats["totalLengthM"], "classCounts": stats["classCounts"],
        "countyFeatureCounts": stats["countyFeatureCounts"], "excludedClassCounts": stats["excludedClassCounts"],
        "outsideWindowFeatureCount": stats["outsideWindow"], "namedUnitCount": len(units),
        "discovery": {
            "minCorridorM": MIN_CORRIDOR_M, "targetCorridorM": TARGET_CORRIDOR_M, "maxCorridorM": MAX_CORRIDOR_M,
            "proposedCorridorCount": corridors, "unitsAtLeastMinCorridor": len(eligible_units),
            "unitsDroppedAsShort": len(dropped_units),
            "unitsSegmented": sum(1 for length in eligible_units if segments_for(length) > 1),
        },
        "pilotRoads": pilot_roads,
        "longestUnits": [{"nameKey": name_key, "lengthM": round(length, 3), "segments": segments_for(length)}
                         for name_key, length in stats["longestUnits"][:6]],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture, indent=2) + "\n")
    return fixture


def manifest_entry(path, digest, stats):
    return {
        "id": DATASET_ID, "type": "road-centerlines-network", "version": DATASET_VERSION, "format": "GeoParquet",
        "url": f"gis/{path.name}", "bytes": path.stat().st_size, "sha256": digest,
        "featureCount": stats["featureCount"], "roadCount": stats["roadCount"], "pointCount": stats["pointCount"],
        "crs": GEOMETRY_CRS,
        "scope": {
            "kind": DATASET_SCOPE, "bbox": list(NETWORK_BBOX), "classes": stats["classCounts"],
            "excludedClasses": stats["excludedClassCounts"], "outsideWindowFeatureCount": stats["outsideWindow"],
            "namedFeatureCount": stats["namedFeatureCount"], "unnamedFeatureCount": stats["unnamedFeatureCount"],
            "totalLengthM": stats["totalLengthM"],
            "counties": [{"fips": fips, "name": COUNTIES[fips][0], "featureCount": count}
                         for fips, count in sorted(stats["countyFeatureCounts"].items())],
        },
        "source": {"agency": SOURCE_AGENCY, "dataset": SOURCE_DATASET, "vintage": SOURCE_VINTAGE,
                   "url": SOURCE_BASE + COUNTIES["41067"][1],
                   "urls": {fips: SOURCE_BASE + COUNTIES[fips][1] for fips in sorted(COUNTIES)},
                   "sha256": {fips: COUNTIES[fips][2] for fips in sorted(COUNTIES)},
                   "publicationDate": SOURCE_PUBLICATION_DATE, "documentationUrl": SOURCE_DOCS, "license": SOURCE_LICENSE},
        "normalization": {"pipelineVersion": PIPELINE_VERSION, "method": NORMALIZATION,
                          "sourceCrs": SOURCE_CRS, "crs": GEOMETRY_CRS, "measureCrs": MEASURE_CRS,
                          "windowBbox": list(NETWORK_BBOX), "extractClasses": sorted(EXTRACT_CLASSES)},
        "schemaVersion": 1,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="pre-downloaded TIGER/Line county ROADS ZIP matching a pinned digest")
    parser.add_argument("--cache", type=Path, default=Path("/tmp/roadnaturalist-road-sources"))
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()

    tally = {"excludedClasses": {}, "outsideWindow": 0, "degenerate": 0}
    rows = []
    for county_fips in sorted(COUNTIES):
        supplied = args.archive if args.archive and COUNTIES[county_fips][1] == args.archive.name else None
        archive = source_archive(county_fips, supplied, args.cache, args.download)
        rows.extend(read_county(county_fips, archive, tally))
    if not rows:
        raise ValueError("No network features extracted")
    rows.sort(key=lambda row: (row["road_id"], row["source_feature_id"], row["part"]))

    path = ROOT / "data" / "gis" / "or-roads-network-2025.parquet"
    stats = write_geoparquet(rows, path)
    stats.update(summarize(rows, tally))
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    fixture = write_summary_fixture(ROOT / "tests" / "fixtures" / "or-roads-network.summary.json", stats, digest,
                                    ["NW Cornelius Pass Rd", "NW Springville Rd", "NW Susbauer Rd"])
    print(f"{DATASET_ID}: {stats['featureCount']} features ({stats['namedFeatureCount']} named, "
          f"{stats['unnamedFeatureCount']} unnamed), {stats['roadCount']} county-scoped road ids, "
          f"{stats['pointCount']} vertices, {stats['totalLengthM'] / 1000:,.1f} km, {path.stat().st_size:,} bytes, "
          f"SHA-256 {digest}")
    print(f"excluded classes: {stats['excludedClassCounts']}, outside window: {stats['outsideWindow']}")
    print(f"named road units: {fixture['namedUnitCount']}, proposed discovery corridors: "
          f"{fixture['discovery']['proposedCorridorCount']} "
          f"({fixture['discovery']['unitsDroppedAsShort']} units shorter than {MIN_CORRIDOR_M / 1609.344:.1f} mi dropped), "
          f"segmented: {fixture['discovery']['unitsSegmented']}")
    for road in fixture["pilotRoads"]:
        print(f"  pilot {road['name']}: {road['featureCount']} features, {road['collapsedDuplicates']} duplicates collapsed, "
              f"unit {road['primaryUnitLengthM'] / 1609.344:.2f} mi, {road['segments']} discovery corridor(s)")

    manifest_path = ROOT / "data" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    others = [dataset for dataset in manifest["datasets"] if dataset["id"] != DATASET_ID]
    manifest["datasets"] = sorted(others + [manifest_entry(path, digest, stats)], key=lambda entry: entry["id"])
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"manifest: {len(manifest['datasets'])} datasets declared")


if __name__ == "__main__":
    main()

