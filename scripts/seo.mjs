// The site's search-result contract: the homepage metadata, the WebApplication JSON-LD block, robots.txt, the
// sitemap, and the policy that keeps the Pages hostnames out of an index that already has the canonical domain.
//
// One page, one canonical URL. A browser test cannot see any of this - it is read by crawlers, not by people - so
// the contract lives here and is applied three times: by `scripts/stage-pages.mjs` before anything can upload, by
// `scripts/verify-pages-release.mjs` against the bytes the origin actually serves, and offline by
// `tests/seo.test.js`. A release that loses the crawler files, or points them at a hostname other than
// roadnaturalist.com, fails rather than shipping quietly.
export const SEO_ORIGIN = 'https://roadnaturalist.com';
export const CANONICAL_URL = `${SEO_ORIGIN}/`;
export const SITEMAP_URL = `${SEO_ORIGIN}/sitemap.xml`;
export const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';
export const SITE_NAME = 'Road Naturalist';
// The two files Cloudflare Pages serves as-is for a crawler, beside index.html.
export const CRAWLER_FILES = Object.freeze(['robots.txt', 'sitemap.xml']);

const META_DESCRIPTION_MIN = 50;
const META_DESCRIPTION_MAX = 300;

function attributes(tag) {
  const found = {};
  for (const match of tag.matchAll(/([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*"([^"]*)"/g)) found[match[1].toLowerCase()] = match[2];
  return found;
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(match => attributes(match[0]));
}

function metaContents(html, attribute, value) {
  return tags(html, 'meta')
    .filter(meta => (meta[attribute] ?? '').toLowerCase() === value.toLowerCase())
    .map(meta => meta.content ?? '');
}

function linkHrefs(html, rel) {
  return tags(html, 'link')
    .filter(link => (link.rel ?? '').toLowerCase().split(/\s+/).includes(rel))
    .map(link => link.href ?? '');
}

function urlOf(value) {
  try { return new URL(value); } catch { return null; }
}

// A value that names a hostname which is not the canonical one. The Pages hostnames are real, serve the same
// bytes, and must never be the address a search result or a social card points at.
function foreignHost(value) {
  const url = urlOf(value.trim());
  if (url) return url.hostname !== new URL(SEO_ORIGIN).hostname ? url.hostname : null;
  return /(^|[^a-z0-9.-])[a-z0-9.-]*\.pages\.dev\b/i.test(value) ? 'a pages.dev hostname' : null;
}

function validateHomepage(html, problems) {
  const titles = [...html.matchAll(/<title>([\s\S]*?)<\/title>/gi)].map(match => match[1].trim());
  if (titles.length !== 1 || !titles[0]) problems.push('index.html must carry exactly one non-empty <title>');

  const descriptions = metaContents(html, 'name', 'description');
  if (descriptions.length !== 1) problems.push('index.html must declare exactly one meta description');
  else if (descriptions[0].length < META_DESCRIPTION_MIN || descriptions[0].length > META_DESCRIPTION_MAX) {
    problems.push(`the meta description is ${descriptions[0].length} characters; a search result shows roughly `
      + `${META_DESCRIPTION_MIN}-${META_DESCRIPTION_MAX}`);
  }

  const canonicals = linkHrefs(html, 'canonical');
  if (canonicals.length !== 1 || canonicals[0] !== CANONICAL_URL) {
    problems.push(`index.html must declare exactly one canonical ${CANONICAL_URL}, not ${canonicals.join(', ') || 'none'}`);
  }

  const robots = metaContents(html, 'name', 'robots');
  // A page with no meta robots is indexable, which is what the site wants; one that says otherwise is a decision
  // nobody made on purpose, and it fails here instead of silently removing the page from every index.
  for (const value of robots) {
    if (/noindex/i.test(value)) problems.push(`index.html declares meta robots "${value}": the page must stay indexable`);
  }

  const expected = { 'og:type': 'website', 'og:url': CANONICAL_URL };
  for (const [property, value] of Object.entries(expected)) {
    const found = metaContents(html, 'property', property);
    if (found.length !== 1 || found[0] !== value) {
      problems.push(`index.html must declare ${property} as ${value}, not ${found.join(', ') || 'nothing'}`);
    }
  }
  const required = { property: ['og:title', 'og:description'], name: ['twitter:card'] };
  for (const [attribute, properties] of Object.entries(required)) {
    for (const property of properties) {
      const found = metaContents(html, attribute, property);
      if (found.length !== 1 || !found[0].trim()) problems.push(`index.html must declare one non-empty ${property}`);
    }
  }
  // A site name that disagrees with the structured data is two identities for one page.
  for (const value of metaContents(html, 'property', 'og:site_name')) {
    if (value !== SITE_NAME) problems.push(`index.html declares og:site_name "${value}", not ${SITE_NAME}`);
  }
  for (const meta of tags(html, 'meta')) {
    const key = meta.property ?? meta.name ?? '';
    if (!/^(?:og|twitter):/.test(key) || !meta.content) continue;
    const host = foreignHost(meta.content);
    if (host) problems.push(`${key} names ${host}, which is not the canonical host`);
  }
}

function validateStructuredData(html, problems) {
  const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]);
  if (blocks.length !== 1) {
    problems.push(`index.html must carry exactly one application/ld+json block, not ${blocks.length}`);
    return;
  }
  let data;
  try { data = JSON.parse(blocks[0]); }
  catch (error) { problems.push(`the JSON-LD block is not valid JSON: ${error.message}`); return; }
  if (data['@context'] !== 'https://schema.org') problems.push('the JSON-LD @context must be https://schema.org');
  const types = Array.isArray(data['@type']) ? data['@type'] : [data['@type']];
  if (!types.includes('WebApplication')) problems.push('the JSON-LD @type must be WebApplication');
  if (data.url !== CANONICAL_URL) problems.push(`the JSON-LD url must be ${CANONICAL_URL}, not ${data.url ?? 'nothing'}`);
  if (data.name !== SITE_NAME) problems.push(`the JSON-LD name must be ${SITE_NAME}`);
  if (typeof data.description !== 'string' || data.description.length < META_DESCRIPTION_MIN) {
    problems.push('the JSON-LD description must describe the application in at least one sentence');
  }
  if (typeof data.applicationCategory !== 'string' || !data.applicationCategory.trim()) {
    problems.push('the JSON-LD applicationCategory must be declared');
  }
  // Nothing on this site rates, reviews or prices itself. Structured data that invents those is a lie a search
  // result then repeats, so a block that carries one fails instead of being ignored.
  for (const invented of ['aggregateRating', 'review', 'ratingValue']) {
    if (invented in data) problems.push(`the JSON-LD must not carry ${invented}: the site has no such evidence`);
  }
}

function validateRobots(robots, problems) {
  if (!/^User-agent:\s*\*/im.test(robots)) problems.push('robots.txt must address User-agent: *');
  if (!/^Allow:\s*\/\s*$/im.test(robots)) problems.push('robots.txt must allow the site root');
  if (/^Disallow:\s*\/\s*$/im.test(robots)) problems.push('robots.txt must not disallow the whole site');
  if (/^Disallow:\s*\/(?!data\/)/im.test(robots)) problems.push('robots.txt must not disallow anything but /data/');
  const sitemaps = [...robots.matchAll(/^Sitemap:\s*(\S+)\s*$/gim)].map(match => match[1]);
  if (sitemaps.length !== 1) problems.push(`robots.txt must declare exactly one Sitemap line, not ${sitemaps.length}`);
  else if (sitemaps[0] !== SITEMAP_URL) problems.push(`robots.txt must point at ${SITEMAP_URL}, not ${sitemaps[0]}`);
  for (const line of robots.split('\n')) {
    if (!/^(?:Sitemap|Allow|Disallow):/i.test(line.trim())) continue;
    const host = foreignHost(line);
    if (host) problems.push(`robots.txt references ${host}, which is not the canonical host`);
  }
}

function validateSitemap(sitemap, problems) {
  if (!/^<\?xml\s+version="1\.0"\s+encoding="UTF-8"\s*\?>/.test(sitemap.trim())) {
    problems.push('sitemap.xml must open with an XML declaration');
  }
  if (!sitemap.includes(`xmlns="${SITEMAP_NAMESPACE}"`)) problems.push('sitemap.xml must declare the sitemap namespace');
  if (!/<\/urlset>\s*$/.test(sitemap.trim())) problems.push('sitemap.xml must close its <urlset>');
  const locs = [...sitemap.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/g)].map(match => match[1]);
  if (!locs.length) { problems.push('sitemap.xml must list at least one URL'); return; }
  if (new Set(locs).size !== locs.length) problems.push('sitemap.xml lists the same URL twice');
  if (!locs.includes(CANONICAL_URL)) problems.push(`sitemap.xml must list ${CANONICAL_URL}`);
  for (const loc of locs) {
    const url = urlOf(loc);
    if (!url || url.protocol !== 'https:') { problems.push(`sitemap.xml lists ${loc}, which is not an https URL`); continue; }
    if (url.hostname !== new URL(SEO_ORIGIN).hostname) problems.push(`sitemap.xml lists ${url.hostname}, not the canonical host`);
    if (url.search || url.hash) problems.push(`sitemap.xml lists ${loc}, which carries a query or fragment`);
  }
}

// The whole contract, applied to three documents. An empty array means the payload may be published.
export function validateSeo({ html, robots, sitemap }) {
  const problems = [];
  validateHomepage(html, problems);
  validateStructuredData(html, problems);
  validateRobots(robots, problems);
  validateSitemap(sitemap, problems);
  return problems;
}

// The Pages hostnames serve the same bytes for previews and release verification. They must not be indexable:
// two hostnames serving one page split its search result, and a preview deployment is not the product.
export function validatePreviewNoindex(headers) {
  const problems = [];
  for (const pattern of ['https://:project.pages.dev/*', 'https://:version.:project.pages.dev/*']) {
    const index = headers.indexOf(pattern);
    if (index < 0) { problems.push(`_headers must declare a rule for ${pattern}`); continue; }
    const block = headers.slice(index + pattern.length).split(/\n\n/)[0];
    if (!/X-Robots-Tag:\s*noindex/i.test(block)) problems.push(`_headers must mark ${pattern} X-Robots-Tag: noindex`);
  }
  return problems;
}
