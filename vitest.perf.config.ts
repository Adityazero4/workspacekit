import { defineConfig } from 'vitest/config';
import serverConfig from './packages/server/vitest.config.ts';

export default defineConfig({
  resolve: serverConfig.resolve,
  test: {
    name: 'perf',
    include: ['packages/*/test/**/*.perf.test.ts'],
    fileParallelism: false,
  },
});
