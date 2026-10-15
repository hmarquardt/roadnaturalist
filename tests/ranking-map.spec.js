import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openAdvancedSearch, openAllResults, openChangeLocation } from './discovery-ui.js';

import { RANKING_VERSION } from '../src/discovery/ranking.js';
import { EXPLORATION_ORDER_VERSION } from '../src/discovery/exploration-order.js';
import { DEFAULT_SORT } from '../src/discovery/filter.js';
import { cameraOf } from './map-contract.js';

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
// Ordinary discovery must reach nothing that costs data: no raw plane, no source-evidence rebuild. The ranking
// itself reads only measurements the discovery run already made, and this census proves it in the browser. It is
// narrowed to DATA requests - the application's own modules are served from these same origins and are not reads.
const RAW_PLANE = /\/(national\/roads|national\/wetlands|national\/hydro)\//;

test.skip(!process.env.RUN_RANKING_MAP, 'set RUN_RANKING_MAP=1 to sanity-check the exploration order on the map');

function artifact() {
  const path = process.env.RANKING_EVAL_ARTIFACT ?? '../data/ranking/naturalist-interest-v2-evaluation.json';
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

function orderArtifact() {
  const path = process.env.RANKING_ORDER_ARTIFACT ?? '../data/ranking/exploration-order-v1-evaluation.json';
  const evaluation = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  expect(evaluation.orderVersion).toBe(EXPLORATION_ORDER_VERSION);
  expect(evaluation.interestVersion).toBe(RANKING_VERSION);
  return evaluation;
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
    const rawReads = [];
    page.on('request', request => { if (RAW_PLANE.test(request.url())) rawReads.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await openChangeLocation(page);
    await expect(page.locator('#discover-roads')).toBeEnabled({ timeout: 180000 });

    // The same centre the evaluation measured with: typed, not a gazetteer point, so the two runs are comparable.
    const [lon, lat] = region.center;
    await openAdvancedSearch(page);
    await page.locator('#discovery-center-lat').fill(lat.toFixed(4));
    await page.locator('#discovery-center-lon').fill(lon.toFixed(4));
    await page.locator('#discovery-center-apply').click();
    await page.locator('#discovery-radius-input').fill(String(region.radiusMiles));
    await page.locator('#discovery-radius-input').press('Enter');
    await expect(page.locator('#discovery-radius-value')).toHaveText(`${region.radiusMiles} mi`);
    await openChangeLocation(page);
    await page.locator('#discover-roads').click();
    await openAllResults(page);
    await expect(page.locator('#discovery-results tbody tr').first()).toBeVisible({ timeout: 600000 });

    const camera = () => cameraOf(page);
    const rows = () => page.locator('#discovery-results tbody tr').evaluateAll(nodes =>
      nodes.slice(0, 10).map(row => ({ id: row.dataset.candidateId, text: row.innerText.split('\n')[0] })));

    // ---------------------------------------------------------------- a fresh search leads with the default
    // THE DEFAULT IS THE EXPLORATION ORDER, and it is already selected without anyone choosing it.
    const sortSelect = page.locator('#discovery-sort');
    await expect(sortSelect).toHaveValue(DEFAULT_SORT);
    const order = orderArtifact().regions.find(entry => entry.id === id);
    expect(order, `the exploration evaluation must include ${id}`).toBeTruthy();
    const expectedOrder = order.selected.order.map(entry => entry.corridorId);
    const shown = await rows();
    expect(shown.length).toBeGreaterThan(0);
    console.log(`RANKING_MAP_DEFAULT ${id} ${JSON.stringify(shown)}`);
    expect(shown.map(row => row.id)).toEqual(expectedOrder.slice(0, shown.length));

    // THE MAP DRAWS THEM. Every top-ranked corridor has candidate geometry on the map - a list entry the map never
    // drew would be the listing and the map disagreeing about what the search found. Existence, not viewport
    // visibility: the camera covers the whole result set, and an individual short segment can still sit at the SVG
    // edge, but the element being present is the synchronisation claim.
    const drawnIds = await page.locator('#map path[data-role="candidate"][data-corridor-id]')
      .evaluateAll(paths => [...new Set(paths.map(path => path.getAttribute('data-corridor-id')))]);
    for (const row of shown) {
      expect(drawnIds, `${row.id} must be drawn on the map`).toContain(row.id);
    }
    // A degenerate list would repeat one corridor; the order must name several distinct roads.
    expect(new Set(shown.map(row => row.id)).size).toBe(shown.length);

    // PORTLAND: the rim bias the evaluation found is gone in the shipped list. The distance-aware order's median
    // top-10 distance is materially below the interest order's, which is the whole point of the transform.
    if (id === 'portland-or') {
      const interestMedian = order.candidates[order.selectedCandidate].metrics.distanceFrom.median;
      const orderMedian = order.candidates[order.selectedCandidate].metrics.distanceAfter.median;
      expect(orderMedian).toBeLessThan(interestMedian / 2);
    }

    // ---------------------------------------------------------------- switching sorts changes only the order
    // CHOOSING THE INTEREST ORDER STILL WORKS, and it matches the committed interest evaluation.
    const before = await camera();
    await sortSelect.selectOption('naturalistInterest');
    const interest = await rows();
    const expectedInterest = region.comparison.interest.map(entry => entry.corridorId);
    console.log(`RANKING_MAP_INTEREST ${id} ${JSON.stringify(interest.map(row => row.id))}`);
    expect(interest.map(row => row.id)).toEqual(expectedInterest.slice(0, interest.length));
    expect(await camera(), 'changing the sort must not move the camera').toEqual(before);

    // SWITCHING BACK RESTORES THE DEFAULT ORDER, and the camera still has not moved.
    await sortSelect.selectOption(DEFAULT_SORT);
    const restored = await rows();
    expect(restored.map(row => row.id)).toEqual(expectedOrder.slice(0, restored.length));
    expect(await camera(), 'changing the sort back must not move the camera either').toEqual(before);

    // BOTH SCORES ARE ON SCREEN, and the selection panel never labels one as the other.
    await page.locator('#discovery-results tbody tr').first().locator('.discovery-row').click();
    const panel = page.locator('#discovery-selected');
    await expect(panel).toContainText('Naturalist interest');
    await expect(panel).toContainText('Exploration order');

    // Ranking reads measured context only: no raw plane and no source-evidence rebuild is triggered by ordering.
    expect(rawReads, `ordering must not read a raw plane or rebuild source evidence: ${rawReads.join(', ')}`).toEqual([]);
    expect(errors).toEqual([]);
  });
}
