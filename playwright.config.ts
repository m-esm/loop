import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  use: { headless: true, viewport: { width: 1440, height: 900 } },
  webServer: {
    command: 'npm run dev -w @loop/web -- --port 3100',
    url: 'http://127.0.0.1:3100',
    env: { NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3101/api' },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
