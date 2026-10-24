import { createTreeStore, type TreeSnapshot } from '@workspacekit/core';
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { expect, test } from 'vitest';
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  isDeletedFromTree,
  NO_TABS,
  openTab,
  pinTab,
  remapTabs,
  setTabDirty,
  withDeletedCleanTabsClosed,
  type TabsState,
} from '../src/tabs/tabs-store';

const paths = (state: TabsState): string[] => state.tabs.map((tab) => tab.path);
const opened = (...steps: Array<[string, 'preview' | 'pin']>): TabsState =>
  steps.reduce((state, [path, how]) => openTab(state, path, how), NO_TABS);

test('preview replaces preview; pin keeps', () => {
  let state = openTab(NO_TABS, 'a.txt');
  expect(state).toEqual({ tabs: [{ path: 'a.txt', preview: true, dirty: false }], active: 'a.txt' });
  state = openTab(state, 'b.txt', 'preview');
  expect(paths(state)).toEqual(['b.txt']);
  state = openTab(state, 'c.txt', 'pin');
  state = openTab(state, 'd.txt', 'preview');
  expect(state).toEqual({
    tabs: [
      { path: 'd.txt', preview: true, dirty: false },
      { path: 'c.txt', preview: false, dirty: false },
    ],
    active: 'd.txt',
  });
});

test('preview replaces the existing preview tab in place; opening a pinned tab as preview only activates it', () => {
  let state = opened(['a.txt', 'pin'], ['b.txt', 'preview'], ['c.txt', 'pin']);
  state = openTab(state, 'd.txt', 'preview');
  expect(paths(state)).toEqual(['a.txt', 'd.txt', 'c.txt']);
  expect(state.active).toBe('d.txt');
  const before = activateTab(state, 'a.txt');
  expect(openTab(before, 'a.txt', 'preview').tabs).toBe(before.tabs);
  expect(openTab(before, 'a.txt', 'preview').active).toBe('a.txt');
  const pinned = openTab(state, 'd.txt', 'pin');
  expect(pinned.tabs[1]).toEqual({ path: 'd.txt', preview: false, dirty: false });
  expect(openTab(pinned, 'e.txt', 'preview').tabs).toHaveLength(4);
});

test('setDirty pins', () => {
  const state = setTabDirty(opened(['a.txt', 'preview']), 'a.txt', true);
  expect(state.tabs).toEqual([{ path: 'a.txt', preview: false, dirty: true }]);
  expect(openTab(state, 'b.txt', 'preview').tabs).toHaveLength(2);
  expect(setTabDirty(state, 'a.txt', false).tabs).toEqual([{ path: 'a.txt', preview: false, dirty: false }]);
  expect(setTabDirty(state, 'a.txt', true)).toBe(state);
  expect(setTabDirty(state, 'missing.txt', true)).toBe(state);
});

test('closing the active tab activates the neighbour', () => {
  const state = activateTab(opened(['a', 'pin'], ['b', 'pin'], ['c', 'pin']), 'b');
  expect(closeTab(state, 'b')).toEqual({ tabs: state.tabs.filter((tab) => tab.path !== 'b'), active: 'c' });
  const last = activateTab(state, 'c');
  expect(closeTab(last, 'c').active).toBe('b');
  expect(closeTab(state, 'a').active).toBe('b');
  expect(closeTab(opened(['a', 'pin']), 'a')).toEqual(NO_TABS);
  expect(closeTab(state, 'missing')).toBe(state);
});

test('closeOthers keeps one tab and activates it; pin and activate ignore unknown paths', () => {
  const state = opened(['a', 'pin'], ['b', 'preview'], ['c', 'pin']);
  expect(closeOtherTabs(state, 'b')).toEqual({ tabs: [state.tabs[1]], active: 'b' });
  expect(closeOtherTabs(state, 'missing')).toBe(state);
  expect(pinTab(state, 'b').tabs[1]!.preview).toBe(false);
  expect(pinTab(state, 'a')).toBe(state);
  expect(activateTab(state, 'missing')).toBe(state);
});

test('rename and move of a folder remap open tabs below it', () => {
  const state = activateTab(
    opened(['src/a.ts', 'pin'], ['src/lib/b.ts', 'pin'], ['srcs/c.ts', 'pin']),
    'src/lib/b.ts',
  );
  const renamed = remapTabs(state, 'src', 'app');
  expect(paths(renamed)).toEqual(['app/a.ts', 'app/lib/b.ts', 'srcs/c.ts']);
  expect(renamed.active).toBe('app/lib/b.ts');
  expect(renamed.tabs[2]).toBe(state.tabs[2]);
  expect(remapTabs(state, 'elsewhere', 'x')).toBe(state);
});

test('a move onto an open path merges the two tabs into the first, keeping either one dirty', () => {
  const state = setTabDirty(opened(['b.txt', 'pin'], ['a.txt', 'pin']), 'a.txt', true);
  expect(remapTabs(state, 'a.txt', 'b.txt')).toEqual({
    tabs: [{ path: 'b.txt', preview: false, dirty: true }],
    active: 'b.txt',
  });
});

async function loadedSnapshot(): Promise<{ snapshot: () => TreeSnapshot; remove: (path: string) => void }> {
  const adapter = createMemoryAdapter({
    files: { 'kept.txt': '', 'gone.txt': '', 'dir/deep/file.txt': '', 'dir/x.txt': '' },
  });
  const store = createTreeStore(adapter, { fetchDepth: 1 });
  await store.loadFolder('');
  await store.loadFolder('dir');
  return {
    snapshot: store.getSnapshot,
    remove: (path) => store.applyChanges([{ type: 'deleted', path }]),
  };
}

test('a path counts as deleted only when a loaded listing lacks it or an ancestor of it', async () => {
  const tree = await loadedSnapshot();
  const deleted = (path: string): boolean => isDeletedFromTree(tree.snapshot(), path, '');
  expect(deleted('kept.txt')).toBe(false);
  expect(deleted('missing.txt')).toBe(true);
  expect(deleted('dir/deep/never-loaded.txt'), 'its folder is not loaded yet').toBe(false);
  expect(deleted('kept.txt/inside'), 'below a file').toBe(true);
  tree.remove('dir');
  expect(deleted('dir/deep/file.txt'), 'an ancestor was removed').toBe(true);
  expect(isDeletedFromTree(tree.snapshot(), 'outside/x.txt', 'dir'), 'outside the root').toBe(false);
});

test('deleting a file closes its clean tab and keeps a dirty one', async () => {
  const tree = await loadedSnapshot();
  const state = setTabDirty(
    opened(['kept.txt', 'pin'], ['gone.txt', 'pin'], ['dir/x.txt', 'pin']),
    'dir/x.txt',
    true,
  );
  const nothingMoving = (): boolean => false;
  expect(withDeletedCleanTabsClosed(state, tree.snapshot(), '', nothingMoving)).toBe(state);
  tree.remove('gone.txt');
  tree.remove('dir');
  expect(withDeletedCleanTabsClosed(state, tree.snapshot(), '', nothingMoving)).toEqual({
    tabs: [state.tabs[0], state.tabs[2]],
    active: 'dir/x.txt',
  });
  expect(
    withDeletedCleanTabsClosed(state, tree.snapshot(), '', (path) => path === 'gone.txt'),
    'a tab whose path a move in flight involves stays open',
  ).toBe(state);
});
