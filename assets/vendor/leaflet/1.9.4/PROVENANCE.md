# Leaflet 1.9.4 — vendored

| | |
|---|---|
| Version | 1.9.4 |
| Upstream | https://unpkg.com/leaflet@1.9.4/dist/ (Leaflet — https://leafletjs.com) |
| Retrieved | 2026-10-11 |
| Licence | BSD-2-Clause (see the `@preserve` header in `leaflet.js`) |

| Asset | Bytes | SHA-256 |
|---|---|---|
| `leaflet.js` | 147552 | `db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a` |
| `leaflet.css` | 14806 | `a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6` |

Vendored rather than loaded from a CDN so the application pins exactly this build, works offline, and does not
depend on a third party's availability or on a runtime script fetch that could change under it.

The `images/` directory is deliberately **not** vendored: it exists for Leaflet's default marker icons, and this
application draws its own geometry (paths, circles and circle markers) rather than drop-pins, so those assets would
be dead weight. If a default marker is ever used, its icons must be vendored in the same way.

To re-fetch and verify:

```bash
curl -fsSL -o assets/vendor/leaflet/1.9.4/leaflet.js  https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
curl -fsSL -o assets/vendor/leaflet/1.9.4/leaflet.css https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
shasum -a 256 assets/vendor/leaflet/1.9.4/*
```
