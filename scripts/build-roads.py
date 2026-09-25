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
import urllib.request
import zipfile
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import shapefile
from pyproj import CRS, Transformer
from shapely import wkb as shapely_wkb
from shapely.geometry import LineString

ROOT = Path(__file__).resolve().parents[1]
SOURCE_BASE = "https://www2.census.gov/geo/tiger/TIGER2025/ROADS/"
SOURCE_AGENCY = "U.S. Census Bureau"
SOURCE_DATASET = "TIGER/Line 2025 ROADS (county road centerlines)"
SOURCE_VINTAGE = "TIGER2025"
SOURCE_PUBLICATION_DATE = "2025-09-22"
SOURCE_DOCS = "https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html"
SOURCE_LICENSE = "Public domain (U.S. Government work)"
PIPELINE_VERSION = "road-ingest-v1"
NORMALIZATION = (
    "Filter TIGER/Line county ROADS features by pilot road name and pilot bounding box; split multi-part shapes "
    "into one row per part; drop consecutive duplicate vertices; transform EPSG:4269 to EPSG:4326 with always_xy; "
    "emit one WKB LineString row per source feature part."
)
DATASET_ID = "or-roads-pilot"
DATASET_VERSION = "tiger-2025-v1"
DATASET_SCOPE = "Oregon road centerline pilot (Washington and Multnomah County extract)"
COUNTIES = {
    "41067": ("Washington County, Oregon", "tl_2025_41067_roads.zip",
              "fda13013515689b57a500462db9b19bdd4dc0c3a70d341eec7eb9f7d7c42eea7"),
    "41051": ("Multnomah County, Oregon", "tl_2025_41051_roads.zip",
              "30ae0afe1a0bb6685da281b8ad97fc708876b61e9bfc7c1f0f96118d33d3cb92"),
}
# Bounded extraction window. The pilot is a bounded extract, not a county or state road catalog.
PILOT_BBOX = (-123.10, 45.50, -122.70, 45.70)
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
    "source_publication_date": SOURCE_PUBLICATION_DATE, "source_crs": "EPSG:4269", "crs": "EPSG:4326",
    "pipeline_version": PIPELINE_VERSION, "normalization": NORMALIZATION,
}
# Conus Albers (EPSG:5070) meters for deterministic length and endpoint measurements.
TO_METERS = Transformer.from_crs(4326, 5070, always_xy=True).transform
# Composition tolerance mirrors src/roads/normalize.js: short junction gaps are joined in order,
# larger gaps are reported as unresolved rather than invented.
COMPOSITION_TOLERANCE_M = 150.0
REVERSED_LINK_LENGTH_RATIO = 0.25


def slug(text):
    cleaned = "".join(char.lower() if char.isalnum() else "-" for char in str(text))
    return "-".join(part for part in cleaned.split("-") if part)


def road_id(county_fips, name):
    return f"tiger-2025-or-{county_fips}-{slug(name)}"


def source_archive(county_fips, supplied, cache, download):
    name, digest = COUNTIES[county_fips][1], COUNTIES[county_fips][2]
    path = supplied or cache / name
    if not path.exists():
        if not download:
            raise FileNotFoundError(f"{path} missing; pass --download or --archive")
        cache.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(SOURCE_BASE + name, path)
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != digest:
        raise ValueError(f"{name} SHA-256 mismatch: {actual} (source republished? see docs/ROADS.md)")
    return path


def clean(coords):
    """Drop consecutive duplicate vertices; real centerlines repeat junction vertices."""
    kept = []
    for point in coords:
        if kept and (point[0], point[1]) == (kept[-1][0], kept[-1][1]):
            continue
        kept.append((float(point[0]), float(point[1])))
    return kept


def read_county(county_fips, archive):
    stem = Path(COUNTIES[county_fips][1]).stem
    county_name = COUNTIES[county_fips][0]
    names = {name for name, fips, _ in PILOT_ROADS if fips == county_fips}
    rows = []
    with zipfile.ZipFile(archive) as archive_zip:
        source_crs = CRS.from_wkt(archive_zip.read(stem + ".prj").decode())
        if source_crs.to_authority() != ("EPSG", "4269"):
            raise ValueError(f"{county_fips} source CRS is {source_crs.to_authority()}, expected EPSG:4269")
        project = Transformer.from_crs(source_crs, 4326, always_xy=True).transform
        reader = shapefile.Reader(shp=archive_zip.open(stem + ".shp"), shx=archive_zip.open(stem + ".shx"),
                                  dbf=archive_zip.open(stem + ".dbf"), encoding="latin1")
        fields = [field[0] for field in reader.fields[1:]]
        for feature in reader.iterShapeRecords():
            record = dict(zip(fields, feature.record))
            name = str(record.get("FULLNAME") or "").strip()
            if name not in names:
                continue
            geometry = feature.shape.__geo_interface__
            parts = geometry["coordinates"] if geometry["type"] == "MultiLineString" else [geometry["coordinates"]]
            for part_index, part in enumerate(parts):
                coords = clean(part)
                xs = [point[0] for point in coords]
                ys = [point[1] for point in coords]
                if min(xs) < PILOT_BBOX[0] or max(xs) > PILOT_BBOX[2] or min(ys) < PILOT_BBOX[1] or max(ys) > PILOT_BBOX[3]:
                    raise ValueError(f"{name} source feature {record['LINEARID']} leaves the pilot bounding box")
                if len(coords) < 2:
                    raise ValueError(f"{name} source feature {record['LINEARID']} has fewer than two vertices")
                projected = [TO_METERS(lon, lat) for lon, lat in coords]
                length_m = sum(
                    ((projected[i][0] - projected[i - 1][0]) ** 2 + (projected[i][1] - projected[i - 1][1]) ** 2) ** 0.5
                    for i in range(1, len(projected)))
                line = LineString(coords)
                if line.is_empty or not line.is_valid or line.length <= 0:
                    raise ValueError(f"Invalid geometry for {name} source feature {record['LINEARID']}")
                rows.append({
                    "road_id": road_id(county_fips, name), "name": name, "road_class": str(record["MTFCC"]),
                    "route_type": str(record.get("RTTYP") or ""), "county_fips": county_fips, "county_name": county_name,
                    "source_feature_id": str(record["LINEARID"]), "part": part_index, "point_count": len(coords),
                    "length_m": round(length_m, 3), "min_lon": min(xs), "min_lat": min(ys), "max_lon": max(xs),
                    "max_lat": max(ys), "source_url": SOURCE_BASE + COUNTIES[county_fips][1],
                    "source_archive_sha256": COUNTIES[county_fips][2], **PROVENANCE, "geometry": line.wkb,
                })
    if not rows:
        raise ValueError(f"No pilot road features found in {archive}")
    return rows


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


def composed_lines(rows):
    """Duplicate handling that mirrors src/roads/normalize.js, used only for offline verification.

    Exact duplicates (same or reversed vertex sequence) are dropped, and a pair of features that
    digitizes the same junction link in opposite directions is collapsed to the longer one.
    Ordering and canonical geometry are decided in the browser normalizer, not here.
    """
    key = lambda line: (-line_length_m(line), tuple(line[0]), tuple(line[-1]))
    kept, seen = [], set()
    for line in sorted([list(shapely_wkb.loads(row["geometry"]).coords) for row in rows], key=key):
        sequences = (tuple(line), tuple(reversed(line)))
        if sequences[0] in seen or sequences[1] in seen:
            continue
        seen.update(sequences)
        kept.append(line)
    collapsed = []
    for line in kept:
        if not any(is_reversed_link(line, other) for other in collapsed):
            collapsed.append(line)
    return collapsed


def endpoint_gap_m(first, second):
    first_m = [TO_METERS(lon, lat) for lon, lat in (first[0], first[-1])]
    second_m = [TO_METERS(lon, lat) for lon, lat in (second[0], second[-1])]
    return min(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 for a in first_m for b in second_m)


def is_reversed_link(first, second, tolerance_m=COMPOSITION_TOLERANCE_M):
    """True when two features digitize the same short stretch of road in opposite directions."""
    if endpoint_gap_m(list(reversed(first)), second) > tolerance_m:
        return False
    lengths = (line_length_m(first), line_length_m(second))
    if abs(lengths[0] - lengths[1]) > REVERSED_LINK_LENGTH_RATIO * max(lengths):
        return False
    midpoints = [TO_METERS(*line[len(line) // 2]) for line in (first, second)]
    return ((midpoints[0][0] - midpoints[1][0]) ** 2 + (midpoints[0][1] - midpoints[1][1]) ** 2) ** 0.5 <= tolerance_m


def line_length_m(coordinates):
    projected = [TO_METERS(lon, lat) for lon, lat in coordinates]
    return sum(((projected[i][0] - projected[i - 1][0]) ** 2 + (projected[i][1] - projected[i - 1][1]) ** 2) ** 0.5
               for i in range(1, len(projected)))


def write_geoparquet(rows, path):
    columns = {key: [row[key] for row in rows] for key in rows[0]}
    table = pa.table(columns)
    geo = {"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": {
        "encoding": "WKB", "geometry_types": ["LineString"], "crs": CRS.from_epsg(4326).to_json_dict(),
        "bbox": [min(row["min_lon"] for row in rows), min(row["min_lat"] for row in rows),
                 max(row["max_lon"] for row in rows), max(row["max_lat"] for row in rows)]}}}
    table = table.replace_schema_metadata({b"geo": json.dumps(geo, separators=(",", ":")).encode()})
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path, compression="zstd")
    reread = pq.read_table(path)
    if reread.num_rows != len(rows) or b"geo" not in reread.schema.metadata:
        raise ValueError("GeoParquet round-trip failed")
    if any(value is None for value in reread.column("geometry").to_pylist()):
        raise ValueError("GeoParquet contains null geometry")
    conn = duckdb.connect()
    conn.execute("INSTALL spatial; LOAD spatial;")
    total, roads, points, linears = conn.execute(
        "SELECT count(*), count(DISTINCT road_id), sum(ST_NPoints(geometry)), "
        "sum(CASE WHEN ST_GeometryType(geometry) = 'LINESTRING' THEN 1 ELSE 0 END) FROM read_parquet(?)",
        [str(path)]).fetchone()
    if (total, linears) != (len(rows), len(rows)) or roads < 1 or points < len(rows) * 2:
        raise ValueError("DuckDB read-back failed")
    return {"featureCount": int(total), "roadCount": int(roads), "pointCount": int(points)}


def write_snapshot(rows, path):
    """Deterministic offline snapshot of the real pilot source features for Node tests."""
    roads = []
    for road in sorted({row["road_id"] for row in rows}):
        features = [row for row in rows if row["road_id"] == road]
        lines = composed_lines(features)
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
        lines = composed_lines([row for row in rows if row["road_id"] == road])
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
    manifest["datasets"] = others + [manifest_entry(path, digest, stats, snapshot_roads)]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"manifest: {len(manifest['datasets'])} datasets declared")

    if args.verify_ecoregions:
        verify_ecoregions(rows)


if __name__ == "__main__":
    main()

