#!/usr/bin/env python3
"""Build the immutable derived corridor-metrics plane for a published regional window.

    npm run build:derived

Every stage reuses an existing definition instead of restating it:

    published road partitions      raw, immutable
      -> source features            the runtime's own dedupe key (county_fips, source_feature_id, part)
      -> corridor composition       node scripts/compose-derived-corridors.mjs -> src/discovery/units.js,
                                    src/discovery/segment.js: the modules the browser composes with
      -> analytical geometry        canonical, else the shared repair ladder (point-preserving)
      -> habitat metrics            the shared expressions from src/gis/habitat-metrics.js
      -> derived rows               0.2 degree cells, whole rows replicated into every cell they intersect
      -> GeoParquet + manifest      carrying the analysis fingerprint

`npm run verify:derived-equivalence` proves the result against a live raw batch and detailed analysis.
"""
import argparse
import hashlib
import json
import math
import subprocess
import sys
import time
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from shapely import wkb
from shapely.geometry import box, shape

ROOT = Path(__file__).resolve().parents[1]
STEP = 0.2
METRES_PER_DEGREE_LAT = 110000.0
METRES_PER_DEGREE_LON = 111320.0
PAD_MARGIN = 1.1
DISTANCES = (250, 500, 1000)
WORK = Path('/tmp/roadnaturalist-derived')


def log(message):
    print(message, flush=True)


def sha256_of(path):
    value = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def run_node(args):
    result = subprocess.run(['node', *args], cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"node {' '.join(args)} failed:\n{result.stderr[-4000:]}")
    return result.stdout.strip()


def pad_of(bounds, distance_m):
    """The runtime neighbourhood pad (src/gis/habitat-result.js paddedBounds), mirrored exactly."""
    centre = (bounds[1] + bounds[3]) / 2 * math.pi / 180
    lat_pad = distance_m / METRES_PER_DEGREE_LAT * PAD_MARGIN
    lon_pad = distance_m / (METRES_PER_DEGREE_LON * max(math.cos(centre), 0.2)) * PAD_MARGIN
    return [bounds[0] - lon_pad, bounds[1] - lat_pad, bounds[2] + lon_pad, bounds[3] + lat_pad]


def cells_for(bounds):
    x0 = math.floor((bounds[0] + 180) / STEP)
    x1 = math.ceil((bounds[2] + 180) / STEP)
    y0 = math.floor((bounds[1] + 90) / STEP)
    y1 = math.ceil((bounds[3] + 90) / STEP)
    for x in range(x0, x1):
        for y in range(y0, y1):
            yield f"x{x}_y{y}", [round(-180 + STEP * x, 9), round(-90 + STEP * y, 9),
                                 round(-180 + STEP * (x + 1), 9), round(-90 + STEP * (y + 1), 9)]


def wkt_of(geometry):
    def line(coordinates):
        return '(' + ','.join(f"{point[0]} {point[1]}" for point in coordinates) + ')'
    if geometry['type'] == 'LineString':
        return 'LINESTRING' + line(geometry['coordinates'])
    if geometry['type'] == 'MultiLineString':
        return 'MULTILINESTRING(' + ','.join(line(part) for part in geometry['coordinates']) + ')'
    raise ValueError(f"unsupported corridor geometry {geometry['type']}")


class Builder:
    def __init__(self, catalog, profile, region):
        self.catalog = catalog
        self.profile = profile
        self.fingerprint = profile['fingerprint']
        self.region = region
        self.con = duckdb.connect()
        self.con.execute('INSTALL spatial; LOAD spatial')
        # The habitat layers are far larger than the process can hold, so DuckDB is given a ceiling and spills
        # instead of being killed by the machine mid-build.
        self.con.execute("PRAGMA memory_limit='2GB'")
        self.con.execute('PRAGMA threads=4')
        self.expressions = json.loads(Path('/tmp/habitat-sql.json').read_text())
        self.datasets = {dataset['id']: dataset for dataset in catalog['datasets']}
        # Per-chunk restriction: corridor chunk bounds and the pad clause each metric query adds for the
        # habitat table it reads. Without it a 16k-corridor window would be one corridor x habitat cross join.
        self.chunk_ids = None
        self.chunk_pad = None
        self.build_bounds = None

    # ------------------------------------------------------------------ dataset relations
    def files(self, dataset_id):
        return [str(ROOT / 'data' / part['url']) for part in self.datasets[dataset_id]['partitions'] if part['state'] == 'present']

    def prepare_habitat(self):
        con = self.con
        con.execute('CREATE OR REPLACE TEMP VIEW wetland_all AS SELECT source_feature_id, attribute, wetland_type, '
                    'min_lon, min_lat, max_lon, max_lat, ST_Transform(geometry, \'EPSG:4326\', \'EPSG:5070\', always_xy := true) AS geom '
                    'FROM (SELECT *, row_number() OVER (PARTITION BY source_feature_id) AS rn FROM read_parquet(' + repr(self.files('wetlands')) + ')) WHERE rn = 1')
        con.execute('CREATE OR REPLACE TEMP VIEW hydro_all AS SELECT layer, source_feature_id, name, feature_type_code, '
                    'feature_type_label, water_class, min_lon, min_lat, max_lon, max_lat, ST_Transform(geometry, \'EPSG:4326\', \'EPSG:5070\', always_xy := true) AS geom '
                    'FROM (SELECT *, row_number() OVER (PARTITION BY layer, source_feature_id) AS rn FROM read_parquet(' + repr(self.files('hydrography')) + ')) WHERE rn = 1')
        # One relation over every declared ecoregion layer, tagged with its level so the level metrics can
        # read the union of states the runtime answers from.
        parts = []
        for dataset in self.eco_datasets():
            parts.append("SELECT *, %d AS level FROM read_parquet('%s')" % (int(dataset['level']), ROOT / 'data' / dataset['url']))
        con.execute('CREATE OR REPLACE TEMP VIEW eco_all AS ' + ' UNION ALL '.join(parts))
        self.reset_views()

    def eco_datasets(self):
        manifest = json.loads((ROOT / 'data/manifest.json').read_text())
        return [dataset for dataset in manifest['datasets'] if dataset['id'].startswith('epa-ecoregions-')]

    # ------------------------------------------------------------------ chunk views
    def reset_views(self):
        """Whole-window relations, used before the first chunk is set."""
        for name in ('wetland', 'hydro', 'eco'):
            self.con.execute(f'CREATE OR REPLACE TEMP TABLE {name} AS SELECT * FROM {name}_all')

    def set_chunk(self, ids, bounds):
        """Restrict every relation to one chunk: the corridor view to these ids, and each habitat view to the
        chunk's padded bounding box. The metric statements themselves are unchanged, so the offline build runs
        the batch's own queries - the restriction is a bounding-box prefilter of the kind the runtime already
        applies per corridor, which the pad proof makes exact."""
        self.chunk_ids = list(ids)
        pad = pad_of(bounds, max(DISTANCES))
        self.chunk_pad = pad
        listing = ','.join(f"'{value}'" for value in ids)
        self.con.execute(f'CREATE OR REPLACE TEMP VIEW corridor AS SELECT * FROM corridor_all WHERE id IN ({listing})')
        for name in ('wetland', 'hydro', 'eco'):
            self.con.execute(f"CREATE OR REPLACE TEMP TABLE {name} AS SELECT * FROM {name}_all WHERE "
                             f"{pad[0]} <= max_lon AND {pad[2]} >= min_lon AND {pad[1]} <= max_lat AND {pad[3]} >= min_lat")

    # ------------------------------------------------------------------ corridor table and probing
    def load_corridors(self, corridors, analytical):
        """Materialise the analytical corridors through a registered Arrow table: no SQL parameter is ever
        wrapped in a function call, which is what makes DuckDB's binding behave."""
        con = self.con
        ids, wkts, bounds, pads = [], [], [], []
        for corridor in corridors:
            box_bounds = corridor['bounds']
            pad = pad_of(box_bounds, max(DISTANCES))
            ids.append(corridor['id'])
            wkts.append(analytical[corridor['id']]['wkt'])
            bounds.append([float(value) for value in box_bounds])
            pads.append([float(value) for value in pad])
        con.register('corridor_input', pa.table({'id': ids, 'wkt': wkts,
          'min_lon': [value[0] for value in bounds], 'min_lat': [value[1] for value in bounds],
          'max_lon': [value[2] for value in bounds], 'max_lat': [value[3] for value in bounds],
          'pad_min_lon': [value[0] for value in pads], 'pad_min_lat': [value[1] for value in pads],
          'pad_max_lon': [value[2] for value in pads], 'pad_max_lat': [value[3] for value in pads]}))
        con.execute("CREATE OR REPLACE TEMP TABLE corridor_all AS SELECT id, "
                    "ST_Transform(ST_GeomFromText(wkt), 'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom, "
                    "ST_GeomFromText(wkt) AS geom_4326, min_lon, min_lat, max_lon, max_lat, "
                    "pad_min_lon, pad_min_lat, pad_max_lon, pad_max_lat FROM corridor_input")
        con.execute('CREATE OR REPLACE TEMP VIEW corridor AS SELECT * FROM corridor_all')
        count = con.execute('SELECT count(*) FROM corridor_all').fetchone()[0]
        assert count == len(corridors), (count, len(corridors))

    def probe_geometry(self, ids, wkts):
        """Ask the engine to buffer these corridor geometries: the same operation the runtime probes with."""
        self.con.register('probe_input', pa.table({'id': ids, 'wkt': wkts}))
        self.con.execute("CREATE OR REPLACE TEMP TABLE probe AS SELECT id, "
                         "ST_Transform(ST_GeomFromText(wkt), 'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom FROM probe_input")
        self.con.execute('SELECT count(*) FROM (SELECT ST_Buffer(geom, 1000) AS b FROM probe) WHERE b IS NOT NULL')

    def failing(self, entries):
        """Bisect corridor geometries down to the ones the engine refuses to buffer."""
        try:
            self.probe_geometry([entry[0] for entry in entries], [entry[1] for entry in entries])
            return []
        except duckdb.Error:
            if len(entries) == 1:
                return [entries[0][0]]
            middle = len(entries) // 2
            return self.failing(entries[:middle]) + self.failing(entries[middle:])

    # ------------------------------------------------------------------ metrics (shared definitions)
    def route_lengths(self):
        return {str(row[0]): float(row[1]) for row in self.con.execute('SELECT id, ST_Length(geom) FROM corridor').fetchall()}

    def wetland_metrics(self):
        rows = self.con.execute(f"""
          WITH d(distance_m) AS (VALUES (250), (500), (1000)),
          hit AS (
            SELECT c.id AS id, d.distance_m AS distance_m, w.wetland_type AS label, w.attribute AS code,
                   w.source_feature_id AS source_feature_id, {self.expressions['wetlandArea']} AS area_m2
            FROM corridor c, d, wetland w
            WHERE c.pad_min_lon <= w.max_lon AND c.pad_max_lon >= w.min_lon
              AND c.pad_min_lat <= w.max_lat AND c.pad_max_lat >= w.min_lat
              AND ST_Intersects(w.geom, ST_Buffer(c.geom, d.distance_m))
          )
          SELECT id, distance_m, label, code, {self.expressions['wetlandCount']} AS feature_count, sum(area_m2) AS area_m2
          FROM hit WHERE area_m2 > 0 GROUP BY id, distance_m, label, code ORDER BY id, distance_m, sum(area_m2) DESC
        """).fetchall()
        by_id = {}
        for identifier, distance, label, code, feature_count, area in rows:
            entry = by_id.setdefault(identifier, {'buffers': {}, 'classes': {}})
            bucket = entry['buffers'].setdefault(int(distance), {'areaM2': 0.0, 'featureCount': 0})
            bucket['areaM2'] += float(area)
            bucket['featureCount'] += int(feature_count)
            if int(distance) == max(DISTANCES):
                classes = entry['classes'].setdefault((label or 'Unclassified', code), {'areaM2': 0.0, 'featureCount': 0})
                classes['areaM2'] += float(area)
                classes['featureCount'] += int(feature_count)
        proximity = {str(row[0]): {'corridorFeatures': int(row[1]), 'nearestM': None if row[2] is None else float(row[2])}
                     for row in self.con.execute(f"""
            SELECT c.id, count(*) FILTER (WHERE ST_Intersects(w.geom, c.geom)) AS corridor_features,
                   min(ST_Distance(w.geom, c.geom)) AS nearest_m
            FROM corridor c, wetland w
            WHERE c.pad_min_lon <= w.max_lon AND c.pad_max_lon >= w.min_lon
              AND c.pad_min_lat <= w.max_lat AND c.pad_max_lat >= w.min_lat
            GROUP BY c.id""").fetchall()}
        for identifier, entry in by_id.items():
            entry.update(proximity.get(identifier, {'corridorFeatures': 0, 'nearestM': None}))
        for identifier, entry in proximity.items():
            if entry['nearestM'] is not None and entry['nearestM'] > max(DISTANCES): entry['nearestM'] = None
            by_id.setdefault(identifier, {'buffers': {}, 'classes': {}, **entry})
        return by_id

    def hydro_metrics(self):
        rows = self.con.execute(f"""
          WITH d(distance_m) AS (VALUES (250), (500), (1000)),
          hit AS (
            SELECT c.id AS id, d.distance_m AS distance_m, f.layer AS layer, f.source_feature_id AS source_feature_id,
                   {self.expressions['hydroLength']} AS length_m, {self.expressions['hydroArea']} AS area_m2
            FROM corridor c, d, hydro f
            WHERE c.pad_min_lon <= f.max_lon AND c.pad_max_lon >= f.min_lon
              AND c.pad_min_lat <= f.max_lat AND c.pad_max_lat >= f.min_lat
              AND ST_Intersects(f.geom, ST_Buffer(c.geom, d.distance_m))
          )
          SELECT id, distance_m, layer, {self.expressions['hydroCount']} AS feature_count,
                 sum(area_m2) AS area_m2, sum(length_m) AS length_m
          FROM hit WHERE length_m > 0 OR area_m2 > 0 GROUP BY id, distance_m, layer ORDER BY id, distance_m, layer
        """).fetchall()
        buffers = {}
        for identifier, distance, layer, feature_count, area, length in rows:
            entry = buffers.setdefault(identifier, {})
            bucket = entry.setdefault(int(distance), {'flowlineLengthM': 0.0, 'waterbodyAreaM2': 0.0, 'featureCount': 0})
            bucket['featureCount'] += int(feature_count)
            bucket['flowlineLengthM'] += float(length or 0.0)
            bucket['waterbodyAreaM2'] += float(area or 0.0)
        crossings = {}
        for identifier, source_id, name, label, overlap in self.con.execute("""
            SELECT c.id, f.source_feature_id, f.name, f.feature_type_label,
                   ST_Length(ST_Intersection(f.geom, c.geom)) AS overlap_m
            FROM corridor c, hydro f
            WHERE f.layer = 'flowline' AND c.pad_min_lon <= f.max_lon AND c.pad_max_lon >= f.min_lon
              AND c.pad_min_lat <= f.max_lat AND c.pad_max_lat >= f.min_lat AND ST_Intersects(f.geom, c.geom)""").fetchall():
            crossings.setdefault(identifier, []).append({'sourceFeatureId': str(source_id), 'name': name or None,
              'featureTypeLabel': label, 'overlapM': round(float(overlap or 0.0), 3)})
        for entry in crossings.values():
            entry.sort(key=lambda item: (-item['overlapM'], item['sourceFeatureId']))
        proximity = {}
        for identifier, flowing, standing in self.con.execute("""
            SELECT c.id, min(ST_Distance(f.geom, c.geom)) FILTER (WHERE f.water_class = 'flowing'),
                   min(ST_Distance(f.geom, c.geom)) FILTER (WHERE f.water_class = 'standing')
            FROM corridor c, hydro f
            WHERE c.pad_min_lon <= f.max_lon AND c.pad_max_lon >= f.min_lon
              AND c.pad_min_lat <= f.max_lat AND c.pad_max_lat >= f.min_lat
            GROUP BY c.id""").fetchall():
            proximity[identifier] = {'nearestFlowingM': None if flowing is None or float(flowing) > max(DISTANCES) else float(flowing),
              'nearestStandingM': None if standing is None or float(standing) > max(DISTANCES) else float(standing)}
        names = {}
        for identifier, name in self.con.execute("""
            SELECT DISTINCT c.id, f.name FROM corridor c, hydro f, (VALUES (1000)) AS d(distance_m)
            WHERE f.name <> '' AND c.pad_min_lon <= f.max_lon AND c.pad_max_lon >= f.min_lon
              AND c.pad_min_lat <= f.max_lat AND c.pad_max_lat >= f.min_lat
              AND ST_Intersects(f.geom, ST_Buffer(c.geom, d.distance_m)) ORDER BY c.id, f.name""").fetchall():
            names.setdefault(identifier, []).append(name)
        output = {}
        for identifier in set(list(buffers) + list(crossings) + list(proximity) + list(names)):
            output[identifier] = {'buffers': buffers.get(identifier, {}), 'crossings': crossings.get(identifier, []),
              'names': names.get(identifier, []), **proximity.get(identifier, {'nearestFlowingM': None, 'nearestStandingM': None})}
        return output

    def ecology_metrics(self):
        output = {}
        for level in (3, 4):
            rows = self.con.execute(f"""
              WITH pieces AS (
                SELECT c.id AS id, e.code AS code, e.name AS name,
                       ST_Length(ST_Intersection(ST_Transform(e.geometry, 'EPSG:4326', 'EPSG:5070', always_xy := true), c.geom)) AS overlap_m
                FROM eco e, corridor c
                WHERE e.level = {level}
                  AND c.min_lon <= e.max_lon AND c.max_lon >= e.min_lon
                  AND c.min_lat <= e.max_lat AND c.max_lat >= e.min_lat AND ST_Intersects(e.geometry, c.geom_4326)
              )
              SELECT id, code, name, SUM(overlap_m) AS overlap_m FROM pieces
              WHERE overlap_m > 0 GROUP BY id, code, name ORDER BY id, SUM(overlap_m) DESC, code""").fetchall()
            for identifier, code, name, overlap in rows:
                output.setdefault(identifier, {}).setdefault(level, []).append({'code': str(code), 'name': str(name), 'overlapM': float(overlap)})
        return output

    def coverage_metrics(self):
        bounds = self.catalog['region']['bounds']
        polygon = (f"POLYGON(({bounds[0]} {bounds[1]}, {bounds[2]} {bounds[1]}, {bounds[2]} {bounds[3]}, "
                   f"{bounds[0]} {bounds[3]}, {bounds[0]} {bounds[1]}))")
        rows = self.con.execute(f"""
          WITH d(distance_m) AS (VALUES (250), (500), (1000)),
          extent AS (SELECT ST_Transform(ST_GeomFromText('{polygon}'), 'EPSG:4326', 'EPSG:5070', always_xy := true) AS w)
          SELECT c.id AS id, d.distance_m AS distance_m,
                 ST_Contains((SELECT w FROM extent), ST_Buffer(c.geom, d.distance_m)) AS covered,
                 ST_Intersects((SELECT w FROM extent), c.geom) AS corridor_inside
          FROM corridor c, d ORDER BY c.id, d.distance_m""").fetchall()
        output = {}
        for identifier, distance, covered, corridor_inside in rows:
            entry = output.setdefault(identifier, {})
            entry[int(distance)] = {'covered': bool(covered), 'corridorInside': bool(corridor_inside)}
        return output

    # ------------------------------------------------------------------ rows
    def derived_rows(self, corridors):
        wetlands = self.wetland_metrics()
        hydro = self.hydro_metrics()
        ecology = self.ecology_metrics()
        coverage = self.coverage_metrics()
        lengths = self.route_lengths()
        rows = []
        for corridor in corridors:
            identifier = corridor['id']
            canal = self.analytical[identifier]
            wetland = wetlands.get(identifier, {'buffers': {}, 'classes': {}, 'corridorFeatures': 0, 'nearestM': None})
            water = hydro.get(identifier, {'buffers': {}, 'crossings': [], 'names': [], 'nearestFlowingM': None, 'nearestStandingM': None})
            distance_states = self.buffer_states(coverage.get(identifier, {}))
            ecology_entry = self.ecology_entry(ecology.get(identifier, {}), lengths.get(identifier, corridor['lengthM']))
            buffers = {distance: wetland['buffers'].get(distance, {'areaM2': 0.0, 'featureCount': 0}) for distance in DISTANCES}
            hydro_buffers = {distance: water['buffers'].get(distance, {'flowlineLengthM': 0.0, 'waterbodyAreaM2': 0.0, 'featureCount': 0})
                             for distance in DISTANCES}
            classes = sorted(wetland['classes'].items(), key=lambda item: (-item[1]['areaM2'], item[0][0]))[:5]
            rows.append({
                'corridor_id': identifier, 'road_component_id': corridor['componentId'], 'road_unit_id': corridor['unitId'],
                'name': corridor['name'], 'normalized_name': corridor['nameKey'],
                'geometry': wkb.dumps(shape(corridor['geometry'])), 'bounds': [float(value) for value in corridor['bounds']],
                'length_m': float(corridor['lengthM']), 'tiger_class': corridor['roadClasses'][0] if len(corridor['roadClasses']) == 1 else None,
                'counties': [str(value) for value in corridor['counties']],
                'county_names': [str(value) for value in corridor['countyNames']],
                'road_ids': [str(value) for value in corridor['roadIds']],
                'road_classes': [str(value) for value in corridor['roadClasses']],
                'source_feature_ids': [str(value) for value in corridor['sourceFeatureIds']],
                'segment_index': int(corridor['segmentIndex']), 'segment_count': int(corridor['segmentCount']),
                'geometry_repaired': bool(canal['repaired']), 'geometry_repair_method': canal['method'],
                'primary_l3_code': None if not ecology_entry['l3'] else ecology_entry['l3']['primary']['code'],
                'primary_l3_name': None if not ecology_entry['l3'] else ecology_entry['l3']['primary']['name'],
                'primary_l3_percent': None if not ecology_entry['l3'] else ecology_entry['l3']['primary']['percent'],
                'primary_l4_code': None if not ecology_entry['l4'] else ecology_entry['l4']['primary']['code'],
                'primary_l4_name': None if not ecology_entry['l4'] else ecology_entry['l4']['primary']['name'],
                'primary_l4_percent': None if not ecology_entry['l4'] else ecology_entry['l4']['primary']['percent'],
                'l3_count': 0 if not ecology_entry['l3'] else len(ecology_entry['l3']['intersections']),
                'l4_count': 0 if not ecology_entry['l4'] else len(ecology_entry['l4']['intersections']),
                'transition_count': self.transition_count(ecology_entry),
                'ecology_coverage': ecology_entry['coverage'],
                'wetland_intersects': bool(wetland['corridorFeatures'] > 0), 'wetland_nearest_m': wetland['nearestM'],
                'wetland_area_250_m2': round(buffers[250]['areaM2'], 3), 'wetland_area_500_m2': round(buffers[500]['areaM2'], 3),
                'wetland_area_1000_m2': round(buffers[1000]['areaM2'], 3),
                'wetland_count_250': int(buffers[250]['featureCount']), 'wetland_count_500': int(buffers[500]['featureCount']),
                'wetland_count_1000': int(buffers[1000]['featureCount']),
                'wetland_type_summary': ' | '.join(f"{label} {round(entry['areaM2'])}" for (label, _code), entry in classes) or None,
                'hydro_crossing_count': len(water['crossings']), 'hydro_nearest_flowing_m': water['nearestFlowingM'],
                'hydro_nearest_standing_m': water['nearestStandingM'],
                'hydro_flowline_length_1000_m': round(hydro_buffers[1000]['flowlineLengthM'], 3),
                'hydro_waterbody_area_1000_m2': round(hydro_buffers[1000]['waterbodyAreaM2'], 3),
                'hydro_summary': ' | '.join(water['names'][:5]) or None,
                'coverage': distance_states['overall'],
                'coverage_wetlands_250': distance_states['states'][250]['wetlands'], 'coverage_wetlands_500': distance_states['states'][500]['wetlands'],
                'coverage_wetlands_1000': distance_states['states'][1000]['wetlands'],
                'coverage_hydro_250': distance_states['states'][250]['hydro'], 'coverage_hydro_500': distance_states['states'][500]['hydro'],
                'coverage_hydro_1000': distance_states['states'][1000]['hydro'],
                'analysis_fingerprint': self.fingerprint, 'road_length_m': float(lengths.get(identifier, corridor['lengthM'])),
            })
        return rows

    def buffer_states(self, coverage):
        """The runtime's per-distance coverage rule: FULL when every requested buffer is covered, NONE when
        none is, PARTIAL in between, and each distance reports its own state the same way."""
        covered = {distance: bool(coverage.get(distance, {}).get('covered')) for distance in DISTANCES}
        covered_count = sum(1 for value in covered.values() if value)
        overall = 'FULL' if covered_count == len(DISTANCES) else 'NONE' if covered_count == 0 else 'PARTIAL'
        states = {}
        for distance in DISTANCES:
            state = 'FULL' if covered[distance] else ('NONE' if overall == 'NONE' else 'PARTIAL')
            states[distance] = {'wetlands': state, 'hydro': state}
        return {'overall': overall, 'states': states, 'covered': covered}

    def ecology_entry(self, levels, route_length_m):
        """summarizeLevel/combineCoverage from src/gis/ecoregion-result.js, mirrored: intersections sorted by
        overlap, percent against the projected route length, coverage FULL at 99.5% of the route."""
        def level(entries):
            intersections = sorted(({'code': entry['code'], 'name': entry['name'], 'overlapM': entry['overlapM'],
                'percent': round(entry['overlapM'] / route_length_m * 1000) / 10 if route_length_m else 0.0}
                for entry in entries if entry['overlapM'] > 0), key=lambda item: (-item['overlapM'], item['code']))
            measured = sum(item['overlapM'] for item in intersections)
            if measured <= 0: coverage = 'NONE'
            elif route_length_m and measured / route_length_m >= 0.995: coverage = 'FULL'
            else: coverage = 'PARTIAL'
            return {'primary': intersections[0] if intersections else None, 'intersections': intersections,
                    'measuredM': measured, 'coverage': coverage}
        l3 = level(levels.get(3, []))
        l4 = level(levels.get(4, []))
        states = {l3['coverage'], l4['coverage']}
        if states == {'FULL'}: coverage = 'FULL'
        elif states == {'NONE'}: coverage = 'NONE'
        else: coverage = 'PARTIAL'
        return {'l3': l3, 'l4': l4, 'coverage': coverage}

    def transition_count(self, entry):
        return (max(0, len(entry['l3']['intersections']) - 1) if entry['l3'] else 0) \
             + (max(0, len(entry['l4']['intersections']) - 1) if entry['l4'] else 0)

    # ------------------------------------------------------------------ write
    def write_derived(self, rows, corridors, out_dir, report):
        out_dir.mkdir(parents=True, exist_ok=True)
        bounds = self.build_bounds or self.catalog['region']['bounds']
        cells = list(cells_for(bounds))
        membership = {cell_id: [] for cell_id, _bounds in cells}
        for row in rows:
            geometry = wkb.loads(row['geometry'])
            for cell_id, bounds in cells:
                window = box(*bounds)
                if geometry.intersects(window):
                    membership[cell_id].append(row)
        stamp = time.time()
        entries = []
        for cell_id, bounds in cells:
            members = membership[cell_id]
            entry = {'id': cell_id, 'bounds': bounds, 'state': 'present' if members else 'empty', 'rowCount': len(members)}
            if members:
                path = out_dir / 'cells' / f'{cell_id}.parquet'
                path.parent.mkdir(parents=True, exist_ok=True)
                columns = {key: [member[key] for member in members] for key in members[0]}
                table = pa.table(columns)
                path.unlink(missing_ok=True)
                pq.write_table(table, path, compression='zstd')
                reread = pq.read_table(path)
                if reread.num_rows != len(members):
                    raise ValueError(f'{cell_id}: GeoParquet round-trip failed')
                entry.update({'url': f"derived/corridor-metrics/{self.fingerprint}/cells/{cell_id}.parquet",
                              'bytes': path.stat().st_size, 'sha256': sha256_of(path)})
            entries.append(entry)
        report['writeMs'] = round((time.time() - stamp) * 1000)
        total_rows = sum(entry['rowCount'] for entry in entries)
        total_bytes = sum(entry.get('bytes', 0) for entry in entries)
        manifest = {'schemaVersion': 1, 'kind': 'road-derived-corridor-metrics',
          'analysisFingerprint': self.fingerprint, 'derivedSchemaVersion': self.profile['derivedSchemaVersion'],
          'profileVersion': self.profile['profileVersion'],
          'region': {'id': self.catalog['region']['id'], 'version': self.catalog['version'],
            'bounds': list(bounds), 'publishedBounds': list(self.catalog['region']['bounds']),
            'bounded': bool(self.build_bounds)},
          'grid': self.catalog['grid'], 'assetBaseUrl': self.catalog['assetBaseUrl'],
          'schema': list(rows[0].keys()) if rows else [],
          'semantics': {**self.expressions['definition'], 'coverage': 'per distance against the published source-window extent',
            'replication': 'whole derived row replicated into every 0.2 degree cell its geometry intersects'},
          'counts': {'corridors': len(rows), 'storedRows': total_rows, 'replicatedRows': total_rows - len(rows),
            'cells': len(cells), 'presentCells': sum(1 for entry in entries if entry['state'] == 'present'),
            'emptyCells': sum(1 for entry in entries if entry['state'] == 'empty'), 'bytes': total_bytes,
            'averageRowBytes': round(total_bytes / total_rows, 1) if total_rows else 0},
          'cells': entries,
          'provenance': {'regionVersion': self.catalog['version'], 'roadDatasetVersion': self.datasets['roads']['version'],
            'wetlandDatasetVersion': self.datasets['wetlands']['version'],
            'hydroDatasetVersion': self.datasets['hydrography']['version'],
            'roadComponentsSha256': self.catalog.get('roadComponentsSha256'), 'profile': self.profile},
          'build': {'pipelineVersion': 'derived-corridor-metrics-v1', 'corridors': len(corridors), 'report': report}}
        manifest_path = out_dir / 'manifest.json'
        manifest_path.write_text(json.dumps(manifest, indent=1) + '\n')
        report['manifestBytes'] = manifest_path.stat().st_size
        return manifest_path, manifest

    def repair_corridors(self, corridors, failing):
        """Run the shared repair ladder for the corridors the engine refuses, and probe its candidates with the
        same buffering the runtime probes with. A corridor with no usable candidate keeps its canonical geometry
        and is reported as unbufferable, exactly as the batch reports it."""
        by_id = {corridor['id']: corridor for corridor in corridors}
        request_path = WORK / 'repair-request.json'
        output_path = WORK / 'repair-candidates.json'
        request_path.write_text(json.dumps([{'id': identifier, 'geometry': by_id[identifier]['geometry']} for identifier in failing]))
        summary = json.loads(run_node([str(ROOT / 'scripts/compose-derived-corridors.mjs'), 'repair-candidates',
                                       str(request_path), str(output_path)]))
        candidates = json.loads(output_path.read_text())
        repaired, unusable = 0, []
        for entry in candidates:
            chosen = None
            for candidate in entry['candidates']:
                if not candidate['accepted']:
                    continue
                try:
                    self.probe_geometry([entry['id']], [candidate['wkt']])
                    chosen = candidate
                    break
                except duckdb.Error:
                    continue
            if chosen is None:
                unusable.append(entry['id'])
                continue
            self.analytical[entry['id']] = {'wkt': chosen['wkt'], 'method': chosen['method'], 'repaired': True,
              'metrics': chosen['metrics'], 'repairs': chosen['repairs']}
            repaired += 1
        return {'ladder': summary, 'repaired': repaired, 'unusable': unusable}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--region', default='or-sw-wa-portland-v2')
    parser.add_argument('--refresh', action='store_true', help='re-export source features and recompose corridors')
    parser.add_argument('--bbox', default=None, help='build only the corridors intersecting this box (min_lon,min_lat,max_lon,max_lat)')
    args = parser.parse_args()
    started = time.time()
    report = {'phasesMs': {}}
    catalog = json.loads((ROOT / 'data/regional/manifest.json').read_text())
    if catalog['version'] != args.region:
        raise SystemExit(f"catalog is {catalog['version']}, not {args.region}")
    profile = json.loads((ROOT / 'data/regional/analysis-profile.json').read_text())
    builder = Builder(catalog, profile, args.region)
    builder.analytical = {}
    out_dir = ROOT / 'data/regional/derived' / profile['fingerprint']
    log(f'derived build: {args.region} fingerprint {profile["fingerprint"]}')

    roads = builder.datasets['roads']
    road_files = builder.files('roads')
    feature_ndjson = WORK / 'features.ndjson'
    corridor_ndjson = WORK / 'corridors.ndjson'
    WORK.mkdir(parents=True, exist_ok=True)
    if args.refresh or not corridor_ndjson.exists():
        stamp = time.time()
        builder.con.execute(f"""COPY (
          SELECT road_id, name, road_class, route_type, county_fips, county_name, source_feature_id, part,
                 ST_AsGeoJSON(geometry) AS geometry_json
          FROM (SELECT *, row_number() OVER (PARTITION BY county_fips, source_feature_id, part) AS rn
                FROM read_parquet({road_files!r})) WHERE rn = 1
        ) TO '{feature_ndjson}' (FORMAT JSON, ARRAY false)""")
        report['phasesMs']['export'] = round((time.time() - stamp) * 1000)
        stamp = time.time()
        report['compose'] = json.loads(run_node([str(ROOT / 'scripts/compose-derived-corridors.mjs'), 'compose',
          str(feature_ndjson), str(corridor_ndjson)]))
        report['phasesMs']['compose'] = round((time.time() - stamp) * 1000)
        log('composition: ' + json.dumps(report['compose']))
    corridors = [json.loads(line) for line in corridor_ndjson.read_text().split('\n') if line.strip()]
    corridors.sort(key=lambda item: item['id'])
    if args.bbox:
        builder.build_bounds = [float(value) for value in args.bbox.split(',')]
        box_bounds = builder.build_bounds
        corridors = [corridor for corridor in corridors
                     if corridor['bounds'][0] <= box_bounds[2] and corridor['bounds'][2] >= box_bounds[0]
                     and corridor['bounds'][1] <= box_bounds[3] and corridor['bounds'][3] >= box_bounds[1]]
        log(f"bounded to {builder.build_bounds}: {len(corridors)} corridors")

    stamp = time.time()
    # Analytical geometry: probe the canonical corridors the way the runtime does, run the shared repair ladder
    # for the ones the engine refuses, and keep the accepted repair (or report the corridor as unbufferable).
    for corridor in corridors:
        builder.analytical[corridor['id']] = {'wkt': wkt_of(corridor['geometry']), 'method': 'none', 'repaired': False}
    failing = builder.failing([(corridor['id'], builder.analytical[corridor['id']]['wkt']) for corridor in corridors])
    report['probe'] = {'corridors': len(corridors), 'refused': len(failing)}
    log(f'canonical probe: {len(failing)} of {len(corridors)} corridors need the repair ladder')
    if failing:
        report['repair'] = builder.repair_corridors(corridors, failing)
        log('repair: ' + json.dumps(report['repair']))
    builder.load_corridors(corridors, builder.analytical)
    report['phasesMs']['analytical'] = round((time.time() - stamp) * 1000)

    stamp = time.time()
    builder.prepare_habitat()
    report['phasesMs']['prepare'] = round((time.time() - stamp) * 1000)
    stamp = time.time()
    # Corridors are measured in spatial chunks: the metric statements are the batch's own, and a chunk only
    # narrows the relations they read to the chunk's padded box, so the work stays proportional to the search
    # each corridor really implies instead of a whole-window cross join.
    ordered = sorted(corridors, key=lambda item: (math.floor(item['bounds'][0] / STEP), math.floor(item['bounds'][1] / STEP), item['id']))
    chunk_size = 400
    rows = []
    chunks = 0
    for start in range(0, len(ordered), chunk_size):
        chunk = ordered[start:start + chunk_size]
        chunk_bounds = [min(item['bounds'][0] for item in chunk), min(item['bounds'][1] for item in chunk),
                        max(item['bounds'][2] for item in chunk), max(item['bounds'][3] for item in chunk)]
        builder.set_chunk([item['id'] for item in chunk], chunk_bounds)
        rows.extend(builder.derived_rows(chunk))
        chunks += 1
        if chunks % 10 == 0:
            log(f'  measured {len(rows)} of {len(corridors)} corridors in {chunks} chunks')
    report['chunks'] = chunks
    report['phasesMs']['metrics'] = round((time.time() - stamp) * 1000)
    log(f'{len(rows)} derived rows')
    stamp = time.time()
    manifest_path, manifest = builder.write_derived(rows, corridors, out_dir, report)
    report['phasesMs']['write'] = round((time.time() - stamp) * 1000)
    report['phasesMs']['total'] = round((time.time() - started) * 1000)

    published = json.loads((ROOT / 'data/regional/manifest.json').read_text())
    published['derived'] = {'manifestUrl': f'derived/corridor-metrics/{profile["fingerprint"]}/manifest.json',
      'localPath': str(manifest_path.relative_to(ROOT / 'data')),
      'analysisFingerprint': profile['fingerprint'], 'derivedSchemaVersion': profile['derivedSchemaVersion'],
      'bounds': list(manifest['region']['bounds']), 'bounded': manifest['region']['bounded'],
      'corridors': manifest['counts']['corridors'], 'bytes': manifest['counts']['bytes'],
      'cells': manifest['counts']['cells'], 'presentCells': manifest['counts']['presentCells'],
      'emptyCells': manifest['counts']['emptyCells'], 'manifestSha256': sha256_of(manifest_path)}
    (ROOT / 'data/regional/manifest.json').write_text(json.dumps(published, indent=1) + '\n')
    (ROOT / 'data/regional/build-derived-' + args.region + '.json').write_text(json.dumps(report, indent=1) + '\n')
    log('derived build report: ' + json.dumps(report))
    log(f"manifest: {manifest_path} ({manifest_path.stat().st_size:,} bytes)")


if __name__ == '__main__':
    main()
