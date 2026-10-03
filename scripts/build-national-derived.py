#!/usr/bin/env python3
"""Build the national derived corridor-metrics plane from the four verified national source planes.

    uv run --python 3.12 --with duckdb --with shapely --with pyarrow --with pyproj \
        python3 scripts/build-national-derived.py --stage busybox

Stages, every one checkpointed and idempotent:

    lookup      (one process)   normalized road shards -> (county_fips, source_feature_id) provenance lookup
    corridors   (64 buckets)    national name index -> shared composition/segmentation -> corridor Parquet
    metrics     (deterministic 1-degree shards)  corridor x national habitat metrics, one row per corridor,
                                                 plus whole-row replication into the cells each row intersects
    finalize    (one process)   all shards complete -> one GeoParquet per national grid cell + manifest

Reuse rules, not restatements:

  * corridor identity, composition and segmentation are the shared runtime modules
    (scripts/compose-national-corridors.mjs -> src/roads/normalize.js, src/discovery/segment.js), driven by
    the same per-name unit stream the committed national segmentation used;
  * the metric statements are the regional builder's own statements (scripts/build-derived.py), composed
    from src/gis/habitat-metrics.js, applied per chunk with the same bounding-box prefilter;
  * the habitat identity contracts are the verified raw-plane contracts: wetlands dedupe on
    `source_feature_id`, hydrography on `(layer, source_feature_id)` with the runtime layer vocabulary
    `flowline`/`waterbody`;
  * the raw planes are read in place and never modified.

Working data lives on the build volume; nothing large is written to the repository or to /tmp.
"""
import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROAD_WORK = ROOT / "data/national-work"
LEXAR = Path("/Volumes/Lexar/roadnaturalist")


def _build_root():
    configured = os.environ.get("ROADNATURALIST_BUILD_VOLUME")
    if configured and Path(configured).is_dir():
        return Path(configured)
    if LEXAR.is_dir():
        return LEXAR
    return ROOT / "data/national-derived-work"


BUILD = _build_root()
DEFAULT_OUT = BUILD / "work/derived-national"
DEFAULT_FINAL = BUILD / "cells/derived/corridor-metrics"
os.environ.setdefault("DERIVED_WORK", str(DEFAULT_OUT / "scratch"))

import duckdb  # noqa: E402
import pyarrow as pa  # noqa: E402
import pyarrow.compute as pc  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
from importlib.machinery import SourceFileLoader  # noqa: E402
from shapely import wkb, wkt as shapely_wkt  # noqa: E402
from shapely.geometry import box, mapping  # noqa: E402

derived = SourceFileLoader("regional_derived_builder", str(ROOT / "scripts/build-derived.py")).load_module()
STEP = derived.STEP
DISTANCES = derived.DISTANCES
SHARD_STEP = 1.0
CORRIDOR_BUCKETS = 64

MANIFESTS = {
    "roads": ROOT / "data/national/road-manifest.json",
    "wetlands": ROOT / "data/national/wetland-manifest.json",
    "hydrography": ROOT / "data/national/hydro-manifest.json",
    "ecoregions": ROOT / "data/national/epa-manifest.json",
}
DEFAULT_ARTIFACTS = {
    "roads": ROOT / "data/national-work/artifacts/roads",
    "wetlands": BUILD / "work/nwi/artifacts/wetlands",
    "hydrography": BUILD / "work/nhd/artifacts/hydro",
    "ecoregions": BUILD / "cells/epa",
}
GRID = ROOT / "data/national/grid-conus-2025.json"
EPA_ARTIFACTS = {"3": DEFAULT_ARTIFACTS["ecoregions"] / "epa-conus-l3.parquet",
                 "4": DEFAULT_ARTIFACTS["ecoregions"] / "epa-conus-l4.parquet"}

# The pipeline digest: the shared semantics a checkpoint is built against. A fix to composition,
# segmentation, analytical geometry or the metric definition invalidates every affected checkpoint.
PIPELINE_FILES = (
    "scripts/build-national-derived.py", "scripts/compose-national-corridors.mjs",
    "src/discovery/segment.js", "src/discovery/units.js", "src/discovery/constants.js",
    "src/discovery/eligibility.js", "src/roads/normalize.js", "src/domain/analytical-geometry.js",
    "src/domain/line-repair.js", "src/domain/geometry.js", "src/gis/habitat-metrics.js",
    "src/gis/habitat-result.js",
)

ROW_FIELDS = [
    ("corridor_id", pa.string()), ("road_component_id", pa.string()), ("road_unit_id", pa.string()),
    ("name", pa.string()), ("normalized_name", pa.string()),
    ("geometry", pa.binary()), ("bounds", pa.list_(pa.float64())),
    ("length_m", pa.float64()), ("tiger_class", pa.string()),
    ("counties", pa.list_(pa.string())), ("county_names", pa.list_(pa.string())),
    ("road_ids", pa.list_(pa.string())), ("road_classes", pa.list_(pa.string())),
    ("source_feature_ids", pa.list_(pa.string())),
    ("segment_index", pa.int64()), ("segment_count", pa.int64()),
    ("geometry_repaired", pa.bool_()), ("geometry_repair_method", pa.string()),
    ("primary_l3_code", pa.string()), ("primary_l3_name", pa.string()), ("primary_l3_percent", pa.float64()),
    ("primary_l4_code", pa.string()), ("primary_l4_name", pa.string()), ("primary_l4_percent", pa.float64()),
    ("l3_count", pa.int64()), ("l4_count", pa.int64()), ("transition_count", pa.int64()),
    ("ecology_coverage", pa.string()),
    ("wetland_intersects", pa.bool_()), ("wetland_nearest_m", pa.float64()),
    ("wetland_area_250_m2", pa.float64()), ("wetland_area_500_m2", pa.float64()),
    ("wetland_area_1000_m2", pa.float64()),
    ("wetland_count_250", pa.int64()), ("wetland_count_500", pa.int64()), ("wetland_count_1000", pa.int64()),
    ("wetland_type_summary", pa.string()),
    ("hydro_crossing_count", pa.int64()), ("hydro_nearest_flowing_m", pa.float64()),
    ("hydro_nearest_standing_m", pa.float64()),
    ("hydro_flowline_length_1000_m", pa.float64()), ("hydro_waterbody_area_1000_m2", pa.float64()),
    ("hydro_summary", pa.string()),
    ("coverage", pa.string()),
    ("coverage_wetlands_250", pa.string()), ("coverage_wetlands_500", pa.string()),
    ("coverage_wetlands_1000", pa.string()),
    ("coverage_hydro_250", pa.string()), ("coverage_hydro_500", pa.string()),
    ("coverage_hydro_1000", pa.string()),
    ("analysis_fingerprint", pa.string()), ("road_length_m", pa.float64()),
]
ROW_SCHEMA = pa.schema([pa.field(name, kind) for name, kind in ROW_FIELDS])
PARTS_SCHEMA = pa.schema([pa.field(name, kind) for name, kind in ROW_FIELDS] + [pa.field("cell_id", pa.string())])
CORRIDOR_COLUMNS = ["corridor_id", "name", "name_key", "component_id", "unit_id", "component_index",
                    "component_count", "segment_index", "segment_count", "parts", "length_m",
                    "min_lon", "min_lat", "max_lon", "max_lat", "bounds", "unit_length_m", "feature_count",
                    "geometry_json", "geometry_wkt", "analysis_wkt", "geometry_repaired", "geometry_repair_method",
                    "source_feature_ids", "counties", "county_names", "road_ids", "road_classes"]


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(message):
    print(message, flush=True)


def sha256_of(path):
    value = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def canonical_json(value):
    if value is None or not isinstance(value, (dict, list)):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    keys = sorted(key for key, item in value.items() if item is not None)
    return "{" + ",".join(json.dumps(key) + ":" + canonical_json(value[key]) for key in keys) + "}"


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=1, sort_keys=True) + "\n")
    os.replace(temporary, path)


def pipeline_sha():
    value = hashlib.sha256()
    for relative in PIPELINE_FILES:
        value.update(sha256_of(ROOT / relative).encode())
    return value.hexdigest()


def load_manifest(plane):
    return json.loads(MANIFESTS[plane].read_text())


def grid_document():
    return json.loads(GRID.read_text())


def grid_cells():
    document = grid_document()
    return {cell["id"]: cell["bounds"] for cell in document["cells"]}


def manifest_cells(plane, artifacts):
    """Present cell id -> local artifact path, from the committed manifest and the plane's artifact tree."""
    value = load_manifest(plane)
    cells = {}
    for cell in value["cells"]:
        if cell["state"] != "present":
            continue
        if plane == "ecoregions":
            continue
        path = artifacts / f"{cell['id']}.parquet"
        if not path.exists():
            raise SystemExit(f"{plane}: declared present cell artifact is missing: {path}")
        cells[cell["id"]] = path
    return cells


def cells_in_bbox(cells, bounds, margin_cells=1):
    """Every grid cell id whose bounds intersect `bounds`, using the anchored 0.2 degree grid."""
    x0 = math.floor((bounds[0] + 180) / STEP) - margin_cells
    x1 = math.ceil((bounds[2] + 180) / STEP) + margin_cells
    y0 = math.floor((bounds[1] + 90) / STEP) - margin_cells
    y1 = math.ceil((bounds[3] + 90) / STEP) + margin_cells
    selected = []
    for x in range(x0, x1):
        for y in range(y0, y1):
            identifier = f"x{x}_y{y}"
            if identifier in cells:
                selected.append(identifier)
    return selected


def path_for(plane, cell, artifacts):
    if plane == "ecoregions":
        return artifacts / f"epa-conus-l{cell}.parquet"
    return artifacts / f"{cell}.parquet"


def shard_bounds(sx, sy):
    return [sx * SHARD_STEP, sy * SHARD_STEP, (sx + 1) * SHARD_STEP, (sy + 1) * SHARD_STEP]


def shard_list():
    bounds = grid_document()["bounds"]
    x0, x1 = math.floor(bounds[0] / SHARD_STEP), math.floor(bounds[2] / SHARD_STEP)
    y0, y1 = math.floor(bounds[1] / SHARD_STEP), math.floor(bounds[3] / SHARD_STEP)
    shards = []
    for sx in range(x0, x1 + 1):
        for sy in range(y0, y1 + 1):
            shards.append((f"sx{sx}_sy{sy}", sx, sy))
    return shards


def national_fingerprint():
    """The semantics a national derived artifact freezes: dataset versions + manifest digests + code."""
    profile = {
        "kind": "road-discovery-analysis-profile-national",
        "profileVersion": 3,
        "derivedSchemaVersion": 1,
        "region": {"id": "conus-2025", "version": load_manifest("roads")["version"],
                   "bounds": grid_document()["bounds"]},
        "sourcePlanes": {plane: {"version": load_manifest(plane).get("version") or load_manifest(plane).get("kind"),
                                 "manifestSha256": sha256_of(MANIFESTS[plane])}
                         for plane in ("roads", "wetlands", "hydrography", "ecoregions")},
        "grid": {"sha256": sha256_of(GRID), "cells": len(grid_cells())},
        "composition": "src/roads/normalize.js + src/discovery/segment.js",
        "analyticalGeometry": "src/domain/analytical-geometry.js (duplicate segments before probe)",
        "habitat": "src/gis/habitat-metrics.js feature-area-sum / clipped-length / distinct-count",
        "analysisDistancesM": list(DISTANCES),
        "metrics": {"wetlandArea": "feature-area-sum-v1", "hydrographyLength": "clipped-length-sum-v1",
                    "habitatCounts": "distinct-contributing-features-v1", "coverage": "extent-per-distance-v1",
                    "hydroNames": "sorted-distinct-first-40-v1"},
        "pipelineSha256": pipeline_sha(),
    }
    fingerprint = hashlib.sha256(canonical_json(profile).encode()).hexdigest()
    return {**profile, "fingerprint": fingerprint}, fingerprint


class NationalBuilder(derived.Builder):
    """The regional builder's own Builder, fed a national synthetic catalog and per-chunk national habitat."""

    def __init__(self, catalog, profile, region):
        super().__init__(catalog, profile, region)
        memory = os.environ.get("NATIONAL_DERIVED_MEMORY", "2GB")
        threads = os.environ.get("NATIONAL_DERIVED_THREADS", "2")
        self.con.execute(f"PRAGMA memory_limit='{memory}'")
        self.con.execute(f"PRAGMA threads={int(threads)}")

    def prepare_eco(self):
        parts = []
        for level in (3, 4):
            path = EPA_ARTIFACTS[str(level)]
            if not path.exists():
                raise SystemExit(f"national ecoregion artifact missing: {path}")
            parts.append(f"SELECT *, {level} AS level FROM read_parquet({str(path)!r})")
        self.con.execute("CREATE OR REPLACE TEMP TABLE eco AS " + " UNION ALL ".join(parts))

    def prepare_chunk_habitat(self, wetland_files, hydro_files, bounds):
        """Materialise the one chunk's habitat relations from the source cells that can contain a
        neighbourhood feature, deduplicated by the verified raw-plane keys and transformed once.

        The bounding-box clause is the same exact prefilter the runtime applies per corridor; selecting the
        cell files from the chunk's padded box is the file-level form of that prefilter.
        """
        pad = derived.pad_of(bounds, max(DISTANCES))
        if wetland_files:
            self.con.execute(f"""
              CREATE OR REPLACE TEMP TABLE wetland AS
              SELECT source_feature_id, attribute, wetland_type, min_lon, min_lat, max_lon, max_lat,
                     ST_Transform(geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom
              FROM (SELECT *, row_number() OVER (PARTITION BY source_feature_id) AS rn
                    FROM read_parquet({wetland_files!r})
                    WHERE {pad[0]} <= max_lon AND {pad[2]} >= min_lon
                      AND {pad[1]} <= max_lat AND {pad[3]} >= min_lat) WHERE rn = 1""")
        else:
            self.con.execute("""CREATE OR REPLACE TEMP TABLE wetland AS SELECT NULL::VARCHAR AS source_feature_id,
              NULL::VARCHAR AS attribute, NULL::VARCHAR AS wetland_type, NULL::DOUBLE AS min_lon,
              NULL::DOUBLE AS min_lat, NULL::DOUBLE AS max_lon, NULL::DOUBLE AS max_lat,
              NULL::GEOMETRY AS geom WHERE 1 = 0""")
        if hydro_files:
            self.con.execute(f"""
              CREATE OR REPLACE TEMP TABLE hydro AS
              SELECT layer, source_feature_id, name, feature_type_code, feature_type_label, water_class,
                     min_lon, min_lat, max_lon, max_lat,
                     ST_Transform(geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom
              FROM (SELECT *, row_number() OVER (PARTITION BY layer, source_feature_id) AS rn
                    FROM read_parquet({hydro_files!r})
                    WHERE {pad[0]} <= max_lon AND {pad[2]} >= min_lon
                      AND {pad[1]} <= max_lat AND {pad[3]} >= min_lat) WHERE rn = 1""")
        else:
            self.con.execute("""CREATE OR REPLACE TEMP TABLE hydro AS SELECT NULL::VARCHAR AS layer,
              NULL::VARCHAR AS source_feature_id, NULL::VARCHAR AS name, NULL::VARCHAR AS feature_type_code,
              NULL::VARCHAR AS feature_type_label, NULL::VARCHAR AS water_class, NULL::DOUBLE AS min_lon,
              NULL::DOUBLE AS min_lat, NULL::DOUBLE AS max_lon, NULL::DOUBLE AS max_lat,
              NULL::GEOMETRY AS geom WHERE 1 = 0""")

    def set_chunk(self, ids, bounds):
        """Restrict the corridor relations to one chunk. The habitat relations were already materialised
        for this chunk by `prepare_chunk_habitat`; the metric statements are the regional ones unchanged."""
        self.chunk_ids = list(ids)
        self.chunk_pad = derived.pad_of(bounds, max(DISTANCES))
        listing = ",".join(f"'{value}'" for value in ids)
        self.con.execute(f"CREATE OR REPLACE TEMP VIEW corridor AS SELECT * FROM corridor_all WHERE id IN ({listing})")
        distances = ", ".join(f"({int(value)})" for value in self.expressions["definition"]["distancesM"])
        self.con.execute("CREATE OR REPLACE TEMP TABLE buffer AS SELECT c.id AS id, d.distance_m AS distance_m, "
                         "ST_Buffer(c.geom, d.distance_m) AS geom FROM corridor c, "
                         f"(VALUES {distances}) AS d(distance_m)")


# ------------------------------------------------------------------ stages

def stage_lookup(args):
    output = args.out / "lookup"
    output.mkdir(parents=True, exist_ok=True)
    path = output / "road-lookup.parquet"
    checkpoint = output / "road-lookup.json"
    normalized = ROOT / "data/national-work/normalized"
    files = sorted(str(item) for item in normalized.glob("*.parquet"))
    if not files:
        raise SystemExit(f"no normalized road shards under {normalized}")
    digest = hashlib.sha256("\n".join(f"{Path(name).name}:{sha256_of(name)}" for name in files).encode()).hexdigest()
    if checkpoint.exists():
        previous = json.loads(checkpoint.read_text())
        if (previous.get("state") == "complete" and previous.get("inputSha256") == digest
                and previous.get("pipelineSha256") == pipeline_sha() and path.exists()
                and path.stat().st_size == previous.get("bytes") and sha256_of(path) == previous.get("sha256")):
            log(f"lookup reused: {previous['rows']} rows")
            return previous
    started = time.monotonic()
    con = duckdb.connect()
    temporary = path.with_suffix(".parquet.tmp")
    con.execute("CREATE TABLE lookup AS SELECT county_fips, source_feature_id, "
                "any_value(road_id) AS road_id, any_value(road_class) AS road_class, "
                "any_value(county_name) AS county_name FROM read_parquet(?) GROUP BY 1, 2", [files])
    rows = con.execute("SELECT count(*) FROM lookup").fetchone()[0]
    con.execute(f"COPY lookup TO '{temporary}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    con.close()
    os.replace(temporary, path)
    result = {"state": "complete", "rows": int(rows), "inputSha256": digest, "pipelineSha256": pipeline_sha(),
              "bytes": path.stat().st_size, "sha256": sha256_of(path),
              "wallSeconds": round(time.monotonic() - started, 3), "recordedAt": now()}
    atomic_json(checkpoint, result)
    log(f"lookup built: {rows} (county, feature) provenance rows")
    return result


def stage_corridors(args):
    import fcntl
    sys.path.insert(0, str(ROOT / "scripts"))
    import national_components  # noqa: E402

    components = SourceFileLoader("national_component_jobs", str(ROOT / "scripts/build-national-components.py")).load_module()
    segments = SourceFileLoader("national_segment_jobs", str(ROOT / "scripts/build-national-segments.py")).load_module()
    road_work = Path(args.road_work)
    input_sha, counties = components.source_key(road_work)
    # The component index is read-only once complete, but build_index still opens it for write. Serialize
    # that open across the parallel corridor workers so no worker can see a locked database, then read.
    lock_path = road_work / "components/.national-derived-index.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        conn, directory = components.build_index(road_work, input_sha, counties)
        fcntl.flock(lock, fcntl.LOCK_UN)
    output = args.out / "corridors"
    output.mkdir(parents=True, exist_ok=True)
    lookup = args.out / "lookup/road-lookup.parquet"
    if not lookup.exists():
        raise SystemExit("run --stage lookup first")
    node_sha = pipeline_sha()
    selected = parse_buckets(args)
    for bucket in selected:
        result = build_corridor_bucket(conn, directory, components, segments, bucket, input_sha, node_sha,
                                       output, lookup, args)
        log(json.dumps({"bucket": bucket, "corridors": result["counts"]["corridors"],
                        "bytes": result["bytes"], "wallSeconds": result["wallSeconds"]}))
    if all((output / f"corridors-{bucket:02d}.json").exists()
           and json.loads((output / f"corridors-{bucket:02d}.json").read_text()).get("state") == "complete"
           for bucket in range(CORRIDOR_BUCKETS)):
        index = corridor_index(output)
        atomic_json(output / "index.json", index)
        log(f"corridor index: {index['corridors']} corridors, sha256 {index['corridorsSha256'][:16]}...")


def stage_index(args):
    index = corridor_index(args.out / "corridors")
    atomic_json(args.out / "corridors/index.json", index)
    log(f"corridor index: {index['corridors']} corridors, sha256 {index['corridorsSha256'][:16]}... "
        f"({index['bytes']:,} bytes)")


def parse_buckets(args):
    if args.bucket is not None:
        return [args.bucket]
    if args.buckets:
        selected = []
        for token in args.buckets.split(","):
            if ":" in token:
                start, end = token.split(":")
                selected.extend(range(int(start), int(end)))
            else:
                selected.append(int(token))
        return sorted(set(selected))
    return list(range(CORRIDOR_BUCKETS))


def build_corridor_bucket(conn, directory, components, segments, bucket, input_sha, node_sha, output, lookup, args):
    checkpoint = output / f"corridors-{bucket:02d}.json"
    path = output / f"corridors-{bucket:02d}.parquet"
    previous = json.loads(checkpoint.read_text()) if checkpoint.exists() else {}
    if (previous.get("state") == "complete" and previous.get("inputSha256") == input_sha
            and previous.get("pipelineSha256") == node_sha and path.exists()
            and path.stat().st_size == previous.get("bytes") and sha256_of(path) == previous.get("sha256")):
        return previous
    started = time.monotonic()
    atomic_json(checkpoint, {"state": "running", "bucket": bucket, "inputSha256": input_sha,
                             "pipelineSha256": node_sha, "recordedAt": now()})
    raw = output / f"corridors-{bucket:02d}.ndjson.tmp"
    process = subprocess.Popen(["node", str(ROOT / "scripts/compose-national-corridors.mjs"), str(raw)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None, text=True, bufsize=1)
    try:
        sent = 0
        for key, group in components.each_name(conn, bucket):
            indexed = components.national_components.component_index(group, key, key.replace("-", " "), include_lines=True)
            by_id = {str(row["source_feature_id"]): row["county_fips"] for row in group}
            for unit in indexed:
                payload = {"id": unit["id"], "name": unit["name"], "nameKey": key,
                           "componentIndex": unit["componentIndex"], "componentCount": unit["componentCount"],
                           "sourceFeatureIds": unit["sourceFeatureIds"], "counties": unit["counties"],
                           "featureCount": unit["featureCount"], "sourceLines": unit["sourceLines"],
                           "featureMeta": [{"sourceFeatureId": str(feature), "countyFips": by_id.get(str(feature))}
                                           for feature in unit["sourceFeatureIds"]]}
                process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
                sent += 1
        process.stdin.close()
        summary = json.loads(process.stdout.read())
        if process.wait() != 0:
            raise ValueError(f"corridor composer failed for bucket {bucket}")
        if summary["units"] != sent:
            raise ValueError(f"composer unit count mismatch: sent {sent}, got {summary['units']}")
        counts = validate_bucket_against_segmentation(directory, bucket, raw)
        enrich_bucket(raw, path, lookup)
        raw.unlink(missing_ok=True)
        result = {"state": "complete", "bucket": bucket, "inputSha256": input_sha, "pipelineSha256": node_sha,
                  "bytes": path.stat().st_size, "sha256": sha256_of(path), "counts": {**summary, **counts},
                  "wallSeconds": round(time.monotonic() - started, 3), "recordedAt": now()}
        atomic_json(checkpoint, result)
        return result
    except Exception as error:
        if process.poll() is None:
            process.kill()
            process.wait()
        atomic_json(checkpoint, {"state": "failed", "bucket": bucket, "inputSha256": input_sha,
                                 "pipelineSha256": node_sha, "error": str(error), "recordedAt": now()})
        raise


def validate_bucket_against_segmentation(directory, bucket, corridor_ndjson):
    """Fail closed: the composed corridors must equal the committed segmentation exactly.

    Component ids are compared as multisets, not as a map. The committed id scheme can mint the same id for
    two different names (name `co-rd` component 62 and name `co-rd-c62` both become `drv1-co-rd-c62`); 64
    such collisions exist in the verified segmentation, and collapsing them in a map would read as a
    composition mismatch when the composition is in fact exact.
    """
    con = duckdb.connect()
    con.execute("LOAD spatial")
    con.execute(f"CREATE TEMP TABLE raw AS SELECT * FROM read_json_auto({str(corridor_ndjson)!r})")
    composed = {}
    # One entry per composed unit, not per published component id: two different names can mint the same id,
    # so grouping by componentId alone would merge two units the committed segmentation keeps separate.
    for identifier, _name_key, count in con.execute(
            "SELECT componentId, nameKey, count(*) FROM raw GROUP BY 1, 2").fetchall():
        composed.setdefault(identifier, []).append(int(count))
    units = con.execute("SELECT count(DISTINCT (componentId, nameKey)) FROM raw").fetchone()[0]
    con.close()
    expected = {}
    segmented_units = 0
    with open(directory / f"segments-{bucket:02d}.jsonl") as handle:
        for line in handle:
            record = json.loads(line)
            if record["corridorCount"]:
                expected.setdefault(record["id"], []).append(int(record["corridorCount"]))
                segmented_units += 1
    for identifier in sorted(set(expected) | set(composed)):
        left = sorted(expected.get(identifier, []))
        right = sorted(composed.get(identifier, []))
        if left != right:
            raise ValueError(f"bucket {bucket}: {identifier} composed corridor counts {right} but the committed "
                             f"segmentation declares {left}")
    return {"units": int(units), "segmentedUnits": segmented_units}


def enrich_bucket(raw, path, lookup):
    """Attach the published provenance (road ids, classes, county names) by the raw plane's own key, then
    write the corridor Parquet the metrics stage reads. The ordering of every list is sorted, so the same
    input composes byte-identical output."""
    con = duckdb.connect()
    con.execute("LOAD spatial")
    con.execute(f"CREATE TEMP TABLE raw AS SELECT * FROM read_json_auto({str(raw)!r})")
    con.execute(f"CREATE TEMP TABLE exploded AS SELECT r.id AS corridor_id, f.countyFips AS county_fips, "
                f"f.sourceFeatureId AS source_feature_id FROM raw r, UNNEST(r.sourceFeatureKeys) AS t(f)")
    con.execute(f"CREATE TEMP TABLE lookup AS SELECT * FROM read_parquet({str(lookup)!r})")
    unmatched = con.execute("SELECT count(*) FROM exploded e LEFT JOIN lookup l USING (county_fips, source_feature_id) "
                            "WHERE l.road_id IS NULL").fetchone()[0]
    if unmatched:
        raise ValueError(f"{unmatched} corridor source features have no normalized provenance row")
    con.execute("""CREATE TEMP TABLE provenance AS
        SELECT e.corridor_id, list_sort(list(DISTINCT l.road_id)) AS road_ids,
               list_sort(list(DISTINCT l.road_class)) AS road_classes,
               list_sort(list(DISTINCT l.county_name)) AS county_names
        FROM exploded e JOIN lookup l USING (county_fips, source_feature_id) GROUP BY e.corridor_id""")
    temporary = path.with_suffix(".parquet.tmp")
    con.execute(f"""COPY (
        SELECT r.id AS corridor_id, r.name, r.nameKey AS name_key, r.componentId AS component_id,
               r.unitId AS unit_id, r.componentIndex AS component_index, r.componentCount AS component_count,
               r.segmentIndex AS segment_index, r.segmentCount AS segment_count, r.parts, r.lengthM AS length_m,
               r.bounds[1] AS min_lon, r.bounds[2] AS min_lat, r.bounds[3] AS max_lon, r.bounds[4] AS max_lat,
               r.bounds, r.unitLengthM AS unit_length_m, r.featureCount AS feature_count,
               r.geometry AS geometry_json,
               ST_AsText(ST_GeomFromText(r.geometry)) AS geometry_wkt,
               CASE WHEN r.analysisGeometry IS NULL THEN NULL ELSE ST_AsText(ST_GeomFromText(r.analysisGeometry)) END
                   AS analysis_wkt,
               r.geometryRepaired AS geometry_repaired, r.geometryRepairMethod AS geometry_repair_method,
               r.sourceFeatureIds AS source_feature_ids, r.counties,
               p.road_ids, p.road_classes, p.county_names
        FROM raw r LEFT JOIN provenance p ON p.corridor_id = r.id ORDER BY r.id
        ) TO '{temporary}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
    con.close()
    os.replace(temporary, path)


def corridor_index(output):
    buckets = []
    corridors = 0
    bytes_total = 0
    for bucket in range(CORRIDOR_BUCKETS):
        checkpoint = json.loads((output / f"corridors-{bucket:02d}.json").read_text())
        if checkpoint.get("state") != "complete":
            raise ValueError(f"corridor bucket {bucket} is {checkpoint.get('state')}")
        buckets.append({"bucket": bucket, "sha256": checkpoint["sha256"], "bytes": checkpoint["bytes"],
                        "corridors": checkpoint["counts"]["corridors"]})
        corridors += checkpoint["counts"]["corridors"]
        bytes_total += checkpoint["bytes"]
    value = hashlib.sha256("\n".join(f"{item['bucket']}:{item['sha256']}" for item in buckets).encode()).hexdigest()
    collisions = published_id_collisions(output)
    return {"state": "complete", "buckets": buckets, "corridors": corridors, "bytes": bytes_total,
            "corridorsSha256": value, "pipelineSha256": pipeline_sha(),
            "identityCollisions": collisions["count"], "identityCollisionExamples": collisions["examples"],
            "recordedAt": now()}


def published_id_collisions(output):
    """The id scheme can mint one `drv1-...` id for two different names. The committed segmentation carries
    the same collisions; the derived plane keeps the published id and declares them instead of hiding them."""
    con = duckdb.connect()
    paths = [str(output / f"corridors-{bucket:02d}.parquet") for bucket in range(CORRIDOR_BUCKETS)]
    rows = con.execute("SELECT corridor_id, count(DISTINCT name_key), count(DISTINCT round(length_m, 3)) "
                       "FROM read_parquet(?) GROUP BY 1 HAVING count(DISTINCT name_key) > 1 "
                       "OR count(DISTINCT round(length_m, 3)) > 1 ORDER BY 1", [paths]).fetchall()
    con.close()
    return {"count": len(rows), "examples": [row[0] for row in rows[:8]]}


def load_corridor_index(out):
    path = out / "corridors/index.json"
    if not path.exists():
        raise SystemExit("corridor index missing; run --stage corridors to completion first")
    index = json.loads(path.read_text())
    if index.get("state") != "complete" or index.get("pipelineSha256") != pipeline_sha():
        raise SystemExit("corridor index is stale or incomplete")
    return index


def stage_metrics(args):
    index = load_corridor_index(args.out)
    profile, fingerprint = national_fingerprint()
    disks = {
        "wetlands": manifest_cells("wetlands", args.wetlands_artifacts),
        "hydrography": manifest_cells("hydrography", args.hydro_artifacts),
    }
    cells = grid_cells()
    out = args.out / "metrics"
    out.mkdir(parents=True, exist_ok=True)
    shards = shard_list()
    wanted = select_shards(args, shards)
    for number, (identifier, sx, sy) in enumerate(wanted):
        result = process_shard(identifier, sx, sy, args, index, profile, fingerprint, disks, cells)
        log(json.dumps({"shard": identifier, "done": number + 1, "of": len(wanted),
                        "corridors": result["corridors"], "rows": result["rows"],
                        "cellsTouched": len(result["cellsTouched"]), "wallSeconds": result["wallSeconds"]}))
    if len(wanted) == len(shards):
        atomic_json(out / "index.json", {"state": "complete", "shards": len(shards),
                                         "corridorsSha256": index["corridorsSha256"],
                                         "pipelineSha256": pipeline_sha(), "recordedAt": now()})


def select_shards(args, shards):
    if args.shard:
        wanted = []
        for identifier in args.shard:
            match = [entry for entry in shards if entry[0] == identifier]
            if not match:
                raise SystemExit(f"unknown shard {identifier}")
            wanted.append(match[0])
        return wanted
    if args.shard_range:
        start, end = (int(value) for value in args.shard_range.split(":"))
        return shards[start:end]
    return shards


def process_shard(identifier, sx, sy, args, index, profile, fingerprint, disks, cells):
    import pyarrow.parquet as pq

    out = args.out
    metrics_dir = out / "metrics"
    parts_dir = out / "parts"
    metrics_dir.mkdir(parents=True, exist_ok=True)
    parts_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = metrics_dir / f"shard-{identifier}.json"
    metrics_path = metrics_dir / f"shard-{identifier}.parquet"
    parts_path = parts_dir / f"shard-{identifier}.parquet"
    previous = json.loads(checkpoint_path.read_text()) if checkpoint_path.exists() else {}
    if (previous.get("state") == "complete" and previous.get("inputSha256") == index["corridorsSha256"]
            and previous.get("pipelineSha256") == pipeline_sha() and previous.get("fingerprint") == fingerprint):
        metrics_ok = (not previous["metrics"]) or (metrics_path.exists()
                      and metrics_path.stat().st_size == previous["metrics"]["bytes"]
                      and sha256_of(metrics_path) == previous["metrics"]["sha256"])
        parts_ok = (not previous["parts"]) or (parts_path.exists()
                    and parts_path.stat().st_size == previous["parts"]["bytes"]
                    and sha256_of(parts_path) == previous["parts"]["sha256"])
        if metrics_ok and parts_ok:
            return previous
    started = time.monotonic()
    atomic_json(checkpoint_path, {"state": "running", "shard": identifier, "inputSha256": index["corridorsSha256"],
                                  "pipelineSha256": pipeline_sha(), "fingerprint": fingerprint, "recordedAt": now()})
    bounds = shard_bounds(sx, sy)
    try:
        corridor_paths = [str(args.out / "corridors" / f"corridors-{bucket:02d}.parquet")
                          for bucket in range(CORRIDOR_BUCKETS)]
        filters = [("min_lon", ">=", bounds[0]), ("min_lon", "<", bounds[2]),
                   ("min_lat", ">=", bounds[1]), ("min_lat", "<", bounds[3])]
        table = pq.read_table(corridor_paths, filters=filters, columns=CORRIDOR_COLUMNS)
        if table.num_rows == 0:
            result = {"state": "complete", "shard": identifier, "bounds": bounds, "corridors": 0, "rows": 0,
                      "cellsTouched": {}, "chunks": 0, "metrics": None, "parts": None, "refused": 0,
                      "unusable": 0, "duplicateRepairs": 0, "inputSha256": index["corridorsSha256"],
                      "pipelineSha256": pipeline_sha(), "fingerprint": fingerprint,
                      "wallSeconds": round(time.monotonic() - started, 3), "recordedAt": now()}
            atomic_json(checkpoint_path, result)
            return result
        corridors = [corridor_record(row) for row in table.to_pylist()]
        # Published corridor ids are not globally unique (the committed id scheme can mint one id for two
        # different names). Every internal relation is keyed by a unique work id so two colliding corridors
        # in one shard can never overwrite each other; the published id is restored on every emitted row.
        published_ids = {}
        for corridor in corridors:
            published_ids[corridor["work_id"]] = corridor["id"]
            corridor["id"] = corridor["work_id"]
        catalog = {
            "version": "conus-2025-v1",
            "region": {"id": "conus-2025", "bounds": grid_document()["bounds"]},
            "grid": grid_document()["partitionScheme"], "assetBaseUrl": "",
            "roadComponentsSha256": index["corridorsSha256"],
            "datasets": [
                {"id": "roads", "version": load_manifest("roads")["version"]},
                {"id": "wetlands", "version": load_manifest("wetlands")["version"]},
                {"id": "hydrography", "version": load_manifest("hydrography")["version"]},
            ],
        }
        builder = NationalBuilder(catalog, profile, "conus-2025")
        builder.prepare_eco()
        builder.analytical = {}
        duplicate_repairs = 0
        for corridor in corridors:
            repaired = bool(corridor["geometry_repaired"])
            method = corridor["geometry_repair_method"] or "none"
            duplicate_repairs += 1 if repaired else 0
            builder.analytical[corridor["id"]] = {
                "wkt": corridor["analysis_wkt"] or corridor["geometry_wkt"],
                "method": method, "repaired": repaired}
        failing = builder.failing([(corridor["id"], builder.analytical[corridor["id"]]["wkt"])
                                   for corridor in corridors])
        refused = 0
        if failing:
            refused = len(failing)
            refused_ids = set(failing)
            requested = [corridor for corridor in corridors if corridor["id"] in refused_ids]
            repair = builder.prepare_analysis_geometry(requested, failing)
            if repair["unusable"]:
                raise ValueError(f"shard {identifier}: {len(repair['unusable'])} corridors are unusable for "
                                 f"buffered analysis and no point-preserving repair was accepted: "
                                 f"{repair['unusable'][:5]}")
        builder.load_corridors(corridors, builder.analytical)
        ordered = sorted(corridors, key=lambda item: (math.floor(item["bounds"][0] / STEP),
                                                      math.floor(item["bounds"][1] / STEP), item["id"]))
        rows = []
        chunk_size = int(os.environ.get("NATIONAL_DERIVED_CHUNK", "25"))
        chunks = 0
        for start in range(0, len(ordered), chunk_size):
            chunk = ordered[start:start + chunk_size]
            chunk_bounds = [min(item["bounds"][0] for item in chunk), min(item["bounds"][1] for item in chunk),
                            max(item["bounds"][2] for item in chunk), max(item["bounds"][3] for item in chunk)]
            pad = derived.pad_of(chunk_bounds, max(DISTANCES))
            wetland_files = [str(disks["wetlands"][cell]) for cell in cells_in_bbox(disks["wetlands"], pad)]
            hydro_files = [str(disks["hydrography"][cell]) for cell in cells_in_bbox(disks["hydrography"], pad)]
            builder.prepare_chunk_habitat(wetland_files, hydro_files, chunk_bounds)
            builder.set_chunk([item["id"] for item in chunk], chunk_bounds)
            rows.extend(builder.derived_rows(chunk))
            chunks += 1
        for row in rows:
            row["corridor_id"] = published_ids[row["corridor_id"]]
        cells_touched = replicate_rows(rows, cells, parts_path)
        write_table(rows, ROW_SCHEMA, metrics_path)
        metrics_bytes = metrics_path.stat().st_size
        parts_bytes = parts_path.stat().st_size if parts_path.exists() else 0
        result = {"state": "complete", "shard": identifier, "bounds": bounds, "corridors": len(corridors),
                  "rows": len(rows), "chunks": chunks, "cellsTouched": cells_touched,
                  "refused": refused, "duplicateRepairs": duplicate_repairs,
                  "metrics": {"bytes": metrics_bytes, "sha256": sha256_of(metrics_path)},
                  "parts": ({"bytes": parts_bytes, "sha256": sha256_of(parts_path)} if parts_bytes else None),
                  "inputSha256": index["corridorsSha256"], "pipelineSha256": pipeline_sha(),
                  "fingerprint": fingerprint, "wallSeconds": round(time.monotonic() - started, 3),
                  "recordedAt": now()}
        atomic_json(checkpoint_path, result)
        builder.con.close()
        return result
    except Exception as error:
        atomic_json(checkpoint_path, {"state": "failed", "shard": identifier, "bounds": bounds,
                                      "inputSha256": index["corridorsSha256"], "pipelineSha256": pipeline_sha(),
                                      "fingerprint": fingerprint, "error": str(error), "recordedAt": now()})
        raise


def corridor_record(row):
    return {"id": row["corridor_id"], "work_id": f"{row['name_key']}|{row['corridor_id']}",
            "name": row["name"], "nameKey": row["name_key"],
            "componentId": row["component_id"], "unitId": row["unit_id"],
            "componentIndex": row["component_index"], "componentCount": row["component_count"],
            "segmentIndex": row["segment_index"], "segmentCount": row["segment_count"], "parts": row["parts"],
            "lengthM": row["length_m"], "bounds": list(row["bounds"]), "unitLengthM": row["unit_length_m"],
            "featureCount": row["feature_count"], "geometry": mapping(shapely_wkt.loads(row["geometry_wkt"])),
            "geometry_wkt": row["geometry_wkt"], "analysis_wkt": row["analysis_wkt"],
            "geometry_repaired": bool(row["geometry_repaired"]),
            "geometry_repair_method": row["geometry_repair_method"],
            "sourceFeatureIds": list(row["source_feature_ids"] or []), "counties": list(row["counties"] or []),
            "countyNames": list(row["county_names"] or []), "roadIds": list(row["road_ids"] or []),
            "roadClasses": list(row["road_classes"] or [])}


def replicate_rows(rows, cells, parts_path):
    """Whole-row replication: each row is written into every national grid cell its geometry intersects,
    exactly as the runtime selects cells. Returns {cell_id: rowCount}."""
    parts = {}
    for row in rows:
        geometry = wkb.loads(row["geometry"])
        bounds = row["bounds"]
        x0 = math.floor((bounds[0] + 180) / STEP)
        x1 = math.ceil((bounds[2] + 180) / STEP)
        y0 = math.floor((bounds[1] + 90) / STEP)
        y1 = math.ceil((bounds[3] + 90) / STEP)
        for x in range(x0, x1):
            for y in range(y0, y1):
                identifier = f"x{x}_y{y}"
                cell_bounds = cells.get(identifier)
                if cell_bounds is None:
                    continue
                if bounds[0] > cell_bounds[2] or bounds[2] < cell_bounds[0] \
                        or bounds[1] > cell_bounds[3] or bounds[3] < cell_bounds[1]:
                    continue
                if geometry.intersects(box(*cell_bounds)):
                    parts.setdefault(identifier, []).append(row)
    if not parts:
        return {}
    rows_with_cell = []
    for identifier in sorted(parts):
        for row in parts[identifier]:
            rows_with_cell.append({**row, "cell_id": identifier})
    write_table(rows_with_cell, PARTS_SCHEMA, parts_path)
    return {identifier: len(values) for identifier, values in sorted(parts.items())}


def write_table(rows, schema, path):
    table = pa.Table.from_pylist(rows, schema=schema)
    temporary = path.with_suffix(path.suffix + ".tmp")
    pq.write_table(table, temporary, compression="zstd")
    os.replace(temporary, path)


# ------------------------------------------------------------------ finalize

def stage_finalize(args):
    index = load_corridor_index(args.out)
    profile, fingerprint = national_fingerprint()
    cells = grid_cells()
    shards = shard_list()
    metrics_dir = args.out / "metrics"
    cell_parts = {}
    for identifier, _sx, _sy in shards:
        checkpoint_path = metrics_dir / f"shard-{identifier}.json"
        if not checkpoint_path.exists():
            raise SystemExit(f"finalize refused: shard {identifier} has no checkpoint")
        checkpoint = json.loads(checkpoint_path.read_text())
        if checkpoint.get("state") != "complete":
            raise SystemExit(f"finalize refused: shard {identifier} is {checkpoint.get('state')}")
        if checkpoint.get("inputSha256") != index["corridorsSha256"] or checkpoint.get("pipelineSha256") != pipeline_sha() \
                or checkpoint.get("fingerprint") != fingerprint:
            raise SystemExit(f"finalize refused: shard {identifier} is stale")
        parts_path = args.out / "parts" / f"shard-{identifier}.parquet"
        if checkpoint.get("parts") and not parts_path.exists():
            raise SystemExit(f"finalize refused: shard {identifier} part file is missing")
        for cell_id in checkpoint.get("cellsTouched", {}):
            cell_parts.setdefault(cell_id, []).append((identifier, parts_path))
    final_root = args.final / fingerprint
    final_dir = final_root / "cells"
    final_dir.mkdir(parents=True, exist_ok=True)
    progress_path = final_root / "finalize.json"
    progress = json.loads(progress_path.read_text()) if progress_path.exists() else {"cells": {}}
    if progress.get("pipelineSha256") != pipeline_sha() or progress.get("fingerprint") != fingerprint:
        progress = {"cells": {}}
    entries = []
    started = time.monotonic()
    for number, identifier in enumerate(sorted(cells)):
        cell_bounds = cells[identifier]
        sources = cell_parts.get(identifier, [])
        previous = progress["cells"].get(identifier)
        target = final_dir / f"{identifier}.parquet"
        if previous and target.exists() and target.stat().st_size == previous["bytes"] \
                and sha256_of(target) == previous["sha256"]:
            entries.append(previous["entry"])
            continue
        if not sources:
            entry = {"id": identifier, "bounds": cell_bounds, "state": "empty", "rowCount": 0}
            progress["cells"][identifier] = {"entry": entry, "bytes": 0, "sha256": None}
            entries.append(entry)
            continue
        table = pq.read_table([str(path) for _shard, path in sources],
                              columns=[name for name, _ in ROW_FIELDS] + ["cell_id"])
        table = table.filter(pc.equal(table.column("cell_id"), identifier))
        frame = table.drop(["cell_id"]).to_pylist()
        frame.sort(key=lambda row: row["corridor_id"])
        written = write_final_cell(frame, target)
        entry = {"id": identifier, "bounds": cell_bounds, "state": "present", "rowCount": written["featureCount"],
                 "url": f"derived/corridor-metrics/{fingerprint}/cells/{identifier}.parquet",
                 "bytes": target.stat().st_size, "sha256": sha256_of(target)}
        progress["cells"][identifier] = {"entry": entry, "bytes": entry["bytes"], "sha256": entry["sha256"]}
        entries.append(entry)
        if number % 500 == 0:
            progress["pipelineSha256"] = pipeline_sha()
            progress["fingerprint"] = fingerprint
            atomic_json(progress_path, progress)
            log(f"  finalized {number}/{len(cells)} cells, {time.monotonic() - started:.0f} s")
    progress["pipelineSha256"] = pipeline_sha()
    progress["fingerprint"] = fingerprint
    atomic_json(progress_path, progress)
    manifest = build_manifest(entries, cells, index, profile, fingerprint, args)
    manifest_path = final_root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=1) + "\n")
    log(f"manifest: {manifest_path} ({manifest_path.stat().st_size:,} bytes), fingerprint {fingerprint}")
    return manifest


def write_final_cell(rows, path):
    """The regional builder's GeoParquet contract, applied to a merged cell without opening DuckDB per
    cell. Geometry types and the bbox metadata come from the rows; a re-read proves the file parses."""
    columns = {key: [member[key] for member in rows] for key in rows[0]}
    geometry_types = sorted({wkb.loads(value).geom_type for value in columns["geometry"]})
    unknown = sorted(set(geometry_types) - set(derived.CORRIDOR_GEOMETRY_TYPES))
    if unknown:
        raise ValueError(f"{path.name}: unsupported corridor geometry {unknown}")
    bounds = columns["bounds"]
    table = pa.Table.from_pylist(rows, schema=ROW_SCHEMA)
    geo = {"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": {
        "encoding": "WKB", "geometry_types": geometry_types, "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "bbox": [min(value[0] for value in bounds), min(value[1] for value in bounds),
                 max(value[2] for value in bounds), max(value[3] for value in bounds)]}}}
    table = table.replace_schema_metadata({b"geo": json.dumps(geo, separators=(",", ":")).encode()})
    temporary = path.with_suffix(".parquet.tmp")
    pq.write_table(table, temporary, compression="zstd")
    os.replace(temporary, path)
    reread = pq.read_table(path)
    if reread.num_rows != len(rows) or b"geo" not in reread.schema.metadata:
        raise ValueError(f"{path.name}: GeoParquet round-trip failed")
    if any(value is None for value in reread.column("geometry").to_pylist()):
        raise ValueError(f"{path.name}: GeoParquet contains null geometry")
    return {"featureCount": int(reread.num_rows), "geometryTypes": geometry_types}


def build_manifest(entries, cells, index, profile, fingerprint, args):
    present = [entry for entry in entries if entry["state"] == "present"]
    stored_rows = sum(entry["rowCount"] for entry in entries)
    total_bytes = sum(entry.get("bytes", 0) for entry in entries)
    definition = derived.habitat_expressions()["definition"]
    return {
        "schemaVersion": 1, "kind": "road-derived-corridor-metrics",
        "analysisFingerprint": fingerprint, "derivedSchemaVersion": profile["derivedSchemaVersion"],
        "profileVersion": profile["profileVersion"],
        "region": {"id": "conus-2025", "version": "conus-grid-2025", "bounds": grid_document()["bounds"],
                   "publishedBounds": grid_document()["bounds"], "bounded": False},
        "grid": grid_document()["partitionScheme"], "assetBaseUrl": "",
        "geometry": {"encoding": "WKB", "crs": "EPSG:4326", "geometryTypes": ["LineString", "MultiLineString"],
                     "primaryColumn": "geometry", "partition": "whole corridor rows replicated; geometry never clipped",
                     "repair": "canonical geometry first, else the shared point-preserving repair ladder"},
        "schema": [name for name, _kind in ROW_FIELDS],
        "semantics": {**definition,
                      "coverage": "per distance against the declared CONUS grid extent",
                      "replication": "whole derived row replicated into every 0.2 degree cell its geometry intersects"},
        "counts": {"corridors": index["corridors"], "storedRows": stored_rows,
                   "replicatedRows": stored_rows - index["corridors"], "cells": len(cells),
                   "presentCells": len(present), "emptyCells": len(cells) - len(present), "bytes": total_bytes,
                   "averageRowBytes": round(total_bytes / stored_rows, 1) if stored_rows else 0},
        "cells": entries,
        "provenance": {plane: {"version": load_manifest(plane).get("version"),
                               "manifest": str(MANIFESTS[plane].relative_to(ROOT)),
                               "manifestSha256": sha256_of(MANIFESTS[plane])}
                       for plane in ("roads", "wetlands", "hydrography", "ecoregions")},
        "fingerprintProfile": profile,
        "build": {"pipelineVersion": "national-derived-corridor-metrics-v1", "corridorIndex": {
            "sha256": index["corridorsSha256"], "buckets": len(index["buckets"])}},
    }


def stage_status(args):
    index_path = args.out / "corridors/index.json"
    log(f"corridors index: {'present' if index_path.exists() else 'missing'}")
    if index_path.exists():
        index = json.loads(index_path.read_text())
        done = sum(1 for bucket in range(CORRIDOR_BUCKETS) if
                   (args.out / f"corridors/corridors-{bucket:02d}.json").exists()
                   and json.loads((args.out / f"corridors/corridors-{bucket:02d}.json").read_text()).get("state") == "complete")
        log(f"corridor buckets complete: {done}/{CORRIDOR_BUCKETS}, corridors={index.get('corridors')}")
    metrics = sorted((args.out / "metrics").glob("shard-*.json")) if (args.out / "metrics").exists() else []
    complete = failed = running = 0
    rows = 0
    for path in metrics:
        state = json.loads(path.read_text()).get("state")
        complete += state == "complete"
        failed += state == "failed"
        running += state == "running"
        if state == "complete":
            rows += json.loads(path.read_text()).get("rows", 0)
    log(f"shards: {complete} complete / {failed} failed / {running} running / {len(shard_list())} total; rows={rows}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", required=True,
                        choices=["lookup", "corridors", "index", "metrics", "finalize", "status"])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--final", type=Path, default=DEFAULT_FINAL)
    parser.add_argument("--road-work", type=Path, default=DEFAULT_ROAD_WORK)
    parser.add_argument("--wetlands-artifacts", type=Path, default=DEFAULT_ARTIFACTS["wetlands"])
    parser.add_argument("--hydro-artifacts", type=Path, default=DEFAULT_ARTIFACTS["hydrography"])
    parser.add_argument("--bucket", type=int, default=None)
    parser.add_argument("--buckets", default=None)
    parser.add_argument("--shard", action="append", default=None)
    parser.add_argument("--shard-range", default=None)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "scratch").mkdir(parents=True, exist_ok=True)
    derived.WORK = args.out / "scratch" / f"worker-{os.getpid()}"
    derived.WORK.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    if args.stage == "lookup":
        stage_lookup(args)
    elif args.stage == "corridors":
        stage_corridors(args)
    elif args.stage == "index":
        stage_index(args)
    elif args.stage == "metrics":
        stage_metrics(args)
    elif args.stage == "finalize":
        stage_finalize(args)
    elif args.stage == "status":
        stage_status(args)
    log(f"stage {args.stage} finished in {time.monotonic() - started:.1f} s")


if __name__ == "__main__":
    main()
