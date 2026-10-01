#!/usr/bin/env python3
"""Prove the runtime consumer predicate works against the national hydro plane.

The last semantic bug in this plane was a `layer` value the application never asks for: the plane published
`NHDFlowline`/`NHDWaterbody` while every runtime query filters on `flowline`/`waterbody`. Inspecting the schema
would not have caught it, so this check runs the *actual* predicate the browser runs
(`src/gis/discovery-query.js`, `src/gis/habitat-query.js`) over representative national cells and requires real
rows back.

What "representative" means is decided by the source, not by the test. A perfectly valid cell can hold flowlines
and no waterbody, so requiring both layers in every chosen cell asserts something untrue about geography; instead
this check finds, from the fragments that feed the compaction, one cell whose source rows contain flowlines and
one whose source rows contain waterbodies, and requires the published plane to serve each of those layers. It
also requires the published feature count to equal the number of distinct canonical features in the source for
that cell and layer - the compaction dedupes exactly on that key, so anything else means rows were lost, dropped
or invented.

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


def units_per_cell(work):
    """Which units replicate into each cell, from the partition checkpoints: a shared cell is only complete
    when every unit that covers it is counted."""
    mapping = {}
    for path in (work / "partition-jobs").glob("*.json"):
        if not bv.is_data_file(path):
            continue
        record = json.loads(path.read_text())
        for cell_id in record["cells"]:
            mapping.setdefault(cell_id, []).append(record["unit"])
    return mapping


def source_features(work, connection, units, cell_id, layer):
    """Distinct canonical features the fragments offer for one cell and source layer."""
    files = [str(work / "fragments" / f"{unit}.parquet") for unit in sorted(units)]
    files = [path for path in files if Path(path).exists()]
    if not files:
        return None
    query = "SELECT count(DISTINCT feature) FROM read_parquet(?) WHERE cell = ? AND layer = ?"
    return connection.execute(query, [files, cell_id, layer]).fetchone()[0] if files else None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    args = parser.parse_args()
    manifest = json.loads(MANIFEST_PATH.read_text())
    # A partial plane's cells are not evidence about the published plane: the pilot's cells were compacted from a
    # subset of the units that cover them, so a runtime predicate over them can fail for reasons that have
    # nothing to do with the layer vocabulary or the plane that will actually be served.
    if manifest.get("buildCoverage") != "complete":
        raise SystemExit(f"the plane is {manifest.get('buildCoverage')}: run this check against a complete plane")
    present = {cell["id"] for cell in manifest["cells"] if cell["state"] == "present"}
    covering = units_per_cell(args.work)
    connection = duckdb.connect()
    vocabulary = set(nh.PUBLISHED_LAYER.values())

    results, found = [], {"flowline": None, "waterbody": None}
    for unit in PREFERRED_UNITS:
        fragment = args.work / "fragments" / f"{unit}.parquet"
        if not fragment.exists():
            continue
        for source_layer, published_layer in nh.PUBLISHED_LAYER.items():
            if found[published_layer] is not None:
                continue
            cells = [row[0] for row in connection.execute(
                "SELECT cell FROM read_parquet(?) WHERE layer = ? GROUP BY cell ORDER BY cell",
                [str(fragment), source_layer]).fetchall()]
            chosen = next((cell_id for cell_id in cells if cell_id in present), None)
            if chosen is None:
                continue
            artifact = args.work / "artifacts" / "hydro" / f"{chosen}.parquet"
            if not artifact.exists():
                raise SystemExit(f"{chosen}: declared present but no artifact")
            # The runtime predicate verbatim: the value the application filters on.
            counts = dict(connection.execute(
                f"SELECT layer, count(*) FROM read_parquet('{artifact}') GROUP BY layer").fetchall())
            unexpected = sorted(set(counts) - vocabulary)
            if unexpected:
                raise SystemExit(f"{chosen}: published layer values outside the runtime vocabulary: {unexpected}")
            families = dict(connection.execute(
                f"SELECT layer, count(*) FROM read_parquet('{artifact}')"
                " WHERE layer IN ('flowline','waterbody') GROUP BY layer"
                " HAVING sum(CASE WHEN (layer='flowline' AND ST_GeometryType(geometry) <> 'MultiLineString')"
                " OR (layer='waterbody' AND ST_GeometryType(geometry) <> 'MultiPolygon') THEN 1 ELSE 0 END) > 0"
            ).fetchall())
            if families:
                raise SystemExit(f"{chosen}: layer/geometry family mismatch: {families}")
            expected = source_features(args.work, connection, covering.get(chosen, [unit]), chosen, source_layer)
            published = counts.get(published_layer, 0)
            if not published:
                raise SystemExit(f"{chosen}: runtime predicate layer='{published_layer}' returned no rows "
                                 f"though the source carries {expected} distinct features")
            if expected is not None and published != expected:
                raise SystemExit(f"{chosen}: published {published} {published_layer} rows against {expected} "
                                 "distinct source features for the same cell")
            found[published_layer] = chosen
            results.append({"unit": unit, "cell": chosen, "sourceLayer": source_layer,
                            "publishedLayer": published_layer, "sourceFeatures": expected,
                            "publishedRows": published, "layersPresent": sorted(counts)})
    missing = [layer for layer, cell_id in found.items() if cell_id is None]
    if missing:
        raise SystemExit(f"no representative cell was found serving {missing} from the source data")
    connection.close()
    print(json.dumps({"checked": True, "cells": results}, indent=1))


if __name__ == "__main__":
    main()
