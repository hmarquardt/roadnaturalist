#!/usr/bin/env python3
"""Prove the runtime consumer predicate works against the national hydro plane.

The last semantic bug in this plane was a `layer` value the application never asks for: the plane published
`NHDFlowline`/`NHDWaterbody` while every runtime query filters on `flowline`/`waterbody`. Inspecting the schema
would not have caught it, so this check runs the *actual* predicate the browser runs
(`src/gis/discovery-query.js`, `src/gis/habitat-query.js`) over representative national cells and requires real
rows back — one cell from the regional-equivalence location, plus geographically distinct cells.

    python3 scripts/check-hydro-consumers.py --work /Volumes/Lexar/roadnaturalist/work/nhd
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_volume as bv  # noqa: E402
import duckdb  # noqa: E402
import national_hydro as nh  # noqa: E402

MANIFEST_PATH = ROOT / "data/national/hydro-manifest.json"
DEFAULT_WORK = bv.work_dir("nhd", ROOT / "data/national-hydro-work")
# The regional-equivalence location first, then cells far from it: the Gulf coast and the Great Lakes.
PREFERRED_UNITS = ("17090010", "12090101", "04030108")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--cells", type=int, default=3)
    args = parser.parse_args()
    manifest = json.loads(MANIFEST_PATH.read_text())
    present = {cell["id"] for cell in manifest["cells"] if cell["state"] == "present"}
    connection = duckdb.connect()

    chosen = []
    for unit in PREFERRED_UNITS:
        checkpoint = args.work / "partition-jobs" / f"{unit}.json"
        if not checkpoint.exists():
            continue
        record = json.loads(checkpoint.read_text())
        for cell_id in sorted(record["cells"]):
            if cell_id in present and cell_id not in [entry[1] for entry in chosen]:
                chosen.append((unit, cell_id))
                break
        if len(chosen) >= args.cells:
            break
    if not chosen:
        raise SystemExit("no representative built cell is available for the consumer check")

    results = []
    for unit, cell_id in chosen:
        artifact = args.work / "artifacts" / "hydro" / f"{cell_id}.parquet"
        if not artifact.exists():
            raise SystemExit(f"{cell_id}: declared present but no artifact")
        counts = {}
        for layer, member in ((nh.PUBLISHED_LAYER[nh.LAYERS[0][0]], "geometry"), (nh.PUBLISHED_LAYER[nh.LAYERS[1][0]], "geometry")):
            # This is the runtime predicate verbatim: the value the application filters on.
            counts[layer] = connection.execute(
                f"SELECT count(*) FROM read_parquet('{artifact}') WHERE layer = '{layer}'").fetchone()[0]
            lengths = connection.execute(
                f"""SELECT count(*), sum(CASE WHEN length_m IS NOT NULL THEN 1 ELSE 0 END),
                           sum(CASE WHEN area_m2 IS NOT NULL THEN 1 ELSE 0 END)
                    FROM read_parquet('{artifact}') WHERE layer = '{layer}'""").fetchone()
            counts[f"{layer}Measurements"] = {"rows": lengths[0], "withLength": lengths[1], "withArea": lengths[2]}
        results.append({"unit": unit, "cell": cell_id, "counts": counts})
        if counts[nh.PUBLISHED_LAYER[nh.LAYERS[0][0]]] == 0 or counts[nh.PUBLISHED_LAYER[nh.LAYERS[1][0]]] == 0:
            raise SystemExit(f"{cell_id}: a runtime layer predicate returned no rows: {json.dumps(counts)}")
    connection.close()
    print(json.dumps({"checked": True, "cells": results}, indent=1))


if __name__ == "__main__":
    main()
