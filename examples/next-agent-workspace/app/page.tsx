'use client';
import { Workspace } from '@scope/workspace';
import { httpAdapter } from '@scope/core/http';
import '@scope/workspace/styles.css';

/**
 * The page: the workspace over the file API at `/api/files`.
 *
 * @example
 * <Files />
 */
export default function Files() {
  return <Workspace adapter={httpAdapter('/api/files')} />;
}
