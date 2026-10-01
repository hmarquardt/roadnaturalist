"""Shared deterministic rules for the CONUS NWI source plane."""
import hashlib
import json
import math
import struct
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from pyproj import CRS
from shapely import wkb
from shapely.geometry import MultiPolygon, box
from shapely.ops import transform

STEP = 0.2
PIPELINE_VERSION = "nwi-state-gpkg-v1"
CANONICAL_KEY_VERSION = "nwi-id-exact-signature-v1"
COWARDIN_SYSTEMS = {"P": "Palustrine", "R": "Riverine", "L": "Lacustrine", "E": "Estuarine", "M": "Marine"}


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


def gpkg_geometry(blob):
    if not blob or blob[:2] != b"GP":
        raise ValueError("not a GeoPackage geometry blob")
    envelope_size = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(blob[3] >> 1) & 7]
    return wkb.loads(blob[8 + envelope_size:])


def polygonal(geometry):
    if geometry is None or geometry.is_empty:
        return None
    if geometry.geom_type == "Polygon":
        return MultiPolygon([geometry])
    if geometry.geom_type == "MultiPolygon":
        return geometry
    if geometry.geom_type == "GeometryCollection":
        parts = [item for item in geometry.geoms if item.geom_type == "Polygon"]
        return MultiPolygon(parts) if parts else None
    return None


def normalized_geometry_digest(geometry):
    """Exact topological representation used only alongside NWI_ID and attributes."""
    return hashlib.sha256(wkb.dumps(geometry.normalize(), hex=False, output_dimension=2, byte_order=1)).hexdigest()


def semantic_digest(nwi_id, attribute, wetland_type, qaqc_code, geometry_digest):
    values = [nwi_id or "", attribute or "", wetland_type or "", qaqc_code or "", geometry_digest]
    return hashlib.sha256("\0".join(values).encode()).hexdigest()


def canonical_key(state, objectid, nwi_id, geometry_digest, semantic_digest_value, conflict=False):
    """NWI_ID is authoritative only when every package copy has an exact signature.

    Blank IDs and conflicting reuse remain package-qualified. Geometry equality by
    itself never collapses a record, preserving legitimate ecological overlap.
    """
    identifier = (nwi_id or "").strip()
    if identifier and not conflict:
        return f"nwi:{identifier}"
    label = "conflict" if identifier else "local"
    return f"nwi-{label}:{state}:{objectid}:{geometry_digest[:16]}:{semantic_digest_value[:16]}"


def duplicate_group_is_safe(rows):
    """True only for one exact record copied once into multiple state packages."""
    states = {row[0] for row in rows}
    signatures = {row[3] for row in rows}
    return len(states) > 1 and len(rows) == len(states) and len(signatures) == 1


def regional_package_copies_to_remove(features, state_order):
    """Return package-local feature keys for exact NWI copies in a bounded extract.

    The regional tuple shape is (key,state,objectid,attribute,type,qaqc,acres,nwi_id,wkb).
    Its geometry is in the source CRS, before clipping or analytical simplification.
    """
    groups = {}
    for feature in features:
        identifier = str(feature[7] or "").strip()
        if identifier:
            groups.setdefault(identifier, []).append(feature)
    rank = {state: index for index, state in enumerate(state_order)}
    discarded = set()
    for identifier, group in groups.items():
        if len(group) < 2 or len({feature[1] for feature in group}) != len(group):
            continue
        signatures = set()
        for feature in group:
            geometry_digest = normalized_geometry_digest(wkb.loads(feature[8]))
            signatures.add(semantic_digest(identifier, str(feature[3] or ""), str(feature[4] or ""),
                                           str(feature[5] or ""), geometry_digest))
        if len(signatures) != 1:
            continue
        owner = min(group, key=lambda feature: (rank[feature[1]], feature[2]))
        discarded.update(feature[0] for feature in group if feature is not owner)
    return discarded


def member_cells(geometry, cell_ids):
    min_lon, min_lat, max_lon, max_lat = geometry.bounds
    x0, x1 = math.floor((min_lon + 180) / STEP), math.floor((max_lon + 180) / STEP)
    y0, y1 = math.floor((min_lat + 90) / STEP), math.floor((max_lat + 90) / STEP)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            cell_id = f"x{x}_y{y}"
            if cell_id not in cell_ids:
                continue
            bounds = (-180 + STEP*x, -90 + STEP*y, -180 + STEP*(x+1), -90 + STEP*(y+1))
            if geometry.intersects(box(*bounds)):
                yield cell_id


SCHEMA = pa.schema([
    ("canonical_feature_id", pa.string()), ("nwi_id", pa.string()), ("source_feature_id", pa.string()),
    ("source_state", pa.string()),
    ("source_objectid", pa.int64()), ("source_states", pa.string()), ("attribute", pa.string()),
    ("wetland_type", pa.string()), ("system_code", pa.string()), ("system_label", pa.string()),
    ("qaqc_code", pa.string()), ("source_acres", pa.float64()), ("geometry_digest", pa.string()),
    ("min_lon", pa.float64()), ("min_lat", pa.float64()), ("max_lon", pa.float64()),
    ("max_lat", pa.float64()), ("geometry", pa.binary())])
# The published schema is part of what a partition fragment *is*: a fragment written before a column existed
# cannot satisfy a manifest that declares it. Hashing it into the partition cache key means a schema change
# invalidates the fragments instead of silently reusing them, which is the difference between rebuilding two
# states and publishing a plane whose columns disagree with its own manifest.
SCHEMA_DIGEST = hashlib.sha256(json.dumps([(field.name, str(field.type)) for field in SCHEMA],
                                          separators=(",", ":")).encode()).hexdigest()[:16]


def write_geoparquet(rows, path, schema=SCHEMA):
    path = Path(path)
    table = pa.Table.from_pylist(rows, schema=schema)
    bounds = ([min(row["min_lon"] for row in rows), min(row["min_lat"] for row in rows),
               max(row["max_lon"] for row in rows), max(row["max_lat"] for row in rows)] if rows else None)
    geo = {"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": {
        "encoding": "WKB", "geometry_types": ["MultiPolygon"], "crs": CRS.from_epsg(4326).to_json_dict(),
        **({"bbox": bounds} if bounds else {})}}}
    table = table.replace_schema_metadata({b"geo": json.dumps(geo, separators=(",", ":")).encode()})
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    pq.write_table(table, temporary, compression="zstd", row_group_size=16384)
    if pq.read_metadata(temporary).num_rows != len(rows):
        raise ValueError(f"row count mismatch for {path}")
    temporary.replace(path)
    return {"rows": len(rows), "bytes": path.stat().st_size, "sha256": sha256_file(path)}
