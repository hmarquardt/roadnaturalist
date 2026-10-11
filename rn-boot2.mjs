import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 240)));
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 240)); });
await page.goto('https://roadnaturalist.com', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(14000);
console.log('PLACE', await page.locator('#discovery-place').count(), 'ROWS', await page.locator('#discovery-results').count());
await browser.close();
