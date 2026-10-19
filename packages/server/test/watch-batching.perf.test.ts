import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileHandler, nodeFsStore, type FileStore } from '../src';
import { armed, sleep, sse, watchReq } from './watch-fixture';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

let base: string;
let root: string;
let store: FileStore;
beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'watch-')));
  root = path.join(base, 'srv'); // not 'root': macOS may also report the watched directory itself under its own name
  await mkdir(root);
  await sleep(150); // macOS replays recent events of the new directory to a watcher started right away
  store = nodeFsStore(root, { exclude: ['.git'] });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const make = (): ((req: Request) => Promise<Response>) => createFileHandler({ store, authorize: () => true });
const disk = (p: string, text = 'x'): Promise<void> => writeFile(path.join(root, p), text);

// Coalescing depends on wall-clock gaps between fs events (50 ms of quiet closes a batch). CI_SLOW=1 skips it.
describe.skipIf(env.CI_SLOW)('watch route batching budget', () => {
  it('writing 1,000 files in a loop arrives in <= 5 batches', async () => {
    const res = await make()(watchReq());
    const s = sse(res);
    await armed();
    await mkdir(path.join(root, 'many'));
    for (let i = 0; i < 1000; i++) await disk(`many/f${i}.txt`, String(i));
    const frames = await s.until(1000, 10_000);
    expect(frames.length).toBeLessThanOrEqual(5);
    await s.reader.cancel();
  });
});
