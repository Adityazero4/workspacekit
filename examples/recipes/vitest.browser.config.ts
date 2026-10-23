import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { compileReactSourcesLikeTheBuild } from '../../packages/workspace/vitest.shared.ts';
import { testAgainstWorkspaceSources } from './vitest.shared.ts';

export default defineConfig({
  resolve: testAgainstWorkspaceSources,
  plugins: [compileReactSourcesLikeTheBuild()],
  optimizeDeps: {
    include: [
      'react/compiler-runtime',
      'axe-core',
      '@scope/pdf > pdfjs-dist/legacy/build/pdf.mjs',
      '@scope/pdf > pdfjs-dist/legacy/web/pdf_viewer.mjs',
    ],
  },
  test: {
    name: 'recipes:browser',
    fileParallelism: false,
    include: ['src/**/*.browser.test.tsx'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      commands: {
        emulateMedia: async (ctx, options: { colorScheme?: 'light' | 'dark' | null }) => {
          await ctx.page.emulateMedia(options);
        },
      },
      instances: [{ browser: 'chromium' }],
    },
  },
});
