import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Import/discovery is offline. No webServer, global setup, .env loader, database
// client, external baseURL, or existing-server reuse. The future fixture owns it.
process.env.PLAYWRIGHT_BROWSERS_PATH = fileURLToPath(new URL('./.cache/ms-playwright', import.meta.url));

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 45_000,
  globalTimeout: 20 * 60_000,
  expect: { timeout: 8_000 },
  outputDir: '.cache/e2e-results',
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'off',
    video: 'off'
  },
  projects: [{ name: 'chromium-desktop' }]
});
