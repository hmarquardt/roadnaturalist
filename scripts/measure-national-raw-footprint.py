#!/usr/bin/env python3
"""Measure what one national corridor promotion actually needs from the raw planes.

    uv run --python 3.12 --with duckdb --with pyarrow python3 scripts/measure-national-raw-footprint.py
    uv run ... scripts/measure-national-raw-footprint.py --per-region 25 --out data/national/verification/raw-footprint.json

The question this answers is architectural, so it is answered from the real published planes rather than from an
estimate: for corridors sampled out of the *derived* plane in each of the six national regions, which raw road,
wetland and hydrography cells does a promotion read, and how many bytes are they? The rules are the runtime's own
rules - the road selection keeps one cell of margin around the corridor box (the composition tolerance can reach
one cell), the habitat selection pads the box by the 1 km analysis distance exactly as ``paddedBounds`` does - and
the sample deliberately spans short, long, wetland-heavy and hydro-heavy corridors, plus one that sits near a cell
boundary.

It also reports the growth curve, because that is what decides whether a bounded raw publication is worth the
trouble: promotions cluster, so a published working set converges long before it approaches the ~188 GB lake.
"""
import argparse
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = Path(os.environ.get("ROADNATURALIST_BUILD_VOLUME", "/Volumes/Lexar/roadnaturalist"))
CATALOG = "data/national/derived-catalog.json"
DEFAULT_OUT = "data/national/verification/raw-footprint.json"

STEP_LON, STEP_LAT, ORIGIN = 0.2, 0.2, (-180.0, -90.0)
ANALYSIS_DISTANCE_M = 1000
# One cell of margin for roads: composition tolerance joins features less than a cell apart, which is why the
# pre-closure rule grew the road selection by one cell in every direction.
ROAD_MARGIN_DEG = 0.2

# A centre inside each national region, used only to choose which derived cells to sample.
REGION_CENTRES = {"pnw": (-122.92, 45.595), "northeast": (-71.06, 42.36), "gulf": (-90.07, 29.95),
                  "midwest": (-87.63, 41.88), "plains": (-96.68, 40.81), "southwest": (-112.07, 33.45)}
PLANES = ("roads", "wetlands", "hydrography")


def intersects(a, b):
    return a[0] <= b[2] and a[2] >= b[0] and a[1] <= b[3] and a[3] >= b[1]


def padded_bounds(bounds, distance_m):
    """The runtime's own padding rule (src/gis/habitat-result.js), so a measured footprint is the fetched one."""
    centre = ((bounds[1] + bounds[3]) / 2) * math.pi / 180
    lat_pad = (distance_m / 110000) * 1.1
    lon_pad = (distance_m / (111320 * max(math.cos(centre), 0.2))) * 1.1
    return [bounds[0] - lon_pad, bounds[1] - lat_pad, bounds[2] + lon_pad, bounds[3] + lat_pad]


def expand(bounds, degrees):
    return [bounds[0] - degrees, bounds[1] - degrees, bounds[2] + degrees, bounds[3] + degrees]


def cells_for(bounds, index):
    return sorted(cell for cell, entry in index.items() if intersects(entry["bounds"], bounds))


def percentile(values, fraction):
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(fraction * len(ordered)))]


def load_planes():
    planes = {}
    for name, path in (("roads", "data/national/road-manifest.json"),
                       ("wetlands", "data/national/wetland-manifest.json"),
                       ("hydrography", "data/national/hydro-manifest.json")):
        document = json.loads((ROOT / path).read_text())
        planes[name] = {"version": document["version"], "cells": {cell["id"]: cell for cell in document["cells"]},
                        "bytes": sum(cell.get("bytes", 0) for cell in document["cells"] if cell["state"] == "present"),
                        "present": document["counts"].get("present"), "empty": document["counts"].get("empty")}
    ecoregions = json.loads((ROOT / "data/national/epa-manifest.json").read_text())
    planes["ecoregions"] = {"version": ecoregions["version"],
                            "artifacts": {level: {"bytes": entry["bytes"], "sha256": entry["sha256"],
                                                  "url": entry["url"]}
                                          for level, entry in ecoregions["artifacts"].items()},
                            "bytes": sum(entry["bytes"] for entry in ecoregions["artifacts"].values())}
    return planes


def derived_root():
    catalog = json.loads((ROOT / CATALOG).read_text())
    return BUILD / "cells/derived/corridor-metrics" / catalog["derived"]["analysisFingerprint"]


def sample_corridors(per_region):
    """Real corridor rows out of the derived plane: shortest, longest, wetland-heavy, hydro-heavy and a spread."""
    import duckdb

    catalog = json.loads((ROOT / CATALOG).read_text())
    fingerprint = catalog["derived"]["analysisFingerprint"]
    root = BUILD / "cells/derived/corridor-metrics" / fingerprint
    manifest = json.loads((root / "manifest.json").read_text())
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial;")
    samples = {}
    for region, (lon, lat) in REGION_CENTRES.items():
        # The derived cells nearest the region centre that are present: local, cheap, and real.
        candidates = sorted((cell for cell in manifest["cells"] if cell["state"] == "present"),
                            key=lambda cell: (cell["bounds"][0] - lon) ** 2 + (cell["bounds"][1] - lat) ** 2)[:8]
        rows = []
        for cell in candidates:
            path = root / "cells" / f"{cell['id']}.parquet"
            if not path.exists():
                continue
            rows.extend(connection.execute(f"""
                SELECT corridor_id, name, length_m, coverage, wetland_area_1000_m2, hydro_crossing_count,
                       hydro_flowline_length_1000_m, ST_XMin(geometry) AS min_lon, ST_YMin(geometry) AS min_lat,
                       ST_XMax(geometry) AS max_lon, ST_YMax(geometry) AS max_lat, road_component_id
                FROM (SELECT *, row_number() OVER (PARTITION BY corridor_id) AS rn
                      FROM read_parquet('{path}')) WHERE rn = 1""").fetchall())
            if len(rows) >= per_region * 4:
                break
        if not rows:
            continue
        rows.sort(key=lambda row: row[2])
        offset = lambda value: (value - ORIGIN[0]) % STEP_LON
        boundary = min(rows, key=lambda row: min(min(offset(row[7]), STEP_LON - offset(row[7])),
                                                 min(offset(row[9]), STEP_LON - offset(row[9]))))
        chosen = [rows[0], rows[-1], max(rows, key=lambda row: row[4] or 0),
                  max(rows, key=lambda row: (row[5] or 0) * 1000 + (row[6] or 0)), boundary]
        chosen.extend(rows[:: max(1, len(rows) // per_region)][:per_region])
        samples[region] = list({row[0]: row for row in chosen}.values())
    return samples


def component_cells(root, catalog):
    """Component -> the derived cells it appears in, read once from the derived plane.

    The road closure the runtime performs is over this relationship: a promotion loads every cell its corridor's
    road component occupies, so the road part of a footprint is the component's cell count rather than a margin.
    Measured here from the derived plane itself, which is the same relationship the national component index
    publishes.
    """
    import duckdb

    files = sorted(path for path in (root / "cells").glob("*.parquet") if not path.name.startswith("._"))
    connection = duckdb.connect()
    quoted = ", ".join(f"'{path}'" for path in files)
    rows = connection.execute(f"""
        SELECT DISTINCT road_component_id, regexp_extract(filename, '([^/]+)[.]parquet$', 1) AS cell
        FROM read_parquet([{quoted}], filename=true)
        WHERE road_component_id IS NOT NULL""").fetchall()
    cells = {}
    for component, cell in rows:
        cells.setdefault(component, set()).add(cell)
    _ = catalog
    return cells


def footprint(bbox, planes, component=None, components=None, roads_global=False):
    """Which raw objects a promotion of this corridor box reads, and how many bytes they are.

    With `roads_global` the national roads plane is online in full, so the road part of a promotion stops being a
    *publication* question and becomes a fetch question: the bounded publication cost of roads is zero, and what
    remains is wetlands and hydrography.
    """
    if roads_global:
        habitat = padded_bounds(bbox, ANALYSIS_DISTANCE_M)
        road_cells = cells_for(expand(bbox, ROAD_MARGIN_DEG), planes["roads"]["cells"]) if component is None else []
        wetlands = cells_for(habitat, planes["wetlands"]["cells"])
        hydro = cells_for(habitat, planes["hydrography"]["cells"])
        index_w = planes["wetlands"]["cells"]
        index_h = planes["hydrography"]["cells"]
        counts = {"roads": 0, "wetlands": len(wetlands), "hydrography": len(hydro)}
        byte_counts = {"roads": 0,
                       "wetlands": sum(index_w[c].get("bytes", 0) for c in wetlands if index_w[c]["state"] == "present"),
                       "hydrography": sum(index_h[c].get("bytes", 0) for c in hydro if index_h[c]["state"] == "present")}
        return {"cells": counts, "bytes": byte_counts, "objects": sum(counts.values()),
                "bytesTotal": sum(byte_counts.values()), "roads": [], "wetlands": wetlands,
                "hydrography": hydro, "roadCellsIfBounded": len(road_cells)}
    if component is not None and components is not None and components.get(component):
        # The closure: exactly the cells the corridor's own road component occupies, as the runtime selects them.
        roads = sorted(components[component])
    else:
        roads = cells_for(expand(bbox, ROAD_MARGIN_DEG), planes["roads"]["cells"])
    habitat = padded_bounds(bbox, ANALYSIS_DISTANCE_M)
    wetlands = cells_for(habitat, planes["wetlands"]["cells"])
    hydro = cells_for(habitat, planes["hydrography"]["cells"])
    counts, byte_counts = {}, {}
    for name, cells in (("roads", roads), ("wetlands", wetlands), ("hydrography", hydro)):
        index = planes[name]["cells"]
        counts[name] = len(cells)
        byte_counts[name] = sum(index[cell].get("bytes", 0) for cell in cells if index[cell]["state"] == "present")
    return {"cells": counts, "bytes": byte_counts, "objects": sum(counts.values()),
            "bytesTotal": sum(byte_counts.values()), "roads": roads, "wetlands": wetlands, "hydrography": hydro}



def growth(samples, planes, promotions, components, roads_global=False):
    """The published working set after `promotions` promotions, as two bounds.

    The lower bound replays the corridors measured above (clustered: people explore near each other and return),
    counting distinct cells. The upper bound assumes every promotion lands in fresh territory, which cannot reuse
    anything - it is the honest worst case, and it is why publication follows users rather than pre-empting them.
    """
    pool = [row for region in samples.values() for row in region]
    if not pool:
        return None
    seen = {name: set() for name in PLANES}
    bytes_of = {name: 0 for name in PLANES}
    curve = []
    for step in range(promotions):
        row = pool[step % len(pool)]
        measured = footprint([row[7], row[8], row[9], row[10]], planes, row[11], components, roads_global)
        for name in PLANES:
            for cell in measured[name]:
                if cell in seen[name]:
                    continue
                seen[name].add(cell)
                entry = planes[name]["cells"][cell]
                bytes_of[name] += entry.get("bytes", 0) if entry["state"] == "present" else 0
        if step + 1 in (1, 10, 100, 1000, 10000, promotions):
            curve.append({"promotions": step + 1, "cells": {name: len(seen[name]) for name in PLANES},
                          "bytes": sum(bytes_of.values()), "bytesByPlane": dict(bytes_of)})
    # Scattered upper bound: per-promotion distinct cells with no reuse at all, capped by the grid.
    per_promotion = {name: percentile([len(footprint([row[7], row[8], row[9], row[10]], planes, row[11], components,
                                                        roads_global)[name]) for row in pool], 0.5) for name in PLANES}
    grid = len(planes["roads"]["cells"])
    scattered = {}
    for count in (100, 1000, 10000):
        cells = {name: min(grid, per_promotion[name] * count) for name in PLANES}
        bytes_by_plane = {name: cells[name] * (sum(entry.get("bytes", 0) for entry in planes[name]["cells"].values()
                                                   if entry["state"] == "present") / grid) for name in PLANES}
        scattered[count] = {"cells": cells, "bytes": sum(bytes_by_plane.values()), "bytesByPlane": bytes_by_plane}
    lake = sum(entry.get("bytes", 0) for name in PLANES for entry in planes[name]["cells"].values()
               if entry["state"] == "present") + planes["ecoregions"]["bytes"]
    fixed = (sum(entry.get("bytes", 0) for entry in planes["roads"]["cells"].values() if entry["state"] == "present")
             + planes["ecoregions"]["bytes"]) if roads_global else planes["ecoregions"]["bytes"]
    return {"clustered": curve, "scattered": scattered, "medianCellsPerPromotion": per_promotion,
            "fixedBytes": fixed, "rawLakeBytes": lake}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--per-region", type=int, default=25)
    parser.add_argument("--promotions", type=int, default=10000)
    parser.add_argument("--out", default=str(ROOT / DEFAULT_OUT))
    parser.add_argument("--global-roads", action="store_true",
                        help="measure bounded publication only: roads are published nationally and are a fetch, not a publication, cost")
    parser.add_argument("--out-old", default=None, help="also write the bounded-roads measurement here for comparison")
    parser.add_argument("--no-closure", action="store_true",
                        help="use the pre-closure margin rule for roads instead of the component closure")
    args = parser.parse_args()

    planes = load_planes()
    samples = sample_corridors(args.per_region)
    components = {}
    if not args.no_closure:
        components = component_cells(derived_root(), None)
    rows = []
    for region, corridors in samples.items():
        for row in corridors:
            measured = footprint([row[7], row[8], row[9], row[10]], planes, row[11], components, args.global_roads)
            rows.append({"region": region, "corridorId": row[0], "name": row[1], "lengthM": round(row[2] or 0, 1),
                         "wetlandArea1000M2": round(row[4] or 0, 1), "hydroCrossings": row[5] or 0,
                         "componentCells": len(components.get(row[11]) or []) if components else None,
                         "roadComponentId": row[11],
                         "bounds": [row[7], row[8], row[9], row[10]], "objects": measured["objects"],
                         "bytes": measured["bytesTotal"], "cells": measured["cells"],
                         "bytesByPlane": measured["bytes"],
                         "cellIds": {"roads": measured["roads"], "wetlands": measured["wetlands"],
                                     "hydrography": measured["hydrography"]}})
    totals = [row["bytes"] for row in rows]
    summary = {
        "medianBytes": percentile(totals, 0.5), "p95Bytes": percentile(totals, 0.95),
        "worstBytes": max(totals, default=0), "bestBytes": min(totals, default=0),
        "medianObjects": percentile([row["objects"] for row in rows], 0.5),
        "worstObjects": max((row["objects"] for row in rows), default=0),
        "medianBytesByPlane": {name: percentile([row["bytesByPlane"][name] for row in rows], 0.5) for name in PLANES},
        "p95BytesByPlane": {name: percentile([row["bytesByPlane"][name] for row in rows], 0.95) for name in PLANES},
        "worstBytesByPlane": {name: max((row["bytesByPlane"][name] for row in rows), default=0) for name in PLANES},
        "medianCells": {name: percentile([row["cells"][name] for row in rows], 0.5) for name in PLANES},
        "worstCells": {name: max((row["cells"][name] for row in rows), default=0) for name in PLANES},
    }
    if components:
        spans = [len(components.get(entry["roadComponentId"]) or []) for entry in rows
                 if entry.get("roadComponentId") in components]
        summary["roadClosureCells"] = {"median": percentile(spans, 0.5), "p95": percentile(spans, 0.95),
                                       "worst": max(spans, default=0)}
    report = {
        "kind": "national-raw-promotion-footprint", "schemaVersion": 1,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": "Measured from the committed national manifests and the local derived plane, with the runtime's "
                "own selection rules: a road promotion reads every cell the corridor's **road component** "
                "occupies (the closure the runtime performs), and wetlands and hydrography are padded by the 1 km "
                "analysis distance exactly as paddedBounds does. Ecoregions are not per-cell: they are two CONUS "
                "artifacts, measured separately.",
        "roadSelection": "margin" if args.no_closure else "component-closure",
        "planes": {name: {"version": value["version"], "presentCells": value.get("present"),
                          "emptyCells": value.get("empty"), "artifactBytes": value["bytes"]}
                   for name, value in planes.items()},
        "analysisDistanceM": ANALYSIS_DISTANCE_M, "roadMarginDeg": ROAD_MARGIN_DEG,
        "globalRoads": args.global_roads, "sampled": len(rows), "summary": summary,
        "perRegion": {region: {"corridors": len(corridors),
                               "medianBytes": percentile([row["bytes"] for row in rows if row["region"] == region], 0.5),
                               "worstBytes": max((row["bytes"] for row in rows if row["region"] == region), default=0)}
                      for region, corridors in samples.items()},
        "growth": growth(samples, planes, args.promotions, components, args.global_roads),
        "corridors": rows,
    }
    Path(args.out).write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps({"sampled": report["sampled"], "roadSelection": report["roadSelection"],
                      "summary": summary, "perRegion": report["perRegion"]}, indent=1))
    for point in (report["growth"] or {}).get("clustered", []):
        print(f"  clustered {point['promotions']:>6,} promotions -> cells {point['cells']}  bytes {point['bytes']:,}")
    for count, point in ((report["growth"] or {}).get("scattered") or {}).items():
        print(f"  scattered {int(count):>6,} promotions -> cells {point['cells']}  bytes {round(point['bytes']):,}")
    print(f"raw lake (three planes + ecoregions): {(report['growth'] or {}).get('rawLakeBytes', 0):,} bytes")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    raise SystemExit(main())

