'use client';
import { Workspace } from '@workspacekit/workspace';
import { httpAdapter } from '@workspacekit/core/http';
import '@workspacekit/workspace/styles.css';

export default function Files() {
  return <Workspace adapter={httpAdapter('/api/files')} />;
}
