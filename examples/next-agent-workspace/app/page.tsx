'use client';
import { Workspace } from '@workspacekit/workspace';
import { httpAdapter } from '@workspacekit/core/http';
import '@workspacekit/workspace/styles.css';

/**
 * The page: the workspace over the file API at `/api/files`.
 *
 * @example
 * <Files />
 */
export default function Files() {
  return <Workspace adapter={httpAdapter('/api/files')} />;
}
