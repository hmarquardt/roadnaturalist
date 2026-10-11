#!/usr/bin/env python3
"""Measure the two candidate wetlands serving layouts against the canonical 0.2 degree plane.

    uv run --python 3.12 --with duckdb --with pyarrow python3 scripts/prototype-wetlands-serving.py

A promotion downloads whole canonical wetland cells, and one cell can reach 188 MB while a promotion's buffer is
about 2 km wide. Two candidate serving layouts are measured on real canonical cells and real derived corridors:

  * finer fixed subcells (0.1 and 0.05 degrees), where a feature is *replicated* into every subcell its bounding
    box intersects - the layout that preserves the reader's semantics exactly, because the reader already
    prefilters on min/max bounds and dedupes by source_feature_id across the whole relation;
  * publication-time clipping to one promotion window - fewer bytes per artifact, but an artifact that only serves
    the window it was clipped for.

Both are compared against the canonical cost the footprint report already measured (whole cells). Reuse decides it:
subcells are shared by every corridor that touches them, clips are not.
"""
import argparse
import json
import math
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = Path(os.environ.get("ROADNATURALIST_BUILD_VOLUME", "/Volumes/Lexar/roadnaturalist"))
CELLS = BUILD / "work/nwi/artifacts/wetlands"
STEP = 0.2


def padded_bounds(bounds, distance_m=1000):
    centre = ((bounds[1] + bounds[3]) / 2) * math.pi / 180
    lat_pad = (distance_m / 110000) * 1.1
    lon_pad = (distance_m / (111320 * max(math.cos(centre), 0.2))) * 1.1
    return [bounds[0] - lon_pad, bounds[1] - lat_pad, bounds[2] + lon_pad, bounds[3] + lat_pad]


def grid_cells(bounds, step):
    """The canonical grid convention: x = (lon + 180) / step, y = (lat + 90) / step."""
    x0 = math.floor((bounds[0] + 180) / step)
    x1 = math.floor((bounds[2] + 180) / step)
    y0 = math.floor((bounds[1] + 90) / step)
    y1 = math.floor((bounds[3] + 90) / step)
    return [f"x{x}_y{y}" for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def build_subcells(connection, cell, step, out_dir):
    """One Parquet per subcell, holding every feature whose bounding box intersects it.

    Bounding-box membership is exactly what the reader needs: it prefilters on min/max bounds, so a feature that
    cannot reach the window is not needed, and one that can reach it is present in every window it could reach.
    No geometry is cut, so source identity and area semantics are untouched.
    """
    source = CELLS / f"{cell}.parquet"
    if not source.exists():
        return None
    started = time.time()
    rows = connection.execute(f"SELECT count(*) FROM read_parquet('{source}')").fetchone()[0]
    connection.execute(f"""
        COPY (
          SELECT f.*, t.tile_x, t.tile_y
          FROM read_parquet('{source}') AS f,
          LATERAL (SELECT unnest(range(CAST(floor(f.min_lon/{step}) AS BIGINT), CAST(floor(f.max_lon/{step}) AS BIGINT) + 1)) AS tile_x,
                          unnest(range(CAST(floor(f.min_lat/{step}) AS BIGINT), CAST(floor(f.max_lat/{step}) AS BIGINT) + 1)) AS tile_y) AS t
        ) TO '{out_dir}' (FORMAT PARQUET, PARTITION_BY (tile_x, tile_y), OVERWRITE_OR_IGNORE 1)""")
    tiles = {}
    files = []
    for path in sorted(Path(out_dir).rglob("*.parquet")):
        # ExFAT leaves an AppleDouble sidecar beside every file; a sidecar is not data.
        if path.name.startswith('._'):
            continue
        files.append(path)
        parent = path.parent
        tile_id = f"{parent.parent.name.replace('tile_x=', 'x')}_{parent.name.replace('tile_y=', 'y')}"
        tiles[tile_id] = path.stat().st_size
    quoted = ', '.join(f"'{path}'" for path in files)
    written = connection.execute(f"SELECT count(*) FROM read_parquet([{quoted}])").fetchone()[0] if files else 0
    return {"cell": cell, "rows": rows, "rowsWritten": written, "replication": written / rows if rows else 0,
            "objects": len(tiles), "bytes": sum(tiles.values()), "tiles": tiles,
            "seconds": round(time.time() - started, 2)}


def build_clipped_subcells(connection, cell, step, out_dir):
    """The other strategy: cut each feature to the tile it falls in.

    A bounding-box layout keeps a feature whole, and in wetland country one feature can span tens of megabytes, so
    the box cannot shrink an object below the biggest feature it holds. Cutting does: each tile holds only the part
    of each feature inside it, with its bounds recomputed and its source_feature_id untouched, which is what the
    reader's DISTINCT counting and area summing already expect.
    """
    source = CELLS / f"{cell}.parquet"
    if not source.exists():
        return None
    started = time.time()
    rows = connection.execute(f"SELECT count(*) FROM read_parquet('{source}')").fetchone()[0]
    connection.execute(f"""
        COPY (
          SELECT canonical_feature_id, nwi_id, source_feature_id, source_state, source_objectid, source_states,
                 attribute, wetland_type, system_code, system_label, qaqc_code, source_acres, geometry_digest,
                 ST_XMin(f.geometry) AS min_lon, ST_YMin(f.geometry) AS min_lat,
                 ST_XMax(f.geometry) AS max_lon, ST_YMax(f.geometry) AS max_lat, f.geometry AS geometry,
                 f.tile_x, f.tile_y
          FROM (
            SELECT f.*, tile.tile_x, tile.tile_y,
                   ST_MakeEnvelope(tile.tile_x * {step} - 180, tile.tile_y * {step} - 90,
                                   (tile.tile_x + 1) * {step} - 180, (tile.tile_y + 1) * {step} - 90) AS tile_geom
            FROM read_parquet('{source}') AS f,
            LATERAL (SELECT unnest(range(CAST(floor((f.min_lon + 180)/{step}) AS BIGINT), CAST(floor((f.max_lon + 180)/{step}) AS BIGINT) + 1)) AS tile_x,
                            unnest(range(CAST(floor((f.min_lat + 90)/{step}) AS BIGINT), CAST(floor((f.max_lat + 90)/{step}) AS BIGINT) + 1)) AS tile_y) AS tile
          ) AS f, LATERAL (SELECT ST_Intersection(f.geometry, f.tile_geom) AS geometry) AS cut
          WHERE NOT ST_IsEmpty(cut.geometry)
        ) TO '{out_dir}' (FORMAT PARQUET, PARTITION_BY (tile_x, tile_y), OVERWRITE_OR_IGNORE 1)""")
    tiles = {}
    for path in sorted(Path(out_dir).rglob("*.parquet")):
        if path.name.startswith('._'):
            continue
        parent = path.parent
        tiles[f"{parent.parent.name.replace('tile_x=', 'x')}_{parent.name.replace('tile_y=', 'y')}"] = path.stat().st_size
    return {"cell": cell, "rows": rows, "objects": len(tiles), "bytes": sum(tiles.values()), "tiles": tiles,
            "seconds": round(time.time() - started, 2)}


async def _unused():
    pass


def clip(connection, cell, window):
    source = CELLS / f"{cell}.parquet"
    if not source.exists():
        return {"rows": 0, "bytes": 0}
    connection.execute("DROP TABLE IF EXISTS clip")
    connection.execute(f"""
        CREATE TABLE clip AS SELECT * FROM read_parquet('{source}')
        WHERE min_lon <= {window[2]} AND max_lon >= {window[0]} AND min_lat <= {window[3]} AND max_lat >= {window[1]}""")
    rows = connection.execute("SELECT count(*) FROM clip").fetchone()[0]
    connection.execute("COPY clip TO '/tmp/wetland-clip.parquet' (FORMAT PARQUET)")
    return {"rows": rows, "bytes": Path("/tmp/wetland-clip.parquet").stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--steps", default="0.1,0.05")
    parser.add_argument("--strategy", choices=['bbox', 'clipped'], default='bbox')
    parser.add_argument("--tag", default=None)
    parser.add_argument("--corridors", type=int, default=12)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    if args.out is None:
        args.out = str(ROOT / f"data/national/verification/wetlands-serving-prototype{'-' + args.tag if args.tag else ''}.json")

    import duckdb

    manifest = json.loads((ROOT / "data/national/wetland-manifest.json").read_text())
    present = {cell["id"]: cell for cell in manifest["cells"] if cell["state"] == "present"}
    footprint = json.loads((ROOT / "data/national/verification/raw-footprint.json").read_text())
    by_wetlands = sorted(footprint["corridors"], key=lambda row: -row["bytesByPlane"]["wetlands"])
    # The corridors the current layout hurts most, a spread of typical ones, and a Pacific Northwest pair so the
    # sample is not only wetland country.
    chosen = by_wetlands[: args.corridors // 2] + by_wetlands[len(by_wetlands) // 2:][: args.corridors // 2]
    chosen += [row for row in footprint["corridors"] if row["region"] == "pnw"][:2]
    sample = {row["corridorId"]: row for row in chosen}
    connection = duckdb.connect()
    connection.execute('INSTALL spatial; LOAD spatial;')
    work = BUILD / "work/wetlands-serving-prototype"
    work.mkdir(parents=True, exist_ok=True)

    report = {"kind": "wetlands-serving-prototype", "schemaVersion": 1, "strategy": args.strategy,
              "canonical": {"version": manifest["version"], "presentCells": len(present),
                            "bytes": sum(cell["bytes"] for cell in present.values())},
              "sampledCorridors": len(sample), "steps": {}}
    for step in [float(value) for value in args.steps.split(",")]:
        step_dir = work / f"step-{step}"
        step_dir.mkdir(exist_ok=True)
        builder = build_clipped_subcells if args.strategy == 'clipped' else build_subcells
        built = {}
        rows = []
        for corridor in sample.values():
            window = padded_bounds(corridor["bounds"])
            needed = [cell for cell in grid_cells(window, STEP) if cell in present]
            serving_bytes = 0
            serving_tiles = 0
            clip_bytes = 0
            clip_rows = 0
            for cell in needed:
                if cell not in built:
                    built[cell] = builder(connection, cell, step, str(step_dir / cell))
                entry = built[cell]
                if entry:
                    wanted = set(grid_cells(window, step))
                    for tile_id, size in entry["tiles"].items():
                        if tile_id in wanted:
                            serving_bytes += size
                            serving_tiles += 1
                cropped = clip(connection, cell, window)
                clip_bytes += cropped["bytes"]
                clip_rows += cropped["rows"]
            rows.append({"corridorId": corridor["corridorId"], "name": corridor["name"], "region": corridor["region"],
                         "canonicalCells": len(needed), "canonicalBytes": corridor["bytesByPlane"]["wetlands"],
                         "servingTiles": serving_tiles, "servingBytes": serving_bytes,
                         "clipBytes": clip_bytes, "clipRows": clip_rows})
        report["steps"][str(step)] = {"strategy": args.strategy, "corridors": rows,
                                      "cells": sorted([entry for entry in built.values() if entry],
                                                      key=lambda entry: -entry["bytes"])}
    Path(args.out).write_text(json.dumps(report, indent=1) + "\n")

    print(f"canonical: {report['canonical']['presentCells']:,} cells, {report['canonical']['bytes']/1e9:.2f} GB")
    for step, data in report["steps"].items():
        rows = data["corridors"]
        canonical = sum(row["canonicalBytes"] for row in rows)
        serving = sum(row["servingBytes"] for row in rows)
        clips = sum(row["clipBytes"] for row in rows)
        tiles = sum(row["servingTiles"] for row in rows)
        print(f"\nstep {step}: {len(rows)} corridors")
        print(f"  canonical whole cells {canonical/1e6:8.1f} MB over {sum(row['canonicalCells'] for row in rows)} cells")
        print(f"  serving subcells     {serving/1e6:8.1f} MB over {tiles} tiles "
              f"({serving/max(canonical, 1)*100:.1f}% of canonical)")
        print(f"  clipped windows      {clips/1e6:8.1f} MB ({clips/max(canonical, 1)*100:.1f}% of canonical)")
        entries = data["cells"]
        if entries:
            print(f"  build: {len(entries)} canonical cells -> {sum(e['objects'] for e in entries):,} tiles, "
                  f"{sum(e['bytes'] for e in entries)/1e6:.1f} MB, rows x"
                  f"{sum(e['rowsWritten'] for e in entries)/max(sum(e['rows'] for e in entries), 1):.2f}, "
                  f"{sum(e['seconds'] for e in entries):.1f}s")
            worst = entries[0]
            print(f"  worst cell {worst['cell']}: {worst['rows']:,} rows -> {worst['objects']} tiles, "
                  f"{worst['bytes']/1e6:.1f} MB, x{worst['replication']:.2f} rows")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    raise SystemExit(main())

