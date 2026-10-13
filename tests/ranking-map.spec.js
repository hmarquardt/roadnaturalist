import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

import { RANKING_VERSION } from '../src/discovery/ranking.js';

// A QUALITATIVE SANITY CHECK OF THE EXPLORATION ORDER ON THE REAL MAP.
//
//   RUN_RANKING_MAP=1 npx playwright test tests/ranking-map.spec.js
//
// This is not a new map feature and not a second ranking implementation. It proves the one thing the offline
// evaluation cannot: that the order the evaluation measured is the order the deployed application actually shows,
// over the same published plane and the same centre, and that the top-ranked roads are the ones the map draws. The
// expected ids come straight from the committed evaluation artifact, so a divergence here is a real divergence
// between the evaluated order and the shipped order.
const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.pages.dev';
const REGIONS = ['princeton-in', 'portland-or', 'southwest-dry'];

test.skip(!process.env.RUN_RANKING_MAP, 'set RUN_RANKING_MAP=1 to sanity-check the exploration order on the map');

function artifact() {
  return JSON.parse(readFileSync(new URL('../data/ranking/naturalist-interest-v1-evaluation.json', import.meta.url), 'utf8'));
}

for (const id of REGIONS) {
  test(`exploration order on the map: ${id}`, async ({ page }) => {
    test.setTimeout(1800000);
    const evaluation = artifact();
    const region = evaluation.regions.find(entry => entry.id === id);
    expect(region, `the evaluation must include ${id}`).toBeTruthy();
    expect(evaluation.rankingVersion).toBe(RANKING_VERSION);
    await page.setViewportSize({ width: 1440, height: 950 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });

    // The same centre the evaluation measured with: typed, not a gazetteer point, so the two runs are comparable.
    const [lon, lat] = region.center;
    await page.locator('#discovery-center-lat').fill(lat.toFixed(4));
    await page.locator('#discovery-center-lon').fill(lon.toFixed(4));
    await page.locator('#discovery-center-apply').click();
    await page.locator('#discovery-radius-input').fill(String(region.radiusMiles));
    await page.locator('#discovery-radius-input').press('Enter');
    await expect(page.locator('#discovery-radius-value')).toHaveText(`${region.radiusMiles} mi`);
    await page.locator('#discover-roads').click();
    await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 600000 });

    // Order by the exploration heuristic, exactly as a person would.
    await page.locator('#discovery-sort').selectOption('naturalistInterest');
    const shown = await page.locator('#discovery-results tbody tr').evaluateAll(rows =>
      rows.slice(0, 10).map(row => ({ id: row.dataset.candidateId, text: row.innerText.split('\n')[0] })));
    expect(shown.length).toBeGreaterThan(0);
    const expected = region.comparison.interest.map(entry => entry.corridorId);
    console.log(`RANKING_MAP ${id} ${JSON.stringify(shown)}`);
    console.log(`RANKING_MAP_EXPECTED ${id} ${JSON.stringify(expected)}`);

    // THE SHIPPED ORDER IS THE EVALUATED ORDER. Same ids, same sequence, for the top of the list.
    expect(shown.map(row => row.id)).toEqual(expected.slice(0, shown.length));

    // AND THE MAP DRAWS THEM. Every top-ranked corridor has candidate geometry on the map - a list entry the map
    // never drew would be the listing and the map disagreeing about what the search found. Existence, not viewport
    // visibility: the camera covers the whole result set, and an individual short segment can still sit at the SVG
    // edge, but the element being present is the synchronisation claim.
    const drawnIds = await page.locator('#map path[data-role="candidate"][data-corridor-id]')
      .evaluateAll(paths => [...new Set(paths.map(path => path.getAttribute('data-corridor-id')))]);
    for (const row of shown) {
      expect(drawnIds, `${row.id} must be drawn on the map`).toContain(row.id);
    }
    // A degenerate list would repeat one corridor; the order must name several distinct roads.
    expect(new Set(shown.map(row => row.id)).size).toBe(shown.length);
    expect(errors).toEqual([]);
  });
}
