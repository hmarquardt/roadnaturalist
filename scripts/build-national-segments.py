#!/usr/bin/env python3
"""Replay every national connected component through the shared JavaScript segmentation implementation."""
import argparse
import hashlib
import json
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import tiger_sources as tiger  # noqa: E402
import national_components  # noqa: E402
from importlib.machinery import SourceFileLoader

components = SourceFileLoader("component_jobs", str(ROOT / "scripts/build-national-components.py")).load_module()
roads = SourceFileLoader("road_jobs_for_segments", str(ROOT / "scripts/build-national-roads.py")).load_module()
SEGMENTER = ROOT / "scripts/segment-national-units.mjs"


def build_bucket(conn, directory, bucket, input_sha):
    output = directory / f"segments-{bucket:02d}.jsonl"
    checkpoint = directory / f"segments-{bucket:02d}.json"
    # Imported shared semantics are part of the checkpoint key. A fix to composition or segmentation
    # must invalidate every affected bucket even if this wrapper script is unchanged.
    pipeline_sha = hashlib.sha256(''.join(tiger.sha256_of(path) for path in (
        SEGMENTER, ROOT / 'src/roads/normalize.js', ROOT / 'src/discovery/segment.js'
    )).encode()).hexdigest()
    component_sha = hashlib.sha256(''.join(tiger.sha256_of(ROOT / path) for path in (
        'scripts/build-national-components.py', 'scripts/national_components.py',
        'scripts/road_components.py', 'scripts/tiger_sources.py', 'scripts/partition-national-roads.py'
    )).encode()).hexdigest()
    previous = json.loads(checkpoint.read_text()) if checkpoint.exists() else {}
    if (previous.get("state") == "complete" and previous.get("inputSha256") == input_sha
            and previous.get("pipelineSha256") == pipeline_sha
            and previous.get("componentPipelineSha256") == component_sha and output.exists()
            and output.stat().st_size == previous.get("bytes") and tiger.sha256_of(output) == previous.get("sha256")):
        return previous
    roads.atomic_json(checkpoint, {"state": "running", "bucket": bucket, "inputSha256": input_sha,
                                 "pipelineSha256": pipeline_sha, "componentPipelineSha256": component_sha})
    started = time.monotonic()
    temporary = output.with_suffix(".jsonl.tmp")
    process = subprocess.Popen(["node", str(SEGMENTER), str(temporary)], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=None, text=True, bufsize=1)
    sent = 0
    try:
        for key, group in components.each_name(conn, bucket):
            indexed = national_components.component_index(group, key, key.replace("-", " "), include_lines=True)
            for unit in indexed:
                payload = {"id": unit["id"], "name": unit["name"], "sourceLines": unit["sourceLines"]}
                process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
                sent += 1
        process.stdin.close()
        summary = process.stdout.read()
        if process.wait() != 0:
            raise ValueError(f"shared JS segmenter failed for bucket {bucket}")
        counts = json.loads(summary)
        if counts["units"] != sent:
            raise ValueError(f"segmenter unit count mismatch: sent {sent}, got {counts['units']}")
        temporary.replace(output)
        result = {"state": "complete", "bucket": bucket, "inputSha256": input_sha, "pipelineSha256": pipeline_sha,
                  "componentPipelineSha256": component_sha,
                  "bytes": output.stat().st_size, "sha256": tiger.sha256_of(output), "counts": counts,
                  "wallSeconds": round(time.monotonic()-started, 3)}
        roads.atomic_json(checkpoint, result)
        return result
    except Exception as error:
        if process.poll() is None:
            process.kill()
            process.wait()
        roads.atomic_json(checkpoint, {"state": "failed", "bucket": bucket, "inputSha256": input_sha,
                                     "pipelineSha256": pipeline_sha, "componentPipelineSha256": component_sha,
                                     "error": str(error)})
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=roads.DEFAULT_WORK)
    parser.add_argument("--bucket", type=int)
    args = parser.parse_args()
    input_sha, counties = components.source_key(args.work)
    conn, directory = components.build_index(args.work, input_sha, counties)
    selected = [args.bucket] if args.bucket is not None else range(components.BUCKETS)
    totals = Counter()
    for bucket in selected:
        if not 0 <= bucket < components.BUCKETS:
            parser.error("bucket must be 0..63")
        result = build_bucket(conn, directory, bucket, input_sha)
        totals.update({key: value for key, value in result["counts"].items()
                       if isinstance(value, (int, float)) and key != "maxSegmentCount"})
        totals["maxSegmentCount"] = max(totals["maxSegmentCount"], result["counts"]["maxSegmentCount"])
        print(json.dumps({"bucket": bucket, "counts": result["counts"], "wallSeconds": result["wallSeconds"]}), flush=True)
    print(json.dumps({"inputSha256": input_sha, "totals": dict(totals), "directory": str(directory)}))


if __name__ == "__main__":
    main()
