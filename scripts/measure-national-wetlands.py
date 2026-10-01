#!/usr/bin/env python3
"""Measure the national NWI wetlands plane, and replace the extrapolated size estimate with a real one.

    python3 scripts/measure-national-wetlands.py --work /Volumes/Lexar/roadnaturalist/work/nwi

Writes `data/national/wetland-build-benchmark.json`. Raw, canonical, duplicate and ambiguous counts come from the
identity report the partitioner wrote (it is derived from every normalized row, so it is the measurement rather
than an extrapolation), and the cell distribution comes from the manifest. Workspace usage is reported as logical
*and* ExFAT-allocated bytes, because the build volume rounds every small file up to a 262,144-byte block and the
wetland fragment layout - one file per state, chunk and cell - is many small files.
"""
import argparse
import json
import shutil
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_volume as bv  # noqa: E402

MANIFEST_PATH = ROOT / "data/national/wetland-manifest.json"
LOCK_PATH = ROOT / "data/national/nwi-state-lock.json"
INVENTORY_PATH = ROOT / "data/national/nwi-source-schema.json"
REPORT_PATH = ROOT / "data/national/wetland-build-benchmark.json"
DEFAULT_WORK = bv.work_dir("nwi", ROOT / "data/national-wetlands-work")
ALLOCATION_BLOCK = 262144
# The estimate this measurement replaces: a crude extrapolation from the AZ/DC plane.
EXTRAPOLATED_BYTES = 500 * 10 ** 9


def directory_usage(path):
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
    inventory = json.loads(INVENTORY_PATH.read_text())
    counts = manifest["counts"]
    present = [cell for cell in manifest["cells"] if cell["state"] == "present"]
    sizes = sorted(cell["bytes"] for cell in present)
    percentile = (lambda fraction: sizes[min(len(sizes) - 1, int(len(sizes) * fraction))]) if sizes else (lambda _: 0)
    largest = max(present, key=lambda cell: cell["bytes"]) if present else None
    identity = {}
    identity_path = args.work / "identity.json"
    if identity_path.exists():
        raw = json.loads(identity_path.read_text())
        identity = {"rawRows": raw.get("rawFeatures"), "canonicalFeatures": raw.get("canonicalFeatures"),
                    "duplicatePackageCopies": raw.get("duplicatePackageCopies"),
                    "ambiguousRows": raw.get("ambiguousRows"), "blankIdRows": raw.get("blankIdRows")}
    usage = {name: directory_usage(args.work / name) for name in
             ("sources", "normalized", "fragments", "artifacts", "partition-jobs", "jobs", "extracted", "samples")}
    replication = round(counts["storedRows"] / counts["canonicalFeatures"], 6) if counts["canonicalFeatures"] else None
    # Ambiguous rows are retained as published features, so the interesting number is how many *groups* of them
    # there are: one collision between two packages is a different fact from two hundred scattered ones.
    ambiguous_groups = None
    database = args.work / "identity.sqlite"
    if database.exists():
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        ambiguous_groups = connection.execute(
            "SELECT count(DISTINCT canonical_key) FROM mapping WHERE disposition='ambiguous'").fetchone()[0]
        connection.close()
    # Bytes per published row is the figure a future estimate should be built from, since it comes from this
    # complete plane rather than from an extrapolation of a partial one.
    stored = counts["storedRows"] or 1
    volume = shutil.disk_usage(args.work if args.work.exists() else ROOT)
    report = {
        "kind": "national-wetland-build-benchmark", "schemaVersion": 1,
        "version": manifest["version"], "buildCoverage": manifest["buildCoverage"],
        "canonicalKeyVersion": manifest["canonicalKeyVersion"], "pipelineVersion": manifest["pipelineVersion"],
        "states": {"pinned": len(lock["packages"]), "built": len(manifest["builtStates"]),
                   "sourcePackages": lock["packageCount"], "sourceBytes": lock["totalBytes"],
                   "inventoryRawRows": inventory.get("rawFeatures")},
        "features": {"rawRows": identity.get("rawRows"), "canonicalFeatures": identity.get("canonicalFeatures"),
                     "duplicatePackageCopies": identity.get("duplicatePackageCopies"),
                     "ambiguousRows": identity.get("ambiguousRows"), "ambiguousGroups": ambiguous_groups,
                     "blankIdRows": identity.get("blankIdRows"),
                     "bytesPerPublishedRow": round(counts["artifactBytes"] / stored, 1),
                     "bytesPerCanonicalFeature": round(counts["artifactBytes"] / max(1, counts["canonicalFeatures"]), 1)},
        "cells": {"declared": counts["cells"], "present": counts["present"], "typedEmpty": counts["empty"],
                  "unbuilt": counts["unbuilt"], "storedRows": counts["storedRows"], "replicationFactor": replication,
                  "medianBytes": percentile(0.5), "p95Bytes": percentile(0.95),
                  "largestBytes": sizes[-1] if sizes else 0,
                  "largestCellId": largest["id"] if largest else None,
                  "over10MB": sum(1 for size in sizes if size > 10 * 1024 ** 2),
                  "over20MB": sum(1 for size in sizes if size > 20 * 1024 ** 2),
                  "over50MB": sum(1 for size in sizes if size > 50 * 1024 ** 2)},
        "bytes": {"artifactBytes": counts["artifactBytes"], "manifestBytes": MANIFEST_PATH.stat().st_size,
                  "lockBytes": LOCK_PATH.stat().st_size},
        "workspace": {"total": directory_usage(args.work), "byDirectory": usage,
                      "sourceCacheBytes": usage["sources"]["logicalBytes"],
                      "checkpointAndWorkBytes": usage["normalized"]["logicalBytes"]
                                                + usage["fragments"]["logicalBytes"]
                                                + usage["jobs"]["logicalBytes"]
                                                + usage["partition-jobs"]["logicalBytes"]},
        "volume": {"totalBytes": volume.total, "usedBytes": volume.used, "freeBytes": volume.free},
        "projections": {"extrapolatedBytes": EXTRAPOLATED_BYTES, "actualBytes": counts["artifactBytes"],
                        "ratio": round(counts["artifactBytes"] / EXTRAPOLATED_BYTES, 3),
                        "obsolete": manifest["buildCoverage"] == "complete"},
    }
    REPORT_PATH.write_text(json.dumps(report, indent=1, sort_keys=True) + "\n")
    print(json.dumps(report, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
