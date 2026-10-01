#!/usr/bin/env python3
"""Prove the national wetland plane answers the queries its real consumers ask.

Two things read this plane. `scripts/build-derived.py` builds a `wetland_all` view with
`row_number() OVER (PARTITION BY source_feature_id)` and drops every row whose number is not 1, and
`src/gis/service.js` uses `wetlands: 'source_feature_id'` as the dataset's sole source key. So a plane whose
rows lack `source_feature_id`, or whose `source_feature_id` is not unique per feature, breaks both of them
without failing any structural check: the columns exist, the row counts agree, and the consumer silently
collapses distinct features into one.

So this check does not ask whether a query returns rows. It asks whether the *published* plane is the same set of
features as the source it was compacted from, using each cell's own fragments as the expectation:

  * a representative dense cell, a sparse cell and a mid cell: published rows must equal the number of distinct
    canonical features the fragments offer, and every published `source_feature_id` must be unique and
    well-formed;
  * the runtime's bounds-prefilter shape must return what the cell contains;
  * a sample of cells the manifest declares typed-empty must have no fragments and no artifact.

    python3 scripts/check-wetland-consumers.py --work /Volumes/Lexar/roadnaturalist/work/nwi
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_volume as bv  # noqa: E402
import duckdb  # noqa: E402
import national_wetlands as nw  # noqa: E402

DEFAULT_WORK = bv.work_dir("nwi", ROOT / "data/national-wetlands-work")
# The runtime's shaped vocabulary: what discovery-query.js selects out of the wetland source.
RUNTIME_COLUMNS = ("source_feature_id", "attribute", "wetland_type", "min_lon", "min_lat", "max_lon", "max_lat")
MAX_PARTS = 200


def fragment_index(work):
    """Every fragment a partition checkpoint declares, by cell, as its validated digest (path, sha256)."""
    index = defaultdict(list)
    for state_dir in sorted(path for path in (work / "partition-jobs").glob("*/*.json") if bv.is_data_file(path)):
        job = json.loads(state_dir.read_text())
        if job.get("state") != "complete":
            continue
        for cell, item in job["fragments"].items():
            index[cell].append(item)
    return index


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    args = parser.parse_args()
    manifest = json.loads((args.work / "artifacts" / "wetland-manifest.json").read_text())
    if manifest.get("buildCoverage") != "complete":
        raise SystemExit(f"the plane is {manifest.get('buildCoverage')}: run this check against a complete plane")
    declared_schema = [field["name"] for field in manifest["schema"]]
    missing = [name for name in RUNTIME_COLUMNS if name not in declared_schema]
    if missing:
        raise SystemExit(f"the published schema lacks what the runtime and derived build select: {missing}")
    artifact_dir = args.work / "artifacts" / "wetlands"
    index = fragment_index(args.work)
    connection = duckdb.connect()

    present = [cell for cell in manifest["cells"] if cell["state"] == "present"]
    typed_empty = [cell for cell in manifest["cells"] if cell["state"] == "empty"]
    if not present:
        raise SystemExit("the manifest declares no present cell")
    # Dense, sparse and middle: a cell the plane is biggest on, the smallest one it published, and the median by
    # bytes. Sparse cells are where a single lost row hides most easily behind a large dense cell's totals.
    by_size = sorted(present, key=lambda cell: cell["bytes"])
    chosen = [by_size[-1], by_size[len(by_size) // 2], by_size[0]]

    results = []
    for entry in chosen:
        cell_id = entry["id"]
        parts = [item for item in index.get(cell_id, []) if (args.work / item["path"]).exists()]
        if len(parts) > MAX_PARTS:
            raise SystemExit(f"{cell_id}: {len(parts)} fragment parts exceeds the bounded check")
        files = [str(args.work / item["path"]) for item in parts]
        artifact = artifact_dir / f"{cell_id}.parquet"
        if not artifact.exists():
            raise SystemExit(f"{cell_id}: declared present but has no artifact")
        source_rows, source_features = (connection.execute(
            "SELECT count(*), count(DISTINCT canonical_feature_id) FROM read_parquet(?)", [files]).fetchone()
            if files else (0, 0))
        published = connection.execute(
            "SELECT count(*), count(DISTINCT source_feature_id), count(DISTINCT canonical_feature_id) "
            f"FROM read_parquet('{artifact}')").fetchone()
        if published[0] != source_features:
            raise SystemExit(f"{cell_id}: published {published[0]} rows against {source_features} distinct "
                             f"canonical source features offered by its {len(parts)} fragments")
        if published[0] != entry["storedRows"]:
            raise SystemExit(f"{cell_id}: published {published[0]} rows against {entry['storedRows']} declared")
        # The dedupe key must be unique per feature, or the derived build's PARTITION BY source_feature_id
        # collapses distinct features and undercounts without any structural check noticing.
        if published[1] != published[0] or published[2] != published[0]:
            raise SystemExit(f"{cell_id}: source_feature_id is not a unique per-feature key "
                             f"(rows {published[0]}, distinct ids {published[1]}, distinct canonicals {published[2]})")
        # The runtime asks with a bounds prefilter; over the cell's own bounds it must return the same rows.
        west, south, east, north = entry["bounds"]
        prefilt = connection.execute(
            f"SELECT count(*) FROM read_parquet('{artifact}') WHERE min_lon <= {east} AND max_lon >= {west} "
            f"AND min_lat <= {north} AND max_lat >= {south}").fetchone()[0]
        if prefilt != published[0]:
            raise SystemExit(f"{cell_id}: runtime bounds prefilter returned {prefilt} of {published[0]} rows")
        vocabulary = set(connection.execute(
            f"SELECT DISTINCT system_label FROM read_parquet('{artifact}')").fetchall())
        results.append({"cell": cell_id, "fragmentParts": len(parts), "sourceRows": source_rows,
                        "sourceFeatures": source_features, "publishedRows": published[0],
                        "uniqueSourceIds": published[1], "systemLabels": sorted(label for (label,) in vocabulary)})

    # A cell the manifest calls typed-empty must have neither fragments nor an artifact: "empty" is a claim about
    # the source, and it is the claim a consumer relies on when it renders nothing.
    for entry in typed_empty[:5]:
        cell_id = entry["id"]
        if index.get(cell_id):
            raise SystemExit(f"{cell_id}: declared typed-empty but its fragments declare {len(index[cell_id])} parts")
        if (artifact_dir / f"{cell_id}.parquet").exists():
            raise SystemExit(f"{cell_id}: declared typed-empty but has an artifact")
    connection.close()
    print(json.dumps({"checked": True, "cells": results, "typedEmptySample": min(len(typed_empty), 5),
                      "declaredPresent": len(present), "declaredEmpty": len(typed_empty)}, indent=1))


if __name__ == "__main__":
    main()
