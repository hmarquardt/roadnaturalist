"""Spatially indexed pre-groups for the unchanged road_components semantics at CONUS scale."""
import math
from collections import defaultdict

import road_components as base

# 0.003 degrees exceeds 150 m in longitude even at CONUS's northern edge. Search adjacent bins,
# then use the browser's exact haversine distance; bins are only a candidate index, never a connector.
BIN_DEGREES = 0.003


def groups_by_endpoint(rows, tolerance_m=base.JOIN_TOLERANCE_M):
    parent = list(range(len(rows)))

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    bins = defaultdict(list)
    for index, row in enumerate(rows):
        for point in (row["coordinates"][0], row["coordinates"][-1]):
            x, y = math.floor(point[0]/BIN_DEGREES), math.floor(point[1]/BIN_DEGREES)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for other_index, other_point in bins.get((x+dx, y+dy), ()):
                        if other_index != index and base.haversine_m(point, other_point) <= tolerance_m:
                            parent[find(index)] = find(other_index)
            bins[(x, y)].append((index, point))
    groups = defaultdict(list)
    for index, row in enumerate(rows):
        groups[find(index)].append(row)
    return list(groups.values())


def component_index(rows, name_key, normal_name, include_lines=False):
    """Equivalent to base.component_index without its quadratic scan over distant same-name roads."""
    components = []
    duplicates = collapsed = 0
    for group in groups_by_endpoint(rows):
        local = base.component_index(group, name_key, normal_name)
        if local:
            source_lines = None
            if include_lines:
                deduped, _, _ = base.dedupe_source_lines([
                    {"sourceFeatureId": row["source_feature_id"], "coordinates": row["coordinates"]} for row in group])
                source_lines = base.component_groups(deduped)
            duplicates += local[0]["duplicatesRemoved"]
            collapsed += local[0]["collapsedReversedLinks"]
            by_id = {str(row["source_feature_id"]): row for row in group}
            for local_index, item in enumerate(local):
                if include_lines:
                    item = {**item, "sourceLines": source_lines[local_index]}
                representative = min((by_id[feature] for feature in item["sourceFeatureIds"] if feature in by_id),
                                     key=lambda row: (-base.line_length_m(row["coordinates"]), str(row["source_feature_id"])))
                components.append(((-base.line_length_m(representative["coordinates"]),
                                    str(representative["source_feature_id"])), item))
    components.sort(key=lambda pair: pair[0])
    count = len(components)
    output = []
    for index, (_, item) in enumerate(components):
        item = dict(item)
        item["id"] = f"{base.DISCOVERY_ID_PREFIX}-{name_key}" + (f"-c{index+1}" if count > 1 else "")
        item["componentIndex"] = index + 1
        item["componentCount"] = count
        item["duplicatesRemoved"] = duplicates
        item["collapsedReversedLinks"] = collapsed
        output.append(item)
    return output
