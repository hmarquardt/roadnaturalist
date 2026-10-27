# Search discovery — Road Naturalist

Canonical site: https://roadnaturalist.com/

## SEO foundation
- Homepage has a descriptive title, description, canonical and Open Graph metadata.
- A factual WebApplication JSON-LD block describes the public tool without making unsupported claims.
- `/robots.txt` permits crawlers and names `https://roadnaturalist.com/sitemap.xml`.
- `/sitemap.xml` lists only the canonical homepage; dynamic user-specific searches and private state are not indexable pages.
- The established staging process must include both crawler files.

## Release and owner verification
1. Run `npm run stage:pages` and verify the built deployment contains `robots.txt`, `sitemap.xml`, and the updated `index.html`.
2. Cloudflare Pages direct-upload staging; a source commit alone does not establish a live release.
3. Once production deployment is confirmed, retrieve the homepage, `/robots.txt` and `/sitemap.xml` through the canonical hostname and confirm HTTP 200, correct contents, and expected canonical metadata.
4. In Google Search Console, verify the domain property and submit `https://roadnaturalist.com/sitemap.xml`; inspect the homepage using URL Inspection. Indexing is up to Google.

Avoid invented reviews, local-business addresses, guarantees of results, or additional tracking. Do not expose runtime data, private investigation state or source-only materials for indexing.
