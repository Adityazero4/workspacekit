import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const coreSource = (file: string): string => fileURLToPath(new URL(`../core/src/${file}`, import.meta.url));

const testAgainstWorkspaceSourcesWithoutABuild = {
  alias: [
    { find: /^@workspacekit\/core\/(http|memory)$/, replacement: coreSource('$1/index.ts') },
    { find: /^@workspacekit\/core\/docs$/, replacement: coreSource('docs/index.ts') },
    { find: /^@workspacekit\/core$/, replacement: coreSource('index.ts') },
  ],
};

export default defineConfig({
  resolve: testAgainstWorkspaceSourcesWithoutABuild,
  test: { exclude: [...configDefaults.exclude, 'test/**/*.perf.test.ts'] },
});
