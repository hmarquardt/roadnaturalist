"""Focused national-factory invariants; small enough to run without any national cache."""
import importlib.machinery
import sys
from pathlib import Path

from shapely.geometry import LineString

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import national_components  # noqa: E402
import road_components  # noqa: E402
import tiger_sources  # noqa: E402

jobs = importlib.machinery.SourceFileLoader("national_jobs_test", str(ROOT / "scripts/build-national-roads.py")).load_module()
partition = importlib.machinery.SourceFileLoader("national_partition_test", str(ROOT / "scripts/partition-national-roads.py")).load_module()


def line(identifier, points, county="41067"):
    return {"name": "Main St", "source_feature_id": identifier, "county_fips": county, "coordinates": points}


def test_indexed_components_match_shared_rules_for_distant_same_name_and_reversal():
    rows = [line("a", [[-123.2, 45.5], [-123.199, 45.5]]),
            line("b", [[-123.199, 45.5], [-123.198, 45.5]]),
            line("c", [[-123.198, 45.5], [-123.199, 45.5]]),
            line("d", [[-74.0, 40.7], [-73.999, 40.7]], "36061")]
    expected = road_components.component_index(rows, "main-st", "main st")
    actual = national_components.component_index(rows, "main-st", "main st")
    assert actual == expected
    assert national_components.component_index(list(reversed(rows)), "main-st", "main st") == expected
    assert len(actual) == 2
    assert {tuple(item["counties"]) for item in actual} == {("41067",), ("36061",)}


def test_whole_feature_cell_replication_at_a_grid_seam():
    geometry = LineString([[-123.01, 45.5], [-122.99, 45.5]])
    row = {"geometry": geometry.wkb, "min_lon": -123.01, "min_lat": 45.5,
           "max_lon": -122.99, "max_lat": 45.5}
    cells = set(partition.member_cells(row))
    assert len(cells) >= 2
    assert all(cell in partition.CELL_IDS for cell in cells)


def test_checkpoint_reuse_requires_source_output_and_pipeline_digests(tmp_path):
    source = tmp_path / "source.zip"
    output = tmp_path / "roads.parquet"
    source.write_bytes(b"source")
    output.write_bytes(b"output")
    job = {"state": "complete", "pipelineVersion": jobs.PIPELINE_VERSION,
           "sourceBytes": source.stat().st_size, "sourceSha256": tiger_sources.sha256_of(source),
           "outputBytes": output.stat().st_size, "outputSha256": tiger_sources.sha256_of(output)}
    assert jobs.valid_output(job, source, output)
    output.write_bytes(b"changed")
    assert not jobs.valid_output(job, source, output)
    output.write_bytes(b"output")
    assert not jobs.valid_output({**job, "pipelineVersion": "stale"}, source, output)


def test_census_html_retry_uses_a_fresh_cache_key_but_still_requires_the_source_lock():
    url = "https://www2.census.gov/geo/tiger/TIGER2025/ROADS/tl_2025_54039_roads.zip"
    assert jobs.retry_url(url, 0, "abcdef1234567890") == url
    assert jobs.retry_url(url, 1, "abcdef1234567890").endswith("?rn_retry=abcdef123456-1")


def test_cell_compaction_declares_empty_and_rejects_missing_fragment(tmp_path, monkeypatch):
    chosen = next(cell for cell in partition.GRID["cells"] if cell["id"] == "x284_y677")
    empty = next(cell for cell in partition.GRID["cells"] if cell["id"] == "x284_y678")
    small_grid = {**partition.GRID, "counties": [{"fips": "41067"}], "cells": [chosen, empty]}
    monkeypatch.setattr(partition, "GRID", small_grid)
    geometry = LineString([[-123.19, 45.5], [-123.18, 45.5]])
    row = {"county_fips": "41067", "source_feature_id": "one", "part": 0, "name": "A Road",
           "geometry": geometry.wkb, "min_lon": geometry.bounds[0], "min_lat": geometry.bounds[1],
           "max_lon": geometry.bounds[2], "max_lat": geometry.bounds[3]}
    relative = Path("fragments/41067/one/x284_y677.parquet")
    fragment = partition.write_table([row], tmp_path / relative)
    partition.write_table([row], tmp_path / "normalized/41067.parquet")
    jobs.atomic_json(tmp_path / "fragment-jobs/41067.json", {"state": "complete", "fragments": {
        chosen["id"]: {"path": str(relative), **fragment}}})
    totals = partition.compact(tmp_path)
    assert totals == {"cells": 2, "present": 1, "empty": 1, "replicatedRows": 1,
                      "artifactBytes": (tmp_path / "artifacts/roads/x284_y677.parquet").stat().st_size}
    assert partition.compact(tmp_path) == totals  # validated checkpoint reuse
    (tmp_path / relative).write_bytes(b"corrupt")
    (tmp_path / "artifacts/roads/x284_y677.parquet").write_bytes(b"corrupt")
    try:
        partition.compact(tmp_path)
    except ValueError as error:
        assert "missing/corrupt required fragment" in str(error)
    else:
        raise AssertionError("corrupt required fragment was accepted")
