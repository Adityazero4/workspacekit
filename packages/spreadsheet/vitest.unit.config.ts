import { defineConfig } from 'vitest/config';
import { testAgainstWorkspaceSourcesWithoutABuild } from './vitest.shared.ts';

export default defineConfig({
  resolve: testAgainstWorkspaceSourcesWithoutABuild,
  test: {
    name: '@workspacekit/spreadsheet',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
