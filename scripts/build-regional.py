#!/usr/bin/env python3
"""Build the first Oregon spatial catalog from pinned TIGER, NWI and NHD sources.

Source readers are the existing, audited pilot readers. Each source is read once for
the regional window, then whole normalized features are replicated by grid-cell
intersection. No regional source is read once per cell.
"""
import argparse
import importlib.util
import json
import math
import sys
from pathlib import Path

from shapely import wkb
from shapely.geometry import box

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import tiger_sources as tiger  # noqa: E402

SCHEME = {"kind": "lonlat-grid", "stepLon": 0.2, "stepLat": 0.2, "origin": [-180, -90], "crs": "EPSG:4326"}
REGION = [-123.16, 45.46, -122.68, 45.73]
VERSION = "or-portland-west-v1"
OUT = ROOT / "data" / "regional"


def imported(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cells():
    x0 = math.floor((REGION[0] + 180) / 0.2)
    x1 = math.ceil((REGION[2] + 180) / 0.2)
    y0 = math.floor((REGION[1] + 90) / 0.2)
    y1 = math.ceil((REGION[3] + 90) / 0.2)
    for x in range(x0, x1):
        for y in range(y0, y1):
            bounds = [round(-180 + 0.2 * x, 9), round(-90 + 0.2 * y, 9),
                      round(-180 + 0.2 * (x + 1), 9), round(-90 + 0.2 * (y + 1), 9)]
            yield f"x{x}_y{y}", bounds


def partition(rows, dataset, writer, geometry_types):
    output = []
    region = box(*REGION)
    rows = [row for row in rows if wkb.loads(row["geometry"]).intersects(region)]
    for cell_id, bounds in cells():
        window = box(*bounds)
        members = [row for row in rows if box(row["min_lon"], row["min_lat"], row["max_lon"], row["max_lat"]).intersects(window)
                   and wkb.loads(row["geometry"]).intersects(window)]
        entry = {"id": cell_id, "bounds": bounds, "featureCount": len(members), "state": "present" if members else "empty"}
        if members:
            directory = OUT / "partitions" / VERSION / dataset
            path = directory / f"{cell_id}.parquet"
            writer(members, path, geometry_types, dataset, dataset) if geometry_types else writer(members, path)
            entry.update({"url": f"regional/partitions/{VERSION}/{dataset}/{cell_id}.parquet",
                          "bytes": path.stat().st_size,
                          "sha256": tiger.sha256_of(path)})
        output.append(entry)
    return output, len(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--road-cache", type=Path, default=Path("/tmp/roadnaturalist-road-sources"))
    parser.add_argument("--habitat-cache", type=Path, default=Path("/tmp/rn-habitat-sources"))
    args = parser.parse_args()
    roads = imported("road_network", "build-road-network.py")
    habitat = imported("habitat_build", "build-habitat.py")
    roads.NETWORK_BBOX = tuple(REGION)
    habitat.WINDOW = tuple(REGION)
    habitat.WINDOW_WKT = "POLYGON((%s))" % ", ".join(f"{lon} {lat}" for lon, lat in [
        (REGION[0], REGION[1]), (REGION[2], REGION[1]), (REGION[2], REGION[3]),
        (REGION[0], REGION[3]), (REGION[0], REGION[1])])
    habitat.WETLANDS["path"] = args.habitat_cache / habitat.WETLANDS["member"]
    for hu8, source in habitat.HYDROGRAPHY["sources"].items():
        source["path"] = args.habitat_cache / f"NHD_H_{hu8}_HU8_GDB.gdb"
    for fips in tiger.COUNTIES:
        tiger.source_archive(fips, None, args.road_cache, False)
    habitat.fetch(habitat.WETLANDS["url"], args.habitat_cache / habitat.WETLANDS["archive"],
                  habitat.WETLANDS["sha256"], False, habitat.WETLANDS["bytes"])
    for hu8, source in habitat.HYDROGRAPHY["sources"].items():
        habitat.fetch(source["url"], args.habitat_cache / f"NHD_H_{hu8}_HU8_GDB.zip", source["sha256"], False, source["bytes"])
    tally = {"excludedClasses": {}, "outsideWindow": 0, "degenerate": 0}
    road_rows = []
    for fips in sorted(tiger.COUNTIES):
        road_rows.extend(roads.read_county(fips, args.road_cache / tiger.COUNTIES[fips][1], tally))
    wetland_rows, wetland_stats = habitat.read_wetlands()
    hydro_rows, hydro_stats = habitat.read_hydrography()
    base_manifest = json.loads((ROOT / "data" / "manifest.json").read_text())
    base_datasets = {entry["id"]: entry for entry in base_manifest["datasets"]}
    datasets = []
    for dataset_id, rows, writer, geom_types, base_id in [
        ("roads", road_rows, tiger.write_geoparquet, None, "or-roads-network-pilot"),
        ("wetlands", wetland_rows, habitat.write_geoparquet, ["MultiPolygon"], "nwi-wetlands-or-pilot"),
        ("hydrography", hydro_rows, habitat.write_geoparquet, ["MultiLineString", "MultiPolygon"], "nhd-hydrography-or-pilot"),
    ]:
        parts, unique_count = partition(rows, dataset_id, writer, geom_types)
        source = base_datasets[base_id]["source"]
        datasets.append({"id": dataset_id, "version": VERSION, "format": "GeoParquet", "schemaVersion": 1,
                         "featureCount": unique_count, "crs": "EPSG:4326", "sourceDatasetId": base_id,
                         "source": {key: source.get(key) for key in ["agency", "dataset", "vintage", "publicationDate", "url", "sha256"]},
                         "partitions": parts})
        print(f"{dataset_id}: {unique_count} unique rows, {sum(p['featureCount'] for p in parts)} stored rows, "
              f"{sum(p.get('bytes', 0) for p in parts):,} bytes, {sum(p['state'] == 'present' for p in parts)} files", flush=True)
    # A name can cross county and cell boundaries. The browser closes selected road cells over
    # this index before composing connected units; a common name may overfetch, but never truncate.
    name_cells = {}
    name_bounds = {}
    for row in road_rows:
        if not row["name"]:
            continue
        key = tiger.slug(row["name"])
        bounds = name_bounds.setdefault(key, [row["min_lon"], row["min_lat"], row["max_lon"], row["max_lat"]])
        bounds[0] = min(bounds[0], row["min_lon"])
        bounds[1] = min(bounds[1], row["min_lat"])
        bounds[2] = max(bounds[2], row["max_lon"])
        bounds[3] = max(bounds[3], row["max_lat"])
    for part in datasets[0]["partitions"]:
        if part["state"] == "empty":
            continue
        window = box(*part["bounds"])
        for row in road_rows:
            if row["name"] and box(row["min_lon"], row["min_lat"], row["max_lon"], row["max_lat"]).intersects(window) \
                    and wkb.loads(row["geometry"]).intersects(window):
                name_cells.setdefault(tiger.slug(row["name"]), set()).add(part["id"])
    catalog = {"schemaVersion": 2, "project": "roadnaturalist", "version": VERSION,
               "region": {"id": "or-portland-west", "name": "Portland west region", "bounds": REGION,
                          "sourceCoverage": "TIGER 41051/41067, Oregon NWI, NHD HU8 17090010/17090012"},
               "grid": SCHEME, "maxAnalysisDistanceM": 1000, "assetBaseUrl": "https://data.roadnaturalist.com/",
               "datasets": datasets, "roadNameCells": {key: sorted(ids) for key, ids in sorted(name_cells.items())},
               "roadNameBounds": {key: name_bounds[key] for key in sorted(name_bounds)},
               "build": {"pipelineVersion": "regional-grid-v1", "replication": "whole features intersecting cell",
                         "deduplication": {"roads": ["county_fips", "source_feature_id", "part"], "wetlands": ["source_feature_id"],
                                           "hydrography": ["layer", "source_feature_id"]},
                         "wetlandSourceWindowFeatures": wetland_stats["windowFeatureCount"],
                         "hydroFlowlineCount": hydro_stats["flowlineCount"]}}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(catalog, indent=2) + "\n")
    print(f"manifest: {OUT / 'manifest.json'}", flush=True)


if __name__ == "__main__":
    main()
