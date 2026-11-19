import { defineConfig, devices } from '@playwright/test';

/**
 * Critical journeys against the isolated Compose stack (pnpm --filter @sil/hr-e2e stack:up).
 * The journeys build on each other (hire → ... → offboard), so they run in order, one worker.
 */
export const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3420';
export const API = process.env.E2E_API_URL ?? 'http://localhost:3410';
export const SINK = process.env.E2E_SINK_URL ?? 'http://localhost:8199';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  use: { baseURL: WEB, trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'] },
});
