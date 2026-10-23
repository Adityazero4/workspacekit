import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import {
  compileReactSourcesLikeTheBuild,
  spreadsheetWorkerDependencies,
  testAgainstWorkspaceSourcesWithoutABuild,
} from './vitest.shared.ts';

export default defineConfig({
  resolve: testAgainstWorkspaceSourcesWithoutABuild,
  plugins: [compileReactSourcesLikeTheBuild()],
  optimizeDeps: {
    include: ['react/compiler-runtime', 'axe-core', ...spreadsheetWorkerDependencies],
  },
  test: {
    name: 'workspace:browser',
    fileParallelism: false,
    include: ['test/**/*.browser.test.tsx'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      commands: {
        emulateMedia: async (ctx, options: { colorScheme?: 'light' | 'dark' | null }) => {
          await ctx.page.emulateMedia(options);
        },
      },
      instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
    },
  },
});
