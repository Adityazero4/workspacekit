'use client';
import { Workspace } from '@scope/workspace';
import { httpAdapter } from '@scope/core/http';
import '@scope/workspace/styles.css';

export default function Files() {
  return <Workspace adapter={httpAdapter('/api/files')} />;
}
