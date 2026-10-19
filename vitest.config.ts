import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/server', 'packages/react/vitest.{unit,browser}.config.ts'],
  },
});
