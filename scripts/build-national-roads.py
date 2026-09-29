#!/usr/bin/env python3
"""Resumable TIGER2025 county-road normalization; `--counties` bounds an incremental run.

County ZIPs are the source unit because the published national Roads geodatabase does not carry county
provenance. The shared regional reader and normalization are used unchanged. This stage deliberately does
not publish a national manifest: global connected components and cell compaction require every county.
"""
import argparse
import concurrent.futures
import importlib.util
import json
import sys
import time
import urllib.request
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import tiger_sources as tiger  # noqa: E402

PIPELINE_VERSION = "conus-roads-normalize-v1"
GRID = ROOT / "data/national/grid-conus-2025.json"
DEFAULT_WORK = ROOT / "data/national-work"
LOCK = ROOT / "data/national/tiger2025-county-lock.json"
SOURCE_LOCK = json.loads(LOCK.read_text())["counties"] if LOCK.exists() else None


def retry_url(url, attempt, locked_sha):
    if attempt == 0:
        return url
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query))
    # A Census CDN rejection has sometimes been cached as a 200 HTML response. The immutable source
    # lock still decides whether a retry is acceptable; the query only asks the CDN for a fresh copy.
    query["rn_retry"] = f"{locked_sha[:12] if locked_sha else 'unlocked'}-{attempt}"
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def imported(file):
    spec = importlib.util.spec_from_file_location("national_road_reader", ROOT / "scripts" / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")
    temporary.replace(path)


def valid_output(job, archive, output):
    return (job.get("pipelineVersion") == PIPELINE_VERSION and job.get("state") == "complete"
            and archive.exists() and output.exists() and archive.stat().st_size == job.get("sourceBytes")
            and tiger.sha256_of(archive) == job.get("sourceSha256")
            and output.stat().st_size == job.get("outputBytes")
            and tiger.sha256_of(output) == job.get("outputSha256"))


def run_county(county, work, download):
    fips = county["fips"]
    archive = work / "sources" / f"tl_2025_{fips}_roads.zip"
    output = work / "normalized" / f"{fips}.parquet"
    checkpoint = work / "jobs" / f"{fips}.json"
    job = json.loads(checkpoint.read_text()) if checkpoint.exists() else {"countyFips": fips, "state": "pending"}
    locked = SOURCE_LOCK.get(fips) if SOURCE_LOCK is not None else None
    if SOURCE_LOCK is not None and locked is None:
        raise ValueError(f"county {fips} is absent from the committed national source lock")
    if valid_output(job, archive, output) and (locked is None or
            (job.get("sourceSha256") == locked["sha256"] and job.get("sourceBytes") == locked["bytes"])):
        return {"countyFips": fips, "state": "skipped", "reason": "validated checkpoint", "rows": job["rows"],
                "sourceBytes": job["sourceBytes"], "outputBytes": job["outputBytes"]}
    started = time.monotonic()
    job = {"countyFips": fips, "pipelineVersion": PIPELINE_VERSION, "state": "running", "sourceUrl": county["sourceUrl"]}
    atomic_json(checkpoint, job)
    try:
        archive.parent.mkdir(parents=True, exist_ok=True)
        if not archive.exists() or not zipfile.is_zipfile(archive):
            if not download:
                raise FileNotFoundError(f"{archive} missing or not a ZIP; use --download")
            temporary = archive.with_suffix(".zip.part")
            for attempt in range(5):
                urllib.request.urlretrieve(retry_url(county["sourceUrl"], attempt,
                                                     locked["sha256"] if locked else None), temporary)
                if zipfile.is_zipfile(temporary):
                    temporary.replace(archive)
                    break
                if attempt == 4:
                    raise ValueError(f"{fips} source returned non-ZIP bytes after five attempts")
                time.sleep(min(2 ** attempt, 8))
        source_sha = tiger.sha256_of(archive)
        if locked is not None and (source_sha != locked["sha256"] or archive.stat().st_size != locked["bytes"]):
            raise ValueError(f"county {fips} differs from the committed national source lock")
        # Existing regional pins remain authoritative. A republished archive is not silently adopted.
        if fips in tiger.COUNTIES and source_sha != tiger.COUNTIES[fips][2]:
            raise ValueError(f"county {fips} differs from the pinned regional source")
        tiger.COUNTIES[fips] = (county["name"], archive.name, source_sha)
        reader = imported("build-road-network.py")
        reader.NETWORK_BBOX = (-180, -90, 180, 90)
        tally = {"excludedClasses": {}, "outsideWindow": 0, "degenerate": 0}
        rows = reader.read_county(fips, archive, tally)
        if not rows:
            raise ValueError(f"county {fips} produced no eligible road rows")
        temporary = output.with_suffix(".parquet.tmp")
        output.parent.mkdir(parents=True, exist_ok=True)
        tiger.write_geoparquet(rows, temporary)
        temporary.replace(output)
        job.update({"state": "complete", "sourceSha256": source_sha, "sourceBytes": archive.stat().st_size,
                    "outputSha256": tiger.sha256_of(output), "outputBytes": output.stat().st_size,
                    "rows": len(rows), "eligibleNamedRows": sum(bool(row["name"]) and row["road_class"] in ("S1200", "S1400") for row in rows),
                    "classes": {key: sum(row["road_class"] == key for row in rows) for key in sorted(reader.EXTRACT_CLASSES)},
                    "excludedClasses": tally["excludedClasses"], "wallSeconds": round(time.monotonic()-started, 3)})
        atomic_json(checkpoint, job)
        return {"countyFips": fips, "state": "complete", "rows": len(rows), "sourceBytes": job["sourceBytes"],
                "outputBytes": job["outputBytes"], "wallSeconds": job["wallSeconds"]}
    except Exception as error:
        job.update({"state": "failed", "error": str(error), "wallSeconds": round(time.monotonic()-started, 3)})
        atomic_json(checkpoint, job)
        return {"countyFips": fips, "state": "failed", "error": str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--counties", help="comma-separated county FIPS; default is all CONUS counties")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--report", type=Path, help="write the complete machine-readable county benchmark")
    args = parser.parse_args()
    if args.workers < 1 or args.workers > 8:
        parser.error("workers must be between 1 and 8")
    grid = json.loads(GRID.read_text())
    requested = set(args.counties.split(",")) if args.counties else {item["fips"] for item in grid["counties"]}
    counties = [item for item in grid["counties"] if item["fips"] in requested]
    if {item["fips"] for item in counties} != requested:
        parser.error("unknown or non-CONUS county FIPS")
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        outcomes = list(pool.map(lambda county: run_county(county, args.work, args.download), counties))
    report = {"kind": "national-road-normalization-benchmark", "pipelineVersion": PIPELINE_VERSION,
              "workers": args.workers, "requestedCounties": len(counties), "wallSeconds": round(time.monotonic()-started, 3),
              "sourceBytes": sum(item.get("sourceBytes", 0) for item in outcomes),
              "outputBytes": sum(item.get("outputBytes", 0) for item in outcomes),
              "rows": sum(item.get("rows", 0) for item in outcomes),
              "states": {state: sum(item["state"] == state for item in outcomes) for state in ("complete", "skipped", "failed")},
              "results": outcomes}
    if args.report:
        atomic_json(args.report, report)
        print(json.dumps({key: value for key, value in report.items() if key != "results"}, separators=(",", ":")))
    else:
        print(json.dumps(report, separators=(",", ":") if args.json else None, indent=None if args.json else 2))
    if report["states"]["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
