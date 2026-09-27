import { defineConfig } from '@playwright/test';

// One worker and a generous per-test timeout: every browser test initialises DuckDB-WASM Spatial
// and several also query it, so parallel Chromium instances contend for the same CPU.
//
// The test origin is served by a *threaded* Python server, not `python3 -m http.server`. The application fetches
// many files at once (modules, GeoParquet extracts, regional partitions), and `http.server` answers one request
// at a time: a browser that navigates away mid-download leaves the single-threaded server writing to a dead
// socket, and every later request then waits behind it - which shows up as a page that never boots. A threaded
// server serves each connection on its own thread, exactly as the real host does.
export default defineConfig({ testDir: './tests', testMatch: '*.spec.js', workers: 1, timeout: 120000, retries: 1,
  use: { baseURL: 'http://127.0.0.1:8000', browserName: 'chromium' },
  webServer: { command: "python3 -c \"import http.server; http.server.ThreadingHTTPServer(('127.0.0.1', 8000), http.server.SimpleHTTPRequestHandler).serve_forever()\"",
    port: 8000, reuseExistingServer: !process.env.CI }, reporter: 'line' });

