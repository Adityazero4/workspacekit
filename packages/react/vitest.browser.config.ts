import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import {
  compileReactSourcesLikeTheBuild,
  testAgainstWorkspaceSourcesWithoutABuild,
} from './vitest.shared.ts';
import type { MouseStep } from './test/support/mouseStep.ts';

export default defineConfig({
  resolve: testAgainstWorkspaceSourcesWithoutABuild,
  plugins: [compileReactSourcesLikeTheBuild()],
  optimizeDeps: { include: ['react/compiler-runtime', 'utif2'] },
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
          opts: { colorScheme?: 'light' | 'dark' | null; reducedMotion?: 'reduce' | 'no-preference' | null },
        ) => {
          await ctx.page.emulateMedia(opts);
        },
        mouse: async (ctx, selector: string, steps: MouseStep[]) => {
          const box = await ctx.iframe.locator(selector).boundingBox();
          if (!box) throw new Error(`mouse: nothing on screen matches ${selector}`);
          const { mouse, keyboard } = ctx.page;
          let buttonHeld = false;
          try {
            for (const step of steps) {
              if (step === 'down') {
                await mouse.down();
                buttonHeld = true;
              } else if (step === 'up') {
                await mouse.up();
                buttonHeld = false;
              } else if ('wheel' in step) {
                if (!step.holding) {
                  await mouse.wheel(0, step.wheel);
                  continue;
                }
                await keyboard.down(step.holding);
                try {
                  await mouse.wheel(0, step.wheel);
                } finally {
                  await keyboard.up(step.holding);
                }
              } else await mouse.move(box.x + step.x, box.y + step.y);
            }
          } catch (error) {
            if (buttonHeld) await mouse.up();
            throw error;
          }
        },
      },
      instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
    },
  },
});
