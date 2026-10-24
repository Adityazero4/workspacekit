import { defineConfig } from 'vitest/config';
import { testAgainstWorkspaceSourcesWithoutABuild } from './vitest.shared.ts';

export default defineConfig({
  resolve: testAgainstWorkspaceSourcesWithoutABuild,
  test: {
    name: '@workspacekit/code',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
