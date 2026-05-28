import { defineConfig, devices } from '@playwright/test';

// Real-prod smoke against https://tensol.ru — no local dev server, no globalSetup.
export default defineConfig({
  testDir: './e2e',
  testMatch: /real-prod-smoke\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.PW_BASE_URL ?? 'https://tensol.ru',
    screenshot: 'only-on-failure',
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
