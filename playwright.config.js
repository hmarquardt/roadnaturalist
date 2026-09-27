import { defineConfig } from '@playwright/test';

// One worker and a generous per-test timeout: every browser test initialises DuckDB-WASM Spatial
// and several also query it, so parallel Chromium instances contend for the same CPU.
//
// The test origin is served by a *threaded* Python server, not `python3 -m http.server`. The application fetches
// many files at once (modules, GeoParquet extracts, regional partitions), and `http.server` answers one request
// at a time: a browser that navigates away mid-download leaves the single-threaded server writing to a dead
// socket, and every later request then waits behind it - which shows up as a page that never boots.
//
// Two further things keep the server lifecycle deterministic:
//   * its output goes to a log file, not to the runner's pipe. A run that is killed leaves the server alive; with
//     its stdout connected to a dead parent every log line raises BrokenPipeError, which is what turned an
//     orphaned server into one that answered `ERR_EMPTY_RESPONSE` to everything.
//   * `url` is checked. `port` alone only asks whether something is listening, so a stale server that accepts
//     connections and answers nothing was silently reused and every test failed later as "element not found".
//     With `url`, an unhealthy server fails the run before the first test, loudly.
export const TEST_SERVER_LOG = 'test-server.log';
export default defineConfig({ testDir: './tests', testMatch: '*.spec.js', workers: 1, timeout: 120000, retries: 1,
  use: { baseURL: 'http://127.0.0.1:8000', browserName: 'chromium' },
  webServer: { command: "python3 -c \"import http.server; http.server.ThreadingHTTPServer(('127.0.0.1', 8000), http.server.SimpleHTTPRequestHandler).serve_forever()\" >> test-server.log 2>&1",
    url: 'http://127.0.0.1:8000/data/manifest.json', timeout: 30000,
    reuseExistingServer: !process.env.CI }, reporter: 'line' });


