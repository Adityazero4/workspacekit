import { FsError, statusOf, type FileSystemAdapter } from '@scope/core';
import { createMemoryAdapter, type MemoryAdapter } from '@scope/core/memory';
import { useEffect } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { followMove } from '../src/actions/followMove';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { useFileSystem, type FileSystemContext, type Notice } from '../src/provider/hooks';
import { FileTree } from '../src/tree/FileTree';
import { isMac } from '../src/tree/keyboard';
import { interactionSettled } from './support/interactionSettled';

const ROW_HEIGHT = 24;
const MOD = isMac() ? 'Meta' : 'Control';

function CaptureContext({ onContext }: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => {
    onContext(fs);
  });
  return null;
}

interface Mounted {
  fs: FileSystemContext;
  adapter: MemoryAdapter;
  notices: Notice[];
}

const mount = async (
  files: Record<string, string>,
  adaptAdapter: (memory: MemoryAdapter) => FileSystemAdapter = (memory) => memory,
  options: { fetchDepth?: number; spaceAbove?: number } = {},
): Promise<Mounted> => {
  const adapter = createMemoryAdapter({ files });
  const notices: Notice[] = [];
  let captured: FileSystemContext | undefined;
  await render(
    <FileSystemProvider
      adapter={adaptAdapter(adapter)}
      fetchDepth={options.fetchDepth}
      onNotify={(notice) => notices.push(notice)}
    >
      <input aria-label="outside" />
      {options.spaceAbove !== undefined && (
        <div data-testid="space-above" style={{ height: options.spaceAbove }} />
      )}
      <FileTree rowHeight={ROW_HEIGHT} style={{ height: 10 * ROW_HEIGHT }} />
      <CaptureContext onContext={(fs) => (captured = fs)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => captured && statusOf(captured.store.getSnapshot().tree, '')).toBe('loaded');
  await expect.poll(() => rows().length).toBeGreaterThan(0);
  return { fs: captured!, adapter, notices };
};

afterEach(() => {
  vi.restoreAllMocks();
});

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role=treeitem]')];
const labelOf = (row: Element): string | null | undefined =>
  row.querySelector('[data-fs-part=tree-row-label]')?.textContent;
const rowNamed = (name: string): HTMLElement => rows().find((row) => labelOf(row) === name)!;
const activeRowLabel = (): string | null | undefined => {
  const focused = document.activeElement;
  return focused?.getAttribute('role') === 'treeitem' ? labelOf(focused) : undefined;
};
const renameInput = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>('[data-fs-part=tree-rename-input]');
const renameError = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-fs-part=tree-rename-error]');
const listing = async (adapter: MemoryAdapter): Promise<string[]> =>
  (await adapter.list('', { depth: 1 })).map((entry) => entry.name);
const selectedText = (input: HTMLInputElement): string =>
  input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);

const startRenameWithF2 = async (name: string): Promise<HTMLInputElement> => {
  rowNamed(name).focus();
  await userEvent.keyboard('{F2}');
  await expect.poll(() => document.activeElement === renameInput() && renameInput() !== null).toBe(true);
  return renameInput()!;
};
const replaceName = async (input: HTMLInputElement, name: string): Promise<void> => {
  input.select();
  if (name === '') await userEvent.keyboard('{Backspace}');
  else await userEvent.keyboard(name);
};

test('F2 opens rename with the stem selected', async () => {
  await mount({ 'notes.md': '', 'archive.tar.gz': '' });
  const input = await startRenameWithF2('notes.md');
  expect(input.value).toBe('notes.md');
  expect(selectedText(input)).toBe('notes');
  expect(input.getAttribute('aria-label')).toBe('Rename notes.md');
  expect(rowNamed('archive.tar.gz')).toBeDefined();
  await userEvent.keyboard('{Escape}');
  const second = await startRenameWithF2('archive.tar.gz');
  expect(selectedText(second)).toBe('archive.tar');
});

test('dotfile selects the whole name', async () => {
  await mount({ '.env': '', 'a.txt': '' });
  const input = await startRenameWithF2('.env');
  expect(selectedText(input)).toBe('.env');
});

test('invalid and duplicate names show a message and block Enter', async () => {
  const { adapter } = await mount({ 'a.txt': '', 'b.txt': '' });
  const input = await startRenameWithF2('a.txt');
  expect(input.getAttribute('aria-invalid')).toBeNull();

  await replaceName(input, 'B.txt');
  await expect.poll(() => renameError()?.textContent).toContain('already exists');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.getAttribute('aria-describedby')).toBe(renameError()!.id);
  await userEvent.keyboard('{Enter}');
  await interactionSettled();
  expect(renameInput(), 'Enter is blocked').toBe(input);
  expect(await listing(adapter)).toEqual(['a.txt', 'b.txt']);

  await replaceName(input, 'x/y');
  await expect.poll(() => renameError()?.textContent).toContain('slashes');
  await replaceName(input, '');
  await expect.poll(() => renameError()?.textContent).toContain('Enter a name');

  await replaceName(input, 'c.txt');
  await expect.poll(() => input.getAttribute('aria-invalid')).toBeNull();
  expect(input.getAttribute('aria-describedby')).toBeNull();
});

test('Enter renames and focuses the renamed row', async () => {
  const { adapter, fs } = await mount({ 'a.txt': '', 'm.txt': '', 'z.txt': '' });
  fs.selected.set('a.txt');
  await startRenameWithF2('a.txt');
  await userEvent.keyboard('zz');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => listing(adapter)).toEqual(['m.txt', 'z.txt', 'zz.txt']);
  await expect.poll(activeRowLabel).toBe('zz.txt');
  expect(rows().map(labelOf)).toEqual(['m.txt', 'z.txt', 'zz.txt']);
  expect(renameInput()).toBeNull();
  expect(fs.selected.get(), 'the selection follows the rename').toBe('zz.txt');
});

test('Esc restores the label and focus', async () => {
  const { adapter } = await mount({ 'a.txt': '', 'b.txt': '' });
  const input = await startRenameWithF2('a.txt');
  await userEvent.keyboard('changed');
  await userEvent.keyboard('{Escape}');
  await expect.poll(renameInput).toBeNull();
  expect(labelOf(rows()[0]!)).toBe('a.txt');
  expect(activeRowLabel()).toBe('a.txt');
  expect(input.isConnected).toBe(false);
  expect(await listing(adapter)).toEqual(['a.txt', 'b.txt']);
});

test('Rename from the menu focuses the input once focus has returned to the row', async () => {
  await mount({ 'a.txt': '', 'b.txt': '' });
  await userEvent.click(rowNamed('b.txt'), { button: 'right' });
  await expect.poll(() => document.querySelector('[role=menu]')).not.toBeNull();
  const renameItem = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((item) =>
    item.textContent?.startsWith('Rename'),
  )!;
  await userEvent.click(renameItem);
  await expect.poll(() => document.activeElement === renameInput() && renameInput() !== null).toBe(true);
  await interactionSettled();
  expect(document.activeElement, 'nothing takes focus back from the input').toBe(renameInput());
  expect(selectedText(renameInput()!)).toBe('b');
});

test('keys typed in the input stay out of the tree', async () => {
  const { fs } = await mount({ 'a.txt': '', 'b.txt': '', 'c.txt': '' });
  fs.selected.set('a.txt');
  const input = await startRenameWithF2('a.txt');
  await userEvent.keyboard('b');
  await userEvent.keyboard('{ArrowDown}{ArrowUp}{Home}{End}');
  await userEvent.keyboard(`{${MOD}>}c{/${MOD}}`);
  await userEvent.keyboard('{F2}{Delete}');
  await interactionSettled();
  expect(document.activeElement).toBe(input);
  expect(fs.selected.get()).toBe('a.txt');
  expect(fs.clipboard.get()).toBeNull();
  expect(document.querySelector('[role=dialog], [role=alertdialog], [role=menu]')).toBeNull();
});

test('clicking the input does not toggle or open its row', async () => {
  const { fs } = await mount({ 'src/a.txt': '' });
  const input = await startRenameWithF2('src');
  await userEvent.click(input);
  await userEvent.dblClick(input);
  await interactionSettled();
  expect(fs.expanded.get().has('src')).toBe(false);
  expect(renameInput()).toBe(input);
});

test('blur commits a valid name and cancels an invalid one', async () => {
  const { adapter } = await mount({ 'a.txt': '', 'b.txt': '' });
  const outside = document.querySelector<HTMLElement>('[aria-label=outside]')!;
  const input = await startRenameWithF2('a.txt');
  await replaceName(input, 'b.txt');
  await userEvent.click(outside);
  await expect.poll(renameInput).toBeNull();
  expect(await listing(adapter)).toEqual(['a.txt', 'b.txt']);
  expect(document.activeElement, 'blur does not pull focus back').toBe(outside);

  await startRenameWithF2('a.txt');
  await userEvent.keyboard('c');
  await userEvent.click(outside);
  await expect.poll(() => listing(adapter)).toEqual(['b.txt', 'c.txt']);
  expect(document.activeElement).toBe(outside);
});

test('a burst of watch events does not cancel an in-progress rename', async () => {
  const { adapter } = await mount({ 'a.txt': '', 'b.txt': '' });
  const input = await startRenameWithF2('b.txt');
  await userEvent.keyboard('renamed');
  await adapter.create!('0-new.txt', 'file');
  adapter.emit(
    Array.from({ length: 1000 }, (_, i) => ({
      type: 'updated' as const,
      path: i % 2 ? 'a.txt' : 'b.txt',
      actor: 'agent',
    })),
  );
  await expect
    .poll(() => rows().map((row) => labelOf(row) ?? 'input'))
    .toEqual(['0-new.txt', 'a.txt', 'input']);
  await interactionSettled();
  expect(renameInput(), 'the same input stays mounted').toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('renamed.txt');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => listing(adapter)).toEqual(['0-new.txt', 'a.txt', 'renamed.txt']);
  await expect.poll(activeRowLabel).toBe('renamed.txt');
});

test('renaming row survives scrolling out of the window', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [`f${String(i).padStart(3, '0')}.txt`, '']),
  );
  const { adapter } = await mount(files);
  const input = await startRenameWithF2('f000.txt');
  const viewport = document.querySelector<HTMLElement>('[data-fs-part=tree-viewport]')!;
  viewport.scrollTop = viewport.scrollHeight;
  await expect.poll(() => rowNamed('f299.txt')).toBeDefined();
  await interactionSettled();
  expect(input.isConnected).toBe(true);
  expect(document.activeElement).toBe(input);
  await userEvent.keyboard('g');
  await userEvent.keyboard('{Enter}');
  await expect.poll(async () => (await listing(adapter))[0]).toBe('f001.txt');
  expect(await listing(adapter)).toContain('g.txt');
  await expect.poll(activeRowLabel).toBe('g.txt');
});

test('a failed rename reports the error and reopens the input with the typed name', async () => {
  const { notices } = await mount({ 'a.txt': '', 'b.txt': '' }, (memory) => ({
    ...memory,
    move: () => Promise.reject(new FsError('conflict', 'already exists on the server')),
  }));
  await startRenameWithF2('a.txt');
  await userEvent.keyboard('c');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => notices.find((notice) => notice.kind === 'error')?.message).toContain('a.txt');
  await expect.poll(() => renameInput()?.value).toBe('c.txt');
  await expect.poll(() => document.activeElement).toBe(renameInput());
  expect(rows().map((row) => labelOf(row) ?? 'input')).toEqual(['input', 'b.txt']);
});

const failingFirstMove = (memory: MemoryAdapter): FileSystemAdapter => {
  let moves = 0;
  return {
    ...memory,
    move: (from, to, options) => {
      if (moves++ === 0) throw new FsError('forbidden', 'the server refused');
      return memory.move!(from, to, options);
    },
  };
};
const outsideInput = (): HTMLElement => document.querySelector<HTMLElement>('[aria-label=outside]')!;
const pasteInto = async (folderName: string): Promise<void> => {
  rowNamed(folderName).focus();
  await userEvent.keyboard(`{${MOD}>}v{/${MOD}}`);
};
const threeHundredFiles = (prefix = ''): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [`${prefix}f${String(i).padStart(3, '0')}.txt`, '']),
  );

test('a failed blur commit leaves the notice and does not take focus back', async () => {
  let moves = 0;
  const { notices } = await mount({ 'a.txt': '', 'b.txt': '' }, (memory) => ({
    ...memory,
    move: () => {
      moves++;
      return Promise.reject(new FsError('forbidden', 'the server refused'));
    },
  }));
  await startRenameWithF2('a.txt');
  await userEvent.keyboard('c');
  await userEvent.click(outsideInput());
  await expect.poll(() => notices.filter((notice) => notice.kind === 'error').length).toBe(1);
  await interactionSettled();
  expect(document.activeElement).toBe(outsideInput());
  expect(moves, 'no retry loop').toBe(1);
});

test('a failed rename leaves no focus request behind for the name it tried', async () => {
  const { adapter } = await mount({ 'a.txt': '', 'b.txt': '' }, failingFirstMove);
  await startRenameWithF2('a.txt');
  await userEvent.keyboard('c');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => renameInput()?.value).toBe('c.txt');
  await expect.poll(() => document.activeElement).toBe(renameInput());
  await userEvent.click(outsideInput());
  await expect.poll(() => listing(adapter)).toEqual(['b.txt', 'c.txt']);
  await expect.poll(() => rowNamed('c.txt')).toBeDefined();
  await interactionSettled();
  expect(document.activeElement).toBe(outsideInput());
});

test('renaming an expanded folder keeps it expanded', async () => {
  const { fs, notices } = await mount({ 'src/a.txt': '', 'z.txt': '' });
  fs.expanded.set(new Set(['src']));
  await expect.poll(() => rowNamed('a.txt')).toBeDefined();
  await startRenameWithF2('src');
  await userEvent.keyboard('lib');
  await userEvent.keyboard('{Enter}');
  await expect.poll(activeRowLabel).toBe('lib');
  expect(fs.expanded.get()).toEqual(new Set(['lib']));
  expect(rows().map(labelOf)).toEqual(['lib', 'a.txt', 'z.txt']);
  await interactionSettled();
  expect(notices).toEqual([]);
});

test('cutting and pasting an expanded folder keeps it expanded', async () => {
  const { fs, adapter, notices } = await mount({ 'src/a.txt': '', 'dest/x.txt': '' });
  fs.expanded.set(new Set(['src']));
  fs.clipboard.set({ op: 'cut', path: 'src' });
  await pasteInto('dest');
  await expect
    .poll(async () => (await adapter.list('dest', { depth: 1 })).map((entry) => entry.name))
    .toEqual(['src', 'x.txt']);
  expect(fs.expanded.get().has('dest/src')).toBe(true);
  expect(fs.expanded.get().has('src')).toBe(false);
  await interactionSettled();
  expect(notices).toEqual([]);
});

test('a cut file inside a renamed folder still pastes', async () => {
  const { fs, adapter, notices } = await mount({ 'src/a.txt': '', 'dest/x.txt': '' });
  fs.clipboard.set({ op: 'cut', path: 'src/a.txt' });
  await startRenameWithF2('src');
  await userEvent.keyboard('lib');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => fs.clipboard.get()).toEqual({ op: 'cut', path: 'lib/a.txt' });
  await expect.poll(activeRowLabel).toBe('lib');
  await pasteInto('dest');
  await expect
    .poll(async () => (await adapter.list('dest', { depth: 1 })).map((entry) => entry.name))
    .toEqual(['a.txt', 'x.txt']);
  expect(notices).toEqual([]);
});

test('an external delete ends the rename; re-creating the path neither reopens it nor steals focus', async () => {
  const { adapter } = await mount({ 'a.txt': '', 'b.txt': '' });
  await startRenameWithF2('a.txt');
  await adapter.delete!('a.txt');
  await expect.poll(renameInput).toBeNull();
  await expect.poll(activeRowLabel).toBe('b.txt');
  await adapter.create!('a.txt', 'file');
  await expect.poll(() => rowNamed('a.txt')).toBeDefined();
  await interactionSettled();
  expect(renameInput()).toBeNull();
  expect(activeRowLabel()).toBe('b.txt');
});

test('a rename to a name outside the rendered window focuses the renamed row', async () => {
  const { adapter } = await mount(threeHundredFiles());
  const input = await startRenameWithF2('f000.txt');
  await replaceName(input, 'zzz.txt');
  await userEvent.keyboard('{Enter}');
  await expect.poll(activeRowLabel).toBe('zzz.txt');
  expect((await listing(adapter)).at(-1)).toBe('zzz.txt');
});

test('Esc after the renaming row scrolled away returns focus to the row', async () => {
  await mount(threeHundredFiles());
  await startRenameWithF2('f000.txt');
  const viewport = document.querySelector<HTMLElement>('[data-fs-part=tree-viewport]')!;
  viewport.scrollTop = viewport.scrollHeight;
  await expect.poll(() => rowNamed('f299.txt')).toBeDefined();
  await userEvent.keyboard('{Escape}');
  await expect.poll(activeRowLabel).toBe('f000.txt');
  await expect.poll(() => viewport.scrollTop).toBe(0);
});

test('leaving the window keeps the rename open', async () => {
  const { adapter } = await mount({ 'a.txt': '', 'b.txt': '' });
  const input = await startRenameWithF2('a.txt');
  await userEvent.keyboard('c');
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  input.blur();
  await interactionSettled();
  expect(renameInput()).toBe(input);
  expect(input.value).toBe('c.txt');
  expect(await listing(adapter)).toEqual(['a.txt', 'b.txt']);
});

test('the rename message of the last visible row stays inside the viewport', async () => {
  await mount(threeHundredFiles());
  const input = await startRenameWithF2('f009.txt');
  await replaceName(input, 'a/b');
  await expect.poll(() => renameError()?.textContent).toContain('slashes');
  const viewport = document.querySelector<HTMLElement>('[data-fs-part=tree-viewport]')!;
  await expect
    .poll(() => renameError()!.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().bottom)
    .toBe(true);
  expect(document.activeElement).toBe(input);
});

const listingThatWaits = (
  memory: MemoryAdapter,
  slowFolder: string,
): { adapter: FileSystemAdapter; release: () => void } => {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    adapter: {
      ...memory,
      list: async (path, options) => {
        if (path === slowFolder) await released;
        return memory.list(path, options);
      },
    },
    release: () => release(),
  };
};

test('a folder renamed while its listing is loading loads under its new name', async () => {
  let release = (): void => undefined;
  const { fs } = await mount(
    { 'src/a.txt': '', 'z.txt': '' },
    (memory) => {
      const slow = listingThatWaits(memory, 'src');
      release = slow.release;
      return slow.adapter;
    },
    { fetchDepth: 1 },
  );
  fs.expanded.set(new Set(['src']));
  await expect.poll(() => fs.store.getSnapshot().tree.folders.get('src')?.status).toBe('loading');
  await startRenameWithF2('src');
  await userEvent.keyboard('lib');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => fs.expanded.get()).toEqual(new Set(['lib']));
  release();
  await expect.poll(() => rows().map(labelOf)).toEqual(['lib', 'a.txt', 'z.txt']);
});

test('a folder cut and pasted while its listing is loading loads at its new place', async () => {
  let release = (): void => undefined;
  const { fs } = await mount(
    { 'src/a.txt': '', 'dest/x.txt': '' },
    (memory) => {
      const slow = listingThatWaits(memory, 'src');
      release = slow.release;
      return slow.adapter;
    },
    { fetchDepth: 1 },
  );
  fs.expanded.set(new Set(['src', 'dest']));
  await expect.poll(() => fs.store.getSnapshot().tree.folders.get('src')?.status).toBe('loading');
  await expect.poll(() => rowNamed('x.txt')).toBeDefined();
  fs.clipboard.set({ op: 'cut', path: 'src' });
  await pasteInto('dest');
  await expect.poll(() => fs.expanded.get()).toEqual(new Set(['dest', 'dest/src']));
  release();
  await expect.poll(() => rows().map(labelOf)).toEqual(['dest', 'src', 'a.txt', 'x.txt']);
});

test('a rename onto a stale expanded path drops the old path from the expanded set', async () => {
  const { fs } = await mount({ 'src/a.txt': '', 'z.txt': '' });
  fs.expanded.set(new Set(['src', 'lib']));
  await expect.poll(() => rowNamed('a.txt')).toBeDefined();
  await startRenameWithF2('src');
  await userEvent.keyboard('lib');
  await userEvent.keyboard('{Enter}');
  await expect.poll(activeRowLabel).toBe('lib');
  expect(fs.expanded.get()).toEqual(new Set(['lib']));
});

test('F2 on a row whose rename is still open focuses its input', async () => {
  await mount({ 'a.txt': '', 'b.txt': '' }, (memory) => ({
    ...memory,
    move: () => Promise.reject(new FsError('forbidden', 'the server refused')),
  }));
  await startRenameWithF2('a.txt');
  await userEvent.keyboard('c');
  await userEvent.click(outsideInput());
  await expect.poll(() => renameInput()?.value).toBe('c.txt');
  expect(document.activeElement).toBe(outsideInput());
  const row = renameInput()!.closest<HTMLElement>('[role=treeitem]')!;
  row.focus();
  await userEvent.keyboard('{F2}');
  await expect.poll(() => document.activeElement).toBe(renameInput());
  expect(renameInput()!.value).toBe('c.txt');
});

test('a failure after focus left the tree reopens the input without taking focus', async () => {
  let rejectMove: (error: Error) => void = () => undefined;
  const { notices } = await mount({ 'a.txt': '', 'b.txt': '' }, (memory) => ({
    ...memory,
    move: () => new Promise((_resolve, reject) => (rejectMove = reject)),
  }));
  await startRenameWithF2('a.txt');
  await userEvent.keyboard('c');
  await userEvent.keyboard('{Enter}');
  await expect.poll(activeRowLabel).toBe('c.txt');
  await userEvent.click(outsideInput());
  rejectMove(new FsError('forbidden', 'the server refused'));
  await expect.poll(() => notices.length).toBe(1);
  await expect.poll(() => renameInput()?.value).toBe('c.txt');
  await interactionSettled();
  expect(document.activeElement).toBe(outsideInput());
});

test('showing the rename message scrolls only the tree, never the page', async () => {
  await mount(threeHundredFiles(), undefined, { spaceAbove: 0 });
  const spaceAbove = document.querySelector<HTMLElement>('[data-testid=space-above]')!;
  const viewport = document.querySelector<HTMLElement>('[data-fs-part=tree-viewport]')!;
  const rowsAboveTheFold = 5;
  const viewportTopForFiveRowsAboveTheFold = window.innerHeight - rowsAboveTheFold * ROW_HEIGHT - 4;
  spaceAbove.style.height = `${viewportTopForFiveRowsAboveTheFold - viewport.getBoundingClientRect().top}px`;
  expect(window.scrollY).toBe(0);
  const input = await startRenameWithF2('f004.txt');
  expect(window.scrollY).toBe(0);
  await replaceName(input, 'a/b');
  await expect.poll(() => renameError()?.textContent).toContain('slashes');
  await interactionSettled();
  expect(window.scrollY).toBe(0);
});

test('a move of a folder above the renaming row keeps the input open, focused, with the draft at the new path', async () => {
  const { fs, adapter } = await mount({ 'dir/a.txt': '' });
  fs.expanded.set(new Set(['dir']));
  await expect.poll(() => rowNamed('a.txt')).toBeDefined();
  const input = await startRenameWithF2('a.txt');
  await replaceName(input, 'draft.txt');
  input.setSelectionRange(1, 3);
  await adapter.move!('dir', 'moved');
  await expect.poll(() => rowNamed('moved')).toBeDefined();
  await expect.poll(() => renameInput()?.value).toBe('draft.txt');
  expect(document.activeElement).toBe(renameInput());
  expect(selectedText(renameInput()!)).toBe('ra');
  await userEvent.keyboard('{Enter}');
  await expect
    .poll(() => adapter.list('moved', { depth: 1 }).then((entries) => entries.map((e) => e.path)))
    .toEqual(['moved/draft.txt']);
});

test('a rename draft follows an in-app ancestor move', async () => {
  const { fs, adapter } = await mount({ 'dir/a.txt': '' });
  fs.expanded.set(new Set(['dir']));
  await expect.poll(() => rowNamed('a.txt')).toBeDefined();
  const input = await startRenameWithF2('a.txt');
  await replaceName(input, 'draft.txt');
  input.setSelectionRange(1, 3);
  await followMove(fs, 'dir', 'moved', () => fs.store.rename('dir', 'moved'));
  await expect.poll(() => rowNamed('moved')).toBeDefined();
  await expect.poll(() => renameInput()?.value).toBe('draft.txt');
  expect(document.activeElement).toBe(renameInput());
  expect(selectedText(renameInput()!)).toBe('ra');
  await userEvent.keyboard('{Enter}');
  await expect
    .poll(() => adapter.list('moved', { depth: 1 }).then((entries) => entries.map((e) => e.path)))
    .toEqual(['moved/draft.txt']);
});
