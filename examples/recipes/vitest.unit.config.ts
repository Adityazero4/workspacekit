import { defineConfig } from 'vitest/config';
import { testAgainstWorkspaceSources } from './vitest.shared.ts';

export default defineConfig({
  resolve: testAgainstWorkspaceSources,
  test: {
    name: 'recipes:unit',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
