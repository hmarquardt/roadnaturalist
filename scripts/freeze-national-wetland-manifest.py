#!/usr/bin/env python3
"""Commit a compact deterministic index for the measured national NWI build boundary."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "data/national-wetlands-work"
OUTPUT = ROOT / "data/national/wetland-manifest.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=WORK)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    source = json.loads((args.work / "artifacts/wetland-manifest.json").read_text())
    cells = []
    for entry in source["cells"]:
        compact = {"id": entry["id"], "bounds": entry["bounds"], "state": entry["state"]}
        if entry["state"] == "present":
            compact.update({key: entry[key] for key in ("featureCount", "storedRows", "url", "bytes", "sha256")})
        elif entry["state"] == "empty":
            compact.update({"featureCount": 0, "storedRows": 0})
        cells.append(compact)
    source["cells"] = cells
    encoded = json.dumps(source, sort_keys=True, separators=(",", ":")) + "\n"
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != encoded:
            raise SystemExit("committed wetland manifest differs from measured local build")
    else:
        OUTPUT.write_text(encoded)
    print(json.dumps({"path": str(OUTPUT), "bytes": len(encoded), "coverage": source["buildCoverage"],
                      "builtStates": len(source["builtStates"]), **source["counts"]}))


if __name__ == "__main__":
    main()
