#!/usr/bin/env python3
"""Freeze compact, deterministic publish catalogs after road cells, components, and segments validate."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import tiger_sources as tiger  # noqa: E402

VERSION = "tiger2025-county-v1"
OUT = ROOT / "data/national"


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"


def build(work):
    expected_segment_pipeline = hashlib.sha256(''.join(tiger.sha256_of(ROOT / path) for path in (
        'scripts/segment-national-units.mjs', 'src/roads/normalize.js', 'src/discovery/segment.js'
    )).encode()).hexdigest()
    expected_component_pipeline = hashlib.sha256(''.join(tiger.sha256_of(ROOT / path) for path in (
        'scripts/build-national-components.py', 'scripts/national_components.py',
        'scripts/road_components.py', 'scripts/tiger_sources.py', 'scripts/partition-national-roads.py'
    )).encode()).hexdigest()
    grid = json.loads((OUT / "grid-conus-2025.json").read_text())
    lock = OUT / "tiger2025-county-lock.json"
    local = json.loads((work / "artifacts/road-manifest.json").read_text())
    if local["counts"]["cells"] != grid["counts"]["cells"] or local["gridSha256"] != tiger.sha256_of(OUT / "grid-conus-2025.json"):
        raise ValueError("local road manifest does not match the pinned CONUS grid")
    cells = []
    for entry in local["cells"]:
        compact = {field: entry[field] for field in ("id", "bounds", "state", "featureCount")}
        if entry["state"] == "present":
            compact.update({field: entry[field] for field in ("url", "bytes", "sha256")})
        cells.append(compact)
    directories = list((work / "components").glob("*/names.sqlite"))
    if len(directories) != 1:
        raise ValueError("expected exactly one completed national component source digest")
    directory = directories[0].parent
    source_key = directory.name
    component_parts, segment_parts = [], []
    for bucket in range(64):
        for kind, parts in (("components", component_parts), ("segments", segment_parts)):
            checkpoint = directory / f"{kind}-{bucket:02d}.json"
            artifact = directory / f"{kind}-{bucket:02d}.jsonl"
            if not checkpoint.exists() or not artifact.exists():
                raise ValueError(f"{kind} bucket {bucket} missing")
            job = json.loads(checkpoint.read_text())
            if job["state"] != "complete" or job["inputSha256"][:16] != source_key:
                raise ValueError(f"{kind} bucket {bucket} is stale/incomplete")
            if kind == "segments" and job.get("pipelineSha256") != expected_segment_pipeline:
                raise ValueError(f"segment bucket {bucket} has stale shared semantics")
            if kind == "components" and job.get("pipelineSha256") != expected_component_pipeline:
                raise ValueError(f"component bucket {bucket} has stale shared semantics")
            if kind == "segments" and job.get("componentPipelineSha256") != expected_component_pipeline:
                raise ValueError(f"segment bucket {bucket} has stale component semantics")
            if artifact.stat().st_size != job["bytes"] or tiger.sha256_of(artifact) != job["sha256"]:
                raise ValueError(f"{kind} bucket {bucket} digest mismatch")
            parts.append({"bucket": bucket, "url": f"national/roads/{VERSION}/{kind}/{kind}-{bucket:02d}.jsonl",
                          "bytes": job["bytes"], "sha256": job["sha256"], "counts": job["counts"]})
    component_counts = {name: sum(part["counts"].get(name, 0) for part in component_parts)
                        for name in ("names", "namedFeatures", "components", "multiCellComponents")}
    segment_counts = {name: sum(part["counts"].get(name, 0) for part in segment_parts)
                      for name in ("units", "eligibleUnits", "droppedUnits", "corridors", "totalLengthM", "eligibleLengthM")}
    if component_counts["components"] != segment_counts["units"]:
        raise ValueError("component and exact segmentation unit totals differ")
    components = {"schemaVersion": 1, "kind": "national-road-components", "version": VERSION,
                  "sourceKey": source_key, "counts": component_counts, "buckets": component_parts}
    segments = {"schemaVersion": 1, "kind": "national-road-segments", "version": VERSION,
                "sourceKey": source_key, "algorithm": "src/roads/normalize.js + src/discovery/segment.js",
                "counts": segment_counts, "buckets": segment_parts}
    roads = {"schemaVersion": 1, "kind": "national-roads", "version": VERSION,
             "coverage": grid["coverage"], "bounds": grid["bounds"], "gridSha256": local["gridSha256"],
             "sourceLockSha256": tiger.sha256_of(lock), "source": local["source"],
             "pipelineVersion": local["pipelineVersion"], "partitionScheme": grid["partitionScheme"],
             "schema": local["schema"], "counts": local["counts"],
             "componentManifestUrl": f"national/roads/{VERSION}/component-manifest.json",
             "segmentationManifestUrl": f"national/roads/{VERSION}/segmentation-manifest.json",
             "cells": cells}
    return {"road-manifest.json": roads, "component-manifest.json": components,
            "segmentation-manifest.json": segments}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=ROOT / "data/national-work")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    values = build(args.work)
    for name, value in values.items():
        path = OUT / name
        content = encoded(value)
        if args.check:
            if not path.exists() or path.read_text() != content:
                raise SystemExit(f"{name} differs from completed local artifacts")
        else:
            path.write_text(content)
        print(json.dumps({"path": str(path), "bytes": len(content), "sha256": tiger.sha256_of(path)}))


if __name__ == "__main__":
    main()
