#!/usr/bin/env python3
"""Build resumable normalized NWI shards and a canonical 0.2 degree wetland plane."""
import argparse
import hashlib
import json
import os
import resource
import shutil
import sqlite3
import sys
import time
import urllib.request
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pyarrow.parquet as pq
from pyproj import CRS, Transformer
from shapely import wkb
from shapely.ops import transform

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import national_wetlands as nw  # noqa: E402

GRID_PATH = ROOT / "data/national/grid-conus-2025.json"
LOCK_PATH = ROOT / "data/national/nwi-state-lock.json"
DEFAULT_WORK = ROOT / "data/national-wetlands-work"
CHUNK_SIZE = 100_000


def load_inputs():
    grid = json.loads(GRID_PATH.read_text())
    lock = json.loads(LOCK_PATH.read_text())
    return grid, lock


def fetch_package(state, source, work):
    path = work / "sources" / source["filename"]
    if path.exists() and path.stat().st_size == source["bytes"] and nw.sha256_file(path) == source["sha256"]:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".zip.part")
    if shutil.disk_usage(work).free < source["bytes"] + 2 * 1024**3:
        raise OSError(f"{state} needs its pinned ZIP plus 2 GiB of disk headroom")
    request = urllib.request.Request(source["url"], headers={"User-Agent": "RoadNaturalist-NWI/1"})
    with urllib.request.urlopen(request, timeout=300) as response, temporary.open("wb") as output:
        shutil.copyfileobj(response, output, 4 * 1024 * 1024)
    if temporary.stat().st_size != source["bytes"] or nw.sha256_file(temporary) != source["sha256"]:
        raise ValueError(f"{state} source digest/bytes differ from the committed lock")
    temporary.replace(path)
    return path


def extract_package(state, source, archive, work):
    path = work / "extracted" / f"{state}.gpkg"
    checkpoint = work / "extracted" / f"{state}.json"
    with zipfile.ZipFile(archive) as bundle:
        member_bytes = bundle.getinfo(source["member"]).file_size
    prior = json.loads(checkpoint.read_text()) if checkpoint.exists() else {}
    if (path.exists() and prior.get("sourceSha256") == source["sha256"]
            and path.stat().st_size == member_bytes and nw.sha256_file(path) == prior.get("sha256")):
        return path
    if path.exists() and path.stat().st_size == member_bytes and not prior:
        # A prior build may have left a read-only hard link to the exact extracted member.
        # Verify against the pinned ZIP member without needing another full GeoPackage on disk.
        member_digest = hashlib.sha256()
        with zipfile.ZipFile(archive) as bundle, bundle.open(source["member"]) as incoming:
            for block in iter(lambda: incoming.read(4 * 1024 * 1024), b""):
                member_digest.update(block)
        if nw.sha256_file(path) == member_digest.hexdigest():
            nw.atomic_json(checkpoint, {"state": "complete", "sourceSha256": source["sha256"],
                                        "bytes": member_bytes, "sha256": member_digest.hexdigest()})
            return path
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".gpkg.tmp")
    if shutil.disk_usage(work).free < member_bytes + 2 * 1024**3:
        raise OSError(f"{state} needs its GeoPackage plus 2 GiB of disk headroom")
    with zipfile.ZipFile(archive) as bundle, bundle.open(source["member"]) as incoming, temporary.open("wb") as output:
        shutil.copyfileobj(incoming, output, 4 * 1024 * 1024)
    if temporary.stat().st_size != member_bytes:
        raise ValueError(f"{state} extracted GeoPackage byte count differs from ZIP member")
    temporary.replace(path)
    nw.atomic_json(checkpoint, {"state": "complete", "sourceSha256": source["sha256"],
                                "bytes": member_bytes, "sha256": nw.sha256_file(path)})
    return path


def inspect_source(state, path):
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    contents = connection.execute("SELECT table_name, data_type, srs_id FROM gpkg_contents WHERE data_type='features'").fetchall()
    layer = next((row for row in contents if row[0].lower() == f"{state}_wetlands".lower()), None)
    if not layer:
        raise ValueError(f"{state}: no {state}_Wetlands feature layer; found {contents}")
    columns = {row[1]: row[2] for row in connection.execute(f'PRAGMA table_info("{layer[0]}")')}
    required = {"OBJECTID", "ATTRIBUTE", "WETLAND_TYPE", "NWI_ID", "Shape"}
    if not required.issubset(columns):
        raise ValueError(f"{state}: schema lacks {sorted(required-columns.keys())}")
    geometry = connection.execute("SELECT column_name, geometry_type_name, srs_id FROM gpkg_geometry_columns WHERE table_name=?", (layer[0],)).fetchone()
    definition = connection.execute("SELECT definition FROM gpkg_spatial_ref_sys WHERE srs_id=?", (geometry[2],)).fetchone()[0]
    count = connection.execute(f'SELECT count(*) FROM "{layer[0]}"').fetchone()[0]
    nulls = connection.execute(f'SELECT sum(NWI_ID IS NULL OR trim(NWI_ID)=""), sum(ATTRIBUTE IS NULL), sum(WETLAND_TYPE IS NULL) FROM "{layer[0]}"').fetchone()
    samples = connection.execute(f'SELECT "{geometry[0]}" FROM "{layer[0]}" ORDER BY OBJECTID LIMIT 16').fetchall()
    sampled_shapes = [nw.gpkg_geometry(row[0]) for row in samples]
    rtree = connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (f"rtree_{layer[0]}_{geometry[0]}",)).fetchone()
    connection.close()
    crs = CRS.from_wkt(definition)
    authority = crs.to_authority()
    return {"layer": layer[0], "geometryColumn": geometry[0], "geometryType": geometry[1], "srsId": geometry[2],
            "crs": f"{authority[0]}:{authority[1]}" if authority else crs.to_string(), "crsWkt": crs.to_wkt(),
            "featureCount": count, "nullNwiId": nulls[0] or 0, "nullAttribute": nulls[1] or 0,
            "nullWetlandType": nulls[2] or 0, "rtree": bool(rtree), "columns": columns,
            "sampleGeometryTypes": sorted({shape.geom_type for shape in sampled_shapes}),
            "sampleInvalidGeometry": sum(not shape.is_valid for shape in sampled_shapes),
            "sampleEmptyGeometry": sum(shape.is_empty for shape in sampled_shapes)}


def source_bbox(inspection, lonlat_bbox):
    if lonlat_bbox is None:
        return None
    to_source = Transformer.from_crs(4326, CRS.from_wkt(inspection["crsWkt"]), always_xy=True)
    x0, y0, x1, y1 = lonlat_bbox
    points = [to_source.transform(x0 + (x1-x0)*i/4, y0 + (y1-y0)*j/4)
              for i in range(5) for j in range(5)]
    xs, ys = zip(*points)
    return [min(xs), min(ys), max(xs), max(ys)]


def normalize_chunk(state, path, inspection, chunk_index, start_objectid, work, selection_bbox=None):
    output = work / "normalized" / state / f"chunk-{chunk_index:05d}.parquet"
    checkpoint = work / "jobs" / state / f"chunk-{chunk_index:05d}.json"
    source_digest = json.loads(LOCK_PATH.read_text())["packages"][state]["sha256"]
    if checkpoint.exists() and output.exists():
        prior = json.loads(checkpoint.read_text())
        if (prior.get("state") == "complete" and prior.get("sourceSha256") == source_digest
                and prior.get("pipelineVersion") == nw.PIPELINE_VERSION
                and prior.get("selectionBBox") == selection_bbox and prior.get("outputSha256") == nw.sha256_file(output)):
            return prior
    nw.atomic_json(checkpoint, {"state": "running", "sourceSha256": source_digest,
                                "pipelineVersion": nw.PIPELINE_VERSION, "checkpointKey": f"{state}:{chunk_index}",
                                "selectionBBox": selection_bbox})
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    layer, shape = inspection["layer"], inspection["geometryColumn"]
    fields = {name.lower(): name for name in inspection["columns"]}
    qaqc = fields.get("qaqc_code")
    acres = fields.get("acres")
    fields_sql = f'w.OBJECTID,w.ATTRIBUTE,w.WETLAND_TYPE,{f"w.{qaqc}" if qaqc else "NULL"},{f"w.{acres}" if acres else "NULL"},w.NWI_ID,w."{shape}"'
    if selection_bbox is None:
        selected = connection.execute(f'SELECT {fields_sql} FROM "{layer}" w WHERE w.OBJECTID>? ORDER BY w.OBJECTID LIMIT ?',
                                      (start_objectid, CHUNK_SIZE)).fetchall()
    else:
        rtree = f'rtree_{layer}_{shape}'
        selected = connection.execute(
            f'SELECT {fields_sql} FROM "{layer}" w JOIN "{rtree}" r ON w.OBJECTID=r.id '
            'WHERE w.OBJECTID>? AND r.maxx>=? AND r.minx<=? AND r.maxy>=? AND r.miny<=? '
            'ORDER BY w.OBJECTID LIMIT ?',
            (start_objectid, selection_bbox[0], selection_bbox[2], selection_bbox[1], selection_bbox[3], CHUNK_SIZE)).fetchall()
    connection.close()
    transformer = Transformer.from_crs(CRS.from_wkt(inspection["crsWkt"]), 4326, always_xy=True)
    rows, invalid, empty, nonpolygon = [], 0, 0, 0
    for objectid, attribute, wetland_type, qaqc_code, acres_value, nwi_id, blob in selected:
        geometry = nw.polygonal(nw.gpkg_geometry(blob))
        if geometry is None:
            empty += 1
            continue
        if not geometry.is_valid:
            invalid += 1
        if geometry.geom_type != "MultiPolygon":
            nonpolygon += 1
            continue
        geometry_digest = nw.normalized_geometry_digest(geometry)
        semantic = nw.semantic_digest(str(nwi_id or ""), str(attribute or ""), str(wetland_type or ""), str(qaqc_code or ""), geometry_digest)
        lonlat = transform(transformer.transform, geometry)
        bounds = lonlat.bounds
        rows.append({"state": state, "objectid": int(objectid), "nwi_id": str(nwi_id or "").strip(),
                     "attribute": str(attribute or ""), "wetland_type": str(wetland_type or ""),
                     "qaqc_code": str(qaqc_code or ""), "source_acres": float(acres_value or 0),
                     "geometry_digest": geometry_digest, "semantic_digest": semantic,
                     "min_lon": bounds[0], "min_lat": bounds[1], "max_lon": bounds[2], "max_lat": bounds[3],
                     "geometry": wkb.dumps(lonlat, hex=False, output_dimension=2, byte_order=1)})
    schema = nw.pa.schema([(name, field.type) for name, field in zip(
        ["state", "objectid", "nwi_id", "attribute", "wetland_type", "qaqc_code", "source_acres", "geometry_digest", "semantic_digest",
         "min_lon", "min_lat", "max_lon", "max_lat", "geometry"],
        [nw.pa.field("a", nw.pa.string()), nw.pa.field("b", nw.pa.int64()), nw.pa.field("c", nw.pa.string()), nw.pa.field("d", nw.pa.string()),
         nw.pa.field("e", nw.pa.string()), nw.pa.field("f", nw.pa.string()), nw.pa.field("g", nw.pa.float64()), nw.pa.field("h", nw.pa.string()),
         nw.pa.field("i", nw.pa.string()), nw.pa.field("j", nw.pa.float64()), nw.pa.field("k", nw.pa.float64()), nw.pa.field("l", nw.pa.float64()),
         nw.pa.field("m", nw.pa.float64()), nw.pa.field("n", nw.pa.binary())])])
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    nw.pq.write_table(nw.pa.Table.from_pylist(rows, schema=schema), temporary, compression="zstd", row_group_size=16384)
    temporary.replace(output)
    result = {"state": "complete", "sourceSha256": source_digest, "pipelineVersion": nw.PIPELINE_VERSION,
              "selectionBBox": selection_bbox,
              "checkpointKey": f"{state}:{chunk_index}", "inputCount": len(selected), "outputCount": len(rows),
              "invalidGeometry": invalid, "emptyGeometry": empty, "nonPolygon": nonpolygon,
              "firstObjectid": selected[0][0] if selected else None, "lastObjectid": selected[-1][0] if selected else start_objectid,
              "outputBytes": output.stat().st_size, "outputSha256": nw.sha256_file(output)}
    nw.atomic_json(checkpoint, result)
    return result


def completed_state(state, source, work, lonlat_bbox):
    """Reuse a fully validated state without fetching or rescanning its GeoPackage."""
    path = work / "jobs" / state / "state.json"
    if not path.exists():
        return None
    report = json.loads(path.read_text())
    if (report.get("state") != "complete" or report.get("sourceSha256") != source["sha256"]
            or report.get("pipelineVersion") != nw.PIPELINE_VERSION
            or report.get("selectionLonLatBBox") != lonlat_bbox
            or not report.get("inspection", {}).get("rtree") or report.get("chunks", 0) < 1):
        return None
    counts = bytes_total = 0
    for index in range(report["chunks"]):
        output = work / "normalized" / state / f"chunk-{index:05d}.parquet"
        checkpoint = work / "jobs" / state / f"chunk-{index:05d}.json"
        if not output.exists() or not checkpoint.exists():
            return None
        entry = json.loads(checkpoint.read_text())
        if (entry.get("state") != "complete" or entry.get("sourceSha256") != source["sha256"]
                or entry.get("pipelineVersion") != nw.PIPELINE_VERSION
                or entry.get("selectionBBox") != report.get("selectionSourceBBox")
                or entry.get("outputBytes") != output.stat().st_size
                or entry.get("outputSha256") != nw.sha256_file(output)
                or entry.get("outputCount") != pq.read_metadata(output).num_rows):
            return None
        counts += entry["outputCount"]
        bytes_total += entry["outputBytes"]
    if counts != report.get("normalizedFeatures") or bytes_total != report.get("normalizedBytes"):
        return None
    return report


def build_state(state, source, work, cleanup, lonlat_bbox=None):
    prior = completed_state(state, source, work, lonlat_bbox)
    if prior:
        return prior
    state_path = work / "jobs" / state / "state.json"
    if state_path.exists():
        old = json.loads(state_path.read_text())
        if (old.get("sourceSha256") != source["sha256"]
                or old.get("pipelineVersion") != nw.PIPELINE_VERSION
                or old.get("selectionLonLatBBox") != lonlat_bbox):
            for stale in (work / "normalized" / state).glob("chunk-*.parquet"):
                stale.unlink()
            for stale in (work / "jobs" / state).glob("chunk-*.json"):
                stale.unlink()
            state_path.unlink()
    started = time.monotonic()
    archive = fetch_package(state, source, work)
    fetch_seconds = time.monotonic() - started
    path = extract_package(state, source, archive, work)
    extract_seconds = time.monotonic() - started - fetch_seconds
    inspection = inspect_source(state, path)
    inspect_seconds = time.monotonic() - started - fetch_seconds - extract_seconds
    selection = source_bbox(inspection, lonlat_bbox)
    normalize_started = time.monotonic()
    chunks, start, index = [], -1, 0
    while True:
        result = normalize_chunk(state, path, inspection, index, start, work, selection)
        chunks.append(result)
        if result["inputCount"] < CHUNK_SIZE:
            break
        start, index = result["lastObjectid"], index + 1
    report = {"state": "complete", "sourceSha256": source["sha256"], "pipelineVersion": nw.PIPELINE_VERSION,
              "selectionLonLatBBox": lonlat_bbox, "selectionSourceBBox": selection,
              "inspection": inspection, "chunks": len(chunks), "rawFeatures": sum(c["inputCount"] for c in chunks),
              "normalizedFeatures": sum(c["outputCount"] for c in chunks), "invalidGeometry": sum(c["invalidGeometry"] for c in chunks),
              "normalizedBytes": sum(c["outputBytes"] for c in chunks), "wallSeconds": round(time.monotonic()-started, 3),
              "fetchSeconds": round(fetch_seconds, 3), "extractSeconds": round(extract_seconds, 3),
              "inspectSeconds": round(inspect_seconds, 3),
              "normalizeSeconds": round(time.monotonic()-normalize_started, 3)}
    nw.atomic_json(work / "jobs" / state / "state.json", report)
    if cleanup:
        path.unlink(missing_ok=True)
        archive.unlink(missing_ok=True)
    return report


def main():
    invocation_started = time.monotonic()
    cpu_started = time.process_time()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--states", required=True, help="comma-separated state abbreviations")
    parser.add_argument("--workers", type=int, default=1, choices=range(1, 5))
    parser.add_argument("--cleanup-source", action="store_true")
    parser.add_argument("--bbox", help="bounded validation slice in EPSG:4326: minLon,minLat,maxLon,maxLat")
    args = parser.parse_args()
    _, lock = load_inputs()
    states = args.states.split(",")
    selection = [float(value) for value in args.bbox.split(",")] if args.bbox else None
    if selection and (len(selection) != 4 or selection[0] >= selection[2] or selection[1] >= selection[3]):
        raise ValueError("invalid --bbox")
    if any(state not in lock["packages"] for state in states):
        raise ValueError("every requested state must be present in the NWI source lock")
    args.work.mkdir(parents=True, exist_ok=True)
    totals = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(build_state, state, lock["packages"][state], args.work, args.cleanup_source, selection): state for state in states}
        for future in as_completed(futures):
            result = future.result()
            totals.append(result)
            print(json.dumps({"state": futures[future], "features": result["normalizedFeatures"], "seconds": result["wallSeconds"]}), flush=True)
    usage = resource.getrusage(resource.RUSAGE_SELF)
    print(json.dumps({"states": len(totals), "workers": args.workers,
                      "rawFeatures": sum(item["rawFeatures"] for item in totals),
                      "normalizedFeatures": sum(item["normalizedFeatures"] for item in totals),
                      "normalizedBytes": sum(item["normalizedBytes"] for item in totals),
                      "invocationSeconds": round(time.monotonic()-invocation_started, 3),
                      "processCpuSeconds": round(time.process_time()-cpu_started, 3),
                      "peakProcessRssBytes": usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss * 1024}))


if __name__ == "__main__":
    main()
