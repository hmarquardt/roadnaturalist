#!/usr/bin/env python3
"""Verify the pinned CONUS grid and every completed national county road checkpoint."""
import argparse
import importlib.util
import json
import sys
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq
from pyproj import CRS
from shapely import wkb
from shapely.geometry import box

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import tiger_sources as tiger  # noqa: E402

GRID = ROOT / "data/national/grid-conus-2025.json"
DEFAULT_WORK = ROOT / "data/national-work"
REQUIRED = {"road_id", "name", "road_class", "county_fips", "source_feature_id", "part", "geometry",
            "source_archive_sha256", "min_lon", "min_lat", "max_lon", "max_lat"}


def verify(work, selected=None, require_all=False):
    grid = json.loads(GRID.read_text())
    registry = json.loads((ROOT / "data/national/source-registry.json").read_text())
    if grid["boundarySource"]["stateSha256"] != registry["sources"]["boundaries"]["stateSha256"]:
        raise ValueError("grid state source differs from registry")
    if grid["boundarySource"]["countySha256"] != registry["sources"]["boundaries"]["countySha256"]:
        raise ValueError("grid county source differs from registry")
    lock = json.loads((ROOT / registry["sources"]["roads"]["lockPath"]).read_text())
    if lock["countyCount"] != len(grid["counties"]) or set(lock["counties"]) != {item["fips"] for item in grid["counties"]}:
        raise ValueError("national source lock does not cover exactly the CONUS counties")
    if grid["counts"] != {"states": 49, "counties": len(grid["counties"]), "cells": len(grid["cells"]),
                          "fullCells": sum(cell["coverage"] == "full" for cell in grid["cells"]),
                          "edgeCells": sum(cell["coverage"] == "edge" for cell in grid["cells"])}:
        raise ValueError("grid counts are inconsistent")
    if len({cell["id"] for cell in grid["cells"]}) != len(grid["cells"]):
        raise ValueError("duplicate grid cell ID")
    if len({county["fips"] for county in grid["counties"]}) != len(grid["counties"]):
        raise ValueError("duplicate county FIPS")
    requested = selected or {county["fips"] for county in grid["counties"]}
    if not requested <= {county["fips"] for county in grid["counties"]}:
        raise ValueError("requested county outside CONUS")
    counts = Counter()
    rows = source_bytes = output_bytes = 0
    problems = []
    for fips in sorted(requested):
        checkpoint = work / "jobs" / f"{fips}.json"
        if not checkpoint.exists():
            counts["pending"] += 1
            continue
        job = json.loads(checkpoint.read_text())
        if job["state"] != "complete":
            counts[job["state"]] += 1
            continue
        archive = work / "sources" / f"tl_2025_{fips}_roads.zip"
        output = work / "normalized" / f"{fips}.parquet"
        if job["sourceSha256"] != lock["counties"][fips]["sha256"] or job["sourceBytes"] != lock["counties"][fips]["bytes"]:
            problems.append(f"{fips}: source differs from committed national lock")
            continue
        if not archive.exists() or not output.exists():
            problems.append(f"{fips}: complete checkpoint missing source/output")
            continue
        if archive.stat().st_size != job["sourceBytes"] or tiger.sha256_of(archive) != job["sourceSha256"]:
            problems.append(f"{fips}: source digest/bytes mismatch")
            continue
        if output.stat().st_size != job["outputBytes"] or tiger.sha256_of(output) != job["outputSha256"]:
            problems.append(f"{fips}: normalized digest/bytes mismatch")
            continue
        schema = pq.read_schema(output)
        if not REQUIRED <= set(schema.names) or b"geo" not in (schema.metadata or {}):
            problems.append(f"{fips}: schema/GeoParquet metadata mismatch")
            continue
        table = pq.read_table(output, columns=["county_fips", "source_feature_id", "part", "road_class", "geometry"])
        if table.num_rows != job["rows"] or table.num_rows == 0:
            problems.append(f"{fips}: row count mismatch")
            continue
        values = table.to_pydict()
        keys = list(zip(values["county_fips"], values["source_feature_id"], values["part"]))
        if len(set(keys)) != len(keys) or any(item != fips for item in values["county_fips"]):
            problems.append(f"{fips}: duplicate logical ID or wrong county")
            continue
        if any(value not in ("S1200", "S1400", "S1500") for value in values["road_class"]):
            problems.append(f"{fips}: unexpected road class")
            continue
        if any(not value for value in values["geometry"]):
            problems.append(f"{fips}: null geometry")
            continue
        counts["complete"] += 1
        rows += table.num_rows
        source_bytes += job["sourceBytes"]
        output_bytes += job["outputBytes"]
    if problems:
        raise ValueError("; ".join(problems[:20]))
    if require_all and counts["complete"] != len(requested):
        raise ValueError(f"{len(requested)-counts['complete']} requested counties are not complete")
    return {"kind": "national-road-normalization-verification", "gridCells": len(grid["cells"]),
            "gridFullCells": grid["counts"]["fullCells"], "gridEdgeCells": grid["counts"]["edgeCells"],
            "conusCounties": len(grid["counties"]), "requestedCounties": len(requested), "states": dict(sorted(counts.items())),
            "rows": rows, "sourceBytes": source_bytes, "outputBytes": output_bytes}


def regional_regression(work):
    """Compare every pinned regional county with the current 20-county road-cell build."""
    regional = json.loads((ROOT / "data/regional/manifest.json").read_text())
    bounds = regional["region"]["bounds"] if isinstance(regional.get("region"), dict) else regional["bounds"]
    counties = sorted(tiger.COUNTIES)
    expected = {}
    for fips in counties:
        for row in pq.read_table(work / "normalized" / f"{fips}.parquet").to_pylist():
            if (row["min_lon"] >= bounds[0] and row["min_lat"] >= bounds[1]
                    and row["max_lon"] <= bounds[2] and row["max_lat"] <= bounds[3]):
                expected[(row["county_fips"], row["source_feature_id"], row["part"])] = row
    actual = {}
    for path in (ROOT / "data/regional/partitions/or-sw-wa-portland-v2/roads").glob("*.parquet"):
        for row in pq.read_table(path).to_pylist():
            actual[(row["county_fips"], row["source_feature_id"], row["part"])] = row
    if set(actual) != set(expected):
        missing = sorted(set(expected)-set(actual))[:3]
        extra = sorted(set(actual)-set(expected))[:3]
        raise ValueError(f"regional regression keys differ: national {len(expected)}, regional {len(actual)}, missing {missing}, extra {extra}")
    for key in expected:
        for field in ("road_id", "name", "road_class", "geometry", "source_feature_id", "part"):
            if expected[key][field] != actual[key][field]:
                raise ValueError(f"regional regression differs at {key} {field}")
    return {"counties": len(counties), "rows": len(expected), "result": "exact identity and geometry"}


def verify_manifest(work):
    path = work / "artifacts/road-manifest.json"
    if not path.exists():
        raise ValueError("national road manifest missing")
    manifest = json.loads(path.read_text())
    grid = json.loads(GRID.read_text())
    if manifest["gridSha256"] != tiger.sha256_of(GRID) or manifest["partitionScheme"] != grid["partitionScheme"]:
        raise ValueError("manifest grid digest/scheme mismatch")
    if len(manifest["cells"]) != len(grid["cells"]):
        raise ValueError("manifest does not declare every grid cell")
    present = empty = replicated = artifact_bytes = 0
    for cell, declared in zip(grid["cells"], manifest["cells"]):
        if declared["id"] != cell["id"] or declared["bounds"] != cell["bounds"]:
            raise ValueError(f"manifest cell mismatch: {cell['id']}")
        if declared["state"] == "empty":
            empty += 1
            if declared["featureCount"] != 0 or "url" in declared:
                raise ValueError(f"invalid declared empty cell: {cell['id']}")
            continue
        if declared["state"] != "present":
            raise ValueError(f"missing/failed cell cannot be published: {cell['id']}")
        output = work / "artifacts/roads" / f"{cell['id']}.parquet"
        if not output.exists() or output.stat().st_size != declared["bytes"] or tiger.sha256_of(output) != declared["sha256"]:
            raise ValueError(f"required cell object missing/corrupt: {cell['id']}")
        schema = pq.read_schema(output)
        if [{"name": field.name, "type": str(field.type)} for field in schema] != manifest["schema"]:
            raise ValueError(f"cell schema mismatch: {cell['id']}")
        geo = json.loads(schema.metadata[b"geo"])
        if geo.get("primary_column") != "geometry" or CRS.from_json_dict(geo["columns"]["geometry"]["crs"]).to_epsg() != 4326:
            raise ValueError(f"cell GeoParquet CRS mismatch: {cell['id']}")
        table = pq.read_table(output, columns=["county_fips", "source_feature_id", "part", "geometry"])
        if table.num_rows != declared["featureCount"] or table.num_rows == 0:
            raise ValueError(f"cell row count mismatch: {cell['id']}")
        values = table.to_pydict()
        keys = list(zip(values["county_fips"], values["source_feature_id"], values["part"]))
        if len(set(keys)) != len(keys) or any(not geometry for geometry in values["geometry"]):
            raise ValueError(f"cell duplicate ID/null geometry: {cell['id']}")
        for geometry in (values["geometry"][0], values["geometry"][-1]):
            line = wkb.loads(geometry)
            if line.geom_type != "LineString" or not line.intersects(box(*cell["bounds"])):
                raise ValueError(f"cell geometry unreadable/outside bounds: {cell['id']}")
        present += 1
        replicated += table.num_rows
        artifact_bytes += output.stat().st_size
    counts = {"cells": len(grid["cells"]), "present": present, "empty": empty,
              "replicatedRows": replicated, "artifactBytes": artifact_bytes}
    if counts != manifest["counts"]:
        raise ValueError("manifest totals differ from verified objects")
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--counties", help="comma-separated county FIPS; default all CONUS")
    parser.add_argument("--require-all", action="store_true")
    parser.add_argument("--regional-regression", action="store_true")
    parser.add_argument("--manifest", action="store_true", help="verify all final cell objects and declared empties")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = verify(args.work, set(args.counties.split(",")) if args.counties else None, args.require_all)
    if args.regional_regression:
        result["regionalRegression"] = regional_regression(args.work)
    if args.manifest:
        result["manifest"] = verify_manifest(args.work)
    print(json.dumps(result, separators=(",", ":") if args.json else None, indent=None if args.json else 2))


if __name__ == "__main__":
    main()
