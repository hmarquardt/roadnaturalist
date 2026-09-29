#!/usr/bin/env python3
"""Freeze a machine-readable summary of measured national NWI work."""
import argparse
import json
import sqlite3
import statistics
import tempfile
from pathlib import Path

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "data/national-wetlands-work"
OUTPUT = ROOT / "data/national/nwi-build-benchmark.json"


def build(work):
    lock = json.loads((ROOT / "data/national/nwi-state-lock.json").read_text())
    manifest = json.loads((work / "artifacts/wetland-manifest.json").read_text())
    identity = json.loads((work / "identity.json").read_text())
    jobs = [json.loads((work / "jobs" / state / "state.json").read_text()) for state in manifest["builtStates"]]
    partition_timings = json.loads((work / "partition-benchmark.json").read_text()) if (work / "partition-benchmark.json").exists() else {}
    sizes = sorted(entry["bytes"] for entry in manifest["cells"] if entry["state"] == "present")
    percentile = lambda fraction: sizes[min(len(sizes)-1, round((len(sizes)-1)*fraction))] if sizes else 0
    # A partial slice can normalize features outside its publishable cells. Count
    # distinct IDs actually stored in present cells before calling this replication.
    with tempfile.TemporaryDirectory(prefix="nwi-benchmark-", dir=work) as temporary:
        connection = sqlite3.connect(Path(temporary) / "ids.sqlite")
        connection.execute("PRAGMA journal_mode=OFF")
        connection.execute("PRAGMA synchronous=OFF")
        connection.execute("CREATE TABLE ids(id TEXT PRIMARY KEY) WITHOUT ROWID")
        for entry in manifest["cells"]:
            if entry["state"] != "present":
                continue
            column = pq.read_table(work / "artifacts" / "wetlands" / f"{entry['id']}.parquet",
                                   columns=["canonical_feature_id"]).column(0).to_pylist()
            connection.executemany("INSERT OR IGNORE INTO ids VALUES(?)", ((value,) for value in column))
        unique_grid = connection.execute("SELECT count(*) FROM ids").fetchone()[0]
        connection.close()
    return {"schemaVersion": 1, "kind": "national-wetlands-build-benchmark",
            "source": {"packagesPinned": lock["packageCount"], "compressedBytes": lock["totalBytes"],
                       "builtPackages": len(jobs), "builtCompressedBytes": sum(lock["packages"][state]["bytes"] for state in manifest["builtStates"])},
            "features": {"raw": sum(job["rawFeatures"] for job in jobs), "normalized": sum(job["normalizedFeatures"] for job in jobs),
                         "canonical": identity["canonicalFeatures"], "duplicates": identity["duplicatePackageCopies"],
                         "ambiguous": identity["ambiguousRows"]},
            "cells": {**manifest["counts"], "uniqueStoredFeatures": unique_grid,
                      "medianBytes": int(statistics.median(sizes)) if sizes else 0,
                      "p95Bytes": percentile(.95), "largestBytes": max(sizes) if sizes else 0,
                      "replicationRatio": round(manifest["counts"]["storedRows"] / unique_grid, 6) if unique_grid else 0},
            "timings": {"stateNormalizationSeconds": round(sum(job["wallSeconds"] for job in jobs), 3),
                        "fetchSeconds": round(sum(job.get("fetchSeconds", 0) for job in jobs), 3),
                        "extractSeconds": round(sum(job.get("extractSeconds", 0) for job in jobs), 3),
                        "inspectSeconds": round(sum(job.get("inspectSeconds", 0) for job in jobs), 3),
                        "normalizeSeconds": round(sum(job.get("normalizeSeconds", 0) for job in jobs), 3),
                        **partition_timings},
            "resources": {"workersDefault": 1, "workersMaximum": 4, "peakRss": None, "peakCpu": None}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=WORK)
    parser.add_argument("--out", type=Path, default=OUTPUT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    result = build(args.work)
    content = json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n"
    if args.check:
        if not args.out.exists() or args.out.read_text() != content:
            raise SystemExit("national wetlands benchmark differs")
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(content)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
