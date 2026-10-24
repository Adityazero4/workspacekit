import { createTreeStore, entryAt, FsError, type Entry, type FileSystemAdapter } from '@workspacekit/core';
import { createMemoryAdapter, type MemoryAdapter } from '@workspacekit/core/memory';
import { afterEach, expect, test } from 'vitest';
import type { FollowedMove } from '../src/actions/followMove';
import { createEditBuffers, type EditBuffers } from '../src/editing/buffers';
import { createUiStore, type UiStore } from '../src/provider/ui-store';
import { NO_TABS, type TabsState } from '../src/tabs/tabs-store';

interface Session {
  memory: MemoryAdapter;
  buffers: EditBuffers;
  followedMoves: UiStore<ReadonlySet<FollowedMove>>;
  tabs: UiStore<TabsState>;
  moved: (from: string, to: string) => void;
  reload: () => Promise<void>;
  treeEntry: (path: string) => Entry | undefined;
}

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function session(
  files: Record<string, string>,
  adapt: (memory: MemoryAdapter) => FileSystemAdapter = (memory) => memory,
): Promise<Session> {
  const memory = createMemoryAdapter({ files });
  const store = createTreeStore(adapt(memory));
  const movedListeners = new Set<(from: string, to: string) => void>();
  const followedMoves = createUiStore<ReadonlySet<FollowedMove>>(new Set());
  const tabs = createUiStore(NO_TABS);
  const buffers = createEditBuffers({
    adapter: adapt(memory),
    store,
    root: '',
    tabs,
    followedMoves,
    onMovedPaths: (listener) => {
      movedListeners.add(listener);
      return () => void movedListeners.delete(listener);
    },
  });
  stops.push(buffers.connect(), store.dispose);
  await store.loadFolder('', { force: true });
  return {
    memory,
    buffers,
    followedMoves,
    tabs,
    moved: (from, to) => {
      for (const listener of [...movedListeners]) listener(from, to);
    },
    treeEntry: (path) => entryAt(store.getSnapshot().tree, path),
    reload: async () => {
      await store.loadFolder('', { force: true });
      await settled();
    },
  };
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const versionOf = async (memory: MemoryAdapter, path: string): Promise<number | undefined> =>
  (await memory.stat!(path))?.mtimeMs;

function held(): { wait: () => Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { wait: () => gate, release };
}

test('a save while a followed move covers the file waits, then writes at the final path', async () => {
  const gate = held();
  const writes: string[] = [];
  const { memory, buffers, followedMoves, moved } = await session({ 'a.txt': 'A' }, (memory) => ({
    ...memory,
    write: (path, text, options) => {
      writes.push(path);
      return memory.write!(path, text, options);
    },
  }));
  buffers.edit('a.txt', 'A mine', await versionOf(memory, 'a.txt'));
  const move: FollowedMove = { from: 'a.txt', to: 'b.txt' };
  followedMoves.set(new Set([move]));
  moved('a.txt', 'b.txt');
  const saving = buffers.flush('b.txt');
  await settled();
  expect(writes, 'nothing is written while the move is in flight').toEqual([]);

  void gate.wait().then(async () => {
    await memory.move!('a.txt', 'b.txt');
    followedMoves.set(new Set());
  });
  gate.release();
  await saving;
  expect(writes).toEqual(['b.txt']);
  expect(buffers.get('b.txt')?.status).toBe('saved');
  expect(await memory.read('b.txt', 'text')).toBe('A mine');
});

test('with watch, the echo of a save that lands while typing goes on is not a conflict', async () => {
  const gate = held();
  const { memory, buffers } = await session({ 'a.txt': 'A' }, (memory) => ({
    ...memory,
    write: async (path, text, options) => {
      const entry = await memory.write!(path, text, options);
      await gate.wait();
      return entry;
    },
  }));
  buffers.edit('a.txt', 'A1', await versionOf(memory, 'a.txt'));
  const firstSave = buffers.flush('a.txt');
  await settled();
  buffers.edit('a.txt', 'A12', undefined);
  await settled();
  gate.release();
  await firstSave;
  await settled();
  expect(buffers.get('a.txt')?.status).toBe('dirty');
  await buffers.flush('a.txt');
  expect(buffers.get('a.txt')?.status).toBe('saved');
  expect(await memory.read('a.txt', 'text')).toBe('A12');
});

test('a version someone else writes while a save is in flight is kept in the tree and is a conflict', async () => {
  const gate = held();
  let agentVersion: number | undefined;
  const { memory, buffers, treeEntry } = await session({ 'a.txt': 'A' }, (memory) => ({
    ...memory,
    write: async (path, text, options) => {
      const entry = await memory.write!(path, text, options);
      if (text === 'A1') agentVersion = (await memory.write!(path, 'agent')).mtimeMs;
      await gate.wait();
      return entry;
    },
  }));
  buffers.edit('a.txt', 'A1', await versionOf(memory, 'a.txt'));
  const saving = buffers.flush('a.txt');
  await settled();
  buffers.edit('a.txt', 'A12', undefined);
  gate.release();
  await saving;
  await settled();
  expect(treeEntry('a.txt')?.mtimeMs, 'our older write never replaces theirs in the tree').toBe(agentVersion);
  expect(buffers.get('a.txt')?.status).toBe('conflict');
  expect(await memory.read('a.txt', 'text')).toBe('agent');
});

test('Keep mine on a file that is gone marks it deleted, and Save then creates it', async () => {
  let gone = false;
  const { memory, buffers } = await session({ 'a.txt': 'A' }, (memory) => ({
    ...memory,
    stat: (path, options) => (gone ? Promise.resolve(null) : memory.stat!(path, options)),
  }));
  buffers.edit('a.txt', 'mine', await versionOf(memory, 'a.txt'));
  await memory.write!('a.txt', 'agent');
  await settled();
  expect(buffers.get('a.txt')?.status).toBe('conflict');
  gone = true;
  await buffers.keepMine('a.txt');
  expect(buffers.get('a.txt')?.status).toBe('deleted');
  expect(await memory.read('a.txt', 'text'), 'nothing written').toBe('agent');
  await memory.delete!('a.txt');
  await buffers.recreate('a.txt');
  expect(await memory.read('a.txt', 'text')).toBe('mine');
  expect(buffers.get('a.txt')?.status).toBe('saved');
});

test('Keep mine refuses a server copy without a modification time', async () => {
  const writes: string[] = [];
  const { memory, buffers } = await session({ 'a.txt': 'A' }, (memory) => ({
    ...memory,
    stat: async (path) => {
      const entry = await memory.stat!(path);
      return entry && { path: entry.path, name: entry.name, kind: entry.kind };
    },
    write: (path, text, options) => {
      writes.push(text);
      return memory.write!(path, text, options);
    },
  }));
  buffers.edit('a.txt', 'mine', await versionOf(memory, 'a.txt'));
  await memory.write!('a.txt', 'agent');
  await settled();
  await expect(buffers.keepMine('a.txt')).rejects.toThrow(/Save mine as a copy/);
  expect(writes).toEqual([]);
  expect(buffers.get('a.txt')?.status).toBe('conflict');
});

test('Save of a deleted file is a conflict when something is at the path again, never a blind write', async () => {
  const { memory, buffers } = await session({ 'a.txt': 'A' });
  buffers.edit('a.txt', 'mine', await versionOf(memory, 'a.txt'));
  await memory.delete!('a.txt');
  await settled();
  expect(buffers.get('a.txt')?.status).toBe('deleted');
  await memory.upload!.direct('a.txt', new Blob(['new from the agent']), {
    signal: new AbortController().signal,
  });
  await buffers.recreate('a.txt');
  expect(buffers.get('a.txt')?.status).toBe('conflict');
  expect(await memory.read('a.txt', 'text')).toBe('new from the agent');
});

test('without a known version, nothing is written; a version without mtime is a conflict', async () => {
  const writes: string[] = [];
  const { memory, buffers } = await session({ 'a.txt': 'A', 'b.txt': 'B' }, (memory) => ({
    ...memory,
    write: (path, text, options) => {
      writes.push(text);
      return memory.write!(path, text, options);
    },
    list: async (path, options) =>
      (await memory.list(path, options)).map((entry) =>
        entry.name === 'b.txt' ? { path: entry.path, name: entry.name, kind: entry.kind } : entry,
      ),
  }));
  buffers.edit('b.txt', 'mine', undefined);
  await buffers.flush('b.txt');
  expect(writes, 'never a write without a version over a file that exists').toEqual([]);
  expect(buffers.get('b.txt')?.status).toBe('conflict');

  buffers.edit('a.txt', 'mine', await versionOf(memory, 'a.txt'));
  memory.emit([{ type: 'updated', path: 'a.txt', entry: { path: 'a.txt', name: 'a.txt', kind: 'file' } }]);
  await settled();
  expect(buffers.get('a.txt')?.status, 'a version without mtime cannot be confirmed').toBe('conflict');
});

test('Save mine as a copy never writes over a file created at that name meanwhile', async () => {
  let raceTheNextListing = false;
  const { memory, buffers } = await session({ 'a.txt': 'A' }, (memory) => ({
    ...memory,
    list: async (path, options) => {
      const listed = await memory.list(path, options);
      if (raceTheNextListing) await memory.write!('a copy.txt', 'raced in');
      raceTheNextListing = false;
      return listed;
    },
  }));
  buffers.edit('a.txt', 'mine', await versionOf(memory, 'a.txt'));
  raceTheNextListing = true;
  await expect(buffers.saveCopy('a.txt')).rejects.toBeInstanceOf(FsError);
  expect(await memory.read('a copy.txt', 'text')).toBe('raced in');
  expect(buffers.get('a.txt')?.text).toBe('mine');
});

test('Save mine as a copy removes the empty copy when writing it fails', async () => {
  const { memory, buffers } = await session({ 'a.txt': 'A' }, (memory) => ({
    ...memory,
    write: (path, text, options) =>
      path === 'a copy.txt'
        ? Promise.reject(new FsError('network', 'offline'))
        : memory.write!(path, text, options),
  }));
  buffers.edit('a.txt', 'mine', await versionOf(memory, 'a.txt'));
  await expect(buffers.saveCopy('a.txt')).rejects.toThrow('offline');
  expect(await memory.stat!('a copy.txt')).toBeNull();
  expect(buffers.get('a.txt')?.text).toBe('mine');
});

test('a replacing move keeps the replaced edits as an unsaved copy beside it, with its tab', async () => {
  const { memory, buffers, tabs, moved } = await session({ 'a.txt': 'A', 'b.txt': 'B' });
  buffers.edit('a.txt', 'A edited', await versionOf(memory, 'a.txt'));
  buffers.edit('b.txt', 'B with my unsaved work', await versionOf(memory, 'b.txt'));
  await memory.move!('a.txt', 'b.txt', { overwrite: true });
  moved('a.txt', 'b.txt');
  await settled();
  expect(buffers.get('b.txt')?.text).toBe('A edited');
  expect(buffers.get('b copy.txt')).toMatchObject({ text: 'B with my unsaved work', status: 'deleted' });
  expect(tabs.get().tabs).toEqual([{ path: 'b copy.txt', preview: false, dirty: true }]);
  await buffers.recreate('b copy.txt');
  expect(await memory.read('b copy.txt', 'text')).toBe('B with my unsaved work');
});

test('Save of a copy set aside after its save had landed writes the whole text there', async () => {
  const gate = held();
  let writesHeld = 0;
  const { memory, buffers, moved } = await session({ 'a.txt': 'A', 'b.txt': 'B' }, (memory) => ({
    ...memory,
    write: async (path, text, options) => {
      const entry = await memory.write!(path, text, options);
      if (++writesHeld === 1) await gate.wait();
      return entry;
    },
  }));
  buffers.edit('b.txt', 'B unsaved', await versionOf(memory, 'b.txt'));
  void buffers.flush('b.txt');
  await settled();
  buffers.edit('a.txt', 'A edited', await versionOf(memory, 'a.txt'));
  await memory.move!('a.txt', 'b.txt', { overwrite: true });
  moved('a.txt', 'b.txt');
  gate.release();
  await settled();
  expect(buffers.get('b copy.txt')?.status).toBe('deleted');
  await buffers.recreate('b copy.txt');
  expect(await memory.read('b copy.txt', 'text')).toBe('B unsaved');
  expect(buffers.get('b copy.txt')?.status).toBe('saved');
});

test('Save of a file deleted after its save had landed writes the whole text again', async () => {
  const gate = held();
  let writesHeld = 0;
  const { memory, buffers } = await session({ 'a.txt': 'A' }, (memory) => ({
    ...memory,
    write: async (path, text, options) => {
      const entry = await memory.write!(path, text, options);
      if (++writesHeld === 1) await gate.wait();
      return entry;
    },
  }));
  buffers.edit('a.txt', 'mine', await versionOf(memory, 'a.txt'));
  void buffers.flush('a.txt');
  await settled();
  await memory.delete!('a.txt');
  gate.release();
  await settled();
  expect(buffers.get('a.txt')?.status).toBe('deleted');
  await buffers.recreate('a.txt');
  expect(await memory.read('a.txt', 'text')).toBe('mine');
});

test('Save of a deleted file never overwrites a file that appears at its path meanwhile', async () => {
  let armed = false;
  const agentWritesOnce = async (memory: MemoryAdapter): Promise<void> => {
    if (!armed) return;
    armed = false;
    await memory.write!('a.txt', 'AGENT');
  };
  const { memory, buffers, reload } = await session({ 'a.txt': 'A' }, (memory) => ({
    ...memory,
    watch: undefined,
    stat: async (path, options) => {
      const entry = await memory.stat!(path, options);
      await agentWritesOnce(memory);
      return entry;
    },
    create: async (path, kind) => {
      await agentWritesOnce(memory);
      return memory.create!(path, kind);
    },
  }));
  buffers.edit('a.txt', 'mine', await versionOf(memory, 'a.txt'));
  await memory.delete!('a.txt');
  await reload();
  expect(buffers.get('a.txt')?.status).toBe('deleted');
  armed = true;
  await buffers.recreate('a.txt');
  expect(await memory.read('a.txt', 'text')).toBe('AGENT');
  expect(buffers.get('a.txt')?.status).toBe('conflict');
});

test.each(['discard', 'takeTheirs'] as const)(
  'a save deferred by a move never writes once the edits were dropped (%s)',
  async (drop) => {
    const writes: string[] = [];
    const { memory, buffers, followedMoves } = await session({ 'a.txt': 'A' }, (memory) => ({
      ...memory,
      write: (path, text, options) => {
        writes.push(text);
        return memory.write!(path, text, options);
      },
    }));
    buffers.edit('a.txt', 'mine', await versionOf(memory, 'a.txt'));
    followedMoves.set(new Set([{ from: 'a.txt', to: 'x.txt' }]));
    const deferred = buffers.flush('a.txt');
    await settled();
    const dropping = drop === 'discard' ? buffers.discard('a.txt') : buffers.takeTheirs('a.txt');
    followedMoves.set(new Set());
    await Promise.all([deferred, dropping]);
    await settled();
    expect(writes).toEqual([]);
    expect(await memory.read('a.txt', 'text')).toBe('A');
  },
);

test('typing while Save mine as a copy writes keeps the newer edits instead of taking theirs', async () => {
  const gate = held();
  const { memory, buffers } = await session({ 'a.txt': 'A' }, (memory) => ({
    ...memory,
    write: async (path, text, options) => {
      if (path === 'a copy.txt') await gate.wait();
      return memory.write!(path, text, options);
    },
  }));
  const version = await versionOf(memory, 'a.txt');
  buffers.edit('a.txt', 'mine', version);
  await memory.write!('a.txt', 'agent');
  await settled();
  const copying = buffers.saveCopy('a.txt');
  await settled();
  buffers.edit('a.txt', 'mine + more typing', version);
  gate.release();
  expect(await copying).toMatchObject({ copyPath: 'a copy.txt', editsKept: true });
  expect(await memory.read('a copy.txt', 'text')).toBe('mine');
  expect(buffers.get('a.txt')).toMatchObject({ text: 'mine + more typing', status: 'conflict' });
});

test('ending the session while a save is in flight still saves the text typed during that save', async () => {
  const firstWrite = held();
  let writes = 0;
  const { memory, buffers } = await session({ 'a.txt': 'A' }, (memory) => ({
    ...memory,
    write: async (path, text, options) => {
      writes++;
      if (writes === 1) await firstWrite.wait();
      return memory.write!(path, text, options);
    },
  }));
  const version = await versionOf(memory, 'a.txt');
  buffers.edit('a.txt', 'A1', version);
  void buffers.flush('a.txt');
  buffers.edit('a.txt', 'A12', version);
  for (const stop of stops.splice(0)) stop();
  firstWrite.release();
  await expect.poll(() => memory.read('a.txt', 'text')).toBe('A12');
});
