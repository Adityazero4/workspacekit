import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@scope/core',
    exclude: [...configDefaults.exclude, 'test/**/*.perf.test.ts'],
  },
});
