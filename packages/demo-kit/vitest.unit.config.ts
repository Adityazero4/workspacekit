import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@scope/demo-kit',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
