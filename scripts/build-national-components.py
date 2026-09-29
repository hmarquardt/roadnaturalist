#!/usr/bin/env python3
"""Build name-scoped national connected components with a resumable SQLite name index and 64 output jobs."""
import argparse
import hashlib
import json
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import pyarrow.parquet as pq
from shapely import wkb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import tiger_sources as tiger  # noqa: E402
import national_components  # noqa: E402
from importlib.machinery import SourceFileLoader

roads = SourceFileLoader("national_road_jobs", str(ROOT / "scripts/build-national-roads.py")).load_module()
partitions = SourceFileLoader("national_partitions", str(ROOT / "scripts/partition-national-roads.py")).load_module()
BUCKETS = 64


def pipeline_sha():
    # The SQLite name index and output buckets depend on these shared rules, not just on county bytes.
    return hashlib.sha256(''.join(tiger.sha256_of(ROOT / path) for path in (
        'scripts/build-national-components.py', 'scripts/national_components.py',
        'scripts/road_components.py', 'scripts/tiger_sources.py',
        'scripts/partition-national-roads.py'
    )).encode()).hexdigest()


def source_key(work):
    grid = json.loads(roads.GRID.read_text())
    hashes = []
    for county in grid["counties"]:
        fips = county["fips"]
        path = work / "jobs" / f"{fips}.json"
        if not path.exists():
            raise ValueError(f"national components need all counties: {fips} pending")
        job = json.loads(path.read_text())
        if job["state"] != "complete":
            raise ValueError(f"national components need all counties: {fips} {job['state']}")
        hashes.append(f"{fips}:{job['outputSha256']}")
    return hashlib.sha256("\n".join(hashes).encode()).hexdigest(), [county["fips"] for county in grid["counties"]]


def build_index(work, input_sha, counties):
    directory = work / "components" / input_sha[:16]
    directory.mkdir(parents=True, exist_ok=True)
    database = directory / "names.sqlite"
    conn = sqlite3.connect(database)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("CREATE TABLE IF NOT EXISTS roads(bucket INTEGER, name_key TEXT, name TEXT, county_fips TEXT, source_feature_id TEXT, geometry BLOB)")
    conn.execute("CREATE TABLE IF NOT EXISTS completed(county_fips TEXT PRIMARY KEY, output_sha TEXT, row_count INTEGER)")
    conn.execute("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    stored_pipeline = conn.execute("SELECT value FROM metadata WHERE key='pipelineSha256'").fetchone()
    completed_count = conn.execute("SELECT count(*) FROM completed").fetchone()[0]
    if completed_count and (stored_pipeline is None or stored_pipeline[0] != pipeline_sha()):
        # Source shards remain valid. Invalidate only the indexed/component stages when their code changes.
        with conn:
            conn.execute("DELETE FROM roads")
            conn.execute("DELETE FROM completed")
            conn.execute("INSERT OR REPLACE INTO metadata VALUES ('pipelineSha256', ?)", (pipeline_sha(),))
    elif stored_pipeline is None:
        with conn:
            conn.execute("INSERT INTO metadata VALUES ('pipelineSha256', ?)", (pipeline_sha(),))
    done = dict(conn.execute("SELECT county_fips, output_sha FROM completed"))
    for fips in counties:
        output = work / "normalized" / f"{fips}.parquet"
        job = json.loads((work / "jobs" / f"{fips}.json").read_text())
        if done.get(fips) == job["outputSha256"]:
            continue
        if fips in done:
            raise ValueError(f"stale county index {fips}; a new input digest should create a new database")
        if tiger.sha256_of(output) != job["outputSha256"]:
            raise ValueError(f"normalized road shard digest mismatch: {fips}")
        table = pq.read_table(output, columns=["name", "county_fips", "source_feature_id", "geometry", "road_class"])
        values = table.to_pydict()
        batch = []
        for name, county, feature, geometry, road_class in zip(values["name"], values["county_fips"],
                                                                values["source_feature_id"], values["geometry"], values["road_class"]):
            if not name or road_class not in ("S1200", "S1400"):
                continue
            key = tiger.slug(name)
            bucket = int(hashlib.sha256(key.encode()).hexdigest()[:4], 16) % BUCKETS
            batch.append((bucket, key, name, county, feature, geometry))
        with conn:
            conn.executemany("INSERT INTO roads VALUES (?,?,?,?,?,?)", batch)
            conn.execute("INSERT INTO completed VALUES (?,?,?)", (fips, job["outputSha256"], len(batch)))
    conn.execute("CREATE INDEX IF NOT EXISTS roads_name ON roads(bucket,name_key)")
    conn.commit()
    return conn, directory


def each_name(conn, bucket):
    cursor = conn.execute("SELECT name_key,name,county_fips,source_feature_id,geometry FROM roads WHERE bucket=? ORDER BY name_key", (bucket,))
    current_key, group = None, []
    for key, name, county, feature, geometry in cursor:
        if current_key is not None and key != current_key:
            yield current_key, group
            group = []
        current_key = key
        group.append({"name": name, "county_fips": county, "source_feature_id": feature,
                      "coordinates": list(wkb.loads(geometry).coords), "geometry": geometry})
    if group:
        yield current_key, group


def build_bucket(conn, directory, bucket, input_sha):
    output = directory / f"components-{bucket:02d}.jsonl"
    checkpoint = directory / f"components-{bucket:02d}.json"
    previous = json.loads(checkpoint.read_text()) if checkpoint.exists() else {}
    if (previous.get("state") == "complete" and previous.get("inputSha256") == input_sha
            and previous.get("pipelineSha256") == pipeline_sha()
            and output.exists() and output.stat().st_size == previous.get("bytes")
            and tiger.sha256_of(output) == previous.get("sha256")):
        return previous
    roads.atomic_json(checkpoint, {"state": "running", "bucket": bucket, "inputSha256": input_sha,
                                 "pipelineSha256": pipeline_sha()})
    started = time.monotonic()
    temporary = output.with_suffix(".jsonl.tmp")
    counts = Counter()
    largest = []
    with temporary.open("w") as stream:
        for key, group in each_name(conn, bucket):
            counts["names"] += 1
            counts["namedFeatures"] += len(group)
            components = national_components.component_index(group, key, key.replace("-", " "))
            by_id = defaultdict(list)
            for row in group:
                by_id[row["source_feature_id"]].append(row)
            for component in components:
                cells = set()
                for feature in component["sourceFeatureIds"]:
                    for row in by_id[feature]:
                        from shapely.geometry import LineString
                        line = LineString(row["coordinates"])
                        min_lon, min_lat, max_lon, max_lat = line.bounds
                        cells.update(partitions.member_cells({"geometry": row["geometry"], "min_lon": min_lon,
                                                              "min_lat": min_lat, "max_lon": max_lon, "max_lat": max_lat}))
                compact = {field: component[field] for field in ("id", "name", "componentIndex", "componentCount",
                           "sourceFeatureIds", "counties", "featureCount", "lengthM", "bounds")}
                compact["nameKey"] = key
                compact["cells"] = sorted(cells)
                stream.write(json.dumps(compact, sort_keys=True, separators=(",", ":")) + "\n")
                counts["components"] += 1
                if len(cells) > 1:
                    counts["multiCellComponents"] += 1
                if component["lengthM"] > 100000:
                    largest.append({"id": component["id"], "name": component["name"],
                                    "lengthM": component["lengthM"], "features": component["featureCount"]})
    temporary.replace(output)
    largest.sort(key=lambda item: (-item["lengthM"], item["id"]))
    result = {"state": "complete", "bucket": bucket, "inputSha256": input_sha, "pipelineSha256": pipeline_sha(), "bytes": output.stat().st_size,
              "sha256": tiger.sha256_of(output), "counts": dict(counts), "largestOver100km": largest[:20],
              "wallSeconds": round(time.monotonic()-started, 3)}
    roads.atomic_json(checkpoint, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=roads.DEFAULT_WORK)
    parser.add_argument("--bucket", type=int, help="one of 64 deterministic component output jobs")
    args = parser.parse_args()
    input_sha, counties = source_key(args.work)
    conn, directory = build_index(args.work, input_sha, counties)
    selected = [args.bucket] if args.bucket is not None else range(BUCKETS)
    totals = Counter()
    largest = []
    for bucket in selected:
        if not 0 <= bucket < BUCKETS:
            parser.error("bucket must be 0..63")
        result = build_bucket(conn, directory, bucket, input_sha)
        totals.update(result["counts"])
        largest.extend(result["largestOver100km"])
        print(json.dumps({"bucket": bucket, "counts": result["counts"], "wallSeconds": result["wallSeconds"]}), flush=True)
    largest.sort(key=lambda item: (-item["lengthM"], item["id"]))
    print(json.dumps({"inputSha256": input_sha, "counts": dict(totals), "largest": largest[:20],
                      "directory": str(directory)}))


if __name__ == "__main__":
    main()
