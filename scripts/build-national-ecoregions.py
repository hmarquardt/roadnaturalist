#!/usr/bin/env python3
"""Build the CONUS EPA Level III/IV ecoregion plane, and pin its sources.

    python3 scripts/build-national-ecoregions.py --freeze --download     # pin the two national ZIPs
    python3 scripts/build-national-ecoregions.py --download              # build both levels

Why a national product rather than 49 state extracts: EPA publishes the same seamless mapping twice - as
per-state downloads (what the pilot pins, and what the browser reads today) and as two national shapefiles. The
national files carry the same ecoregion codes and names in the same NAD83 Albers projection, so a national plane
built from them has identical semantics while being one artifact per level instead of dozens. The state files stay
exactly as they are: the regional plane is not rebuilt, and the verifier proves the two agree point by point over
the regional window rather than assuming it.

The `us_eco_l4_no_st` layer is deliberately the *no state boundaries* variant: state-split polygons would repeat
a code many times for no semantic gain, and intersection summaries aggregate by code regardless of how many
polygons carry it.
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
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_volume as bv  # noqa: E402
from pyproj import CRS, Transformer
from shapely import make_valid
from shapely.geometry import shape
from shapely.ops import transform

ROOT = Path(__file__).resolve().parents[1]
LOCK_PATH = ROOT / "data/national/epa-conus-lock.json"
MANIFEST_PATH = ROOT / "data/national/epa-manifest.json"
DEFAULT_CACHE = Path("/Volumes/Lexar/roadnaturalist/sources/epa")
BASE = "https://dmap-prod-oms-edc.s3.us-east-1.amazonaws.com/ORD/Ecoregions/us/"
# The two published layers. `layer` is the shapefile stem inside each ZIP; the Level III file carries
# US_L3CODE/US_L3NAME and the Level IV file carries US_L4*/US_L3*, the same attribute pair the per-state extracts
# carry, so both products read through one code path.
LEVELS = {
    3: {"file": "us_eco_l3.zip", "layer": "us_eco_l3", "code": "US_L3CODE", "name": "US_L3NAME", "minFeatures": 50},
    4: {"file": "us_eco_l4.zip", "layer": "us_eco_l4_no_st", "code": "US_L4CODE", "name": "US_L4NAME",
        "minFeatures": 500},
}
PUBLICATION = {"agency": "U.S. Environmental Protection Agency",
               "dataset": "Level III and IV Ecoregions of the Continental United States",
               "publicationDate": "2015-07-17",
               "documentation": "https://www.epa.gov/eco-research/level-iii-and-iv-ecoregions-continental-united-states"}


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=1, sort_keys=True) + "\n")
    temporary.replace(path)


def freeze(cache, download=True):
    """Pin the two national archives by byte length and SHA-256, leaving them cached on the build volume."""
    cache.mkdir(parents=True, exist_ok=True)
    prior = json.loads(LOCK_PATH.read_text()) if LOCK_PATH.exists() else {}
    units = dict(prior.get("units", {}))
    for level, spec in sorted(LEVELS.items()):
        target = cache / spec["file"]
        if not target.exists():
            if not download:
                raise FileNotFoundError(f"{target} missing; pass --download or --source-dir")
            request = urllib.request.Request(BASE + spec["file"], headers={"User-Agent": "RoadNaturalist-EPA/1"})
            with urllib.request.urlopen(request, timeout=600) as response, target.open("wb") as output:
                while block := response.read(4 * 1024 * 1024):
                    output.write(block)
        with zipfile.ZipFile(target) as archive:
            members = sorted(item.filename for item in archive.infolist() if not item.is_dir())
            uncompressed = sum(item.file_size for item in archive.infolist())
        units[str(level)] = {"level": level, "url": BASE + spec["file"], "filename": spec["file"],
                             "bytes": target.stat().st_size, "sha256": sha256_file(target),
                             "layer": spec["layer"], "members": members, "uncompressedBytes": uncompressed,
                             "publicationDate": PUBLICATION["publicationDate"]}
        print(f"level {level}: {target.stat().st_size:,} bytes sha256 {units[str(level)]['sha256'][:16]}")
    atomic_json(LOCK_PATH, {"schemaVersion": 1, "kind": "epa-conus-ecoregions-lock", "coverage": "CONUS",
                            "levelCount": len(units),
                            "totalBytes": sum(entry["bytes"] for entry in units.values()),
                            **PUBLICATION, "units": dict(sorted(units.items()))})
    print(json.dumps({"levels": len(units), "totalBytes": sum(entry["bytes"] for entry in units.values())}))


def read_level(level, archive, spec):
    """Read the published polygon records: codes, names and geometry, repaired but never simplified."""
    rows = []
    with zipfile.ZipFile(archive) as z:
        source_crs = CRS.from_wkt(z.read(spec["layer"] + ".prj").decode())
        if not source_crs.is_projected:
            raise ValueError(f"Level {level} source CRS is not projected")
        project = Transformer.from_crs(source_crs, 4326, always_xy=True).transform
        reader = shapefile.Reader(shp=z.open(spec["layer"] + ".shp"), shx=z.open(spec["layer"] + ".shx"),
                                  dbf=z.open(spec["layer"] + ".dbf"), encoding="latin1")
        for feature in reader.iterShapeRecords():
            props = feature.record.as_dict()
            code = str(props[spec["code"]]).strip()
            name = str(props[spec["name"]]).strip()
            l3_code = str(props["US_L3CODE"]).strip()
            l3_name = str(props["US_L3NAME"]).strip()
            if not all((code, name, l3_code, l3_name)):
                raise ValueError(f"Level {level} has missing code/name")
            geometry = make_valid(transform(project, shape(feature.shape.__geo_interface__)))
            if geometry.is_empty or geometry.geom_type not in ("Polygon", "MultiPolygon") or not geometry.is_valid:
                raise ValueError(f"Invalid Level {level} geometry for {code}")
            bounds = geometry.bounds
            rows.append({"code": code, "name": name, "l3_code": l3_code, "l3_name": l3_name,
                         "min_lon": bounds[0], "min_lat": bounds[1], "max_lon": bounds[2], "max_lat": bounds[3],
                         "geometry": geometry.wkb})
    if len(rows) < spec["minFeatures"]:
        raise ValueError(f"Level {level} has too few features: {len(rows)}")
    return rows


def write_level(rows, path):
    """Write one GeoParquet with the pilot's schema and prove it reads back."""
    schema = pa.schema([("code", pa.string()), ("name", pa.string()), ("l3_code", pa.string()),
                        ("l3_name", pa.string()), ("min_lon", pa.float64()), ("min_lat", pa.float64()),
                        ("max_lon", pa.float64()), ("max_lat", pa.float64()), ("geometry", pa.binary())])
    table = pa.Table.from_pylist(rows, schema=schema)
    bounds = [min(row["min_lon"] for row in rows), min(row["min_lat"] for row in rows),
              max(row["max_lon"] for row in rows), max(row["max_lat"] for row in rows)]
    geo = {"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": {
        "encoding": "WKB", "geometry_types": ["Polygon", "MultiPolygon"],
        "crs": CRS.from_epsg(4326).to_json_dict(), "bbox": bounds}}}
    table = table.replace_schema_metadata({b"geo": json.dumps(geo, separators=(",", ":")).encode()})
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    pq.write_table(table, temporary, compression="zstd")
    temporary.replace(path)
    reread = pq.read_table(path)
    if reread.num_rows != len(rows) or b"geo" not in reread.schema.metadata:
        raise ValueError("GeoParquet round-trip failed")
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    result = connection.execute(
        "SELECT count(*), count(DISTINCT code), count(geometry), count(name) FROM read_parquet(?)",
        [str(path)]).fetchone()
    if result[0] != len(rows) or result[2] != len(rows) or result[3] != len(rows):
        raise ValueError(f"read-back validation failed for {path.name}: {result}")
    # A code may legitimately carry more than one published name. EPA's national Level IV layer spells code
    # `42c` both "Missouri Coteau Slope" and "Miissouri Coteau Slope" (a doubled i in the western polygon), and
    # names are reused across codes by design. Neither is ours to fix or drop: the rows are kept exactly as
    # published, and the multi-name codes are measured and recorded so a consumer aggregating by code knows the
    # published label can vary with which polygon overlaps most.
    multiple = connection.execute(
        """SELECT code, list(DISTINCT name) FROM read_parquet(?) GROUP BY code
           HAVING count(DISTINCT name) > 1 ORDER BY code""", [str(path)]).fetchall()
    connection.close()
    if not result[1]:
        raise ValueError(f"read-back validation failed for {path.name}: no codes")
    # Sorted, so the manifest is byte-stable run to run: a `DISTINCT` list order is not guaranteed.
    return {"rows": len(rows), "uniqueCodes": result[1],
            "codesWithMultipleNames": {code: sorted(names) for code, names in multiple},
            "bounds": bounds, "bytes": path.stat().st_size, "sha256": sha256_file(path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--out", type=Path,
                        default=bv.cells_dir("epa", ROOT / "data" / "national"),
                        help="where the level artifacts are written; defaults to the build volume")

    parser.add_argument("--download", action="store_true", help="fetch a missing pinned archive")
    parser.add_argument("--freeze", action="store_true", help="pin the sources and stop")
    args = parser.parse_args()
    if args.freeze:
        freeze(args.cache, args.download)
        return
    if not LOCK_PATH.exists():
        raise SystemExit("no source lock; run with --freeze --download first")
    lock = json.loads(LOCK_PATH.read_text())
    artifacts, features, codes = {}, 0, 0
    for level, spec in sorted(LEVELS.items()):
        entry = lock["units"][str(level)]
        archive = args.cache / entry["filename"]
        if not archive.exists():
            if not args.download:
                raise FileNotFoundError(f"{archive} missing; pass --download")
            freeze(args.cache, True)
        if archive.stat().st_size != entry["bytes"] or sha256_file(archive) != entry["sha256"]:
            raise ValueError(f"level {level} archive differs from the committed lock")
        rows = read_level(level, archive, spec)
        written = write_level(rows, args.out / f"epa-conus-l{level}.parquet")
        artifacts[str(level)] = {"id": f"epa-ecoregions-conus-l{level}", "level": level, "format": "GeoParquet",
                                 "url": f"national/epa-conus-l{level}.parquet", "crs": "EPSG:4326",
                                 "schemaVersion": 1, "featureCount": written["rows"],
                                 "uniqueCodes": written["uniqueCodes"],
                                 "codesWithMultipleNames": written["codesWithMultipleNames"],
                                 "bounds": written["bounds"],
                                 "bytes": written["bytes"], "sha256": written["sha256"],
                                 "source": {"url": entry["url"], "bytes": entry["bytes"],
                                            "sha256": entry["sha256"], "layer": entry["layer"]}}
        features += written["rows"]
        codes += written["uniqueCodes"]
        print(f"level {level}: {written['rows']} features, {written['uniqueCodes']} codes, "
              f"{written['bytes']:,} bytes, SHA-256 {written['sha256'][:16]}")
    manifest = {"schemaVersion": 1, "kind": "national-ecoregions", "version": "epa-conus-2015-v1",
                "coverage": "CONUS", "buildCoverage": "complete" if len(artifacts) == len(LEVELS) else "partial",
                "pipelineVersion": "epa-conus-shapefile-v1", "partitioning": "none: one artifact per level",
                "levels": sorted(int(level) for level in artifacts),
                "sourceLockSha256": sha256_file(LOCK_PATH), "publication": PUBLICATION,
                "artifacts": dict(sorted(artifacts.items())),
                "counts": {"levels": len(artifacts), "features": features, "uniqueCodes": codes,
                           "codesWithMultipleNames": sum(len(entry["codesWithMultipleNames"])
                                                         for entry in artifacts.values()),
                           "artifactBytes": sum(entry["bytes"] for entry in artifacts.values())}}
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    print(json.dumps({"manifest": str(MANIFEST_PATH), "manifestBytes": MANIFEST_PATH.stat().st_size,
                      "counts": manifest["counts"]}))


if __name__ == "__main__":
    main()
