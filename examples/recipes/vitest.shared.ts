import { fileURLToPath } from 'node:url';
import { testAgainstWorkspaceSourcesWithoutABuild } from '../../packages/workspace/vitest.shared.ts';

const serverSource = fileURLToPath(new URL('../../packages/server/src/index.ts', import.meta.url));

/**
 * Vitest options that resolve `@workspacekit/*` imports to the packages' sources, so tests need no build.
 *
 * @example
 * export default defineConfig({ resolve: testAgainstWorkspaceSources });
 */
export const testAgainstWorkspaceSources: typeof testAgainstWorkspaceSourcesWithoutABuild = {
  alias: [
    { find: /^@workspacekit\/server$/, replacement: serverSource },
    ...testAgainstWorkspaceSourcesWithoutABuild.alias,
  ],
};
