import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { testAgainstWorkspaceSourcesWithoutABuild } from '../../packages/workspace/vitest.shared.ts';

export default defineConfig({
  resolve: testAgainstWorkspaceSourcesWithoutABuild,
  test: {
    name: 'vite-memory:browser',
    include: ['test/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
