#!/usr/bin/env python3
"""Offline structural and integrity review of every regional GeoParquet cell."""
import hashlib
import json
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
catalog = json.loads((DATA / "regional/manifest.json").read_text())
source_manifest = json.loads((DATA / "manifest.json").read_text())
sources = {item["id"] for item in source_manifest["datasets"]}
assert catalog["schemaVersion"] == 2 and catalog["maxAnalysisDistanceM"] >= 1000
connection = duckdb.connect()
connection.execute("INSTALL spatial; LOAD spatial")
for dataset in catalog["datasets"]:
    assert dataset["sourceDatasetId"] in sources
    partitions = dataset["partitions"]
    assert len({part["id"] for part in partitions}) == len(partitions)
    files = []
    for part in partitions:
        if part["state"] == "empty":
            assert part["featureCount"] == 0 and "url" not in part
            continue
        path = DATA / part["url"]
        payload = path.read_bytes()
        assert len(payload) == part["bytes"], path
        assert hashlib.sha256(payload).hexdigest() == part["sha256"], path
        count, valid, crs, outside = connection.execute("""
          SELECT count(*), count(*) FILTER (WHERE ST_IsValid(geometry) AND NOT ST_IsEmpty(geometry)),
                 any_value(ST_CRS(geometry)),
                 count(*) FILTER (WHERE NOT ST_Intersects(geometry, ST_MakeEnvelope(?, ?, ?, ?)))
          FROM read_parquet(?)
        """, [*part["bounds"], str(path)]).fetchone()
        assert count == part["featureCount"] and valid == count and crs == "EPSG:4326" and outside == 0, path
        files.append(str(path))
    key = "county_fips, source_feature_id, part" if dataset["id"] == "roads" else "layer, source_feature_id" if dataset["id"] == "hydrography" else "source_feature_id"
    packed, unique, conflicts = connection.execute(f"""
      SELECT count(*), count(DISTINCT ({key})),
        (SELECT count(*) FROM (SELECT {key}, count(DISTINCT geometry) AS shapes
           FROM read_parquet(?) GROUP BY {key} HAVING shapes > 1))
      FROM read_parquet(?)
    """, [files, files]).fetchone()
    assert unique == dataset["featureCount"], (dataset["id"], unique, dataset["featureCount"])
    assert conflicts == 0, (dataset["id"], conflicts)
    distinct_rows = connection.execute("SELECT count(*) FROM (SELECT DISTINCT * FROM read_parquet(?))", [files]).fetchone()[0]
    assert distinct_rows == unique, (dataset["id"], "replicated feature attributes differ", distinct_rows, unique)
    # Exercise the same row_number source-key deduplication as the browser. Raw replicated
    # polygons/streams must have a larger summed measure; the logical dataset must count each once.
    measures = connection.execute(f"""
      WITH raw AS (SELECT * FROM read_parquet(?)),
      logical AS (SELECT * EXCLUDE rn FROM (SELECT *, row_number() OVER (PARTITION BY {key}) AS rn FROM raw) WHERE rn = 1)
      SELECT (SELECT count(*) FROM logical),
             (SELECT sum(ST_Area(geometry) + ST_Length(geometry)) FROM raw),
             (SELECT sum(ST_Area(geometry) + ST_Length(geometry)) FROM logical)
    """, [files]).fetchone()
    assert measures[0] == unique and measures[1] > measures[2] > 0, (dataset["id"], "double-counted geometry", measures)
    print(f"{dataset['id']}: {len(files)} cells, {packed} stored rows, {unique} unique features, {packed - unique} replicated, {sum(p.get('bytes', 0) for p in partitions):,} bytes")
print("regional artifacts: VALID")
