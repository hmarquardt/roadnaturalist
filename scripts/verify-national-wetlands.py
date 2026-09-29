#!/usr/bin/env python3
"""Verify NWI locks, checkpoints, identity decisions, cells, and manifest determinism."""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

import pyarrow.parquet as pq
from shapely import wkb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import national_wetlands as nw  # noqa: E402

LOCK_PATH = ROOT / "data/national/nwi-state-lock.json"
GRID_PATH = ROOT / "data/national/grid-conus-2025.json"
DEFAULT_WORK = ROOT / "data/national-wetlands-work"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--states", help="required completed state subset; default manifest builtStates")
    parser.add_argument("--require-all", action="store_true")
    args = parser.parse_args()
    lock = json.loads(LOCK_PATH.read_text())
    grid = json.loads(GRID_PATH.read_text())
    if lock.get("packageCount") != 49 or len(lock.get("packages", {})) != 49:
        raise ValueError("NWI source lock is not complete for 48 states plus DC")
    if any(len(entry.get("sha256", "")) != 64 or entry.get("bytes", 0) <= 0 for entry in lock["packages"].values()):
        raise ValueError("NWI source lock contains an invalid pin")
    border_report = json.loads((ROOT / "data/national/nwi-border-analysis.json").read_text())
    required_borders = {"OR/WA", "CA/OR", "NV/CA", "TX/LA", "FL/GA", "NY/NJ", "PA/OH"}
    if (border_report.get("canonicalKeyVersion") != nw.CANONICAL_KEY_VERSION
            or set(border_report.get("borders", {})) != required_borders):
        raise ValueError("NWI border regression report is missing or uses a stale canonical key")
    for label, border in border_report["borders"].items():
        if border.get("exactDuplicateCopies", 0) <= 0 or border.get("ambiguousRows", -1) < 0:
            raise ValueError(f"{label} border regression lacks measured duplicate/ambiguity counts")
    manifest_path = args.work / "artifacts" / "wetland-manifest.json"
    if not manifest_path.exists():
        raise ValueError("wetland manifest missing")
    manifest = json.loads(manifest_path.read_text())
    states = args.states.split(",") if args.states else manifest["builtStates"]
    if args.require_all and set(states) != set(lock["packages"]):
        raise ValueError(f"full build required; completed {len(states)}/49 states")
    if manifest["builtStates"] != sorted(states):
        raise ValueError("manifest built-state set differs")
    if len(manifest["cells"]) != len(grid["cells"]):
        raise ValueError("manifest does not declare the complete grid universe")
    if manifest["gridSha256"] != nw.sha256_file(GRID_PATH) or manifest["sourceLockSha256"] != nw.sha256_file(LOCK_PATH):
        raise ValueError("manifest source/grid pin mismatch")
    if manifest["pipelineVersion"] != nw.PIPELINE_VERSION or manifest["canonicalKeyVersion"] != nw.CANONICAL_KEY_VERSION:
        raise ValueError("manifest pipeline/key version mismatch")
    state_totals = {"raw": 0, "normalized": 0, "invalid": 0}
    for state in states:
        job_path = args.work / "jobs" / state / "state.json"
        if not job_path.exists():
            raise ValueError(f"{state} state checkpoint missing")
        job = json.loads(job_path.read_text())
        if job.get("state") != "complete" or job.get("sourceSha256") != lock["packages"][state]["sha256"]:
            raise ValueError(f"{state} state checkpoint stale")
        if not job["inspection"]["rtree"]:
            raise ValueError(f"{state} source lacks a spatial R-tree")
        chunks = sorted((args.work / "normalized" / state).glob("chunk-*.parquet"))
        if len(chunks) != job["chunks"]:
            raise ValueError(f"{state} chunk count mismatch")
        measured = 0
        for index, path in enumerate(chunks):
            checkpoint_path = args.work / "jobs" / state / f"chunk-{index:05d}.json"
            if not checkpoint_path.exists():
                raise ValueError(f"{state} chunk {index} checkpoint missing")
            checkpoint = json.loads(checkpoint_path.read_text())
            if (checkpoint.get("state") != "complete" or checkpoint.get("sourceSha256") != lock["packages"][state]["sha256"]
                    or checkpoint.get("pipelineVersion") != nw.PIPELINE_VERSION
                    or checkpoint.get("outputBytes") != path.stat().st_size
                    or checkpoint.get("outputSha256") != nw.sha256_file(path)
                    or checkpoint.get("outputCount") != pq.read_metadata(path).num_rows):
                raise ValueError(f"{state} chunk {index} checkpoint stale/corrupt")
            measured += checkpoint["outputCount"]
        if measured != job["normalizedFeatures"]:
            raise ValueError(f"{state} normalized row total mismatch")
        state_totals["raw"] += job["rawFeatures"]
        state_totals["normalized"] += job["normalizedFeatures"]
        state_totals["invalid"] += job["invalidGeometry"]
    identity = json.loads((args.work / "identity.json").read_text())
    if identity["states"] != sorted(states) or identity["rawFeatures"] != state_totals["normalized"]:
        raise ValueError("identity index differs from normalized checkpoints")
    if identity["dbSha256"] != nw.sha256_file(args.work / "identity.sqlite"):
        raise ValueError("identity checkpoint database digest mismatch")
    connection = sqlite3.connect(args.work / "identity.sqlite")
    mapped, canonical, duplicates, ambiguous = connection.execute(
        "SELECT count(*),sum(owner),sum(disposition='duplicate'),sum(disposition='ambiguous') FROM mapping").fetchone()
    connection.close()
    if mapped != identity["rawFeatures"] or canonical != identity["canonicalFeatures"] or duplicates != identity["duplicatePackageCopies"] or ambiguous != identity["ambiguousRows"]:
        raise ValueError("canonical identity statistics mismatch")
    present = empty = unbuilt = rows = bytes_total = 0
    for entry, grid_cell in zip(manifest["cells"], grid["cells"]):
        if entry["id"] != grid_cell["id"] or entry["bounds"] != grid_cell["bounds"]:
            raise ValueError("wetland cell ordering/bounds differ from the national grid")
        if entry["state"] == "present":
            present += 1
            path = args.work / "artifacts" / "wetlands" / f"{entry['id']}.parquet"
            if not path.exists() or path.stat().st_size != entry["bytes"] or nw.sha256_file(path) != entry["sha256"]:
                raise ValueError(f"{entry['id']} artifact missing/corrupt")
            metadata = pq.read_metadata(path)
            if metadata.num_rows != entry["storedRows"]:
                raise ValueError(f"{entry['id']} row count mismatch")
            schema = pq.read_schema(path)
            geo = json.loads((schema.metadata or {}).get(b"geo", b"{}"))
            if geo.get("primary_column") != "geometry" or geo.get("columns", {}).get("geometry", {}).get("geometry_types") != ["MultiPolygon"]:
                raise ValueError(f"{entry['id']} invalid GeoParquet geometry declaration")
            sample = pq.read_table(path, columns=["canonical_feature_id", "geometry"]).slice(0, 10).to_pylist()
            if any(not row["canonical_feature_id"] or wkb.loads(row["geometry"]).is_empty
                   or not wkb.loads(row["geometry"]).intersects(nw.box(*entry["bounds"])) for row in sample):
                raise ValueError(f"{entry['id']} invalid sample")
            rows += entry["storedRows"]
            bytes_total += entry["bytes"]
        elif entry["state"] == "empty": empty += 1
        elif entry["state"] == "unbuilt": unbuilt += 1
        else: raise ValueError(f"{entry['id']} unknown state {entry['state']}")
    expected = manifest["counts"]
    actual = {"present": present, "empty": empty, "unbuilt": unbuilt, "storedRows": rows, "artifactBytes": bytes_total}
    if any(expected[key] != value for key, value in actual.items()):
        raise ValueError(f"manifest totals differ: {actual}")
    encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n"
    if manifest_path.read_text() != encoded:
        raise ValueError("wetland manifest is not deterministically encoded")
    print(json.dumps({"ok": True, "packages": 49, "builtStates": len(states), "rawFeatures": state_totals["raw"],
                      "canonicalFeatures": canonical, "duplicates": duplicates, "ambiguous": ambiguous,
                      **actual, "invalidGeometry": state_totals["invalid"]}))


if __name__ == "__main__":
    main()
