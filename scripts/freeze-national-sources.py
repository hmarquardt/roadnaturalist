#!/usr/bin/env python3
"""Freeze or verify every CONUS TIGER2025 county ZIP digest from completed local checkpoints."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GRID = ROOT / "data/national/grid-conus-2025.json"
LOCK = ROOT / "data/national/tiger2025-county-lock.json"


def build(work):
    grid = json.loads(GRID.read_text())
    counties = {}
    for county in grid["counties"]:
        fips = county["fips"]
        path = work / "jobs" / f"{fips}.json"
        if not path.exists():
            raise ValueError(f"{fips} has no completed source checkpoint")
        job = json.loads(path.read_text())
        if job.get("state") != "complete":
            raise ValueError(f"{fips} source job is {job.get('state')}")
        counties[fips] = {"sha256": job["sourceSha256"], "bytes": job["sourceBytes"]}
    return {"schemaVersion": 1, "kind": "tiger2025-conus-county-road-archives", "countyCount": len(counties),
            "totalBytes": sum(entry["bytes"] for entry in counties.values()), "counties": counties}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=ROOT / "data/national-work")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content = json.dumps(build(args.work), sort_keys=True, separators=(",", ":")) + "\n"
    if args.check:
        if not LOCK.exists() or LOCK.read_text() != content:
            raise SystemExit("national TIGER source lock differs from completed checkpoints")
    else:
        LOCK.write_text(content)
    print(json.dumps({"path": str(LOCK), "bytes": len(content), "countyCount": json.loads(content)["countyCount"]}))


if __name__ == "__main__":
    main()
