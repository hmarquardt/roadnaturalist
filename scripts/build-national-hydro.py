#!/usr/bin/env python3
"""Build the CONUS legacy NHD High Resolution hydrography plane from pinned HU8 staged extracts.

    python3 scripts/build-national-hydro.py --units 17090010,17090012          # normalize units
    python3 scripts/build-national-hydro.py --units ... --finalize             # + identity, cells, manifest

Checkpoint unit is the HU8 staged extract, which is the source's own partition: a killed build loses the unit it
was working on (minutes), never the completed ones. A unit checkpoint is reused only when its source digest,
pipeline version, selection and output bytes/SHA-256 all still agree, and its normalized rows are re-hashed
before reuse. The GDB is extracted, used and (with --cleanup-source) removed, so a large national run needs room
for a few units rather than for the whole 23.65 GB source set.

Identity, cell assignment and the manifest follow the wetland factory exactly: one canonical key per source
feature, whole-feature replication into every intersecting 0.2-degree cell, typed-empty cells only for cells whose
source coverage is complete, and unbuilt cells declared as unbuilt. See scripts/national_hydro.py for the
national hydro semantic contract.
"""
import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
import time
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import duckdb  # noqa: E402
import national_hydro as nh  # noqa: E402
import pyarrow as pa  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
from pyproj import Transformer  # noqa: E402
from shapely import force_2d  # noqa: E402
from shapely import wkb  # noqa: E402
from shapely.geometry import MultiLineString, MultiPolygon  # noqa: E402
from shapely.ops import transform  # noqa: E402
import build_volume as bv  # noqa: E402

LOCK_PATH = ROOT / "data/national/nhd-hr-hu8-lock.json"
GRID_PATH = ROOT / "data/national/grid-conus-2025.json"
MANIFEST_PATH = ROOT / "data/national/hydro-manifest.json"
DEFAULT_WORK = bv.work_dir("nhd", ROOT / "data/national-hydro-work")
AGENT = "RoadNaturalist-NHD/1"
# The unit output schema: the preserved source fields plus the identity ingredients and measured values.
UNIT_SCHEMA = pa.schema([
    ("unit", pa.string()), ("objectid", pa.int64()), ("layer", pa.string()), ("member", pa.string()),
    ("permanent_identifier", pa.string()), ("reach_code", pa.string()), ("gnis_name", pa.string()),
    ("ftype", pa.int64()), ("fcode", pa.int64()), ("water_class", pa.string()), ("visibility_filter", pa.string()),
    ("source_feature_date", pa.string()), ("resolution", pa.string()), ("source_length_km", pa.float64()),
    ("source_area_km2", pa.float64()), ("length_m", pa.float64()), ("area_m2", pa.float64()),
    ("geometry_digest", pa.string()), ("signature", pa.string()),
    ("min_lon", pa.float64()), ("min_lat", pa.float64()), ("max_lon", pa.float64()), ("max_lat", pa.float64()),
    ("geometry", pa.binary()),
])


def load_inputs():
    lock = json.loads(LOCK_PATH.read_text())
    grid = json.loads(GRID_PATH.read_text())
    return lock, grid


def fetch_unit(unit, source, work):
    """Verify the pinned archive, downloading it only when it is not already in the cache."""
    sources = work / "sources"
    sources.mkdir(parents=True, exist_ok=True)
    archive = sources / source["filename"]
    if not archive.exists():
        if shutil.disk_usage(work).free < source["bytes"] + 2 * 1024 ** 3:
            raise OSError(f"{unit} needs {source['bytes']:,} bytes plus 2 GiB headroom")
        temporary = archive.with_suffix(".part")
        request = urllib.request.Request(source["url"], headers={"User-Agent": AGENT})
        with urllib.request.urlopen(request, timeout=900) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output, 4 * 1024 * 1024)
        if temporary.stat().st_size != source["bytes"]:
            temporary.unlink(missing_ok=True)
            raise ValueError(f"{unit} download length mismatch")
        temporary.replace(archive)
    if archive.stat().st_size != source["bytes"] or nh.sha256_file(archive) != source["sha256"]:
        raise ValueError(f"{unit} archive differs from the committed lock")
    return archive


def extract_unit(unit, archive, work):
    """Extract the staged GDB once, reusing a previously verified extraction."""
    checkpoint = work / "extracted" / f"{unit}.json"
    root = work / "extracted" / unit
    if checkpoint.exists():
        prior = json.loads(checkpoint.read_text())
        if prior.get("state") == "complete" and prior.get("archiveSha256") == nh.sha256_file(archive):
            directory = root / prior["gdb"]
            if directory.exists():
                return directory
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as zip_file:
        zip_file.extractall(root)
    # Only a real directory is a file geodatabase: on ExFAT, macOS writes an AppleDouble sidecar beside it,
    # and a sidecar must never be mistaken for a second source.
    gdb = sorted(path for path in root.rglob("*.gdb") if path.is_dir() and bv.is_data_file(path))
    if len(gdb) != 1:
        raise ValueError(f"{unit} expected one file geodatabase, found {len(gdb)}")
    nh.atomic_json(checkpoint, {"state": "complete", "archiveSha256": nh.sha256_file(archive),
                                "gdb": gdb[0].name, "extractedBytes": sum(p.stat().st_size for p in root.rglob("*")
                                        if p.is_file() and bv.is_data_file(p))})
    return gdb[0]


def wrap_member(geometry, member):
    """One geometry family per member, so a partition relation is structurally consistent.

    The staged extracts carry four-ordinate (XYZM) geometry: NHD flowlines publish a linear measure in the M
    ordinate. The current Road Naturalist hydro semantics use horizontal position only, so X and Y are preserved
    exactly and the Z/M ordinates are dropped explicitly rather than left to fail a transform in three
    dimensions. No coordinate is moved, rounded or simplified.
    """
    if geometry is None or geometry.is_empty:
        return None
    geometry = force_2d(geometry)
    if member == "line":
        if geometry.geom_type == "LineString":
            return MultiLineString([geometry])
        if geometry.geom_type == "MultiLineString":
            return geometry
        parts = [item for item in getattr(geometry, "geoms", []) if item.geom_type == "LineString"]
        return MultiLineString(parts) if parts else None
    if geometry.geom_type == "Polygon":
        return MultiPolygon([geometry])
    if geometry.geom_type == "MultiPolygon":
        return geometry
    parts = [item for item in getattr(geometry, "geoms", []) if item.geom_type == "Polygon"]
    return MultiPolygon(parts) if parts else None


def normalize_unit(unit, source, work, gdb, cleanup):
    output = work / "normalized" / f"{unit}.parquet"
    checkpoint = work / "jobs" / f"{unit}.json"
    if checkpoint.exists() and output.exists():
        prior = json.loads(checkpoint.read_text())
        if (prior.get("state") == "complete" and prior.get("sourceSha256") == source["sha256"]
                and prior.get("pipelineVersion") == nh.PIPELINE_VERSION
                and prior.get("outputBytes") == output.stat().st_size
                and prior.get("outputSha256") == nh.sha256_file(output)
                and prior.get("outputRows") == pq.read_metadata(output).num_rows):
            return prior
    nh.atomic_json(checkpoint, {"state": "running", "sourceSha256": source["sha256"],
                                "pipelineVersion": nh.PIPELINE_VERSION, "checkpointKey": unit})
    started = time.monotonic()
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    to_stored = Transformer.from_crs(nh.SOURCE_CRS, nh.STORED_CRS, always_xy=True)
    to_analysis = Transformer.from_crs(nh.SOURCE_CRS, nh.ANALYSIS_CRS, always_xy=True)
    rows, stats = [], {"inputRows": 0, "outputRows": 0, "droppedEmpty": 0, "droppedOtherGeometry": 0,
                       "invalidGeometry": 0, "blankIdentity": 0, "lines": 0, "polygons": 0,
                       "lengthM": 0.0, "areaM2": 0.0}
    for layer, member in nh.LAYERS:
        source_length = "lengthkm" if member == "line" else "NULL::DOUBLE AS lengthkm"
        source_area = "areasqkm" if member == "polygon" else "NULL::DOUBLE AS areasqkm"
        query = f"""SELECT OBJECTID, permanent_identifier, reachcode, gnis_name, ftype, fcode, visibilityfilter,
                           fdate, resolution, {source_length}, {source_area}, ST_AsWKB(SHAPE)
                    FROM ST_Read('{gdb}', layer := '{layer}') ORDER BY OBJECTID"""
        for (objectid, identifier, reach_code, name, ftype, fcode, visibility, feature_date, resolution,
             length_km, area_km2, blob) in connection.execute(query).fetchall():
            stats["inputRows"] += 1
            if not blob:
                stats["droppedEmpty"] += 1
                continue
            source_shape = wrap_member(wkb.loads(bytes(blob)), member)
            if source_shape is None:
                stats["droppedOtherGeometry"] += 1
                continue
            if not source_shape.is_valid:
                stats["invalidGeometry"] += 1
            if not str(identifier or "").strip():
                stats["blankIdentity"] += 1
            digest = nh.geometry_digest(source_shape)
            signature = nh.attribute_signature(reach_code, name, ftype, fcode, length_km, area_km2, digest)
            measured = transform(to_analysis.transform, source_shape)
            stored = transform(to_stored.transform, source_shape)
            bounds = stored.bounds
            length_m = round(float(measured.length), 3) if member == "line" else None
            area_m2 = round(float(measured.area), 3) if member == "polygon" else None
            rows.append({"unit": unit, "objectid": int(objectid), "layer": layer, "member": member,
                         "permanent_identifier": str(identifier or "").strip(), "reach_code": str(reach_code or ""),
                         "gnis_name": str(name or ""), "ftype": int(ftype) if ftype is not None else None,
                         "fcode": int(fcode) if fcode is not None else None,
                         "water_class": nh.water_class(int(ftype) if ftype is not None else None),
                         "visibility_filter": str(visibility or ""),
                         "source_feature_date": str(feature_date)[:10] if feature_date else "",
                         "resolution": str(resolution or ""),
                         "source_length_km": float(length_km) if length_km is not None else None,
                         "source_area_km2": float(area_km2) if area_km2 is not None else None,
                         "length_m": length_m, "area_m2": area_m2, "geometry_digest": digest, "signature": signature,
                         "min_lon": bounds[0], "min_lat": bounds[1], "max_lon": bounds[2], "max_lat": bounds[3],
                         "geometry": wkb.dumps(stored, hex=False, output_dimension=2, byte_order=1)})
            stats["lines" if member == "line" else "polygons"] += 1
            if length_m:
                stats["lengthM"] += length_m
            if area_m2:
                stats["areaM2"] += area_m2
    connection.close()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    pq.write_table(pa.Table.from_pylist(rows, schema=UNIT_SCHEMA), temporary, compression="zstd", row_group_size=32768)
    temporary.replace(output)
    shutil.rmtree(gdb.parent, ignore_errors=True)
    (work / "extracted" / f"{unit}.json").unlink(missing_ok=True)
    if cleanup:
        (work / "sources" / source["filename"]).unlink(missing_ok=True)
    stats["outputRows"] = len(rows)
    stats["lengthM"] = round(stats["lengthM"], 1)
    stats["areaM2"] = round(stats["areaM2"], 1)
    result = {"state": "complete", "checkpointKey": unit, "unit": unit, "sourceSha256": source["sha256"],
              "pipelineVersion": nh.PIPELINE_VERSION, "outputBytes": output.stat().st_size,
              "outputSha256": nh.sha256_file(output), "outputRows": len(rows), "stats": stats,
              "wallSeconds": round(time.monotonic() - started, 3)}
    nh.atomic_json(checkpoint, result)
    return result


# ---------------------------------------------------------------- canonical identity

def build_identity(work, units):
    """Resolve cross-unit identity over the normalized units, fail-closed, exactly like the wetland rule."""
    started = time.monotonic()
    inputs = [work / "normalized" / f"{unit}.parquet" for unit in sorted(units)]
    input_digest = hashlib.sha256("\n".join(f"{path.name}:{nh.sha256_file(path)}" for path in inputs).encode()).hexdigest()
    db_path = work / "identity.sqlite"
    meta_path = work / "identity.json"
    if meta_path.exists() and db_path.exists():
        old = json.loads(meta_path.read_text())
        if (old.get("state") == "complete" and old.get("inputSha256") == input_digest
                and old.get("canonicalKeyVersion") == nh.CANONICAL_KEY_VERSION
                and old.get("dbSha256") == nh.sha256_file(db_path)):
            return old
    db_path.unlink(missing_ok=True)
    connection = sqlite3.connect(db_path)
    connection.executescript("""
      PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE feature(unit TEXT, member TEXT, objectid INTEGER, permanent_identifier TEXT,
                           geometry_digest TEXT, signature TEXT, PRIMARY KEY(unit, member, objectid));
      CREATE INDEX feature_id ON feature(member, permanent_identifier);
      CREATE TABLE mapping(unit TEXT, member TEXT, objectid INTEGER, canonical_key TEXT, owner INTEGER,
                           source_units TEXT, disposition TEXT, PRIMARY KEY(unit, member, objectid));
    """)
    raw = 0
    for unit in sorted(units):
        table = pq.read_table(work / "normalized" / f"{unit}.parquet",
                              columns=["unit", "member", "objectid", "permanent_identifier", "geometry_digest", "signature"])
        rows = zip(*(table.column(name).to_pylist() for name in table.column_names))
        connection.executemany("INSERT INTO feature VALUES(?,?,?,?,?,?)", rows)
        raw += table.num_rows
    connection.commit()
    connection.execute("""CREATE TABLE id_summary AS SELECT member, permanent_identifier, count(*) AS copies,
                             count(DISTINCT unit) AS unit_count, count(DISTINCT signature) AS signatures
                           FROM feature WHERE permanent_identifier <> '' GROUP BY member, permanent_identifier""")
    connection.execute("CREATE UNIQUE INDEX summary_id ON id_summary(member, permanent_identifier)")
    connection.create_function("local_key", 6, lambda member, unit, objectid, identifier, digest, signature:
                               nh.canonical_key(member, unit, objectid, identifier, digest, signature, conflict=True))
    connection.execute("""INSERT INTO mapping
        SELECT f.unit,f.member,f.objectid,'nhd-'||f.member||':'||f.permanent_identifier,1,f.unit,'unique'
        FROM feature f JOIN id_summary s ON f.member=s.member AND f.permanent_identifier=s.permanent_identifier
        WHERE s.copies=1""")
    connection.execute("""INSERT INTO mapping
        SELECT f.unit,f.member,f.objectid,local_key(f.member,f.unit,f.objectid,f.permanent_identifier,f.geometry_digest,f.signature),1,f.unit,'ambiguous'
        FROM feature f JOIN id_summary s ON f.member=s.member AND f.permanent_identifier=s.permanent_identifier
        WHERE s.copies>1 AND NOT (s.unit_count>1 AND s.copies=s.unit_count AND s.signatures=1)""")
    connection.execute("""INSERT INTO mapping
        SELECT f.unit,f.member,f.objectid,local_key(f.member,f.unit,f.objectid,'',f.geometry_digest,f.signature),1,f.unit,'blank-id'
        FROM feature f WHERE f.permanent_identifier=''""")
    suspect = connection.execute("""SELECT member, permanent_identifier, copies, unit_count, signatures FROM id_summary
                                   WHERE copies>1 AND unit_count>1 AND copies=unit_count AND signatures=1""").fetchall()
    duplicates = 0
    unit_pairs = defaultdict(int)
    for member, identifier, count, unit_count, signature_count in suspect:
        rows = connection.execute("""SELECT unit, objectid, geometry_digest, signature FROM feature
                                     WHERE member=? AND permanent_identifier=? ORDER BY unit,objectid""",
                                  (member, identifier)).fetchall()
        if not nh.duplicate_group_is_safe(rows):
            continue
        rows.sort(key=lambda row: (row[0], row[1]))
        owner = rows[0]
        key = nh.canonical_key(member, owner[0], owner[1], identifier, owner[2], owner[3])
        units_for = ",".join(row[0] for row in rows)
        for index, row in enumerate(rows):
            connection.execute("INSERT INTO mapping VALUES(?,?,?,?,?,?,?)",
                               (row[0], member, row[1], key, index == 0, units_for,
                                "canonical" if index == 0 else "duplicate"))
        duplicates += count - 1
        for left in range(len(rows)):
            for right in range(left + 1, len(rows)):
                unit_pairs[f"{rows[left][0]}/{rows[right][0]}"] += 1
    connection.commit()
    canonical = connection.execute("SELECT count(*) FROM mapping WHERE owner=1").fetchone()[0]
    ambiguous = connection.execute("SELECT count(*) FROM mapping WHERE disposition='ambiguous'").fetchone()[0]
    blank = connection.execute("SELECT count(*) FROM mapping WHERE disposition='blank-id'").fetchone()[0]
    connection.close()
    report = {"state": "complete", "pipelineVersion": nh.PIPELINE_VERSION,
              "canonicalKeyVersion": nh.CANONICAL_KEY_VERSION, "inputSha256": input_digest,
              "dbSha256": nh.sha256_file(db_path), "units": sorted(units), "rawRows": raw,
              "canonicalFeatures": canonical, "duplicatePackageCopies": duplicates, "ambiguousRows": ambiguous,
              "blankIdRows": blank, "unitPairs": dict(sorted(unit_pairs.items(), key=lambda item: (-item[1], item[0]))),
              "wallSeconds": round(time.monotonic() - started, 3)}
    nh.atomic_json(meta_path, report)
    return report


# ---------------------------------------------------------------- coverage and cells

def unit_coverage(unit, work, gdb):
    """The unit's own WBDHU8 polygon: the declaration that makes a typed empty cell exact rather than assumed."""
    path = work / "coverage" / f"{unit}.json"
    if path.exists():
        return json.loads(path.read_text())
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    rows = connection.execute(
        f"SELECT huc8, name, ST_AsWKB(SHAPE) FROM ST_Read('{gdb}', layer := 'WBDHU8')").fetchall()
    connection.close()
    if not rows:
        raise ValueError(f"{unit} declares no WBDHU8 coverage polygon")
    polygons = []
    for huc8, name, blob in rows:
        if blob:
            polygons.append(wkb.loads(bytes(blob)))
    if not polygons:
        raise ValueError(f"{unit} has no readable WBDHU8 geometry")
    stored = transform(Transformer.from_crs(nh.SOURCE_CRS, nh.STORED_CRS, always_xy=True).transform,
                       polygons[0] if len(polygons) == 1 else polygons[0].union(polygons[1]) if len(polygons) == 2
                       else __import__('shapely').union_all(polygons))
    value = {"unit": unit, "huc8": str(rows[0][0]), "name": rows[0][1], "bounds": list(stored.bounds),
             "geometry": wkb.dumps(stored, hex=True, output_dimension=2, byte_order=1)}
    nh.atomic_json(path, value)
    return value


def partition_units(work, units, cells):
    """Replicate every canonical whole feature into each intersecting 0.2-degree cell."""
    totals = {"units": 0, "replicatedRows": 0, "fragments": 0, "keys": 0}
    for unit in sorted(units):
        checkpoint = work / "partition-jobs" / f"{unit}.json"
        fragment = work / "fragments" / f"{unit}.parquet"
        normalized = work / "normalized" / f"{unit}.parquet"
        if checkpoint.exists() and fragment.exists():
            prior = json.loads(checkpoint.read_text())
            if (prior.get("state") == "complete" and prior.get("normalizedSha256") == nh.sha256_file(normalized)
                    and prior.get("fragmentBytes") == fragment.stat().st_size
                    and prior.get("fragmentSha256") == nh.sha256_file(fragment)):
                totals["units"] += 1
                totals["replicatedRows"] += prior["replicatedRows"]
                totals["fragments"] += len(prior["cells"])
                totals["keys"] += prior["canonicalKeys"]
                continue
        started = time.monotonic()
        canonical = {}
        connection = sqlite3.connect(work / "identity.sqlite")
        for unit_key, member, objectid, key, owner in connection.execute(
                "SELECT unit, member, objectid, canonical_key, owner FROM mapping WHERE unit=?", (unit,)):
            canonical[(member, objectid)] = (key, owner)
        connection.close()
        rows, cells_touched = [], set()
        for row in pq.read_table(normalized).to_pylist():
            entry = canonical.get((row["member"], row["objectid"]))
            if entry is None or not entry[1]:
                continue
            geometry = wkb.loads(row["geometry"])
            for cell_id in nh.member_cells(geometry, cells):
                cells_touched.add(cell_id)
                rows.append({"cell": cell_id, "feature": entry[0], **{key: row[key] for key in (
                    "permanent_identifier", "layer", "unit", "gnis_name", "ftype", "fcode", "water_class",
                    "reach_code", "source_feature_date", "resolution", "source_length_km", "source_area_km2",
                    "length_m", "area_m2", "geometry_digest", "min_lon", "min_lat", "max_lon", "max_lat",
                    "geometry")}})
        fragment.parent.mkdir(parents=True, exist_ok=True)
        temporary = fragment.with_suffix(".tmp")
        pq.write_table(pa.Table.from_pylist(rows), temporary, compression="zstd", row_group_size=32768)
        temporary.replace(fragment)
        record = {"state": "complete", "unit": unit, "pipelineVersion": nh.PIPELINE_VERSION,
                  "normalizedSha256": nh.sha256_file(normalized), "replicatedRows": len(rows),
                  "canonicalKeys": len({row["feature"] for row in rows}), "cells": sorted(cells_touched),
                  "fragmentBytes": fragment.stat().st_size, "fragmentSha256": nh.sha256_file(fragment),
                  "sourceUnits": sorted({row.get("unit") for row in rows}),
                  "wallSeconds": round(time.monotonic() - started, 3)}
        nh.atomic_json(checkpoint, record)
        totals["units"] += 1
        totals["replicatedRows"] += len(rows)
        totals["fragments"] += len(cells_touched)
        totals["keys"] += record["canonicalKeys"]
    return totals


def publication_version(units, complete):
    digest = hashlib.sha256(",".join(sorted(units)).encode()).hexdigest()[:12]
    return f"nhd-hr-hu8-2023-12-v1" if complete else f"nhd-hr-hu8-2023-12-v1-partial-{digest}"


def finalize(work, units, lock, grid):
    """Compact the replicated fragments into cells, dedupe by canonical key, and write the manifest."""
    started = time.monotonic()
    identity = build_identity(work, units)
    cells_meta = {cell["id"]: cell for cell in grid["cells"]}
    partition = partition_units(work, units, set(cells_meta))
    # Which units cover each cell, from the units' own declared boundaries: a cell may only be declared empty
    # when every unit that covers it has been processed. Everything else stays explicitly unbuilt.
    cell_units = defaultdict(set)
    for unit in sorted(units):
        coverage = json.loads((work / "coverage" / f"{unit}.json").read_text())
        polygon = wkb.loads(bytes.fromhex(coverage["geometry"]))
        for cell_id in nh.member_cells(polygon, set(cells_meta)):
            cell_units[cell_id].add(unit)
    owner_units = {}
    connection = sqlite3.connect(work / "identity.sqlite")
    for key, units_for in connection.execute("SELECT DISTINCT canonical_key, source_units FROM mapping WHERE owner=1"):
        owner_units[key] = units_for
    connection.close()
    # Cell -> contributing units and their fragment digests, read from the partition checkpoints rather than from
    # the fragments themselves, so a resumed compaction can decide what to rewrite without touching a fragment.
    cell_inputs = defaultdict(list)
    for unit in sorted(units):
        record = json.loads((work / "partition-jobs" / f"{unit}.json").read_text())
        for cell_id in record["cells"]:
            cell_inputs[cell_id].append((unit, record["fragmentSha256"]))
    priors = {}
    if MANIFEST_PATH.exists():
        prior_manifest = json.loads(MANIFEST_PATH.read_text())
        priors = {cell["id"]: cell for cell in prior_manifest.get("cells", []) if cell.get("state") == "present"}
    # A build is complete only when every CONUS unit of the measured inventory is pinned and built. A build
    # that covers every unit of a *pinned subset* is partial, and the manifest says so: the version also
    # carries a digest of the built set, so a partial object can never sit at the complete plane's key.
    inventory = json.loads((ROOT / "data/national/nhd-hr-hu8-inventory.json").read_text())
    complete = set(units) == set(lock["units"]) and lock["unitCount"] == inventory["conusUnits"]
    version = publication_version(units, complete)
    artifact_dir = work / "artifacts" / "hydro"
    cells, problems, reused = [], [], 0
    for cell_id, meta in cells_meta.items():
        covered = cell_units.get(cell_id, set())
        parts = cell_inputs.get(cell_id, [])
        if covered - set(units):
            cells.append({"id": cell_id, "bounds": meta["bounds"], "state": "unbuilt",
                          "missingUnits": sorted(covered - set(units))})
            continue
        if not parts:
            cells.append({"id": cell_id, "bounds": meta["bounds"], "state": "empty", "featureCount": 0, "storedRows": 0})
            continue
        input_sha = hashlib.sha256((nh.COMPACT_VERSION + "\n"
                                    + "\n".join(f"{unit}:{digest}" for unit, digest in sorted(parts))).encode()).hexdigest()
        url = f"national/hydro/{version}/hydro/{cell_id}.parquet"
        prior = priors.get(cell_id)
        artifact = artifact_dir / f"{cell_id}.parquet"
        # An unchanged cell is reused rather than rewritten: its inputs are the same fragment digests and its
        # artifact still hashes to what the previous manifest declared. This is what makes a national
        # compaction restartable instead of one fragile multi-hour job.
        if (prior and prior.get("inputSha256") == input_sha and artifact.exists()
                and artifact.stat().st_size == prior.get("bytes") and nh.sha256_file(artifact) == prior.get("sha256")):
            cells.append({**prior, "id": cell_id, "bounds": meta["bounds"], "url": url})
            reused += 1
            continue
        by_key = {}
        for unit, _digest in sorted(parts):
            for row in pq.read_table(work / "fragments" / f"{unit}.parquet",
                                     filters=[("cell", "=", cell_id)]).to_pylist():
                found = by_key.get(row["feature"])
                if found and found["geometry_digest"] != row["geometry_digest"]:
                    problems.append(f"canonical hydro geometry conflict {row['feature']} in {cell_id}")
                    continue
                by_key[row["feature"]] = row
        rows = [{"canonical_feature_id": key, "source_feature_id": by_key[key]["permanent_identifier"],
                 "layer": "flowline" if by_key[key]["layer"] == "NHDFlowline" else "waterbody", "source_unit": by_key[key]["unit"],
                 "source_units": owner_units.get(key, by_key[key]["unit"]),
                 "name": by_key[key]["gnis_name"], "feature_type_code": str(by_key[key]["ftype"] or ""),
                 "feature_type_label": nh.feature_type_label(by_key[key]["ftype"]),
                 "feature_code": str(by_key[key]["fcode"] or ""), "water_class": by_key[key]["water_class"],
                 "reach_code": by_key[key]["reach_code"], "source_feature_date": by_key[key]["source_feature_date"],
                 "resolution": by_key[key]["resolution"], "source_length_km": by_key[key]["source_length_km"],
                 "source_area_km2": by_key[key]["source_area_km2"], "length_m": by_key[key]["length_m"],
                 "area_m2": by_key[key]["area_m2"], "geometry_digest": by_key[key]["geometry_digest"],
                 "min_lon": by_key[key]["min_lon"], "min_lat": by_key[key]["min_lat"],
                 "max_lon": by_key[key]["max_lon"], "max_lat": by_key[key]["max_lat"],
                 "geometry": by_key[key]["geometry"]} for key in sorted(by_key)]
        result = nh.write_geoparquet(rows, artifact)
        cells.append({"id": cell_id, "bounds": meta["bounds"], "state": "present", "featureCount": len(rows),
                      "storedRows": len(rows), "url": url, "inputSha256": input_sha, **result})
    manifest = {"schemaVersion": 1, "kind": "national-hydrography", "version": version,
                "coverage": grid["coverage"], "buildCoverage": "complete" if complete else "partial",
                "builtUnits": sorted(units), "pinnedUnits": lock["unitCount"], "conusUnits": inventory["conusUnits"], "unpinnedConusUnits": inventory["conusUnits"] - lock["unitCount"],
                "gridSha256": nh.sha256_file(GRID_PATH),
                "sourceLockSha256": nh.sha256_file(LOCK_PATH), "pipelineVersion": nh.PIPELINE_VERSION,
                "canonicalKeyVersion": nh.CANONICAL_KEY_VERSION, "partitionScheme": grid["partitionScheme"],
                "source": {"dataset": lock["dataset"], "unitCount": lock["unitCount"],
                           "totalBytes": lock["totalBytes"], "inventory": "data/national/nhd-hr-hu8-inventory.json"},
                "schema": [{"name": field.name, "type": str(field.type)} for field in nh.SCHEMA],
                "counts": {"rawRows": identity["rawRows"], "canonicalFeatures": identity["canonicalFeatures"],
                           "duplicatePackageCopies": identity["duplicatePackageCopies"],
                           "ambiguousRows": identity["ambiguousRows"], "cells": len(cells),
                           "present": sum(cell["state"] == "present" for cell in cells),
                           "empty": sum(cell["state"] == "empty" for cell in cells),
                           "unbuilt": sum(cell["state"] == "unbuilt" for cell in cells),
                           "storedRows": sum(cell.get("storedRows", 0) for cell in cells),
                           "artifactBytes": sum(cell.get("bytes", 0) for cell in cells)},
                "cells": cells}
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    nh.atomic_json(work / "build-benchmark.json", {"identitySeconds": identity["wallSeconds"],
        "fragments": partition["fragments"], "reusedCells": reused,
        "totalSeconds": round(time.monotonic() - started, 3)})
    print(json.dumps({"problems": problems[:5], "reusedCells": reused, "counts": manifest["counts"]}, indent=1))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--units", required=True, help="comma-separated pinned HUC8 units")
    parser.add_argument("--workers", type=int, default=1, choices=range(1, 5))
    parser.add_argument("--cleanup-source", action="store_true", help="drop each verified archive after normalization")
    parser.add_argument("--finalize", action="store_true", help="resolve identity, replicate cells and write the manifest")
    args = parser.parse_args()
    lock, grid = load_inputs()
    units = args.units.split(",")
    unknown = [unit for unit in units if unit not in lock["units"]]
    if unknown:
        raise SystemExit(f"units are not pinned in the NHD lock: {unknown}")
    args.work.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    results = []
    for unit in units:
        source = lock["units"][unit]
        archive = fetch_unit(unit, source, args.work)
        gdb = extract_unit(unit, archive, args.work)
        unit_coverage(unit, args.work, gdb)
        result = normalize_unit(unit, source, args.work, gdb, args.cleanup_source)
        results.append(result)
        print(json.dumps({"unit": unit, "rows": result["outputRows"], "bytes": result["outputBytes"],
                          "lines": result["stats"]["lines"], "polygons": result["stats"]["polygons"],
                          "invalidGeometry": result["stats"]["invalidGeometry"],
                          "wallSeconds": result["wallSeconds"]}), flush=True)
    print(json.dumps({"normalizedUnits": len(results),
                      "rows": sum(result["outputRows"] for result in results),
                      "wallSeconds": round(time.monotonic() - started, 3)}))
    if args.finalize:
        finalize(args.work, units, lock, grid)


if __name__ == "__main__":
    main()
