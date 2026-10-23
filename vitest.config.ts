import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/server',
      'packages/_template',
      'packages/code/vitest.{unit,browser}.config.ts',
      'packages/demo-kit/vitest.{unit,browser}.config.ts',
      'packages/docx/vitest.{unit,browser}.config.ts',
      'packages/markdown/vitest.{unit,browser}.config.ts',
      'packages/pdf/vitest.{unit,browser}.config.ts',
      'packages/pptx/vitest.{unit,browser}.config.ts',
      'packages/react/vitest.{unit,browser}.config.ts',
      'packages/spreadsheet/vitest.{unit,browser}.config.ts',
      'packages/workspace/vitest.{unit,browser}.config.ts',
      'examples/recipes/vitest.{unit,browser}.config.ts',
      'examples/vite-memory/vitest.browser.config.ts',
    ],
  },
});
