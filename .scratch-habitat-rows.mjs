// SCRATCH (deleted after this task): evidence gathering for the habitat source-feature slice. Asks the deployed
// application for the rows its own habitat analysis returns, and reads the map's DOM for the shapes it draws today.
import { chromium } from '@playwright/test';

const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.com';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));

const out = { phaseA: null, phaseB: null, errors };

// PHASE A: the exact row contract, from the application's own service, for a corridor inside the bounded extract.
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('#discover-roads').waitFor({ state: 'attached', timeout: 180000 });
  out.phaseA = await page.evaluate(async () => {
    const { gis } = await import('/src/app/main.js');
    const pilot = await (await fetch('data/roads/or-roads-pilot.json')).json();
    const roadIds = pilot.candidates.flatMap(candidate => candidate.roadIds ?? []);
    const roads = await gis.queryRoads({ roadIds });
    const geometry = { type: 'MultiLineString', coordinates: roads.features.map(row => row.geometry.coordinates) };
    const overlay = await gis.getHabitatOverlay(geometry);
    const rows = overlay.features;
    const byLayer = {};
    for (const row of rows) {
      const entry = byLayer[row.layer] ??= { count: 0, keys: null, geometryTypes: {}, ids: 0, distinctIds: new Set(),
        emptyIds: 0, labels: new Set(), codes: new Set(), samples: [] };
      entry.count += 1;
      entry.keys = Object.keys(row).sort();
      const type = row.geometry?.type ?? null;
      entry.geometryTypes[type] = (entry.geometryTypes[type] ?? 0) + 1;
      if (typeof row.sourceFeatureId === 'string' && row.sourceFeatureId.length) { entry.ids += 1; entry.distinctIds.add(row.sourceFeatureId); } else entry.emptyIds += 1;
      if (row.label != null) entry.labels.add(String(row.label));
      if (row.code != null) entry.codes.add(String(row.code));
      if (entry.samples.length < 3) entry.samples.push(row);
    }
    return {
      roads: { features: roads.features.length, coverage: roads.coverage },
      diagnostics: overlay.diagnostics, bufferType: overlay.bufferGeometry?.type ?? null,
      coverage: overlay.coverage, featureCount: rows.length,
      layers: Object.fromEntries(Object.entries(byLayer).map(([layer, entry]) => [layer, { ...entry,
        distinctIds: entry.distinctIds.size, labels: [...entry.labels].slice(0, 4), codes: [...entry.codes].slice(0, 4) }])),
    };
  });
} catch (error) { out.phaseA = { error: String(error).slice(0, 400) }; }

// PHASE B: the seeded North Plains corridor through the real UI, and what the map's DOM holds with Habitat on.
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('#discovery-place').fill('north plains or');
  await page.locator('#discovery-place-results .discovery-place-option').first().waitFor({ timeout: 120000 });
  await page.locator('#discovery-place-results .discovery-place-option').first().click();
  await page.locator('#discovery-radius-input').fill('4');
  await page.locator('#discovery-radius-input').press('Enter');
  await page.locator('#discovery-search-status').filter({ hasText: 'Coverage: FULL' }).waitFor({ timeout: 120000 });
  await page.locator('#discover-roads').click();
  await page.locator('#discovery-results tbody tr').first().waitFor({ timeout: 600000 });
  await page.locator('#discovery-results tbody tr').first().locator('.discovery-row').click();
  const before = await page.evaluate(() => document.querySelectorAll('#map path').length);
  await page.locator('#habitat-layers').check();
  const note = page.locator('#habitat-layers-note');
  await page.waitForFunction(() => {
    const text = document.querySelector('#habitat-layers-note')?.textContent ?? '';
    return text.length > 0 && !/Running the habitat analysis/.test(text);
  }, null, { timeout: 300000 });
  out.phaseB = {
    note: (await note.innerText()).slice(0, 200), pathsBeforeHabitat: before,
    paths: await page.evaluate(() => {
      const rows = [];
      for (const path of document.querySelectorAll('#map path')) {
        rows.push({ tag: path.tagName, attrs: Object.fromEntries([...path.getAttributeNames()].map(name => [name, path.getAttribute(name)])),
          interactive: path.classList.contains('leaflet-interactive'), stroke: path.getAttribute('stroke'),
          fill: path.getAttribute('fill'), closed: /z$/i.test((path.getAttribute('d') ?? '').trim()),
          dLength: (path.getAttribute('d') ?? '').length });
      }
      const census = {};
      for (const row of rows) {
        const key = `role=${row.attrs['data-role'] ?? null}|corridor=${row.attrs['data-corridor-id'] ?? null}`
          + `|habitat=${row.attrs['data-habitat-id'] ?? null}|buffer=${row.attrs['data-habitat-corridor-id'] ?? null}`
          + `|interactive=${row.interactive}|stroke=${row.stroke}|closed=${row.closed}`;
        census[key] = (census[key] ?? 0) + 1;
      }
      return { total: rows.length, census, untyped: rows.filter(row => row.attrs['data-role'] === 'candidate'
        && row.attrs['data-corridor-id'] === undefined) };
    }),
  };
} catch (error) { out.phaseB = { error: String(error).slice(0, 400) }; }

// PHASE C: what are the untyped candidate-role paths, and are they habitat-driven? Census at three moments.
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('#discovery-place').fill('north plains or');
  await page.locator('#discovery-place-results .discovery-place-option').first().waitFor({ timeout: 120000 });
  await page.locator('#discovery-place-results .discovery-place-option').first().click();
  await page.locator('#discovery-radius-input').fill('4');
  await page.locator('#discovery-radius-input').press('Enter');
  await page.locator('#discovery-search-status').filter({ hasText: 'Coverage: FULL' }).waitFor({ timeout: 120000 });
  await page.locator('#discover-roads').click();
  await page.locator('#discovery-results tbody tr').first().waitFor({ timeout: 600000 });
  await page.locator('#discovery-results tbody tr').first().locator('.discovery-row').click();
  const census = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#map path')].map(path => ({
      role: path.getAttribute('data-role'), corridorId: path.getAttribute('data-corridor-id'),
      habitatId: path.getAttribute('data-habitat-id'), bufferId: path.getAttribute('data-habitat-corridor-id'),
      interactive: path.classList.contains('leaflet-interactive'), stroke: path.getAttribute('stroke'),
      strokeWidth: path.getAttribute('stroke-width'), d: path.getAttribute('d') ?? '' }));
    const identified = new Set(rows.filter(row => row.corridorId).map(row => row.d));
    const untyped = rows.filter(row => row.role === 'candidate' && row.corridorId === null);
    return { total: rows.length, untyped: untyped.length,
      untypedDuplicatingAnIdentifiedPath: untyped.filter(row => identified.has(row.d)).length,
      untypedSample: untyped.slice(0, 8).map(row => ({ d: row.d.slice(0, 60), dLength: row.d.length,
        interactive: row.interactive, stroke: row.stroke, strokeWidth: row.strokeWidth })),
      habitatPaths: rows.filter(row => row.habitatId).length,
      bufferPaths: rows.filter(row => row.bufferId).length };
  });
  await page.waitForTimeout(1200);
  const afterSelection = await census();
  await page.locator('#habitat-layers').check();
  await page.waitForFunction(() => {
    const text = document.querySelector('#habitat-layers-note')?.textContent ?? '';
    return text.length > 0 && !/Running the habitat analysis/.test(text);
  }, null, { timeout: 300000 });
  await page.waitForTimeout(2500);
  const withHabitat = await census();
  await page.locator('#habitat-layers').uncheck();
  await page.waitForTimeout(1500);
  out.phaseC = { afterSelection, withHabitat, afterDisable: await census(),
    note: (await page.locator('#habitat-layers-note').innerText()).slice(0, 120) };
} catch (error) { out.phaseC = { error: String(error).slice(0, 400) }; }

console.log(JSON.stringify(out, null, 1));
await browser.close();
