#!/usr/bin/env python3
"""Verify all national component/segmentation buckets, identities, cell closure, and exact totals."""
import argparse
import hashlib
import itertools
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import tiger_sources as tiger  # noqa: E402


def verify(work):
    expected_pipeline = hashlib.sha256(''.join(tiger.sha256_of(ROOT / path) for path in (
        'scripts/segment-national-units.mjs', 'src/roads/normalize.js', 'src/discovery/segment.js'
    )).encode()).hexdigest()
    expected_component = hashlib.sha256(''.join(tiger.sha256_of(ROOT / path) for path in (
        'scripts/build-national-components.py', 'scripts/national_components.py',
        'scripts/road_components.py', 'scripts/tiger_sources.py', 'scripts/partition-national-roads.py'
    )).encode()).hexdigest()
    grid = json.loads((ROOT / "data/national/grid-conus-2025.json").read_text())
    cells = {cell["id"] for cell in grid["cells"]}
    directories = list((work / "components").glob("*/names.sqlite"))
    if len(directories) != 1:
        raise ValueError("expected one completed component source key")
    directory = directories[0].parent
    totals = Counter()
    largest = []
    for bucket in range(64):
        paths = [directory / f"{kind}-{bucket:02d}.jsonl" for kind in ("components", "segments")]
        jobs = [json.loads((directory / f"{kind}-{bucket:02d}.json").read_text()) for kind in ("components", "segments")]
        if jobs[0].get("pipelineSha256") != expected_component or jobs[1].get("componentPipelineSha256") != expected_component:
            raise ValueError(f"bucket {bucket} uses stale component semantics")
        if jobs[1].get("pipelineSha256") != expected_pipeline:
            raise ValueError(f"bucket {bucket} uses stale shared corridor composition/segmentation code")
        for path, job in zip(paths, jobs):
            if job["state"] != "complete" or not path.exists() or path.stat().st_size != job["bytes"] or tiger.sha256_of(path) != job["sha256"]:
                raise ValueError(f"bucket {bucket} missing, stale, or digest-mismatched: {path.name}")
        counts = Counter()
        last_key, index, group_count = None, 0, 0
        with paths[0].open() as components, paths[1].open() as segments:
            for component_line, segment_line in itertools.zip_longest(components, segments):
                if component_line is None or segment_line is None:
                    raise ValueError(f"bucket {bucket} component/segment row count differs")
                component = json.loads(component_line)
                segment = json.loads(segment_line)
                if component["id"] != segment["id"]:
                    raise ValueError(f"bucket {bucket} component/segment ID differs")
                if component["nameKey"] != last_key:
                    if last_key is not None and index != group_count:
                        raise ValueError(f"bucket {bucket} incomplete component-index sequence for {last_key}")
                    last_key, index, group_count = component["nameKey"], 0, component["componentCount"]
                    counts["names"] += 1
                index += 1
                if component["componentIndex"] != index or component["componentCount"] != group_count:
                    raise ValueError(f"bucket {bucket} unstable component index: {component['id']}")
                if component["featureCount"] != len(component["sourceFeatureIds"]) or component["featureCount"] != segment["sourceFeatureCount"]:
                    raise ValueError(f"bucket {bucket} source feature count mismatch: {component['id']}")
                if not component["cells"] or not set(component["cells"]) <= cells or component["lengthM"] <= 0:
                    raise ValueError(f"bucket {bucket} invalid cell closure/length: {component['id']}")
                if segment["corridorCount"] < 0 or segment["lengthM"] <= 0:
                    raise ValueError(f"bucket {bucket} invalid segment record: {component['id']}")
                counts["components"] += 1
                counts["namedFeatures"] += segment["sourceFeatureCount"]
                counts["multiCellComponents"] += len(component["cells"]) > 1
                counts["corridors"] += segment["corridorCount"]
                counts["eligibleUnits"] += segment["corridorCount"] > 0
                counts["droppedUnits"] += segment["corridorCount"] == 0
                counts["over500km"] += component["lengthM"] >= 500000
                counts["over1000km"] += component["lengthM"] >= 1000000
                counts["maxFeatureCount"] = max(counts["maxFeatureCount"], component["featureCount"])
                if component["lengthM"] >= 100000:
                    largest.append({"id": component["id"], "lengthM": component["lengthM"],
                                    "featureCount": component["featureCount"], "counties": component["counties"]})
        if last_key is not None and index != group_count:
            raise ValueError(f"bucket {bucket} incomplete final component-index sequence")
        # Raw named features include duplicates removed during composition, so that one count must come
        # from the source-index checkpoint. The component/segment rows agree on surviving features.
        for field in ("names", "components", "multiCellComponents"):
            if counts[field] != jobs[0]["counts"][field]:
                raise ValueError(f"bucket {bucket} {field} differs from component checkpoint")
        for field in ("components", "corridors", "eligibleUnits", "droppedUnits"):
            expected = jobs[1]["counts"]["units"] if field == "components" else jobs[1]["counts"][field]
            if counts[field] != expected:
                raise ValueError(f"bucket {bucket} {field} differs from segmentation checkpoint")
        totals.update({field: counts[field] for field in ("names", "components", "multiCellComponents", "corridors", "eligibleUnits", "droppedUnits")})
        totals["namedFeatures"] += jobs[0]["counts"]["namedFeatures"]
        totals["over500km"] += counts["over500km"]
        totals["over1000km"] += counts["over1000km"]
        totals["maxFeatureCount"] = max(totals["maxFeatureCount"], counts["maxFeatureCount"])
    largest.sort(key=lambda item: (-item["lengthM"], item["id"]))
    return {"kind": "national-road-index-verification", "sourceKey": directory.name, "counts": dict(totals),
            "largest": largest[:20], "componentBytes": sum((directory / f"components-{bucket:02d}.jsonl").stat().st_size for bucket in range(64)),
            "segmentationBytes": sum((directory / f"segments-{bucket:02d}.jsonl").stat().st_size for bucket in range(64))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=ROOT / "data/national-work")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = verify(args.work)
    print(json.dumps(result, separators=(",", ":") if args.json else None, indent=None if args.json else 2))


if __name__ == "__main__":
    main()
