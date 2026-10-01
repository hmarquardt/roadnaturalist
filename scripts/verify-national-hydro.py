#!/usr/bin/env python3
"""Verify the national hydrography plane: pins, checkpoints, identity, cells, digests, schema, manifest.

Offline and deterministic. Unit checkpoints are re-hashed, the identity rule is re-derived for a deterministic
sample of duplicate groups, every cell declaration is checked against the artifact it names, typed-empty cells are
checked against the units that actually cover them, and the manifest is re-encoded to prove reproducibility.
`--require-all` turns a partial plane into a failure, which is what a completed national build must satisfy.
"""
import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_volume as bv
import national_hydro as nh  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
from shapely import wkb  # noqa: E402

LOCK_PATH = ROOT / "data/national/nhd-hr-hu8-lock.json"
INVENTORY_PATH = ROOT / "data/national/nhd-hr-hu8-inventory.json"
GRID_PATH = ROOT / "data/national/grid-conus-2025.json"
MANIFEST_PATH = ROOT / "data/national/hydro-manifest.json"
DEFAULT_WORK = bv.work_dir("nhd", ROOT / "data/national-hydro-work")
CONUS_REGIONS = {f"{code:02d}" for code in range(1, 19)}


def verify_pins(lock, inventory, manifest):
    for unit, entry in lock["units"].items():
        assert len(entry["sha256"]) == 64 and entry["bytes"] > 0, f"{unit}: unusable pin"
        assert entry["region"] in CONUS_REGIONS, f"{unit}: outside the CONUS profile"
        measured = inventory["units"].get(unit)
        assert measured and measured["bytes"] == entry["bytes"], f"{unit}: inventory disagrees with the pin"
    # A partial plane is built from the subset of the lock that existed when it ran, and the lock legitimately
    # grows as more units are pinned. For a partial plane the requirement is therefore that every *built* unit
    # still pins to the same bytes; a complete plane must match the whole lock digest it recorded.
    if manifest.get("buildCoverage") == "complete":
        assert nh.sha256_file(LOCK_PATH) == manifest["sourceLockSha256"], "manifest was built against a different lock"
    for unit in manifest["builtUnits"]:
        pinned = lock["units"].get(unit)
        assert pinned and len(pinned["sha256"]) == 64, f"{unit}: built unit is no longer pinned"
    assert nh.sha256_file(GRID_PATH) == manifest["gridSha256"], "manifest was built against a different grid"


def verify_unit_checkpoints(work, lock, manifest):
    raw_rows = 0
    for unit in manifest["builtUnits"]:
        checkpoint = work / "jobs" / f"{unit}.json"
        output = work / "normalized" / f"{unit}.parquet"
        assert checkpoint.exists() and output.exists(), f"{unit}: complete unit without checkpoint/output"
        record = json.loads(checkpoint.read_text())
        assert record["state"] == "complete", f"{unit}: checkpoint is {record['state']}"
        assert record["sourceSha256"] == lock["units"][unit]["sha256"], f"{unit}: source differs from the lock"
        assert record["pipelineVersion"] == nh.PIPELINE_VERSION, f"{unit}: stale pipeline version"
        assert output.stat().st_size == record["outputBytes"], f"{unit}: normalized bytes differ"
        assert nh.sha256_file(output) == record["outputSha256"], f"{unit}: normalized digest differs"
        assert pq.read_metadata(output).num_rows == record["outputRows"], f"{unit}: normalized row count differs"
        raw_rows += record["outputRows"]
    return raw_rows


def verify_identity(work, raw_rows, sample):
    identity = json.loads((work / "identity.json").read_text())
    assert identity["state"] == "complete" and identity["canonicalKeyVersion"] == nh.CANONICAL_KEY_VERSION
    assert identity["dbSha256"] == nh.sha256_file(work / "identity.sqlite"), "identity database changed"
    assert identity["rawRows"] == raw_rows, "identity raw rows disagree with the unit outputs"
    assert identity["canonicalFeatures"] == raw_rows - identity["duplicatePackageCopies"], "canonical count arithmetic"
    connection = sqlite3.connect(f"file:{work / 'identity.sqlite'}?mode=ro", uri=True)
    dispositions = dict(connection.execute("SELECT disposition, count(*) FROM mapping GROUP BY disposition"))
    assert dispositions.get("ambiguous", 0) == identity["ambiguousRows"], "ambiguous rows disagree"
    assert dispositions.get("blank-id", 0) == identity["blankIdRows"], "blank-id rows disagree"
    duplicates = connection.execute("""SELECT member, permanent_identifier FROM feature f
        JOIN id_summary s USING (member, permanent_identifier)
        WHERE s.copies>1 AND f.permanent_identifier<>'' GROUP BY f.member, f.permanent_identifier
        ORDER BY f.member, f.permanent_identifier LIMIT ?""", (sample,)).fetchall()
    for member, identifier in duplicates:
        rows = connection.execute("""SELECT unit, objectid, geometry_digest, signature FROM feature
                                     WHERE member=? AND permanent_identifier=? ORDER BY unit, objectid""",
                                  (member, identifier)).fetchall()
        if len(rows) > 1 and nh.duplicate_group_is_safe(rows):
            canonicals = connection.execute("""SELECT count(*) FROM mapping WHERE member=? AND objectid=?
                                               AND disposition IN ('canonical','duplicate')""", (member, rows[0][1])).fetchone()[0]
            assert canonicals == 1, f"{member}:{identifier}: a safe copy group was not resolved"
    wrong_unique = connection.execute("""SELECT count(*) FROM mapping WHERE disposition='unique'
                                         AND canonical_key NOT LIKE 'nhd-%:%'""").fetchone()[0]
    assert wrong_unique == 0, "a unique disposition carries a non-canonical key"
    qualified = connection.execute("""SELECT count(*) FROM mapping WHERE disposition IN ('ambiguous','blank-id')
                                      AND canonical_key LIKE 'nhd-%-%'""").fetchone()[0]
    assert qualified == dispositions.get("ambiguous", 0) + dispositions.get("blank-id", 0), \
        "ambiguous or blank keys are not package-qualified"
    connection.close()
    return identity


def verify_cells(work, grid, manifest, sample_cells=3):
    ids = {cell["id"] for cell in grid["cells"]}
    cell_units = defaultdict(set)
    for unit in manifest["builtUnits"]:
        coverage = json.loads((work / "coverage" / f"{unit}.json").read_text())
        polygon = wkb.loads(bytes.fromhex(coverage["geometry"]))
        for cell_id in nh.member_cells(polygon, ids):
            cell_units[cell_id].add(unit)
    present = empty = unbuilt = stored = artifact_bytes = 0
    sizes = []
    for cell in manifest["cells"]:
        state = cell["state"]
        assert state in ("present", "empty", "unbuilt"), f"{cell['id']}: unknown state {state}"
        covered = cell_units.get(cell["id"], set())
        missing = covered - set(manifest["builtUnits"])
        if state == "unbuilt":
            assert missing, f"{cell['id']}: declared unbuilt although every covering unit is built"
            assert "url" not in cell and "storedRows" not in cell, f"{cell['id']}: unbuilt cell carries an artifact"
            unbuilt += 1
            continue
        assert not missing, f"{cell['id']}: declared {state} while units {sorted(missing)} are unbuilt"
        if state == "empty":
            assert cell["storedRows"] == 0 and cell["featureCount"] == 0 and "url" not in cell, \
                f"{cell['id']}: typed empty cell is not empty"
            empty += 1
            continue
        artifact = work / "artifacts" / "hydro" / f"{cell['id']}.parquet"
        assert artifact.exists(), f"{cell['id']}: present cell without an artifact"
        assert artifact.stat().st_size == cell["bytes"] and nh.sha256_file(artifact) == cell["sha256"], \
            f"{cell['id']}: artifact digest differs from the manifest"
        table = pq.read_table(artifact)
        assert [field.name for field in nh.SCHEMA] == [field.name for field in table.schema], \
            f"{cell['id']}: schema differs"
        assert table.num_rows == cell["storedRows"] == cell["featureCount"], f"{cell['id']}: row count differs"
        keys = table.column("canonical_feature_id").to_pylist()
        assert len(set(keys)) == len(keys), f"{cell['id']}: a canonical key appears twice"
        for row in table.slice(0, sample_cells).to_pylist():
            geometry = wkb.loads(row["geometry"])
            assert not geometry.is_empty, f"{cell['id']}: empty geometry"
            assert geometry.geom_type == nh.GEOMETRY_FAMILY[row["layer"]], f"{cell['id']}: {geometry.geom_type}"
            # The published plane carries the canonical application vocabulary, and the canonical key carries the
            # layer's member. Both come from the one shared definition in scripts/national_hydro.py, so a
            # vocabulary drift between builder and verifier is not expressible.
            for source_layer, member in nh.LAYERS:
                if nh.PUBLISHED_LAYER[source_layer] == row["layer"]:
                    expected_member = member
            assert row["canonical_feature_id"].split(":", 1)[0].startswith(f"nhd-{expected_member}"), \
                f"{cell['id']}: canonical key does not carry the member"
            assert geometry.bounds[0] <= row["max_lon"] and geometry.bounds[2] >= row["min_lon"], \
                f"{cell['id']}: bounds do not contain the geometry"
        present += 1
        stored += cell["storedRows"]
        artifact_bytes += cell["bytes"]
        sizes.append(cell["bytes"])
    counts = manifest["counts"]
    assert counts["present"] == present and counts["empty"] == empty and counts["unbuilt"] == unbuilt
    assert counts["storedRows"] == stored and counts["artifactBytes"] == artifact_bytes
    assert counts["cells"] == len(manifest["cells"]) == len(grid["cells"])
    sizes.sort()
    return {"present": present, "empty": empty, "unbuilt": unbuilt, "storedRows": stored,
            "artifactBytes": artifact_bytes, "medianCellBytes": sizes[len(sizes) // 2] if sizes else 0,
            "p95CellBytes": sizes[int(len(sizes) * 0.95)] if sizes else 0,
            "largestCellBytes": sizes[-1] if sizes else 0,
            "cellsOver10MB": sum(1 for size in sizes if size > 10 * 1024 ** 2),
            "cellsOver20MB": sum(1 for size in sizes if size > 20 * 1024 ** 2),
            "cellsOver50MB": sum(1 for size in sizes if size > 50 * 1024 ** 2)}


def verify_regional_equivalence(work, units=("17090010", "17090012")):
    """Compare national hydro rows against the published regional plane for the pinned regional pair.

    The regional plane is clipped to its published window and simplified to 1e-6 degrees; the national plane
    keeps whole, unsimplified source features. So the comparison is deliberately not "the numbers are equal":

      * identity: every regional (layer, source_feature_id) must exist nationally, because a clipped window can
        only ever contain a subset of the whole features;
      * classification: water class, feature type code and the source length/area attributes must agree exactly,
        because those are source values and no clipping may change them;
      * measurement: the regional clipped length/area must be less than or equal to the national whole-feature
        measurement, and the national cell set for a feature must cover the regional one.

    Any disagreement in the first two groups is a semantic divergence and fails; the third group is reported as
    measured extents rather than asserted as equality.
    """
    regional_dir = ROOT / "data/regional/partitions/or-sw-wa-portland-v3/hydrography"
    if not regional_dir.is_dir():
        return {"checked": False, "reason": "regional partitions are not present locally"}
    manifest = json.loads(MANIFEST_PATH.read_text())
    present_cells = {cell["id"] for cell in manifest["cells"] if cell["state"] == "present"}
    regional = {}
    regional_cells = defaultdict(int)
    excluded = defaultdict(set)
    for path in sorted(regional_dir.glob("*.parquet")):
        if not bv.is_data_file(path):
            continue
        cell = path.stem
        for row in pq.read_table(path, columns=["layer", "source_feature_id", "source_hu8", "water_class",
                                                "feature_type_code", "source_length_km", "source_area_km2",
                                                "length_m", "area_m2"]).to_pylist():
            if row["source_hu8"] not in units:
                continue
            key = (row["layer"], row["source_feature_id"])
            # A partial national plane leaves every cell that needs an unbuilt neighbour explicitly unbuilt, and
            # an unbuilt cell has no artifact by design. Those features are outside the comparison rather than
            # missing from it, and the count is reported so the limitation is visible instead of implied.
            if cell not in present_cells:
                excluded[cell].add(key)
                continue
            if key not in regional:
                regional[key] = row
            regional_cells[key] += 1
    national = {}
    national_cells = defaultdict(int)
    for unit in units:
        record = json.loads((work / "partition-jobs" / f"{unit}.json").read_text())
        for cell_id in record["cells"]:
            artifact = work / "artifacts" / "hydro" / f"{cell_id}.parquet"
            if not artifact.exists():
                continue
            for row in pq.read_table(artifact, columns=["canonical_feature_id", "source_feature_id", "layer",
                                                        "water_class", "feature_type_code", "source_length_km",
                                                        "source_area_km2", "length_m", "area_m2"]).to_pylist():
                if row["source_feature_id"] not in {key[1] for key in regional} and row["layer"] not in {key[0] for key in regional}:
                    continue
                key = (row["layer"], row["source_feature_id"])
                national.setdefault(key, row)
                national_cells[key] += 1
    missing = sorted(key for key in regional if key not in national)
    classify_mismatch = []
    attribute_mismatch = []
    measurement_worse = []
    cell_shortfall = []
    for key, row in regional.items():
        counterpart = national.get(key)
        if counterpart is None:
            continue
        if (row["water_class"] != counterpart["water_class"]
                or str(row["feature_type_code"]) != str(counterpart["feature_type_code"])):
            classify_mismatch.append(key)
        for field in ("source_length_km", "source_area_km2"):
            left, right = row[field], counterpart[field]
            if (left is None) != (right is None) or (left is not None and abs(float(left) - float(right)) > 1e-6):
                attribute_mismatch.append((key, field, left, right))
        for field in ("length_m", "area_m2"):
            left, right = row[field], counterpart[field]
            if left is not None and right is not None and float(left) > float(right) * 1.001 + 1e-6:
                measurement_worse.append((key, field, left, right))
        if national_cells[key] < regional_cells[key]:
            cell_shortfall.append((key, regional_cells[key], national_cells[key]))
    assert not missing, f"regional hydro features absent nationally: {missing[:5]}"
    assert not classify_mismatch, f"classification diverges: {classify_mismatch[:5]}"
    assert not attribute_mismatch, f"source attributes diverge: {attribute_mismatch[:3]}"
    assert not measurement_worse, f"clipped regional extent exceeds the whole national feature: {measurement_worse[:3]}"
    assert not cell_shortfall, f"national cell membership does not cover the regional one: {cell_shortfall[:3]}"
    return {"checked": True, "units": list(units), "regionalFeatures": len(regional), "nationalFeatures": len(national),
            "matched": len(regional), "regionalReplicatedRows": sum(regional_cells.values()),
            "nationalReplicatedRows": sum(national_cells.values()),
            "excludedFeatureCells": len(excluded),
            "excludedFeatures": len({key for keys in excluded.values() for key in keys})}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--sample", type=int, default=40, help="duplicate groups re-derived")
    parser.add_argument("--regional-equivalence", action="store_true",
                        help="compare against the published regional plane for the pinned regional pair")
    parser.add_argument("--require-all", action="store_true", help="fail unless every CONUS unit is built")
    args = parser.parse_args()
    lock = json.loads(LOCK_PATH.read_text())
    inventory = json.loads(INVENTORY_PATH.read_text())
    grid = json.loads(GRID_PATH.read_text())
    manifest = json.loads(MANIFEST_PATH.read_text())
    verify_pins(lock, inventory, manifest)
    raw_rows = verify_unit_checkpoints(args.work, lock, manifest)
    identity = verify_identity(args.work, raw_rows, args.sample)
    cells = verify_cells(args.work, grid, manifest)
    assert MANIFEST_PATH.read_text() == json.dumps(manifest, indent=1, sort_keys=True) + "\n", \
        "the manifest is not in its deterministic encoding"
    if args.require_all:
        assert manifest["buildCoverage"] == "complete" and cells["unbuilt"] == 0, \
            "the plane does not cover every pinned CONUS unit"
    regional = verify_regional_equivalence(args.work) if args.regional_equivalence else {"checked": False}
    print(json.dumps({"ok": True, "units": len(manifest["builtUnits"]), "lockUnits": lock["unitCount"],
                      "rawRows": raw_rows, "canonicalFeatures": identity["canonicalFeatures"],
                      "duplicatePackageCopies": identity["duplicatePackageCopies"],
                      "ambiguousRows": identity["ambiguousRows"], "blankIdRows": identity["blankIdRows"],
                      "unitPairs": identity["unitPairs"], "regionalEquivalence": regional, **cells}))


if __name__ == "__main__":
    main()
