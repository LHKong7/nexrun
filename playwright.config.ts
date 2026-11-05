import { defineConfig } from '@playwright/test';

function testPort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('Invalid browser-test port.');
  return Number(value);
}
const apiPort = testPort(process.env.NEXRUN_E2E_API_PORT, 3001);
const webPort = testPort(process.env.NEXRUN_E2E_WEB_PORT, 5173);
const testEnvironment = { NEXRUN_E2E_API_PORT: String(apiPort), NEXRUN_E2E_WEB_PORT: String(webPort) };
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    viewport: { width: 1440, height: 1000 },
    channel: process.env.CI ? undefined : 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    { command: 'node --env-file-if-exists=.env --import tsx apps/api/test/e2e-server.ts', url: `http://127.0.0.1:${apiPort}/healthz`, timeout: 60_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 }, reuseExistingServer: false, env: { ...testEnvironment, AGENT_MODE: 'mock' } },
    { command: 'npm run dev --workspace @nexrun/web', url: `http://127.0.0.1:${webPort}`, timeout: 60_000, reuseExistingServer: false, env: testEnvironment },
  ],
});
