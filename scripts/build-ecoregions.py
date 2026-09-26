#!/usr/bin/env python3
"""Build Oregon EPA Level III/IV GeoParquet. Run with uv; see docs/ECOREGIONS.md."""
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
from shapely import make_valid
from shapely.geometry import shape
from shapely.ops import transform

ROOT = Path(__file__).resolve().parents[1]
SOURCE_BASE = "https://dmap-prod-oms-edc.s3.us-east-1.amazonaws.com/ORD/Ecoregions/"
# EPA publishes these per state. Oregon is the pilot's ecoregion layer; Washington is added because the
# partitioned regional window crosses the Columbia River, and a corridor on the Washington side must not
# report "no ecoregion" because the layer stopped at a state line.
STATES = {
    "or": {3: ("or_eco_l3.zip", "b6690dd28974bbc0615225b0e96070bd32a3779d949c47b6666158e074098cdf"),
           4: ("or_eco_l4.zip", "0ed948418c655e3dd735a550debfe5ceddff54a74a3fb7c02d5b7e1c9f5f29ab")},
    "wa": {3: ("wa_eco_l3.zip", "e665f5a691b006feaf0c2d0ec8394c4e6d03de127267a21e054ae5bec4e6dae3"),
           4: ("wa_eco_l4.zip", "bc5c13a56a3cdd7bc4a48251400ac9bf7624b3af5d5fb8615e8b7127daff535b")},
}
STATE_NAMES = {"or": "Oregon", "wa": "Washington"}


def source_archive(state, level, supplied, cache, download):
    name, digest = STATES[state][level]
    path = supplied or cache / name
    if not path.exists():
        if not download:
            raise FileNotFoundError(f"{path} missing; pass --download or --l{level}-archive")
        cache.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(f"{SOURCE_BASE}{state}/{name}", path)
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != digest:
        raise ValueError(f"{name} SHA-256 mismatch: {actual}")
    return path


def read_level(state, level, archive):
    stem = f"{state}_eco_l{level}"
    rows = []
    with zipfile.ZipFile(archive) as z:
        source_crs = CRS.from_wkt(z.read(stem + ".prj").decode())
        if not source_crs.is_projected:
            raise ValueError(f"Level {level} source CRS is not projected")
        project = Transformer.from_crs(source_crs, 4326, always_xy=True).transform
        reader = shapefile.Reader(shp=z.open(stem + ".shp"), shx=z.open(stem + ".shx"), dbf=z.open(stem + ".dbf"), encoding="latin1")
        for feature in reader.iterShapeRecords():
            props = feature.record.as_dict()
            code = str(props[f"US_L{level}CODE"]).strip()
            name = str(props[f"US_L{level}NAME"]).strip()
            l3_code = str(props["US_L3CODE"]).strip()
            l3_name = str(props["US_L3NAME"]).strip()
            if not all((code, name, l3_code, l3_name)):
                raise ValueError(f"Level {level} has missing code/name")
            geom = make_valid(transform(project, shape(feature.shape.__geo_interface__)))
            if geom.is_empty or geom.geom_type not in ("Polygon", "MultiPolygon") or not geom.is_valid:
                raise ValueError(f"Invalid Level {level} geometry for {code}")
            bounds = geom.bounds
            rows.append({"code": code, "name": name, "l3_code": l3_code, "l3_name": l3_name,
                         "min_lon": bounds[0], "min_lat": bounds[1], "max_lon": bounds[2], "max_lat": bounds[3],
                         "geometry": geom.wkb})
    if len(rows) < (5 if level == 3 else 100):
        raise ValueError(f"Level {level} has too few features: {len(rows)}")
    return rows


def write_geoparquet(rows, path):
    columns = {key: [row[key] for row in rows] for key in rows[0]}
    table = pa.table(columns)
    geo = {"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": {
        "encoding": "WKB", "geometry_types": ["Polygon", "MultiPolygon"],
        "crs": CRS.from_epsg(4326).to_json_dict(),
        "bbox": [min(row["min_lon"] for row in rows), min(row["min_lat"] for row in rows), max(row["max_lon"] for row in rows), max(row["max_lat"] for row in rows)]
    }}}
    table = table.replace_schema_metadata({b"geo": json.dumps(geo, separators=(",", ":")).encode()})
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path, compression="zstd")
    reread = pq.read_table(path)
    if reread.num_rows != len(rows) or b"geo" not in reread.schema.metadata:
        raise ValueError("GeoParquet round-trip failed")
    conn = duckdb.connect()
    result = conn.execute("SELECT count(*), count(DISTINCT code), count(geometry), count(name) FROM read_parquet(?)", [str(path)]).fetchone()
    if result[0] != len(rows) or result[2] != len(rows) or result[3] != len(rows):
        raise ValueError("DuckDB read-back failed")
    return result[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", default="or", choices=sorted(STATES))
    parser.add_argument("--l3-archive", type=Path)
    parser.add_argument("--l4-archive", type=Path)
    parser.add_argument("--cache", type=Path, default=Path("/tmp/roadnaturalist-epa-sources"))
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    datasets = []
    for level in (3, 4):
        archive = source_archive(args.state, level, getattr(args, f"l{level}_archive"), args.cache, args.download)
        rows = read_level(args.state, level, archive)
        path = ROOT / "data" / "gis" / f"epa-{args.state}-l{level}-2012.parquet"
        unique_codes = write_geoparquet(rows, path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        datasets.append({"id": f"epa-ecoregions-{args.state}-l{level}", "type": "ecoregions",
                         "version": f"epa-{args.state}-2012-v1", "level": level,
                         "format": "GeoParquet", "url": f"gis/{path.name}", "bytes": path.stat().st_size, "sha256": digest,
                         "featureCount": len(rows), "uniqueCodes": unique_codes, "crs": "EPSG:4326",
                         "scope": {"kind": f"{STATE_NAMES[args.state]} state extract",
                                   "bbox": [min(r["min_lon"] for r in rows), min(r["min_lat"] for r in rows),
                                            max(r["max_lon"] for r in rows), max(r["max_lat"] for r in rows)]},
                         "source": {"agency": "U.S. Environmental Protection Agency",
                                    "url": f"{SOURCE_BASE}{args.state}/{STATES[args.state][level][0]}",
                                    "sha256": STATES[args.state][level][1], "publicationDate": "2012-05-08"},
                         "schemaVersion": 1})
        print(f"{args.state} Level {level}: {len(rows)} features, {unique_codes} codes, {path.stat().st_size:,} bytes, SHA-256 {digest}")
    manifest_path = ROOT / "data" / "manifest.json"
    existing = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"datasets": []}
    built = {dataset["id"] for dataset in datasets}
    preserved = [dataset for dataset in existing.get("datasets", []) if dataset.get("id") not in built]
    manifest = {"schemaVersion": 1, "project": "roadnaturalist",
                "datasets": sorted(preserved + datasets, key=lambda entry: entry["id"])}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"manifest: {len(manifest['datasets'])} datasets declared")


if __name__ == "__main__":
    main()
