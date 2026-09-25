# Backend boundary

Add a Cloudflare Worker only for a concrete need such as server-held API keys, external API proxy/cache, or Investigator calls. The static app and deterministic browser GIS remain independent of it. No Worker is deployed or configured yet.

## Occurrence credentials (documented need, not implemented)

eBird requires a personal API key on every request. Road Naturalist does not ship that key to the
browser, so the browser occurrence service is constructed with `ebirdTransport: null` and eBird
reports `UNKNOWN` with a credential reason instead of a zero result. When live eBird evidence is
wanted in the deployed app, this Worker is the intended boundary: hold the key as a secret, expose one
bounded endpoint that accepts a corridor midpoint and recent-window parameters, call
eBird's `/v2/data/obs/geo/recent` with the key in the `X-eBirdApiToken` header, and return only the
normalized record shape. The browser must never receive the key, and the endpoint must keep the same
bounded request budget and truncation reporting the browser adapter already implements. Until that
boundary is reviewed and deployed, eBird stays UNKNOWN in the browser and
`scripts/verify-occurrence-live.mjs` (Node, `EBIRD_API_KEY`) is the only live eBird path.
