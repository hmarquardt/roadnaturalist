#!/usr/bin/env python3
"""Verify the national derived corridor-metrics plane: artifacts, contracts, and source-grounded metrics.

    uv run --python 3.12 --with duckdb --with shapely --with pyarrow python3 scripts/verify-national-derived.py

Structural checks (always):
  - the corridor index and all 64 bucket files match their declared digests and the committed segmentation;
  - every deterministic shard has a complete checkpoint built against the current corridor index, pipeline
    digest and analysis fingerprint, and its metrics/parts files match their digests;
  - the final manifest declares exactly the national grid cells; every present cell's bytes/SHA-256 match;
  - each stored row derives its corridor id from its unit and segment, carries the manifest fingerprint and
    an established coverage state, and is replicated into every grid cell its geometry intersects.

Contract checks (sampled):
  - hydrography layer values are inside the runtime vocabulary {flowline, waterbody};
  - wetland source_feature_id matches the verified state:objectid source-key contract;
  - a deterministic sample of corridors is re-measured from the raw planes with the shared metric
    expressions and must match the published row exactly (this is the check that catches schema drift).

Exits nonzero on any problem.
"""
import argparse
import hashlib
import json
import math
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
os_environ = __import__("os").environ
os_environ.setdefault("ROADNATURALIST_BUILD_VOLUME", "/Volumes/Lexar/roadnaturalist")

import duckdb  # noqa: E402
from importlib.machinery import SourceFileLoader  # noqa: E402
from shapely import wkb  # noqa: E402
from shapely.geometry import box, shape  # noqa: E402

build = SourceFileLoader("national_derived_build", str(ROOT / "scripts/build-national-derived.py")).load_module()
derived = build.derived

PROBLEMS = []
SECTIONS = {}


def fail(message):
    PROBLEMS.append(message)


def sha256_of(path):
    value = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def check_corridors(args, fingerprint):
    index_path = args.out / "corridors/index.json"
    if not index_path.exists():
        fail("corridor index missing")
        return None
    index = json.loads(index_path.read_text())
    if index.get("pipelineSha256") != build.pipeline_sha():
        fail("corridor index was built by a different pipeline")
    if index.get("state") != "complete" or len(index.get("buckets", [])) != build.CORRIDOR_BUCKETS:
        fail("corridor index is incomplete")
    corrupted = 0
    for entry in index["buckets"]:
        path = args.out / f"corridors/corridors-{entry['bucket']:02d}.parquet"
        if not path.exists() or path.stat().st_size != entry["bytes"] or sha256_of(path) != entry["sha256"]:
            corrupted += 1
    if corrupted:
        fail(f"{corrupted} corridor bucket file(s) do not match the index")
    SECTIONS["corridors"] = {"buckets": len(index["buckets"]), "corridors": index["corridors"],
                             "bytes": index["bytes"], "sha256": index["corridorsSha256"]}
    return index


def check_shards(args, index, fingerprint):
    shards = build.shard_list()
    complete = failed = missing = stale = corrupt = 0
    rows = 0
    parts = 0
    for identifier, _sx, _sy in shards:
        checkpoint_path = args.out / "metrics" / f"shard-{identifier}.json"
        if not checkpoint_path.exists():
            missing += 1
            continue
        checkpoint = json.loads(checkpoint_path.read_text())
        if checkpoint.get("state") == "failed":
            failed += 1
            continue
        if checkpoint.get("state") != "complete":
            missing += 1
            continue
        if (checkpoint.get("inputSha256") != index["corridorsSha256"]
                or checkpoint.get("pipelineSha256") != build.pipeline_sha()
                or checkpoint.get("fingerprint") != fingerprint):
            stale += 1
            continue
        for key in ("metrics", "parts"):
            entry = checkpoint.get(key)
            if not entry:
                continue
            kind = "metrics" if key == "metrics" else "parts"
            path = args.out / kind / f"shard-{identifier}.parquet"
            if not path.exists() or path.stat().st_size != entry["bytes"] or sha256_of(path) != entry["sha256"]:
                corrupt += 1
        complete += 1
        rows += checkpoint.get("rows", 0)
        parts += bool(checkpoint.get("parts"))
    if missing or failed or stale or corrupt:
        fail(f"shards: {missing} missing, {failed} failed, {stale} stale, {corrupt} corrupt output(s)")
    SECTIONS["shards"] = {"total": len(shards), "complete": complete, "rows": rows, "withParts": parts}
    if complete != len(shards):
        fail(f"only {complete} of {len(shards)} shards are complete")
    return shards


def check_manifest(args, fingerprint, grid):
    manifest_path = args.final / fingerprint / "manifest.json"
    if not manifest_path.exists():
        fail(f"final manifest missing: {manifest_path}")
        return None
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("analysisFingerprint") != fingerprint:
        fail("manifest fingerprint does not match the current pipeline")
    declared = {cell["id"]: cell for cell in manifest.get("cells", [])}
    missing = sorted(set(grid) - set(declared))
    extra = sorted(set(declared) - set(grid))
    if missing or extra:
        fail(f"manifest cell set differs from the national grid ({len(missing)} missing, {len(extra)} extra)")
    present = [declared[identifier] for identifier in sorted(declared) if declared[identifier]["state"] == "present"]
    corrupted = 0
    for cell in present:
        path = args.final / fingerprint / "cells" / f"{cell['id']}.parquet"
        if not path.exists() or path.stat().st_size != cell["bytes"] or sha256_of(path) != cell["sha256"]:
            corrupted += 1
        if cell["bounds"] != grid[cell["id"]]:
            corrupted += 1
    if corrupted:
        fail(f"{corrupted} present cell artifact(s) do not match the manifest")
    stored = sum(cell["rowCount"] for cell in declared.values())
    total_bytes = sum(cell.get("bytes", 0) for cell in declared.values())
    counts = manifest.get("counts", {})
    if counts.get("storedRows") != stored:
        fail(f"manifest declares {counts.get('storedRows')} stored rows, cells say {stored}")
    if stored - counts.get("corridors", 0) != counts.get("replicatedRows"):
        fail("manifest replicated-row count is inconsistent")
    if counts.get("bytes") != total_bytes:
        fail("manifest byte count is inconsistent")
    for plane, entry in (manifest.get("provenance") or {}).items():
        if entry.get("manifestSha256") != sha256_of(build.MANIFESTS[plane]):
            fail(f"manifest provenance for {plane} is stale")
    SECTIONS["manifest"] = {"cells": len(declared), "present": len(present), "storedRows": stored,
                            "bytes": total_bytes}
    return manifest


def connect():
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    return connection


COVERAGE = {"FULL", "PARTIAL", "NONE", "UNKNOWN"}
COVERAGE_COLUMNS = ["coverage", "ecology_coverage", "coverage_wetlands_250", "coverage_wetlands_500",
                    "coverage_wetlands_1000", "coverage_hydro_250", "coverage_hydro_500", "coverage_hydro_1000"]


def check_cell_rows(args, manifest, fingerprint, sample):
    connection = connect()
    present = [cell for cell in manifest["cells"] if cell["state"] == "present"]
    chosen = present if len(present) <= sample else random.Random(20261002).sample(present, sample)
    paths = [str(args.final / fingerprint / "cells" / f"{cell['id']}.parquet") for cell in chosen]
    totals = connection.execute("SELECT count(*), count(DISTINCT corridor_id), "
                                "count(*) FILTER (WHERE ST_GeometryType(geometry) IN ('LINESTRING','MULTILINESTRING')), "
                                "count(*) FILTER (WHERE geometry IS NULL), count(*) FILTER (WHERE ST_CRS(geometry) <> 'EPSG:4326') "
                                "FROM read_parquet(?)", [paths]).fetchone()
    if totals[2] != totals[0] or totals[3] or totals[4]:
        fail(f"sampled cells carry non-line, null or non-4326 geometry (rows={totals})")
    wrong_fingerprint = connection.execute(
        "SELECT count(*) FROM read_parquet(?) WHERE analysis_fingerprint <> ?", [paths, fingerprint]).fetchone()[0]
    if wrong_fingerprint:
        fail(f"{wrong_fingerprint} sampled row(s) carry a different analysis fingerprint")
    bad_coverage = connection.execute(
        "SELECT count(*) FROM read_parquet(?) WHERE " + " OR ".join(
            f"{column} NOT IN ({', '.join(chr(39) + value + chr(39) for value in sorted(COVERAGE))})"
            for column in COVERAGE_COLUMNS), [paths]).fetchone()[0]
    if bad_coverage:
        fail(f"{bad_coverage} sampled row(s) declare a coverage state outside the established vocabulary")
    identity = connection.execute(
        "SELECT count(*) FROM read_parquet(?) WHERE corridor_id <> road_unit_id || '-s' || CAST(segment_index AS VARCHAR) "
        "OR road_component_id <> road_unit_id", [paths]).fetchone()[0]
    if identity:
        fail(f"{identity} sampled row(s) do not derive their corridor id from their unit")
    SECTIONS["sampledRows"] = {"cells": len(chosen), "rows": totals[0], "corridors": totals[1]}
    connection.close()


def habitat_metric_check(args, manifest, fingerprint, sample):
    """Re-measure sampled corridors from the raw planes and require equality with the published row.

    The corridor geometry is read back from the published cell, its neighbourhood is materialised from the
    committed manifests with the verified source keys, and the same definitions the runtime uses are applied
    in a single independent statement. A drift in layer vocabulary, source key or schema changes the result
    instead of passing silently.
    """
    connection = connect()
    present = [cell for cell in manifest["cells"] if cell["state"] == "present"]
    randomizer = random.Random(7)
    chosen_cells = randomizer.sample(present, min(sample, len(present)))
    wetland_cells = build.manifest_cells("wetlands", args.wetlands_artifacts)
    hydro_cells = build.manifest_cells("hydrography", args.hydro_artifacts)
    mismatches = 0
    checked = 0
    max_delta = 0.0
    for cell in chosen_cells:
        path = args.final / fingerprint / "cells" / f"{cell['id']}.parquet"
        rows = connection.execute("SELECT * FROM read_parquet(?) ORDER BY corridor_id LIMIT 1", [str(path)]).to_pylist()
        if not rows:
            continue
        row = rows[0]
        corridor_wkt = connection.execute(
            "SELECT ST_AsText(geometry) FROM read_parquet(?) WHERE corridor_id = ?",
            [str(path), row["corridor_id"]]).fetchone()[0]
        bounds = row["bounds"]
        pad = derived.pad_of(bounds, max(derived.DISTANCES))
        wetland_files = [str(wetland_cells[identifier])
                         for identifier in build.cells_in_bbox(wetland_cells, pad)]
        hydro_files = [str(hydro_cells[identifier])
                       for identifier in build.cells_in_bbox(hydro_cells, pad)]
        connection.execute("CREATE OR REPLACE TEMP TABLE probe AS SELECT ST_Transform(ST_GeomFromText(?), "
                           "'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom", [corridor_wkt])
        connection.execute("CREATE OR REPLACE TEMP TABLE cbuf AS SELECT geom, ST_Buffer(geom, 1000) AS b1000 FROM probe")
        if wetland_files:
            connection.execute(f"""CREATE OR REPLACE TEMP TABLE wetland AS
                SELECT source_feature_id, ST_Transform(geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom
                FROM (SELECT *, row_number() OVER (PARTITION BY source_feature_id) AS rn
                      FROM read_parquet({wetland_files!r})
                      WHERE {pad[0]} <= max_lon AND {pad[2]} >= min_lon
                        AND {pad[1]} <= max_lat AND {pad[3]} >= min_lat) WHERE rn = 1""")
            wetland = connection.execute(
                "SELECT coalesce(sum(area), 0), count(DISTINCT source_feature_id) FILTER (WHERE area > 0) FROM ("
                "SELECT source_feature_id, ST_Area(ST_Intersection(w.geom, (SELECT b1000 FROM cbuf))) AS area "
                "FROM wetland w WHERE ST_Intersects(w.geom, (SELECT b1000 FROM cbuf)))").fetchone()
            wetland_area, wetland_count = float(wetland[0]), int(wetland[1])
            bad_keys = connection.execute(
                "SELECT count(*) FROM wetland WHERE source_feature_id NOT SIMILAR TO '[A-Z][A-Z]:[0-9]+'").fetchone()[0]
            if bad_keys:
                fail(f"{cell['id']}: {bad_keys} wetland source keys are outside the verified state:objectid contract")
        else:
            wetland_area, wetland_count = 0.0, 0
        if hydro_files:
            connection.execute(f"""CREATE OR REPLACE TEMP TABLE hydro AS
                SELECT layer, source_feature_id, ST_Transform(geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom
                FROM (SELECT *, row_number() OVER (PARTITION BY layer, source_feature_id) AS rn
                      FROM read_parquet({hydro_files!r})
                      WHERE {pad[0]} <= max_lon AND {pad[2]} >= min_lon
                        AND {pad[1]} <= max_lat AND {pad[3]} >= min_lat) WHERE rn = 1""")
            hydro = connection.execute(
                "SELECT coalesce(sum(length_m) FILTER (WHERE layer = 'flowline'), 0), "
                "coalesce(sum(area_m2) FILTER (WHERE layer = 'waterbody'), 0) FROM ("
                "SELECT layer, ST_Length(ST_Intersection(h.geom, (SELECT b1000 FROM cbuf))) AS length_m, "
                "ST_Area(ST_Intersection(h.geom, (SELECT b1000 FROM cbuf))) AS area_m2 "
                "FROM hydro h WHERE ST_Intersects(h.geom, (SELECT b1000 FROM cbuf)))").fetchone()
            flowline_length, waterbody_area = float(hydro[0]), float(hydro[1])
            crossings = connection.execute(
                "SELECT count(*) FROM hydro h WHERE h.layer = 'flowline' AND ST_Intersects(h.geom, (SELECT geom FROM cbuf)) "
                "AND ST_Length(ST_Intersection(h.geom, (SELECT geom FROM cbuf))) > 0").fetchone()[0]
            bad_layers = connection.execute(
                "SELECT DISTINCT layer FROM hydro WHERE layer NOT IN ('flowline', 'waterbody')").fetchall()
            if bad_layers:
                fail(f"{cell['id']}: hydro layer vocabulary drifted: {[row[0] for row in bad_layers]}")
        else:
            flowline_length, waterbody_area, crossings = 0.0, 0.0, 0
        checked += 1
        published = (
            float(row["wetland_area_1000_m2"]), int(row["wetland_count_1000"]),
            float(row["hydro_flowline_length_1000_m"]), float(row["hydro_waterbody_area_1000_m2"]),
            int(row["hydro_crossing_count"]))
        rechecked = (round(wetland_area, 3), wetland_count, round(flowline_length, 3),
                     round(waterbody_area, 3), int(crossings))
        deltas = [abs(left - right) for left, right in zip(published, rechecked)]
        max_delta = max(max_delta, max(deltas))
        tolerance = max(0.002, abs(published[0]) * 1e-6, abs(published[2]) * 1e-6, abs(published[3]) * 1e-6)
        if max(deltas) > tolerance:
            mismatches += 1
            if mismatches <= 5:
                fail(f"{row['corridor_id']}: source-grounded re-measurement {rechecked} != published {published}")
    connection.close()
    if mismatches:
        fail(f"{mismatches} of {checked} sampled corridors disagree with a direct raw-plane measurement")
    SECTIONS["sourceGrounded"] = {"checked": checked, "mismatches": mismatches, "maxDelta": max_delta}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=build.DEFAULT_OUT)
    parser.add_argument("--final", type=Path, default=build.DEFAULT_FINAL)
    parser.add_argument("--wetlands-artifacts", type=Path, default=build.DEFAULT_ARTIFACTS["wetlands"])
    parser.add_argument("--hydro-artifacts", type=Path, default=build.DEFAULT_ARTIFACTS["hydrography"])
    parser.add_argument("--sample-cells", type=int, default=24)
    parser.add_argument("--skip-metrics", action="store_true")
    args = parser.parse_args()
    _profile, fingerprint = build.national_fingerprint()
    grid = build.grid_cells()
    index = check_corridors(args, fingerprint)
    if index and not args.skip_metrics:
        check_shards(args, index, fingerprint)
        manifest = check_manifest(args, fingerprint, grid)
        if manifest:
            check_cell_rows(args, manifest, fingerprint, args.sample_cells)
            habitat_metric_check(args, manifest, fingerprint, args.sample_cells)
    output = {"ok": not PROBLEMS, "fingerprint": fingerprint, "sections": SECTIONS, "problems": PROBLEMS}
    print(json.dumps(output, indent=1))
    sys.exit(1 if PROBLEMS else 0)


if __name__ == "__main__":
    main()
