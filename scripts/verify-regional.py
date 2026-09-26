#!/usr/bin/env python3
"""Offline structural and integrity review of every published regional catalog and its cells.

    npm run verify:regional

Every catalog under data/regional is reviewed: byte counts, digests, CRS, geometry validity, cell bounds,
unique source keys, replicated-feature deduplication, the declared column schema (which is what makes an
intentionally empty cell a typed empty relation rather than a failure), and the committed benchmark
scenarios against the published window. It reads only local files.
"""
import hashlib
import json
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
source_manifest = json.loads((DATA / "manifest.json").read_text())
sources = {item["id"] for item in source_manifest["datasets"]}
connection = duckdb.connect()
connection.execute("INSTALL spatial; LOAD spatial")

catalogs = sorted((DATA / "regional").glob("manifest*.json"))
assert catalogs, "no regional catalog is published"
for catalog_path in catalogs:
    catalog = json.loads(catalog_path.read_text())
    assert catalog["schemaVersion"] == 2 and catalog["maxAnalysisDistanceM"] >= 1000, catalog_path
    print(f"{catalog_path.name}: {catalog['version']} {catalog['region']['bounds']}")
    # A published window whose partitions are served from R2 rather than committed is still reviewed here:
    # the catalog structure is checked, and the byte-level review is delegated to the remote audit.
    local_root = DATA / "regional" / "partitions" / catalog["version"]
    if not local_root.exists():
        for dataset in catalog["datasets"]:
            assert dataset["sourceDatasetId"] in sources, dataset["id"]
            assert dataset.get("columns"), f"{dataset['id']} declares no column schema"
        print(f"  partitions are not committed for {catalog['version']}; "
              f"audit them remotely with: npm run audit:regional:remote")
        continue
    for dataset in catalog["datasets"]:
        assert dataset["sourceDatasetId"] in sources, dataset["id"]
        partitions = dataset["partitions"]
        assert len({part["id"] for part in partitions}) == len(partitions)
        columns = dataset.get("columns")
        assert columns, f"{dataset['id']} declares no column schema"
        projection = ", ".join(f'{column["name"]}' for column in columns)
        files, empty_cells = [], 0
        for part in partitions:
            if part["state"] == "empty":
                # An intentionally empty cell must still be a valid, typed, empty relation.
                assert part["featureCount"] == 0 and "url" not in part, part
                empty = ", ".join(f'NULL::{column["type"]} AS {column["name"]}' for column in columns)
                rows = connection.execute(f"SELECT count(*) FROM (SELECT {empty} WHERE false)").fetchone()[0]
                assert rows == 0, part["id"]
                empty_cells += 1
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
            # The declared schema must be the schema the file actually carries: that is what lets an
            # all-empty selection be answered with an empty relation of the same shape.
            described = {row[0] for row in connection.execute(f"SELECT {projection} FROM read_parquet(?) LIMIT 0", [str(path)]).description}
            assert described == {column["name"] for column in columns}, (path, described)
            files.append(str(path))
        key = "county_fips, source_feature_id, part" if dataset["id"] == "roads" else "layer, source_feature_id" if dataset["id"] == "hydrography" else "source_feature_id"
        if not files:
            assert dataset["featureCount"] == 0, dataset["id"]
            print(f"  {dataset['id']}: all {empty_cells} cells intentionally empty")
            continue
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
        measures = connection.execute(f"""
          WITH raw AS (SELECT * FROM read_parquet(?)),
          logical AS (SELECT * EXCLUDE rn FROM (SELECT *, row_number() OVER (PARTITION BY {key}) AS rn FROM raw) WHERE rn = 1)
          SELECT (SELECT count(*) FROM logical),
                 (SELECT sum(ST_Area(geometry) + ST_Length(geometry)) FROM raw),
                 (SELECT sum(ST_Area(geometry) + ST_Length(geometry)) FROM logical)
        """, [files]).fetchone()
        assert measures[0] == unique and measures[1] > measures[2] > 0, (dataset["id"], "double-counted geometry", measures)
        print(f"  {dataset['id']}: {len(files)} cells, {packed} stored rows, {unique} unique features, "
              f"{packed - unique} replicated, {empty_cells} empty, {sum(p.get('bytes', 0) for p in partitions):,} bytes")

benchmarks_path = DATA / "regional" / "benchmarks.json"
if benchmarks_path.exists():
    benchmarks = json.loads(benchmarks_path.read_text())
    catalogs_by_version = {json.loads(path.read_text())["version"]: json.loads(path.read_text()) for path in catalogs}
    catalog = catalogs_by_version[benchmarks["region"]]
    published = catalog["region"]["bounds"]
    for scenario in benchmarks["scenarios"]:
        assert scenario["kind"] == "radius" and scenario["radiusMiles"] > 0, scenario
        assert scenario["fullyInsidePublishedRegion"], scenario["id"]
        assert scenario["bbox"][0] >= published[0] and scenario["bbox"][1] >= published[1]
        assert scenario["bbox"][2] <= published[2] and scenario["bbox"][3] <= published[3]
    print(f"benchmarks: {len(benchmarks['scenarios'])} committed scenarios inside {benchmarks['region']}")
print("regional artifacts: VALID")
