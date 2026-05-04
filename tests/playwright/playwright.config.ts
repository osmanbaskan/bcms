import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config — beINport (https://beinport, internal CA TLS).
 * Auth flow: tests/playwright/auth.setup.ts → admin/admin123 → storageState.json
 * Tüm test'ler bu storageState'i reuse eder, login formunu tekrar geçmez.
 */
export default defineConfig({
  testDir: '.',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: './report', open: 'never' }]],

  use: {
    baseURL: process.env.BCMS_BASE_URL ?? 'https://beinport',
    ignoreHTTPSErrors: true,        // internal CA TLS
    viewport: { width: 1440, height: 900 },
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ignoreHTTPSErrors: true,
        storageState: './storage/auth.json',
      },
      dependencies: ['setup'],
    },
  ],
});
