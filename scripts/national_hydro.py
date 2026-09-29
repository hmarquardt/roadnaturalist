"""Shared deterministic rules for the CONUS legacy NHD High Resolution hydrography plane.

NATIONAL HYDRO SEMANTIC CONTRACT (the semantics the regional pipeline already implements, scaled nationally
without broadening them):

  * source product: legacy NHD High Resolution, staged per HU8 ("NHD_H_<huc8>_HU8_GDB.zip") - the same product
    the regional build pins, so national rows are the rows the regional metrics already use.
  * layers: NHDFlowline (line member) and NHDWaterbody (polygon member). No other NHD layer contributes.
  * identity: `permanent_identifier` is the dataset's own stable id; measured unique and non-blank across
    representative units. Identity is (member, permanent_identifier).
  * classification: NHD `ftype` decides flowing/standing with the same sets the regional build uses.
  * geometry: preserved as published (line or polygon), transformed from the source geographic NAD83 frame to
    EPSG:4326 for storage; length and clipped area are measured in EPSG:5070 exactly as the regional build does.
    No simplification, no precision reduction, no per-cell clipping of the stored feature.
  * replication: one whole feature is stored in every 0.2-degree CONUS cell its geometry intersects, exactly
    like wetlands and roads; runtime deduplicates by the canonical key.
  * adjacency: HU8 units are drainage basins, not state boundaries, so a boundary feature can appear in two
    staged extracts. The rule is the wetland rule (fail closed): two rows collapse only when they are the same
    member, the same permanent_identifier, and one identical source signature (geometry digest plus the
    preserved attribute tuple). Anything else is retained, package-qualified when it is a conflicting reuse.
    Distinct connected water features are never merged because their geometries touch, overlap or share a name.
"""
import hashlib
import json
import math
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from pyproj import CRS
from shapely import wkb
from shapely.geometry import box

STEP = 0.2
PIPELINE_VERSION = "nhd-hr-hu8-v1"
CANONICAL_KEY_VERSION = "nhd-permanent-identifier-v1"
LAYERS = (("NHDFlowline", "line"), ("NHDWaterbody", "polygon"))
FLOWING_FTYPES = {334, 336, 460, 558}
STANDING_FTYPES = {361, 378, 390, 436, 466}
NHD_FEATURE_TYPES = {334: "Connector", 336: "CanalDitch", 361: "Playa", 378: "Ice Mass", 390: "Lake/Pond",
                     428: "Pipeline", 436: "Reservoir", 460: "Stream/River", 466: "Swamp/Marsh", 558: "Artificial Path"}
# EPSG:5498 is what the staged GDBs declare (NAD83 geographic plus a NAVD88 vertical component). The horizontal
# frame is NAD83, which is the frame the regional build transforms from.
SOURCE_CRS = "EPSG:4269"
ANALYSIS_CRS = "EPSG:5070"
STORED_CRS = 4326


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
    temporary.replace(path)


def water_class(ftype):
    if ftype in FLOWING_FTYPES:
        return "flowing"
    if ftype in STANDING_FTYPES:
        return "standing"
    return "other"


def feature_type_label(ftype):
    return NHD_FEATURE_TYPES.get(ftype, "Unknown")


def geometry_digest(geometry):
    """Exact topological representation, used only together with the id and the attribute tuple."""
    return hashlib.sha256(wkb.dumps(geometry.normalize(), hex=False, output_dimension=2, byte_order=1)).hexdigest()


def attribute_signature(reach_code, gnis_name, ftype, fcode, lengthkm, areasqkm, geometry_digest_value):
    """The preserved-attribute tuple that must also agree before two rows can be one feature."""
    values = [reach_code or "", gnis_name or "", str(ftype if ftype is not None else ""),
              str(fcode if fcode is not None else ""),
              "" if lengthkm is None else f"{float(lengthkm):.6f}",
              "" if areasqkm is None else f"{float(areasqkm):.6f}", geometry_digest_value]
    return hashlib.sha256("\0".join(values).encode()).hexdigest()


def canonical_key(member, unit, objectid, permanent_id, geometry_digest_value, signature, conflict=False):
    """`permanent_identifier` is authoritative only when every package copy is one identical row."""
    identifier = (permanent_id or "").strip()
    if identifier and not conflict:
        return f"nhd-{member}:{identifier}"
    label = "conflict" if identifier else "local"
    return f"nhd-{member}-{label}:{unit}:{objectid}:{geometry_digest_value[:16]}:{signature[:16]}"


def duplicate_group_is_safe(rows):
    """True only for one exact record copied once into multiple staged units.

    rows are (unit, objectid, geometry_digest, signature).
    """
    units = {row[0] for row in rows}
    signatures = {row[3] for row in rows}
    return len(units) > 1 and len(rows) == len(units) and len(signatures) == 1


def member_cells(geometry, cell_ids):
    """Every 0.2-degree cell whose interior the whole feature touches (no per-cell clipping)."""
    min_lon, min_lat, max_lon, max_lat = geometry.bounds
    x0, x1 = math.floor((min_lon + 180) / STEP), math.floor((max_lon + 180) / STEP)
    y0, y1 = math.floor((min_lat + 90) / STEP), math.floor((max_lat + 90) / STEP)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            cell_id = f"x{x}_y{y}"
            if cell_id not in cell_ids:
                continue
            bounds = (-180 + STEP * x, -90 + STEP * y, -180 + STEP * (x + 1), -90 + STEP * (y + 1))
            if geometry.intersects(box(*bounds)):
                yield cell_id


# The compact published row: what the current hydro metrics read, plus what identity and provenance need.
SCHEMA = pa.schema([
    ("canonical_feature_id", pa.string()), ("source_feature_id", pa.string()), ("layer", pa.string()),
    ("source_unit", pa.string()), ("source_units", pa.string()),
    ("name", pa.string()), ("feature_type_code", pa.string()), ("feature_type_label", pa.string()),
    ("feature_code", pa.string()), ("water_class", pa.string()), ("reach_code", pa.string()),
    ("source_feature_date", pa.string()), ("resolution", pa.string()), ("source_length_km", pa.float64()),
    ("source_area_km2", pa.float64()), ("length_m", pa.float64()), ("area_m2", pa.float64()),
    ("geometry_digest", pa.string()), ("min_lon", pa.float64()), ("min_lat", pa.float64()),
    ("max_lon", pa.float64()), ("max_lat", pa.float64()), ("geometry", pa.binary()),
])


def write_geoparquet(rows, path, schema=SCHEMA):
    path = Path(path)
    table = pa.Table.from_pylist(rows, schema=schema)
    bounds = ([min(row["min_lon"] for row in rows), min(row["min_lat"] for row in rows),
               max(row["max_lon"] for row in rows), max(row["max_lat"] for row in rows)] if rows else None)
    geo = {"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": {
        "encoding": "WKB", "geometry_types": ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
        "crs": CRS.from_epsg(STORED_CRS).to_json_dict(), **({"bbox": bounds} if bounds else {})}}}
    table = table.replace_schema_metadata({b"geo": json.dumps(geo, separators=(",", ":")).encode()})
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    pq.write_table(table, temporary, compression="zstd", row_group_size=16384)
    if pq.read_metadata(temporary).num_rows != len(rows):
        raise ValueError(f"row count mismatch for {path}")
    temporary.replace(path)
    return {"rows": len(rows), "bytes": path.stat().st_size, "sha256": sha256_file(path)}
