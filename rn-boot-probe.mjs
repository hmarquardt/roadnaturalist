import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
await page.goto('https://roadnaturalist.com', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12000);
console.log('HAS_PLACE', await page.locator('#discovery-place').count(), 'HAS_MAP', await page.locator('#map').count(),
  'HAS_L', await page.evaluate(() => typeof globalThis.L));
await browser.close();
