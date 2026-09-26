import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../data/regional/manifest.json', import.meta.url)));
test.skip(!process.env.RUN_REGIONAL_REMOTE, 'Opt-in public R2 browser check');

test('a real browser can read and verify Road Naturalist R2 GeoParquet', async ({ page }) => {
  const part = catalog.datasets[0].partitions.find(item => item.state === 'present');
  await page.goto('/');
  const result = await page.evaluate(async url => {
    const response = await fetch(url);
    const bytes = await response.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map(value => value.toString(16).padStart(2, '0')).join('');
    return { status: response.status, bytes: bytes.byteLength, digest };
  }, new URL(part.url, catalog.assetBaseUrl).href);
  expect(result).toEqual({ status: 200, bytes: part.bytes, digest: part.sha256 });
});
