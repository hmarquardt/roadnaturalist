// SCRATCH (deleted after this task): what actually happens to one real click on a pilot corridor.
import { chromium } from '@playwright/test';

const BASE = process.env.PRODUCTION_BASE_URL ?? 'https://roadnaturalist.com';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const console_ = [];
const errors = [];
page.on('console', message => console_.push(message.text()));
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => { globalThis.__RN_DEBUG_MAP_CLICK = true; });

const out = {};
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const pilot = page.locator('#load-pilot');
  await pilot.waitFor({ state: 'visible', timeout: 300000 });
  await pilot.click();
  await page.locator('.candidate-card', { hasText: 'NW Cornelius Pass Rd' }).first().click();
  await page.waitForTimeout(2500);
  await page.locator('#map').scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    globalThis.__RN_CLICKS = [];
    const el = document.getElementById('map');
    el.addEventListener('click', event => {
      const target = event.target;
      globalThis.__RN_CLICKS.push({ phase: 'capture', tag: target.tagName,
        role: target.getAttribute?.('data-role') ?? null, corridorId: target.getAttribute?.('data-corridor-id') ?? null,
        interactive: Boolean(target.classList?.contains('leaflet-interactive')), detail: event.detail,
        timeStamp: Math.round(event.timeStamp) });
    }, true);
  });
  const probe = await page.evaluate(() => {
    for (const element of [...document.querySelectorAll('#map path[data-role="candidate"][data-corridor-id]')].slice(0, 40)) {
      const length = element.getTotalLength?.() ?? 0;
      if (!length) continue;
      const midpoint = element.getPointAtLength(length / 2);
      const screen = new DOMPoint(midpoint.x, midpoint.y).matrixTransform(element.getScreenCTM());
      const top = document.elementFromPoint(screen.x, screen.y);
      if (top?.dataset?.role === 'candidate' && top.dataset.corridorId) return { x: screen.x, y: screen.y, id: top.dataset.corridorId };
    }
    return null;
  });
  out.probe = probe;
  const before = console_.length;
  await page.mouse.click(probe.x, probe.y);
  await page.waitForTimeout(1200);
  out.events = await page.evaluate(() => globalThis.__RN_CLICKS);
  out.trace = console_.slice(before).filter(line => line.startsWith('MAP_CLICK'));
  out.errors = errors;
  out.detail = (await page.locator('#candidate-detail').innerText()).slice(0, 80);
} catch (error) { out.error = String(error).slice(0, 300); }
console.log(JSON.stringify(out, null, 1));
await browser.close();
