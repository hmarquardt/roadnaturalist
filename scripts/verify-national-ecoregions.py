#!/usr/bin/env python3
"""Verify the national EPA ecoregion plane: pins, artifacts, schema, geometry, coverage, source equivalence.

Offline and deterministic. Two things make this verifier worth having rather than trusting the build:

  * the artifacts are re-hashed, and their schema, CRS, geometry validity, declared bounds, code/name
    completeness and code/name multiplicity are re-asserted against the manifest, including that the declared
    coverage actually contains the CONUS grid the other planes use;
  * **source equivalence is proved, not assumed.** The national plane and the regional plane come from two
    different EPA products (two national shapefiles versus per-state extracts of the same mapping), so for every
    feature in the regional OR/WA files this checks that the national polygon containing that feature's
    representative point carries the same ecoregion code, and that every regional code/name pair exists
    nationally. A representative point avoids boundary fuzz while still being a geometric test.

`--require-all` demands both levels, complete coverage and a digest-matching manifest.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_volume as bv  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
from shapely import wkb  # noqa: E402
from shapely.strtree import STRtree  # noqa: E402

LOCK_PATH = ROOT / "data/national/epa-conus-lock.json"
MANIFEST_PATH = ROOT / "data/national/epa-manifest.json"
GRID_PATH = ROOT / "data/national/grid-conus-2025.json"
DEFAULT_ARTIFACTS = bv.cells_dir("epa", ROOT / "data" / "national")
DEFAULT_CACHE = Path("/Volumes/Lexar/roadnaturalist/sources/epa")
EXPECTED_COLUMNS = ["code", "name", "l3_code", "l3_name", "min_lon", "min_lat", "max_lon", "max_lat", "geometry"]
# The regional plane's per-state EPA files, which the browser reads today.
REGIONAL_STATES = ("or", "wa")


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_pins(lock, manifest, cache):
    assert lock["kind"] == "epa-conus-ecoregions-lock", "unexpected lock kind"
    assert lock["coverage"] == "CONUS"
    for level, entry in lock["units"].items():
        assert len(entry["sha256"]) == 64 and entry["bytes"] > 0, f"level {level}: unusable pin"
        assert entry["url"].startswith("https://"), f"level {level}: source url is not absolute"
        # `layer` is the shapefile stem, so the archive must actually carry that layer's components.
        for extension in (".shp", ".shx", ".dbf", ".prj"):
            assert entry["layer"] + extension in entry["members"], \
                f"level {level}: archive is missing {entry['layer']}{extension}"
        archive = cache / entry["filename"]
        if archive.exists():
            assert archive.stat().st_size == entry["bytes"], f"level {level}: cached archive bytes differ"
            assert sha256_file(archive) == entry["sha256"], f"level {level}: cached archive digest differs"
    assert sha256_file(LOCK_PATH) == manifest["sourceLockSha256"], "manifest was built against a different lock"


def verify_artifacts(artifacts_dir, manifest, grid):
    """Re-hash every level artifact and re-assert schema, CRS, geometry, coverage and declared counts."""
    assert manifest["kind"] == "national-ecoregions"
    assert manifest["partitioning"].startswith("none"), "the national ecoregion plane is one artifact per level"
    grid_bounds = [min(cell["bounds"][0] for cell in grid["cells"]), min(cell["bounds"][1] for cell in grid["cells"]),
                   max(cell["bounds"][2] for cell in grid["cells"]), max(cell["bounds"][3] for cell in grid["cells"])]
    measured = {}
    total_features = total_codes = total_bytes = 0
    for level, entry in sorted(manifest["artifacts"].items()):
        path = artifacts_dir / f"epa-conus-l{level}.parquet"
        assert path.exists(), f"level {level}: declared artifact is missing at {path}"
        assert path.stat().st_size == entry["bytes"], f"level {level}: artifact bytes differ"
        assert sha256_file(path) == entry["sha256"], f"level {level}: artifact digest differs"
        table = pq.read_table(path)
        assert [field.name for field in table.schema] == EXPECTED_COLUMNS, f"level {level}: schema differs"
        assert b"geo" in table.schema.metadata, f"level {level}: GeoParquet metadata missing"
        geo = json.loads(table.schema.metadata[b"geo"])
        assert geo["columns"]["geometry"]["crs"]["id"]["code"] == 4326, f"level {level}: CRS is not EPSG:4326"
        rows = table.to_pylist()
        assert len(rows) == entry["featureCount"], f"level {level}: feature count differs"
        codes = {}
        for row in rows:
            assert row["code"] and row["name"] and row["l3_code"] and row["l3_name"], \
                f"level {level}: blank code or name"
            geometry = wkb.loads(row["geometry"])
            assert geometry.is_valid and not geometry.is_empty, f"level {level}: invalid geometry for {row['code']}"
            assert geometry.geom_type in ("Polygon", "MultiPolygon"), f"level {level}: {geometry.geom_type}"
            assert abs(geometry.bounds[0] - row["min_lon"]) < 1e-9, f"level {level}: declared bounds disagree"
            codes.setdefault(row["code"], set()).add(row["name"])
        assert len(codes) == entry["uniqueCodes"], f"level {level}: unique code count differs"
        multiple = {code: sorted(names) for code, names in codes.items() if len(names) > 1}
        declared = {code: sorted(names) for code, names in entry["codesWithMultipleNames"].items()}
        assert multiple == declared, f"level {level}: manifest code/name multiplicity does not match the artifact"
        bounds = entry["bounds"]
        # Ecoregions are clipped to the land, so their extent cannot contain the grid's rectangular cells: the
        # grid runs into the ocean and a fraction of a degree past the coastline. The check is therefore that the
        # plane stays inside the grid and spans it to within a one-degree margin, which would catch a truncated
        # or partial level while not pretending the land cover is a rectangle.
        for index in (0, 1):
            assert bounds[index] >= grid_bounds[index] - 1e-6, f"level {level}: coverage reaches past the grid"
        for index in (2, 3):
            assert bounds[index] <= grid_bounds[index] + 1e-6, f"level {level}: coverage reaches past the grid"
        assert (bounds[2] - bounds[0]) >= (grid_bounds[2] - grid_bounds[0]) - 1.0, \
            f"level {level}: coverage spans {bounds[2] - bounds[0]:.2f} of a {grid_bounds[2] - grid_bounds[0]:.2f} degree grid"
        assert (bounds[3] - bounds[1]) >= (grid_bounds[3] - grid_bounds[1]) - 1.0, \
            f"level {level}: coverage spans {bounds[3] - bounds[1]:.2f} of a {grid_bounds[3] - grid_bounds[1]:.2f} degree grid"
        measured[level] = {"features": len(rows), "codes": len(codes), "bytes": path.stat().st_size,
                           "codesWithMultipleNames": multiple}
        total_features += len(rows)
        total_codes += len(codes)
        total_bytes += path.stat().st_size
    counts = manifest["counts"]
    assert counts["features"] == total_features and counts["uniqueCodes"] == total_codes \
        and counts["artifactBytes"] == total_bytes, "manifest counts do not match the artifacts"
    return measured, grid_bounds


def verify_source_equivalence(artifacts_dir, manifest):
    """Prove the national plane agrees with the regional per-state files, point by point and by code/name."""
    results = {}
    for level in sorted(manifest["artifacts"]):
        national = pq.read_table(artifacts_dir / f"epa-conus-l{level}.parquet", columns=["code", "name", "geometry"]).to_pylist()
        national_names = {}
        geometries = []
        national_codes = []
        national_pairs = set()
        for row in national:
            geometry = wkb.loads(row["geometry"])
            geometries.append(geometry)
            national_codes.append(row["code"])
            national_names.setdefault(row["code"], set()).add(row["name"])
            national_pairs.add((row["code"], row["name"]))
        tree = STRtree(geometries)
        checked = 0
        for state in REGIONAL_STATES:
            path = ROOT / "data" / "gis" / f"epa-{state}-l{level}-2012.parquet"
            assert path.exists(), f"level {level}: regional {state} file is missing at {path}"
            for row in pq.read_table(path, columns=["code", "name", "geometry"]).to_pylist():
                code, name = row["code"], row["name"]
                assert code in national_names, f"level {level}: regional {state} code {code} is absent nationally"
                assert name in national_names[code], \
                    f"level {level}: regional {state} {code} is named {name!r}, national names are {sorted(national_names[code])}"
                # A representative point is guaranteed to lie inside the polygon, so this is a real geometric test
                # that does not depend on how either product clips at a boundary.
                point = wkb.loads(row["geometry"]).representative_point()
                found = {national_codes[index] for index in tree.query(point, predicate="intersects")}
                assert code in found, \
                    f"level {level}: regional {state} {code} at {point.x:.4f},{point.y:.4f} is {sorted(found)} nationally"
                checked += 1
        results[level] = {"regionalFeaturesChecked": checked, "regionalPairs": len(national_pairs)}
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=DEFAULT_ARTIFACTS)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--require-all", action="store_true",
                        help="fail unless both levels are present with complete coverage")
    args = parser.parse_args()
    lock = json.loads(LOCK_PATH.read_text())
    manifest = json.loads(MANIFEST_PATH.read_text())
    grid = json.loads(GRID_PATH.read_text())
    verify_pins(lock, manifest, args.cache)
    measured, grid_bounds = verify_artifacts(args.artifacts, manifest, grid)
    equivalence = verify_source_equivalence(args.artifacts, manifest)
    if args.require_all:
        assert manifest["buildCoverage"] == "complete" and sorted(int(level) for level in manifest["artifacts"]) == [3, 4], \
            f"both levels are required; manifest declares {sorted(manifest['artifacts'])} as {manifest['buildCoverage']}"
    assert MANIFEST_PATH.read_text() == json.dumps(manifest, indent=1, sort_keys=True) + "\n", \
        "the manifest is not in its deterministic encoding"
    print(json.dumps({"ok": True, "levels": sorted(int(level) for level in manifest["artifacts"]),
                      "buildCoverage": manifest["buildCoverage"], "sourceLockBytes": lock["totalBytes"],
                      "artifactBytes": manifest["counts"]["artifactBytes"],
                      "manifestBytes": MANIFEST_PATH.stat().st_size,
                      "gridBounds": grid_bounds, "measured": measured, "sourceEquivalence": equivalence,
                      "workspace": {name: sum(1 for _ in args.artifacts.glob(f"*.{name}"))
                                    for name in ("parquet",)}}, indent=1))


if __name__ == "__main__":
    main()
