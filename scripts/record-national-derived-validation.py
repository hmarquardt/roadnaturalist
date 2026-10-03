#!/usr/bin/env python3
"""Record the national derived build's representative-shard validation from its own checkpoints.

    uv run --python 3.12 python3 scripts/record-national-derived-validation.py [--out ...]

Writes data/national/derived-validation.json: every validation shard with its measured corridors, rows,
cells and wall time, the six required ecological/geographic conditions, and a pointer to the standalone
regional-equivalence record. Nothing here is hand-entered.
"""
import argparse
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = Path("/Volumes/Lexar/roadnaturalist/work/derived-national")
CONDITIONS = {
    "Pacific Northwest": ["sx-123_sy45", "sx-124_sy45"],
    "Northeast": ["sx-75_sy40"],
    "Gulf/Southeast": ["sx-83_sy27"],
    "Midwest/Great Lakes": ["sx-94_sy44"],
    "arid Southwest": ["sx-113_sy33"],
    "Great Plains": ["sx-98_sy39"],
}
# The regional window the published Oregon/south-west Washington derived plane covers.
REGIONAL_WINDOW = ["sx-125_sy44", "sx-125_sy45", "sx-125_sy46", "sx-124_sy44", "sx-124_sy45",
                   "sx-124_sy46", "sx-123_sy44", "sx-123_sy45", "sx-123_sy46"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--report", type=Path, default=ROOT / "data/national/derived-validation.json")
    args = parser.parse_args()
    equivalence_path = ROOT / "data/national/derived-regional-equivalence.json"
    equivalence = json.loads(equivalence_path.read_text()) if equivalence_path.exists() else None
    seen = {}
    for identifier in sorted({entry for values in CONDITIONS.values() for entry in values} | set(REGIONAL_WINDOW)):
        path = args.out / "metrics" / f"shard-{identifier}.json"
        checkpoint = json.loads(path.read_text())
        if checkpoint.get("state") != "complete":
            raise SystemExit(f"validation shard {identifier} is {checkpoint.get('state')}")
        seen[identifier] = {"corridors": checkpoint["corridors"], "rows": checkpoint["rows"],
                            "cellsTouched": len(checkpoint.get("cellsTouched", {})),
                            "chunks": checkpoint.get("chunks", 0), "refused": checkpoint.get("refused", 0),
                            "duplicateRepairs": checkpoint.get("duplicateRepairs", 0),
                            "wallSeconds": checkpoint["wallSeconds"],
                            "secondsPerCorridor": round(checkpoint["wallSeconds"] / checkpoint["corridors"], 4)
                            if checkpoint["corridors"] else None}
    corridors = sum(entry["corridors"] for entry in seen.values())
    wall = sum(entry["wallSeconds"] for entry in seen.values())
    measured = [entry for identifier, entry in seen.items()
                if identifier not in REGIONAL_WINDOW or entry["corridors"]]
    report = {
        "kind": "national-derived-representative-validation",
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "conditions": {name: [identifier for identifier in shards] for name, shards in CONDITIONS.items()},
        "regionalWindowShards": REGIONAL_WINDOW,
        "shards": seen,
        "measuredCorridors": corridors,
        "measuredWallSeconds": round(wall, 1),
        "weightedSecondsPerCorridor": round(wall / corridors, 4) if corridors else None,
        "regionalEquivalence": equivalence and {
            "ok": equivalence["ok"], "sharedIds": equivalence["sharedIds"],
            "compared": equivalence["fullCoverageCompared"],
            "excludedDifferentFeatures": equivalence["excludedDifferentFeatures"],
            "failures": equivalence["failures"],
            "fields": equivalence["fields"], "categorical": equivalence["categorical"]},
        "note": "Validation shards are deliberately diverse and dense-biased; the weighted rate is an upper "
                "reference for the national projection, not an average. Every shard here is reused by the "
                "national run, never rebuilt.",
    }
    args.report.write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps({key: report[key] for key in ("measuredCorridors", "measuredWallSeconds",
                                                   "weightedSecondsPerCorridor")}, indent=1))
    print(f"wrote {args.report}")


if __name__ == "__main__":
    main()
