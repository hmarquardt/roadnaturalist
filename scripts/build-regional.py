#!/usr/bin/env python3
"""Build a partitioned Oregon/Washington spatial catalog from pinned TIGER, NWI and NHD sources.

Source readers are the existing, audited pilot readers. Each source is read once for the declared
region, then whole normalized features are replicated by grid-cell intersection. No regional source is
read once per cell: cell membership is decided in one pass with a spatial index over the 0.2 degree
cells, which is what keeps a 180 x 180 km window buildable.

    uv run --with duckdb --with pyproj --with shapely --with pyarrow --with pyshp --with numpy \\
      python3 scripts/build-regional.py --region or-sw-wa-portland-v2
"""
import argparse
import importlib.util
import json
import math
import sys
import time
from pathlib import Path

import pyarrow.parquet as pq
from shapely import wkb
from shapely.geometry import box
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import tiger_sources as tiger  # noqa: E402

SCHEME = {"kind": "lonlat-grid", "stepLon": 0.2, "stepLat": 0.2, "origin": [-180, -90], "crs": "EPSG:4326"}
OUT = ROOT / "data" / "regional"
STEP = 0.2
# One benchmark centre for every scale, so a 10-, 25- and 50-mile benchmark differ only in radius. The
# point is inside the pilot window and the original regional window, which keeps old measurements
# comparable. Radii are statute miles; the degree conversion uses the same constants as
# src/discovery/search-area.js (a test asserts the committed bounds still match).
BENCHMARK_CENTER = [-122.92, 45.595]
METRES_PER_MILE = 1609.344
METRES_PER_DEGREE_LAT = 110540
METRES_PER_DEGREE_LON = 111320
BENCHMARK_HALO_M = 1000

# Published regions. Each region names its window, the pinned archives it reads, and the version prefix
# its immutable artifacts live under. A published region is never rewritten: a wider window is a new
# version, and the older catalog keeps pointing at the older objects.
REGIONS = {
    "or-portland-west-v1": {
        "id": "or-portland-west", "name": "Portland west region", "bounds": [-123.16, 45.46, -122.68, 45.73],
        "counties": ["41051", "41067"], "nwi": ["OR"], "hu8": ["17090010", "17090012"],
        "sourceCoverage": "TIGER 41051/41067, Oregon NWI, NHD HU8 17090010/17090012",
    },
    "or-sw-wa-portland-v2": {
        "id": "or-sw-wa-portland", "name": "Greater Portland region (Oregon and south-west Washington)",
        "bounds": [-124.05, 44.75, -121.77, 46.42],
        "counties": ["41005", "41007", "41009", "41027", "41031", "41041", "41043", "41047", "41051", "41053",
                     "41057", "41065", "41067", "41071", "53011", "53015", "53041", "53049", "53059", "53069"],
        "nwi": ["OR", "WA"],
        "hu8": ["17070105", "17070306", "17080001", "17080002", "17080003", "17080004", "17080005", "17080006",
                "17090003", "17090005", "17090006", "17090007", "17090008", "17090009", "17090010", "17090011",
                "17090012", "17100103", "17100106", "17100201", "17100202", "17100203", "17100204"],
        "sourceCoverage": "TIGER 41005/41007/41009/41027/41031/41041/41043/41047/41051/41053/41057/41065/41067/41071 and "
                          "WA 53011/53015/53041/53049/53059/53069, Oregon and Washington NWI, NHD HU8 1707/1708/1709/1710",
    },
}
BENCHMARKS = [
    {"id": "small-10mi", "label": "Small: 10-mile radius", "kind": "radius", "radiusMiles": 10},
    {"id": "medium-25mi", "label": "Medium: 25-mile radius", "kind": "radius", "radiusMiles": 25},
    {"id": "large-50mi", "label": "Large: 50-mile radius", "kind": "radius", "radiusMiles": 50},
]


def imported(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def radius_bounds(center, radius_miles):
    """Radius to a lon/lat bounding box with the constants src/discovery/search-area.js uses."""
    radius_m = radius_miles * METRES_PER_MILE
    lon_scale = METRES_PER_DEGREE_LON * math.cos(math.radians(center[1]))
    return [round(center[0] - radius_m / lon_scale, 9), round(center[1] - radius_m / METRES_PER_DEGREE_LAT, 9),
            round(center[0] + radius_m / lon_scale, 9), round(center[1] + radius_m / METRES_PER_DEGREE_LAT, 9)]


def cells(region_bounds):
    x0 = math.floor((region_bounds[0] + 180) / STEP)
    x1 = math.ceil((region_bounds[2] + 180) / STEP)
    y0 = math.floor((region_bounds[1] + 90) / STEP)
    y1 = math.ceil((region_bounds[3] + 90) / STEP)
    for x in range(x0, x1):
        for y in range(y0, y1):
            yield f"x{x}_y{y}", [round(-180 + STEP * x, 9), round(-90 + STEP * y, 9),
                                 round(-180 + STEP * (x + 1), 9), round(-90 + STEP * (y + 1), 9)]


def cell_membership(rows, cell_list, region_bounds, key_fn=None):
    """Assign every row to the cells its geometry intersects, in one indexed pass.

    The window filter runs first (whole features are kept, so a feature is never clipped by a cell), then
    an STRtree over the 0.2 degree cells answers membership per row. This is O(rows * log cells) instead
    of the rows x cells scan a naive nested loop would do on a 108-cell window.

    ``key_fn`` collapses repeated logical features. Adjacent pinned NHD HU8 extracts can carry the same
    permanent identifier, with the same geometry but a different source basin in its provenance columns;
    keeping the first occurrence (basins are read in code order) makes the published dataset exactly one
    row per logical feature and keeps the GIS deduplication deterministic.
    """
    region = box(*region_bounds)
    kept, membership, seen = [], {}, set()
    shapes = [box(*bounds) for _, bounds in cell_list]
    tree = STRtree(shapes)
    for row in rows:
        if key_fn is not None:
            key = key_fn(row)
            if key in seen:
                continue
            seen.add(key)
        geometry = wkb.loads(row["geometry"])
        if not geometry.intersects(region):
            continue
        index = len(kept)
        kept.append(row)
        envelope = box(row["min_lon"], row["min_lat"], row["max_lon"], row["max_lat"])
        for candidate in tree.query(envelope):
            cell_bounds = shapes[candidate]
            if envelope.intersects(cell_bounds) and geometry.intersects(cell_bounds):
                membership.setdefault(cell_list[candidate][0], []).append(index)
    return kept, membership


# The logical identity of a feature. Repeated keys are collapsed by the GIS layer before analysis, so the
# catalog declares how many *unique* features a dataset holds, not how many rows were stored: a whole
# feature is replicated into every cell it touches, and the pinned NHD HU8 extracts can also carry the
# same permanent identifier in two adjacent basins.
DEDUPE_KEYS = {
    "roads": lambda row: (row["county_fips"], row["source_feature_id"], row["part"]),
    "wetlands": lambda row: (row["source_feature_id"],),
    "hydrography": lambda row: (row["layer"], row["source_feature_id"]),
}


def partition(rows, dataset, writer, geometry_types, region_version, cell_list):
    """Write one GeoParquet per non-empty cell and return the catalog entries and column schema."""
    kept, membership = cell_membership(rows, cell_list, REGIONS[region_version]["bounds"], DEDUPE_KEYS.get(dataset))
    output, schema = [], None
    for cell_id, bounds in cell_list:
        members = [kept[index] for index in membership.get(cell_id, [])]
        entry = {"id": cell_id, "bounds": bounds, "featureCount": len(members), "state": "present" if members else "empty"}
        if members:
            directory = OUT / "partitions" / region_version / dataset
            path = directory / f"{cell_id}.parquet"
            if geometry_types:
                writer(members, path, geometry_types, dataset, dataset)
            else:
                writer(members, path)
            entry.update({"url": f"regional/partitions/{region_version}/{dataset}/{cell_id}.parquet",
                          "bytes": path.stat().st_size, "sha256": tiger.sha256_of(path)})
            if schema is None:
                schema = [{"name": field.name, "type": str(field.type)} for field in pq.read_schema(path)]
        output.append(entry)
    unique = len({DEDUPE_KEYS[dataset](row) for row in kept})
    return output, unique, schema, kept, membership


def road_name_index(road_cells, membership, kept):
    """Which published cells hold each road name, for names that span more than one cell.

    A name whose features all sit in one cell needs no closing step: selecting that cell already brings
    every published piece of it. The index therefore records only names that cross a cell boundary, which
    is both smaller and exactly the set the browser closure has to consider.
    """
    per_name, bounds = {}, {}
    for cell_id, indices in membership.items():
        for index in indices:
            row = kept[index]
            if not row["name"]:
                continue
            key = tiger.slug(row["name"])
            per_name.setdefault(key, set()).add(cell_id)
            current = bounds.setdefault(key, [row["min_lon"], row["min_lat"], row["max_lon"], row["max_lat"]])
            current[0] = min(current[0], row["min_lon"])
            current[1] = min(current[1], row["min_lat"])
            current[2] = max(current[2], row["max_lon"])
            current[3] = max(current[3], row["max_lat"])
    spanning = {key: sorted(ids) for key, ids in per_name.items() if len(ids) > 1}
    return spanning, {key: bounds[key] for key in spanning}


def benchmark_declaration(region_version):
    """Committed benchmark scenarios: fixed centre, fixed radii, and the bounds they imply."""
    region = REGIONS[region_version]
    lon_pad = BENCHMARK_HALO_M / (METRES_PER_DEGREE_LON * math.cos(math.radians(BENCHMARK_CENTER[1])))
    lat_pad = BENCHMARK_HALO_M / METRES_PER_DEGREE_LAT
    scenarios = []
    for scenario in BENCHMARKS:
        bounds = radius_bounds(BENCHMARK_CENTER, scenario["radiusMiles"])
        padded = [bounds[0] - lon_pad, bounds[1] - lat_pad, bounds[2] + lon_pad, bounds[3] + lat_pad]
        published = region["bounds"]
        inside = (padded[0] >= published[0] and padded[1] >= published[1]
                  and padded[2] <= published[2] and padded[3] <= published[3])
        scenarios.append({"id": scenario["id"], "label": scenario["label"], "kind": "radius",
                          "center": list(BENCHMARK_CENTER), "radiusMiles": scenario["radiusMiles"],
                          "bbox": [round(value, 9) for value in bounds], "fullyInsidePublishedRegion": inside})
    return {"kind": "road-discovery-benchmarks", "version": 1, "region": region_version,
            "assetBaseUrl": "https://data.roadnaturalist.com/", "catalogUrl": "regional/manifest.json",
            "analysisHaloM": BENCHMARK_HALO_M,
            "note": "Concentric fixed-radius scenarios on one fixed centre so scale comparisons are meaningful. "
                    "Radii are statute miles; bounds are derived with the same constants src/discovery/search-area.js "
                    "uses, and a test asserts the committed bounds still match that derivation.",
            "scenarios": scenarios}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default="or-sw-wa-portland-v2", choices=sorted(REGIONS))
    parser.add_argument("--road-cache", type=Path, default=Path("/tmp/roadnaturalist-road-sources"))
    parser.add_argument("--habitat-cache", type=Path, default=Path("/tmp/rn-habitat-sources"))
    parser.add_argument("--report", type=Path, default=None, help="write measured build phases to this JSON file")
    args = parser.parse_args()
    version = args.region
    declaration = REGIONS[version]
    bounds = tuple(declaration["bounds"])
    cell_list = list(cells(bounds))
    phases, started_all = {}, time.time()

    roads = imported("road_network", "build-road-network.py")
    habitat = imported("habitat_build", "build-habitat.py")
    roads.NETWORK_BBOX = bounds
    habitat.WINDOW = bounds
    habitat.WINDOW_WKT = "POLYGON((%s))" % ", ".join(f"{lon} {lat}" for lon, lat in [
        (bounds[0], bounds[1]), (bounds[2], bounds[1]), (bounds[2], bounds[3]),
        (bounds[0], bounds[3]), (bounds[0], bounds[1])])

    pin_started = time.time()
    for fips in declaration["counties"]:
        tiger.source_archive(fips, None, args.road_cache, False)
    nwi_sources = []
    for state in declaration["nwi"]:
        source = dict(habitat.WASHINGTON_WETLANDS if state == "WA" else habitat.WETLANDS)
        archive = habitat.fetch(source["url"], args.habitat_cache / source["archive"], source["sha256"], False, source["bytes"])
        member = args.habitat_cache / source["member"]
        if not member.exists():
            import zipfile
            with zipfile.ZipFile(archive) as bundle:
                bundle.extract(source["member"], args.habitat_cache)
        source["path"] = member
        nwi_sources.append(source)
    hu8_sources = {}
    for hu8 in declaration["hu8"]:
        pinned = dict(habitat.REGIONAL_HU8.get(hu8, {}))
        if not pinned and hu8 in habitat.HYDROGRAPHY["sources"]:
            pilot = habitat.HYDROGRAPHY["sources"][hu8]
            pinned = {"url": pilot["url"], "bytes": pilot["bytes"], "sha256": pilot["sha256"]}
        archive = args.habitat_cache / f"NHD_H_{hu8}_HU8_GDB.zip"
        habitat.fetch(pinned["url"], archive, pinned["sha256"], False, pinned["bytes"])
        extracted = args.habitat_cache / f"NHD_H_{hu8}_HU8_GDB.gdb"
        if not extracted.exists():
            import zipfile
            with zipfile.ZipFile(archive) as bundle:
                bundle.extractall(args.habitat_cache)
        hu8_sources[hu8] = {"name": hu8, "url": pinned["url"], "bytes": pinned["bytes"],
                            "sha256": pinned["sha256"], "path": extracted}
    habitat.HYDROGRAPHY["sources"] = hu8_sources
    phases["pinSourcesMs"] = round((time.time() - pin_started) * 1000)
    print(f"region {version}: {len(cell_list)} cells, {len(declaration['counties'])} counties, "
          f"{len(nwi_sources)} NWI states, {len(hu8_sources)} NHD basins", flush=True)

    tally = {"excludedClasses": {}, "outsideWindow": 0, "degenerate": 0}
    read_started = time.time()
    road_rows = []
    for fips in sorted(declaration["counties"]):
        road_rows.extend(roads.read_county(fips, args.road_cache / tiger.COUNTIES[fips][1], tally))
    phases["readRoadsMs"] = round((time.time() - read_started) * 1000)
    print(f"roads: {len(road_rows)} source rows read", flush=True)
    read_started = time.time()
    wetland_rows, wetland_stats = habitat.read_wetlands(nwi_sources)
    phases["readWetlandsMs"] = round((time.time() - read_started) * 1000)
    print(f"wetlands: {len(wetland_rows)} rows read", flush=True)
    read_started = time.time()
    hydro_rows, hydro_stats = habitat.read_hydrography()
    phases["readHydrographyMs"] = round((time.time() - read_started) * 1000)
    print(f"hydrography: {len(hydro_rows)} rows read", flush=True)

    base_manifest = json.loads((ROOT / "data" / "manifest.json").read_text())
    base_datasets = {entry["id"]: entry for entry in base_manifest["datasets"]}
    datasets, schemas, kept_rows, memberships = [], {}, {}, {}
    partition_started = time.time()
    for dataset_id, rows, writer, geom_types, base_id, keys in [
        ("roads", road_rows, tiger.write_geoparquet, None, "or-roads-network-pilot", ["agency", "dataset", "vintage", "publicationDate"]),
        ("wetlands", wetland_rows, habitat.write_geoparquet, ["MultiPolygon"], "nwi-wetlands-or-pilot", ["agency", "dataset", "vintage", "publicationDate"]),
        ("hydrography", hydro_rows, habitat.write_geoparquet, ["MultiLineString", "MultiPolygon"], "nhd-hydrography-or-pilot", ["agency", "dataset", "vintage", "publicationDate"]),
    ]:
        parts, unique_count, schema, kept, membership = partition(rows, dataset_id, writer, geom_types, version, cell_list)
        kept_rows[dataset_id], memberships[dataset_id], schemas[dataset_id] = kept, membership, schema
        source = dict(base_datasets[base_id]["source"])
        entry = {"id": dataset_id, "version": version, "format": "GeoParquet", "schemaVersion": 1,
                 "featureCount": unique_count, "crs": "EPSG:4326", "sourceDatasetId": base_id,
                 "source": {key: source.get(key) for key in keys}, "partitions": parts, "columns": schema}
        if dataset_id == "roads":
            entry["source"].update({"urls": {fips: tiger.SOURCE_BASE + tiger.COUNTIES[fips][1] for fips in sorted(declaration["counties"])},
                                    "sha256": {fips: tiger.COUNTIES[fips][2] for fips in sorted(declaration["counties"])}})
        if dataset_id == "wetlands":
            entry["source"].update({"states": [{"state": state, "url": (habitat.WETLANDS if state == "OR" else habitat.WASHINGTON_WETLANDS)["url"],
                                               "bytes": (habitat.WETLANDS if state == "OR" else habitat.WASHINGTON_WETLANDS)["bytes"],
                                               "sha256": (habitat.WETLANDS if state == "OR" else habitat.WASHINGTON_WETLANDS)["sha256"]}
                                              for state in declaration["nwi"]]})
        if dataset_id == "hydrography":
            entry["source"].update({"hu8": sorted(hu8_sources)})
        datasets.append(entry)
        present = [part for part in parts if part["state"] == "present"]
        print(f"{dataset_id}: {unique_count} unique rows, {sum(p['featureCount'] for p in parts)} stored rows, "
              f"{sum(p.get('bytes', 0) for p in parts):,} bytes, {len(present)}/{len(parts)} files", flush=True)
    phases["partitionMs"] = round((time.time() - partition_started) * 1000)
    name_cells, name_bounds = road_name_index(kept_rows["roads"], memberships["roads"], kept_rows["roads"])
    catalog = {"schemaVersion": 2, "project": "roadnaturalist", "version": version,
               "region": {"id": declaration["id"], "name": declaration["name"], "bounds": declaration["bounds"],
                          "sourceCoverage": declaration["sourceCoverage"]},
               "grid": SCHEME, "maxAnalysisDistanceM": BENCHMARK_HALO_M, "assetBaseUrl": "https://data.roadnaturalist.com/",
               "datasets": datasets, "roadNameCells": name_cells, "roadNameBounds": name_bounds,
               "roadNameIndexPolicy": "only names whose published features span more than one cell need closing; "
                                     "a single-cell name is already complete when its cell is selected",
               "benchmarks": [scenario["id"] for scenario in BENCHMARKS],
               "build": {"pipelineVersion": "regional-grid-v2", "replication": "whole features intersecting cell",
                         "deduplication": {"roads": ["county_fips", "source_feature_id", "part"], "wetlands": ["source_feature_id"],
                                           "hydrography": ["layer", "source_feature_id"]},
                         "wetlandSourceWindowFeatures": wetland_stats["windowFeatureCount"],
                         "hydroFlowlineCount": hydro_stats["flowlineCount"],
                         "phasesMs": phases, "cellCount": len(cell_list)}}
    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT / "manifest.json" if version == "or-sw-wa-portland-v2" else OUT / f"manifest-{version}.json"
    manifest_path.write_text(json.dumps(catalog, indent=2) + "\n")
    if version == "or-sw-wa-portland-v2":
        (OUT / "benchmarks.json").write_text(json.dumps(benchmark_declaration(version), indent=2) + "\n")
    phases["totalMs"] = round((time.time() - started_all) * 1000)
    report = {"region": version, "cells": len(cell_list), "phasesMs": phases,
              "datasets": [{"id": entry["id"], "featureCount": entry["featureCount"],
                            "storedRows": sum(part["featureCount"] for part in entry["partitions"]),
                            "bytes": sum(part.get("bytes", 0) for part in entry["partitions"]),
                            "files": sum(1 for part in entry["partitions"] if part["state"] == "present"),
                            "emptyCells": sum(1 for part in entry["partitions"] if part["state"] == "empty")} for entry in datasets],
              "roadNamesSpanningCells": len(name_cells), "manifest": str(manifest_path.relative_to(ROOT))}
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    (OUT / f"build-{version}.json").write_text(json.dumps(report, indent=2) + "\n")
    print("build report: " + json.dumps(report), flush=True)
    print(f"manifest: {manifest_path} ({manifest_path.stat().st_size:,} bytes)", flush=True)


if __name__ == "__main__":
    main()
