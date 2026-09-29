import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync(new URL('../data/national/source-registry.json', import.meta.url)));
const grid = JSON.parse(readFileSync(new URL('../data/national/grid-conus-2025.json', import.meta.url)));
const qa = JSON.parse(readFileSync(new URL('../data/national/qa-samples.json', import.meta.url)));

test('CONUS source registry preserves the current TIGER road vintage and explicitly defers habitat', () => {
  assert.equal(registry.region, 'conus');
  assert.equal(registry.sources.roads.vintage, '2025');
  assert.match(registry.sources.roads.urlTemplate, /TIGER2025\/ROADS\/tl_2025_\{countyFips\}_roads\.zip$/);
  assert.equal(registry.sources.wetlands.status, 'planned');
  assert.equal(registry.sources.hydrography.status, 'planned');
  assert.equal(registry.grid.stepLon, 0.2);
  assert.equal(registry.grid.stepLat, 0.2);
});

test('fixed national QA samples resolve to declared CONUS cells', () => {
  const cells = new Map(grid.cells.map(cell => [cell.id, cell]));
  assert.equal(new Set(qa.samples.map(sample => sample.id)).size, qa.samples.length);
  for (const sample of qa.samples) {
    const [lon, lat] = sample.center;
    const id = `x${Math.floor((lon + 180) / 0.2)}_y${Math.floor((lat + 90) / 0.2)}`;
    assert.ok(cells.has(id), `${sample.id} is outside the CONUS grid`);
    assert.equal(sample.radiusMiles, 10);
  }
});

test('CONUS grid contains 48 contiguous states and DC, with no territory or ocean-only cell', () => {
  assert.equal(grid.counts.states, 49);
  assert.equal(grid.counts.counties, grid.counties.length);
  assert.equal(grid.counts.cells, grid.cells.length);
  assert.equal(grid.counts.fullCells + grid.counts.edgeCells, grid.cells.length);
  assert.equal(new Set(grid.cells.map(cell => cell.id)).size, grid.cells.length);
  assert.equal(new Set(grid.counties.map(county => county.fips)).size, grid.counties.length);
  for (const excluded of ['02', '15', '60', '66', '69', '72', '78']) assert.ok(!grid.stateFips.includes(excluded));
  assert.ok(grid.stateFips.includes('11'), 'District of Columbia');
  for (const cell of grid.cells) {
    assert.match(cell.id, /^x\d+_y\d+$/);
    assert.ok(['full', 'edge'].includes(cell.coverage));
    assert.ok(cell.states.length > 0, `${cell.id} cannot be ocean-only`);
    assert.ok(cell.states.every(state => grid.stateFips.includes(state)));
    assert.ok(Math.abs(cell.bounds[2] - cell.bounds[0] - 0.2) < 1e-8);
    assert.ok(Math.abs(cell.bounds[3] - cell.bounds[1] - 0.2) < 1e-8);
  }
});
