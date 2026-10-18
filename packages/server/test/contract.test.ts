import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpAdapter } from '@scope/core/http';
import { createFileHandler, nodeFsStore } from '../src';
import { runAdapterContract } from '../../core/test/contract/adapter-contract';

runAdapterContract('http + server + nodeFsStore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fs-contract-'));
  const handler = createFileHandler({ store: nodeFsStore(dir), authorize: () => true, chunkSize: 4 });
  return {
    adapter: httpAdapter('http://t/api/files', { fetch: (i, init) => handler(new Request(i, init)) }),
    cleanup: () => rm(dir, { recursive: true }),
  };
});
