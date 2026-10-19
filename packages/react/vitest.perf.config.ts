import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import {
  compileReactSourcesLikeTheBuild,
  testAgainstWorkspaceSourcesWithoutABuild,
} from './vitest.shared.ts';

const productionReactLikeTheShippedApp = { 'process.env.NODE_ENV': JSON.stringify('production') };
const skipOnSlowMachines = { 'process.env.CI_SLOW': JSON.stringify(process.env.CI_SLOW ?? '') };
const BENCH_PAGE_TIMEOUT_MS = 600_000;
const chromiumFlagsForGcAndExactHeapSizes = ['--js-flags=--expose-gc', '--enable-precise-memory-info'];

export default defineConfig({
  root: import.meta.dirname,
  resolve: testAgainstWorkspaceSourcesWithoutABuild,
  define: { ...productionReactLikeTheShippedApp, ...skipOnSlowMachines },
  oxc: { jsx: { runtime: 'automatic', development: false } },
  plugins: [compileReactSourcesLikeTheBuild()],
  optimizeDeps: { include: ['react', 'react/jsx-runtime', 'react/compiler-runtime', 'react-dom/client'] },
  test: {
    name: 'react:perf',
    fileParallelism: false,
    include: ['test/scale.browser.test.tsx'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { args: chromiumFlagsForGcAndExactHeapSizes } }),
      instances: [{ browser: 'chromium' }],
      commands: {
        firstRenderInAFreshPage: async (ctx, shape: string, files: number): Promise<number> => {
          const page = await ctx.page.context().newPage();
          try {
            await page.goto(new URL(`/bench/index.html?shape=${shape}&size=${files}`, ctx.page.url()).href);
            await page.waitForFunction('"bench" in window', undefined, { timeout: BENCH_PAGE_TIMEOUT_MS });
            return await page.evaluate<number>('window.bench.firstRenderMs()');
          } finally {
            await page.close();
          }
        },
      },
    },
  },
});
