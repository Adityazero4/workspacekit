import { defineConfig, devices } from '@playwright/test';

const PORT = 4320;

export default defineConfig({
  testDir: 'test',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm run build:site && node scripts/serve-out.mjs',
    url: `http://127.0.0.1:${PORT}`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: { NEXT_PUBLIC_DOCS_TEST: '1', PORT: String(PORT) },
  },
});
