import { corridorGeometry, corridorWkt } from '../domain/geometry.js';
import { MEASURE_CRS } from './habitat-result.js';

// Corridor distances for eligible occurrence points, measured with the DuckDB Spatial engine that
// already backs every other spatial query in the app. A second geometry engine is deliberately not
// introduced.
//
// Points are supplied as strict [longitude, latitude] pairs that already passed the occurrence
// privacy rules; a non-precise record never reaches this function. Measurement happens in EPSG:5070
// metres, in one set-oriented statement, not one query per observation.

export const MAX_MEASURED_POINTS = 800;
const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;

export function createOccurrenceQueries({ initialize }) {
  async function measureCorridorDistances(corridor, points) {
    const geometry = corridorGeometry(corridor);
    const eligible = points.filter(point => IDENTIFIER.test(point.id) && Array.isArray(point.coordinates) && point.coordinates.length === 2 && point.coordinates.every(Number.isFinite));
    const measured = eligible.slice(0, MAX_MEASURED_POINTS);
    const rejected = points.length - eligible.length;
    if (!measured.length) return { distances: new Map(), measured: 0, skipped: rejected + (eligible.length - measured.length), crs: MEASURE_CRS };
    const engine = await initialize();
    const values = measured.map(point => `('${point.id}', ${point.coordinates[0]}, ${point.coordinates[1]})`).join(', ');
    const rows = (await engine.conn.query(`
      WITH road AS (SELECT ST_Transform(ST_GeomFromText('${corridorWkt(geometry.geometry)}'), 'EPSG:4326', 'EPSG:5070', always_xy := true) AS g),
           pts(id, lon, lat) AS (VALUES ${values})
      SELECT pts.id AS record_id,
             ST_Distance(ST_Transform(ST_Point(pts.lon, pts.lat), 'EPSG:4326', 'EPSG:5070', always_xy := true), (SELECT g FROM road)) AS distance_m
      FROM pts`)).toArray();
    const distances = new Map(rows.map(row => [String(row.record_id), Number(row.distance_m)]));
    return { distances, measured: measured.length, skipped: rejected + (eligible.length - measured.length), crs: MEASURE_CRS };
  }

  return { measureCorridorDistances };
}
