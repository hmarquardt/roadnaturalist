#!/usr/bin/env python3
"""Build the bounded Oregon wetland and hydrography habitat datasets.

Wetlands:    U.S. Fish and Wildlife Service, National Wetlands Inventory (NWI), Oregon state
             GeoPackage extract. The GeoPackage is a SQLite database: features are selected with
             its own R-tree spatial index, so no GDAL dependency and no statewide scan is needed.
Hydrography: U.S. Geological Survey National Hydrography Dataset (High Resolution) HU8 staged
             extracts. NHD was retired on 2023-10-01 in favour of the 3D Hydrography Program
             (3DHP); see docs/HABITAT.md for why the pinned legacy HU8 product is used here.

    uv run --with duckdb --with pyproj --with shapely --with pyarrow --with pyshp \\
      python3 scripts/build-habitat.py --download --verify --corridors
"""
import argparse
import hashlib
import json
import sqlite3
import urllib.request
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
from pyproj import CRS, Transformer
from shapely import wkb as shapely_wkb
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon
from shapely.ops import transform as shapely_transform
from shapely import prepare as shapely_prepare
from shapely.strtree import STRtree
from shapely import transform as shapely_transform_arrays

ROOT = Path(__file__).resolve().parents[1]
PIPELINE_VERSION = "habitat-ingest-v1"
SIMPLIFY_TOLERANCE_M = 1.0
ROUND_DIGITS = 6
# Analytical window: the pilot corridor extent plus a 1.5 km margin, so every requested buffer
# (up to 1 km) lies inside the recorded coverage extent. Verified against the committed road
# snapshot by verify_window().
WINDOW = (-123.070, 45.505, -122.750, 45.670)
WINDOW_MARGIN_M = 1500
WINDOW_WKT = "POLYGON((%s))" % ", ".join(f"{lon} {lat}" for lon, lat in [
    (WINDOW[0], WINDOW[1]), (WINDOW[2], WINDOW[1]), (WINDOW[2], WINDOW[3]),
    (WINDOW[0], WINDOW[3]), (WINDOW[0], WINDOW[1])])

WETLANDS = {
    "id": "nwi-wetlands-or-pilot", "type": "wetlands", "version": "nwi-or-2026-05-v1",
    "url": "https://documentst.ecosphere.fws.gov/wetlands/data/State-Downloads/OR_geopackage_wetlands.zip",
    "archive": "OR_geopackage_wetlands.zip", "member": "OR_geopackage_wetlands.gpkg",
    "bytes": 1934005929, "sha256": "ae6a75e7945943ce517350f8165ec6dd936c75fea7118a9cdabf765d816954a5",
    "published": "2026-05-04", "layer": "OR_Wetlands", "srs_id": 300001,
    "artifact": "nwi-wetlands-pilot.parquet",
    "agency": "U.S. Fish and Wildlife Service",
    "dataset": "National Wetlands Inventory — Oregon state extract (GeoPackage)",
    "vintage": "May 2026 NWI release (state download published 2026-05-04)",
    "documentation_url": "https://www.fws.gov/program/national-wetlands-inventory/data-download",
    "license": "Public domain (U.S. Government work)",
}
HYDROGRAPHY = {
    "id": "nhd-hydrography-or-pilot", "type": "hydrography", "version": "nhd-hr-hu8-2023-12-v1",
    "base": "https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/NHD/HU8/GDB/",
    "artifact": "nhd-hydrography-pilot.parquet",
    "agency": "U.S. Geological Survey",
    "dataset": "National Hydrography Dataset (NHD) High Resolution — HU8 staged extract",
    "vintage": "NHD HR HU8 extracts published 2023-12-13..2023-12-27",
    "published": "2023-12-27",
    "product_status": "Legacy: NHD was retired on 2023-10-01 and is no longer maintained; "
                      "the 3D Hydrography Program (3DHP) is the current USGS hydrography program.",
    "successor_product": "3D Hydrography Program (3DHP) — https://hydro.nationalmap.gov/arcgis/rest/services/3DHP_all/MapServer",
    "documentation_url": "https://www.usgs.gov/national-hydrography/access-national-hydrography-products",
    "license": "Public domain (U.S. Government work)",
    "sources": {
        "17090010": {"name": "Tualatin", "url": "https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/NHD/HU8/GDB/NHD_H_17090010_HU8_GDB.zip", "bytes": 21056661, "sha256": "9f65000fa8ccdee7b8eaa8e68e9f5feb6b68daa69c79452590ec2ac64d6c90c4", "published": "2023-12-27"},
        "17090012": {"name": "Lower Willamette", "url": "https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/NHD/HU8/GDB/NHD_H_17090012_HU8_GDB.zip", "bytes": 12173295, "sha256": "9b24d7dc5fab0ab3b3c5a482c2cb8ad32cf3e111b17a7b6e81f7bb3ac99cc813", "published": "2023-12-20"},
    },
}
# Cowardin system letters present in NWI codes. Only the leading system letter is interpreted
# here; finer class/subclass text comes from the source WETLAND_TYPE label.
COWARDIN_SYSTEMS = {"P": "Palustrine", "R": "Riverine", "L": "Lacustrine", "E": "Estuarine", "M": "Marine"}
# NHD feature types (FType). Labels follow the published NHD feature-type list.
NHD_FEATURE_TYPES = {
    334: "Connector", 336: "CanalDitch", 361: "Playa", 378: "Ice Mass", 390: "Lake/Pond",
    428: "Pipeline", 436: "Reservoir", 460: "Stream/River", 466: "Swamp/Marsh", 558: "Artificial Path",
}
FLOWING_FTYPES = {334, 336, 460, 558}
STANDING_FTYPES = {361, 378, 390, 436, 466}


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch(url, path, digest, download, bytes_expected=None):
    """Verify a pinned source archive, downloading it only when explicitly asked."""
    if not path.exists():
        if not download:
            raise FileNotFoundError(f"{path} missing; pass --download or place the pinned archive in the cache")
        path.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(url, path)
    actual = sha256(path)
    if actual != digest:
        raise ValueError(f"{path.name} SHA-256 mismatch: {actual} (source republished? see docs/HABITAT.md)")
    if bytes_expected is not None and path.stat().st_size != bytes_expected:
        raise ValueError(f"{path.name} byte length mismatch")
    return path


def gpkg_geometry(blob):
    """Decode a GeoPackage geometry blob (GP header + optional envelope + WKB)."""
    if blob[0:2] != b"GP":
        raise ValueError("Not a GeoPackage geometry blob")
    envelope_size = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(blob[3] >> 1) & 0x07]
    return shapely_wkb.loads(blob[8 + envelope_size:])


def round_coordinates(geometry, digits=ROUND_DIGITS):
    return shapely_transform(lambda x, y, z=None: (round(x, digits), round(y, digits)), geometry)


def to_lon_lat(geometry, transformer):
    """Vectorised EPSG:4326 conversion with 1e-6 degree rounding (numpy-level, not per-vertex)."""
    def project(coordinates):
        lon, lat = transformer.transform(coordinates[:, 0], coordinates[:, 1])
        return np.column_stack([np.round(lon, ROUND_DIGITS), np.round(lat, ROUND_DIGITS)])

    return shapely_transform_arrays(geometry, project)


def multi(geometry, kind):
    """Coerce to a stable multi-part form so the analytical SQL stays uniform."""
    if geometry is None or geometry.is_empty:
        return None
    member = "LineString" if kind == "line" else "Polygon"
    factory = MultiLineString if kind == "line" else MultiPolygon
    parts = list(geometry.geoms) if geometry.geom_type == f"Multi{member}" else [geometry]
    parts = [part for part in parts if part.geom_type == member and not part.is_empty]
    return factory(parts) if parts else None


def wetlands_extract_geometry():
    """The analytical window in the NWI source CRS (NAD83 Conus Albers) plus a bounding box."""
    connection = sqlite3.connect("file:%s?mode=ro" % WETLANDS["path"], uri=True)
    definition = connection.execute("SELECT definition FROM gpkg_spatial_ref_sys WHERE srs_id = ?", (WETLANDS["srs_id"],)).fetchone()
    connection.close()
    if not definition:
        raise ValueError("GeoPackage does not declare its spatial reference")
    source_crs = CRS.from_wkt(definition[0])
    to_source = Transformer.from_crs(4326, source_crs, always_xy=True).transform
    corners = [to_source(lon, lat) for lon in (WINDOW[0], WINDOW[2]) for lat in (WINDOW[1], WINDOW[3])]
    xs, ys = zip(*corners)
    return source_crs, (min(xs), min(ys), max(xs), max(ys))


def read_wetlands():
    """Select NWI features with the GeoPackage R-tree, then process geometry in DuckDB Spatial."""
    source_crs, bbox = wetlands_extract_geometry()
    window_5070 = (f"ST_SetCRS(ST_GeomFromText('POLYGON(({bbox[0]} {bbox[1]}, {bbox[2]} {bbox[1]}, "
f"{bbox[2]} {bbox[3]}, {bbox[0]} {bbox[3]}, {bbox[0]} {bbox[1]}))'), 'EPSG:5070')")
    connection = sqlite3.connect("file:%s?mode=ro" % WETLANDS["path"], uri=True)
    cursor = connection.cursor()
    statewide = cursor.execute("SELECT count(*) FROM %s" % WETLANDS["layer"]).fetchone()[0]
    features = cursor.execute(
        f"SELECT w.OBJECTID, w.ATTRIBUTE, w.WETLAND_TYPE, w.QAQC_CODE, w.ACRES, w.NWI_ID, w.Shape FROM {WETLANDS['layer']} w "
        "JOIN rtree_%s_Shape r ON w.OBJECTID = r.id "
        "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ? ORDER BY w.OBJECTID" % WETLANDS["layer"],
        (bbox[0], bbox[2], bbox[1], bbox[3])).fetchall()
    projects = cursor.execute(
        "SELECT p.OBJECTID, p.PROJECT_NAME, p.IMAGE_YR, p.Shape FROM OR_Wetlands_Project_Metadata p "
        "JOIN rtree_OR_Wetlands_Project_Metadata_Shape r ON p.OBJECTID = r.id "
        "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?",
        (bbox[0], bbox[2], bbox[1], bbox[3])).fetchall()
    connection.close()

    project_shapes = []
    for row in projects:
        geometry = gpkg_geometry(row[3])
        if geometry.geom_type == "MultiPolygon":
            geometry = MultiPolygon([part.simplify(25.0, preserve_topology=True) for part in geometry.geoms])
        else:
            geometry = geometry.simplify(25.0, preserve_topology=True)
        shapely_prepare(geometry)
        project_shapes.append((row[1], row[2], geometry))
    project_tree = STRtree([entry[2] for entry in project_shapes]) if project_shapes else None

    def project_for(point):
        if project_tree is None:
            return None
        for index in project_tree.query(point):
            if project_shapes[index][2].covers(point):
                return project_shapes[index]
        return None

    attributes = {row[0]: row for row in features}
    engine = duckdb.connect()
    engine.execute("INSTALL spatial; LOAD spatial;")
    engine.register("nwi", pa.table({
        "objectid": [row[0] for row in features],
        "wkb": [gpkg_geometry(row[6]).wkb for row in features],
    }))
    processed = engine.execute(f"""
        WITH tight AS (
          SELECT objectid, ST_SimplifyPreserveTopology(ST_Intersection(ST_SetCRS(ST_GeomFromWKB(wkb), 'EPSG:5070'), {window_5070}), {SIMPLIFY_TOLERANCE_M}) AS geometry
          FROM nwi
        ), shaped AS (
          SELECT objectid, geometry, ST_Area(geometry) AS area_m2,
                 ST_X(ST_Centroid(geometry)) AS centroid_x, ST_Y(ST_Centroid(geometry)) AS centroid_y,
                 ST_ReducePrecision(ST_Transform(geometry, 'EPSG:5070', 'EPSG:4326', always_xy := true), 0.000001) AS geometry_lon_lat
          FROM tight
        )
        SELECT objectid, ST_AsWKB(geometry_lon_lat), area_m2, centroid_x, centroid_y,
               ST_XMin(geometry_lon_lat), ST_YMin(geometry_lon_lat), ST_XMax(geometry_lon_lat), ST_YMax(geometry_lon_lat),
               ST_IsEmpty(geometry_lon_lat)
        FROM shaped ORDER BY objectid""").fetchall()
    engine.close()

    authority = source_crs.to_authority()
    source_crs_string = f"{authority[0]}:{authority[1]}" if authority else source_crs.to_string()
    source_crs_definition = source_crs.to_wkt()
    rows, dropped, total_area = [], 0, 0.0
    for row in processed:
        objectid, geometry_wkb, area_m2, centroid_x, centroid_y, min_lon, min_lat, max_lon, max_lat, empty = row
        if empty or area_m2 <= 0:
            dropped += 1
            continue
        feature = attributes[objectid]
        attribute = str(feature[1] or "")
        match = project_for(Point(centroid_x, centroid_y))
        total_area += area_m2
        rows.append({
            "source_feature_id": str(objectid), "attribute": attribute, "wetland_type": str(feature[2] or ""),
            "system_code": attribute[0] if attribute else "", "system_label": COWARDIN_SYSTEMS.get(attribute[0], "") if attribute else "",
            "qaqc_code": str(feature[3] or ""), "source_acres": float(feature[4] or 0.0), "nwi_id": str(feature[5] or ""),
            "source_project_name": match[0] if match else "", "source_image_year": int(match[1]) if match and match[1] else None,
            "area_m2": round(area_m2, 3),
            "min_lon": min_lon, "min_lat": min_lat, "max_lon": max_lon, "max_lat": max_lat,
            "geometry": bytes(geometry_wkb),
        })
    stats = {"statewideFeatureCount": statewide, "windowFeatureCount": len(features), "featureCount": len(rows),
             "droppedFeatureCount": dropped, "areaM2": round(total_area, 1),
             "sourceCrs": source_crs_string, "sourceCrsDefinition": source_crs_definition,
             "sourceImageYears": sorted({int(row["source_image_year"]) for row in rows if row["source_image_year"]}),
             "wetlandTypes": sorted({row["wetland_type"] for row in rows if row["wetland_type"]}),
             "attributes": sorted({row["attribute"] for row in rows if row["attribute"]})}
    return rows, stats



def read_hydrography():
    """Read the pinned NHD HU8 extracts with DuckDB Spatial and clip them to the window."""
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    rows, stats = [], {"flowlineCount": 0, "waterbodyCount": 0, "flowlineLengthM": 0.0, "waterbodyAreaM2": 0.0,
                       "droppedFeatureCount": 0, "featureDates": [], "hu8": [], "flowlineLengthMFull": 0.0}
    window = f"ST_GeomFromText('{WINDOW_WKT}')"
    projected_window = f"ST_Transform({window}, 'EPSG:4326', 'EPSG:5070', always_xy := true)"
    for hu8, source in sorted(HYDROGRAPHY["sources"].items()):
        stats["hu8"].append({"hu8": hu8, "name": source["name"], "bytes": source["bytes"], "sha256": source["sha256"]})
        for layer, member in (("NHDFlowline", "line"), ("NHDWaterbody", "polygon")):
            source_length = "lengthkm" if layer == "NHDFlowline" else "NULL::DOUBLE AS lengthkm"
            source_area = "areasqkm" if layer == "NHDWaterbody" else "NULL::DOUBLE AS areasqkm"
            projected = f"ST_Transform(SHAPE, 'EPSG:4269', 'EPSG:5070', always_xy := true)"
            query = f"""
                SELECT permanent_identifier, ftype, fcode, gnis_name, fdate, resolution,
                       lengthkm, areasqkm,
                       ST_AsWKB(ST_ReducePrecision(ST_Transform(
                         ST_Intersection({projected}, {projected_window}),
                         'EPSG:5070', 'EPSG:4326', always_xy := true), 0.000001)) AS geometry,
                       ST_Length(ST_Intersection({projected}, {projected_window})) AS length_m,
                       ST_Area(ST_Intersection({projected}, {projected_window})) AS area_m2
                FROM ST_Read('{source['path']}', layer := '{layer}')
                WHERE ST_Intersects(SHAPE, ST_Buffer({window}, 0.001))
                ORDER BY permanent_identifier"""
            query = query.replace("lengthkm, areasqkm,", f"{source_length}, {source_area},")
            for row in connection.execute(query).fetchall():
                identifier, ftype, fcode, name, feature_date, resolution, source_length_km, source_area_km2, geometry_wkb, length_m, area_m2 = row
                shape = shapely_wkb.loads(bytes(geometry_wkb)) if geometry_wkb else None
                shaped = multi(shape, member)
                if shaped is None or (member == "line" and length_m <= 0) or (member == "polygon" and area_m2 <= 0):
                    stats["droppedFeatureCount"] += 1
                    continue
                bounds = shaped.bounds
                feature_type = int(ftype)
                rows.append({
                    "layer": "flowline" if layer == "NHDFlowline" else "waterbody",
                    "source_feature_id": str(identifier), "source_hu8": hu8, "source_hu8_name": source["name"],
                    "feature_type_code": feature_type, "feature_type_label": NHD_FEATURE_TYPES.get(feature_type, "Unknown"),
                    "feature_code": int(fcode) if fcode is not None else None,
                    "water_class": "flowing" if feature_type in FLOWING_FTYPES else "standing" if feature_type in STANDING_FTYPES else "other",
                    "name": name or "", "source_feature_date": str(feature_date)[:10] if feature_date else "",
                    "resolution": str(resolution or ""),
                    "source_length_km": float(source_length_km) if source_length_km is not None else None,
                    "source_area_km2": float(source_area_km2) if source_area_km2 is not None else None,
                    "length_m": round(float(length_m), 3) if member == "line" else None,
                    "area_m2": round(float(area_m2), 3) if member == "polygon" else None,
                    "min_lon": bounds[0], "min_lat": bounds[1], "max_lon": bounds[2], "max_lat": bounds[3],
                    "geometry": shaped.wkb,
                })
                if member == "line":
                    stats["flowlineCount"] += 1
                    stats["flowlineLengthM"] += float(length_m)
                else:
                    stats["waterbodyCount"] += 1
                    stats["waterbodyAreaM2"] += float(area_m2)
                stats["featureDates"].append(str(feature_date)[:10] if feature_date else "")
    stats["flowlineLengthM"] = round(stats["flowlineLengthM"], 1)
    stats["waterbodyAreaM2"] = round(stats["waterbodyAreaM2"], 1)
    stats["sourceFeatureDates"] = sorted({date for date in stats.pop("featureDates") if date})
    return rows, stats


def write_geoparquet(rows, path, geometry_types, dataset_id, title):
    if not rows:
        raise ValueError(f"{dataset_id}: no features to write")
    columns = {key: [row[key] for row in rows] for key in rows[0]}
    table = pa.table(columns)
    geo = {"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": {
        "encoding": "WKB", "geometry_types": geometry_types, "crs": CRS.from_epsg(4326).to_json_dict(),
        "bbox": [min(row["min_lon"] for row in rows), min(row["min_lat"] for row in rows),
                 max(row["max_lon"] for row in rows), max(row["max_lat"] for row in rows)]}}}
    table = table.replace_schema_metadata({b"geo": json.dumps(geo, separators=(",", ":")).encode()})
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path, compression="zstd")
    reread = pq.read_table(path)
    if reread.num_rows != len(rows) or b"geo" not in reread.schema.metadata:
        raise ValueError(f"{title} GeoParquet round-trip failed")
    if any(value is None for value in reread.column("geometry").to_pylist()):
        raise ValueError(f"{title} contains null geometry")
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    total, invalid, non_empty, srid = connection.execute(
        "SELECT count(*), sum(CASE WHEN ST_IsValid(geometry) THEN 0 ELSE 1 END), "
        "sum(CASE WHEN ST_IsEmpty(geometry) THEN 0 ELSE 1 END), any_value(ST_CRS(geometry)) FROM read_parquet(?)",
        [str(path)]).fetchone()
    if total != len(rows) or invalid or non_empty != len(rows) or srid != 'EPSG:4326':
        raise ValueError(f"{title} DuckDB read-back failed (rows={total}, invalid={invalid}, empty={len(rows) - non_empty}, srid={srid})")
    return {"featureCount": int(total), "bytes": path.stat().st_size, "sha256": sha256(path)}



def wetlands_manifest(stats, written):
    return {
        "id": WETLANDS["id"], "type": WETLANDS["type"], "version": WETLANDS["version"], "format": "GeoParquet",
        "url": f"gis/{WETLANDS['artifact']}", "bytes": written["bytes"], "sha256": written["sha256"],
        "featureCount": written["featureCount"], "crs": "EPSG:4326",
        "scope": {
            "kind": "Bounded NWI wetland extract around the Oregon road pilot",
            "bbox": list(WINDOW), "windowMarginM": WINDOW_MARGIN_M,
            "statewideFeatureCount": stats["statewideFeatureCount"], "windowFeatureCount": stats["windowFeatureCount"],
            "totalWetlandAreaM2": stats["areaM2"], "sourceImageYears": stats["sourceImageYears"],
            "wetlandTypes": stats["wetlandTypes"],
            "geometryTreatment": {"clipped": "analytical window", "simplifiedToleranceM": SIMPLIFY_TOLERANCE_M,
                                  "roundDigits": ROUND_DIGITS, "measuredCrs": "EPSG:5070"},
        },
        "source": {
            "agency": WETLANDS["agency"], "dataset": WETLANDS["dataset"], "vintage": WETLANDS["vintage"],
            "url": WETLANDS["url"], "bytes": WETLANDS["bytes"], "sha256": WETLANDS["sha256"],
            "publicationDate": WETLANDS["published"], "documentationUrl": WETLANDS["documentation_url"],
            "license": WETLANDS["license"], "layer": WETLANDS["layer"], "sourceCrs": stats["sourceCrs"],
            "sourceCrsDefinition": stats["sourceCrsDefinition"],
            "fields": ["ATTRIBUTE", "WETLAND_TYPE", "QAQC_CODE", "ACRES", "NWI_ID"],
        },
        "normalization": {
            "pipelineVersion": PIPELINE_VERSION,
            "method": "GeoPackage R-tree window selection; clip to the analytical window; simplify preserving topology; "
                      "round to 1e-6 degrees; transform the NWI Albers source CRS to EPSG:4326; areas measured in EPSG:5070",
            "sourceCrs": stats["sourceCrs"], "crs": "EPSG:4326", "measureCrs": "EPSG:5070",
            "simplifyToleranceM": SIMPLIFY_TOLERANCE_M,
        },
        "schemaVersion": 1,
    }


def hydrography_manifest(rows, stats, written):
    flowlines = [row for row in rows if row["layer"] == "flowline"]
    waterbodies = [row for row in rows if row["layer"] == "waterbody"]
    return {
        "id": HYDROGRAPHY["id"], "type": HYDROGRAPHY["type"], "version": HYDROGRAPHY["version"], "format": "GeoParquet",
        "url": f"gis/{HYDROGRAPHY['artifact']}", "bytes": written["bytes"], "sha256": written["sha256"],
        "featureCount": written["featureCount"], "crs": "EPSG:4326",
        "layers": {"flowline": {"featureCount": len(flowlines), "lengthM": stats["flowlineLengthM"]},
                   "waterbody": {"featureCount": len(waterbodies), "areaM2": stats["waterbodyAreaM2"]}},
        "scope": {
            "kind": "Bounded NHD High Resolution extraction around the Oregon road pilot",
            "bbox": list(WINDOW), "windowMarginM": WINDOW_MARGIN_M,
            "flowlineCount": stats["flowlineCount"], "waterbodyCount": stats["waterbodyCount"],
            "flowlineLengthM": stats["flowlineLengthM"], "waterbodyAreaM2": stats["waterbodyAreaM2"],
            "sourceFeatureDates": stats["sourceFeatureDates"],
            "flowingFeatureTypes": sorted(FLOWING_FTYPES), "standingFeatureTypes": sorted(STANDING_FTYPES),
            "geometryTreatment": {"clipped": "analytical window", "simplifiedToleranceM": SIMPLIFY_TOLERANCE_M,
                                  "roundDigits": ROUND_DIGITS, "measuredCrs": "EPSG:5070"},
        },
        "source": {
            "agency": HYDROGRAPHY["agency"], "dataset": HYDROGRAPHY["dataset"], "vintage": HYDROGRAPHY["vintage"],
            "url": HYDROGRAPHY["sources"]["17090010"]["url"],
            "urls": {hu8: entry["url"] for hu8, entry in HYDROGRAPHY["sources"].items()},
            "bytes": {hu8: entry["bytes"] for hu8, entry in HYDROGRAPHY["sources"].items()},
            "sha256": {hu8: entry["sha256"] for hu8, entry in HYDROGRAPHY["sources"].items()},
            "hu8Names": {hu8: entry["name"] for hu8, entry in HYDROGRAPHY["sources"].items()},
            "publicationDate": HYDROGRAPHY["published"], "documentationUrl": HYDROGRAPHY["documentation_url"],
            "license": HYDROGRAPHY["license"], "layers": ["NHDFlowline", "NHDWaterbody"], "sourceCrs": "EPSG:4269",
            "productStatus": HYDROGRAPHY["product_status"], "successorProduct": HYDROGRAPHY["successor_product"],
        },
        "normalization": {
            "pipelineVersion": PIPELINE_VERSION,
            "method": "DuckDB Spatial read of the pinned HU8 File Geodatabases; clip to the analytical window; "
                      "simplify preserving topology; round to 1e-6 degrees; transform EPSG:4269 to EPSG:4326; "
                      "lengths and areas measured in EPSG:5070",
            "sourceCrs": "EPSG:4269", "crs": "EPSG:4326", "measureCrs": "EPSG:5070",
            "simplifyToleranceM": SIMPLIFY_TOLERANCE_M,
        },
        "schemaVersion": 1,
    }


def update_manifest(entries):
    manifest_path = ROOT / "data" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    ids = {entry["id"] for entry in entries}
    manifest["datasets"] = [dataset for dataset in manifest["datasets"] if dataset["id"] not in ids] + entries
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return [dataset["id"] for dataset in manifest["datasets"]]


def pilot_corridors():
    """Candidate corridor geometry from the committed road snapshot (real TIGER/Line coordinates).

    Duplicate source features are dropped exactly as src/roads/normalize.js does; ordering and
    part reporting are irrelevant to buffer analysis.
    """
    snapshot = json.loads((ROOT / "tests" / "fixtures" / "or-roads-pilot.snapshot.json").read_text())
    declaration = json.loads((ROOT / "data" / "roads" / "or-roads-pilot.json").read_text())
    by_road = {road["roadId"]: road for road in snapshot["roads"]}
    corridors = {}
    for candidate in declaration["candidates"]:
        seen, lines = set(), []
        for road_id in candidate["roadIds"]:
            for feature in by_road[road_id]["features"]:
                coordinates = [tuple(point) for point in feature["coordinates"]]
                keys = (tuple(coordinates), tuple(reversed(coordinates)))
                if keys[0] in seen or keys[1] in seen:
                    continue
                seen.update(keys)
                lines.append(coordinates)
        corridors[candidate["id"]] = lines
    return corridors


def window_polygon():
    """The analytical window as a projected polygon (EPSG:5070)."""
    to_meters = Transformer.from_crs(4326, 5070, always_xy=True).transform
    corners = [to_meters(WINDOW[0], WINDOW[1]), to_meters(WINDOW[2], WINDOW[1]),
               to_meters(WINDOW[2], WINDOW[3]), to_meters(WINDOW[0], WINDOW[3])]
    return Polygon(corners)


def window_covers(lines, distance_m):
    """True when the buffered corridor is inside the recorded analytical window."""
    to_meters = Transformer.from_crs(4326, 5070, always_xy=True).transform
    window = window_polygon()
    for line in lines:
        buffered = LineString([to_meters(lon, lat) for lon, lat in line]).buffer(distance_m)
        if not window.covers(buffered):
            return False
    return True


def verify_window():
    """The pilot corridors plus the largest analysis buffer must fit inside the recorded window."""
    window_covers_distance = max(ANALYSIS_DISTANCES_M)
    to_meters = Transformer.from_crs(4326, 5070, always_xy=True).transform
    west, south, east, north = window_polygon().bounds
    corridors = pilot_corridors()
    tightest = None
    for candidate_id, lines in corridors.items():
        points = [to_meters(lon, lat) for line in lines for lon, lat in line]
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        margin = min(min(xs) - west, east - max(xs), min(ys) - south, north - max(ys))
        tightest = margin if tightest is None else min(tightest, margin)
        if not window_covers(lines, window_covers_distance):
            raise ValueError(f"{candidate_id}: the {window_covers_distance} m buffer is not inside the window")
    if tightest < WINDOW_MARGIN_M - 100:
        raise ValueError(f"window margin {tightest:.0f} m is smaller than the recorded {WINDOW_MARGIN_M} m")
    print(f"window {WINDOW} covers every pilot corridor: tightest margin {tightest:.0f} m, "
          f"{window_covers_distance} m buffers inside ({len(corridors)} candidates)")
    return corridors


ANALYSIS_DISTANCES_M = [250, 500, 1000]


def verify_spatial_math():
    """Synthetic fixtures: nearest distance, buffer area, polygon area, intersection and units."""
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    project = "ST_Transform({0}, 'EPSG:4326', 'EPSG:5070', always_xy := true)"
    point = project.format("ST_GeomFromText('POINT(-122.9 45.58)')")
    near = project.format("ST_GeomFromText('POINT(-122.8999 45.58)')")
    distance = connection.execute(f"SELECT ST_Distance({point}, {near})").fetchone()[0]
    assert abs(distance - 7.8) < 1.5, f"nearest distance fixture: {distance}"
    area = connection.execute(f"SELECT ST_Area(ST_Buffer({point}, 1000))").fetchone()[0]
    assert abs(area / 3.141592653589793 / 1e6 - 1) < 0.01, f"buffer area fixture: {area}"
    square = project.format("ST_GeomFromText('POLYGON((-122.91 45.57, -122.91 45.58, -122.90 45.58, -122.90 45.57, -122.91 45.57))')")
    square_area = connection.execute(f"SELECT ST_Area({square})").fetchone()[0]
    assert 800_000 < square_area < 920_000, f"polygon area fixture: {square_area}"
    crossing = connection.execute(f"SELECT ST_Intersects({point}, ST_Buffer({near}, 20))").fetchone()[0]
    assert crossing is True, "intersection fixture should intersect"
    separated = connection.execute(f"SELECT ST_Intersects({point}, ST_Buffer({near}, 5))").fetchone()[0]
    assert separated is False, "intersection fixture should not intersect"
    length = connection.execute(
        "SELECT ST_Length(ST_Transform(ST_GeomFromText('LINESTRING(-122.9 45.58, -122.89 45.58)'), "
        "'EPSG:4326', 'EPSG:5070', always_xy := true))").fetchone()[0]
    assert 700 < length < 900, f"length unit fixture: {length}"
    print(f"spatial math: 7.8 m fixture reads {distance:.2f} m; 1 km buffer {area / 10000:.2f} ha; "
          f"0.01 deg square {square_area / 10000:.1f} ha; intersect yes/no; 0.01 deg line {length:.1f} m")


def unzip_member(archive, member, cache):
    """Extract a member (or a whole archive) and return its path, reusing an existing extraction."""
    import zipfile
    target = cache / member
    if target.exists() and (target.is_dir() or target.stat().st_size > 0):
        return target
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(cache)
    if not target.exists():
        raise FileNotFoundError(f"{member} not found in {archive}")
    return target


def corridor_wkt(lines):
    return "MULTILINESTRING(" + ",".join("(" + ",".join(f"{lon} {lat}" for lon, lat in line) + ")" for line in lines) + ")"


def measure_corridors(corridors, distances=None):
    """Deterministic habitat metrics per corridor, using the same SQL shape as the browser layer."""
    distances = distances or ANALYSIS_DISTANCES_M
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    wetlands = f"read_parquet('{ROOT / 'data' / 'gis' / WETLANDS['artifact']}')"
    hydrography = f"read_parquet('{ROOT / 'data' / 'gis' / HYDROGRAPHY['artifact']}')"
    distance_values = ", ".join(f"({distance})" for distance in distances)
    measured = {}
    for candidate_id, lines in corridors.items():
        road_5070 = f"ST_Transform(ST_GeomFromText('{corridor_wkt(lines)}'), 'EPSG:4326', 'EPSG:5070', always_xy := true)"
        buffers = connection.execute(f"""
            WITH road AS (SELECT {road_5070} AS g), d(distance_m) AS (VALUES {distance_values}),
            hit AS (
              SELECT d.distance_m, w.wetland_type, w.source_feature_id,
                     ST_Area(ST_Intersection(w.geom, ST_Buffer(road.g, d.distance_m))) AS area_m2
              FROM (SELECT ST_Transform(geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom,
                           wetland_type, source_feature_id FROM {wetlands}) w, road, d
              WHERE ST_Intersects(w.geom, ST_Buffer(road.g, d.distance_m))
            )
            SELECT distance_m, wetland_type, count(DISTINCT source_feature_id), sum(area_m2)
            FROM hit WHERE area_m2 > 0 GROUP BY distance_m, wetland_type ORDER BY distance_m, sum(area_m2) DESC""").fetchall()
        proximity = connection.execute(f"""
            WITH road AS (SELECT {road_5070} AS g)
            SELECT count(*) FILTER (WHERE ST_Intersects(w.geom, road.g)), min(ST_Distance(w.geom, road.g)), count(*)
            FROM (SELECT ST_Transform(geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom FROM {wetlands}) w, road""").fetchone()
        wetland_buffers = {}
        for distance in distances:
            rows = [row for row in buffers if row[0] == distance]
            wetland_buffers[str(distance)] = {
                "areaM2": round(sum(row[3] for row in rows), 1),
                "featureCount": sum(row[2] for row in rows),
                "classes": [{"wetlandType": row[1], "featureCount": row[2], "areaM2": round(row[3], 1)} for row in rows],
            }
        measured[candidate_id] = {
            "wetlands": {
                "coverage": "FULL" if all(window_covers(lines, distance) for distance in distances) else "PARTIAL",
                "intersectsCorridor": bool(proximity[0]), "nearestDistanceM": round(float(proximity[1]), 1),
                "sourceFeatureCount": int(proximity[2]), "buffers": wetland_buffers,
            },
        }
    return measured


def measure_hydrography(corridors, distances=None):
    """Hydrography metrics per corridor: buffered lengths/areas, crossings, nearest water."""
    distances = distances or ANALYSIS_DISTANCES_M
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    hydrography = f"read_parquet('{ROOT / 'data' / 'gis' / HYDROGRAPHY['artifact']}')"
    distance_values = ", ".join(f"({distance})" for distance in distances)
    measured = {}
    for candidate_id, lines in corridors.items():
        road_5070 = f"ST_Transform(ST_GeomFromText('{corridor_wkt(lines)}'), 'EPSG:4326', 'EPSG:5070', always_xy := true)"
        buffers = connection.execute(f"""
            WITH road AS (SELECT {road_5070} AS g), d(distance_m) AS (VALUES {distance_values}),
            hit AS (
              SELECT d.distance_m, h.layer, h.source_feature_id,
                     ST_Length(ST_Intersection(h.geom, ST_Buffer(road.g, d.distance_m))) AS length_m,
                     ST_Area(ST_Intersection(h.geom, ST_Buffer(road.g, d.distance_m))) AS area_m2
              FROM (SELECT ST_Transform(geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom,
                           layer, source_feature_id FROM {hydrography}) h, road, d
              WHERE ST_Intersects(h.geom, ST_Buffer(road.g, d.distance_m))
            )
            SELECT distance_m, layer, count(DISTINCT source_feature_id), sum(length_m), sum(area_m2)
            FROM hit WHERE length_m > 0 OR area_m2 > 0 GROUP BY distance_m, layer ORDER BY distance_m, layer""").fetchall()
        crossings = connection.execute(f"""
            WITH road AS (SELECT {road_5070} AS g)
            SELECT f.source_feature_id, f.name, f.feature_type_label, ST_Length(ST_Intersection(f.geom, road.g))
            FROM (SELECT ST_Transform(geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom,
                         source_feature_id, name, feature_type_label, layer FROM {hydrography}) f, road
            WHERE f.layer = 'flowline' AND ST_Intersects(f.geom, road.g)
            ORDER BY 4 DESC, f.source_feature_id""").fetchall()
        nearest = connection.execute(f"""
            WITH road AS (SELECT {road_5070} AS g)
            SELECT min(ST_Distance(h.geom, road.g)) FILTER (WHERE h.water_class = 'flowing'),
                   min(ST_Distance(h.geom, road.g)) FILTER (WHERE h.water_class = 'standing')
            FROM (SELECT ST_Transform(geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom, water_class
                  FROM {hydrography}) h, road""").fetchone()
        buffers_out = {}
        for distance in distances:
            rows = [row for row in buffers if row[0] == distance]
            buffers_out[str(distance)] = {
                "flowlineLengthM": round(sum(row[3] for row in rows if row[1] == "flowline"), 1),
                "waterbodyAreaM2": round(sum(row[4] for row in rows if row[1] == "waterbody"), 1),
                "flowlineFeatureCount": sum(row[2] for row in rows if row[1] == "flowline"),
                "waterbodyFeatureCount": sum(row[2] for row in rows if row[1] == "waterbody"),
            }
        measured[candidate_id] = {
            "coverage": "FULL" if all(window_covers(lines, distance) for distance in distances) else "PARTIAL",
            "crossingCount": len(crossings),
            "crossings": [{"sourceFeatureId": row[0], "name": row[1] or None, "featureTypeLabel": row[2], "overlapM": round(row[3], 2)} for row in crossings],
            "nearestFlowingWaterM": round(float(nearest[0]), 1) if nearest[0] is not None else None,
            "nearestStandingWaterM": round(float(nearest[1]), 1) if nearest[1] is not None else None,
            "buffers": buffers_out,
        }
    return measured




def write_expectations(corridors):
    wetland_metrics = measure_corridors(corridors)
    hydro_metrics = measure_hydrography(corridors)
    expectations = {
        "note": "Generated by scripts/build-habitat.py from the committed habitat artifacts. The browser GIS layer "
                "is expected to reproduce these values; the Playwright habitat test compares them.",
        "analysisDistancesM": ANALYSIS_DISTANCES_M, "window": list(WINDOW), "measuredCrs": "EPSG:5070",
        "candidates": {candidate_id: {**wetland_metrics[candidate_id], "hydrography": hydro_metrics[candidate_id]}
                       for candidate_id in wetland_metrics},
    }
    path = ROOT / "tests" / "fixtures" / "habitat-pilot-expectations.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(expectations, indent=2) + "\n")
    for candidate_id, metrics in expectations["candidates"].items():
        wetlands = metrics["wetlands"]
        hydro = metrics["hydrography"]
        print(f"\n{candidate_id}: wetlands {wetlands['coverage']} nearest {wetlands['nearestDistanceM']} m, "
              f"intersects={wetlands['intersectsCorridor']}")
        for distance in ANALYSIS_DISTANCES_M:
            entry = wetlands["buffers"][str(distance)]
            print(f"   wetland <= {distance} m: {entry['areaM2'] / 10000:.2f} ha, {entry['featureCount']} feature(s), "
                  f"{len(entry['classes'])} type(s)")
        print(f"   hydrography {hydro['coverage']}: {hydro['crossingCount']} crossing(s), "
              f"nearest flowing {hydro['nearestFlowingWaterM']} m, nearest standing {hydro['nearestStandingWaterM']} m")
        for distance in ANALYSIS_DISTANCES_M:
            entry = hydro["buffers"][str(distance)]
            print(f"   <= {distance} m: {entry['flowlineLengthM']:,.0f} m flowline, "
                  f"{entry['waterbodyAreaM2'] / 10000:.2f} ha waterbody")
    print(f"\nexpectations written to {path}")
    return expectations


def verify_artifacts():
    """Offline check of the committed artifacts: manifest digests, DuckDB readability, corridor metrics."""
    manifest = json.loads((ROOT / "data" / "manifest.json").read_text())
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    for dataset in (WETLANDS, HYDROGRAPHY):
        entry = next(item for item in manifest["datasets"] if item["id"] == dataset["id"])
        path = ROOT / "data" / entry["url"]
        actual = sha256(path)
        assert actual == entry["sha256"], f"{entry['id']} digest mismatch"
        assert path.stat().st_size == entry["bytes"], f"{entry['id']} byte mismatch"
        rows, invalid, crs = connection.execute(
            "SELECT count(*), sum(CASE WHEN ST_IsValid(geometry) THEN 0 ELSE 1 END), any_value(ST_CRS(geometry)) "
            "FROM read_parquet(?)", [str(path)]).fetchone()
        assert rows == entry["featureCount"], f"{entry['id']} row count"
        assert invalid == 0, f"{entry['id']} has {invalid} invalid geometries"
        assert crs == "EPSG:4326", f"{entry['id']} CRS {crs}"
        print(f"{entry['id']}: {rows} features readable, digest {actual[:16]}, geometry valid, CRS {crs}")
    corridors = verify_window()
    measured = measure_corridors(corridors)
    for candidate_id, metrics in measure_hydrography(corridors).items():
        measured[candidate_id]["hydrography"] = metrics
    expectations = json.loads((ROOT / "tests" / "fixtures" / "habitat-pilot-expectations.json").read_text())
    for candidate_id, metrics in measured.items():
        expected = expectations["candidates"][candidate_id]
        for distance in ANALYSIS_DISTANCES_M:
            actual_area = metrics["wetlands"]["buffers"][str(distance)]["areaM2"]
            expected_area = expected["wetlands"]["buffers"][str(distance)]["areaM2"]
            assert abs(actual_area - expected_area) <= max(expected_area * 0.005, 1), f"{candidate_id} wetlands {distance} m"
            actual_length = metrics["hydrography"]["buffers"][str(distance)]["flowlineLengthM"]
            expected_length = expected["hydrography"]["buffers"][str(distance)]["flowlineLengthM"]
            assert abs(actual_length - expected_length) <= max(expected_length * 0.005, 1), f"{candidate_id} flowline {distance} m"
        assert metrics["hydrography"]["crossingCount"] == expected["hydrography"]["crossingCount"], f"{candidate_id} crossings"
        assert metrics["wetlands"]["nearestDistanceM"] == expected["wetlands"]["nearestDistanceM"], f"{candidate_id} nearest wetland"
        print(f"{candidate_id}: metrics reproduce the committed expectations")
    return measured


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=Path("/tmp/roadnaturalist-habitat-sources"))
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--verify", action="store_true", help="run the synthetic spatial-math fixtures")
    parser.add_argument("--corridors", action="store_true", help="measure the pilot corridors and write expectations")
    parser.add_argument("--verify-artifacts", action="store_true", help="check the committed artifacts and expectations offline")
    args = parser.parse_args()
    if args.verify_artifacts:
        verify_artifacts()
        return
    args.cache.mkdir(parents=True, exist_ok=True)
    corridors = verify_window()

    WETLANDS["path"] = unzip_member(fetch(WETLANDS["url"], args.cache / WETLANDS["archive"], WETLANDS["sha256"],
                                         args.download, WETLANDS["bytes"]), WETLANDS["member"], args.cache)
    wetland_rows, wetland_stats = read_wetlands()
    wetland_written = write_geoparquet(wetland_rows, ROOT / "data" / "gis" / WETLANDS["artifact"],
                                       ["MultiPolygon"], WETLANDS["id"], "wetlands")
    print(f"{WETLANDS['id']}: {wetland_written['featureCount']} features of {wetland_stats['statewideFeatureCount']:,} "
          f"statewide, {wetland_stats['areaM2'] / 10000:.1f} ha in window, {wetland_written['bytes']:,} bytes, "
          f"imagery years {wetland_stats['sourceImageYears']}")

    for hu8, source in HYDROGRAPHY["sources"].items():
        archive = fetch(source["url"], args.cache / f"NHD_H_{hu8}_HU8_GDB.zip", source["sha256"], args.download, source["bytes"])
        source["path"] = unzip_member(archive, f"NHD_H_{hu8}_HU8_GDB.gdb", args.cache)
    hydro_rows, hydro_stats = read_hydrography()
    hydro_written = write_geoparquet(hydro_rows, ROOT / "data" / "gis" / HYDROGRAPHY["artifact"],
                                     ["MultiLineString", "MultiPolygon"], HYDROGRAPHY["id"], "hydrography")
    print(f"{HYDROGRAPHY['id']}: {hydro_stats['flowlineCount']} flowlines ({hydro_stats['flowlineLengthM'] / 1000:.1f} km), "
          f"{hydro_stats['waterbodyCount']} waterbodies ({hydro_stats['waterbodyAreaM2'] / 10000:.1f} ha), "
          f"{hydro_written['bytes']:,} bytes, feature dates {hydro_stats['sourceFeatureDates'][:1]}-{hydro_stats['sourceFeatureDates'][-1:]}")

    datasets = update_manifest([wetlands_manifest(wetland_stats, wetland_written),
                                hydrography_manifest(hydro_rows, hydro_stats, hydro_written)])
    print(f"manifest: {len(datasets)} datasets declared")
    if args.verify:
        verify_spatial_math()
    if args.corridors:
        write_expectations(corridors)


if __name__ == "__main__":
    main()
