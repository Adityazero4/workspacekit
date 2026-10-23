import { createFileHandler, nodeFsStore } from '@scope/server';
import { isSignedIn } from '../../../../lib/auth';

/**
 * The file API: serves `AGENT_WORKSPACE_DIR` under `/api/files` to requests that `isSignedIn` accepts.
 *
 * @example
 * export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
 */
const handler = createFileHandler({
  store: nodeFsStore(process.env.AGENT_WORKSPACE_DIR!),
  authorize: async (req) => isSignedIn(req),
});
export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
