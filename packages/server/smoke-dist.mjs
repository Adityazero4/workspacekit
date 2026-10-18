// Smoke test against the BUILT dist via package exports (run after `pnpm build`).
// Bare specifiers resolve through exports maps: @scope/server by self-reference, @scope/core via node_modules.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpAdapter } from '@scope/core/http';
import { createFileHandler, nodeFsStore } from '@scope/server';

const dir = await mkdtemp(join(tmpdir(), 'fs-smoke-'));
try {
  await writeFile(join(dir, 'a.txt'), 'hi');
  const handler = createFileHandler({ store: nodeFsStore(dir), authorize: () => true });
  const fs = httpAdapter('http://t/api/files', { fetch: (i, init) => handler(new Request(i, init)) });
  assert.deepEqual((await fs.list('', { depth: 1 })).map((e) => e.path), ['a.txt']);
  console.log('smoke-dist ok');
} finally {
  await rm(dir, { recursive: true });
}
