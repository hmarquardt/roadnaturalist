#!/usr/bin/env python3
"""Measure the finished national derived corridor-metrics plane from its own artifacts.

    uv run --python 3.12 --with pyarrow python3 scripts/measure-national-derived.py [--out ...] [--final ...]

Writes data/national/derived-benchmark.json (committed) and prints the measured table. Nothing here is an
estimate: every number is read from the finalized manifest, the shard checkpoints and the build volume.
"""
import argparse
import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = Path("/Volumes/Lexar/roadnaturalist")


def disk_usage(path):
    import shutil
    usage = shutil.disk_usage(path)
    return {"total": usage.total, "used": usage.used, "free": usage.free}


def directory_bytes(path):
    total = 0
    files = 0
    for item in Path(path).rglob("*"):
        if item.is_file() and not item.name.startswith("."):
            total += item.stat().st_size
            files += 1
    return total, files


def percentile(values, fraction):
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(fraction * (len(ordered) - 1))))
    return ordered[index]


def chain_wall_seconds(out):
    log = Path(out) / "logs/chain.log"
    if not log.exists():
        return None
    stamps = []
    for line in log.read_text().splitlines():
        token = line.split(" ", 1)[0]
        try:
            stamps.append(time.mktime(time.strptime(token, "%Y-%m-%dT%H:%M:%SZ")))
        except ValueError:
            continue
    return round(max(stamps) - min(stamps), 1) if len(stamps) > 1 else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    default_out = BUILD / "work/derived-national"
    default_final = BUILD / "cells/derived/corridor-metrics"
    parser.add_argument("--out", type=Path, default=default_out)
    parser.add_argument("--final", type=Path, default=default_final)
    parser.add_argument("--report", type=Path, default=ROOT / "data/national/derived-benchmark.json")
    args = parser.parse_args()

    index = json.loads((args.out / "corridors/index.json").read_text())
    manifest_path = next(iter(sorted(args.final.rglob("manifest.json"))), None)
    if manifest_path is None:
        raise SystemExit(f"no final manifest under {args.final}")
    manifest = json.loads(manifest_path.read_text())
    fingerprint = manifest["analysisFingerprint"]
    present = [cell for cell in manifest["cells"] if cell["state"] == "present"]
    sizes = [cell["bytes"] for cell in present]
    rows = [cell["rowCount"] for cell in present]
    stored_rows = sum(cell["rowCount"] for cell in manifest["cells"])
    total_bytes = sum(cell.get("bytes", 0) for cell in manifest["cells"])
    shard_wall = 0.0
    shard_count = 0
    metrics_bytes = 0
    parts_bytes = 0
    for path in (args.out / "metrics").glob("shard-*.json"):
        checkpoint = json.loads(path.read_text())
        if checkpoint.get("state") != "complete":
            continue
        shard_count += 1
        shard_wall += checkpoint.get("wallSeconds", 0)
        metrics_bytes += (checkpoint.get("metrics") or {}).get("bytes", 0)
        parts_bytes += (checkpoint.get("parts") or {}).get("bytes", 0)
    result = {
        "kind": "national-derived-corridor-metrics-measurement",
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "analysisFingerprint": fingerprint,
        "sourcePlanes": {plane: {"version": entry.get("version"), "manifestSha256": entry.get("manifestSha256")}
                         for plane, entry in (manifest.get("provenance") or {}).items()},
        "corridors": index["corridors"],
        "derivedRawCandidateRows": index["corridors"],
        "storedRows": stored_rows,
        "replicatedRows": stored_rows - index["corridors"],
        "presentCells": len(present),
        "emptyCells": len(manifest["cells"]) - len(present),
        "cellBytes": total_bytes,
        "manifestBytes": manifest_path.stat().st_size,
        "totalDerivedArtifactBytes": total_bytes + manifest_path.stat().st_size,
        "cellSize": {"median": statistics.median(sizes) if sizes else 0,
                     "p95": percentile(sizes, 0.95), "max": max(sizes) if sizes else 0,
                     "min": min(sizes) if sizes else 0},
        "cellRows": {"median": statistics.median(rows) if rows else 0,
                     "p95": percentile(rows, 0.95), "max": max(rows) if rows else 0},
        "bytesPerStoredRow": round(total_bytes / stored_rows, 1) if stored_rows else 0,
        "corridorIndexBytes": index["bytes"],
        "corridorIndexSha256": index["corridorsSha256"],
        "metricsParquetBytes": metrics_bytes,
        "cellPartsParquetBytes": parts_bytes,
        "shardsComplete": shard_count,
        "shardWorkSeconds": round(shard_wall, 1),
        "chainWallSeconds": chain_wall_seconds(args.out),
        "lexar": disk_usage(BUILD),
        "finalPlaneDirectory": str(manifest_path.parent),
    }
    args.report.write_text(json.dumps(result, indent=1) + "\n")
    print(json.dumps(result, indent=1))
    print(f"wrote {args.report}")


if __name__ == "__main__":
    main()
