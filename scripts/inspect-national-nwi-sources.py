#!/usr/bin/env python3
"""Inspect every pinned NWI GeoPackage sequentially with resumable schema records."""
import argparse
import importlib.machinery
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import national_wetlands as nw  # noqa: E402
builder = importlib.machinery.SourceFileLoader("national_nwi_builder_inspection", str(ROOT / "scripts/build-national-wetlands.py")).load_module()

LOCK = ROOT / "data/national/nwi-state-lock.json"
OUTPUT = ROOT / "data/national/nwi-source-schema.json"
DEFAULT_WORK = ROOT / "data/national-wetlands-work"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--states", help="comma-separated states; default all pinned states")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    lock = json.loads(LOCK.read_text())
    previous = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {"states": {}}
    states = dict(previous.get("states", {}))
    selected = args.states.split(",") if args.states else sorted(lock["packages"])
    if args.check:
        if set(states) != set(lock["packages"]):
            raise SystemExit(f"schema inventory is incomplete: {len(states)}/49")
        if any(states[state]["sourceSha256"] != lock["packages"][state]["sha256"] for state in states):
            raise SystemExit("schema inventory contains stale source digests")
        print(json.dumps({"states": len(states), "rawFeatures": sum(item["featureCount"] for item in states.values())}))
        return
    for state in selected:
        source = lock["packages"][state]
        if states.get(state, {}).get("sourceSha256") == source["sha256"]:
            print(f"{state}: inspected checkpoint reused", flush=True)
            continue
        normalized_jobs = [args.work / "jobs" / state / "state.json",
                           *(sorted((args.work / "samples").glob(f"*/jobs/{state}/state.json")))]
        normalized_job = next((path for path in normalized_jobs if path.exists()), None)
        if normalized_job:
            prior_job = json.loads(normalized_job.read_text())
            if prior_job.get("state") == "complete" and prior_job.get("sourceSha256") == source["sha256"]:
                inspection = prior_job["inspection"]
                states[state] = {"sourceSha256": source["sha256"], "sourceBytes": source["bytes"],
                                 "geoPackageBytes": source.get("memberBytes", source["uncompressedBytes"]),
                                 **{key: inspection[key] for key in ("layer", "geometryColumn", "geometryType", "srsId", "crs",
                                    "featureCount", "nullNwiId", "nullAttribute", "nullWetlandType", "rtree", "columns")},
                                 "sampleGeometryTypes": inspection.get("sampleGeometryTypes", []),
                                 "sampleInvalidGeometry": inspection.get("sampleInvalidGeometry"),
                                 "sampleEmptyGeometry": inspection.get("sampleEmptyGeometry"),
                                 "wallSeconds": prior_job["wallSeconds"], "inspectionSource": "normalized-state-checkpoint"}
                output = {"schemaVersion": 1, "kind": "fws-nwi-conus-source-schema-inventory",
                          "sourceLockSha256": nw.sha256_file(LOCK), "inspectedStates": len(states),
                          "rawFeatures": sum(item["featureCount"] for item in states.values()),
                          "states": dict(sorted(states.items()))}
                nw.atomic_json(OUTPUT, output)
                print(f"{state}: normalized schema checkpoint reused", flush=True)
                continue
        started = time.monotonic()
        archive = builder.fetch_package(state, source, args.work)
        gpkg = builder.extract_package(state, source, archive, args.work)
        inspection = builder.inspect_source(state, gpkg)
        states[state] = {"sourceSha256": source["sha256"], "sourceBytes": source["bytes"],
                         "geoPackageBytes": gpkg.stat().st_size,
                         **{key: inspection[key] for key in ("layer", "geometryColumn", "geometryType", "srsId", "crs",
                            "featureCount", "nullNwiId", "nullAttribute", "nullWetlandType", "rtree", "columns")},
                         "sampleGeometryTypes": inspection.get("sampleGeometryTypes", []),
                         "sampleInvalidGeometry": inspection.get("sampleInvalidGeometry"),
                         "sampleEmptyGeometry": inspection.get("sampleEmptyGeometry"),
                         "wallSeconds": round(time.monotonic() - started, 3)}
        output = {"schemaVersion": 1, "kind": "fws-nwi-conus-source-schema-inventory",
                  "sourceLockSha256": nw.sha256_file(LOCK), "inspectedStates": len(states),
                  "rawFeatures": sum(item["featureCount"] for item in states.values()),
                  "states": dict(sorted(states.items()))}
        nw.atomic_json(OUTPUT, output)
        gpkg.unlink(missing_ok=True)
        archive.unlink(missing_ok=True)
        print(json.dumps({"state": state, "features": inspection["featureCount"],
                          "seconds": states[state]["wallSeconds"]}), flush=True)


if __name__ == "__main__":
    main()
