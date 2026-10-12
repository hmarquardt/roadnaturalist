import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// THE INVESTIGATOR IS A LAZY FEATURE BOUNDARY.
//
// Road Naturalist must not download or initialise the Investigator just because somebody opened the app or used the
// map: the feature enters the runtime when a person asks for access research, and not before. These tests prove the
// boundary rather than describe it - they walk the application's static import graph the way a browser would, and
// compare the data the two sides rely on.

const ROOT = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, ROOT), 'utf8');

// The modules a module statically pulls in: `import ... from '...'`, bare `import '...'` and `export ... from '...'`.
// A dynamic `import('...')` is deliberately not one of these: that is the boundary.
function staticDependencies(source) {
  const specifiers = [];
  const patterns = [/^\s*import\s+[^;]*?from\s*['"]([^'"]+)['"]/gm, /^\s*import\s*['"]([^'"]+)['"]/gm,
    /^\s*export\s+[^;]*?from\s*['"]([^'"]+)['"]/gm];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  return specifiers;
}

// Every module reachable through static imports from an entry point, following the browser's rules: a module that
// imports data blocks on that data, so JSON imports are part of the graph.
function staticGraph(entryUrl) {
  const seen = new Map();
  const queue = [entryUrl];
  while (queue.length) {
    const url = queue.pop();
    if (seen.has(url.href)) continue;
    let source;
    try { source = readFileSync(url, 'utf8'); } catch { seen.set(url.href, null); continue; }
    seen.set(url.href, source);
    for (const specifier of staticDependencies(source)) {
      if (specifier.startsWith('.')) queue.push(new URL(specifier, url));
    }
  }
  return seen;
}

test('the ordinary application pulls no Investigator module into its static graph', () => {
  const graph = staticGraph(new URL('src/app/main.js', ROOT));
  assert.ok(graph.size > 20, `the graph was walked (${graph.size} modules)`);
  const investigator = [...graph.keys()].filter(url => /\/src\/investigator\//.test(url));
  assert.deepEqual(investigator, [], 'nothing under src/investigator/ may be statically reachable from the app shell');
  // The Investigator's catalog is data its modules import: it must not arrive by either route.
  const catalog = [...graph.keys()].filter(url => /probe-catalog/.test(url));
  assert.deepEqual(catalog, [], 'the probe catalog is not ordinary application data');
});

test('the feature is reached by a dynamic import of exactly one boundary module', () => {
  const source = read('src/app/main.js');
  const dynamic = [...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
  assert.deepEqual(dynamic, ['../investigator/feature.js'], 'one public feature boundary, loaded on request');
  assert.ok(!/^\s*import\s+[^;]*?from\s*['"][^'"]*investigator/m.test(source),
    'and no static import of anything under src/investigator/ creeps back in');
  const boundary = read('src/investigator/feature.js');
  const exported = staticDependencies(boundary);
  assert.ok(exported.length >= 7, 'the boundary names the whole feature, not one file of it');
  assert.ok(exported.every(specifier => specifier.startsWith('./')), 'and only its own internals');
});

test('the feature boundary loads in isolation and offers the operations the app asks it for', async () => {
  // A runtime check as well as a static one: the boundary really resolves, and the operations the application calls
  // through it exist. It is imported here directly (a test may reach the feature), never from the app shell.
  const feature = await import(new URL('src/investigator/feature.js', ROOT));
  for (const name of ['createInvestigatorService', 'createResearchService', 'createRecordedTransport',
    'createOsmSource', 'createRecordedOsmSource', 'buildCorridorBundle', 'PILOT_PROBES_BY_CORRIDOR',
    'probeAvailability', 'buildProbeBaseline', 'retrievalModeCounts', 'createWorkerResearchTransport', 'BROWSER_MIRRORS']) {
    assert.ok(feature[name], `the boundary exports ${name}`);
  }
  assert.equal(typeof feature.buildCorridorBundle, 'function');
  assert.ok(Object.keys(feature.PILOT_PROBES_BY_CORRIDOR).length >= 1, 'and the declared probes travel with it');
});

test('the ordinary page links no Investigator stylesheet, and the feature requests one itself', () => {
  const html = read('index.html');
  assert.ok(!/<link[^>]+investigator\.css/.test(html), 'an ordinary visit must not request the feature stylesheet');
  const source = read('src/app/main.js');
  assert.match(source, /assets\/css\/investigator\.css/, 'the feature loader names the stylesheet');
  assert.match(source, /requestInvestigatorStyles/, 'and adds it when the feature is requested');
  assert.match(source, /link\.rel = 'stylesheet'/, 'as a stylesheet, not as a script');
});

test('the styles the ordinary detail needs are in the ordinary stylesheet, and the rest stayed lazy', () => {
  // The Access & road status section and the run control are on screen before the feature is loaded, so their rules
  // cannot live in a lazy stylesheet. Everything else in investigator.css belongs to surfaces that only exist once
  // the feature is here.
  const ordinary = read('assets/css/components.css');
  const lazy = read('assets/css/investigator.css');
  for (const selector of ['.access-section', '.investigation-section', '.access-actions']) {
    assert.ok(ordinary.includes(selector), `${selector} is styled without the Investigator`);
    assert.ok(!lazy.includes(`${selector}{`) && !lazy.includes(`${selector} {`), `${selector} is not duplicated in the lazy sheet`);
  }
  for (const selector of ['.access-finding', '.stage-list', '.source-list', '.adversarial-list', '.human-review']) {
    assert.ok(!ordinary.includes(selector), `${selector} stays with the feature`);
    assert.ok(lazy.includes(selector), `${selector} is still styled where it belongs`);
  }
});

test('the declared research corridors are exactly the corridors the pilot declares', () => {
  // The ordinary panel answers "is a source declared for this corridor?" from the pilot declaration, because the
  // catalog is Investigator data it must not load. That derivation is only sound while the catalog covers exactly the
  // pilot's corridors and each of them has at least one declared probe - so it is asserted here, not assumed.
  const catalog = JSON.parse(read('data/investigator/probe-catalog.json'));
  const pilot = JSON.parse(read('data/roads/or-roads-pilot.json'));
  const catalogIds = catalog.corridors.map(corridor => corridor.id).sort();
  const pilotIds = pilot.candidates.map(candidate => candidate.id).sort();
  assert.deepEqual(catalogIds, pilotIds, 'the reviewed catalog covers the declared pilot corridors, and only those');
  assert.ok(catalogIds.length > 0, 'and covers at least one');
  for (const corridorId of catalogIds) {
    const declared = catalog.probes.filter(probe => !probe.corridorIds || probe.corridorIds.includes(corridorId));
    assert.ok(declared.length >= 1, `${corridorId} has at least one declared probe`);
  }
});

test('no ordinary module names Investigator data as something it reads', () => {
  // The same guard at the level of the files an ordinary visit loads: only the feature may name Investigator data.
  const graph = staticGraph(new URL('src/app/main.js', ROOT));
  for (const [url, source] of graph) {
    if (!source || /\/src\/investigator\//.test(url)) continue;
    assert.ok(!/data\/investigator\//.test(source), `${fileURLToPath(url)} must not name Investigator data`);
  }
});

