#!/usr/bin/env python3
"""Offline structural and geometric review of the published derived corridor-metrics plane.

    npm run verify:derived [--json]

`verify-derived-equivalence.mjs` proves the derived *numbers* agree with a live raw batch. This proves the
*artifacts* are what they claim to be, with no browser and no network:

  - the manifest carries the analysis fingerprint this build implements, and the published regional catalog
    declares the plane;
  - every cell of the region grid is declared exactly once, on the anchored 0.2 degree grid;
  - every present cell's bytes and SHA-256 match the committed object, and it reads back through DuckDB
    Spatial as a typed EPSG:4326 line geometry;
  - every row carries the declared schema and the manifest's own analysis fingerprint;
  - replication is exact: the distinct corridors are the declared corridor count, the stored rows are the
    declared replicated total, and recomputing membership from each row's own geometry reproduces the cell
    it was replicated into (whole rows, never clipped);
  - coverage values are the established vocabulary, so a derived row can never invent a coverage state.

Exits nonzero on any problem.
"""
import hashlib
import json
import math
import sys
from pathlib import Path

import duckdb
from shapely.geometry import box, shape

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
STEP = 0.2
COVERAGE = {'FULL', 'PARTIAL', 'NONE', 'UNKNOWN'}
COVERAGE_COLUMNS = ['coverage', 'ecology_coverage', 'coverage_wetlands_250', 'coverage_wetlands_500',
                    'coverage_wetlands_1000', 'coverage_hydro_250', 'coverage_hydro_500', 'coverage_hydro_1000']
json_output = '--json' in sys.argv
problems = []
sections = {}


def fail(message):
    problems.append(message)


def cell_bounds(cell_id):
    """The anchored grid cell bounds an id names, or None when the id is not on the grid."""
    text = str(cell_id).lstrip('x').split('_y')
    if len(text) != 2:
        return None
    try:
        x_index, y_index = int(text[0]), int(text[1])
    except ValueError:
        return None
    return [-180 + STEP * x_index, -90 + STEP * y_index, -180 + STEP * (x_index + 1), -90 + STEP * (y_index + 1)]


def declare_manifest(manifest, declared):
    """Check the manifest's identity, fingerprint and grid coverage; returns (fingerprint, present cells)."""
    if manifest.get('kind') != 'road-derived-corridor-metrics' or manifest.get('schemaVersion') != 1:
        fail('the derived manifest is not a corridor-metrics manifest')
        return None, []
    fingerprint = manifest.get('analysisFingerprint')
    if fingerprint != profile['fingerprint']:
        fail(f'the derived manifest was built at fingerprint {fingerprint}, expected {profile["fingerprint"]}')
    if fingerprint != declared.get('analysisFingerprint'):
        fail('the catalog and the derived manifest disagree about the analysis fingerprint')
    if manifest.get('derivedSchemaVersion') != profile['derivedSchemaVersion']:
        fail('the derived manifest declares a different derived schema version than the analysis profile')
    if manifest.get('region', {}).get('bounded'):
        fail('the published derived plane is a bounded sub-build, not the published region')
    region_bounds = manifest['region']['bounds']
    # The cell set is derived exactly as the builder derives it (scripts/build-derived.py `cells_for`): the first
    # cell index is the floor of the region's minimum and the last is the ceiling of its maximum, so a region
    # bound that falls inside a cell pulls the whole cell in rather than rounding to the nearest edge.
    expected = {}
    x0, x1 = math.floor((region_bounds[0] + 180) / STEP + 1e-9), math.ceil((region_bounds[2] + 180) / STEP - 1e-9)
    y0, y1 = math.floor((region_bounds[1] + 90) / STEP + 1e-9), math.ceil((region_bounds[3] + 90) / STEP - 1e-9)
    for x in range(x0, x1):
        for y in range(y0, y1):
            expected[f'x{x}_y{y}'] = [-180 + STEP * x, -90 + STEP * y, -180 + STEP * (x + 1), -90 + STEP * (y + 1)]
    seen = {}
    for cell in manifest.get('cells', []):
        identifier = cell.get('id')
        if identifier in seen:
            fail(f'{identifier}: declared twice')
            continue
        seen[identifier] = cell
        grid = cell_bounds(identifier)
        if grid is None or any(abs(grid[index] - cell['bounds'][index]) > 1e-9 for index in range(4)):
            fail(f'{identifier}: bounds are not on the published 0.2 degree grid')
        if cell.get('state') not in ('present', 'empty'):
            fail(f"{identifier}: unknown cell state {cell.get('state')}")
        if cell.get('state') == 'empty' and (cell.get('rowCount') != 0 or 'url' in cell):
            fail(f'{identifier}: an empty cell must declare no rows and no artifact')
    missing, extra = sorted(set(expected) - set(seen)), sorted(set(seen) - set(expected))
    if missing:
        fail(f'the derived manifest does not declare {len(missing)} grid cell(s), e.g. {missing[:4]}')
    if extra:
        fail(f'the derived manifest declares {len(extra)} cell(s) outside the region grid, e.g. {extra[:4]}')
    # The declared cell count and the empty/present split are what the runtime selects against.
    present = sorted(identifier for identifier, cell in seen.items() if cell['state'] == 'present')
    for key, value in (('cells', len(seen)), ('presentCells', len(present)),
                       ('emptyCells', len(seen) - len(present))):
        if manifest['counts'].get(key) != value:
            fail(f"the manifest declares {key}={manifest['counts'].get(key)}, the cells say {value}")
    if declared.get('cells') != len(seen) or declared.get('presentCells') != len(present):
        fail('the catalog and the derived manifest disagree about cell counts')
    return fingerprint, [seen[identifier] for identifier in present]


def check_artifacts(cells, fingerprint):
    """Digest, read back, and cross-check every present cell through DuckDB Spatial."""
    paths = []
    for cell in cells:
        path = DATA / cell['url']
        if not path.exists():
            fail(f"{cell['id']}: the declared artifact {cell['url']} is missing")
            continue
        payload = path.read_bytes()
        if len(payload) != cell['bytes']:
            fail(f"{cell['id']}: declared {cell['bytes']} bytes, the file is {len(payload)}")
        elif hashlib.sha256(payload).hexdigest() != cell['sha256']:
            fail(f"{cell['id']}: SHA-256 mismatch")
        paths.append((cell, str(path)))
    if not paths:
        fail('no derived cell artifact is readable')
        return None
    connection = duckdb.connect()
    connection.execute('INSTALL spatial; LOAD spatial')
    files = [path for _cell, path in paths]
    total, distinct, linears, crs, nulls = connection.execute(
        "SELECT count(*), count(DISTINCT corridor_id), "
        "count(*) FILTER (WHERE ST_GeometryType(geometry) IN ('LINESTRING', 'MULTILINESTRING')), "
        "count(*) FILTER (WHERE ST_CRS(geometry) = 'EPSG:4326'), count(*) FILTER (WHERE geometry IS NULL) "
        'FROM read_parquet(?)', [files]).fetchone()
    if linears != total or nulls:
        fail(f'{total - linears} corridor row(s) are not line geometry and {nulls} are null')
    if crs != total:
        fail(f'{total - crs} corridor row(s) do not read back as EPSG:4326 geometry')
    return connection, paths, {'storedRows': int(total), 'corridors': int(distinct)}


def check_rows(connection, paths, manifest, fingerprint, totals):
    """The declared schema, the row fingerprint, exact replication, and the coverage vocabulary."""
    files = [path for _cell, path in paths]
    columns = {row[0] for row in connection.execute('DESCRIBE SELECT * FROM read_parquet(?)', [files]).fetchall()}
    missing = [name for name in manifest['schema'] if name not in columns]
    if missing:
        fail(f'the cells do not carry the declared schema: {missing[:6]}')
    wrong = connection.execute('SELECT count(*) FROM read_parquet(?) WHERE analysis_fingerprint <> ?',
                               [files, fingerprint]).fetchone()[0]
    if wrong:
        fail(f'{wrong} corridor row(s) carry a different analysis fingerprint than the manifest')
    unsupported = connection.execute(
        'SELECT count(*) FROM read_parquet(?) WHERE ' + ' OR '.join(
            f"{column} NOT IN ({', '.join(chr(39) + value + chr(39) for value in sorted(COVERAGE))})"
            for column in COVERAGE_COLUMNS), [files]).fetchone()[0]
    if unsupported:
        fail(f'{unsupported} corridor row(s) declare a coverage state outside the established vocabulary')
    if totals['storedRows'] != manifest['counts'].get('storedRows'):
        fail(f"the manifest declares {manifest['counts'].get('storedRows')} stored rows, the plane holds {totals['storedRows']}")
    if totals['corridors'] != manifest['counts'].get('corridors'):
        fail(f"the manifest declares {manifest['counts'].get('corridors')} corridors, the plane holds {totals['corridors']}")
    if totals['storedRows'] - totals['corridors'] != manifest['counts'].get('replicatedRows'):
        fail('the manifest replicated-row count does not match the cells')
    methods = sorted(str(row[0]) for row in connection.execute(
        'SELECT DISTINCT geometry_repair_method FROM read_parquet(?)', [files]).fetchall())
    partial = connection.execute(
        "SELECT count(DISTINCT corridor_id) FROM read_parquet(?) "
        "WHERE coverage = 'PARTIAL' OR ecology_coverage = 'PARTIAL' "
        "OR coverage_wetlands_1000 = 'PARTIAL' OR coverage_hydro_1000 = 'PARTIAL'", [files]).fetchone()[0]
    if not partial:
        fail('the committed plane contains no real PARTIAL-coverage corridor')
    sections['coverage'] = {'unsupportedRows': 0, 'partialCorridors': int(partial), 'repairMethods': methods}
    # Corridor identity is not re-derived by the plane: a row's corridor id is the id the shared segmentation
    # mints from its unit, and its component identity is that unit. A row that disagrees would promote to a
    # different corridor than the one the person selected.
    identity = connection.execute(
        "SELECT count(*) FROM read_parquet(?) WHERE corridor_id <> road_unit_id || '-s' || CAST(segment_index AS VARCHAR) "
        'OR road_component_id <> road_unit_id', [files]).fetchone()[0]
    if identity:
        fail(f'{identity} derived row(s) do not derive their corridor id from their unit and segment index')
    sections['identity'] = {'rows': totals['storedRows'] - identity}

    # Replication, recomputed from each row's own geometry. A whole derived row must be stored in every grid
    # cell its geometry intersects, so a cell that claims a row it does not reach (or a row that is missing from
    # a cell it does reach) would make cell selection an unreliable superset of the exact-disk test.
    misplaced, unreplicated = 0, 0
    grid = [(cell['id'], cell['bounds']) for cell in manifest['cells']]
    stored = {}
    geometry_of = {}
    for cell, path in paths:
        window = box(*cell['bounds'])
        for corridor_id, geometry in connection.execute(
                'SELECT corridor_id, ST_AsGeoJSON(geometry) FROM read_parquet(?)', [[path]]).fetchall():
            parsed = shape(json.loads(geometry))
            if not parsed.intersects(window):
                misplaced += 1
            stored.setdefault(corridor_id, set()).add(cell['id'])
            geometry_of[corridor_id] = parsed
    for corridor_id, cells in stored.items():
        expected = {identifier for identifier, bounds in grid if geometry_of[corridor_id].intersects(box(*bounds))}
        if expected != cells:
            unreplicated += 1
    if misplaced:
        fail(f'{misplaced} replicated row(s) sit in a cell their geometry does not intersect')
    if unreplicated:
        fail(f'{unreplicated} corridor(s) are not replicated into every grid cell their geometry intersects')
    sections['replication'] = {'replicatedRows': totals['storedRows'] - totals['corridors'],
                               'multicellCorridors': sum(1 for cells in stored.values() if len(cells) > 1)}


catalog = json.loads((DATA / 'regional/manifest.json').read_text())
profile = json.loads((DATA / 'regional/analysis-profile.json').read_text())
if not catalog.get('derived'):
    fail('data/regional/manifest.json does not declare a derived plane')
else:
    declared = catalog['derived']
    manifest_path = DATA / declared['localPath']
    if not manifest_path.exists():
        fail(f"the declared derived manifest is missing: {declared['localPath']}")
    else:
        raw = manifest_path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != declared.get('manifestSha256'):
            fail('the derived manifest digest does not match the catalog declaration')
        manifest = json.loads(raw)
        fingerprint, cells = declare_manifest(manifest, declared)
        if fingerprint and cells:
            checked = check_artifacts(cells, fingerprint)
            if checked:
                connection, paths, totals = checked
                total_bytes = sum(cell['bytes'] for cell, _path in paths)
                sections['artifacts'] = {'cells': len(paths), 'storedRows': totals['storedRows'],
                                         'corridors': totals['corridors'], 'bytes': total_bytes,
                                         'averageRowBytes': round(total_bytes / totals['storedRows'], 1)
                                         if totals['storedRows'] else 0}
                check_rows(connection, paths, manifest, fingerprint, totals)
                connection.close()

if json_output:
    print(json.dumps({'ok': not problems, 'sections': sections, 'problems': problems}, indent=1))
else:
    print('derived corridor metrics (structural)')
    if sections.get('artifacts'):
        artifacts = sections['artifacts']
        print(f"  artifacts    {artifacts['cells']} cells / {artifacts['storedRows']} rows / "
              f"{artifacts['corridors']} corridors / {artifacts['bytes']:,} bytes / {artifacts['averageRowBytes']} bytes per row")
    if sections.get('replication'):
        print(f"  replication  {sections['replication']['replicatedRows']} replicated rows, "
              f"{sections['replication']['multicellCorridors']} multi-cell corridors")
    if sections.get('coverage'):
        print(f"  coverage     {sections['coverage']['unsupportedRows']} unsupported values, "
              f"repair methods {sections['coverage']['repairMethods']}")
    for problem in problems:
        print(f'  PROBLEM  {problem}')
    print(f"FAILED ({len(problems)} problem{'s' if len(problems) != 1 else ''})" if problems else 'VALID')
sys.exit(1 if problems else 0)
