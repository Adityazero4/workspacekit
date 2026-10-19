import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import {
  compileReactSourcesLikeTheBuild,
  testAgainstWorkspaceSourcesWithoutABuild,
} from './vitest.shared.ts';

export default defineConfig({
  resolve: testAgainstWorkspaceSourcesWithoutABuild,
  plugins: [compileReactSourcesLikeTheBuild()],
  optimizeDeps: { include: ['react/compiler-runtime'] },
  test: {
    name: 'react:browser',
    fileParallelism: false,
    setupFiles: ['test/support/releaseFocusAfterEachFile.ts'],
    include: ['test/**/*.browser.test.tsx'],
    exclude: ['test/scale.browser.test.tsx'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      commands: {
        emulateMedia: async (
          ctx,
          opts: { colorScheme?: 'light' | 'dark' | null; reducedMotion?: 'reduce' | null },
        ) => {
          await ctx.page.emulateMedia(opts);
        },
      },
      instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
    },
  },
});
