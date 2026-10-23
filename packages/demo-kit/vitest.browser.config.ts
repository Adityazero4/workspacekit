import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import {
  compileReactSourcesLikeTheBuild,
  spreadsheetWorkerDependencies,
  testAgainstWorkspaceSourcesWithoutABuild,
} from '../workspace/vitest.shared.ts';

export default defineConfig({
  resolve: testAgainstWorkspaceSourcesWithoutABuild,
  plugins: [compileReactSourcesLikeTheBuild()],
  optimizeDeps: {
    include: ['react/compiler-runtime', ...spreadsheetWorkerDependencies],
  },
  test: {
    name: 'demo-kit:browser',
    fileParallelism: false,
    include: ['test/**/*.browser.test.tsx'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
    },
  },
});
