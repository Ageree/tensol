import { defineConfig, devices } from '@playwright/test';

// One-off config to run real-prod-full-scan.spec.ts against api.tensol.ru
// without spinning up the local dev server (which the default config does
// via globalSetup). Test is HTTP-only via apiRequest, so no browser project
// is strictly needed but Playwright requires at least one.
export default defineConfig({
  testDir: './e2e',
  testMatch: /real-prod-full-scan\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'https://api.tensol.ru',
    screenshot: 'off',
    video: 'off',
    trace: 'off',
    locale: 'en-US',
    timezoneId: 'UTC',
    ignoreHTTPSErrors: false,
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
