#!/usr/bin/env python3
"""Build the road-component closure the raw publisher reads.

    uv run --python 3.12 --with duckdb python3 scripts/build-national-raw-closure.py

A promoted corridor is rebuilt from every cell its *road component* occupies, and the corridor id it must
reproduce was composed over the whole national road plane - so "which cells does this component span?" has to be
answered from one authoritative source, not from the cells a single search happens to load. That source is the
derived plane itself: it was built by composing the national road network, and every corridor row was replicated
into each cell it intersects, which makes derived `road_component_id -> cells` exactly the closure relationship
the runtime needs.

Only components that span more than one cell are written: a single-cell component adds nothing to a closure, and
the region catalog's own validator requires at least two cells per entry. The output is deterministic, records the
derived fingerprint it was read from, and is rebuilt only when that fingerprint changes.
"""
import argparse
import glob
import hashlib
import json
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = Path(os.environ.get("ROADNATURALIST_BUILD_VOLUME", "/Volumes/Lexar/roadnaturalist"))
STEP_DEG = 0.2


def cell_bounds(identifier):
    x, y = (int(part[1:]) for part in identifier.split("_"))
    return [-180 + x * STEP_DEG, -90 + y * STEP_DEG, -180 + (x + 1) * STEP_DEG, -90 + (y + 1) * STEP_DEG]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=BUILD / "work/raw-closure")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    catalog = json.loads((ROOT / "data/national/derived-catalog.json").read_text())
    fingerprint = catalog["derived"]["analysisFingerprint"]
    root = BUILD / "cells/derived/corridor-metrics" / fingerprint / "cells"
    if not root.is_dir():
        raise SystemExit(f"the derived plane is not on this volume: {root}")
    args.out.mkdir(parents=True, exist_ok=True)
    closure_path = args.out / "components.jsonl"
    summary_path = args.out / "summary.json"
    if closure_path.exists() and not args.force:
        summary = json.loads(summary_path.read_text())
        if summary.get("analysisFingerprint") == fingerprint:
            print(f"closure is current for {fingerprint[:16]}: {summary['multiCellComponents']} components")
            return 0

    import duckdb

    files = sorted(path for path in glob.glob(str(root / "*.parquet")) if not os.path.basename(path).startswith("._"))
    quoted = ", ".join(f"'{path}'" for path in files)
    connection = duckdb.connect()
    print(f"reading {len(files):,} derived cells for component closure")
    rows = connection.execute(f"""
        SELECT DISTINCT road_component_id, regexp_extract(filename, '([^/]+)[.]parquet$', 1) AS cell,
               normalized_name
        FROM read_parquet([{quoted}], filename=true)
        WHERE road_component_id IS NOT NULL""").fetchall()
    cells = defaultdict(set)
    names = defaultdict(lambda: defaultdict(int))
    for component, cell, name in rows:
        cells[component].add(cell)
        if name:
            names[component][name] += 1
    multi = {component: sorted(value) for component, value in cells.items() if len(value) > 1}
    digest = hashlib.sha256()
    with closure_path.open("w") as handle:
        for component in sorted(multi):
            name_key = sorted(names[component].items(), key=lambda item: (-item[1], item[0]))[0][0] if names[component] else component
            bounds = [min(cell_bounds(cell)[0] for cell in multi[component]), min(cell_bounds(cell)[1] for cell in multi[component]),
                      max(cell_bounds(cell)[2] for cell in multi[component]), max(cell_bounds(cell)[3] for cell in multi[component])]
            line = json.dumps({"id": component, "nameKey": name_key, "cells": multi[component],
                               "bounds": [round(value, 6) for value in bounds]}, separators=(",", ":"))
            handle.write(line + "\n")
            digest.update(line.encode())
    payload = closure_path.read_bytes()
    summary = {"kind": "national-road-closure", "schemaVersion": 1,
               "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "analysisFingerprint": fingerprint, "derivedCells": len(files),
               "components": len(cells), "multiCellComponents": len(multi), "bytes": len(payload),
               "sha256": digest.hexdigest(),
               "cellsPerComponent": {"median": sorted(len(value) for value in cells.values())[len(cells) // 2],
                                     "max": max(len(value) for value in cells.values())}}
    summary_path.write_text(json.dumps(summary, indent=1) + "\n")
    print(f"{closure_path}: {len(multi):,} multi-cell components, {len(payload):,} bytes, SHA-256 {summary['sha256'][:16]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
