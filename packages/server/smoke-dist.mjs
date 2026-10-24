import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpAdapter } from '@workspacekit/core/http';
import { createFileHandler, nodeFsStore } from '@workspacekit/server';

const dir = await mkdtemp(join(tmpdir(), 'fs-smoke-'));
try {
  await writeFile(join(dir, 'a.txt'), 'hi');
  const handler = createFileHandler({ store: nodeFsStore(dir), authorize: () => true });
  const fs = httpAdapter('http://t/api/files', { fetch: (i, init) => handler(new Request(i, init)) });
  assert.deepEqual(
    (await fs.list('', { depth: 1 })).map((e) => e.path),
    ['a.txt'],
  );
  process.stdout.write('smoke-dist ok\n');
} finally {
  await rm(dir, { recursive: true });
}
