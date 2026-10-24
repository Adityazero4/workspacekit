import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import {
  compileReactSourcesLikeTheBuild,
  testAgainstWorkspaceSourcesWithoutABuild,
} from './vitest.shared.ts';

const productionReactLikeTheShippedApp = { 'process.env.NODE_ENV': JSON.stringify('production') };
const perfBudgetScale = {
  'process.env.PERF_BUDGET_SCALE': JSON.stringify(process.env.PERF_BUDGET_SCALE ?? '1'),
};
const chromiumFlagsForGc = ['--js-flags=--expose-gc'];

export default defineConfig({
  root: import.meta.dirname,
  resolve: testAgainstWorkspaceSourcesWithoutABuild,
  define: { ...productionReactLikeTheShippedApp, ...perfBudgetScale },
  oxc: { jsx: { runtime: 'automatic', development: false } },
  plugins: [compileReactSourcesLikeTheBuild()],
  optimizeDeps: {
    include: [
      'react',
      'react/jsx-runtime',
      'react/compiler-runtime',
      'react-dom/client',
      '@tanstack/react-virtual',
    ],
  },
  test: {
    name: 'spreadsheet:perf',
    reporters: ['verbose'],
    fileParallelism: false,
    include: ['test/**/*.perf.test.tsx'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { args: chromiumFlagsForGc } }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
