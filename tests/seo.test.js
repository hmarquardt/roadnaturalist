import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CANONICAL_URL, CRAWLER_FILES, SITEMAP_URL, validatePreviewNoindex, validateSeo } from '../scripts/seo.mjs';

// THE SITE'S SEARCH RESULT, HELD OFFLINE.
//
// A browser test cannot see any of this: the homepage metadata, the WebApplication JSON-LD, robots.txt and
// sitemap.xml are read by crawlers, not by people. So the contract is tested here, on the committed files, and the
// negative cases below are the regressions that matter - a canonical that drifts to a preview host, structured
// data that invents a rating, a sitemap with no canonical URL - because a release that ships one of them looks
// perfectly healthy in the product.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const robots = readFileSync(new URL('../robots.txt', import.meta.url), 'utf8');
const sitemap = readFileSync(new URL('../sitemap.xml', import.meta.url), 'utf8');
const headers = readFileSync(new URL('../config/pages-headers', import.meta.url), 'utf8');
const staging = readFileSync(new URL('../scripts/stage-pages.mjs', import.meta.url), 'utf8');

test('the committed site satisfies the crawler contract', () => {
  assert.deepEqual(validateSeo({ html, robots, sitemap }), []);
  assert.deepEqual(validatePreviewNoindex(headers), []);
});

test('one page, one canonical domain, and the sitemap agrees with it', () => {
  assert.equal(CANONICAL_URL, 'https://roadnaturalist.com/');
  assert.equal(SITEMAP_URL, 'https://roadnaturalist.com/sitemap.xml');
  assert.match(robots, /^Sitemap: https:\/\/roadnaturalist\.com\/sitemap\.xml$/m);
  assert.match(sitemap, new RegExp(`<loc>${CANONICAL_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>`));
  // The comment lines may explain the canonical host; nothing a crawler acts on may name a preview host.
  const directives = robots.replace(/^#.*$/gm, '').trim();
  assert.ok(!/pages\.dev/.test(directives), 'robots.txt must not direct crawlers at a preview host');
});

test('the staging list publishes the crawler files, and the staging gate applies the contract', () => {
  const entries = /const SITE_ENTRIES = \[([^\]]*)\]/.exec(staging)?.[1] ?? '';
  for (const file of CRAWLER_FILES) {
    assert.ok(entries.includes(`'${file}'`), `${file} must be a staged site entry or it is never published`);
  }
  assert.match(staging, /validateSeo\(/, 'staging must apply the crawler contract before anything uploads');
});

// The JSON-LD is parsed, not pattern-matched: an invalid block is worse than no block, because a crawler drops the
// whole description of the application.
test('the structured data is one valid WebApplication', () => {
  const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(blocks.length, 1);
  const data = JSON.parse(blocks[0][1]);
  assert.equal(data['@type'], 'WebApplication');
  assert.equal(data.url, CANONICAL_URL);
  assert.equal(data.name, 'Road Naturalist');
  assert.ok(data.applicationCategory?.trim(), 'the application category must be declared');
  assert.ok(data.description.length >= 50, 'the application must be described in one sentence');
  for (const invented of ['aggregateRating', 'review']) assert.ok(!(invented in data));
});

// Each mutation is a release regression a person could actually commit. The gate must name it.
const mutilations = [
  ['a homepage with no canonical', { html: html.replace(/<link rel="canonical"[^>]*>/, '') }, /canonical/],
  ['a canonical pointing at the Pages host', { html: html.replace('https://roadnaturalist.com/"', 'https://roadnaturalist.pages.dev/"') }, /canonical|pages\.dev/],
  ['a homepage with no meta description', { html: html.replace(/<meta name="description"[^>]*>/, '') }, /meta description/],
  ['a meta description too short to describe anything', { html: html.replace(/<meta name="description" content="[^"]*"/, '<meta name="description" content="Roads"') }, /meta description is \d+ characters/],
  ['structured data that invents a rating', { html: html.replace('"@type":"WebApplication",', '"@type":"WebApplication","aggregateRating":{"@type":"AggregateRating","ratingValue":"5"},') }, /aggregateRating/],
  ['structured data that is not JSON', { html: html.replace('"@type":"WebApplication"', '"@type": WebApplication') }, /not valid JSON/],
  ['two structured-data blocks', { html: html.replace('</script>', '</script><script type="application/ld+json">{}</script>') }, /exactly one application\/ld\+json/],
  ['a page that tells crawlers not to index it', { html: html.replace('<title>', '<meta name="robots" content="noindex"><title>') }, /must stay indexable/],
  ['a sitemap pointing at the Pages host', { sitemap: sitemap.replace(CANONICAL_URL, 'https://roadnaturalist.pages.dev/') }, /canonical host/],
  ['a sitemap listing a URL with a query', { sitemap: sitemap.replace(`<loc>${CANONICAL_URL}</loc>`, `<loc>${CANONICAL_URL}?utm=x</loc>`) }, /query or fragment/],
  ['a robots.txt with no sitemap', { robots: robots.replace(/^Sitemap:.*$/m, '') }, /Sitemap/],
  ['a robots.txt that disallows the whole site', { robots: robots.replace('Allow: /', 'Disallow: /') }, /disallow the whole site|must allow/],
  ['a robots.txt pointing at the Pages host', { robots: robots.replace(SITEMAP_URL, 'https://roadnaturalist.pages.dev/sitemap.xml') }, /must point at|pages\.dev/],
];

for (const [name, change, expected] of mutilations) {
  test(`the contract rejects ${name}`, () => {
    const problems = validateSeo({ html, robots, sitemap, ...change });
    assert.ok(problems.some(problem => expected.test(problem)),
      `expected a problem matching ${expected}, got ${JSON.stringify(problems)}`);
  });
}

test('the Pages hostnames are noindex, and only they are', () => {
  assert.deepEqual(validatePreviewNoindex(headers), []);
  const unfenced = headers.replace('https://:project.pages.dev/*\n  X-Robots-Tag: noindex', 'https://:project.pages.dev/*');
  assert.ok(validatePreviewNoindex(unfenced).length > 0, 'a preview rule without noindex must fail');
});
