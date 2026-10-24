import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@workspacekit/demo-kit',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
