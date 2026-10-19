import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeFsStore, type FileStore } from '../src';
import type * as FsPromises from 'node:fs/promises';

// Lets a test run code at the moment the store is about to read a given directory.
const hook: { onReaddir?: (dir: string) => Promise<void> } = {};
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof FsPromises>();
  return {
    ...real,
    readdir: (async (p: string, ...rest: unknown[]) => {
      const out = await (real.readdir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      const h = hook.onReaddir;
      if (h) {
        hook.onReaddir = undefined; // one shot
        await h(String(p));
      }
      return out;
    }) as typeof real.readdir,
  };
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let base: string;
let root: string;
let store: FileStore;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'race-')));
  root = path.join(base, 'root');
  await mkdir(path.join(base, 'outdir'));
  await writeFile(path.join(base, 'outdir', 'secret-passwords.txt'), 'S');
  await mkdir(path.join(root, 'a0', 'e'), { recursive: true });
  await writeFile(path.join(root, 'a0', 'e', 'plain.txt'), 'p');
  await mkdir(path.join(root, 'x', 'y', 'z'), { recursive: true });
  await mkdir(path.join(root, 'x', 'outdir'));
  // Fine where it is (-> root/x/outdir); after x/y/z replaces a0 it points at base/outdir.
  await symlink('../../outdir', path.join(root, 'x', 'y', 'z', 'e'));
  store = nodeFsStore(root);
});
afterEach(async () => {
  hook.onReaddir = undefined;
  await rm(base, { recursive: true, force: true });
});

describe('listing while the tree changes underneath', () => {
  /**
   * Walks are breadth-first, so by the time `x` is read, `a0/e` is already queued as a plain
   * directory. At that moment a concurrent API move swaps `a0` for `x/y/z`, turning `a0/e` into
   * a link that now leaves the root.
   */
  const swapWhenReadingX = (): { moved: Promise<unknown> } => {
    const state: { moved: Promise<unknown> } = { moved: Promise.resolve() };
    const arm = (): void => {
      hook.onReaddir = async (dir) => {
        if (!dir.endsWith(`${path.sep}x`)) return arm();
        state.moved = store.move('x/y/z', 'a0', { overwrite: true });
        // Without a lock the move completes here; with one it waits behind the reader, so stop waiting.
        await Promise.race([state.moved.catch(() => {}), sleep(150)]);
      };
    };
    arm();
    return state;
  };

  it('search never descends into a queued directory that became an escaping link', async () => {
    const state = swapWhenReadingX();
    const found = await store.search!('secret', 50);
    await state.moved;
    expect(found.map((e) => e.path)).toEqual([]);
  });

  it('list never returns entries from behind a queued directory that became an escaping link', async () => {
    const state = swapWhenReadingX();
    const listed = await store.list('', 5);
    await state.moved;
    expect(listed.map((e) => e.path).filter((p) => p.includes('secret'))).toEqual([]);
  });
});
