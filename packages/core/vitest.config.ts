import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@workspacekit/core',
    exclude: [...configDefaults.exclude, 'test/**/*.perf.test.ts'],
  },
});
