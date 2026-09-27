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
import os
import subprocess
import sys
import time
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pyproj import CRS
from shapely import wkb
from shapely.geometry import box, shape

ROOT = Path(__file__).resolve().parents[1]
STEP = 0.2
METRES_PER_DEGREE_LAT = 110000.0
METRES_PER_DEGREE_LON = 111320.0
PAD_MARGIN = 1.1
DISTANCES = (250, 500, 1000)
# The published layout is `derived/corridor-metrics/<fingerprint>/...` on the R2 data plane and, because the
# runtime resolves a catalog url against `data/`, `data/derived/corridor-metrics/<fingerprint>/...` locally. The
# two are the same relative path, so a local run reads exactly the objects production reads.
PUBLISHED_PREFIX = 'derived/corridor-metrics'
CORRIDOR_GEOMETRY_TYPES = ['LineString', 'MultiLineString']
# Scratch space for the exported features, the composed corridors, and DuckDB's spill files. Every entry is
# derived from committed inputs, so losing it (a reboot clears /tmp) costs a recomposition, never correctness.
WORK = Path(os.environ.get('DERIVED_WORK', '/tmp/roadnaturalist-derived'))


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


def habitat_expressions():
    """The shared habitat metric expressions, exported from src/gis/habitat-metrics.js by the composition module.

    They are regenerated for every build instead of being read from a cached file: the offline statements must
    be the runtime's own definition at the moment the artifacts are built, so a scratch directory that survived
    a source change can never become a second definition.
    """
    WORK.mkdir(parents=True, exist_ok=True)
    path = WORK / 'habitat-sql.json'
    path.unlink(missing_ok=True)
    run_node([str(ROOT / 'scripts/compose-derived-corridors.mjs'), 'sql', str(path)])
    return json.loads(path.read_text())


def write_cell_geoparquet(rows, path):
    """Write one derived cell as GeoParquet and prove DuckDB Spatial reads it back as geometry.

    A plain WKB column named `geometry` is only a BLOB: DuckDB will refuse `ST_XMin`/`ST_AsGeoJSON` on it, and
    the runtime reads the cells with exactly those functions. The GeoParquet `geo` metadata is what makes the
    column a typed EPSG:4326 GEOMETRY, so the write is verified with the same reader the browser uses rather
    than trusting the writer.
    """
    columns = {key: [member[key] for member in rows] for key in rows[0]}
    # A derived row carries its geometry as WKB bytes (the shape the corridor module produced), so the type set
    # is read back from that encoding rather than re-encoding it.
    geometry_types = sorted({wkb.loads(value).geom_type for value in columns['geometry']})
    unknown = sorted(set(geometry_types) - set(CORRIDOR_GEOMETRY_TYPES))
    if unknown:
        raise ValueError(f'{path.name}: unsupported corridor geometry {unknown}')
    bounds = columns['bounds']
    table = pa.table(columns)
    geo = {'version': '1.1.0', 'primary_column': 'geometry', 'columns': {'geometry': {
        'encoding': 'WKB', 'geometry_types': geometry_types, 'crs': CRS.from_epsg(4326).to_json_dict(),
        'bbox': [min(value[0] for value in bounds), min(value[1] for value in bounds),
                 max(value[2] for value in bounds), max(value[3] for value in bounds)]}}}
    table = table.replace_schema_metadata({b'geo': json.dumps(geo, separators=(',', ':')).encode()})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    pq.write_table(table, path, compression='zstd')
    reread = pq.read_table(path)
    if reread.num_rows != len(rows) or b'geo' not in reread.schema.metadata:
        raise ValueError(f'{path.name}: GeoParquet round-trip failed')
    if any(value is None for value in reread.column('geometry').to_pylist()):
        raise ValueError(f'{path.name}: GeoParquet contains null geometry')
    connection = duckdb.connect()
    connection.execute('INSTALL spatial; LOAD spatial;')
    total, linears, invalid, srid = connection.execute(
        "SELECT count(*), count(*) FILTER (WHERE ST_GeometryType(geometry) IN ('LINESTRING', 'MULTILINESTRING')), "
        "count(*) FILTER (WHERE NOT ST_IsValid(geometry)), any_value(ST_CRS(geometry)) FROM read_parquet(?)",
        [str(path)]).fetchone()
    if total != len(rows) or linears != len(rows) or invalid or srid != 'EPSG:4326':
        raise ValueError(f'{path.name}: DuckDB read-back failed (rows={total}, lines={linears}, '
                         f'invalid={invalid}, srid={srid})')
    connection.close()
    return {'featureCount': int(total), 'geometryTypes': geometry_types}


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
        WORK.mkdir(parents=True, exist_ok=True)
        self.con = duckdb.connect()
        self.con.execute('INSTALL spatial; LOAD spatial')
        # The habitat layers are far larger than the process can hold, so DuckDB is given a ceiling and spills
        # into the build's own scratch directory instead of being killed by the machine mid-build.
        self.con.execute("PRAGMA memory_limit='2GB'")
        self.con.execute("PRAGMA threads=2")
        self.con.execute("SET temp_directory='" + str(WORK / 'duckdb') + "'")
        # Row order is imposed on every written artifact by an explicit sort, so DuckDB is free to stream
        # instead of materialising insertion order.
        self.con.execute('PRAGMA preserve_insertion_order=false')
        self.expressions = habitat_expressions()
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
        """There is no whole-window relation to read: every metric is measured on a chunk. This drops what a
        previous chunk left behind, so a query can never silently read a stale neighbourhood."""
        for name in ('wetland', 'hydro', 'eco'):
            self.con.execute(f'DROP VIEW IF EXISTS {name}')
            self.con.execute(f'DROP TABLE IF EXISTS {name}')

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
        # The requested buffers, materialised once for every corridor in the chunk: the same operation the
        # runtime batch performs in prepareBuffers (src/gis/discovery-query.js), and the reason its metric
        # statements clip against `b.geom` instead of recomputing a buffer per feature pair.
        distances = ', '.join(f'({int(value)})' for value in self.expressions['definition']['distancesM'])
        self.con.execute('CREATE OR REPLACE TEMP TABLE buffer AS SELECT c.id AS id, d.distance_m AS distance_m, '
                         'ST_Buffer(c.geom, d.distance_m) AS geom FROM corridor c, '
                         f'(VALUES {distances}) AS d(distance_m)')

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
        """Ask the engine for the buffers the runtime asks for: the runtime probes every requested distance in
        one statement (src/gis/analytical-geometry.js probeStoredGeometry), so the offline probe must ask for
        the same set. Probing only the widest distance calls a corridor usable that the batch would repair."""
        self.con.register('probe_input', pa.table({'id': ids, 'wkt': wkts}))
        self.con.execute("CREATE OR REPLACE TEMP TABLE probe AS SELECT id, "
                         "ST_Transform(ST_GeomFromText(wkt), 'EPSG:4326', 'EPSG:5070', always_xy := true) AS geom FROM probe_input")
        buffers = ', '.join(f'ST_Buffer(geom, {int(value)})' for value in self.expressions['definition']['distancesM'])
        self.con.execute(f'SELECT count(*) FROM (SELECT {buffers} FROM probe)')

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
          WITH hit AS (
            SELECT b.id AS id, b.distance_m AS distance_m, w.wetland_type AS label, w.attribute AS code,
                   w.source_feature_id AS source_feature_id, {self.expressions['wetlandAreaBuffered']} AS area_m2
            FROM buffer b JOIN corridor c ON c.id = b.id, wetland w
            WHERE c.pad_min_lon <= w.max_lon AND c.pad_max_lon >= w.min_lon
              AND c.pad_min_lat <= w.max_lat AND c.pad_max_lat >= w.min_lat
              AND ST_Intersects(w.geom, b.geom)
          )
          SELECT id, distance_m, label, code, {self.expressions['wetlandCountBuffered']} AS feature_count, sum(area_m2) AS area_m2
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
          WITH hit AS (
            SELECT b.id AS id, b.distance_m AS distance_m, f.layer AS layer, f.source_feature_id AS source_feature_id,
                   {self.expressions['hydroLengthBuffered']} AS length_m, {self.expressions['hydroAreaBuffered']} AS area_m2
            FROM buffer b JOIN corridor c ON c.id = b.id, hydro f
            WHERE c.pad_min_lon <= f.max_lon AND c.pad_max_lon >= f.min_lon
              AND c.pad_min_lat <= f.max_lat AND c.pad_max_lat >= f.min_lat
              AND ST_Intersects(f.geom, b.geom)
          )
          SELECT id, distance_m, layer, {self.expressions['hydroCountBuffered']} AS feature_count,
                 sum(area_m2) AS area_m2, sum(length_m) AS length_m
          FROM hit WHERE length_m > 0 OR area_m2 > 0
          GROUP BY id, distance_m, layer ORDER BY id, distance_m, layer
        """).fetchall()
        buffers = {}
        for identifier, distance, layer, feature_count, area, length in rows:
            entry = buffers.setdefault(identifier, {})
            bucket = entry.setdefault(int(distance), {'flowlineLengthM': 0.0, 'waterbodyAreaM2': 0.0, 'featureCount': 0})
            bucket['featureCount'] += int(feature_count)
            bucket['flowlineLengthM'] += float(length or 0.0)
            bucket['waterbodyAreaM2'] += float(area or 0.0)
        crossings = {}
        for identifier, source_id, name, label, overlap in self.con.execute(f"""
            SELECT c.id, f.source_feature_id, f.name, f.feature_type_label, {self.expressions['hydroCrossing']} AS overlap_m
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
            SELECT DISTINCT b.id, f.name FROM hydro f, buffer b JOIN corridor c ON c.id = b.id
            WHERE f.name <> '' AND b.distance_m = 1000 AND c.pad_min_lon <= f.max_lon AND c.pad_max_lon >= f.min_lon
              AND c.pad_min_lat <= f.max_lat AND c.pad_max_lat >= f.min_lat
              AND ST_Intersects(f.geom, b.geom) ORDER BY b.id, f.name""").fetchall():
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
        # The established coverage rule (src/gis/habitat-metrics.js coverageExpressions): a requested buffer is
        # covered when the published extent contains it, and the corridor itself is inside the extent when it
        # intersects. The buffer is the chunk's materialised one, so the rule is stated once per distance.
        rows = self.con.execute(f"""
          WITH extent AS (SELECT ST_Transform(ST_GeomFromText('{polygon}'), 'EPSG:4326', 'EPSG:5070', always_xy := true) AS w)
          SELECT b.id AS id, b.distance_m AS distance_m,
                 ST_Contains((SELECT w FROM extent), b.geom) AS covered,
                 ST_Intersects((SELECT w FROM extent), c.geom) AS corridor_inside
          FROM buffer b JOIN corridor c ON c.id = b.id ORDER BY b.id, b.distance_m""").fetchall()
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
                'hydro_summary': ' | '.join(water['names'][:40]) or None,
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
        region_bounds = self.build_bounds or self.catalog['region']['bounds']
        cells = list(cells_for(region_bounds))
        membership = {cell_id: [] for cell_id, _cell_bounds in cells}
        for row in rows:
            row_bounds = row['bounds']
            geometry = wkb.loads(row['geometry'])
            for cell_id, cell_bounds in cells:
                # A cheap bounds prefilter first: a whole corridor row is replicated into every cell its
                # geometry intersects, so most cell/row pairs are rejected before any geometry work.
                if row_bounds[0] > cell_bounds[2] or row_bounds[2] < cell_bounds[0] \
                        or row_bounds[1] > cell_bounds[3] or row_bounds[3] < cell_bounds[1]:
                    continue
                if geometry.intersects(box(*cell_bounds)):
                    membership[cell_id].append(row)
        stamp = time.time()
        base = f"{PUBLISHED_PREFIX}/{self.fingerprint}"
        entries = []
        geometry_types = set()
        for cell_id, cell_bounds in cells:
            members = membership[cell_id]
            entry = {'id': cell_id, 'bounds': cell_bounds, 'state': 'present' if members else 'empty', 'rowCount': len(members)}
            if members:
                path = out_dir / 'cells' / f'{cell_id}.parquet'
                written = write_cell_geoparquet(members, path)
                geometry_types.update(written['geometryTypes'])
                entry.update({'url': f"{base}/cells/{cell_id}.parquet",
                              'bytes': path.stat().st_size, 'sha256': sha256_of(path)})
            entries.append(entry)
        report['writeMs'] = round((time.time() - stamp) * 1000)
        total_rows = sum(entry['rowCount'] for entry in entries)
        total_bytes = sum(entry.get('bytes', 0) for entry in entries)
        manifest = {'schemaVersion': 1, 'kind': 'road-derived-corridor-metrics',
          'analysisFingerprint': self.fingerprint, 'derivedSchemaVersion': self.profile['derivedSchemaVersion'],
          'profileVersion': self.profile['profileVersion'],
          'region': {'id': self.catalog['region']['id'], 'version': self.catalog['version'],
            'bounds': list(region_bounds), 'publishedBounds': list(self.catalog['region']['bounds']),
            'bounded': bool(self.build_bounds)},
          'grid': self.catalog['grid'], 'assetBaseUrl': self.catalog['assetBaseUrl'],
          'geometry': {'encoding': 'WKB', 'crs': 'EPSG:4326', 'geometryTypes': sorted(geometry_types),
            'primaryColumn': 'geometry', 'partition': 'whole corridor rows replicated; geometry never clipped',
            'repair': 'canonical geometry first, else the shared point-preserving repair ladder'},
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

    def prepare_analysis_geometry(self, corridors, failing):
        """Decide the analysis geometry for every corridor with the shared repair ladder.

        Two rules, both taken from what the runtime actually does:

        * `remove-duplicate-segments` (the ladder's first rung) applies whenever the canonical geometry really
          contains duplicate segments. A TIGER part that repeats a segment makes the corridor measure its own
          length twice, so the line the metrics describe must not depend on which engine happens to buffer the
          doubled form; the runtime boundary removes a doubled traversal before probing for every reader
          (src/gis/analytical-geometry.js), and this build does the same. Measured on the equivalence sample the
          doubled length was up to 43% too long, which moves every corridor-length-based metric (ecology
          percentages) and every corridor-line intersection (hydrography crossings).
        * the shared engine probe decides the rest, and it is asked from the de-duplicated line onwards: a
          corridor the engine refuses pays for the ladder, a corridor it accepts is used as it is.
        """
        request_path = WORK / 'repair-request.json'
        output_path = WORK / 'repair-candidates.json'
        request_path.write_text(json.dumps([{'id': corridor['id'], 'geometry': corridor['geometry']} for corridor in corridors]))
        summary = json.loads(run_node([str(ROOT / 'scripts/compose-derived-corridors.mjs'), 'repair-candidates',
                                       str(request_path), str(output_path)]))
        refused = set(failing)
        gated, duplicates, unusable = 0, 0, []
        for entry in json.loads(output_path.read_text()):
            candidates = [candidate for candidate in entry['candidates'] if candidate['accepted']]
            doubled = next((candidate for candidate in candidates if candidate['repairs'].get('removedSegmentCount')), None)
            if doubled is None and entry['id'] not in refused:
                continue
            chosen = None
            for candidate in candidates:
                try:
                    self.probe_geometry([entry['id']], [candidate['wkt']])
                    chosen = candidate
                    break
                except duckdb.Error:
                    continue
            if chosen is None:
                unusable.append(entry['id'])
                continue
            gated += 1
            if chosen['repairs'].get('removedSegmentCount'):
                duplicates += 1
            self.analytical[entry['id']] = {'wkt': chosen['wkt'], 'method': chosen['method'], 'repaired': True,
              'metrics': chosen['metrics'], 'repairs': chosen['repairs']}
        return {'ladder': summary, 'gatedCorridors': gated, 'duplicateRepairs': duplicates, 'unusable': unusable}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--region', default='or-sw-wa-portland-v2')
    parser.add_argument('--refresh', action='store_true', help='re-export source features and recompose corridors')
    parser.add_argument('--bbox', default=None, help='build only the corridors intersecting this box (min_lon,min_lat,max_lon,max_lat)')
    parser.add_argument('--no-publish-catalog', action='store_true',
                        help='write the plane without declaring it in data/regional/manifest.json (used for probes)')
    args = parser.parse_args()
    started = time.time()
    report = {'phasesMs': {}}
    catalog = json.loads((ROOT / 'data/regional/manifest.json').read_text())
    if catalog['version'] != args.region:
        raise SystemExit(f"catalog is {catalog['version']}, not {args.region}")
    profile = json.loads((ROOT / 'data/regional/analysis-profile.json').read_text())
    builder = Builder(catalog, profile, args.region)
    builder.analytical = {}
    # The local path is the published path: the runtime resolves a catalog url against data/, so the artifacts
    # a local browser reads are byte-for-byte the objects the R2 data plane serves under the same key.
    out_dir = ROOT / 'data' / PUBLISHED_PREFIX / profile['fingerprint']
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
    # Analysis geometry: probe the canonical corridors the way the runtime does, then let the shared ladder
    # decide (duplicate segments always; the other rungs when the engine refuses the line without them).
    for corridor in corridors:
        builder.analytical[corridor['id']] = {'wkt': wkt_of(corridor['geometry']), 'method': 'none', 'repaired': False}
    failing = builder.failing([(corridor['id'], builder.analytical[corridor['id']]['wkt']) for corridor in corridors])
    report['probe'] = {'corridors': len(corridors), 'refused': len(failing)}
    log(f'canonical probe: {len(failing)} of {len(corridors)} corridors are refused by the native engine')
    report['repair'] = builder.prepare_analysis_geometry(corridors, failing)
    log('analysis geometry: ' + json.dumps({key: value for key, value in report['repair'].items() if key != 'ladder'}))
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
    # Chunking is an internal batching detail: the pad proof makes a corridor's metrics identical in any chunk.
    # Keep each chunk's materialised buffers and spatial joins within the 2 GB DuckDB ceiling.
    chunk_size = 100
    rows = []
    chunks = 0
    for start in range(0, len(ordered), chunk_size):
        chunk = ordered[start:start + chunk_size]
        chunk_bounds = [min(item['bounds'][0] for item in chunk), min(item['bounds'][1] for item in chunk),
                        max(item['bounds'][2] for item in chunk), max(item['bounds'][3] for item in chunk)]
        builder.set_chunk([item['id'] for item in chunk], chunk_bounds)
        rows.extend(builder.derived_rows(chunk))
        chunks += 1
        # Log every chunk: a whole-region build is the long pole, and a build that cannot be watched cannot be
        # diagnosed when the machine is under pressure.
        log(f'  measured {len(rows)} of {len(corridors)} corridors in {chunks} chunk(s), '
            f'{time.time() - stamp:.0f} s elapsed')
    report['chunks'] = chunks
    report['phasesMs']['metrics'] = round((time.time() - stamp) * 1000)
    log(f'{len(rows)} derived rows')
    stamp = time.time()
    manifest_path, manifest = builder.write_derived(rows, corridors, out_dir, report)
    report['phasesMs']['write'] = round((time.time() - stamp) * 1000)
    report['phasesMs']['total'] = round((time.time() - started) * 1000)

    published = json.loads((ROOT / 'data/regional/manifest.json').read_text())
    if not args.no_publish_catalog:
        published['derived'] = {'manifestUrl': f'{PUBLISHED_PREFIX}/{profile["fingerprint"]}/manifest.json',
          'localPath': str(manifest_path.relative_to(ROOT / 'data')),
          'analysisFingerprint': profile['fingerprint'], 'derivedSchemaVersion': profile['derivedSchemaVersion'],
          'bounds': list(manifest['region']['bounds']), 'bounded': manifest['region']['bounded'],
          'corridors': manifest['counts']['corridors'], 'bytes': manifest['counts']['bytes'],
          'cells': manifest['counts']['cells'], 'presentCells': manifest['counts']['presentCells'],
          'emptyCells': manifest['counts']['emptyCells'], 'storedRows': manifest['counts']['storedRows'],
          'averageRowBytes': manifest['counts']['averageRowBytes'], 'manifestSha256': sha256_of(manifest_path)}
        (ROOT / 'data/regional/manifest.json').write_text(json.dumps(published, indent=2) + '\n')
        log('declared the derived plane in data/regional/manifest.json')
    report_path = ROOT / 'data/regional' / f'build-derived-{args.region}.json'
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    log('derived build report: ' + json.dumps(report))
    log(f"manifest: {manifest_path} ({manifest_path.stat().st_size:,} bytes)")


if __name__ == '__main__':
    main()
