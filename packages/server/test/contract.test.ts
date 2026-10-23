import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeFsStore } from '../src';
import { runStoreContract } from './support/store-contract';

runStoreContract('nodeFsStore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fs-contract-'));
  return { store: nodeFsStore(dir), cleanup: () => rm(dir, { recursive: true }) };
});
