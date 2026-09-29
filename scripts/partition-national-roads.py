#!/usr/bin/env python3
"""Resume county-to-cell fragments, then compact one immutable GeoParquet object per CONUS cell."""
import argparse
import hashlib
import json
import math
import sys
import time
from collections import defaultdict
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from shapely import wkb
from shapely.geometry import box

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import tiger_sources as tiger  # noqa: E402
from importlib.machinery import SourceFileLoader

jobs = SourceFileLoader("national_jobs", str(ROOT / "scripts/build-national-roads.py")).load_module()
GRID = json.loads((ROOT / "data/national/grid-conus-2025.json").read_text())
CELL_IDS = {cell["id"] for cell in GRID["cells"]}
STEP = 0.2
VERSION = "tiger2025-county-v1"


def hash_text(value):
    return hashlib.sha256(value.encode()).hexdigest()


def cell_for(x, y):
    return f"x{x}_y{y}"


def member_cells(row):
    geometry = wkb.loads(row["geometry"])
    x0, x1 = math.floor((row["min_lon"]+180)/STEP), math.floor((row["max_lon"]+180)/STEP)
    y0, y1 = math.floor((row["min_lat"]+90)/STEP), math.floor((row["max_lat"]+90)/STEP)
    for x in range(x0, x1+1):
        for y in range(y0, y1+1):
            cell = cell_for(x, y)
            if cell not in CELL_IDS:
                continue
            bounds = [-180+STEP*x, -90+STEP*y, -180+STEP*(x+1), -90+STEP*(y+1)]
            if geometry.intersects(box(*bounds)):
                yield cell


def write_table(rows, path, schema=None):
    table = pa.Table.from_pylist(rows, schema=schema)
    bounds = [min(row["min_lon"] for row in rows), min(row["min_lat"] for row in rows),
              max(row["max_lon"] for row in rows), max(row["max_lat"] for row in rows)]
    from pyproj import CRS
    geo = {"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": {
        "encoding": "WKB", "geometry_types": ["LineString"], "crs": CRS.from_epsg(4326).to_json_dict(), "bbox": bounds}}}
    table = table.replace_schema_metadata({b"geo": json.dumps(geo, separators=(",", ":")).encode()})
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    pq.write_table(table, temporary, compression="zstd")
    if pq.read_metadata(temporary).num_rows != len(rows):
        raise ValueError(f"row count mismatch: {path}")
    temporary.replace(path)
    return {"rows": len(rows), "bytes": path.stat().st_size, "sha256": tiger.sha256_of(path)}


def partition_county(work, fips):
    source_job = json.loads((work / "jobs" / f"{fips}.json").read_text())
    if source_job["state"] != "complete":
        raise ValueError(f"{fips} normalization is {source_job['state']}")
    normalized = work / "normalized" / f"{fips}.parquet"
    if tiger.sha256_of(normalized) != source_job["outputSha256"]:
        raise ValueError(f"{fips} normalized digest mismatch")
    path = work / "fragment-jobs" / f"{fips}.json"
    prior = json.loads(path.read_text()) if path.exists() else {}
    fragments = prior.get("fragments", {})
    if (prior.get("state") == "complete" and prior.get("inputSha256") == source_job["outputSha256"]
            and all((work / entry["path"]).exists() and tiger.sha256_of(work / entry["path"]) == entry["sha256"]
                    for entry in fragments.values())):
        return {"countyFips": fips, "state": "skipped", "cells": len(fragments), "rows": prior["replicatedRows"]}
    jobs.atomic_json(path, {"countyFips": fips, "state": "running", "inputSha256": source_job["outputSha256"]})
    started = time.monotonic()
    rows = pq.read_table(normalized).to_pylist()
    source_schema = pq.read_schema(normalized).remove_metadata()
    by_cell = defaultdict(list)
    for row in rows:
        for cell in member_cells(row):
            by_cell[cell].append(row)
    out = {}
    prefix = fips + "/" + source_job["outputSha256"][:16]
    for cell in sorted(by_cell):
        relative = Path("fragments") / prefix / f"{cell}.parquet"
        result = write_table(by_cell[cell], work / relative, source_schema)
        out[cell] = {"path": str(relative), **result}
    checkpoint = {"countyFips": fips, "state": "complete", "inputSha256": source_job["outputSha256"],
                  "fragments": out, "replicatedRows": sum(item["rows"] for item in out.values()),
                  "wallSeconds": round(time.monotonic()-started, 3)}
    jobs.atomic_json(path, checkpoint)
    return {"countyFips": fips, "state": "complete", "cells": len(out), "rows": checkpoint["replicatedRows"],
            "wallSeconds": checkpoint["wallSeconds"]}


def compact(work):
    county_fips = [county["fips"] for county in GRID["counties"]]
    canonical_schema = pq.read_schema(work / "normalized" / f"{county_fips[0]}.parquet").remove_metadata()
    index = defaultdict(list)
    for fips in county_fips:
        path = work / "fragment-jobs" / f"{fips}.json"
        if not path.exists():
            raise ValueError(f"cannot finalize: county {fips} has no partition checkpoint")
        job = json.loads(path.read_text())
        if job["state"] != "complete":
            raise ValueError(f"cannot finalize: county {fips} is {job['state']}")
        for cell, entry in job["fragments"].items():
            index[cell].append(entry)
    result = []
    old_path = work / "artifacts" / "road-manifest.json"
    old = json.loads(old_path.read_text()) if old_path.exists() else {}
    previous = {entry["id"]: entry for entry in old.get("cells", [])}
    for cell in GRID["cells"]:
        cell_id = cell["id"]
        fragments = sorted(index.get(cell_id, []), key=lambda item: item["path"])
        input_sha = hash_text("\n".join(item["sha256"] for item in fragments))
        if not fragments:
            result.append({"id": cell_id, "bounds": cell["bounds"], "state": "empty", "featureCount": 0,
                           "inputSha256": input_sha})
            continue
        path = work / "artifacts" / "roads" / f"{cell_id}.parquet"
        prior = previous.get(cell_id, {})
        if (prior.get("inputSha256") == input_sha and path.exists() and path.stat().st_size == prior.get("bytes")
                and tiger.sha256_of(path) == prior.get("sha256")
                and pq.read_schema(path).remove_metadata() == canonical_schema):
            result.append(prior)
            continue
        by_key = {}
        for fragment in fragments:
            source = work / fragment["path"]
            if not source.exists() or tiger.sha256_of(source) != fragment["sha256"]:
                raise ValueError(f"missing/corrupt required fragment {source}")
            for row in pq.read_table(source).to_pylist():
                key = (row["county_fips"], row["source_feature_id"], row["part"])
                if key in by_key and by_key[key]["geometry"] != row["geometry"]:
                    raise ValueError(f"same logical road with different geometry: {key}")
                by_key[key] = row
        rows = [by_key[key] for key in sorted(by_key)]
        artifact = write_table(rows, path, canonical_schema)
        result.append({"id": cell_id, "bounds": cell["bounds"], "state": "present", "featureCount": len(rows),
                       "inputSha256": input_sha, "url": f"national/roads/{VERSION}/roads/{cell_id}.parquet", **artifact})
    first_present = next(entry for entry in result if entry["state"] == "present")
    first_schema = pq.read_schema(work / "artifacts" / "roads" / f"{first_present['id']}.parquet")
    schema = [{"name": field.name, "type": str(field.type)} for field in first_schema]
    manifest = {"schemaVersion": 1, "kind": "national-roads", "version": VERSION,
                "coverage": GRID["coverage"], "gridSha256": tiger.sha256_of(ROOT / "data/national/grid-conus-2025.json"),
                "source": {"dataset": "TIGER/Line county ROADS", "vintage": "2025", "countyCount": len(county_fips)},
                "pipelineVersion": jobs.PIPELINE_VERSION, "partitionScheme": GRID["partitionScheme"], "schema": schema,
                "counts": {"cells": len(result), "present": sum(entry["state"] == "present" for entry in result),
                           "empty": sum(entry["state"] == "empty" for entry in result),
                           "replicatedRows": sum(entry["featureCount"] for entry in result),
                           "artifactBytes": sum(entry.get("bytes", 0) for entry in result)}, "cells": result}
    jobs.atomic_json(old_path, manifest)
    return manifest["counts"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=jobs.DEFAULT_WORK)
    parser.add_argument("--counties", help="comma-separated FIPS for bounded fragment build; default all completed counties")
    parser.add_argument("--finalize", action="store_true", help="requires all 3,109 county fragment jobs")
    args = parser.parse_args()
    if args.finalize:
        print(json.dumps(compact(args.work)))
        return
    requested = args.counties.split(",") if args.counties else [county["fips"] for county in GRID["counties"]
                                                               if (args.work / "jobs" / f"{county['fips']}.json").exists()
                                                               and json.loads((args.work / "jobs" / f"{county['fips']}.json").read_text()).get("state") == "complete"]
    totals = {"counties": 0, "complete": 0, "skipped": 0, "cells": 0, "replicatedRows": 0}
    for fips in requested:
        outcome = partition_county(args.work, fips)
        totals["counties"] += 1
        totals[outcome["state"]] += 1
        totals["cells"] += outcome["cells"]
        totals["replicatedRows"] += outcome["rows"]
    print(json.dumps(totals))


if __name__ == "__main__":
    main()
