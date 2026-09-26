#!/usr/bin/env python3
"""Road connected components, mirroring the browser's discovery composition rules exactly.

The browser turns source road features into discovery units in src/discovery/units.js: features are
normalized (exact and reversed duplicates collapse), joined by endpoint proximity inside one normalized name,
and split into connected components, so two unrelated roads that share a name never become one candidate.
That is the right unit for a cell-closure index too: a component is the largest set of features that can end
up in the same corridor.

This module is the build-time mirror of those rules, so the published component index names exactly the units
the browser composes from the selected cells:

    clean line -> drop exact duplicates -> collapse reversed links -> endpoint components (150 m)
             -> order components by their representative line -> stable drv1-<name-key>[-c<n>] id

`tests/road-components.test.js` cross-checks this mirror against the real JavaScript modules on real source
features, and asserts that a shuffled feature order produces the same index.
"""
import math
from collections import OrderedDict

JOIN_TOLERANCE_M = 150.0
REVERSED_LINK_LENGTH_RATIO = 0.25
EARTH_RADIUS_M = 6371000.0  # the browser's haversine mean radius (src/domain/geometry.js)
DISCOVERY_ID_PREFIX = "drv1"


def haversine_m(first, second):
    lat1, lon1 = math.radians(first[1]), math.radians(first[0])
    lat2, lon2 = math.radians(second[1]), math.radians(second[0])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def clean_line(coordinates):
    kept = []
    for point in coordinates or []:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            continue
        lon, lat = float(point[0]), float(point[1])
        if not (math.isfinite(lon) and math.isfinite(lat)) or abs(lon) > 180 or abs(lat) > 90:
            continue
        if kept and kept[-1][0] == lon and kept[-1][1] == lat:
            continue
        kept.append([lon, lat])
    return kept


def line_length_m(coordinates):
    return sum(haversine_m(coordinates[index - 1], coordinates[index]) for index in range(1, len(coordinates)))


def endpoint_gap_m(first, second):
    ends = (first[0], first[-1])
    starts = (second[0], second[-1])
    return min(haversine_m(a, b) for a in ends for b in starts)


def is_reversed_link(first, second, tolerance_m=JOIN_TOLERANCE_M):
    if endpoint_gap_m(list(reversed(first)), second) > tolerance_m:
        return False
    lengths = (line_length_m(first), line_length_m(second))
    if abs(lengths[0] - lengths[1]) > REVERSED_LINK_LENGTH_RATIO * max(lengths):
        return False
    return haversine_m(first[len(first) // 2], second[len(second) // 2]) <= tolerance_m


def compare_lines(left, right):
    """The browser's order: longest first, then source feature id ascending."""
    left_key = (-line_length_m(left["coordinates"]), str(left["sourceFeatureId"]))
    right_key = (-line_length_m(right["coordinates"]), str(right["sourceFeatureId"]))
    return (left_key > right_key) - (left_key < right_key)


def dedupe_source_lines(lines, tolerance_m=JOIN_TOLERANCE_M):
    cleaned = []
    for line in lines:
        coordinates = clean_line(line.get("coordinates"))
        if len(coordinates) >= 2:
            cleaned.append({"sourceFeatureId": str(line.get("sourceFeatureId", "")), "coordinates": coordinates})
    kept, seen, duplicates = [], set(), 0
    for line in sorted(cleaned, key=lambda item: (-line_length_m(item["coordinates"]), str(item["sourceFeatureId"]))):
        forward = ";".join(f"{point[0]},{point[1]}" for point in line["coordinates"])
        backward = ";".join(f"{point[0]},{point[1]}" for point in reversed(line["coordinates"]))
        if forward in seen or backward in seen:
            duplicates += 1
            continue
        seen.add(forward)
        seen.add(backward)
        kept.append(line)
    collapsed, survivors = 0, []
    for line in sorted(kept, key=lambda item: (-line_length_m(item["coordinates"]), str(item["sourceFeatureId"]))):
        if any(is_reversed_link(other["coordinates"], line["coordinates"], tolerance_m) for other in survivors):
            collapsed += 1
            continue
        survivors.append(line)
    return survivors, duplicates, collapsed


def component_groups(lines, tolerance_m=JOIN_TOLERANCE_M):
    """Endpoint-connectivity components, ordered exactly as the browser orders them."""
    parent = list(range(len(lines)))

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for a in range(len(lines)):
        for b in range(a + 1, len(lines)):
            if endpoint_gap_m(lines[a]["coordinates"], lines[b]["coordinates"]) <= tolerance_m:
                parent[find(a)] = find(b)
    groups = OrderedDict()
    for index, line in enumerate(lines):
        groups.setdefault(find(index), []).append(line)

    def representative(group):
        return min(group, key=lambda item: (-line_length_m(item["coordinates"]), str(item["sourceFeatureId"])))

    def group_key(group):
        line = representative(group)
        return (-line_length_m(line["coordinates"]), str(line["sourceFeatureId"]))

    return sorted(groups.values(), key=group_key)


def component_index(rows, name_key, normal_name, tolerance_m=JOIN_TOLERANCE_M):
    """Components for one normalized road name, with the browser's stable ids.

    ``rows`` are normalized source rows (name, source_feature_id, coordinates, county_fips, min_lon...).
    """
    lines = [{"sourceFeatureId": row["source_feature_id"], "coordinates": row["coordinates"]} for row in rows]
    deduped, duplicates, collapsed = dedupe_source_lines(lines, tolerance_m)
    if not deduped:
        return []
    components = component_groups(deduped, tolerance_m)
    # Bounds come from the component's own vertices rather than from the composed line: the composition
    # orients and merges source lines for display, and the raw union of the component's vertices is a
    # conservative superset of it. A closure index must never be narrower than the geometry it stands for.
    by_id = {str(row["source_feature_id"]): row for row in rows}
    output = []
    for index, component in enumerate(components):
        members = [by_id[line["sourceFeatureId"]] for line in component if line["sourceFeatureId"] in by_id]
        coordinates = [point for line in component for point in line["coordinates"]]
        kinds = {}
        for row in members:
            kinds[row["name"]] = kinds.get(row["name"], 0) + 1
        display = sorted(kinds.items(), key=lambda item: (-item[1], item[0]))[0][0] if kinds else normal_name
        output.append({
            "id": f"{DISCOVERY_ID_PREFIX}-{name_key}" + (f"-c{index + 1}" if len(components) > 1 else ""),
            "name": display, "componentIndex": index + 1, "componentCount": len(components),
            "sourceFeatureIds": [line["sourceFeatureId"] for line in component],
            "counties": sorted({row["county_fips"] for row in members if row.get("county_fips")}),
            "featureCount": len(component),
            "lengthM": round(sum(line_length_m(line["coordinates"]) for line in component), 3),
            "duplicatesRemoved": duplicates, "collapsedReversedLinks": collapsed,
            "bounds": [min(point[0] for point in coordinates), min(point[1] for point in coordinates),
                       max(point[0] for point in coordinates), max(point[1] for point in coordinates)],
        })
    return output
