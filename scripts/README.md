# Offline preparation

`build-ecoregions.py` prepares the EPA Oregon Level III/IV dataset from pinned shapefile ZIPs. `build-roads.py` prepares the Oregon road-centerline pilot from pinned U.S. Census Bureau TIGER/Line 2025 county ROADS ZIPs, writes the road GeoParquet, the test snapshot fixture, and the manifest entry, and can print a read-only EPA overlap check. Both scripts verify source digests, keep raw source caches out of Git, and preserve dataset entries they do not build when rewriting `data/manifest.json`.

`docs/ECOREGIONS.md` and `docs/ROADS.md` hold the exact commands, source digests, schemas, and scope. Generated small GeoParquet files are committed so local analysis works without production data hosting.
