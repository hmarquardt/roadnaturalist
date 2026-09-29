"""Focused national hydro rules; no heavyweight source packages required."""
import json
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import national_hydro as nh  # noqa: E402

LOCK = json.loads((ROOT / "data/national/nhd-hr-hu8-lock.json").read_text())
INVENTORY = json.loads((ROOT / "data/national/nhd-hr-hu8-inventory.json").read_text())
MANIFEST = json.loads((ROOT / "data/national/hydro-manifest.json").read_text())
GRID = json.loads((ROOT / "data/national/grid-conus-2025.json").read_text())


def line(coords):
    return MultiLineString([LineString(coords)])


def polygon(coords):
    return MultiPolygon([Polygon(coords)])


def signature(geometry, reach="11000001234567", name="Dairy Creek", ftype=460, fcode=46006):
    digest = nh.geometry_digest(geometry)
    return digest, nh.attribute_signature(reach, name, ftype, fcode, 1.234, None, digest)


def test_source_lock_covers_conus_regions_and_matches_the_measured_inventory():
    assert LOCK["kind"] == "usgs-nhd-hr-hu8-staged-lock"
    assert LOCK["unitCount"] == len(LOCK["units"]) == 38
    regions = {entry["region"] for entry in LOCK["units"].values()}
    assert regions == {f"{code:02d}" for code in range(1, 19)}, "all 18 CONUS HUC2 regions are represented"
    for unit, entry in LOCK["units"].items():
        assert len(unit) == 8 and len(entry["sha256"]) == 64 and entry["bytes"] > 0
        assert INVENTORY["units"][unit]["bytes"] == entry["bytes"], "the pin agrees with the bucket measurement"
    assert LOCK["totalBytes"] == sum(entry["bytes"] for entry in LOCK["units"].values())
    assert INVENTORY["conusUnits"] == 2166 and INVENTORY["nonConusUnits"] == 220
    assert INVENTORY["conusCompressedBytes"] == 23652050889


def test_canonical_key_uses_the_permanent_identifier_only_without_conflict():
    geometry = line([(-122.9, 45.5), (-122.8, 45.51)])
    digest, signed = signature(geometry)
    assert nh.canonical_key("flowline", "17090010", 1, "11000001234567", digest, signed) == \
        nh.canonical_key("flowline", "17090012", 9, "11000001234567", digest, signed) == \
        "nhd-flowline:11000001234567"
    conflicting = nh.canonical_key("flowline", "17090010", 1, "11000001234567", digest, signed, conflict=True)
    assert conflicting.startswith("nhd-flowline-conflict:17090010:1:") and conflicting != "nhd-flowline:11000001234567"


def test_duplicate_group_is_safe_only_for_one_identical_row_per_unit():
    geometry = line([(-122.9, 45.5), (-122.8, 45.51)])
    digest, signed = signature(geometry)
    assert nh.duplicate_group_is_safe([("17090010", 1, digest, signed), ("17090012", 4, digest, signed)])
    assert not nh.duplicate_group_is_safe([("17090010", 1, digest, signed), ("17090010", 2, digest, signed)])
    other = line([(-122.9, 45.5), (-122.8, 45.52)])
    other_digest, other_signed = signature(other)
    assert not nh.duplicate_group_is_safe([("17090010", 1, digest, signed), ("17090012", 4, other_digest, other_signed)])


def test_same_identifier_with_different_geometry_is_retained_not_collapsed():
    """The adversarial case the central requirement names: identical id, different geometry, both survive."""
    first = line([(-122.9, 45.5), (-122.8, 45.51)])
    second = line([(-122.9, 45.5), (-122.87, 45.56)])
    first_digest, first_signed = signature(first)
    second_digest, second_signed = signature(second)
    rows = [("17090010", 1, first_digest, first_signed), ("17090012", 4, second_digest, second_signed)]
    assert not nh.duplicate_group_is_safe(rows)
    assert nh.canonical_key("flowline", "17090010", 1, "11000001234567", first_digest, first_signed, conflict=True) != \
        nh.canonical_key("flowline", "17090012", 4, "11000001234567", second_digest, second_signed, conflict=True)


def test_distinct_connected_features_are_never_merged_on_name_or_touching_geometry():
    """Two genuinely different water features that share a GNIS name and touch stay two features."""
    left = line([(-122.90, 45.50), (-122.85, 45.50)])
    right = line([(-122.85, 45.50), (-122.80, 45.50)])
    assert left.intersects(right)
    left_digest, left_signed = signature(left, reach="11000001111111")
    right_digest, right_signed = signature(right, reach="11000002222222")
    assert left_digest != right_digest
    assert nh.canonical_key("flowline", "17090010", 1, "id-left", left_digest, left_signed) != \
        nh.canonical_key("flowline", "17090010", 2, "id-right", right_digest, right_signed)


def test_blank_identifier_is_package_qualified_even_for_equal_geometry():
    geometry = polygon([(-122.9, 45.5), (-122.8, 45.5), (-122.8, 45.6), (-122.9, 45.6)])
    digest, signed = signature(geometry, ftype=390)
    assert nh.canonical_key("waterbody", "17090010", 1, "", digest, signed) != \
        nh.canonical_key("waterbody", "17090012", 1, "", digest, signed)
    assert nh.canonical_key("waterbody", "17090010", 1, "", digest, signed).startswith("nhd-waterbody-local:17090010:1:")


def test_whole_feature_replicates_across_a_grid_seam():
    # A feature that straddles both a longitude and a latitude seam intersects four cells and is stored whole in
    # each of them: no per-cell clipping, so runtime dedupe has one canonical geometry to collapse.
    feature = polygon([(-123.01, 45.59), (-122.99, 45.59), (-122.99, 45.61), (-123.01, 45.61)])
    ids = {"x284_y677", "x285_y677", "x284_y678", "x285_y678", "x999_y999"}
    assert sorted(nh.member_cells(feature, ids)) == ["x284_y677", "x284_y678", "x285_y677", "x285_y678"]
    inside = polygon([(-123.05, 45.65), (-123.03, 45.65), (-123.03, 45.67), (-123.05, 45.67)])
    assert sorted(nh.member_cells(inside, ids)) == ["x284_y678"]



def test_hydro_manifest_declares_every_grid_cell_with_exactly_one_state():
    assert MANIFEST["kind"] == "national-hydrography"
    assert len(MANIFEST["cells"]) == len(GRID["cells"]) == 21874
    states = {cell["id"]: cell["state"] for cell in MANIFEST["cells"]}
    assert len(states) == 21874
    assert MANIFEST["canonicalKeyVersion"] == nh.CANONICAL_KEY_VERSION
    assert MANIFEST["pipelineVersion"] == nh.PIPELINE_VERSION
    assert [field["name"] for field in MANIFEST["schema"]] == [field.name for field in nh.SCHEMA]
    counts = MANIFEST["counts"]
    assert counts["present"] + counts["empty"] + counts["unbuilt"] == counts["cells"]
    assert MANIFEST["buildCoverage"] in ("partial", "complete")
    for cell in MANIFEST["cells"]:
        if cell["state"] == "present":
            assert cell["bytes"] > 0 and len(cell["sha256"]) == 64
            assert cell["url"].startswith("national/hydro/") and cell["storedRows"] == cell["featureCount"]
        elif cell["state"] == "empty":
            assert cell["storedRows"] == 0 and "url" not in cell
        else:
            assert "url" not in cell and cell["missingUnits"]


def test_manifest_encoding_and_counters_are_reproducible():
    path = ROOT / "data/national/hydro-manifest.json"
    assert path.read_text() == json.dumps(MANIFEST, indent=1, sort_keys=True) + "\n"
    counts = MANIFEST["counts"]
    assert counts["storedRows"] == sum(cell.get("storedRows", 0) for cell in MANIFEST["cells"])
    assert counts["artifactBytes"] == sum(cell.get("bytes", 0) for cell in MANIFEST["cells"])
    assert counts["canonicalFeatures"] == counts["rawRows"] - counts["duplicatePackageCopies"]
    assert MANIFEST["sourceLockSha256"] == nh.sha256_file(ROOT / "data/national/nhd-hr-hu8-lock.json")
    assert MANIFEST["gridSha256"] == nh.sha256_file(ROOT / "data/national/grid-conus-2025.json")


def test_every_declared_present_cell_carries_what_a_publisher_needs():
    """The publisher and the auditor both enumerate from the manifest, so every declared object must be complete."""
    for cell in MANIFEST["cells"]:
        if cell["state"] != "present":
            continue
        assert {"id", "url", "bytes", "sha256", "storedRows"} <= set(cell)
        assert cell["url"] == f"national/hydro/{MANIFEST['version']}/hydro/{cell['id']}.parquet"


def test_completed_unit_resumes_only_with_a_matching_digest(tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("hydro_builder", ROOT / "scripts/build-national-hydro.py")
    importlib.util.module_from_spec(spec)
    source = {"sha256": "a" * 64}
    checkpoint = tmp_path / "jobs" / "17090010.json"
    output = tmp_path / "normalized" / "17090010.parquet"
    output.parent.mkdir(parents=True)
    pq.write_table(pa.table({"unit": ["17090010"]}), output)
    nh.atomic_json(checkpoint, {"state": "complete", "sourceSha256": source["sha256"],
                                "pipelineVersion": nh.PIPELINE_VERSION, "outputBytes": output.stat().st_size,
                                "outputSha256": nh.sha256_file(output), "outputRows": 1})
    # The builder's reuse path re-hashes the output; a changed byte must invalidate it.
    output.write_bytes(output.read_bytes() + b"stale")
    record = json.loads(checkpoint.read_text())
    assert output.stat().st_size != record["outputBytes"]
    assert nh.sha256_file(output) != record["outputSha256"]


def test_water_class_matches_the_regional_semantics():
    assert nh.FLOWING_FTYPES == {334, 336, 460, 558}
    assert nh.STANDING_FTYPES == {361, 378, 390, 436, 466}
    assert nh.water_class(460) == "flowing" and nh.water_class(558) == "flowing"
    assert nh.water_class(390) == "standing" and nh.water_class(436) == "standing"
    assert nh.water_class(428) == "other" and nh.water_class(None) == "other"
    assert nh.feature_type_label(460) == "Stream/River"


def test_blank_geometry_is_dropped_rather_than_published():
    assert nh.STORED_CRS == 4326 and nh.SOURCE_CRS == "EPSG:4269" and nh.ANALYSIS_CRS == "EPSG:5070"
    assert nh.STEP == 0.2, "the national hydro plane uses the same 0.2-degree grid as roads and wetlands"
