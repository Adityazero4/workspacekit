import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FsError } from '../src/errors';
import { createMemoryAdapter } from '../src/memory';
import { withPolling, type PollingOptions } from '../src/polling';
import type { ChangeEvent, Entry, FileSystemAdapter } from '../src/types';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const unreadable = (): Promise<never> => Promise.reject(new FsError('unknown'));

function memoryWithoutWatch(files: Record<string, string>) {
  const memory = createMemoryAdapter({ files });
  const { watch, emit, ...withoutWatch } = memory;
  return { memory, withoutWatch: withoutWatch as FileSystemAdapter };
}

function watchPolled(adapter: FileSystemAdapter, options: PollingOptions) {
  const batches: ChangeEvent[][] = [];
  const stop = withPolling(adapter, options).watch!((events) => batches.push(events));
  return { batches, stop };
}

function listRecorder(results: Array<'fail' | 'succeed'>) {
  const listedAt: number[] = [];
  const adapter: FileSystemAdapter = {
    read: unreadable,
    list: () => {
      listedAt.push(Date.now());
      return results.shift() === 'fail'
        ? Promise.reject(new FsError('network', 'offline'))
        : Promise.resolve([]);
    },
  };
  const gaps = (): number[] => listedAt.slice(1).map((at, index) => at - listedAt[index]!);
  return { adapter, listedAt, gaps };
}

const byTypeAndPath = (events: ChangeEvent[]): string[] =>
  events.map((event) => `${event.type} ${event.path}`).sort();

test('first poll is a baseline; later polls emit created/updated/deleted with entries', async () => {
  const { memory, withoutWatch } = memoryWithoutWatch({ 'a.txt': 'a', 'b.txt': 'b', 'dir/c.txt': 'c' });
  const { batches, stop } = watchPolled(withoutWatch, { paths: () => ['dir', ''] });

  await vi.advanceTimersByTimeAsync(3000);
  expect(batches, 'the first poll of each folder only sets its baseline').toEqual([]);

  await memory.write!('a.txt', 'changed');
  await memory.create!('new.txt', 'file');
  await memory.delete!('b.txt');
  await memory.move!('dir/c.txt', 'dir/d.txt');
  await vi.advanceTimersByTimeAsync(3000);

  expect(batches.length, 'one batch per round').toBe(1);
  const [batch] = batches as [ChangeEvent[]];
  expect(byTypeAndPath(batch)).toEqual([
    'created dir/d.txt',
    'created new.txt',
    'deleted b.txt',
    'deleted dir/c.txt',
    'updated a.txt',
  ]);
  expect(batch.every((event) => event.actor === 'external')).toBe(true);
  for (const event of batch.filter((each) => each.type !== 'deleted')) {
    expect(event.entry, event.path).toEqual(await memory.stat!(event.path));
  }
  expect(batch.filter((event) => event.type === 'deleted').map((event) => event.entry)).toEqual([
    undefined,
    undefined,
  ]);

  await vi.advanceTimersByTimeAsync(3000);
  expect(batches.length, 'nothing changed since the last round').toBe(1);
  stop();
});

test('a folder whose mtime changed with its children is not an update', async () => {
  const folderAt = (mtimeMs: number): Entry => ({ path: 'dir', name: 'dir', kind: 'directory', mtimeMs });
  const listings: Entry[][] = [[folderAt(1)], [folderAt(2)]];
  const adapter: FileSystemAdapter = {
    read: unreadable,
    list: () => Promise.resolve(listings.shift() ?? [folderAt(2)]),
  };
  const { batches, stop } = watchPolled(adapter, { paths: () => [''] });
  await vi.advanceTimersByTimeAsync(6000);
  expect(batches).toEqual([]);
  stop();
});

test('emitted paths are normalized like the listing the store normalizes', async () => {
  const entry: Entry = { path: '/dir//x.txt', name: 'x.txt', kind: 'file', size: 1, mtimeMs: 1 };
  const listings: Entry[][] = [[], [entry]];
  const adapter: FileSystemAdapter = {
    read: unreadable,
    list: () => Promise.resolve(listings.shift() ?? [entry]),
  };
  const { batches, stop } = watchPolled(adapter, { paths: () => ['dir'] });
  await vi.advanceTimersByTimeAsync(6000);
  expect(batches).toEqual([
    [{ type: 'created', path: 'dir/x.txt', actor: 'external', entry: { ...entry, path: 'dir/x.txt' } }],
  ]);
  stop();
});

test('failures back off to 30 s and success resets', async () => {
  const { adapter, gaps } = listRecorder(['fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'succeed']);
  const { stop } = watchPolled(adapter, { paths: () => [''] });
  await vi.advanceTimersByTimeAsync(3000 + 6000 + 12000 + 24000 + 30000 + 30000 + 30000 + 3000);
  expect(gaps()).toEqual([6000, 12000, 24000, 30000, 30000, 30000, 3000]);
  stop();
});

test('a folder that is gone is forgotten without backing off', async () => {
  const { memory, withoutWatch } = memoryWithoutWatch({ 'dir/c.txt': 'c' });
  const listed: string[] = [];
  const recording: FileSystemAdapter = {
    ...withoutWatch,
    list: (path, options) => {
      listed.push(path);
      return withoutWatch.list(path, options);
    },
  };
  const { batches, stop } = watchPolled(recording, { paths: () => ['dir', ''] });
  await vi.advanceTimersByTimeAsync(3000);
  await memory.delete!('dir');
  await vi.advanceTimersByTimeAsync(3000);
  expect(batches).toEqual([[{ type: 'deleted', path: 'dir', actor: 'external' }]]);
  listed.length = 0;
  await vi.advanceTimersByTimeAsync(3000);
  expect(listed, 'polled again at the normal interval').toEqual(['dir', '']);
  stop();
});

test('paused while hidden; one poll on resume', async () => {
  const { adapter, listedAt } = listRecorder([]);
  let hidden = true;
  let resume: (() => void) | undefined;
  const stopResumeSignal = vi.fn();
  const { stop } = watchPolled(adapter, {
    paths: () => [''],
    isPaused: () => hidden,
    resumeSignal: (poll) => {
      resume = poll;
      return stopResumeSignal;
    },
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(listedAt, 'nothing is polled while paused').toEqual([]);

  resume!();
  expect(listedAt, 'a resume signal while still paused polls nothing').toEqual([]);

  hidden = false;
  const resumedAt = Date.now();
  resume!();
  expect(listedAt, 'resuming polls at once').toEqual([resumedAt]);
  resume!();
  expect(listedAt, 'a resume while a round runs does not start another').toEqual([resumedAt]);

  await vi.advanceTimersByTimeAsync(3000);
  expect(listedAt, 'then at the normal interval').toEqual([resumedAt, resumedAt + 3000]);
  stop();
  expect(stopResumeSignal).toHaveBeenCalledOnce();
});

function resumable(results: Array<'fail' | 'succeed'>) {
  const recorder = listRecorder(results);
  const startedAt = Date.now();
  let resume: () => void = () => undefined;
  const { stop } = watchPolled(recorder.adapter, {
    paths: () => [''],
    resumeSignal: (poll) => {
      resume = poll;
      return () => undefined;
    },
  });
  const listedSinceStart = (): number[] => recorder.listedAt.map((at) => at - startedAt);
  return { listedSinceStart, resume: () => resume(), stop };
}

test('a resume signal sooner than the interval after the last round waits out the rest of it', async () => {
  const { listedSinceStart, resume, stop } = resumable([]);
  await vi.advanceTimersByTimeAsync(3000);
  await vi.advanceTimersByTimeAsync(1000);
  resume();
  resume();
  await vi.advanceTimersByTimeAsync(1999);
  expect(listedSinceStart(), 'no round before the interval is up').toEqual([3000]);
  await vi.advanceTimersByTimeAsync(1);
  expect(listedSinceStart()).toEqual([3000, 6000]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(listedSinceStart(), 'then at the normal interval').toEqual([3000, 6000, 9000]);
  stop();
});

test('after failures, a resume signal waits out the rest of the backoff', async () => {
  const { listedSinceStart, resume, stop } = resumable(['fail', 'fail']);
  await vi.advanceTimersByTimeAsync(9000);
  expect(listedSinceStart(), 'the second round came 6 s after the first').toEqual([3000, 9000]);
  await vi.advanceTimersByTimeAsync(1000);
  resume();
  await vi.advanceTimersByTimeAsync(10_999);
  expect(listedSinceStart(), 'nothing before the 12 s backoff is up').toEqual([3000, 9000]);
  await vi.advanceTimersByTimeAsync(1);
  expect(listedSinceStart()).toEqual([3000, 9000, 21_000]);
  stop();
});

test('unsubscribe stops all timers', async () => {
  let release!: () => void;
  let signal: AbortSignal | undefined;
  const adapter: FileSystemAdapter = {
    read: unreadable,
    list: (_path, options) => {
      signal = options.signal;
      return new Promise((resolve) => (release = () => resolve([])));
    },
  };
  const { batches, stop } = watchPolled(adapter, { paths: () => [''] });
  expect(vi.getTimerCount()).toBe(1);
  stop();
  expect(vi.getTimerCount(), 'stopped before the first round').toBe(0);

  const second = watchPolled(adapter, { paths: () => [''] });
  await vi.advanceTimersByTimeAsync(3000);
  expect(signal?.aborted).toBe(false);
  second.stop();
  expect(signal?.aborted, 'the listing in flight is aborted').toBe(true);
  release();
  await vi.advanceTimersByTimeAsync(60000);
  expect(vi.getTimerCount(), 'a round that ends after the unsubscribe schedules nothing').toBe(0);
  expect(batches).toEqual([]);
  expect(second.batches).toEqual([]);
});

test('polls at most maxFoldersPerRound distinct folders, in the order given', async () => {
  const listed: string[] = [];
  const adapter: FileSystemAdapter = {
    read: unreadable,
    list: (path) => {
      listed.push(path);
      return Promise.resolve([]);
    },
  };
  const { stop } = watchPolled(adapter, {
    paths: () => ['b', 'a', 'b', 'c', 'd'],
    maxFoldersPerRound: 3,
    intervalMs: 100,
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(listed).toEqual(['b', 'a', 'c']);
  stop();
});

test('a frozen adapter can be wrapped, listed and watched', async () => {
  const { memory, withoutWatch } = memoryWithoutWatch({ 'a.txt': 'a' });
  const polled = withPolling(Object.freeze(withoutWatch), { paths: () => [''] });
  const batches: ChangeEvent[][] = [];
  const stop = polled.watch!((events) => batches.push(events));
  expect('watch' in polled).toBe(true);
  expect((await polled.list('', { depth: 1 })).map((entry) => entry.path)).toEqual(['a.txt']);
  await memory.write!('b.txt', 'b');
  await vi.advanceTimersByTimeAsync(3000);
  expect(batches.map(byTypeAndPath)).toEqual([['created b.txt']]);
  stop();
});

test('the wrapped adapter keeps every other member, bound to the original', async () => {
  class ClassAdapter implements FileSystemAdapter {
    readonly #entries: Entry[] = [{ path: 'x.txt', name: 'x.txt', kind: 'file' }];
    list(): Promise<Entry[]> {
      return Promise.resolve(this.#entries);
    }
    read(): Promise<never> {
      return unreadable();
    }
  }
  const polled = withPolling(new ClassAdapter(), { paths: () => [] });
  expect(await polled.list('', { depth: 1 })).toEqual([{ path: 'x.txt', name: 'x.txt', kind: 'file' }]);
  expect(typeof polled.watch).toBe('function');
});

const ownChanges: Array<[string, (polled: FileSystemAdapter) => Promise<unknown>]> = [
  ['create', (polled) => polled.create!('dir/mine.txt', 'file')],
  ['write', (polled) => polled.write!('dir/c.txt', 'my own save')],
  ['move', (polled) => polled.move!('a.txt', 'dir/a.txt')],
  ['copy', (polled) => polled.copy!('a.txt', 'dir/a copy.txt')],
  ['delete', (polled) => polled.delete!('dir/c.txt')],
  [
    'direct upload',
    (polled) =>
      polled.upload!.direct('dir/up.txt', new Blob(['up']), { signal: new AbortController().signal }),
  ],
  [
    'chunked upload',
    async (polled) => {
      const chunked = polled.upload!.chunked!;
      const { uploadId } = await chunked.init('dir/big.txt', 2);
      await chunked.put(uploadId, 0, 0, new Blob(['up']), new AbortController().signal);
      return chunked.complete(uploadId);
    },
  ],
];

test.each(ownChanges)(
  "the user's own %s is not reported; an external change in the same round still is",
  async (_kind, changeOwnFiles) => {
    const { memory, withoutWatch } = memoryWithoutWatch({ 'a.txt': 'a', 'dir/c.txt': 'c' });
    const polled = withPolling(withoutWatch, { paths: () => ['', 'dir'] });
    const batches: ChangeEvent[][] = [];
    const stop = polled.watch!((events) => batches.push(events));
    await vi.advanceTimersByTimeAsync(3000);
    await changeOwnFiles(polled);
    await memory.write!('dir/external.txt', 'an agent edit');
    await vi.advanceTimersByTimeAsync(3000);
    expect(batches.map(byTypeAndPath)).toEqual([['created dir/external.txt']]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(batches.length, 'and nothing later either').toBe(1);
    stop();
  },
);

test("the user's own change that lands while its folder's listing is in flight is not reported", async () => {
  const { withoutWatch } = memoryWithoutWatch({ 'dir/c.txt': 'c' });
  let holdListings = false;
  const held: Array<() => void> = [];
  const gated: FileSystemAdapter = {
    ...withoutWatch,
    list: (path, options) => {
      const listedNow = withoutWatch.list(path, options);
      if (!holdListings) return listedNow;
      return new Promise((resolve) => held.push(() => resolve(listedNow)));
    },
  };
  const polled = withPolling(gated, { paths: () => ['dir'] });
  const batches: ChangeEvent[][] = [];
  const stop = polled.watch!((events) => batches.push(events));
  await vi.advanceTimersByTimeAsync(3000);
  holdListings = true;
  await vi.advanceTimersByTimeAsync(3000);
  expect(held.length, 'the listing is taken before the save').toBe(1);
  await polled.create!('dir/mine.txt', 'file');
  holdListings = false;
  held.shift()!();
  await vi.advanceTimersByTimeAsync(3000 + 3000);
  expect(batches).toEqual([]);
  stop();
});

test("a change after the app's own listing and before the first poll is reported by that poll", async () => {
  const { memory, withoutWatch } = memoryWithoutWatch({ 'a.txt': 'a', 'dir/c.txt': 'c' });
  const polled = withPolling(withoutWatch, { paths: () => ['', 'dir'] });
  const batches: ChangeEvent[][] = [];
  const stop = polled.watch!((events) => batches.push(events));
  await polled.list('', { depth: 2 });
  await memory.write!('a.txt', 'an agent edit');
  await memory.write!('dir/c.txt', 'below the listed folder');
  await vi.advanceTimersByTimeAsync(3000);
  expect(batches.map(byTypeAndPath), 'only the listed folder had a baseline').toEqual([['updated a.txt']]);
  stop();
});

test("the user's own change that lands while the app's own listing is in flight is not reported", async () => {
  const { withoutWatch } = memoryWithoutWatch({ 'dir/c.txt': 'c' });
  const held: Array<() => void> = [];
  const gated: FileSystemAdapter = {
    ...withoutWatch,
    list: (path, options) => {
      const listedNow = withoutWatch.list(path, options);
      return new Promise((resolve) => held.push(() => resolve(listedNow)));
    },
  };
  const polled = withPolling(gated, { paths: () => ['dir'] });
  const batches: ChangeEvent[][] = [];
  const stop = polled.watch!((events) => batches.push(events));
  const appListing = polled.list('dir', { depth: 1 });
  await polled.create!('dir/mine.txt', 'file');
  held.shift()!();
  await appListing;
  await vi.advanceTimersByTimeAsync(3000);
  held.shift()!();
  await vi.advanceTimersByTimeAsync(0);
  expect(batches).toEqual([]);
  stop();
});

test("the user's own change after the app's own listing and before the first poll is not reported", async () => {
  const { memory, withoutWatch } = memoryWithoutWatch({ 'dir/c.txt': 'c' });
  const polled = withPolling(withoutWatch, { paths: () => ['dir'] });
  const batches: ChangeEvent[][] = [];
  const stop = polled.watch!((events) => batches.push(events));
  await polled.list('dir', { depth: 1 });
  await polled.write!('dir/c.txt', 'my own save');
  await polled.create!('dir/mine.txt', 'file');
  await memory.write!('dir/agent.txt', 'an agent edit');
  await vi.advanceTimersByTimeAsync(3000);
  expect(batches.map(byTypeAndPath)).toEqual([['created dir/agent.txt']]);
  stop();
});

test("the app's own listing seeds a subscription that polls the folder through pollPaths", async () => {
  const { memory, withoutWatch } = memoryWithoutWatch({ 'dir/c.txt': 'c' });
  const polled = withPolling(withoutWatch, { paths: () => [''] });
  const batches: ChangeEvent[][] = [];
  const stop = polled.watch!((events) => batches.push(events), { pollPaths: () => ['dir'] });
  await polled.list('dir', { depth: 1 });
  await memory.write!('dir/c.txt', 'an agent edit');
  await vi.advanceTimersByTimeAsync(3000);
  expect(batches.map(byTypeAndPath)).toEqual([['updated dir/c.txt']]);
  stop();
});

test('a listing of a folder that is not polled is not kept', async () => {
  const { memory, withoutWatch } = memoryWithoutWatch({ 'a.txt': 'a', 'other/b.txt': 'b' });
  let polledFolders = ['other'];
  const polled = withPolling(withoutWatch, { paths: () => polledFolders });
  const batches: ChangeEvent[][] = [];
  const stop = polled.watch!((events) => batches.push(events));
  await polled.list('', { depth: 1 });
  await memory.write!('a.txt', 'changed before the root was polled');
  polledFolders = ['', 'other'];
  await vi.advanceTimersByTimeAsync(3000);
  expect(batches, "the root's first poll is its baseline").toEqual([]);
  stop();
});

test('a list that throws synchronously fails the round and polling goes on', async () => {
  const listedAt: number[] = [];
  const adapter: FileSystemAdapter = {
    read: unreadable,
    list: () => {
      listedAt.push(Date.now());
      if (listedAt.length === 1) throw new Error('thrown, not rejected');
      return Promise.resolve([]);
    },
  };
  const { stop } = watchPolled(adapter, { paths: () => [''] });
  const start = Date.now();
  await vi.advanceTimersByTimeAsync(3000 + 6000 + 3000);
  expect(listedAt.map((at) => at - start)).toEqual([3000, 9000, 12000]);
  stop();
});

test('paths() that throws fails the round and polling goes on', async () => {
  const { adapter, listedAt } = listRecorder([]);
  let pathCalls = 0;
  const { stop } = watchPolled(adapter, {
    paths: () => {
      if (++pathCalls === 1) throw new Error('no folders yet');
      return [''];
    },
  });
  const start = Date.now();
  await vi.advanceTimersByTimeAsync(3000 + 6000 + 3000);
  expect(listedAt.map((at) => at - start)).toEqual([9000, 12000]);
  stop();
});

test('a forbidden folder backs off on its own without slowing the others', async () => {
  const listed: string[] = [];
  const adapter: FileSystemAdapter = {
    read: unreadable,
    list: (path) => {
      listed.push(path);
      return path === 'locked' ? Promise.reject(new FsError('forbidden')) : Promise.resolve([]);
    },
  };
  const { stop } = watchPolled(adapter, { paths: () => ['locked', ''] });
  await vi.advanceTimersByTimeAsync(3000 * 6);
  expect(listed.filter((path) => path === '').length, 'the root is polled every round').toBe(6);
  expect(listed.filter((path) => path === 'locked').length, 'rounds 1, 3 and 6 only').toBe(3);
  stop();
});

test('changes made while a folder was forbidden are reported once it can be listed again', async () => {
  const { memory, withoutWatch } = memoryWithoutWatch({ 'locked/a.txt': 'a' });
  let denied = false;
  const adapter: FileSystemAdapter = {
    ...withoutWatch,
    list: (path, opts) =>
      denied && path === 'locked' ? Promise.reject(new FsError('forbidden')) : withoutWatch.list(path, opts),
  };
  const { batches, stop } = watchPolled(adapter, { paths: () => ['locked'] });
  await vi.advanceTimersByTimeAsync(3000);
  denied = true;
  await memory.create!('locked/added.txt', 'file');
  await vi.advanceTimersByTimeAsync(3000);
  denied = false;
  await vi.advanceTimersByTimeAsync(3000 * 2);
  expect(byTypeAndPath(batches.flat())).toEqual(['created locked/added.txt']);
  stop();
});

test("a poll that answers with more than the folder's children compares only its children", async () => {
  const { memory, withoutWatch } = memoryWithoutWatch({ 'a.txt': 'a', 'dir/c.txt': 'c' });
  const listingTwoLevels: FileSystemAdapter = {
    ...withoutWatch,
    list: (path, options) => memory.list(path, { ...options, depth: 2 }),
  };
  const polled = withPolling(listingTwoLevels, { paths: () => [''] });
  const batches: ChangeEvent[][] = [];
  const stop = polled.watch!((events) => batches.push(events));
  await polled.list('', { depth: 1 });
  await vi.advanceTimersByTimeAsync(3000);
  expect(batches, 'the first poll matches the baseline of the app listing').toEqual([]);
  await memory.write!('dir/c.txt', 'below the polled folder');
  await memory.write!('a.txt', 'an agent edit');
  await vi.advanceTimersByTimeAsync(3000);
  expect(batches.map(byTypeAndPath)).toEqual([['updated a.txt']]);
  stop();
});
