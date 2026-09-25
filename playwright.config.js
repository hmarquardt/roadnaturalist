import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: './tests', testMatch: '*.spec.js', use: { baseURL: 'http://127.0.0.1:8000', browserName: 'chromium' }, webServer: { command: 'python3 -m http.server 8000 --bind 127.0.0.1', port: 8000, reuseExistingServer: !process.env.CI }, reporter: 'line' });
