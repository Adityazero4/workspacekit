/**
 * The server half of the quick start.
 *
 * @example
 * const code = SERVER_SNIPPET;
 */
export const SERVER_SNIPPET = `// app/api/files/[...path]/route.ts
import { createFileHandler, nodeFsStore } from '@workspacekit/server';

const handler = createFileHandler({
  store: nodeFsStore(process.env.AGENT_WORKSPACE_DIR!),
  authorize: async (req, op, path) => isSignedIn(req),
});
export { handler as GET, handler as POST, handler as PUT, handler as DELETE };`;

/**
 * The browser half of the quick start.
 *
 * @example
 * const code = BROWSER_SNIPPET;
 */
export const BROWSER_SNIPPET = `// page.tsx
'use client';
import { Workspace } from '@workspacekit/workspace';
import { httpAdapter } from '@workspacekit/core/http';
import '@workspacekit/workspace/styles.css';

export default function Files() {
  return <Workspace adapter={httpAdapter('/api/files')} />;
}`;

/**
 * The install commands shown with copy buttons.
 *
 * @example
 * const [first] = INSTALL_COMMANDS;
 */
export const INSTALL_COMMANDS: readonly { label: string; command: string }[] = [
  { label: 'In the browser', command: 'pnpm add @workspacekit/workspace @workspacekit/core' },
  { label: 'On the server', command: 'pnpm add @workspacekit/server' },
];
