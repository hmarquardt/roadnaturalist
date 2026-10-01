"""Deterministic national EPA ecoregion checks; no heavy sources required.

These read the committed lock and manifest, and - when the build volume is present - re-check the artifacts
themselves. The point is to hold the contract rather than to re-run the build: pins, counts, coverage, the
declared upstream anomaly, and the source equivalence between the national product and the regional per-state
files the browser reads today.
"""
import hashlib
import json
from pathlib import Path

import pyarrow.parquet as pq
import pytest
from shapely import wkb

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "data/national/epa-conus-lock.json").read_text())
MANIFEST = json.loads((ROOT / "data/national/epa-manifest.json").read_text())
GRID = json.loads((ROOT / "data/national/grid-conus-2025.json").read_text())
ARTIFACTS = Path("/Volumes/Lexar/roadnaturalist/cells/epa")
REGIONAL = ROOT / "data" / "gis"
# EPA publishes code `42c` twice, once with a doubled i. It is upstream data, kept verbatim and declared.
KNOWN_ANOMALY = {"4": {"42c": ["Miissouri Coteau Slope", "Missouri Coteau Slope"]}}


def grid_bounds():
    return [min(cell["bounds"][0] for cell in GRID["cells"]), min(cell["bounds"][1] for cell in GRID["cells"]),
            max(cell["bounds"][2] for cell in GRID["cells"]), max(cell["bounds"][3] for cell in GRID["cells"])]


def test_source_lock_pins_both_conus_levels():
    assert LOCK["kind"] == "epa-conus-ecoregions-lock" and LOCK["coverage"] == "CONUS"
    assert LOCK["levelCount"] == len(LOCK["units"]) == 2
    assert LOCK["totalBytes"] == sum(entry["bytes"] for entry in LOCK["units"].values())
    for level, entry in LOCK["units"].items():
        assert level in ("3", "4")
        assert entry["url"].startswith("https://") and entry["url"].endswith(".zip")
        assert len(entry["sha256"]) == 64 and entry["bytes"] > 0
        for extension in (".shp", ".shx", ".dbf", ".prj"):
            assert entry["layer"] + extension in entry["members"], level
        assert entry["publicationDate"]


def test_manifest_declares_complete_conus_coverage_and_matches_the_lock():
    assert MANIFEST["kind"] == "national-ecoregions" and MANIFEST["buildCoverage"] == "complete"
    assert MANIFEST["coverage"] == "CONUS"
    assert MANIFEST["partitioning"].startswith("none"), "one artifact per level, deliberately unpartitioned"
    assert MANIFEST["levels"] == [3, 4]
    assert MANIFEST["sourceLockSha256"] == hashlib.sha256((ROOT / "data/national/epa-conus-lock.json").read_bytes()).hexdigest()
    assert MANIFEST["counts"]["levels"] == 2
    assert MANIFEST["counts"]["features"] == sum(a["featureCount"] for a in MANIFEST["artifacts"].values())
    assert MANIFEST["counts"]["artifactBytes"] == sum(a["bytes"] for a in MANIFEST["artifacts"].values())
    path = ROOT / "data/national/epa-manifest.json"
    assert path.read_text() == json.dumps(MANIFEST, indent=1, sort_keys=True) + "\n", "manifest encoding is not deterministic"


def test_declared_coverage_stays_inside_the_grid_and_spans_it():
    bounds = grid_bounds()
    for level, entry in MANIFEST["artifacts"].items():
        values = entry["bounds"]
        for index in (0, 1):
            assert values[index] >= bounds[index] - 1e-6, level
        for index in (2, 3):
            assert values[index] <= bounds[index] + 1e-6, level
        assert (values[2] - values[0]) >= (bounds[2] - bounds[0]) - 1.0, level
        assert (values[3] - values[1]) >= (bounds[3] - bounds[1]) - 1.0, level


def test_the_upstream_code_name_anomaly_is_declared_verbatim():
    declared = {level: entry["codesWithMultipleNames"] for level, entry in MANIFEST["artifacts"].items()
                if entry["codesWithMultipleNames"]}
    assert declared == KNOWN_ANOMALY, "an upstream code/name anomaly changed; it is data, not ours to fix"


def test_artifacts_verify_when_the_build_volume_is_present():
    if not ARTIFACTS.is_dir():
        pytest.skip("the national EPA artifacts are not present on this machine")
    for level, entry in MANIFEST["artifacts"].items():
        path = ARTIFACTS / f"epa-conus-l{level}.parquet"
        assert path.exists(), f"level {level} artifact missing"
        assert path.stat().st_size == entry["bytes"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"]
        table = pq.read_table(path)
        assert [field.name for field in table.schema] == ["code", "name", "l3_code", "l3_name", "min_lon", "min_lat",
                                                          "max_lon", "max_lat", "geometry"]
        geo = json.loads(table.schema.metadata[b"geo"])
        assert geo["columns"]["geometry"]["crs"]["id"]["code"] == 4326
        rows = table.to_pylist()
        assert len(rows) == entry["featureCount"]
        names = {}
        for row in rows[:200]:
            assert row["code"] and row["name"] and row["l3_code"] and row["l3_name"]
            geometry = wkb.loads(row["geometry"])
            assert geometry.is_valid and geometry.geom_type in ("Polygon", "MultiPolygon")
            names.setdefault(row["code"], set()).add(row["name"])
        assert all(len(value) >= 1 for value in names.values())
