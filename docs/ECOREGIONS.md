# Oregon EPA ecoregion pilot

This is the first real GIS dataset in Road Naturalist. It covers the **Oregon EPA state extract**, not the nation. A corridor outside these polygons receives `NONE` after a successful query; a corridor crossing the extract edge receives `PARTIAL`. If one level resolves and the other fails, the combined result is `PARTIAL` and the failed level remains `UNKNOWN`. If neither level can establish a positive or no-coverage conclusion, the result is `UNKNOWN`.

## Authoritative source

The [EPA Region 10 download page](https://www.epa.gov/eco-research/ecoregion-download-files-state-region-10) links the [Oregon Level III ZIP](https://dmap-prod-oms-edc.s3.us-east-1.amazonaws.com/ORD/Ecoregions/or/or_eco_l3.zip) and [Oregon Level IV ZIP](https://dmap-prod-oms-edc.s3.us-east-1.amazonaws.com/ORD/Ecoregions/or/or_eco_l4.zip). EPA [Level III metadata](https://dmap-prod-oms-edc.s3.us-east-1.amazonaws.com/ORD/Ecoregions/or/or_eco_l3.htm) and [Level IV metadata](https://dmap-prod-oms-edc.s3.us-east-1.amazonaws.com/ORD/Ecoregions/or/or_eco_l4.htm) identify the agency, fields, projection, and publication date (2012-05-08). These state files are extracted from EPA's seamless national mapping. The EPA describes the Oregon map as compiled at 1:250,000 scale and cautions against treating these boundaries as suitable for individual county or finer-scale decisions. Corridor percentages are approximate contextual overlaps, especially near boundaries.

Source ZIP SHA-256 values are pinned in `scripts/build-ecoregions.py`; output digests are in `data/manifest.json`. The ZIPs are not committed. To regenerate from cached source files:

```sh
uv run --with pyshp --with shapely --with pyproj --with pyarrow --with duckdb \
  python3 scripts/build-ecoregions.py \
  --l3-archive /path/to/or_eco_l3.zip --l4-archive /path/to/or_eco_l4.zip
```

Or use `--download`, which retrieves the pinned EPA ZIPs into `/tmp/roadnaturalist-epa-sources`. No production resource is touched.

## Preparation and schema

The script validates the source ZIP SHA-256, reads EPA codes/names and polygon geometry, repairs invalid polygons when needed, transforms the source NAD83 Albers projected CRS to EPSG:4326 longitude/latitude with `always_xy`, and writes two Zstd GeoParquet files. There is no geometric simplification. Output columns are `code`, `name`, `l3_code`, `l3_name`, `min_lon`, `min_lat`, `max_lon`, `max_lat`, and WKB `geometry`, with GeoParquet `geo` metadata declaring EPSG:4326. It validates nonempty features/codes, geometry validity, a PyArrow read-back, and a DuckDB Parquet read-back. The manifest records feature counts, byte lengths, SHA-256, source URL/digest/date, CRS, and bounds.

The checked-in files are 475,469 bytes (9 Level III features) and 2,253,981 bytes (241 Level IV features, 67 distinct codes). This small pilot is served at the same relative paths by the local HTTP server and a future static Pages artifact. A future R2 URL can replace a manifest `url` without changing the GIS service.

## Browser query

Selecting a corridor initializes DuckDB-WASM 1.30.0 and `spatial` on demand. The browser verifies each downloaded Parquet file's byte length and SHA-256 before registering it. DuckDB Spatial intersects the canonical GeoJSON line with each EPA polygon. It measures each intersected line in EPSG:5070 meters, sums by code/name, and chooses the greatest overlap as primary (code breaks ties). Both primary and secondary regions remain in the domain result.

The current DuckDB bundle and Spatial extension load from pinned DuckDB/CDN endpoints at runtime, as in Fruiting Forecast. Thus first local use requires network access, although the GeoParquet data itself is local. The two verified data buffers are cached in memory for the session. There is no persistent GIS cache yet; this is appropriate for a 2.7 MB pilot but should be revisited before adding large layers. If the engine or data fails, the UI shows `UNKNOWN` and the cause instead of fabricating a zero-intersection result.
