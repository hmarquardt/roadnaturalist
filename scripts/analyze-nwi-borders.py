#!/usr/bin/env python3
"""Inspect real NWI package overlap at selected CONUS state borders."""
import argparse
import importlib.machinery
import json
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

from pyproj import CRS, Transformer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import national_wetlands as nw  # noqa: E402
builder = importlib.machinery.SourceFileLoader("national_wetland_builder", str(ROOT / "scripts/build-national-wetlands.py")).load_module()

DEFAULT_WORK = ROOT / "data/national-wetlands-work"
REPORT = ROOT / "data/national/nwi-border-analysis.json"
BORDERS = {
    "OR/WA": [-124.3, 45.45, -116.7, 46.35],
    "CA/OR": [-123.6, 41.75, -122.5, 42.25],
    "NV/CA": [-120.15, 38.7, -119.65, 39.3],
    "TX/LA": [-94.25, 30.65, -93.55, 31.25],
    "FL/GA": [-84.7, 30.45, -83.7, 31.05],
    "NY/NJ": [-74.55, 40.75, -73.85, 41.25],
    "PA/OH": [-80.75, 40.45, -80.15, 41.05],
}


def rows_in_bbox(state, path, inspection, bbox):
    transformer = Transformer.from_crs(4326, CRS.from_wkt(inspection["crsWkt"]), always_xy=True)
    corners = [transformer.transform(x, y) for x in (bbox[0], bbox[2]) for y in (bbox[1], bbox[3])]
    xs, ys = zip(*corners)
    source_bbox = (min(xs), min(ys), max(xs), max(ys))
    layer, shape = inspection["layer"], inspection["geometryColumn"]
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    fields = {row[1].lower(): row[1] for row in connection.execute(f'PRAGMA table_info("{layer}")')}
    qaqc = f'w."{fields["qaqc_code"]}"' if fields.get("qaqc_code") else "NULL"
    selected = connection.execute(
        f'SELECT w.OBJECTID,w.NWI_ID,w.ATTRIBUTE,w.WETLAND_TYPE,{qaqc},w."{shape}" FROM "{layer}" w '
        f'JOIN "rtree_{layer}_{shape}" r ON w.OBJECTID=r.id WHERE r.maxx>=? AND r.minx<=? AND r.maxy>=? AND r.miny<=? ORDER BY w.OBJECTID',
        (source_bbox[0], source_bbox[2], source_bbox[1], source_bbox[3])).fetchall()
    connection.close()
    output = []
    for objectid, nwi_id, attribute, wetland_type, qaqc_code, blob in selected:
        geometry = nw.polygonal(nw.gpkg_geometry(blob))
        if geometry is None:
            continue
        geometry_digest = nw.normalized_geometry_digest(geometry)
        semantic = nw.semantic_digest(str(nwi_id or ""), str(attribute or ""), str(wetland_type or ""), str(qaqc_code or ""), geometry_digest)
        output.append({"state": state, "objectid": objectid, "nwiId": str(nwi_id or "").strip(),
                       "attribute": str(attribute or ""), "wetlandType": str(wetland_type or ""),
                       "geometryDigest": geometry_digest, "semanticDigest": semantic})
    return output


def analyze_pair(label, work, lock, cleanup):
    states = label.split("/")
    by_state = {}
    schemas = {}
    for state in states:
        source = lock["packages"][state]
        archive = builder.fetch_package(state, source, work)
        gpkg = builder.extract_package(state, source, archive, work)
        inspection = builder.inspect_source(state, gpkg)
        schemas[state] = {key: inspection[key] for key in ("layer", "geometryType", "crs", "featureCount",
                    "nullNwiId", "nullAttribute", "nullWetlandType", "rtree", "columns")}
        by_state[state] = rows_in_bbox(state, gpkg, inspection, BORDERS[label])
    left, right = states
    left_ids, right_ids = defaultdict(list), defaultdict(list)
    for row in by_state[left]: left_ids[row["nwiId"]].append(row)
    for row in by_state[right]: right_ids[row["nwiId"]].append(row)
    shared = sorted((set(left_ids) & set(right_ids)) - {""})
    exact = ambiguous = same_id_different_geometry = same_id_different_attributes = repeated_id_within_package = 0
    examples = []
    for identifier in shared:
        signatures_left = {row["semanticDigest"] for row in left_ids[identifier]}
        signatures_right = {row["semanticDigest"] for row in right_ids[identifier]}
        if len(left_ids[identifier]) == len(right_ids[identifier]) == 1 and signatures_left == signatures_right:
            exact += 1
            if len(examples) < 3:
                examples.append({"nwiId": identifier, "leftObjectid": left_ids[identifier][0]["objectid"],
                                 "rightObjectid": right_ids[identifier][0]["objectid"], "attribute": left_ids[identifier][0]["attribute"]})
        else:
            ambiguous += len(left_ids[identifier]) + len(right_ids[identifier])
            if len(left_ids[identifier]) != 1 or len(right_ids[identifier]) != 1:
                repeated_id_within_package += 1
            if {row["geometryDigest"] for row in left_ids[identifier]} != {row["geometryDigest"] for row in right_ids[identifier]}:
                same_id_different_geometry += 1
            if {(row["attribute"], row["wetlandType"]) for row in left_ids[identifier]} != {(row["attribute"], row["wetlandType"]) for row in right_ids[identifier]}:
                same_id_different_attributes += 1
    left_geometry = defaultdict(set)
    for row in by_state[left]: left_geometry[row["geometryDigest"]].add(row["nwiId"])
    same_geometry_distinct_ids = sum(1 for row in by_state[right]
                                     if row["geometryDigest"] in left_geometry and row["nwiId"] not in left_geometry[row["geometryDigest"]])
    result = {"border": label, "bbox": BORDERS[label], "sourceSchemas": schemas,
              "rawRows": {left: len(by_state[left]), right: len(by_state[right])},
              "sharedNonblankNwiIds": len(shared), "exactDuplicateCopies": exact,
              "ambiguousRows": ambiguous, "sameGeometryDistinctIdRowsRetained": same_geometry_distinct_ids,
              "sameIdDifferentGeometryGroups": same_id_different_geometry,
              "sameIdDifferentAttributesGroups": same_id_different_attributes,
              "repeatedIdWithinPackageGroups": repeated_id_within_package,
              "examples": examples}
    if cleanup:
        for state in states:
            (work / "extracted" / f"{state}.gpkg").unlink(missing_ok=True)
            (work / "sources" / lock["packages"][state]["filename"]).unlink(missing_ok=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--borders", help="comma-separated pair labels; default all")
    parser.add_argument("--cleanup-source", action="store_true")
    args = parser.parse_args()
    lock = json.loads((ROOT / "data/national/nwi-state-lock.json").read_text())
    labels = args.borders.split(",") if args.borders else list(BORDERS)
    previous = json.loads(REPORT.read_text()) if REPORT.exists() else {"borders": {}}
    results = dict(previous.get("borders", {}))
    for label in labels:
        started = time.monotonic()
        results[label] = analyze_pair(label, args.work, lock, args.cleanup_source)
        results[label]["wallSeconds"] = round(time.monotonic() - started, 3)
        nw.atomic_json(REPORT, {"schemaVersion": 1, "kind": "nwi-border-overlap-analysis",
                                "canonicalKeyVersion": nw.CANONICAL_KEY_VERSION, "borders": dict(sorted(results.items()))})
        print(json.dumps(results[label]), flush=True)


if __name__ == "__main__":
    main()
