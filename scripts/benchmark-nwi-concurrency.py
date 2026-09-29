#!/usr/bin/env python3
"""Compare 1/2/4 state workers on the same pinned small real NWI source set."""
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import national_wetlands as nw  # noqa: E402

SPEC = importlib.util.spec_from_file_location("nwi_builder_benchmark", ROOT / "scripts/build-national-wetlands.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)
STATES = ("CT", "DC", "DE", "RI")
BBOX = (-77.3, 38.65, -71.0, 42.2)
DEFAULT_WORK = ROOT / "data/national-wetlands-work/concurrency"
DEFAULT_REPORT = ROOT / "data/national/nwi-concurrency-benchmark.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--out", type=Path, default=DEFAULT_REPORT)
    args = parser.parse_args()
    lock = json.loads((ROOT / "data/national/nwi-state-lock.json").read_text())
    source_work = args.work / "source-cache"
    source_work.mkdir(parents=True, exist_ok=True)
    source_started = time.monotonic()
    for state in STATES:
        pin = lock["packages"][state]
        archive = builder.fetch_package(state, pin, source_work)
        builder.extract_package(state, pin, archive, source_work)
    source_seconds = round(time.monotonic() - source_started, 3)
    runs = []
    for workers in (1, 2, 4):
        work = args.work / f"workers-{workers}"
        marker = work / ".nwi-concurrency-work"
        if work.exists():
            if not marker.exists():
                raise ValueError(f"refusing to replace unmarked benchmark workspace {work}")
            shutil.rmtree(work)
        work.mkdir(parents=True)
        marker.write_text("Road Naturalist NWI concurrency benchmark\n")
        for state in STATES:
            pin = lock["packages"][state]
            for relative in (Path("sources") / pin["filename"], Path("extracted") / f"{state}.gpkg"):
                target = work / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                os.link(source_work / relative, target)
            checkpoint = work / "extracted" / f"{state}.json"
            checkpoint.write_bytes((source_work / "extracted" / f"{state}.json").read_bytes())
        started = time.monotonic()
        completed = subprocess.run([sys.executable, str(ROOT / "scripts/build-national-wetlands.py"),
                                    "--work", str(work), "--states", ",".join(STATES),
                                    "--workers", str(workers),
                                    "--bbox=" + ",".join(str(value) for value in BBOX)],
                                   cwd=ROOT, capture_output=True, text=True, check=True)
        final = json.loads(completed.stdout.strip().splitlines()[-1])
        runs.append({"workers": workers, "wallSeconds": round(time.monotonic() - started, 3), **final,
                     "stateNormalizedFeatures": {state: json.loads((work / "jobs" / state / "state.json").read_text())["normalizedFeatures"]
                                                 for state in STATES}})
        print(json.dumps(runs[-1]), flush=True)
    if len({tuple(sorted(run["stateNormalizedFeatures"].items())) for run in runs}) != 1:
        raise ValueError("concurrency changed source-row output counts")
    report = {"schemaVersion": 1, "kind": "nwi-worker-concurrency-benchmark",
              "states": list(STATES), "selectionBBox": list(BBOX),
              "sourceLockSha256": nw.sha256_file(ROOT / "data/national/nwi-state-lock.json"),
              "sourceCompressedBytes": sum(lock["packages"][state]["bytes"] for state in STATES),
              "sourcePreparationSeconds": source_seconds, "runs": runs}
    nw.atomic_json(args.out, report)
    print(json.dumps({"report": str(args.out), "runs": len(runs)}))


if __name__ == "__main__":
    main()
