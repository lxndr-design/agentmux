import { defineConfig } from '@playwright/test';

/**
 * Two servers, both loopback:
 *  - the demo harness: real daemon (WS :8787) + control endpoint (:8788)
 *  - `vite preview` serving the built app on :4173
 * `npm run test:e2e` builds with VITE_DEMO_CONTROL_URL baked in, then runs
 * this config. In CI (fresh sandbox) servers always start fresh.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node demo/harness.mjs',
      cwd: '.',
      url: 'http://127.0.0.1:8788/demo/config',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'npx vite preview --port 4173 --strictPort --host 127.0.0.1',
      cwd: '.',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
