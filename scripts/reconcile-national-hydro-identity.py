#!/usr/bin/env python3
"""Reconcile the hydro identity stage against the validated per-unit outputs, per unit.

`verify-national-hydro.py` asserts that the identity artifact's raw-row total equals the sum declared by the
2,166 unit checkpoints. When that fails, the useful question is not "which total is bigger" but "which units
disagree", because the identity stage is a per-unit accumulation: every raw row belongs to exactly one unit, so
`identity.json`'s `unitPairs` and each checkpoint's `stats.inputRows` must agree unit by unit.

This produces that reconciliation and nothing else - it never writes to the workspace:

  expected raw rows      sum of `stats.inputRows` over every unit whose checkpoint is `complete`
  identity raw rows      sum of `identity.json`'s per-unit pair counts (and its declared `rawRows`)
  delta                  identity minus expected, unit by unit and in total
  unit sets              units present in one side only, checkpoint files that disagree with their `unit` field
                         (the duplicate/driver-race signature), and per-unit row mismatches

Recovery follows from the shape of the answer: identical unit sets with mismatched counts means the identity
artifact is a different generation of the same inputs (rebuild it); units present in only one side means the
stages ran against different unit lists (fix the list, then rebuild only what depends on it).
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_volume as bv  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", type=Path, default=Path("/Volumes/Lexar/roadnaturalist/work/nhd"))
    parser.add_argument("--top", type=int, default=12, help="how many per-unit mismatches to print")
    parser.add_argument("--database", action="store_true",
                        help="also compare the identity mapping per unit (reads every mapping row; slow on the "
                             "13.9 GB identity database and therefore opt-in)")
    arguments = parser.parse_args()

    jobs = arguments.work / "jobs"
    identity_path = arguments.work / "identity.json"
    identity = json.loads(identity_path.read_text())
    pairs = identity.get("unitPairs", {})

    checkpoints: dict[str, dict[str, int | str | None]] = {}
    duplicate_units: dict[str, list[str]] = {}
    mislabelled: list[str] = []
    for path in sorted(jobs.glob("*.json")):
        # ExFAT writes an AppleDouble `._name` sidecar beside every file, and Python's glob matches it while the
        # shell's does not - which is exactly how one of these gets mistaken for a checkpoint.
        if not bv.is_data_file(path):
            continue
        record = json.loads(path.read_text())
        unit = record.get("unit")
        if unit != path.stem:
            mislabelled.append(f"{path.name} declares unit {unit!r}")
        if unit in checkpoints:
            duplicate_units.setdefault(unit, [f"{unit}.json"]).append(path.name)
        # The verifier accumulates `outputRows` (rows the identity stage actually read from the normalized
        # parquet), so that is the comparable figure. `stats.inputRows` is reported alongside because the two
        # differ whenever normalization dropped a row, which is itself worth seeing.
        checkpoints[unit] = {"rows": record.get("outputRows"),
                            "inputRows": (record.get("stats") or {}).get("inputRows"),
                            "state": record.get("state"), "file": path.name}

    expected = sum(entry["rows"] or 0 for entry in checkpoints.values())
    declared = identity.get("rawRows")
    incomplete = sorted(unit for unit, entry in checkpoints.items() if entry["state"] != "complete")
    # `unitPairs` is keyed by "unitA/unitB" - the pair of units that shared a duplicate - so its keys are not
    # unit identifiers and its values are not per-unit row counts. It is reported as what it is, and the per-unit
    # comparison is read from the identity database instead (opt-in, because it reads every mapping row).
    cross_unit_copies = sum(pairs.values())
    per_unit, database_reason = {}, None
    if arguments.database:
        try:
            connection = sqlite3.connect(f"file:{arguments.work / 'identity.sqlite'}?mode=ro", uri=True)
            per_unit = dict(connection.execute("SELECT unit, count(*) FROM mapping GROUP BY unit"))
            connection.close()
        except sqlite3.Error as error:  # an unreadable database is reported, never guessed at
            database_reason = str(error)
    missing = sorted(set(checkpoints) - set(per_unit)) if per_unit else []
    without_checkpoint = sorted(set(per_unit) - set(checkpoints)) if per_unit else []
    mismatched = sorted(((unit, entry["rows"], per_unit[unit]) for unit, entry in checkpoints.items()
                         if unit in per_unit and entry["rows"] != per_unit[unit]),
                        key=lambda row: -abs((row[1] or 0) - row[2])) if per_unit else []
    stored = sum(per_unit.values()) if per_unit else None

    reasons = []
    if incomplete:
        reasons.append(f"{len(incomplete)} checkpoints are not complete")
    if duplicate_units or mislabelled:
        reasons.append("checkpoint files are duplicated or mislabelled")
    if declared != expected:
        reasons.append(f"identity declares {declared} raw rows against {expected} from the unit outputs")
    if identity.get("canonicalFeatures") != (declared or 0) - (identity.get("duplicatePackageCopies") or 0):
        reasons.append("identity canonical arithmetic does not hold")
    if per_unit:
        if missing:
            reasons.append(f"{len(missing)} units are absent from the identity mapping")
        if without_checkpoint:
            reasons.append(f"{len(without_checkpoint)} mapping units have no checkpoint")
        if mismatched:
            reasons.append(f"{len(mismatched)} units disagree with the identity row counts")
        if stored != expected:
            reasons.append(f"the mapping holds {stored} rows against {expected} from the unit outputs")

    report = {"state": "reconciled" if not reasons else "disagreeing", "reasons": reasons,
              "checkpointUnits": len(checkpoints), "expectedRawRows": expected,
              "identityDeclaredRawRows": declared, "rowDelta": (declared or 0) - expected,
              "identityMappingRows": stored, "databaseChecked": arguments.database,
              "databaseUnavailable": database_reason, "crossUnitDuplicatePairs": len(pairs),
              "crossUnitDuplicateCopies": cross_unit_copies, "identityState": identity.get("state"),
              "identityInputSha256": identity.get("inputSha256"), "checkpointDir": str(jobs),
              "incompleteCheckpoints": incomplete, "mislabelledCheckpointFiles": mislabelled,
              "duplicateUnitCheckpoints": duplicate_units, "unitsMissingFromIdentity": missing,
              "unitsWithoutCheckpoint": without_checkpoint, "mismatchedUnitCount": len(mismatched),
              "largestMismatches": [{"unit": unit, "checkpointRows": rows, "identityRows": identity_rows,
                                     "delta": (rows or 0) - identity_rows} for unit, rows, identity_rows in
                                    mismatched[: max(0, arguments.top)]]}
    print(json.dumps(report, indent=1, sort_keys=True))
    raise SystemExit(0 if report["state"] == "reconciled" else 1)


if __name__ == "__main__":
    main()
