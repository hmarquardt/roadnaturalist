#!/usr/bin/env python3
"""Build wetlands serving tiles from canonical cells, and prove they answer a promotion identically.

    uv run --python 3.12 --with duckdb --with pyarrow python3 scripts/serve-wetlands.py --verify 6
    uv run --python 3.12 --with duckdb --with pyarrow python3 scripts/serve-wetlands.py --build --cells x450_y599

A serving tile is a slice of one canonical 0.2 degree cell: every wetland feature is *cut* to the tile it falls
in, with its bounds recomputed and its `source_feature_id` untouched. This is the layout the measurement chose
(10.2 % of canonical bytes at 0.1 degrees, where bounding-box replication saved only about 17 %) and it is the
layout that keeps the reader's semantics, because the reader already prefilters on min/max bounds, counts DISTINCT
source_feature_id, and sums clipped areas - which is exactly what a partition of the same geometry into tiles
yields.
"""
import argparse
import hashlib
import json
import math
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = Path(os.environ.get("ROADNATURALIST_BUILD_VOLUME", "/Volumes/Lexar/roadnaturalist"))
CELLS = BUILD / "work/nwi/artifacts/wetlands"
CELL_STEP = 0.2
SERVING_VERSION = "nwi-serving-0.1-v1"
SERVING_STEP = 0.1
DISTANCES_M = [250, 500, 1000]
COLUMNS = ["canonical_feature_id", "nwi_id", "source_feature_id", "source_state", "source_objectid", "source_states",
           "attribute", "wetland_type", "system_code", "system_label", "qaqc_code", "source_acres", "geometry_digest",
           "min_lon", "min_lat", "max_lon", "max_lat", "geometry"]


def padded_bounds(bounds, distance_m=1000):
    centre = ((bounds[1] + bounds[3]) / 2) * math.pi / 180
    lat_pad = (distance_m / 110000) * 1.1
    lon_pad = (distance_m / (111320 * max(math.cos(centre), 0.2))) * 1.1
    return [bounds[0] - lon_pad, bounds[1] - lat_pad, bounds[2] + lon_pad, bounds[3] + lat_pad]


def tile_ids_for(bounds, step):
    x0 = math.floor((bounds[0] + 180) / step + 1e-9)
    x1 = math.ceil((bounds[2] + 180) / step - 1e-9) - 1
    y0 = math.floor((bounds[1] + 90) / step + 1e-9)
    y1 = math.ceil((bounds[3] + 90) / step - 1e-9) - 1
    return [f"x{x}_y{y}" for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def canonical_cells_for(bounds):
    return tile_ids_for(bounds, CELL_STEP)


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def build_cell(connection, cell, out_dir, step=SERVING_STEP):
    """Cut one canonical cell into serving tiles. Deterministic: the same source gives the same bytes."""
    source = CELLS / f"{cell}.parquet"
    if not source.exists():
        return None
    out_dir = Path(out_dir)
    listing_path = out_dir / f"{cell}.listing.json"
    if listing_path.exists():
        recorded = json.loads(listing_path.read_text())
        if all((out_dir / tile["file"]).exists() for tile in recorded["tiles"]):
            return recorded
    started = time.time()
    connection.execute(f"CREATE OR REPLACE TEMP VIEW c AS SELECT * FROM read_parquet('{source}')")
    rows = connection.execute("SELECT count(*) FROM c").fetchone()[0]
    connection.execute("DROP TABLE IF EXISTS serving")
    connection.execute(f"""
        CREATE TABLE serving AS
        SELECT {', '.join(COLUMNS[0:13])},
               ST_XMin(cut.geometry) AS min_lon, ST_YMin(cut.geometry) AS min_lat,
               ST_XMax(cut.geometry) AS max_lon, ST_YMax(cut.geometry) AS max_lat, cut.geometry AS geometry,
               tile.tile_x AS tile_x, tile.tile_y AS tile_y
        FROM c,
        LATERAL (SELECT unnest(range(CAST(floor((c.min_lon + 180)/{step}) AS BIGINT),
                                      CAST(floor((c.max_lon + 180)/{step}) AS BIGINT) + 1)) AS tile_x,
                        unnest(range(CAST(floor((c.min_lat + 90)/{step}) AS BIGINT),
                                      CAST(floor((c.max_lat + 90)/{step}) AS BIGINT) + 1)) AS tile_y) AS tile,
        LATERAL (SELECT ST_Intersection(c.geometry, ST_MakeEnvelope(tile.tile_x * {step} - 180,
                tile.tile_y * {step} - 90, (tile.tile_x + 1) * {step} - 180, (tile.tile_y + 1) * {step} - 90))
                AS geometry) AS cut
        WHERE NOT ST_IsEmpty(cut.geometry)""")
    out_dir.mkdir(parents=True, exist_ok=True)
    listing = []
    for tile_x, tile_y in connection.execute(
            "SELECT DISTINCT tile_x, tile_y FROM serving ORDER BY tile_x, tile_y").fetchall():
        path = out_dir / f"{cell}__x{tile_x}_y{tile_y}.parquet"
        connection.execute(f"""COPY (SELECT {', '.join(COLUMNS)} FROM serving
            WHERE tile_x = {tile_x} AND tile_y = {tile_y}) TO '{path}' (FORMAT PARQUET)""")
        counted = connection.execute(f"SELECT count(*), min(min_lon), min(min_lat), max(max_lon), max(max_lat) "
                                     f"FROM read_parquet('{path}')").fetchone()
        listing.append({"tile": f"x{tile_x}_y{tile_y}", "file": path.name, "sourceCell": cell,
                        "rows": counted[0], "bytes": path.stat().st_size, "sha256": sha256_of(path),
                        "bounds": [round(value, 9) for value in counted[1:]]})
    document = {"kind": "wetlands-serving-cell", "servingVersion": SERVING_VERSION,
                "sourcePlaneVersion": json.loads((ROOT / "data/national/wetland-manifest.json").read_text())["version"],
                "sourceCell": cell, "grid": {"stepLon": step, "stepLat": step, "origin": [-180, -90]},
                "geometry": "clipped", "canonicalRows": rows,
                "counts": {"tiles": len(listing), "bytes": sum(tile["bytes"] for tile in listing),
                           "rows": sum(tile["rows"] for tile in listing)},
                "seconds": round(time.time() - started, 2), "tiles": listing}
    listing_path.write_text(json.dumps(document, indent=1) + "\n")
    return document




# The reader's own statements, statement for statement: src/gis/habitat-query.js runs exactly these expressions and
# src/gis/habitat-metrics.js defines them. A serving layout that answers these identically answers the product
# identically - which is the whole claim a serving layer is allowed to make.
def projected(value):
    return f"ST_Transform({value}, 'EPSG:4326', 'EPSG:5070', always_xy := true)"


def reader_sql(table, wkt, corridor_bounds, distances=DISTANCES_M):
    outer = max(distances)
    pad = padded_bounds(corridor_bounds, outer)
    road = projected(f"ST_GeomFromText('{wkt}')")
    prefilter = f"min_lon <= {pad[2]} AND max_lon >= {pad[0]} AND min_lat <= {pad[3]} AND max_lat >= {pad[1]}"
    feature = projected("wetland.geometry")
    distances_sql = ", ".join(f"({int(distance)})" for distance in distances)
    return {
        "buffers": f"""
            WITH road AS (SELECT {road} AS g), d(distance_m) AS (VALUES {distances_sql}),
            hit AS (
              SELECT d.distance_m, wetland.wetland_type AS label, wetland.attribute AS code, wetland.source_feature_id,
                     ST_Area(ST_Intersection({feature}, ST_Buffer((SELECT g FROM road), d.distance_m))) AS area_m2
              FROM {table} AS wetland, d
              WHERE {prefilter} AND ST_Intersects({feature}, ST_Buffer((SELECT g FROM road), d.distance_m))
            )
            SELECT distance_m, label, code, count(DISTINCT source_feature_id) AS feature_count, sum(area_m2) AS area_m2
            FROM hit WHERE area_m2 > 0 GROUP BY distance_m, label, code ORDER BY distance_m, sum(area_m2) DESC""",
        "proximity": f"""
            WITH road AS (SELECT {road} AS g)
            SELECT count(*) FILTER (WHERE ST_Intersects({feature}, (SELECT g FROM road))) AS corridor_features,
                   min(ST_Distance({feature}, (SELECT g FROM road))) AS nearest_m
            FROM {table} AS wetland WHERE {prefilter}""",
        "ids": f"""
            WITH road AS (SELECT {road} AS g)
            SELECT DISTINCT wetland.source_feature_id FROM {table} AS wetland
            WHERE {prefilter} AND ST_Intersects({feature}, ST_Buffer((SELECT g FROM road), 250))""",
    }


def synthetic_road(bounds):
    """A line across the corridor's own box. The comparison does not depend on the road's exact shape, only on both
    sides measuring the same geometry."""
    mid_lat = (bounds[1] + bounds[3]) / 2
    return f"LINESTRING({bounds[0]} {mid_lat}, {bounds[2]} {mid_lat})"


def reader_result(connection, table, bounds, distances=DISTANCES_M):
    sql = reader_sql(table, synthetic_road(bounds), bounds, distances)
    buffers = [{"distanceM": int(row[0]), "label": row[1] or "Unclassified", "code": row[2],
                "featureCount": int(row[3]), "areaM2": float(row[4])}
               for row in connection.execute(sql["buffers"]).fetchall()]
    proximity = connection.execute(sql["proximity"]).fetchone()
    ids = sorted(str(row[0]) for row in connection.execute(sql["ids"]).fetchall())
    return {"buffers": buffers, "corridorFeatures": int(proximity[0] or 0),
            "nearestM": float(proximity[1]) if proximity[1] is not None else None, "ids250": ids}


def verify(connection, corridors, work, tolerance_m2=1.0):
    """Canonical cells against serving tiles, for the same corridor, with the reader's own SQL."""
    results = []
    for corridor in corridors:
        bounds = corridor["bounds"]
        window = padded_bounds(bounds, max(DISTANCES_M))
        cells = [cell for cell in canonical_cells_for(window) if (CELLS / f"{cell}.parquet").exists()]
        canonical_table = "read_parquet([" + ", ".join(f"'{CELLS}/{cell}.parquet'" for cell in cells) + "])"
        tiles = []
        serving_bytes = 0
        canonical_bytes = 0
        for cell in cells:
            source = CELLS / f"{cell}.parquet"
            source_size = source.stat().st_size
            canonical_bytes += source_size
            listing = build_cell(connection, cell, work / "cells")
            if not listing:
                continue
            wanted = set(tile_ids_for(window, SERVING_STEP))
            for tile in listing["tiles"]:
                if tile["tile"] in wanted:
                    tiles.append(str(work / "cells" / tile["file"]))
                    serving_bytes += tile["bytes"]
        if not tiles:
            results.append({"corridorId": corridor["corridorId"], "status": "no serving tiles"})
            continue
        serving_table = "read_parquet([" + ", ".join(f"'{path}'" for path in sorted(tiles)) + "])"
        before = reader_result(connection, canonical_table, bounds)
        after = reader_result(connection, serving_table, bounds)
        key = lambda row: (row["distanceM"], row["label"], row["code"])
        before_rows = {key(row): row for row in before["buffers"]}
        after_rows = {key(row): row for row in after["buffers"]}
        area_delta = 0.0
        mismatch = []
        for label in sorted(set(before_rows) | set(after_rows)):
            one, two = before_rows.get(label), after_rows.get(label)
            if one is None or two is None:
                mismatch.append({"class": list(label), "canonical": bool(one), "serving": bool(two)})
                continue
            area_delta = max(area_delta, abs(one["areaM2"] - two["areaM2"]))
            if one["featureCount"] != two["featureCount"] or abs(one["areaM2"] - two["areaM2"]) > tolerance_m2:
                mismatch.append({"class": list(label), "canonicalRows": one["featureCount"],
                                 "servingRows": two["featureCount"], "canonicalArea": one["areaM2"],
                                 "servingArea": two["areaM2"]})
        nearest_delta = None
        if before["nearestM"] is not None and after["nearestM"] is not None:
            nearest_delta = abs(before["nearestM"] - after["nearestM"])
        results.append({"corridorId": corridor["corridorId"], "name": corridor["name"], "region": corridor["region"],
                        "canonicalCells": len(cells), "canonicalBytes": canonical_bytes, "servingTiles": len(tiles),
                        "servingBytes": serving_bytes,
                        "reductionPercent": round((1 - serving_bytes / max(canonical_bytes, 1)) * 100, 1),
                        "classes": len(before_rows), "maxAreaDeltaM2": area_delta, "nearestDeltaM": nearest_delta,
                        "idsEqual": before["ids250"] == after["ids250"], "classMismatches": mismatch,
                        "corridorFeaturesEqual": before["corridorFeatures"] == after["corridorFeatures"],
                        "status": "equal" if not mismatch and before["ids250"] == after["ids250"] else "DIFFERS"})
    return results


def pick_corridors(count):
    footprint = json.loads((ROOT / "data/national/verification/raw-footprint.json").read_text())
    by_wetlands = sorted(footprint["corridors"], key=lambda row: -row["bytesByPlane"]["wetlands"])
    chosen = by_wetlands[: max(1, count // 2)] + by_wetlands[len(by_wetlands) // 2:][: max(1, count // 2)]
    chosen += [row for row in footprint["corridors"] if row["region"] == "pnw"][:1]
    return list({row["corridorId"]: row for row in chosen}.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--verify", type=int, default=0, help="corridors to compare canonical against serving")
    parser.add_argument("--cells", default=None, help="comma separated canonical cells to build")
    parser.add_argument("--out", default=None)
    parser.add_argument("--work", default=str(BUILD / "work/wetlands-serving"))
    args = parser.parse_args()

    import duckdb

    if not BUILD.exists():
        raise SystemExit(f"the build volume is required for serving-tile generation: {BUILD}")
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)

    if args.cells:
        documents = [build_cell(connection, cell.strip(), work / "cells") for cell in args.cells.split(",")]
        print(json.dumps([{k: doc[k] for k in ("sourceCell", "counts", "seconds")} for doc in documents if doc], indent=1))
        return 0

    started = time.time()
    results = verify(connection, pick_corridors(args.verify or 6), work)
    report = {"kind": "wetlands-serving-equivalence", "schemaVersion": 1, "servingVersion": SERVING_VERSION,
              "sourcePlaneVersion": json.loads((ROOT / "data/national/wetland-manifest.json").read_text())["version"],
              "grid": {"stepLon": SERVING_STEP, "stepLat": SERVING_STEP}, "geometry": "clipped",
              "corridors": results, "seconds": round(time.time() - started, 1)}
    out = Path(args.out) if args.out else ROOT / "data/national/verification/wetlands-serving-equivalence.json"
    out.write_text(json.dumps(report, indent=1) + "\n")
    canonical = sum(row.get("canonicalBytes", 0) for row in results)
    serving = sum(row.get("servingBytes", 0) for row in results)
    print(f"equivalence over {len(results)} corridors: "
          f"{sum(1 for row in results if row.get('status') == 'equal')} equal")
    print(f"  canonical {canonical/1e6:.1f} MB -> serving {serving/1e6:.1f} MB ({serving/max(canonical, 1)*100:.1f}%)")
    for row in results:
        print(f"  {str(row.get('region')):>10} {str(row.get('name'))[:24]:24} cells {row.get('canonicalCells')} "
              f"({row.get('canonicalBytes', 0)/1e6:7.1f} MB) tiles {row.get('servingTiles')} "
              f"({row.get('servingBytes', 0)/1e6:6.1f} MB, -{row.get('reductionPercent', 0)}%) "
              f"area delta {row.get('maxAreaDeltaM2', 0):.6f} m2 ids {row.get('idsEqual')} -> {row.get('status')}")
        for mismatch in row.get("classMismatches", [])[:3]:
            print(f"      mismatch {mismatch}")
    failing = [row for row in results if row.get("status") != "equal"]
    return 0 if not failing else 1


if __name__ == "__main__":
    raise SystemExit(main())
