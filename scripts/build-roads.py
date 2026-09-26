#!/usr/bin/env python3
"""Build the Oregon road-centerline pilot GeoParquet from pinned TIGER/Line ROADS.

Source: U.S. Census Bureau TIGER/Line 2025 county ROADS (road centerlines).
See docs/ROADS.md for the source decision, regeneration command, and limitations.

    uv run --with pyshp --with pyproj --with pyarrow --with duckdb --with shapely \
      python3 scripts/build-roads.py --download
"""
import argparse
import hashlib
import json
from pathlib import Path

import duckdb
from pyproj import CRS
from shapely import wkb as shapely_wkb
from shapely.geometry import LineString

from tiger_sources import (COUNTIES, PILOT_BBOX, SOURCE_AGENCY, SOURCE_BASE, SOURCE_CRS, SOURCE_DATASET, SOURCE_DOCS,
                           SOURCE_LICENSE, SOURCE_PUBLICATION_DATE, SOURCE_VINTAGE, bounds_of, clean, composed_lines,
                           feature_parts, line_length_m, open_roads, slug, source_archive, within, write_geoparquet)

ROOT = Path(__file__).resolve().parents[1]
PIPELINE_VERSION = "road-ingest-v1"
NORMALIZATION = (
    "Filter TIGER/Line county ROADS features by pilot road name and pilot bounding box; split multi-part shapes "
    "into one row per part; drop consecutive duplicate vertices; transform EPSG:4269 to EPSG:4326 with always_xy; "
    "emit one WKB LineString row per source feature part."
)
DATASET_ID = "or-roads-pilot"
DATASET_VERSION = "tiger-2025-v1"
DATASET_SCOPE = "Oregon road centerline pilot (Washington and Multnomah County extract)"
# Source verification: the road/county pairs and source feature counts this pilot was designed against.
# NW Springville Rd and NW Cornelius Pass Rd both cross the Washington/Multnomah county line, so one real road
# becomes two county-scoped road records that a candidate composes (see docs/ROADS.md).
PILOT_ROADS = [
    ("NW Cornelius Pass Rd", "41067", 4),
    ("NW Cornelius Pass Rd", "41051", 1),
    ("NW Springville Rd", "41067", 1),
    ("NW Springville Rd", "41051", 3),
    ("NW Susbauer Rd", "41067", 1),
]
PROVENANCE = {
    "source_agency": SOURCE_AGENCY, "source_dataset": SOURCE_DATASET, "source_vintage": SOURCE_VINTAGE,
    "source_publication_date": SOURCE_PUBLICATION_DATE, "source_crs": SOURCE_CRS, "crs": "EPSG:4326",
    "pipeline_version": PIPELINE_VERSION, "normalization": NORMALIZATION,
}


def road_id(county_fips, name):
    return f"tiger-2025-or-{county_fips}-{slug(name)}"


def read_county(county_fips, archive):
    """Extract the pilot's named roads from one county ROADS archive.

    Names are matched exactly as TIGER/Line publishes them (FULLNAME), and a matched feature that
    leaves the pilot window is an error rather than a silent clip: the pilot must hold whole roads.
    """
    county_name = COUNTIES[county_fips][0]
    names = {name for name, fips, _ in PILOT_ROADS if fips == county_fips}
    rows = []
    with open_roads(county_fips, archive) as (reader, fields, _source_crs):
        for record, part_index, coords in feature_parts(reader, fields):
            name = str(record.get("FULLNAME") or "").strip()
            if name not in names:
                continue
            if not within(PILOT_BBOX, coords):
                raise ValueError(f"{name} source feature {record['LINEARID']} leaves the pilot bounding box")
            if len(coords) < 2:
                raise ValueError(f"{name} source feature {record['LINEARID']} has fewer than two vertices")
            rows.append(pilot_row(county_fips, county_name, record, part_index, name, coords))
    if not rows:
        raise ValueError(f"No pilot road features found in {archive}")
    return rows


def pilot_row(county_fips, county_name, record, part_index, name, coords):
    length_m = line_length_m(coords)
    line = LineString(coords)
    if line.is_empty or not line.is_valid or line.length <= 0:
        raise ValueError(f"Invalid geometry for {name} source feature {record['LINEARID']}")
    min_lon, min_lat, max_lon, max_lat = bounds_of(coords)
    return {
        "road_id": road_id(county_fips, name), "name": name, "road_class": str(record["MTFCC"]),
        "route_type": str(record.get("RTTYP") or ""), "county_fips": county_fips, "county_name": county_name,
        "source_feature_id": str(record["LINEARID"]), "part": part_index, "point_count": len(coords),
        "length_m": round(length_m, 3), "min_lon": min_lon, "min_lat": min_lat, "max_lon": max_lon,
        "max_lat": max_lat, "source_url": SOURCE_BASE + COUNTIES[county_fips][1],
        "source_archive_sha256": COUNTIES[county_fips][2], **PROVENANCE, "geometry": line.wkb,
    }


def source_lines(rows):
    """Composed source geometry for offline verification of one county-scoped road.

    Ordering and canonical geometry are decided in the browser normalizer, not here; this only
    applies the same duplicate handling so the offline numbers and the browser agree.
    """
    return composed_lines([{"coordinates": list(shapely_wkb.loads(row["geometry"]).coords)} for row in rows])


def verify_source_coverage(rows):
    counts = {}
    for row in rows:
        key = (row["name"], row["county_fips"])
        counts[key] = counts.get(key, 0) + 1
    for name, county_fips, expected in PILOT_ROADS:
        actual = counts.get((name, county_fips), 0)
        if actual != expected:
            raise ValueError(f"Source verification failed: {name} in {county_fips} has {actual} features, expected {expected}")
    if set(counts) - {(name, fips) for name, fips, _ in PILOT_ROADS}:
        raise ValueError("Unexpected pilot road/county pairs in the source extract")


def write_snapshot(rows, path):
    """Deterministic offline snapshot of the real pilot source features for Node tests."""
    roads = []
    for road in sorted({row["road_id"] for row in rows}):
        features = [row for row in rows if row["road_id"] == road]
        lines = source_lines(features)
        roads.append({
            "roadId": road, "name": features[0]["name"], "roadClass": features[0]["road_class"],
            "routeType": features[0]["route_type"], "countyFips": features[0]["county_fips"],
            "countyName": features[0]["county_name"], "sourceFeatureCount": len(features),
            "sourceFeatureIds": [row["source_feature_id"] for row in features],
            "sourceLengthM": round(sum(row["length_m"] for row in features), 3),
            "uniqueSourceLengthM": round(sum(line_length_m(line) for line in lines), 3),
            "features": [{"sourceFeatureId": row["source_feature_id"], "part": row["part"],
                          "coordinates": [list(point) for point in shapely_wkb.loads(row["geometry"]).coords]}
                         for row in features],
        })
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "kind": "road-pilot-source-snapshot", "datasetId": DATASET_ID, "datasetVersion": DATASET_VERSION,
        "note": "Generated by scripts/build-roads.py from the pinned TIGER/Line archives. Real source coordinates; "
                "the browser still retrieves geometry through the GIS service.",
        "source": {"agency": SOURCE_AGENCY, "dataset": SOURCE_DATASET, "vintage": SOURCE_VINTAGE,
                   "publicationDate": SOURCE_PUBLICATION_DATE, "documentationUrl": SOURCE_DOCS, "license": SOURCE_LICENSE},
        "sourceCrs": "EPSG:4269", "geometryCrs": "EPSG:4326", "roads": roads,
    }, indent=2) + "\n")
    return roads



def verify_ecoregions(rows):
    """Read-only check that the real pilot geometry resolves against the checked-in EPA layers."""
    conn = duckdb.connect()
    conn.execute("INSTALL spatial; LOAD spatial;")
    for road in sorted({row["road_id"] for row in rows}):
        lines = source_lines([row for row in rows if row["road_id"] == road])
        wkt = "MULTILINESTRING(" + ",".join("(" + ",".join(f"{lon} {lat}" for lon, lat in line) + ")" for line in lines) + ")"
        geom = f"ST_GeomFromText('{wkt}')"
        projected = f"ST_Transform({geom}, 'EPSG:4326', 'EPSG:5070', always_xy := true)"
        total = round(conn.execute(f"SELECT ST_Length({projected})").fetchone()[0], 1)
        print(f"\n{road}: {total:,.1f} m composed ({len(lines)} unique source feature(s))")
        for level in (3, 4):
            sql = f"""SELECT code, name, round(SUM(m), 1) AS overlap_m FROM (
                SELECT code, name, ST_Length(ST_Transform(ST_Intersection(geometry, {geom}), 'EPSG:4326',
                    'EPSG:5070', always_xy := true)) AS m
                FROM read_parquet('{ROOT / "data" / "gis" / f"epa-or-l{level}-2012.parquet"}')
                WHERE ST_Intersects(geometry, {geom})) WHERE m > 0
                GROUP BY code, name ORDER BY overlap_m DESC, code"""
            for code, name, overlap_m in conn.execute(sql).fetchall():
                print(f"   L{level} {code:>3} {name:44} {overlap_m:9,.1f} m {overlap_m / total * 100:5.1f}%")


def manifest_entry(path, digest, stats, snapshot_roads):
    roads = [{"id": road["roadId"], "name": road["name"], "roadClass": road["roadClass"],
              "countyFips": road["countyFips"], "countyName": road["countyName"],
              "sourceFeatureCount": road["sourceFeatureCount"], "sourceLengthM": road["sourceLengthM"],
              "uniqueSourceLengthM": road["uniqueSourceLengthM"]} for road in snapshot_roads]
    return {
        "id": DATASET_ID, "type": "road-centerlines", "version": DATASET_VERSION, "format": "GeoParquet",
        "url": f"gis/{path.name}", "bytes": path.stat().st_size, "sha256": digest,
        "featureCount": stats["featureCount"], "roadCount": stats["roadCount"], "pointCount": stats["pointCount"],
        "crs": "EPSG:4326",
        "scope": {"kind": DATASET_SCOPE, "bbox": list(PILOT_BBOX), "roads": roads},
        "source": {"agency": SOURCE_AGENCY, "dataset": SOURCE_DATASET, "vintage": SOURCE_VINTAGE,
                   "url": SOURCE_BASE + COUNTIES["41067"][1],
                   "urls": {fips: SOURCE_BASE + COUNTIES[fips][1] for fips in sorted(COUNTIES)},
                   "sha256": {fips: COUNTIES[fips][2] for fips in sorted(COUNTIES)},
                   "publicationDate": SOURCE_PUBLICATION_DATE, "documentationUrl": SOURCE_DOCS,
                   "license": SOURCE_LICENSE},
        "normalization": {"pipelineVersion": PIPELINE_VERSION, "method": NORMALIZATION,
                          "sourceCrs": "EPSG:4269", "crs": "EPSG:4326"},
        "schemaVersion": 1,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="pre-downloaded TIGER/Line county ROADS ZIP matching a pinned digest")
    parser.add_argument("--cache", type=Path, default=Path("/tmp/roadnaturalist-road-sources"))
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--verify-ecoregions", action="store_true", help="print EPA Level III/IV overlap for the pilot roads")
    args = parser.parse_args()

    rows = []
    for county_fips in sorted(COUNTIES):
        supplied = args.archive if args.archive and COUNTIES[county_fips][1] == args.archive.name else None
        rows.extend(read_county(county_fips, source_archive(county_fips, supplied, args.cache, args.download)))
    rows.sort(key=lambda row: (row["road_id"], row["source_feature_id"], row["part"]))
    verify_source_coverage(rows)

    path = ROOT / "data" / "gis" / "or-roads-pilot-2025.parquet"
    stats = write_geoparquet(rows, path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    snapshot_roads = write_snapshot(rows, ROOT / "tests" / "fixtures" / "or-roads-pilot.snapshot.json")
    print(f"{DATASET_ID}: {stats['roadCount']} roads, {stats['featureCount']} source features, "
          f"{stats['pointCount']} vertices, {path.stat().st_size:,} bytes, SHA-256 {digest}")

    manifest_path = ROOT / "data" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    others = [dataset for dataset in manifest["datasets"] if dataset["id"] != DATASET_ID]
    # Deterministic order so rebuilding one artifact rewrites exactly one entry instead of moving it.
    manifest["datasets"] = sorted(others + [manifest_entry(path, digest, stats, snapshot_roads)], key=lambda entry: entry["id"])
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"manifest: {len(manifest['datasets'])} datasets declared")

    if args.verify_ecoregions:
        verify_ecoregions(rows)


if __name__ == "__main__":
    main()

