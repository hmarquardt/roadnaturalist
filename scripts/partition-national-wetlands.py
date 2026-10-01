#!/usr/bin/env python3
"""Resolve cross-package NWI identity, replicate whole features, and compact cells."""
import argparse
import hashlib
import json
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

import pyarrow.parquet as pq
from shapely import wkb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_volume as bv
import national_wetlands as nw  # noqa: E402

GRID = json.loads((ROOT / "data/national/grid-conus-2025.json").read_text())
LOCK = json.loads((ROOT / "data/national/nwi-state-lock.json").read_text())
DEFAULT_WORK = bv.work_dir("nwi", ROOT / "data/national-wetlands-work")
VERSION = "nwi-state-2026-05-v1"
STATE_FIPS = {"AL":"01","AZ":"04","AR":"05","CA":"06","CO":"08","CT":"09","DE":"10","DC":"11","FL":"12","GA":"13","ID":"16","IL":"17","IN":"18","IA":"19","KS":"20","KY":"21","LA":"22","ME":"23","MD":"24","MA":"25","MI":"26","MN":"27","MS":"28","MO":"29","MT":"30","NE":"31","NV":"32","NH":"33","NJ":"34","NM":"35","NY":"36","NC":"37","ND":"38","OH":"39","OK":"40","OR":"41","PA":"42","RI":"44","SC":"45","SD":"46","TN":"47","TX":"48","UT":"49","VT":"50","VA":"51","WA":"53","WV":"54","WI":"55","WY":"56"}
CELL_IDS = {item["id"] for item in GRID["cells"]}


def publication_version(states, sample_bbox):
    if set(states) == set(LOCK["packages"]) and sample_bbox is None:
        return VERSION
    selection = json.dumps({"states": sorted(states), "bbox": sample_bbox}, sort_keys=True, separators=(",", ":"))
    return f"{VERSION}-sample-{hashlib.sha256(selection.encode()).hexdigest()[:12]}"


def input_chunks(work, states):
    result = []
    for state in sorted(states):
        state_job = work / "jobs" / state / "state.json"
        if not state_job.exists() or json.loads(state_job.read_text()).get("state") != "complete":
            raise ValueError(f"{state} normalization is incomplete")
        job = json.loads(state_job.read_text())
        if (job.get("sourceSha256") != LOCK["packages"][state]["sha256"]
                or job.get("pipelineVersion") != nw.PIPELINE_VERSION):
            raise ValueError(f"{state} normalization was built from a stale source or pipeline")
        paths = sorted((work / "normalized" / state).glob("chunk-*.parquet"))
        if len(paths) != job["chunks"]:
            raise ValueError(f"{state} normalized chunk count differs from its state checkpoint")
        for index, path in enumerate(paths):
            checkpoint = work / "jobs" / state / f"chunk-{index:05d}.json"
            if path.name != f"chunk-{index:05d}.parquet" or not checkpoint.exists():
                raise ValueError(f"{state} normalized chunk sequence is incomplete")
            entry = json.loads(checkpoint.read_text())
            digest = nw.sha256_file(path)
            if (entry.get("state") != "complete" or entry.get("outputSha256") != digest
                    or entry.get("outputBytes") != path.stat().st_size
                    or entry.get("outputCount") != pq.read_metadata(path).num_rows
                    or entry.get("sourceSha256") != job["sourceSha256"]
                    or entry.get("pipelineVersion") != job["pipelineVersion"]):
                raise ValueError(f"{state} normalized chunk {index} is stale or corrupt")
            result.append((state, path, digest))
    return result


def build_identity(work, states):
    started = time.monotonic()
    chunks = input_chunks(work, states)
    input_digest = hashlib.sha256("\n".join(f"{state}:{digest}" for state, _, digest in chunks).encode()).hexdigest()
    db_path = work / "identity.sqlite"
    meta_path = work / "identity.json"
    if meta_path.exists() and db_path.exists():
        old = json.loads(meta_path.read_text())
        if (old.get("state") == "complete" and old.get("inputSha256") == input_digest
                and old.get("canonicalKeyVersion") == nw.CANONICAL_KEY_VERSION
                and old.get("dbSha256") == nw.sha256_file(db_path)):
            return old
    db_path.unlink(missing_ok=True)
    connection = sqlite3.connect(db_path)
    connection.executescript("""
      PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;  -- rebuildable intermediate: a lost write costs a re-run, not data
      CREATE TABLE feature(state TEXT, objectid INTEGER, nwi_id TEXT, geometry_digest TEXT, semantic_digest TEXT,
                           PRIMARY KEY(state, objectid));
      CREATE INDEX feature_nwi ON feature(nwi_id);
      CREATE TABLE mapping(state TEXT, objectid INTEGER, canonical_key TEXT, owner INTEGER, source_states TEXT,
                           disposition TEXT, PRIMARY KEY(state, objectid));
    """)
    raw = 0
    for _, path, _ in chunks:
        table = pq.read_table(path, columns=["state", "objectid", "nwi_id", "geometry_digest", "semantic_digest"])
        rows = zip(*(table.column(name).to_pylist() for name in table.column_names))
        connection.executemany("INSERT INTO feature VALUES(?,?,?,?,?)", rows)
        raw += table.num_rows
    connection.commit()
    connection.execute("""CREATE TABLE id_summary AS SELECT nwi_id, count(*) AS copies,
                         count(DISTINCT state) AS state_count, count(DISTINCT semantic_digest) AS signatures
                         FROM feature WHERE nwi_id <> '' GROUP BY nwi_id""")
    connection.execute("CREATE UNIQUE INDEX summary_nwi ON id_summary(nwi_id)")
    connection.create_function("local_key", 5, lambda state, objectid, nwi_id, geometry_digest, semantic_digest:
                               nw.canonical_key(state, objectid, nwi_id, geometry_digest, semantic_digest, conflict=True))
    connection.execute("""INSERT INTO mapping
        SELECT f.state,f.objectid,'nwi:'||f.nwi_id,1,f.state,'unique'
        FROM feature f JOIN id_summary s ON f.nwi_id=s.nwi_id WHERE s.copies=1""")
    connection.execute("""INSERT INTO mapping
        SELECT f.state,f.objectid,local_key(f.state,f.objectid,f.nwi_id,f.geometry_digest,f.semantic_digest),1,f.state,'ambiguous'
        FROM feature f JOIN id_summary s ON f.nwi_id=s.nwi_id
        WHERE s.copies>1 AND NOT (s.state_count>1 AND s.copies=s.state_count AND s.signatures=1)""")
    connection.execute("""INSERT INTO mapping
        SELECT f.state,f.objectid,local_key(f.state,f.objectid,'',f.geometry_digest,f.semantic_digest),1,f.state,'blank-id'
        FROM feature f WHERE f.nwi_id=''""")
    suspect_groups = connection.execute("""SELECT nwi_id,copies,state_count,signatures FROM id_summary
                                             WHERE copies>1 AND state_count>1 AND copies=state_count AND signatures=1""").fetchall()
    duplicates = ambiguous = 0
    pair_counts = defaultdict(int)
    for nwi_id, count, state_count, signature_count in suspect_groups:
        rows = connection.execute("SELECT state,objectid,geometry_digest,semantic_digest FROM feature WHERE nwi_id=? ORDER BY state,objectid", (nwi_id,)).fetchall()
        if nw.duplicate_group_is_safe(rows):
            rows.sort(key=lambda row: (STATE_FIPS[row[0]], row[1]))
            owner = rows[0]
            states_for = ",".join(row[0] for row in rows)
            key = nw.canonical_key(owner[0], owner[1], nwi_id, owner[2], owner[3])
            for index, row in enumerate(rows):
                connection.execute("INSERT INTO mapping VALUES(?,?,?,?,?,?)", (row[0], row[1], key, index == 0, states_for, "canonical" if index == 0 else "duplicate"))
            duplicates += count - 1
            for left in range(len(rows)):
                for right in range(left + 1, len(rows)):
                    pair_counts[f"{rows[left][0]}/{rows[right][0]}"] += 1
    connection.commit()
    canonical = connection.execute("SELECT count(*) FROM mapping WHERE owner=1").fetchone()[0]
    ambiguous = connection.execute("SELECT count(*) FROM mapping WHERE disposition='ambiguous'").fetchone()[0]
    blank_count = connection.execute("SELECT count(*) FROM mapping WHERE disposition='blank-id'").fetchone()[0]
    connection.close()
    db_sha = nw.sha256_file(db_path)
    report = {"state": "complete", "pipelineVersion": nw.PIPELINE_VERSION, "canonicalKeyVersion": nw.CANONICAL_KEY_VERSION,
              "inputSha256": input_digest, "dbSha256": db_sha, "states": sorted(states), "rawFeatures": raw, "canonicalFeatures": canonical,
              "duplicatePackageCopies": duplicates, "ambiguousRows": ambiguous, "blankIdRows": blank_count,
              "wallSeconds": round(time.monotonic()-started, 3),
              "borderPairs": dict(sorted(pair_counts.items(), key=lambda item: (-item[1], item[0])))}
    nw.atomic_json(meta_path, report)
    return report


def required_identity(work, states):
    """The already-built global identity, validated, never rebuilt.

    Partition shards run concurrently and every one of them needs the identity database. Rebuilding it here would
    mean each shard recomputing a different identity over its own state subset and unlinking the shared database
    while its siblings read it, so a subset stage validates the existing global index instead and refuses to
    proceed without one. Identity is built once, over every state, by --identity-only.
    """
    meta_path = work / "identity.json"
    db_path = work / "identity.sqlite"
    if not meta_path.exists() or not db_path.exists():
        raise ValueError("wetlands identity has not been built; run --identity-only over every state first")
    identity = json.loads(meta_path.read_text())
    if identity.get("state") != "complete" or identity.get("canonicalKeyVersion") != nw.CANONICAL_KEY_VERSION:
        raise ValueError("wetlands identity checkpoint is incomplete or uses a stale canonical key")
    if identity.get("dbSha256") != nw.sha256_file(db_path):
        raise ValueError("wetlands identity database changed since its checkpoint was written")
    missing = sorted(set(states) - set(identity.get("states", [])))
    if missing:
        raise ValueError(f"wetlands identity does not cover {missing}")
    return identity


def partition_chunks(work, states):
    started = time.monotonic()
    identity = required_identity(work, states)
    connection = sqlite3.connect(work / "identity.sqlite")
    totals = {"chunks": 0, "replicatedRows": 0, "fragments": 0}
    for state, path, digest in input_chunks(work, states):
        chunk_name = path.stem
        checkpoint = work / "partition-jobs" / state / f"{chunk_name}.json"
        old = json.loads(checkpoint.read_text()) if checkpoint.exists() else {}
        if old.get("state") == "complete" and old.get("inputSha256") == digest and old.get("identitySha256") == identity["inputSha256"] and old.get("schemaDigest") == nw.SCHEMA_DIGEST and all(
                (work / item["path"]).exists() and nw.sha256_file(work / item["path"]) == item["sha256"] for item in old.get("fragments", {}).values()):
            totals["chunks"] += 1; totals["replicatedRows"] += old["replicatedRows"]; totals["fragments"] += len(old["fragments"])
            continue
        table = pq.read_table(path)
        objectids = table.column("objectid").to_pylist()
        mappings = ({row[0]: row[1:] for row in connection.execute(
            "SELECT objectid,canonical_key,owner,source_states,disposition FROM mapping WHERE state=? AND objectid BETWEEN ? AND ?",
            (state, min(objectids), max(objectids)))} if objectids else {})
        by_cell = defaultdict(list)
        for row in table.to_pylist():
            canonical_key, owner, source_states, _ = mappings[row["objectid"]]
            if not owner:
                continue
            geometry = wkb.loads(row["geometry"])
            attribute = row["attribute"]
            # `source_feature_id` is the identifier the derived build and the runtime both key on:
            # build-derived.py dedupes with PARTITION BY source_feature_id, and service.js uses
            # `wetlands: 'source_feature_id'` as the dataset's sole source key. Object numbers are only unique
            # within their state package, so publishing them bare would make two states' features look like one
            # feature and silently undercount. Qualifying with the state keeps it unique and traceable.
            output = {"canonical_feature_id": canonical_key, "nwi_id": row["nwi_id"],
                      "source_feature_id": f"{state}:{row['objectid']}",
                      "source_state": state,
                      "source_objectid": row["objectid"], "source_states": source_states, "attribute": attribute,
                      "wetland_type": row["wetland_type"], "system_code": attribute[:1],
                      "system_label": nw.COWARDIN_SYSTEMS.get(attribute[:1], ""), "qaqc_code": row["qaqc_code"],
                      "source_acres": row["source_acres"], "geometry_digest": row["geometry_digest"],
                      "min_lon": row["min_lon"], "min_lat": row["min_lat"], "max_lon": row["max_lon"],
                      "max_lat": row["max_lat"], "geometry": row["geometry"]}
            for cell in nw.member_cells(geometry, CELL_IDS):
                by_cell[cell].append(output)
        fragments = {}
        for cell in sorted(by_cell):
            relative = Path("fragments") / state / chunk_name / f"{cell}.parquet"
            result = nw.write_geoparquet(by_cell[cell], work / relative)
            fragments[cell] = {"path": str(relative), **result}
        record = {"state": "complete", "inputSha256": digest, "identitySha256": identity["inputSha256"],
                  "schemaDigest": nw.SCHEMA_DIGEST,
                  "replicatedRows": sum(item["rows"] for item in fragments.values()), "fragments": fragments}
        nw.atomic_json(checkpoint, record)
        totals["chunks"] += 1; totals["replicatedRows"] += record["replicatedRows"]; totals["fragments"] += len(fragments)
    connection.close()
    totals["wallSeconds"] = round(time.monotonic()-started, 3)
    return totals


def compact(work, states):
    started = time.monotonic()
    identity = build_identity(work, states)
    partition_report = partition_chunks(work, states)
    compact_started = time.monotonic()
    fragments = defaultdict(list)
    for state in states:
        for checkpoint in sorted(path for path in (work / "partition-jobs" / state).glob("*.json")
                                  if bv.is_data_file(path)):
            job = json.loads(checkpoint.read_text())
            if job.get("state") != "complete":
                raise ValueError(f"incomplete partition checkpoint {checkpoint}")
            for cell, item in job["fragments"].items():
                fragments[cell].append(item)
    cells = []
    built_fips = {STATE_FIPS[state] for state in states}
    selections = [json.loads((work / "jobs" / state / "state.json").read_text()).get("selectionLonLatBBox") for state in states]
    if any(item != selections[0] for item in selections):
        raise ValueError("sample states use different source-selection bounds")
    sample_bbox = selections[0]
    complete = set(states) == set(LOCK["packages"]) and sample_bbox is None
    # A sample cell can change when an unbuilt neighboring package contributes a
    # copy. Never publish it at the future complete-plane immutable key.
    version = publication_version(states, sample_bbox)
    artifact_dir = work / "artifacts" / "wetlands"
    old_manifest_path = work / "artifacts" / "wetland-manifest.json"
    old_manifest = json.loads(old_manifest_path.read_text()) if old_manifest_path.exists() else {}
    previous = {entry["id"]: entry for entry in old_manifest.get("cells", [])}
    for cell in GRID["cells"]:
        cell_id = cell["id"]
        required_built = set(cell["states"]).issubset(built_fips)
        if sample_bbox:
            bounds = cell["bounds"]
            required_built = required_built and (sample_bbox[0] <= bounds[0] and sample_bbox[1] <= bounds[1]
                                                   and sample_bbox[2] >= bounds[2] and sample_bbox[3] >= bounds[3])
        parts = sorted(fragments.get(cell_id, []), key=lambda item: item["path"])
        if not required_built:
            cells.append({"id": cell_id, "bounds": cell["bounds"], "state": "unbuilt"})
            continue
        if not parts:
            cells.append({"id": cell_id, "bounds": cell["bounds"], "state": "empty", "featureCount": 0, "storedRows": 0})
            continue
        input_sha = hashlib.sha256("\n".join(item["sha256"] for item in parts).encode()).hexdigest()
        prior = previous.get(cell_id, {})
        prior_path = artifact_dir / f"{cell_id}.parquet"
        url = f"national/wetlands/{version}/wetlands/{cell_id}.parquet"
        if (prior.get("inputSha256") == input_sha and prior.get("state") == "present"
                and prior_path.exists() and prior_path.stat().st_size == prior.get("bytes")
                and nw.sha256_file(prior_path) == prior.get("sha256")):
            cells.append({**prior, "url": url})
            continue
        by_key = {}
        for item in parts:
            source = work / item["path"]
            if not source.exists() or nw.sha256_file(source) != item["sha256"]:
                raise ValueError(f"missing/corrupt wetland fragment {source}")
            for row in pq.read_table(source).to_pylist():
                old = by_key.get(row["canonical_feature_id"])
                if old and old["geometry_digest"] != row["geometry_digest"]:
                    raise ValueError(f"canonical wetland geometry conflict {row['canonical_feature_id']}")
                by_key[row["canonical_feature_id"]] = row
        rows = [by_key[key] for key in sorted(by_key)]
        result = nw.write_geoparquet(rows, artifact_dir / f"{cell_id}.parquet")
        cells.append({"id": cell_id, "bounds": cell["bounds"], "state": "present", "featureCount": len(rows),
                      "storedRows": len(rows), "inputSha256": input_sha,
                      "url": url, **result})
    manifest = {"schemaVersion": 1, "kind": "national-wetlands", "version": version,
                "coverage": GRID["coverage"], "buildCoverage": "sample" if sample_bbox else
                    ("complete" if complete else "partial"),
                "builtStates": sorted(states), "gridSha256": nw.sha256_file(ROOT / "data/national/grid-conus-2025.json"),
                "selectionBBox": sample_bbox,
                "sourceLockSha256": nw.sha256_file(ROOT / "data/national/nwi-state-lock.json"),
                "pipelineVersion": nw.PIPELINE_VERSION, "canonicalKeyVersion": nw.CANONICAL_KEY_VERSION,
                "partitionScheme": GRID["partitionScheme"], "schema": [{"name": field.name, "type": str(field.type)} for field in nw.SCHEMA],
                "counts": {"rawFeatures": identity["rawFeatures"], "canonicalFeatures": identity["canonicalFeatures"],
                           "duplicatePackageCopies": identity["duplicatePackageCopies"], "ambiguousRows": identity["ambiguousRows"],
                           "cells": len(cells), "present": sum(c["state"] == "present" for c in cells),
                           "empty": sum(c["state"] == "empty" for c in cells), "unbuilt": sum(c["state"] == "unbuilt" for c in cells),
                           "storedRows": sum(c.get("storedRows", 0) for c in cells),
                           "artifactBytes": sum(c.get("bytes", 0) for c in cells)}, "cells": cells}
    nw.atomic_json(work / "artifacts" / "wetland-manifest.json", manifest)
    nw.atomic_json(work / "partition-benchmark.json", {"identitySeconds": identity.get("wallSeconds"),
        "partitionSeconds": partition_report["wallSeconds"],
        "compactionSeconds": round(time.monotonic()-compact_started, 3),
        "invocationSeconds": round(time.monotonic()-started, 3)})
    print(json.dumps(manifest["counts"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--states", required=True)
    parser.add_argument("--finalize", action="store_true")
    parser.add_argument("--identity-only", action="store_true",
                        help="resolve canonical wetland identity over the given states and exit; identity is "
                             "global (it resolves duplicates across every package) so it must run once, over all "
                             "states, before any partition shard starts")
    parser.add_argument("--partition-only", action="store_true",
                        help="replicate and fragment only the given states and exit; requires the identity "
                             "database from --identity-only, so this stage shards across processes")
    args = parser.parse_args()
    states = args.states.split(",")
    if args.identity_only:
        print(json.dumps({"identity": build_identity(args.work, states)}))
        return
    if args.partition_only:
        print(json.dumps({"partitions": partition_chunks(args.work, states)}))
        return
    if args.finalize:
        compact(args.work, states)
    else:
        print(json.dumps({"identity": build_identity(args.work, states), "partitions": partition_chunks(args.work, states)}))


if __name__ == "__main__":
    main()
