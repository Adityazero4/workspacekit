import { treeRowRenders } from './support/countComponentRenders';
import { statusOf } from '@scope/core';
import { createMemoryAdapter } from '@scope/core/memory';
import { useEffect } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { useFileSystem, type FileSystemContext } from '../src/provider/hooks';
import { internalsOf } from '../src/provider/internals';
import { FileTree } from '../src/tree/FileTree';
import { animationFrames } from './support/animationFrames';
import { interactionSettled } from './support/interactionSettled';

const ROW_HEIGHT = 24;
const FILES = Object.fromEntries(
  Array.from({ length: 100_000 }, (_, i) => [`f${String(i).padStart(6, '0')}.txt`, '']),
);

function CaptureContext({ onContext }: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => {
    onContext(fs);
  });
  return null;
}

const PAST_THE_VIRTUALIZERS_SCROLL_RESET_MS = 1000;
const rowCount = (): number => document.querySelectorAll('[role=treeitem]').length;

const mount = async (): Promise<{
  fs: FileSystemContext;
  adapter: ReturnType<typeof createMemoryAdapter>;
}> => {
  const adapter = createMemoryAdapter({ files: FILES });
  let captured: FileSystemContext | undefined;
  await render(
    <FileSystemProvider adapter={adapter}>
      <FileTree rowHeight={ROW_HEIGHT} style={{ height: 10 * ROW_HEIGHT }} />
      <CaptureContext onContext={(fs) => (captured = fs)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => captured && statusOf(captured.store.getSnapshot().tree, '')).toBe('loaded');
  await expect.poll(rowCount).toBeGreaterThan(0);
  await interactionSettled();
  return { fs: captured!, adapter };
};

const measure = async (action: () => void): Promise<{ updates: number; mounts: number }> => {
  treeRowRenders.updates = 0;
  treeRowRenders.mounts = 0;
  action();
  await interactionSettled();
  return { ...treeRowRenders };
};

test('scrolling by 3 rows renders only the entering rows', async () => {
  await mount();
  const scroller = document.querySelector<HTMLElement>('[data-fs-part=tree-viewport]')!;
  treeRowRenders.updates = 0;
  treeRowRenders.mounts = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    scroller.scrollTop = 3 * ROW_HEIGHT;
    await animationFrames(2);
    await vi.advanceTimersByTimeAsync(PAST_THE_VIRTUALIZERS_SCROLL_RESET_MS);
  } finally {
    vi.useRealTimers();
  }
  await interactionSettled();
  expect(treeRowRenders, 'also after the end of scrolling re-renders the tree').toEqual({
    updates: 0,
    mounts: 3,
  });
});

test('an unrelated off-screen change renders no rows', async () => {
  const { fs, adapter } = await mount();
  const renders = await measure(() =>
    adapter.emit([{ type: 'updated', path: 'f099999.txt', actor: 'agent' }]),
  );
  expect(fs.store.getSnapshot().changed.has('f099999.txt'), 'the change did reach the store').toBe(true);
  expect(renders).toEqual({ updates: 0, mounts: 0 });
});

test('selecting a row renders only the previously and newly selected rows', async () => {
  const { fs } = await mount();
  expect(
    await measure(() => fs.selected.set('f000003.txt')),
    'row 3 selected, row 0 loses the tab stop',
  ).toEqual({
    updates: 2,
    mounts: 0,
  });
  expect(await measure(() => fs.selected.set('f000005.txt'))).toEqual({ updates: 2, mounts: 0 });
  expect(
    await measure(() => fs.selected.set('f099998.txt')),
    'the off-screen row mounts as the tab stop; only row 5 updates',
  ).toEqual({ updates: 1, mounts: 1 });
});

test('opening and closing an action menu renders no rows', async () => {
  await mount();
  const row = document.querySelector<HTMLElement>('[role=treeitem]:nth-child(4)')!;
  const rect = row.getBoundingClientRect();
  const opened = await measure(() =>
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left,
        clientY: rect.top,
      }),
    ),
  );
  expect(document.querySelector('[role=menu]'), 'the menu opened').not.toBeNull();
  expect(opened).toEqual({ updates: 0, mounts: 0 });
  const menuItem = document.querySelector<HTMLElement>('[role=menuitem]')!;
  const closed = await measure(() =>
    menuItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
  );
  expect(document.querySelector('[role=menu]'), 'the menu closed').toBeNull();
  expect(closed, 'focus returns to the row: it and the previous tab stop update').toEqual({
    updates: 2,
    mounts: 0,
  });
});

test('opening and closing a conflict dialog renders no rows', async () => {
  const { fs } = await mount();
  let answered: Promise<unknown> | undefined;
  const opened = await measure(() => (answered = internalsOf(fs).conflicts.ask('copy', 'f000003.txt')));
  expect(document.querySelector('[role=alertdialog]'), 'the dialog opened').not.toBeNull();
  expect(opened).toEqual({ updates: 0, mounts: 0 });
  const closed = await measure(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ),
  );
  expect(document.querySelector('[role=alertdialog]'), 'the dialog closed').toBeNull();
  expect(closed).toEqual({ updates: 0, mounts: 0 });
  expect(await answered).toBeNull();
});

test('starting and cancelling a rename renders only the renamed row', async () => {
  await mount();
  const row = document.querySelector<HTMLElement>('[role=treeitem]:nth-child(4)')!;
  row.focus();
  await interactionSettled();
  const started = await measure(() =>
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true })),
  );
  const input = document.querySelector<HTMLElement>('[data-fs-part=tree-rename-input]');
  expect(input, 'the rename input opened').not.toBeNull();
  expect(started).toEqual({ updates: 1, mounts: 0 });
  const cancelled = await measure(() =>
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
  );
  expect(document.querySelector('[data-fs-part=tree-rename-input]'), 'the rename input closed').toBeNull();
  expect(cancelled).toEqual({ updates: 1, mounts: 0 });
});

test('a reveal renders only the rows whose state changes, and the flash ending only the revealed row', async () => {
  const { fs } = await mount();
  const revealed = await measure(() => void fs.reveal('f000005.txt', { flash: true }));
  const row = document.activeElement!;
  expect(row.textContent, 'the revealed row has focus').toContain('f000005.txt');
  expect(row.hasAttribute('data-flash')).toBe(true);
  expect(revealed, 'row 5 is selected, focused and flashed; row 0 loses the tab stop').toEqual({
    updates: 2,
    mounts: 0,
  });
  treeRowRenders.updates = 0;
  await expect.poll(() => row.hasAttribute('data-flash'), { timeout: 3000 }).toBe(false);
  await interactionSettled();
  expect(treeRowRenders, 'only the revealed row re-renders when its flash ends').toEqual({
    updates: 1,
    mounts: 0,
  });
});
