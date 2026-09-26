#!/usr/bin/env python3
"""Pinned TIGER/Line 2025 ROADS sources, shared by the road-data build scripts.

Road Naturalist builds two artifacts from the same pinned county archives:

    * ``data/gis/or-roads-pilot-2025.parquet``   (``scripts/build-roads.py``)        the three named pilot roads
    * ``data/gis/or-roads-network-2025.parquet`` (``scripts/build-road-network.py``) the bounded discovery network

Both artifacts must agree about provenance, digests, CRS, and geometry handling, so those decisions
live here once. The source constants, the bounding windows, and the low-level readers are the shared
part; each script keeps its own extraction rule (pilot: road name; network: TIGER feature class).

Source coordinates are stored exactly as TIGER/Line publishes them: NAD83 (EPSG:4269) decimal
degrees written into an EPSG:4326 column. The two datums differ below the source's own positional
accuracy, and keeping the source numbers means both artifacts hold identical coordinates for
identical source features. Lengths are always measured in EPSG:5070 meters. See docs/ROADS.md.
"""
import hashlib
import json
import math
import urllib.request
import zipfile
from contextlib import contextmanager
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import shapefile
from pyproj import CRS, Transformer

SOURCE_BASE = "https://www2.census.gov/geo/tiger/TIGER2025/ROADS/"
SOURCE_AGENCY = "U.S. Census Bureau"
SOURCE_DATASET = "TIGER/Line 2025 ROADS (county road centerlines)"
SOURCE_VINTAGE = "TIGER2025"
SOURCE_PUBLICATION_DATE = "2025-09-22"
SOURCE_DOCS = "https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html"
SOURCE_LICENSE = "Public domain (U.S. Government work)"
SOURCE_CRS = "EPSG:4269"
GEOMETRY_CRS = "EPSG:4326"
MEASURE_CRS = "EPSG:5070"
# Pinned county ROADS archives: county FIPS -> (county name, archive file name, SHA-256).
COUNTIES = {
    "41067": ("Washington County, Oregon", "tl_2025_41067_roads.zip",
              "fda13013515689b57a500462db9b19bdd4dc0c3a70d341eec7eb9f7d7c42eea7"),
    "41051": ("Multnomah County, Oregon", "tl_2025_41051_roads.zip",
              "30ae0afe1a0bb6685da281b8ad97fc708876b61e9bfc7c1f0f96118d33d3cb92"),
}
# The hand-selected pilot window. Bounded extract, not a county or state road catalog.
PILOT_BBOX = (-123.10, 45.50, -122.70, 45.70)
# The discovery window is the bounded habitat analysis window (data/manifest.json, scope.bbox of the
# NWI and NHD extracts), because candidate discovery only claims FULL coverage where wetlands,
# hydrography, and ecoregions all cover the requested area. A test asserts this equality.
NETWORK_BBOX = (-123.07, 45.505, -122.75, 45.67)
# Conus Albers (EPSG:5070) meters for deterministic length and endpoint measurements.
TO_METERS = Transformer.from_crs(4326, MEASURE_CRS, always_xy=True).transform
# Composition tolerance mirrors src/roads/normalize.js: short junction gaps are joined in order,
# larger gaps are reported as unresolved rather than invented.
COMPOSITION_TOLERANCE_M = 150.0
REVERSED_LINK_LENGTH_RATIO = 0.25


def sha256_of(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_archive(county_fips, supplied, cache, download):
    """Return a pinned county archive path, verifying the published digest."""
    name, digest = COUNTIES[county_fips][1], COUNTIES[county_fips][2]
    path = supplied or Path(cache) / name
    if not path.exists():
        if not download:
            raise FileNotFoundError(f"{path} missing; pass --download or --archive")
        Path(cache).mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(SOURCE_BASE + name, path)
    actual = sha256_of(path)
    if actual != digest:
        raise ValueError(f"{name} SHA-256 mismatch: {actual} (source republished? see docs/ROADS.md)")
    return path


@contextmanager
def open_roads(county_fips, archive):
    """Yield ``(reader, fields, source_crs)`` for one county ROADS archive inside its ZIP."""
    stem = Path(COUNTIES[county_fips][1]).stem
    with zipfile.ZipFile(archive) as archive_zip:
        source_crs = CRS.from_wkt(archive_zip.read(stem + ".prj").decode())
        if source_crs.to_authority() != ("EPSG", "4269"):
            raise ValueError(f"{county_fips} source CRS is {source_crs.to_authority()}, expected EPSG:4269")
        reader = shapefile.Reader(shp=archive_zip.open(stem + ".shp"), shx=archive_zip.open(stem + ".shx"),
                                  dbf=archive_zip.open(stem + ".dbf"), encoding="latin1")
        yield reader, [field[0] for field in reader.fields[1:]], source_crs


def feature_parts(reader, fields):
    """Yield ``(record, part_index, coordinates)`` for every part of every source line feature."""
    for feature in reader.iterShapeRecords():
        record = dict(zip(fields, feature.record))
        geometry = feature.shape.__geo_interface__
        parts = geometry["coordinates"] if geometry["type"] == "MultiLineString" else [geometry["coordinates"]]
        for part_index, part in enumerate(parts):
            yield record, part_index, clean(part)


def clean(coords):
    """Drop consecutive duplicate vertices; real centerlines repeat junction vertices."""
    kept = []
    for point in coords:
        if kept and (point[0], point[1]) == (kept[-1][0], kept[-1][1]):
            continue
        kept.append((float(point[0]), float(point[1])))
    return kept


def bounds_of(coordinates):
    xs = [point[0] for point in coordinates]
    ys = [point[1] for point in coordinates]
    return min(xs), min(ys), max(xs), max(ys)


def within(window, coordinates):
    """True when every vertex of the line lies inside ``window`` (a bounded extract, never clipped)."""
    min_lon, min_lat, max_lon, max_lat = bounds_of(coordinates)
    return min_lon >= window[0] and min_lat >= window[1] and max_lon <= window[2] and max_lat <= window[3]


def overlaps(window, coordinates):
    min_lon, min_lat, max_lon, max_lat = bounds_of(coordinates)
    return not (max_lon < window[0] or min_lon > window[2] or max_lat < window[1] or min_lat > window[3])


def line_length_m(coordinates):
    projected = [TO_METERS(lon, lat) for lon, lat in coordinates]
    return sum(((projected[index][0] - projected[index - 1][0]) ** 2
                + (projected[index][1] - projected[index - 1][1]) ** 2) ** 0.5
               for index in range(1, len(projected)))


# The browser measures corridor length with this spherical formula (src/domain/geometry.js
# haversineM, mean Earth radius 12,742,000 m). The road-network extract uses the same metric for its
# length column and its discovery unit lengths so the offline extraction summary and the browser count
# the same corridor. The road *pilot* artifact keeps the EPSG:5070 measurement it was audited with.
EARTH_RADIUS_M = 12742000


def haversine_m(first, second):
    """Mirror of ``haversineM`` in src/domain/geometry.js, constant and formula included."""
    half_lat = math.radians(second[1] - first[1]) / 2
    half_lon = math.radians(second[0] - first[0]) / 2
    h = math.sin(half_lat) ** 2 + math.cos(math.radians(first[1])) * math.cos(math.radians(second[1])) * math.sin(half_lon) ** 2
    return EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def haversine_length_m(coordinates):
    return sum(haversine_m(coordinates[index - 1], coordinates[index]) for index in range(1, len(coordinates)))


def slug(text):
    cleaned = "".join(char.lower() if char.isalnum() else "-" for char in str(text))
    return "-".join(part for part in cleaned.split("-") if part)


def endpoint_gap_m(first, second):
    first_m = [TO_METERS(lon, lat) for lon, lat in (first[0], first[-1])]
    second_m = [TO_METERS(lon, lat) for lon, lat in (second[0], second[-1])]
    return min(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 for a in first_m for b in second_m)


def haversine_endpoint_gap_m(first, second):
    """Endpoint proximity measured exactly like src/roads/normalize.js ``endpointGapM``."""
    return min(haversine_m(a, b) for a in (first[0], first[-1]) for b in (second[0], second[-1]))


def is_reversed_link(first, second, tolerance_m=COMPOSITION_TOLERANCE_M):
    """True when two features digitize the same short stretch of road in opposite directions."""
    if endpoint_gap_m(list(reversed(first)), second) > tolerance_m:
        return False
    lengths = (line_length_m(first), line_length_m(second))
    if abs(lengths[0] - lengths[1]) > REVERSED_LINK_LENGTH_RATIO * max(lengths):
        return False
    midpoints = [TO_METERS(*line[len(line) // 2]) for line in (first, second)]
    return ((midpoints[0][0] - midpoints[1][0]) ** 2 + (midpoints[0][1] - midpoints[1][1]) ** 2) ** 0.5 <= tolerance_m


def haversine_is_reversed_link(first, second, tolerance_m=COMPOSITION_TOLERANCE_M):
    """Mirror of ``isReversedLink`` in src/roads/normalize.js, metric and midpoint check included."""
    if haversine_endpoint_gap_m(list(reversed(first)), second) > tolerance_m:
        return False
    lengths = (haversine_length_m(first), haversine_length_m(second))
    if abs(lengths[0] - lengths[1]) > REVERSED_LINK_LENGTH_RATIO * max(lengths):
        return False
    midpoints = [line[len(line) // 2] for line in (first, second)]
    return haversine_m(midpoints[0], midpoints[1]) <= tolerance_m


def unique_lines(lines, length_fn=line_length_m, reversed_link_fn=is_reversed_link):
    """Duplicate handling mirroring src/roads/normalize.js: exact and reversed duplicates collapse."""
    def key(line):
        return (-length_fn(line), tuple(line[0]), tuple(line[-1]))
    kept, seen = [], set()
    for line in sorted(lines, key=key):
        sequences = (tuple(line), tuple(reversed(line)))
        if sequences[0] in seen or sequences[1] in seen:
            continue
        seen.update(sequences)
        kept.append(line)
    collapsed = []
    for line in kept:
        if not any(reversed_link_fn(line, other) for other in collapsed):
            collapsed.append(line)
    return collapsed


def composed_lines(rows):
    """Duplicate handling used for offline verification of one county-scoped road."""
    return unique_lines([list(row["coordinates"]) for row in rows])


def write_geoparquet(rows, path):
    """Write one GeoParquet table and verify it reads back through DuckDB Spatial."""
    path = Path(path)
    columns = {key: [row[key] for row in rows] for key in rows[0]}
    table = pa.table(columns)
    geo = {"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": {
        "encoding": "WKB", "geometry_types": ["LineString"], "crs": CRS.from_epsg(4326).to_json_dict(),
        "bbox": [min(row["min_lon"] for row in rows), min(row["min_lat"] for row in rows),
                 max(row["max_lon"] for row in rows), max(row["max_lat"] for row in rows)]}}}
    table = table.replace_schema_metadata({b"geo": json.dumps(geo, separators=(",", ":")).encode()})
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path, compression="zstd")
    reread = pq.read_table(path)
    if reread.num_rows != len(rows) or b"geo" not in reread.schema.metadata:
        raise ValueError("GeoParquet round-trip failed")
    if any(value is None for value in reread.column("geometry").to_pylist()):
        raise ValueError("GeoParquet contains null geometry")
    conn = duckdb.connect()
    conn.execute("INSTALL spatial; LOAD spatial;")
    total, roads, points, linears = conn.execute(
        "SELECT count(*), count(DISTINCT road_id), sum(ST_NPoints(geometry)), "
        "sum(CASE WHEN ST_GeometryType(geometry) = 'LINESTRING' THEN 1 ELSE 0 END) FROM read_parquet(?)",
        [str(path)]).fetchone()
    if (total, linears) != (len(rows), len(rows)) or roads < 1 or points < len(rows) * 2:
        raise ValueError("DuckDB read-back failed")
    return {"featureCount": int(total), "roadCount": int(roads), "pointCount": int(points)}


def probe_units(features, tolerance_m=COMPOSITION_TOLERANCE_M, length_fn=line_length_m, gap_fn=endpoint_gap_m,
                dedupe_fn=unique_lines):
    """Offline cross-check of the browser road-unit builder (src/discovery/units.js).

    ``features`` are ``(name_key, coordinates)`` pairs. Named source features are deduplicated,
    joined by endpoint proximity, and every connected group becomes one unit. Returns
    ``{name_key: {"unitLengthsM": [...], "featureCount": n, "collapsedDuplicates": n}}`` so a test
    can compare Python and JavaScript composition independently.
    """
    groups = {}
    for name_key, coordinates in features:
        groups.setdefault(name_key, []).append(list(coordinates))
    units = {}
    for name_key, lines in sorted(groups.items()):
        kept = dedupe_fn(lines, length_fn=length_fn) if dedupe_fn is unique_lines else dedupe_fn(lines)
        parent = list(range(len(kept)))

        def find(index):
            while parent[index] != index:
                parent[index] = parent[parent[index]]
                index = parent[index]
            return index

        for a in range(len(kept)):
            for b in range(a + 1, len(kept)):
                if gap_fn(kept[a], kept[b]) <= tolerance_m:
                    parent[find(a)] = find(b)
        components = {}
        for index, line in enumerate(kept):
            components.setdefault(find(index), []).append(line)
        units[name_key] = {
            "unitLengthsM": sorted(round(sum(length_fn(line) for line in group), 3)
                                   for group in components.values()),
            "featureCount": len(lines),
            "collapsedDuplicates": len(lines) - len(kept),
        }
    return units
