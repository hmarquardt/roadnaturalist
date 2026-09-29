#!/usr/bin/env python3
"""Build the deterministic CONUS 0.2-degree grid and county job universe from pinned TIGER boundaries."""
import argparse
import hashlib
import json
import math
import zipfile
from pathlib import Path

import shapefile
from shapely.geometry import box, shape
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "data/national/source-registry.json"
GRID = ROOT / "data/national/grid-conus-2025.json"
# 48 contiguous states and DC, explicitly excluding AK, HI and all territories.
STATE_FIPS = frozenset("01 04 05 06 08 09 10 11 12 13 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 44 45 46 47 48 49 50 51 53 54 55 56".split())
STEP = 0.2


def digest(path):
    with Path(path).open("rb") as source:
        hash_value = hashlib.sha256()
        for block in iter(lambda: source.read(1024 * 1024), b""):
            hash_value.update(block)
    return hash_value.hexdigest()


def features(archive, stem):
    with zipfile.ZipFile(archive) as zipped:
        with zipped.open(stem + ".shp") as shp, zipped.open(stem + ".shx") as shx, zipped.open(stem + ".dbf") as dbf:
            reader = shapefile.Reader(shp=shp, shx=shx, dbf=dbf, encoding="latin1")
            names = [field[0] for field in reader.fields[1:]]
            for record in reader.iterShapeRecords():
                yield dict(zip(names, record.record)), shape(record.shape.__geo_interface__)


def build(state_archive, county_archive):
    registry = json.loads(REGISTRY.read_text())
    source = registry["sources"]["boundaries"]
    for path, prefix in ((state_archive, "state"), (county_archive, "county")):
        if path.stat().st_size != source[prefix + "Bytes"] or digest(path) != source[prefix + "Sha256"]:
            raise ValueError(f"{prefix} boundary archive does not match pinned bytes/SHA-256: {path}")
    states = [(row["STATEFP"], geometry) for row, geometry in features(state_archive, "tl_2025_us_state")
              if row["STATEFP"] in STATE_FIPS]
    if len(states) != 49 or {code for code, _ in states} != STATE_FIPS:
        raise ValueError("CONUS must contain exactly the declared 48 states and DC")
    state_shapes = [geometry for _, geometry in states]
    tree = STRtree(state_shapes)
    west = min(geometry.bounds[0] for geometry in state_shapes)
    south = min(geometry.bounds[1] for geometry in state_shapes)
    east = max(geometry.bounds[2] for geometry in state_shapes)
    north = max(geometry.bounds[3] for geometry in state_shapes)
    cells = []
    for x in range(math.floor((west + 180) / STEP), math.ceil((east + 180) / STEP)):
        for y in range(math.floor((south + 90) / STEP), math.ceil((north + 90) / STEP)):
            bounds = [round(-180 + STEP*x, 9), round(-90 + STEP*y, 9),
                      round(-180 + STEP*(x+1), 9), round(-90 + STEP*(y+1), 9)]
            rectangle = box(*bounds)
            hit = [(states[int(index)][0], state_shapes[int(index)]) for index in tree.query(rectangle)
                   if state_shapes[int(index)].intersection(rectangle).area > 0]
            if not hit:
                continue
            # A cell is full only when one or more declared state polygons cover it completely.
            from shapely.ops import unary_union
            coverage = "full" if unary_union([geometry for _, geometry in hit]).covers(rectangle) else "edge"
            cells.append({"id": f"x{x}_y{y}", "bounds": bounds, "coverage": coverage,
                          "states": sorted(code for code, _ in hit)})
    counties = []
    for row, geometry in features(county_archive, "tl_2025_us_county"):
        if row["STATEFP"] not in STATE_FIPS:
            continue
        fips = row["GEOID"]
        counties.append({"fips": fips, "stateFips": row["STATEFP"], "name": row["NAME"],
                         "bounds": [round(value, 9) for value in geometry.bounds],
                         "sourceUrl": registry["sources"]["roads"]["urlTemplate"].replace("{countyFips}", fips)})
    cells.sort(key=lambda item: item["id"])
    counties.sort(key=lambda item: item["fips"])
    return {"schemaVersion": 1, "kind": "conus-grid", "coverage": "48 contiguous states plus District of Columbia",
            "stateFips": sorted(STATE_FIPS), "boundarySource": {"vintage": "TIGER2025", "stateSha256": source["stateSha256"],
            "countySha256": source["countySha256"]}, "partitionScheme": registry["grid"],
            "bounds": [round(value, 9) for value in (west, south, east, north)],
            "counts": {"states": len(states), "counties": len(counties), "cells": len(cells),
                       "fullCells": sum(cell["coverage"] == "full" for cell in cells),
                       "edgeCells": sum(cell["coverage"] == "edge" for cell in cells)},
            "cells": cells, "counties": counties}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-archive", type=Path, default=Path("/private/tmp/rn-tl_2025_us_state.zip"))
    parser.add_argument("--county-archive", type=Path, default=Path("/private/tmp/rn-tl_2025_us_county.zip"))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content = json.dumps(build(args.state_archive, args.county_archive), separators=(",", ":"), sort_keys=True) + "\n"
    if args.check:
        if GRID.read_text() != content:
            raise SystemExit("CONUS grid differs from committed catalog")
    else:
        GRID.parent.mkdir(parents=True, exist_ok=True)
        GRID.write_text(content)
    print(json.dumps({"grid": str(GRID), "bytes": len(content), "sha256": hashlib.sha256(content.encode()).hexdigest(),
                      "counts": json.loads(content)["counts"]}))


if __name__ == "__main__":
    main()
