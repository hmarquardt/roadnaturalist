// OSM / Overpass road and access context.
//
// OpenStreetMap is supporting evidence, never automatically authoritative access evidence. A missing tag
// stays missing: `access` absent means "OSM provides no explicit access tag", which is not evidence of
// public access. Every retrieved way keeps its element id, its verbatim tags, the query that produced it,
// and the retrieval time, so a reader can re-check it at the source.
//
// Transport is injected. The browser and the operator script use the same adapter, the same bounded
// request budget, the same mirror list, and the same failure reporting. A mirror failure is recorded as a
// failure — it is never reported as "OSM has no data here".

export const OVERPASS_MIRRORS = Object.freeze([
  Object.freeze({ id: 'overpass-api-de', url: 'https://overpass-api.de/api/interpreter', cors: false,
    note: 'Primary public instance. Serves the operator script (it needs a User-Agent and sends no CORS header, so a browser cannot use it).' }),
  Object.freeze({ id: 'osm-mail-ru', url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', cors: true,
    note: 'Mirror that returns access-control-allow-origin: *, so the browser can query it directly.' }),
  Object.freeze({ id: 'osm-kumi-systems', url: 'https://overpass.kumi.systems/api/interpreter', cors: false,
    note: 'Community mirror; frequently rate-limited (HTTP 429).' }),
]);

// A browser can only use a mirror that sends CORS headers, and it cannot set User-Agent at all. Intersecting
// the two constraints is the adapter's job, not the caller's.
export const BROWSER_MIRRORS = Object.freeze(OVERPASS_MIRRORS.filter(mirror => mirror.cors));

// A public API should be able to see who is asking. This is the only client identification sent, and it is
// dropped automatically where the platform forbids it (browsers ignore User-Agent).
export const OVERPASS_USER_AGENT = 'roadnaturalist/1.0 (corridor access evidence; +https://github.com/hmarquardt/roadnaturalist)';

// A deliberately small budget: three corridors need a handful of queries, and Overpass is a shared public
// service. Concurrency is never used; queries are spaced apart and cached in session.
export const OVERPASS_BUDGET = Object.freeze({ maxRequests: 12, minSpacingMs: 1500, timeoutMs: 60000, queryTimeoutS: 45 });

// Highway values that are not roads a motor vehicle can cruise.
export const NON_ROAD_HIGHWAY_TYPES = Object.freeze(['path', 'footway', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'corridor', 'elevator', 'construction', 'proposed']);
// Tags kept verbatim for the access question, in the order a reader expects them.
export const ACCESS_TAG_KEYS = Object.freeze(['access', 'motor_vehicle', 'motorcar', 'vehicle', 'hgv', 'bicycle', 'horse', 'foot', 'seasonal', 'opening_hours', 'barrier', 'locked', 'gate']);
export const ROAD_TAG_KEYS = Object.freeze(['highway', 'name', 'ref', 'surface', 'tracktype', 'smoothness', 'service', 'operator', 'owner', 'ownership', 'maintenance', 'oneway', 'lanes', 'maxweight', 'width', 'designation', 'route']);

const ACCESS_VALUES_PUBLIC = new Set(['yes', 'public', 'permissive', 'designated']);
const ACCESS_VALUES_RESTRICTED = new Set(['no', 'private', 'customers', 'delivery', 'permit', 'destination', 'agricultural', 'forestry']);

export const OSM_ACCESS_SIGNAL = Object.freeze({
  EXPLICIT_PUBLIC: 'EXPLICIT_PUBLIC',
  EXPLICIT_RESTRICTED: 'EXPLICIT_RESTRICTED',
  EXPLICIT_PERMISSIVE: 'EXPLICIT_PERMISSIVE',
  ABSENT: 'ABSENT',
});

export function osmWayUrl(osmId) { return `https://www.openstreetmap.org/way/${osmId}`; }
export function osmNodeUrl(osmId) { return `https://www.openstreetmap.org/node/${osmId}`; }

// Every query is a plain, reviewable string. `out tags geom` is used so tags and geometry arrive together
// and nothing else is downloaded.
//
// Bounds are GeoJSON order [west, south, east, north] everywhere in this project, while Overpass wants
// (south, west, north, east). The conversion happens here, once, so no caller can transpose them by mistake.
export const overpassBbox = bounds => `${Number(bounds[1]).toFixed(4)},${Number(bounds[0]).toFixed(4)},${Number(bounds[3]).toFixed(4)},${Number(bounds[2]).toFixed(4)}`;

export function buildOsmWayQuery({ bounds, names, timeoutS = OVERPASS_BUDGET.queryTimeoutS }) {
  const alternation = names.map(name => escapeRegex(name.trim())).join('|');
  return `[out:json][timeout:${timeoutS}];way["highway"]["name"~"${alternation}",i](${overpassBbox(bounds)});out tags geom;`;
}

export function buildOsmBarrierQuery({ bounds, timeoutS = OVERPASS_BUDGET.queryTimeoutS }) {
  return `[out:json][timeout:${timeoutS}];node["barrier"](${overpassBbox(bounds)});out tags;`;
}

// The same query text shape the operator script uses to re-verify a captured record.
export function escapeRegex(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Tag normalization. Nothing is inferred: a tag that is not present is reported as absent.
export function normalizeOsmWay(element, { retrievedAt, mirror = null, query = null, osmTimestamp = null } = {}) {
  if (!element || element.type !== 'way' || !Number.isFinite(Number(element.id))) throw new TypeError('OSM way needs a numeric way id');
  const tags = Object.freeze({ ...(element.tags ?? {}) });
  const geometry = (element.geometry ?? []).filter(point => point && Number.isFinite(point.lat) && Number.isFinite(point.lon))
    .map(point => [Number(point.lon.toFixed(7)), Number(point.lat.toFixed(7))]);
  return Object.freeze({
    osmType: 'way',
    osmId: String(element.id),
    osmVersion: element.version ?? null,
    osmTimestamp: element.timestamp ?? osmTimestamp,
    url: osmWayUrl(element.id),
    name: tags.name ?? null,
    highway: tags.highway ?? null,
    surface: tags.surface ?? null,
    tracktype: tags.tracktype ?? null,
    smoothness: tags.smoothness ?? null,
    service: tags.service ?? null,
    operator: tags.operator ?? null,
    ownership: tags.ownership ?? tags.owner ?? null,
    ref: tags.ref ?? null,
    seasonal: tags.seasonal ?? null,
    tags,
    accessSignal: accessSignalOf(tags),
    geometry,
    provenance: Object.freeze({ source: 'OpenStreetMap contributors', sourceClass: 'TIER_3_COMMUNITY', license: 'ODbL 1.0',
      retrievedAt: retrievedAt ?? null, mirror, query, osmTimestamp: element.timestamp ?? osmTimestamp }),
  });
}

// What the tags actually say. Absent is a first-class state, not a soft yes.
export function accessSignalOf(tags = {}) {
  const keys = ['access', 'motor_vehicle', 'motorcar', 'vehicle'];
  const present = keys.filter(key => typeof tags[key] === 'string' && tags[key].trim());
  const values = Object.fromEntries(present.map(key => [key, tags[key]]));
  if (!present.length) return Object.freeze({ signal: OSM_ACCESS_SIGNAL.ABSENT, keys: Object.freeze(present), values: Object.freeze(values),
    note: 'OpenStreetMap carries no explicit access tag on this way. That is not evidence of public access and not evidence of restriction.' });
  const merged = present.map(key => tags[key]);
  const restricted = merged.find(value => ACCESS_VALUES_RESTRICTED.has(value));
  if (restricted) return Object.freeze({ signal: OSM_ACCESS_SIGNAL.EXPLICIT_RESTRICTED, keys: Object.freeze(present), values: Object.freeze(values),
    note: `OpenStreetMap states an explicit access value (${restricted}) on this way.` });
  if (merged.includes('permissive')) return Object.freeze({ signal: OSM_ACCESS_SIGNAL.EXPLICIT_PERMISSIVE, keys: Object.freeze(present), values: Object.freeze(values),
    note: "OpenStreetMap states access=permissive: passage is tolerated by the owner, which is weaker than an explicit public value." });
  const isPublic = merged.find(value => ACCESS_VALUES_PUBLIC.has(value));
  if (isPublic) return Object.freeze({ signal: OSM_ACCESS_SIGNAL.EXPLICIT_PUBLIC, keys: Object.freeze(present), values: Object.freeze(values),
    note: `OpenStreetMap states an explicit access value (${isPublic}) on this way.` });
  return Object.freeze({ signal: OSM_ACCESS_SIGNAL.ABSENT, keys: Object.freeze(present), values: Object.freeze(values),
    note: `OpenStreetMap access tags present (${merged.join(', ')}) but no public/private value; treated as no explicit access statement.` });
}

export const isRoadWay = way => Boolean(way?.highway) && !NON_ROAD_HIGHWAY_TYPES.includes(way.highway);

// The adapter. A caller asks for ways near a corridor and gets normalized ways plus a request ledger. Every
// failure (HTTP status, mirror, timeout) is preserved; a run with failures is PARTIAL, not empty.
export function createOsmSource({ transport = defaultOverpassTransport, mirrors = OVERPASS_MIRRORS, budget = OVERPASS_BUDGET, now = () => new Date(), cache = new Map(), requireCors = false } = {}) {
  const usableMirrors = requireCors ? mirrors.filter(mirror => mirror.cors) : mirrors;
  let requests = 0;
  let lastRequestAt = 0;
  const failures = [];
  const ledger = [];

  async function query(queryText, { kind, key }) {
    if (cache.has(key)) return { ...cache.get(key), cached: true };
    if (requests >= budget.maxRequests) {
      const failure = Object.freeze({ kind, reason: `Overpass request budget for this session is spent (${budget.maxRequests}).`, query: queryText });
      failures.push(failure);
      return { status: 'BUDGET_EXHAUSTED', ways: [], barriers: [], failures: Object.freeze([failure]), mirrorFailures: Object.freeze([failure]), query: queryText, cached: false };
    }
    const waitMs = budget.minSpacingMs - (Date.now() - lastRequestAt);
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    const retrievedAt = now().toISOString();
    const attempts = [];
    for (const mirror of usableMirrors) {
      requests += 1;
      lastRequestAt = Date.now();
      try {
        const body = await transport(`${mirror.url}?data=${encodeURIComponent(queryText)}`, { timeoutMs: budget.timeoutMs });
        ledger.push(Object.freeze({ kind, query: queryText, mirror: mirror.id, retrievedAt, outcome: 'OK', osmTimestamp: body?.osm3s?.timestamp_osm_base ?? null }));
        const result = Object.freeze({ status: 'OK', body, mirror: mirror.id, retrievedAt, query: queryText, failures: Object.freeze([]),
          mirrorFailures: Object.freeze([...attempts]), cached: false, osmTimestamp: body?.osm3s?.timestamp_osm_base ?? null });
        cache.set(key, result);
        return result;
      } catch (error) {
        const failure = Object.freeze({ kind, mirror: mirror.id, reason: error.message, query: queryText, retrievedAt });
        attempts.push(failure);
        failures.push(failure);
        ledger.push(Object.freeze({ kind, query: queryText, mirror: mirror.id, retrievedAt, outcome: 'FAILED', reason: error.message }));
      }
    }
    return { status: 'FAILED', ways: [], barriers: [], failures: Object.freeze(attempts), mirrorFailures: Object.freeze(attempts), query: queryText, mirrorsTried: usableMirrors.map(mirror => mirror.id), cached: false };
  }

  function select(limit) {
    const corridorKey = `${limit.bounds.map(value => value.toFixed(4)).join(',')}|${[...limit.names].sort().join(',')}`;
    return { waysKey: `ways|${corridorKey}`, barrierKey: `barrier|${corridorKey}` };
  }

  return Object.freeze({
    budget,
    mirrors: Object.freeze(usableMirrors),
    // One way query and one barrier query per corridor box; nothing is polled and nothing is retried in a storm.
    async queryCorridor(limit) {
      const keys = select(limit);
      const wayResult = await query(buildOsmWayQuery(limit), { kind: 'ways', key: keys.waysKey });
      const ways = (wayResult.body?.elements ?? []).filter(element => element.type === 'way').map(element => normalizeOsmWay(element, { retrievedAt: wayResult.retrievedAt, mirror: wayResult.mirror, query: wayResult.query, osmTimestamp: wayResult.osmTimestamp ?? null }));
      const barrierResult = await query(buildOsmBarrierQuery(limit), { kind: 'barriers', key: keys.barrierKey });
      const barriers = (barrierResult.body?.elements ?? []).filter(element => element.type === 'node').map(element => normalizeOsmBarrier(element, { retrievedAt: barrierResult.retrievedAt, mirror: barrierResult.mirror, query: barrierResult.query }));
      const allFailures = [...((wayResult.failures) ?? []), ...((barrierResult.failures) ?? [])];
      const mirrorFailures = [...((wayResult.mirrorFailures) ?? []), ...((barrierResult.mirrorFailures) ?? [])];
      return Object.freeze({
        status: allFailures.length && !ways.length && !barriers.length ? 'FAILED' : allFailures.length ? 'PARTIAL' : 'OK',
        ways: Object.freeze(ways.filter(isRoadWay)),
        nonRoadWays: Object.freeze(ways.filter(way => !isRoadWay(way))),
        barriers: Object.freeze(barriers),
        retrievedAt: wayResult.retrievedAt ?? null,
        osmTimestamp: wayResult.osmTimestamp ?? null,
        mirrorsUsed: Object.freeze([wayResult.mirror, barrierResult.mirror].filter(Boolean)),
        queries: Object.freeze([{ kind: 'ways', query: wayResult.query, status: wayResult.status }, { kind: 'barriers', query: barrierResult.query, status: barrierResult.status }]),
        failures: Object.freeze(allFailures), 
        // A mirror that failed but was recovered by another mirror is diagnostic, not a coverage problem.
        mirrorFailures: Object.freeze(mirrorFailures),
      });
    },
    requestCount: () => requests,
    failures: () => Object.freeze([...failures]),
    ledger: () => Object.freeze([...ledger]),
    ledgerEntry: () => Object.freeze({ requests, failures: Object.freeze([...failures]), calls: Object.freeze([...ledger]) }),
  });
}

// A mapped barrier (gate, cattle grid, block) is context that a corridor may be gated; its access tag is
// reported verbatim and never interpreted as permission.
export function normalizeOsmBarrier(element, { retrievedAt, mirror = null, query = null } = {}) {
  if (!element || element.type !== 'node' || !Number.isFinite(Number(element.id))) throw new TypeError('OSM barrier needs a numeric node id');
  const tags = Object.freeze({ ...(element.tags ?? {}) });
  return Object.freeze({
    osmType: 'node', osmId: String(element.id), url: osmNodeUrl(element.id),
    barrier: tags.barrier ?? null, access: tags.access ?? null, locked: tags.locked ?? null, tags,
    location: Number.isFinite(element.lat) && Number.isFinite(element.lon) ? Object.freeze([Number(element.lon.toFixed(7)), Number(element.lat.toFixed(7))]) : null,
    provenance: Object.freeze({ source: 'OpenStreetMap contributors', sourceClass: 'TIER_3_COMMUNITY', license: 'ODbL 1.0', retrievedAt: retrievedAt ?? null, mirror, query }),
  });
}

// Default transport: plain fetch, hard timeout, JSON only. It is never given a credential because Overpass
// needs none, which is why the browser may call the CORS-enabled mirror directly.
export async function defaultOverpassTransport(url, { timeoutMs = OVERPASS_BUDGET.timeoutMs } = {}) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': OVERPASS_USER_AGENT }, signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined });
  if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
  return response.json();
}

// A RECORDED OPERATOR RUN. The browser cannot crawl county web sites (no CORS header) and should not depend
// on Overpass being reachable, so it replays the reviewed operator capture for OpenStreetMap context while
// the official-source evidence is replayed by createRecordedTransport in research.js. The captured facts keep
// their original retrieval timestamp and are labelled as recorded, never as a fresh check.
export function createRecordedOsmSource({ record, corridorId }) {
  const entry = record?.corridors?.[corridorId] ?? null;
  return Object.freeze({
    id: 'recorded-osm',
    async queryCorridor() {
      if (!entry?.osm) {
        return Object.freeze({ status: 'FAILED', ways: Object.freeze([]), nonRoadWays: Object.freeze([]), barriers: Object.freeze([]),
          failures: Object.freeze([{ kind: 'record', reason: 'the operator capture contains no OpenStreetMap context for this corridor' }]),
          retrievedAt: null, osmTimestamp: null, mirrorsUsed: Object.freeze([]), queries: Object.freeze([]), recorded: null });
      }
      const osm = entry.osm;
      return Object.freeze({ status: osm.status ?? 'OK', ways: Object.freeze([]), nonRoadWays: Object.freeze([]), barriers: Object.freeze([]),
        failures: Object.freeze([...(osm.failures ?? [])]), retrievedAt: osm.retrievedAt ?? null, osmTimestamp: osm.osmTimestamp ?? null,
        mirrorsUsed: Object.freeze([...(osm.mirrorsUsed ?? [])]), queries: Object.freeze([...(osm.queries ?? [])]),
        recorded: Object.freeze({ capturedAt: record.capturedAt ?? null, status: osm.status ?? 'OK',
          match: osm.match ?? null, nameVariants: Object.freeze([...(osm.nameVariants ?? [])]),
          barriers: Object.freeze([...(osm.barriers ?? [])]), waySummaries: Object.freeze([...(osm.waySummaries ?? [])]),
          queries: Object.freeze([...(osm.queries ?? [])]), failures: Object.freeze([...(osm.failures ?? [])]),
          retrievedAt: osm.retrievedAt ?? null, osmTimestamp: osm.osmTimestamp ?? null, mirrorsUsed: Object.freeze([...(osm.mirrorsUsed ?? [])]),
          searchNames: Object.freeze([...(osm.searchNames ?? [])]), searchBounds: osm.searchBounds ?? null }),
      });
    },
  });
}
