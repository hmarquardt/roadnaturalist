"""Fail-closed primary-ecoregion handling in the shared derived row writer."""
import importlib.util
from pathlib import Path

import pytest

PATH = Path(__file__).resolve().parents[1] / "scripts/build-derived.py"
SPEC = importlib.util.spec_from_file_location("regional_derived_ecology_test", PATH)
derived = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(derived)


def test_none_coverage_has_no_primary():
    assert derived.primary_or_none({"primary": None, "intersections": [], "coverage": "NONE"}, "edge", "Level III") is None


def test_measured_overlap_requires_primary():
    with pytest.raises(ValueError, match="edge: Level III ecology has no primary"):
        derived.primary_or_none({"primary": None, "intersections": [{"code": "x"}], "coverage": "PARTIAL"},
                                "edge", "Level III")


def test_missing_summary_reports_context():
    with pytest.raises(ValueError, match="edge: Level III ecology summary is missing"):
        derived.primary_or_none(None, "edge", "Level III")


def test_measured_primary_is_unchanged():
    primary = {"code": "12", "name": "Somewhere", "percent": 99.5}
    assert derived.primary_or_none({"primary": primary, "intersections": [primary], "coverage": "FULL"},
                                   "inside", "Level IV") is primary
