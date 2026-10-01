#!/usr/bin/env python3
"""Measure the national hydrography plane, and compare it with the projections it replaces.

    python3 scripts/measure-national-hydro.py --work /Volumes/Lexar/roadnaturalist/work/nhd

Writes a machine-readable report to `data/national/hydro-build-benchmark.json`. Layer counts come from the unit
checkpoints (which record each unit's flowline and polygon rows) rather than from re-reading every artifact, so
the measurement is exact and cheap. Filesystem allocation is reported alongside logical bytes because the build
volume is ExFAT with a 262,144-byte allocation block, which rounds every small file up.
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_volume as bv  # noqa: E402
import national_hydro as nh  # noqa: E402

MANIFEST_PATH = ROOT / "data/national/hydro-manifest.json"
LOCK_PATH = ROOT / "data/national/nhd-hr-hu8-lock.json"
REPORT_PATH = ROOT / "data/national/hydro-build-benchmark.json"
DEFAULT_WORK = bv.work_dir("nhd", ROOT / "data/national-hydro-work")
ALLOCATION_BLOCK = 262144
# The three projections this run replaces: a row-proportional extrapolation from the 38-unit plane, a
# source-proportional one from compressed source bytes, and the projection implied by the observed compaction
# rate during the repaired national finalize.
PROJECTION_ROW_PROPORTIONAL = 164 * 10 ** 9
PROJECTION_SOURCE_PROPORTIONAL = 215 * 10 ** 9
PROJECTION_COMPACTION = 190 * 10 ** 9


def directory_usage(path):
    """Logical and allocated bytes, plus the small-file count that ExFAT's allocation block makes expensive."""
    logical = allocated = files = sidecars = 0
    if not path.is_dir():
        return {"logicalBytes": 0, "allocatedBytes": 0, "files": 0, "sidecars": 0}
    for entry in path.rglob("*"):
        if not entry.is_file():
            continue
        size = entry.stat().st_size
        if entry.name.startswith("."):
            sidecars += 1
            allocated += ALLOCATION_BLOCK
            continue
        files += 1
        logical += size
        allocated += ((size + ALLOCATION_BLOCK - 1) // ALLOCATION_BLOCK) * ALLOCATION_BLOCK
    return {"logicalBytes": logical, "allocatedBytes": allocated, "files": files, "sidecars": sidecars}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    args = parser.parse_args()
    manifest = json.loads(MANIFEST_PATH.read_text())
    lock = json.loads(LOCK_PATH.read_text())
    counts = manifest["counts"]
    cells = manifest["cells"]
    present = [cell for cell in cells if cell["state"] == "present"]
    sizes = sorted(cell["bytes"] for cell in present)
    percentile = (lambda fraction: sizes[min(len(sizes) - 1, int(len(sizes) * fraction))]) if sizes else (lambda _: 0)
    largest = max(present, key=lambda cell: cell["bytes"]) if present else None
    flowlines = waterbodies = 0
    for unit in manifest["builtUnits"]:
        checkpoint = args.work / "jobs" / f"{unit}.json"
        if checkpoint.exists():
            stats = json.loads(checkpoint.read_text()).get("stats", {})
            flowlines += stats.get("lines", 0)
            waterbodies += stats.get("polygons", 0)
    usage = {name: directory_usage(args.work / name) for name in
             ("sources", "normalized", "fragments", "artifacts", "partition-jobs", "jobs", "coverage", "extracted")}
    total = directory_usage(args.work)
    replication = round(counts["storedRows"] / counts["canonicalFeatures"], 6) if counts["canonicalFeatures"] else None
    ratio_row = round(counts["artifactBytes"] / PROJECTION_ROW_PROPORTIONAL, 3)
    ratio_source = round(counts["artifactBytes"] / PROJECTION_SOURCE_PROPORTIONAL, 3)
    ratio_compaction = round(counts["artifactBytes"] / PROJECTION_COMPACTION, 3)
    distances = {"row-proportional": abs(1 - ratio_row), "source-proportional": abs(1 - ratio_source),
                 "compaction-rate": abs(1 - ratio_compaction)}
    report = {
        "kind": "national-hydro-build-benchmark", "schemaVersion": 1,
        "version": manifest["version"], "buildCoverage": manifest["buildCoverage"],
        "canonicalKeyVersion": manifest["canonicalKeyVersion"], "pipelineVersion": manifest["pipelineVersion"],
        "compactVersion": nh.COMPACT_VERSION,
        "units": {"pinned": lock["unitCount"], "built": len(manifest["builtUnits"]),
                  "conus": manifest.get("conusUnits"), "unpinned": manifest.get("unpinnedConusUnits"),
                  "sourceBytes": lock["totalBytes"]},
        "features": {"rawRows": counts["rawRows"], "canonicalFeatures": counts["canonicalFeatures"],
                     "duplicatePackageCopies": counts["duplicatePackageCopies"],
                     "ambiguousRows": counts["ambiguousRows"], "flowlines": flowlines, "waterbodies": waterbodies},
        "cells": {"declared": counts["cells"], "present": counts["present"], "typedEmpty": counts["empty"],
                  "unbuilt": counts["unbuilt"], "storedRows": counts["storedRows"],
                  "replicationFactor": replication, "medianBytes": percentile(0.5), "p95Bytes": percentile(0.95),
                  "largestBytes": sizes[-1] if sizes else 0,
                  "largestCellId": largest["id"] if largest else None,
                  "largestCellBounds": largest["bounds"] if largest else None,
                  "over10MB": sum(1 for size in sizes if size > 10 * 1024 ** 2),
                  "over20MB": sum(1 for size in sizes if size > 20 * 1024 ** 2),
                  "over50MB": sum(1 for size in sizes if size > 50 * 1024 ** 2)},
        "bytes": {"artifactBytes": counts["artifactBytes"], "manifestBytes": MANIFEST_PATH.stat().st_size,
                  "lockBytes": LOCK_PATH.stat().st_size},
        "workspace": {"total": total, "byDirectory": usage,
                      "sourceCacheBytes": usage["sources"]["logicalBytes"],
                      "checkpointAndWorkBytes": usage["normalized"]["logicalBytes"]
                                                + usage["partition-jobs"]["logicalBytes"]
                                                + usage["jobs"]["logicalBytes"] + usage["fragments"]["logicalBytes"]},
        "projections": {"rowProportionalBytes": PROJECTION_ROW_PROPORTIONAL,
                        "sourceProportionalBytes": PROJECTION_SOURCE_PROPORTIONAL,
                        "compactionProjectionBytes": PROJECTION_COMPACTION,
                        "actualBytes": counts["artifactBytes"], "rowProportionalRatio": ratio_row,
                        "sourceProportionalRatio": ratio_source, "compactionRatio": ratio_compaction,
                        "closer": min(distances, key=distances.get)
                        if manifest["buildCoverage"] == "complete" else None,
                        "distanceFromActual": distances if manifest["buildCoverage"] == "complete" else None},
    }
    REPORT_PATH.write_text(json.dumps(report, indent=1, sort_keys=True) + "\n")
    print(json.dumps(report, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
