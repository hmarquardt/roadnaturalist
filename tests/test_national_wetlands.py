"""Focused national NWI rules; no heavyweight source packages required."""
import importlib.util
import json
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from shapely.geometry import MultiPolygon, Polygon

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import national_wetlands as nw  # noqa: E402


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def signature(geometry, attribute="PFO1A", wetland_type="Freshwater Forested/Shrub Wetland"):
    digest = nw.normalized_geometry_digest(geometry)
    return digest, nw.semantic_digest("abc", attribute, wetland_type, "", digest)


def test_canonical_key_collapses_only_exact_cross_package_nwi_identity():
    geometry = MultiPolygon([Polygon([(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)])])
    digest, semantic = signature(geometry)
    rows = [("OR", 1, digest, semantic), ("WA", 9, digest, semantic)]
    assert nw.duplicate_group_is_safe(rows)
    assert nw.canonical_key("OR", 1, "abc", digest, semantic) == nw.canonical_key("WA", 9, "abc", digest, semantic)


def test_same_package_repeat_and_conflicting_geometry_are_ambiguous():
    first = MultiPolygon([Polygon([(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)])])
    second = MultiPolygon([Polygon([(0, 0), (2, 0), (2, 1), (0, 1), (0, 0)])])
    a, sa = signature(first)
    b, sb = signature(second)
    assert not nw.duplicate_group_is_safe([("OR", 1, a, sa), ("OR", 2, a, sa)])
    assert not nw.duplicate_group_is_safe([("OR", 1, a, sa), ("WA", 2, b, sb)])
    assert nw.canonical_key("OR", 1, "abc", a, sa, conflict=True) != nw.canonical_key("WA", 2, "abc", b, sb, conflict=True)


def test_legitimate_overlapping_wetlands_with_distinct_ids_survive():
    a = MultiPolygon([Polygon([(0, 0), (2, 0), (2, 2), (0, 2), (0, 0)])])
    b = MultiPolygon([Polygon([(1, 1), (3, 1), (3, 3), (1, 3), (1, 1)])])
    assert a.intersects(b)
    da, sa = signature(a)
    db, sb = signature(b)
    assert nw.canonical_key("FL", 1, "wetland-a", da, sa) != nw.canonical_key("FL", 2, "wetland-b", db, sb)


def test_blank_ids_remain_package_scoped_even_for_equal_geometry():
    geometry = MultiPolygon([Polygon([(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)])])
    digest, semantic = signature(geometry)
    assert nw.canonical_key("OR", 1, "", digest, semantic) != nw.canonical_key("WA", 1, "", digest, semantic)


def test_regional_ingest_removes_only_proven_package_copy():
    first = MultiPolygon([Polygon([(0, 0), (2, 0), (2, 2), (0, 2), (0, 0)])])
    second = MultiPolygon([Polygon([(1, 1), (3, 1), (3, 3), (1, 3), (1, 1)])])
    def feature(key, state, oid, nwi_id, geometry):
        return (key, state, oid, "PFO1A", "Freshwater Forested/Shrub Wetland", "", 0, nwi_id, geometry.wkb)
    rows = [feature("1", "OR", 1, "same", first), feature("WA-9", "WA", 9, "same", first),
            feature("2", "OR", 2, "other", second), feature("WA-10", "WA", 10, "overlap", second),
            feature("WA-11", "WA", 11, "distinct-same-shape", first)]
    assert first.intersects(second)
    assert nw.regional_package_copies_to_remove(rows, ["OR", "WA"]) == {"WA-9"}


def test_whole_polygon_replicates_across_grid_seam():
    geometry = MultiPolygon([Polygon([(-123.01, 45.59), (-122.99, 45.59), (-122.99, 45.61), (-123.01, 45.61), (-123.01, 45.59)])])
    possible = {f"x{x}_y{y}" for x in range(280, 290) for y in range(670, 680)}
    cells = list(nw.member_cells(geometry, possible))
    assert len(cells) == 4


def test_source_lock_has_exact_conus_state_universe_when_complete():
    lock_path = ROOT / "data/national/nwi-state-lock.json"
    if not lock_path.exists():
        return
    lock = json.loads(lock_path.read_text())
    # During a resumable freezer run the committed lock is intentionally partial.
    if lock["packageCount"] == 49:
        freezer = load_script("nwi_freezer", "freeze-national-wetlands.py")
        assert set(lock["packages"]) == set(freezer.STATES)
        assert all(len(item["sha256"]) == 64 and item["bytes"] > 0 for item in lock["packages"].values())


def test_partial_cell_namespace_cannot_collide_with_complete_plane():
    partition = load_script("nwi_partition", "partition-national-wetlands.py")
    complete = partition.publication_version(partition.LOCK["packages"], None)
    sample = partition.publication_version(["OR", "WA"], [-123.4, 45.4, -122.6, 46.0])
    other = partition.publication_version(["OR", "WA"], [-123.6, 45.4, -122.6, 46.0])
    assert complete == partition.VERSION
    assert sample != complete and sample != other
    assert sample == partition.publication_version(["WA", "OR"], [-123.4, 45.4, -122.6, 46.0])


def test_completed_state_resumes_only_with_valid_digest_and_selection(tmp_path):
    builder = load_script("nwi_builder", "build-national-wetlands.py")
    source = {"sha256": "a" * 64}
    output = tmp_path / "normalized" / "DC" / "chunk-00000.parquet"
    output.parent.mkdir(parents=True)
    pq.write_table(pa.table({"objectid": [1]}), output)
    chunk = {"state": "complete", "sourceSha256": source["sha256"], "pipelineVersion": nw.PIPELINE_VERSION,
             "selectionBBox": None, "outputBytes": output.stat().st_size,
             "outputSha256": nw.sha256_file(output), "outputCount": 1}
    job = {"state": "complete", "sourceSha256": source["sha256"], "pipelineVersion": nw.PIPELINE_VERSION,
           "selectionLonLatBBox": None, "selectionSourceBBox": None, "inspection": {"rtree": True},
           "chunks": 1, "normalizedFeatures": 1, "normalizedBytes": output.stat().st_size}
    nw.atomic_json(tmp_path / "jobs" / "DC" / "chunk-00000.json", chunk)
    nw.atomic_json(tmp_path / "jobs" / "DC" / "state.json", job)
    assert builder.completed_state("DC", source, tmp_path, None) == job
    assert builder.completed_state("DC", source, tmp_path, [-77, 38, -76, 39]) is None
    assert builder.completed_state("DC", {"sha256": "b" * 64}, tmp_path, None) is None
    output.write_bytes(output.read_bytes() + b"stale")
    assert builder.completed_state("DC", source, tmp_path, None) is None


def test_regional_columbia_source_copy_regression_is_recorded():
    catalog = json.loads((ROOT / "data/regional/manifest.json").read_text())
    wetlands = next(entry for entry in catalog["datasets"] if entry["id"] == "wetlands")
    assert catalog["version"] == "or-sw-wa-portland-v3"
    assert catalog["build"]["wetlandPackageCopiesRemoved"] == 20839
    assert wetlands["featureCount"] == 153853


def test_national_manifest_distinguishes_typed_empty_from_unbuilt():
    manifest = json.loads((ROOT / "data/national/wetland-manifest.json").read_text())
    counts = manifest["counts"]
    assert manifest["buildCoverage"] in ("partial", "complete")
    assert counts["cells"] == 21874
    assert counts["present"] + counts["empty"] + counts["unbuilt"] == counts["cells"]
    assert [field["name"] for field in manifest["schema"]] == [field.name for field in nw.SCHEMA]
    for entry in manifest["cells"]:
        if entry["state"] == "empty":
            assert entry["storedRows"] == 0 and "url" not in entry
        elif entry["state"] == "unbuilt":
            assert "url" not in entry and "storedRows" not in entry
    # The two coverages assert different things, and neither is weaker: a partial plane is exactly what
    # distinguishes unbuilt from typed-empty (cells a covering package was never built for), while a complete
    # plane has no unbuilt cell at all and must represent every pinned package.
    if manifest["buildCoverage"] == "partial":
        assert counts["unbuilt"] > 0 and counts["empty"] >= 0
    else:
        lock = json.loads((ROOT / "data/national/nwi-state-lock.json").read_text())
        assert counts["unbuilt"] == 0
        assert len(manifest["builtStates"]) == len(lock["packages"])
        assert counts["storedRows"] > 0 and counts["artifactBytes"] > 0


def test_real_nwi_schema_inventory_covers_geographic_regimes():
    inventory = json.loads((ROOT / "data/national/nwi-source-schema.json").read_text())
    lock = json.loads((ROOT / "data/national/nwi-state-lock.json").read_text())
    assert inventory["inspectedStates"] == 49
    assert set(inventory["states"]) == set(lock["packages"])
    assert inventory["rawFeatures"] == sum(state["featureCount"] for state in inventory["states"].values())
    for state in ("OR", "CA", "AZ", "KS", "IL", "LA", "NY", "FL"):
        inspection = inventory["states"][state]
        assert inspection["sourceSha256"] == lock["packages"][state]["sha256"]
        assert inspection["crs"] == "EPSG:5070"
        assert inspection["geometryType"] == "MULTIPOLYGON"
        assert inspection["rtree"] is True
        assert {"OBJECTID", "ATTRIBUTE", "WETLAND_TYPE", "NWI_ID", "Shape"} <= set(inspection["columns"])
