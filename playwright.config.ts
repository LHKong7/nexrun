import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    channel: process.env.CI ? undefined : 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    { command: 'node --env-file-if-exists=.env --import tsx apps/api/test/e2e-server.ts', url: 'http://127.0.0.1:3001/healthz', timeout: 60_000, reuseExistingServer: false, env: { AGENT_MODE: 'mock' } },
    { command: 'npm run dev --workspace @nexrun/web', url: 'http://127.0.0.1:5173', timeout: 60_000, reuseExistingServer: false },
  ],
});
