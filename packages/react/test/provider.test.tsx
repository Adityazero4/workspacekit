import { FsError, statusOf, type ChangeEvent, type Entry, type FileSystemAdapter } from '@workspacekit/core';
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { followMove } from '../src/actions/followMove';
import { FileSystemProvider, type FileSystemProviderProps } from '../src/provider/FileSystemProvider';
import { useEntryState, useFileSystem, type FileSystemContext } from '../src/provider/hooks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const mount = async (ui: ReactNode, opts?: Parameters<typeof createRoot>[1]): Promise<Root> => {
  const root = createRoot(document.createElement('div'), opts);
  await act(async () => root.render(ui));
  return root;
};
/** Lets the memory adapter's promise chains and the store's microtask notifications run. */
const settle = (): Promise<void> =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });

/** Renders a provider and hands back its context. */
const withContext = async (
  props: Omit<FileSystemProviderProps, 'children'>,
  extra?: ReactNode,
): Promise<{ ctx: () => FileSystemContext; root: Root }> => {
  let ctx: FileSystemContext | undefined;
  const Grab = (): null => {
    ctx = useFileSystem();
    return null;
  };
  const root = await mount(
    <FileSystemProvider {...props}>
      <Grab />
      {extra}
    </FileSystemProvider>,
  );
  await settle();
  return { ctx: () => ctx!, root };
};

test('useFileSystem outside the provider throws a message naming FileSystemProvider', async () => {
  const Bare = (): null => {
    useFileSystem();
    return null;
  };
  // act rethrows the render error
  await expect(mount(<Bare />)).rejects.toThrow(
    /outside <FileSystemProvider>\. Wrap.*See https:\/\/\S+\/docs\/concepts\/adapter#provider-and-hooks/s,
  );
});

test('provider loads the root and disposes the store on unmount', async () => {
  const adapter = createMemoryAdapter({ files: { 'a.txt': 'a' } });
  const list = vi.spyOn(adapter, 'list');
  let ctx: FileSystemContext | undefined;
  const Grab = (): null => {
    ctx = useFileSystem();
    return null;
  };
  const tree = (a: FileSystemAdapter): ReactNode => (
    <FileSystemProvider adapter={a}>
      <Grab />
    </FileSystemProvider>
  );
  const root = await mount(tree(adapter));
  await settle();
  const first = ctx!.store;
  expect(list).toHaveBeenCalledWith('', expect.objectContaining({ depth: 2 }));
  expect(statusOf(first.getSnapshot().tree, '')).toBe('loaded');
  const disposeFirst = vi.spyOn(first, 'dispose');

  // a new adapter gets a new store; the old one is disposed
  await act(async () => root.render(tree(createMemoryAdapter())));
  await settle();
  expect(disposeFirst).toHaveBeenCalledTimes(1);
  const second = ctx!.store;
  expect(second).not.toBe(first);
  const disposeSecond = vi.spyOn(second, 'dispose');

  await act(async () => root.unmount());
  expect(disposeSecond).toHaveBeenCalledTimes(1);
});

test('useEntryState re-renders only the row whose path changed', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 99; i++) files[`d/f${String(i).padStart(2, '0')}`] = 'x';
  const paths = ['d', ...Object.keys(files)];
  expect(paths).toHaveLength(100);
  const renders = new Map<string, number>();
  const Probe = ({ path }: { path: string }): null => {
    useEntryState(path);
    renders.set(path, (renders.get(path) ?? 0) + 1);
    return null;
  };
  const { ctx, root } = await withContext(
    { adapter: createMemoryAdapter({ files }) },
    paths.map((p) => <Probe key={p} path={p} />),
  );
  expect(statusOf(ctx().store.getSnapshot().tree, 'd')).toBe('loaded');
  renders.clear();

  await act(async () => void (await ctx().store.rename('d/f42', 'g42')));
  await settle();

  const rerendered = [...renders.keys()];
  expect(rerendered).toContain('d/f42');
  expect(rerendered.every((p) => p === 'd/f42' || p === 'd')).toBe(true);
  await act(async () => root.unmount());
});

test('expanding a folder loads it once', async () => {
  const adapter = createMemoryAdapter({ files: { 'd/x.txt': 'x' } });
  const list = vi.spyOn(adapter, 'list');
  const { ctx, root } = await withContext({ adapter, fetchDepth: 1 });
  const loadsOfD = (): number => list.mock.calls.filter(([p]) => p === 'd').length;
  expect(loadsOfD()).toBe(0);

  await act(async () => ctx().expanded.set((s) => new Set(s).add('d')));
  await settle();
  expect(loadsOfD()).toBe(1);
  expect(statusOf(ctx().store.getSnapshot().tree, 'd')).toBe('loaded');

  // collapse and expand again: already loaded
  await act(async () => ctx().expanded.set(new Set()));
  await act(async () => ctx().expanded.set(new Set(['d'])));
  await settle();
  expect(loadsOfD()).toBe(1);
  await act(async () => root.unmount());
});

test('expanded set persists with storageKey and survives a reload', async () => {
  const adapter = createMemoryAdapter({ files: { 'd/x.txt': 'x', 'e/y.txt': 'y' } });
  const first = await withContext({ adapter, storageKey: 'ws' });
  await act(async () => first.ctx().expanded.set(new Set(['d'])));
  expect(localStorage.getItem('ws:expanded')).toBeNull(); // debounced
  window.dispatchEvent(new Event('pagehide'));
  expect(JSON.parse(localStorage.getItem('ws:expanded')!)).toEqual(['d']);

  await act(async () => {
    first.ctx().expanded.set(new Set(['d', 'e']));
    first.ctx().sort.set({ by: 'mtime', direction: 'desc' });
    first.ctx().showHidden.set(true);
  });
  await act(async () => first.root.unmount()); // flushes

  const second = await withContext({ adapter, storageKey: 'ws' });
  expect([...second.ctx().expanded.get()]).toEqual(['d', 'e']);
  expect(second.ctx().sort.get()).toEqual({ by: 'mtime', direction: 'desc' });
  expect(second.ctx().showHidden.get()).toBe(true);
  await act(async () => second.root.unmount());
});

test('localStorage throwing does not break the provider', async () => {
  const boom = (): never => {
    throw new DOMException('denied', 'SecurityError');
  };
  vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom, clear: (): void => {} });
  const adapter = createMemoryAdapter({ files: { 'd/x.txt': 'x' } });
  const { ctx, root } = await withContext({ adapter, storageKey: 'ws', fetchDepth: 1 });
  expect(statusOf(ctx().store.getSnapshot().tree, '')).toBe('loaded');
  await act(async () => ctx().expanded.set(new Set(['d'])));
  await settle();
  window.dispatchEvent(new Event('pagehide'));
  expect(statusOf(ctx().store.getSnapshot().tree, 'd')).toBe('loaded');
  await act(async () => root.unmount());
});

test('onError receives store load failures but not cancellations', async () => {
  const mem = createMemoryAdapter({ files: { 'bad/x': 'x', 'gone/y': 'y' } });
  const forbidden = new FsError('forbidden', 'no access to bad');
  const adapter: FileSystemAdapter = {
    ...mem,
    list: async (path, opts) => {
      if (path === 'bad') throw forbidden;
      if (path === 'gone') throw new FsError('cancelled');
      return mem.list(path, opts);
    },
  };
  const onError = vi.fn();
  const { ctx, root } = await withContext({ adapter, fetchDepth: 1, onError });
  await act(async () => ctx().expanded.set(new Set(['bad', 'gone'])));
  await settle();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith(forbidden);

  // provider-level reports go through the same filter
  const onNotify = vi.fn();
  await act(async () => root.unmount());
  const again = await withContext({ adapter, onError, onNotify });
  again.ctx().notify({ kind: 'error', message: 'cancelled', error: new FsError('cancelled') });
  expect(onNotify).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledTimes(1);
  await act(async () => again.root.unmount());
});

test('under StrictMode the store survives the double mount: root listed and watch events applied', async () => {
  const adapter = createMemoryAdapter({ files: { 'a.txt': 'a' } });
  let ctx: FileSystemContext | undefined;
  const Grab = (): null => {
    ctx = useFileSystem();
    return null;
  };
  const root = await mount(
    <StrictMode>
      <FileSystemProvider adapter={adapter}>
        <Grab />
      </FileSystemProvider>
    </StrictMode>,
  );
  await settle();
  const names = (): string[] => [...(ctx!.store.getSnapshot().tree.folders.get('')?.children.keys() ?? [])];
  expect(names()).toEqual(['a.txt']);
  await act(async () => void (await adapter.create!('b.txt', 'file'))); // reaches the store only through watch
  await settle();
  expect(names()).toContain('b.txt');
  await act(async () => root.unmount());
});

test('restored expanded paths: outside the root dropped, missing ones removed silently; session failures still report', async () => {
  const adapter = createMemoryAdapter({ files: { 'w/d/x.txt': 'x', 'other/y.txt': 'y' } });
  localStorage.setItem('ws:expanded', JSON.stringify(['other', 'w/d', 'w/gone', 'w/../other', 7]));
  const onError = vi.fn();
  const first = await withContext({ adapter, root: 'w', storageKey: 'ws', fetchDepth: 1, onError });
  expect([...first.ctx().expanded.get()]).toEqual(['w/d']);
  expect(statusOf(first.ctx().store.getSnapshot().tree, 'w/d')).toBe('loaded');
  expect(onError).not.toHaveBeenCalled();
  await act(async () => first.root.unmount());
  expect(JSON.parse(localStorage.getItem('ws:expanded')!)).toEqual(['w/d']);

  const second = await withContext({ adapter, root: 'w', fetchDepth: 1, onError });
  await act(async () => second.ctx().expanded.set(new Set(['w/nope'])));
  await settle();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'not_found' }));
  expect(second.ctx().expanded.get().has('w/nope')).toBe(true);
  await act(async () => second.root.unmount());
});

test('switching the adapter resets expanded and selected', async () => {
  const files = { 'd/x.txt': 'x' };
  let ctx: FileSystemContext | undefined;
  const Grab = (): null => {
    ctx = useFileSystem();
    return null;
  };
  const tree = (a: FileSystemAdapter): ReactNode => (
    <FileSystemProvider adapter={a}>
      <Grab />
    </FileSystemProvider>
  );
  const root = await mount(tree(createMemoryAdapter({ files })));
  await settle();
  await act(async () => {
    ctx!.expanded.set(new Set(['d']));
    ctx!.selected.set('d/x.txt');
  });
  await act(async () => root.render(tree(createMemoryAdapter({ files }))));
  await settle();
  expect(ctx!.expanded.get().size).toBe(0);
  expect(ctx!.selected.get()).toBeNull();
  await act(async () => root.unmount());
});

test('switching storageKey loads the new key and never writes the old state under it', async () => {
  const adapter = createMemoryAdapter({ files: { 'd/x.txt': 'x', 'e/y.txt': 'y' } });
  localStorage.setItem('B:expanded', JSON.stringify(['e']));
  let ctx: FileSystemContext | undefined;
  const Grab = (): null => {
    ctx = useFileSystem();
    return null;
  };
  const tree = (key: string): ReactNode => (
    <FileSystemProvider adapter={adapter} storageKey={key}>
      <Grab />
    </FileSystemProvider>
  );
  const root = await mount(tree('A'));
  await settle();
  await act(async () => {
    ctx!.expanded.set(new Set(['d'])); // queued for A, not yet flushed
    ctx!.showHidden.set(true);
  });
  await act(async () => root.render(tree('B')));
  await settle();
  expect([...ctx!.expanded.get()]).toEqual(['e']);
  expect(ctx!.showHidden.get()).toBe(false);
  await act(async () => root.unmount());
  expect(JSON.parse(localStorage.getItem('A:expanded')!)).toEqual(['d']);
  expect(JSON.parse(localStorage.getItem('B:expanded')!)).toEqual(['e']);
  expect(localStorage.getItem('B:hidden')).toBeNull();
});

test('hiddenNames keeps its identity across renders with an equal inline hidden array', async () => {
  const adapter = createMemoryAdapter();
  let ctx: FileSystemContext | undefined;
  const Grab = (): null => {
    ctx = useFileSystem();
    return null;
  };
  const tree = (hidden: string[]): ReactNode => (
    <FileSystemProvider adapter={adapter} hidden={hidden}>
      <Grab />
    </FileSystemProvider>
  );
  const root = await mount(tree(['.git', 'dist']));
  const first = ctx!.hiddenNames;
  await act(async () => root.render(tree(['.git', 'dist'])));
  expect(ctx!.hiddenNames).toBe(first);
  await act(async () => root.render(tree(['.git'])));
  expect([...ctx!.hiddenNames]).toEqual(['.git']);
  await act(async () => root.unmount());
});

test('restored folders covered by the root listing are not listed again', async () => {
  const adapter = createMemoryAdapter({ files: { 'd/x.txt': 'x' } });
  const list = vi.spyOn(adapter, 'list');
  localStorage.setItem('ws:expanded', JSON.stringify(['d']));
  const { ctx, root } = await withContext({ adapter, storageKey: 'ws' });
  expect(statusOf(ctx().store.getSnapshot().tree, 'd')).toBe('loaded');
  expect(list.mock.calls.map(([p]) => p)).toEqual(['']);
  await act(async () => root.unmount());
});

test('fetchDepth NaN renders without a re-render loop', async () => {
  const { ctx, root } = await withContext({ adapter: createMemoryAdapter(), fetchDepth: Number.NaN });
  expect(ctx().store).toBeDefined();
  await act(async () => root.unmount());
});

test('a restored expanded path that is now a file is removed silently', async () => {
  const adapter = createMemoryAdapter({ files: { 'd/x.txt': 'x', 'was-dir': 'now a file' } });
  localStorage.setItem('ws:expanded', JSON.stringify(['d', 'was-dir']));
  const onError = vi.fn();
  const { ctx, root } = await withContext({ adapter, storageKey: 'ws', fetchDepth: 1, onError });
  expect([...ctx().expanded.get()]).toEqual(['d']);
  expect(onError).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  expect(JSON.parse(localStorage.getItem('ws:expanded')!)).toEqual(['d']);
});

test('open tabs persist with storageKey; restored tabs that no longer exist are dropped silently, dirty is not restored', async () => {
  const adapter = createMemoryAdapter({
    files: { 'w/a.txt': 'a', 'w/d/e/f/deep.txt': 'x', 'other/y.txt': 'y' },
  });
  localStorage.setItem(
    'ws:tabs',
    JSON.stringify({
      tabs: [
        { path: 'w/a.txt', preview: false, dirty: true },
        { path: 'w/gone.txt', preview: false, dirty: false },
        { path: 'w/d/e/f/deep.txt', preview: true, dirty: false },
        { path: 'w/d/e/f/deep-gone.txt', preview: false, dirty: false },
        { path: 'other/y.txt', preview: false, dirty: false },
        { path: 'w/../other/y.txt', preview: false, dirty: false },
        { path: 'w/a.txt', preview: true, dirty: false },
        { path: 7 },
      ],
      active: 'w/gone.txt',
    }),
  );
  const onError = vi.fn();
  const first = await withContext({ adapter, root: 'w', storageKey: 'ws', fetchDepth: 1, onError });
  expect(first.ctx().tabs.get()).toEqual({
    tabs: [
      { path: 'w/a.txt', preview: true, dirty: false },
      { path: 'w/d/e/f/deep.txt', preview: true, dirty: false },
    ],
    active: 'w/d/e/f/deep.txt',
  });
  expect(onError).not.toHaveBeenCalled();
  await act(async () => first.ctx().tabs.set((state) => ({ ...state, active: 'w/a.txt' })));
  await act(async () => first.root.unmount());

  const second = await withContext({ adapter, root: 'w', storageKey: 'ws', fetchDepth: 1 });
  expect(second.ctx().tabs.get().active).toBe('w/a.txt');
  await act(async () => second.root.unmount());
});

test('an external move remaps open tabs, expanded folders and the selection', async () => {
  const adapter = createMemoryAdapter({ files: { 'src/lib/a.ts': 'a', 'src/b.ts': 'b' } });
  const { ctx, root } = await withContext({ adapter });
  await act(async () => {
    ctx().expanded.set(new Set(['src', 'src/lib']));
    ctx().selected.set('src/lib/a.ts');
    ctx().tabs.set({
      tabs: [{ path: 'src/lib/a.ts', preview: false, dirty: false }],
      active: 'src/lib/a.ts',
    });
  });
  await act(async () => {
    await adapter.move!('src', 'app');
  });
  await settle();
  expect([...ctx().expanded.get()]).toEqual(['app', 'app/lib']);
  expect(ctx().selected.get()).toBe('app/lib/a.ts');
  expect(ctx().tabs.get()).toEqual({
    tabs: [{ path: 'app/lib/a.ts', preview: false, dirty: false }],
    active: 'app/lib/a.ts',
  });
  await act(async () => root.unmount());
});

test('a followMove rename moves tabs and expanded state once, before the store call, with no flash or double remap', async () => {
  const adapter = createMemoryAdapter({ files: { 'src/lib/a.ts': 'a' } });
  const { ctx, root } = await withContext({ adapter });
  await act(async () => {
    ctx().expanded.set(new Set(['src']));
    ctx().tabs.set({
      tabs: [{ path: 'src/lib/a.ts', preview: false, dirty: false }],
      active: 'src/lib/a.ts',
    });
  });
  const expandedSeen: string[][] = [];
  const tabsSeen: string[][] = [];
  ctx().expanded.subscribe(() => expandedSeen.push([...ctx().expanded.get()]));
  ctx().tabs.subscribe(() =>
    tabsSeen.push(
      ctx()
        .tabs.get()
        .tabs.map((tab) => tab.path),
    ),
  );
  await act(async () => {
    await followMove(ctx(), 'src', 'app', () => ctx().store.rename('src', 'app'));
  });
  await settle();
  expect(expandedSeen).toEqual([['app']]);
  expect(tabsSeen).toEqual([['app/lib/a.ts']]);
  await act(async () => root.unmount());
});

test('a Replace through followMove drops the replaced entry state and keeps the moved one, once', async () => {
  const adapter = createMemoryAdapter({ files: { 'a/x/1.txt': '', 'b/old/2.txt': '' } });
  const { ctx, root } = await withContext({ adapter });
  await act(async () => {
    ctx().expanded.set(new Set(['a', 'a/x', 'b', 'b/old']));
    ctx().selected.set('a');
    ctx().tabs.set({
      tabs: [
        { path: 'b/old/2.txt', preview: false, dirty: false },
        { path: 'a/x/1.txt', preview: false, dirty: false },
      ],
      active: 'a/x/1.txt',
    });
  });
  await act(async () => {
    await followMove(ctx(), 'a', 'b', () => ctx().store.move('a', '', { name: 'b', overwrite: true }));
  });
  await settle();
  expect([...ctx().expanded.get()].sort()).toEqual(['b', 'b/x']);
  expect(ctx().selected.get()).toBe('b');
  expect(
    ctx()
      .tabs.get()
      .tabs.map((tab) => tab.path),
  ).toEqual(['b/x/1.txt']);
  await act(async () => root.unmount());
});

test('a failed followMove keeps a clean tab open at the source', async () => {
  const adapter = createMemoryAdapter({ files: { 'a.txt': 'a' } });
  const failing: FileSystemAdapter = {
    ...adapter,
    move: async () => {
      await Promise.resolve();
      throw new FsError('unknown', 'the server refused');
    },
  };
  const { ctx, root } = await withContext({ adapter: failing });
  await act(async () =>
    ctx().tabs.set({ tabs: [{ path: 'a.txt', preview: false, dirty: false }], active: 'a.txt' }),
  );
  await act(async () => {
    await followMove(ctx(), 'a.txt', 'b.txt', () => ctx().store.rename('a.txt', 'b.txt')).catch(
      () => undefined,
    );
  });
  await settle();
  expect(
    ctx()
      .tabs.get()
      .tabs.map((tab) => tab.path),
  ).toEqual(['a.txt']);
  await act(async () => root.unmount());
});

test('a Replace through followMove forgets the replaced entry state even with no state under the source', async () => {
  const adapter = createMemoryAdapter({ files: { 'a/x/1.txt': '', 'b/old/2.txt': '' } });
  const { ctx, root } = await withContext({ adapter });
  await act(async () => {
    ctx().expanded.set(new Set(['b', 'b/old']));
    ctx().selected.set('b/old/2.txt');
  });
  await act(async () => {
    await followMove(ctx(), 'a', 'b', () => ctx().store.move('a', '', { name: 'b', overwrite: true }));
  });
  await settle();
  expect([...ctx().expanded.get()]).toEqual(['b']);
  expect(ctx().selected.get()).toBeNull();
  await act(async () => root.unmount());
});

test('renaming a to b and then c to a while the first is in flight keeps both folders expanded', async () => {
  const adapter = createMemoryAdapter({ files: { 'a/1.txt': '', 'c/2.txt': '' }, latencyMs: 20 });
  const { ctx, root } = await withContext({ adapter });
  await act(async () => {
    await ctx().store.loadFolder('');
    ctx().expanded.set(new Set(['a', 'c']));
  });
  for (const folder of ['a', 'c']) {
    await vi.waitFor(() => expect(statusOf(ctx().store.getSnapshot().tree, folder)).toBe('loaded'));
  }
  await settle();
  await act(async () => {
    await Promise.all([
      followMove(ctx(), 'a', 'b', () => ctx().store.rename('a', 'b')),
      followMove(ctx(), 'c', 'a', () => ctx().store.rename('c', 'a')),
    ]);
  });
  await settle();
  expect([...ctx().expanded.get()].sort()).toEqual(['a', 'b']);
  await act(async () => root.unmount());
});

test('an external move onto an existing path drops the replaced entry state and moves the source state', async () => {
  const adapter = createMemoryAdapter({ files: { 'a/x/1.txt': '', 'b/old/2.txt': '' } });
  const { ctx, root } = await withContext({ adapter });
  await act(async () => {
    ctx().expanded.set(new Set(['a', 'a/x', 'b', 'b/old']));
    ctx().selected.set('b/old/2.txt');
    ctx().tabs.set({
      tabs: [
        { path: 'b/old/2.txt', preview: false, dirty: false },
        { path: 'a/x/1.txt', preview: false, dirty: false },
      ],
      active: 'a/x/1.txt',
    });
  });
  await settle();
  await act(async () => {
    await adapter.move!('a', 'b', { overwrite: true });
  });
  await settle();
  expect([...ctx().expanded.get()].sort()).toEqual(['b', 'b/x']);
  expect(ctx().selected.get()).toBeNull();
  expect(ctx().tabs.get()).toEqual({
    tabs: [{ path: 'b/x/1.txt', preview: false, dirty: false }],
    active: 'b/x/1.txt',
  });
  await act(async () => root.unmount());
});

test('an external move onto an existing path drops the replaced entry state even with no state under the source', async () => {
  const adapter = createMemoryAdapter({ files: { 'a/x/1.txt': '', 'b/old/2.txt': '' } });
  const { ctx, root } = await withContext({ adapter });
  await act(async () => {
    ctx().expanded.set(new Set(['b', 'b/old']));
    ctx().selected.set('b/old/2.txt');
  });
  await act(async () => {
    await adapter.move!('a', 'b', { overwrite: true });
  });
  await settle();
  expect([...ctx().expanded.get()]).toEqual(['b']);
  expect(ctx().selected.get()).toBeNull();
  await act(async () => root.unmount());
});

test('an external move from the source of a followMove in flight, to another path, is still followed', async () => {
  const adapter = createMemoryAdapter({ files: { 'a/1.txt': '', 'c/old/2.txt': '' } });
  const { ctx, root } = await withContext({ adapter });
  await act(async () => {
    ctx().expanded.set(new Set(['c', 'c/old']));
    ctx().selected.set('c/old/2.txt');
  });
  let resolveMove: (entry: Entry) => void = () => undefined;
  let following: Promise<Entry> | undefined;
  await act(async () => {
    following = followMove(ctx(), 'a', 'b', () => new Promise<Entry>((resolve) => (resolveMove = resolve)));
  });
  await act(async () => {
    await adapter.move!('a', 'c', { overwrite: true });
  });
  await settle();
  expect([...ctx().expanded.get()], 'the replaced c lost its expanded folders').toEqual(['c']);
  expect(ctx().selected.get()).toBeNull();
  await act(async () => {
    resolveMove({ path: 'b', name: 'b', kind: 'directory' });
    await following;
  });
  await act(async () => root.unmount());
});

test('late echoes of a ping-pong of followed renames leave the moved entry state alone', async () => {
  const inner = createMemoryAdapter({ files: { 'a/x/1.txt': '' } });
  const held: ChangeEvent[][] = [];
  let deliver: (events: ChangeEvent[]) => void = () => undefined;
  const adapter: FileSystemAdapter = {
    ...inner,
    watch: (listener) => {
      deliver = listener;
      return inner.watch!((events) => held.push(events));
    },
  };
  const { ctx, root } = await withContext({ adapter });
  await act(async () => {
    await ctx().store.loadFolder('a');
    ctx().expanded.set(new Set(['a', 'a/x']));
    ctx().selected.set('a/x/1.txt');
  });
  await settle();
  for (const [from, to] of [
    ['a', 'b'],
    ['b', 'a'],
    ['a', 'b'],
  ] as const) {
    await act(async () => {
      await followMove(ctx(), from, to, () => ctx().store.rename(from, to));
    });
    await settle();
  }
  const before = { expanded: [...ctx().expanded.get()].sort(), selected: ctx().selected.get() };
  expect(before).toEqual({ expanded: ['b', 'b/x'], selected: 'b/x/1.txt' });
  await act(async () => {
    for (const events of held.splice(0)) deliver(events);
  });
  await settle();
  expect({ expanded: [...ctx().expanded.get()].sort(), selected: ctx().selected.get() }).toEqual(before);
  await act(async () => root.unmount());
});

test('a followMove the server completes under another name moves the state there once', async () => {
  const inner = createMemoryAdapter({ files: { 'a/x/1.txt': '' } });
  const adapter: FileSystemAdapter = {
    ...inner,
    move: async (from) => inner.move!(from, 'b (1)'),
  };
  const { ctx, root } = await withContext({ adapter });
  await act(async () => {
    await ctx().store.loadFolder('a');
    ctx().expanded.set(new Set(['a', 'a/x']));
    ctx().selected.set('a/x/1.txt');
  });
  await act(async () => {
    await followMove(ctx(), 'a', 'b', () => ctx().store.rename('a', 'b'));
  });
  await settle();
  expect([...ctx().expanded.get()].sort()).toEqual(['b (1)', 'b (1)/x']);
  expect(ctx().selected.get()).toBe('b (1)/x/1.txt');
  await act(async () => root.unmount());
});

test('a Replace that the adapter completes under another name forgets the state where the entry landed', async () => {
  const inner = createMemoryAdapter({
    files: { 'a/x/1.txt': '', 'b/old/2.txt': '', 'b (1)/stale/3.txt': '' },
  });
  const adapter: FileSystemAdapter = {
    ...inner,
    move: async (from) => inner.move!(from, 'b (1)', { overwrite: true }),
  };
  const { ctx, root } = await withContext({ adapter });
  await act(async () => {
    ctx().expanded.set(new Set(['b', 'b/old', 'b (1)', 'b (1)/stale']));
    ctx().selected.set('b (1)/stale/3.txt');
  });
  await act(async () => {
    await followMove(ctx(), 'a', 'b', () => ctx().store.move('a', '', { name: 'b', overwrite: true }));
  });
  await settle();
  expect([...ctx().expanded.get()].sort()).toEqual(['b', 'b (1)', 'b/old']);
  expect(ctx().selected.get()).toBeNull();
  await act(async () => root.unmount());
});

class PrivateFieldAdapter implements FileSystemAdapter {
  readonly #inner = createMemoryAdapter({ files: { 'src/a.txt': 'a' } });
  readonly pollPathsSeen: Array<(() => readonly string[]) | undefined> = [];

  list: FileSystemAdapter['list'] = (path, options) => this.#inner.list(path, options);
  read: FileSystemAdapter['read'] = ((path: string, as: 'text') =>
    this.#inner.read(path, as)) as FileSystemAdapter['read'];
  watch: FileSystemAdapter['watch'] = (onChange, options) => {
    this.pollPathsSeen.push(options?.pollPaths);
    return this.#inner.watch!(onChange);
  };
}

test('an adapter with #private fields keeps working behind the provider, and watch gets the folders shown', async () => {
  const adapter = new PrivateFieldAdapter();
  const onError = vi.fn();
  await withContext({ adapter, root: 'src', onError });
  expect(onError).not.toHaveBeenCalled();
  expect(adapter.pollPathsSeen).toHaveLength(1);
  expect(adapter.pollPathsSeen[0]!()).toContain('src');
});

test('a frozen adapter with watch keeps working behind the provider', async () => {
  const adapter = Object.freeze(createMemoryAdapter({ files: { 'src/a.txt': 'a' } }));
  const onError = vi.fn();
  const { ctx, root } = await withContext({ adapter, onError });
  expect(onError).not.toHaveBeenCalled();
  expect(statusOf(ctx().store.getSnapshot().tree, '')).toBe('loaded');
  await act(async () => root.unmount());
});
