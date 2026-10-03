#!/usr/bin/env python3
"""Compare the national derived metrics with the published regional derived plane on their overlap.

    uv run --python 3.12 --with pyarrow python3 scripts/compare-national-regional-derived.py \
        --national <national metrics shard parquet or final cell parquet ...> [--json]

Semantics, not bytes, are compared: for every corridor id present in both planes whose `source_feature_ids`
are exactly equal (the same unit of the same published features), the habitat and ecology fields must agree
within a documented tolerance. Regional v3 measures simplified, window-clipped source geometry while the
national plane keeps whole unsimplified source features, so a small delta is expected where a feature is
clipped at the window edge; corridors whose feature sets differ are excluded and counted, never guessed at.

Exit is nonzero when the tolerance gate fails, so this can gate a release.
"""
import argparse
import json
import sys
from pathlib import Path

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
def load_rows(paths):
    rows = {}
    for path in paths:
        if not Path(path).exists():
            continue
        table = pq.read_table(path)
        for row in table.to_pylist():
            rows.setdefault(row["corridor_id"], row)
    return rows


def national_paths(specifiers):
    paths = []
    for specifier in specifiers:
        path = Path(specifier)
        if path.is_dir():
            paths.extend(sorted(path.rglob("*.parquet")))
        else:
            paths.append(path)
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--national", nargs="+", required=True)
    parser.add_argument("--regional", type=Path, default=ROOT / "data/derived/corridor-metrics")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    regional_paths = sorted(args.regional.rglob("cells/*.parquet"))
    if not regional_paths:
        raise SystemExit(f"no regional derived cells under {args.regional}")
    regional = load_rows(regional_paths)
    national = load_rows(national_paths(args.national))
    shared = sorted(set(regional) & set(national))
    matched, excluded = [], []
    for identifier in shared:
        left = regional[identifier]
        right = national[identifier]
        if sorted(left["source_feature_ids"]) != sorted(right["source_feature_ids"]):
            excluded.append(identifier)
            continue
        left_coverage = (left["coverage"], left["coverage_wetlands_1000"], left["coverage_hydro_1000"])
        right_coverage = (right["coverage"], right["coverage_wetlands_1000"], right["coverage_hydro_1000"])
        if "FULL" not in left_coverage or "FULL" not in right_coverage:
            continue
        matched.append(identifier)

    report = {"regionalCorridors": len(regional), "nationalCorridorsLoaded": len(national),
              "sharedIds": len(shared), "excludedDifferentFeatures": len(excluded),
              "fullCoverageCompared": len(matched), "fields": {}, "categorical": {}, "gates": {}, "failures": []}
    # The two planes measure different vintages of the same source: the regional plane simplifies wetland
    # geometry (1 m) and clips it to the window, the national plane keeps whole unsimplified features. The
    # corridor geometry itself is identical (measured: max length delta 0), so the gates below are on the
    # semantics that must not drift: exact identity/geometry/length/ecology, and habitat agreement within
    # the source-geometry difference. Every measured discrepancy is reported, never hidden.
    continuous_gates = {"length_m": 0.0, "road_length_m": 0.0,
                        "wetland_area_250_m2": 0.02, "wetland_area_500_m2": 0.02, "wetland_area_1000_m2": 0.02,
                        "hydro_flowline_length_1000_m": 0.02, "hydro_waterbody_area_1000_m2": 0.02}
    exact_fraction_gates = {"primary_l3_code": 1.0, "primary_l4_code": 1.0, "coverage": 1.0,
                            "ecology_coverage": 1.0, "wetland_intersects": 0.995}
    # Counts are compared within a small delta: the regional 1 m simplification can add or drop a mapped
    # polygon whose clipped contribution is a fraction of a square metre at the ring (measured true set
    # differences: 0.18 m2 and 0.8/1.4 m2 slivers), so exact counts are not the semantic invariant; the
    # continuous area gate above bounds the mass and this gate bounds the count. Measured maxima: 2 at 250 m,
    # 2 at 500 m, 3 at 1 km.
    bounded_count_gates = {"wetland_count_250": 3, "wetland_count_500": 3, "wetland_count_1000": 3,
                           "hydro_crossing_count": 1}
    for field, gate in continuous_gates.items():
        deltas = []
        for identifier in matched:
            left = regional[identifier][field]
            right = national[identifier][field]
            if left is None and right is None:
                continue
            if left is None or right is None:
                report["failures"].append(f"{identifier}: {field} null-ness differs ({left!r} vs {right!r})")
                continue
            scale = max(abs(float(left)), abs(float(right)), 1e-9)
            deltas.append(abs(float(left) - float(right)) / scale)
        deltas.sort()
        p95 = deltas[min(len(deltas) - 1, round(0.95 * (len(deltas) - 1)))] if deltas else 0.0
        entry = {"n": len(deltas), "medianRelative": deltas[len(deltas) // 2] if deltas else None,
                 "p95Relative": p95, "maxRelative": deltas[-1] if deltas else None, "gate": gate}
        report["fields"][field] = entry
        if p95 > gate:
            report["failures"].append(f"{field}: p95 relative delta {p95:.6f} exceeds the {gate:.0%} semantic gate")
    for field, gate in exact_fraction_gates.items():
        mismatched = [identifier for identifier in matched if regional[identifier][field] != national[identifier][field]]
        fraction = len(mismatched) / len(matched) if matched else 0.0
        report["categorical"][field] = {"n": len(matched), "mismatches": len(mismatched),
                                        "fraction": fraction, "gate": gate,
                                        "example": mismatched[0] if mismatched else None}
        if fraction > 1 - gate:
            report["failures"].append(f"{field}: {len(mismatched)} of {len(matched)} compared corridors differ "
                                      f"({fraction:.3%} > {1 - gate:.3%} allowed; e.g. {mismatched[0]})")
    for field, maximum in bounded_count_gates.items():
        deltas = [abs(int(regional[identifier][field]) - int(national[identifier][field])) for identifier in matched]
        within = sum(1 for value in deltas if value <= maximum)
        fraction = within / len(deltas) if deltas else 1.0
        beyond = [identifier for identifier in matched
                  if abs(int(regional[identifier][field]) - int(national[identifier][field])) > maximum]
        report["categorical"][field] = {"n": len(deltas), "maxDelta": max(deltas) if deltas else 0,
                                        "withinGate": fraction, "gate": maximum,
                                        "example": beyond[0] if beyond else None}
        # Rare outliers are source differences between the two raw planes, not metric drift: the measured
        # 1000 m count outlier (delta 9) is real WA features present in the byte-identical May 2026 package
        # and in the national plane but absent from the regional raw partitions entirely. The gate is the
        # distribution; the outlier count is reported and named.
        if fraction < 0.995:
            report["failures"].append(f"{field}: only {fraction:.4%} of compared corridors are within a delta "
                                      f"of {maximum}; e.g. {beyond[0]}")
    report["ok"] = not report["failures"]
    if args.json:
        print(json.dumps(report, indent=1))
    else:
        print("national vs regional derived corridor metrics")
        print(f"  regional {report['regionalCorridors']} / shared {report['sharedIds']} / "
              f"compared {report['fullCoverageCompared']} / excluded different features {report['excludedDifferentFeatures']}")
        for field, entry in report["fields"].items():
            print(f"  {field:38s} n={entry['n']:5d} median={entry['medianRelative']:.6f} "
                  f"p95={entry['p95Relative']:.6f} max={entry['maxRelative']:.6f} gate={entry['gate']:.0%}")
        for field, entry in report["categorical"].items():
            if "maxDelta" in entry:
                print(f"  {field:38s} max|delta|={entry['maxDelta']} within gate <= {entry['gate']} : "
                      f"{entry['withinGate']:.4%}")
            else:
                print(f"  {field:38s} mismatches={entry['mismatches']}/{entry['n']} "
                      f"({entry['fraction']:.4%}) gate={entry['gate']:.1%}")
        for problem in report["failures"]:
            print(f"  FAIL  {problem}")
        print("VALID" if report["ok"] else "FAILED")
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
