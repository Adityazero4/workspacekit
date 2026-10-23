import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import {
  compileReactSourcesLikeTheBuild,
  oneSharedLexicalInstance,
  testAgainstWorkspaceSourcesWithoutABuild,
} from './vitest.shared.ts';

export default defineConfig({
  resolve: testAgainstWorkspaceSourcesWithoutABuild,
  plugins: [compileReactSourcesLikeTheBuild()],
  optimizeDeps: { include: ['react/compiler-runtime', 'axe-core', ...oneSharedLexicalInstance] },
  test: {
    name: 'markdown:browser',
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
