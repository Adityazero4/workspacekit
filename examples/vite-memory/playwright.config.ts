import { defineConfig, devices } from '@playwright/test';

const PREVIEW_PORT = 4173;

export default defineConfig({
  testDir: 'test',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PREVIEW_PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `vite build && vite preview --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
    url: `http://127.0.0.1:${PREVIEW_PORT}`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
