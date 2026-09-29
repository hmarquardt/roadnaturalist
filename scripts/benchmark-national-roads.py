#!/usr/bin/env python3
"""Compile measured national road build checkpoints into a deterministic machine-readable benchmark."""
import argparse
import hashlib
import json
import zipfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data/national/road-build-benchmark.json"


def build(work):
    expected_segment_pipeline = hashlib.sha256(''.join(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in (
        'scripts/segment-national-units.mjs', 'src/roads/normalize.js', 'src/discovery/segment.js'
    )).encode()).hexdigest()
    expected_component_pipeline = hashlib.sha256(''.join(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in (
        'scripts/build-national-components.py', 'scripts/national_components.py',
        'scripts/road_components.py', 'scripts/tiger_sources.py', 'scripts/partition-national-roads.py'
    )).encode()).hexdigest()
    grid = json.loads((ROOT / "data/national/grid-conus-2025.json").read_text())
    first = json.loads((work / "benchmark-full.json").read_text())
    jobs = [json.loads((work / "jobs" / f"{county['fips']}.json").read_text()) for county in grid["counties"]]
    fragments = [json.loads((work / "fragment-jobs" / f"{county['fips']}.json").read_text()) for county in grid["counties"]]
    if any(job["state"] != "complete" for job in jobs + fragments):
        raise ValueError("national road benchmark needs every county and fragment checkpoint complete")
    manifest_path = work / "artifacts/road-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    directories = list((work / "components").glob("*/names.sqlite"))
    if len(directories) != 1:
        raise ValueError("component source index missing or ambiguous")
    directory = directories[0].parent
    components = [json.loads((directory / f"components-{bucket:02d}.json").read_text()) for bucket in range(64)]
    segments = [json.loads((directory / f"segments-{bucket:02d}.json").read_text()) for bucket in range(64)]
    if any(job["state"] != "complete" for job in components + segments):
        raise ValueError("component/segment benchmark needs all 64 buckets complete")
    if any(job.get("pipelineSha256") != expected_segment_pipeline for job in segments):
        raise ValueError("national road benchmark refuses stale segmentation checkpoints")
    if any(job.get("pipelineSha256") != expected_component_pipeline for job in components):
        raise ValueError("national road benchmark refuses stale component checkpoints")
    if any(job.get("componentPipelineSha256") != expected_component_pipeline for job in segments):
        raise ValueError("national road benchmark refuses segmentation from stale components")
    total = lambda values, key: sum(item[key] for item in values)
    source_records = 0
    for county in grid["counties"]:
        fips = county["fips"]
        with zipfile.ZipFile(work / "sources" / f"tl_2025_{fips}_roads.zip") as archive:
            with archive.open(f"tl_2025_{fips}_roads.dbf") as dbf:
                source_records += int.from_bytes(dbf.read(8)[4:8], "little")
    counts = {"sourceRecords": source_records, "normalizedRows": total(jobs, "rows"),
              "eligibleS1200S1400Rows": sum(job["classes"]["S1200"] + job["classes"]["S1400"] for job in jobs),
              "namedEligibleRows": sum(job["counts"]["namedFeatures"] for job in components),
              "components": sum(job["counts"]["components"] for job in components),
              "multiCellComponents": sum(job["counts"]["multiCellComponents"] for job in components),
              "eligibleUnits": sum(job["counts"]["eligibleUnits"] for job in segments),
              "droppedUnits": sum(job["counts"]["droppedUnits"] for job in segments),
              "corridors": sum(job["counts"]["corridors"] for job in segments),
              "cells": manifest["counts"]["cells"], "populatedCells": manifest["counts"]["present"],
              "emptyCells": manifest["counts"]["empty"], "replicatedRoadRows": manifest["counts"]["replicatedRows"]}
    bytes_ = {"sourceZips": total(jobs, "sourceBytes"), "normalizedGeoParquet": total(jobs, "outputBytes"),
              "countyCellFragments": sum(entry["bytes"] for job in fragments for entry in job["fragments"].values()),
              "roadCells": manifest["counts"]["artifactBytes"], "localRoadManifest": manifest_path.stat().st_size,
              "componentIndex": total(components, "bytes"), "segmentIndex": total(segments, "bytes")}
    times = {"normalizationFirstPassSeconds": first["wallSeconds"],
             "countyFragmentWorkSeconds": round(total(fragments, "wallSeconds"), 3),
             "componentBucketWorkSeconds": round(total(components, "wallSeconds"), 3),
             "exactSegmentationBucketWorkSeconds": round(total(segments, "wallSeconds"), 3),
             "cellCompactionSeconds": None, "networkDownloadSeconds": None}
    segment_distribution = Counter()
    length_bands = Counter()
    for job in segments:
        segment_distribution.update(job["counts"]["segmentCountDistribution"])
        length_bands.update(job["counts"]["lengthBands"])
    return {"schemaVersion": 1, "kind": "national-road-build-benchmark", "machine": "2026-09-28/29 local macOS development machine",
            "workers": 2, "sourceVintage": "TIGER2025", "counties": len(jobs), "counts": counts, "bytes": bytes_,
            "segmentation": {"maxSegmentCount": max(job["counts"]["maxSegmentCount"] for job in segments),
                             "segmentCountDistribution": dict(segment_distribution), "lengthBandsM": dict(length_bands)},
            "time": times, "throughput": {"normalizedRowsPerFirstPassSecond": round(counts["normalizedRows"]/first["wallSeconds"], 1),
                        "sourceZipBytesPerFirstPassSecond": round(bytes_["sourceZips"]/first["wallSeconds"], 1)},
            "resourceObservations": {"workspaceKiBObserved": 28569260,
                                     "normalizationRSSKiBObserved": 726960, "normalizationCpuPercentObserved": 113.2,
                                     "peakRAMMeasured": False, "peakDiskMeasured": False},
            "measurementLimits": "First pass included a cached HTML Census response for county 54039, recovered separately. Network download and cell compaction times were not isolated; RSS/CPU values are observed snapshots, not peaks."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=ROOT / "data/national-work")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content = json.dumps(build(args.work), sort_keys=True, separators=(",", ":")) + "\n"
    if args.check:
        if not OUT.exists() or OUT.read_text() != content:
            raise SystemExit("national road benchmark differs from completed checkpoints")
    else:
        OUT.write_text(content)
    print(content)


if __name__ == "__main__":
    main()
