import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { habitatNote, habitatSelection } from '../src/app/habitat-selection.js';
import { habitatOverlayStatus } from '../src/gis/habitat-query.js';
import { COVERAGE } from '../src/domain/corridor.js';

// HABITAT FOR A DISCOVERY CORRIDOR, AND AN HONEST DESCRIPTION OF THE RESULT.
//
// The map draws promoted candidates and discovery results alike, so the habitat action has to be able to name the corridor
// the person is looking at. These tests cover that normalization, the decision about whether an analysis could actually be
// made, and the words the panel uses for each outcome - the places where a panel could quietly claim something that did
// not happen.
const DISCOVERY = Object.freeze({ id: 'drv1-co-rd-900-c11-s1', name: 'Co Rd 900',
  geometry: { type: 'LineString', coordinates: [[-87.5201, 38.2801], [-87.42, 38.29]] },
  distanceFromCenterM: 1604.2, nearestCenterPoint: [-87.51, 38.28] });
const PROMOTED = Object.freeze({ id: 'or-roads-cornelius-pass-rd', name: 'NW Cornelius Pass Rd',
  geometry: { type: 'LineString', coordinates: [[-122.9, 45.6], [-122.86, 45.62]] },
  dataCatalogUrl: 'regional/manifest.json' });

test('a discovery corridor normalizes into habitat-analysis input, geometry and all', () => {
  const selection = habitatSelection({ discoveryResult: DISCOVERY });
  assert.equal(selection.id, DISCOVERY.id);
  assert.equal(selection.name, DISCOVERY.name);
  assert.equal(selection.promoted, false);
  assert.deepEqual(selection.geometry, DISCOVERY.geometry, 'the real geometry, coordinate for coordinate');
  assert.deepEqual(selection.bounds, [-87.5201, 38.2801, -87.42, 38.29], 'and its real bounds');
  assert.ok(selection.lengthM > 0, 'with a real measured length');
  assert.equal(selection.catalogUrl, null, 'a discovery result carries no regional catalogue, and none is invented');
  // A promoted candidate is the other kind of selection, and keeps the catalogue it really has.
  const promoted = habitatSelection({ candidate: PROMOTED });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.catalogUrl, 'regional/manifest.json');
  // Nothing about source identity, access or measurement is manufactured on the way in.
  assert.deepEqual(Object.keys(selection).sort(),
    ['bounds', 'catalogUrl', 'geometry', 'id', 'lengthM', 'name', 'promoted']);
  // A selection with no usable geometry is no selection at all, and a candidate wins over a discovery result.
  assert.equal(habitatSelection({}), null);
  assert.equal(habitatSelection({ discoveryResult: { id: 'x', geometry: { type: 'Point', coordinates: [0, 0] } } }), null);
  assert.equal(habitatSelection({ discoveryResult: { id: 'x' } }), null);

test('an analysis is only ready where its sources are, and never zero where they are not', () => {
  const sealed = habitatOverlayStatus({ wetlandsCoverage: COVERAGE.FULL, hydrographyCoverage: COVERAGE.FULL,
    featureCount: 3 });
  assert.equal(sealed.status, 'ready');
  assert.equal(sealed.drawsBuffer, true, 'a covered corridor gets its analysis area');
  assert.equal(sealed.reason, null);
  // Coverage that is there and finds nothing is a measurement, and says so.
  const empty = habitatOverlayStatus({ wetlandsCoverage: COVERAGE.FULL, hydrographyCoverage: COVERAGE.PARTIAL,
    featureCount: 0 });
  assert.equal(empty.status, 'ready');
  assert.equal(empty.drawsBuffer, true);
  assert.match(empty.reason, /no mapped wetland or hydrography features were found/);
  // One plane missing is partial, and names it.
  const partial = habitatOverlayStatus({ wetlandsCoverage: COVERAGE.FULL, hydrographyCoverage: COVERAGE.NONE });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.drawsBuffer, true);
  assert.match(partial.reason, /raw hydrography coverage is not published/);
  // No required coverage at all is unavailable - and draws no analysis area, because nothing was analysed.
  for (const coverage of [COVERAGE.NONE, COVERAGE.UNKNOWN, undefined]) {
    const unavailable = habitatOverlayStatus({ wetlandsCoverage: coverage, hydrographyCoverage: COVERAGE.NONE });
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.drawsBuffer, false, 'an unavailable analysis is never drawn as an empty one');
    assert.match(unavailable.reason, /not published for this area/);
  }
});

test('the panel says what happened, and never claims a layer that is not there', () => {
  const ready = habitatNote({ diagnostics: { status: 'ready', reason: null }, features: [{}, {}] });
  assert.match(ready, /Habitat analysis loaded for this corridor/);
  assert.match(ready, /2 mapped source feature/);
  const nothingFound = habitatNote({ diagnostics: { status: 'ready',
    reason: 'no mapped wetland or hydrography features were found within the analysis area' }, features: [] });
  assert.match(nothingFound, /no mapped wetland or hydrography features were found/);
  assert.ok(!/unavailable/i.test(nothingFound), 'a completed analysis with no hits is not an unavailable one');
  assert.ok(!/loaded/i.test(nothingFound), 'and it does not claim layers were displayed');
  const partial = habitatNote({ diagnostics: { status: 'partial',
    reason: 'the required raw wetland coverage is not published for this area' }, features: [{}] });
  assert.match(partial, /partial/);
  assert.match(partial, /raw wetland coverage is not published/);
  const unavailable = habitatNote({ diagnostics: { status: 'unavailable',
    reason: 'the required raw wetland and hydrography coverage is not published for this area' }, features: [] });
  assert.match(unavailable, /unavailable here/);
  assert.match(unavailable, /coverage is not published/);
  assert.ok(!/loaded|displayed/i.test(unavailable), 'and it never says a layer is shown when nothing was analysed');
  // No selection, no analysis, and the panel says that too.
  assert.match(habitatNote(null), /no corridor with usable geometry is selected/);
});

test('only the explicit habitat action runs the analysis', () => {
  // THE ANALYSIS IS A REQUEST, NOT A SIDE EFFECT. Selection, sorting, panning and fitting must not run it: the one call
  // site is the habitat control's own change listener, and this says so where a reader can check it rather than trusting
  // the wiring by inspection.
  const source = readFileSync(new URL('../src/app/main.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const calls = [...source.matchAll(/toggleHabitatOverlay\(/g)];
  assert.equal(calls.length, 2, 'one definition and one call');
  const listener = source.indexOf('habitatToggle?.addEventListener');
  assert.match(source.slice(listener, listener + 400), /toggleHabitatOverlay\(enabled\)/,
    'and the call is the habitat control change listener');
});

  assert.equal(habitatSelection({ candidate: PROMOTED, discoveryResult: DISCOVERY }).id, PROMOTED.id);
});
