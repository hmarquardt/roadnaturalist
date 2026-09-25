import { defineConfig } from '@playwright/test';

// One worker and a generous per-test timeout: every browser test initialises DuckDB-WASM Spatial
// and several also query it, so parallel Chromium instances contend for the same CPU.
export default defineConfig({ testDir: './tests', testMatch: '*.spec.js', workers: 1, timeout: 120000, retries: 1,
  use: { baseURL: 'http://127.0.0.1:8000', browserName: 'chromium' }, webServer: { command: 'python3 -m http.server 8000 --bind 127.0.0.1', port: 8000, reuseExistingServer: !process.env.CI }, reporter: 'line' });
