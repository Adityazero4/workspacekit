import { statusOf } from '@scope/core';
import { createMemoryAdapter } from '@scope/core/memory';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import { expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { useFileSystem, type FileSystemContext } from '../src/provider/hooks';
import { useFileTree, type FileTreeApi, type UseFileTreeOptions } from '../src/tree/useFileTree';

const ROW_HEIGHT = 24;

interface Handle {
  api: FileTreeApi;
  fs: FileSystemContext;
}

function MinimalVirtualizedTestTree({
  handle,
  options,
}: {
  handle: Partial<Handle>;
  options?: UseFileTreeOptions;
}): React.JSX.Element {
  const api = useFileTree({ rowHeight: ROW_HEIGHT, ...options });
  handle.api = api;
  handle.fs = useFileSystem();
  const scroller = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- test-only renderer; tests do not run the React Compiler
  const virtualizer = useVirtualizer({
    count: api.index.count,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (api.tabbableIndex >= 0 && !indexes.includes(api.tabbableIndex)) indexes.push(api.tabbableIndex);
      return indexes.sort((a, b) => a - b);
    },
  });
  useEffect(() => api.setScrollToIndex((index) => virtualizer.scrollToIndex(index)));
  return (
    <>
      <input aria-label="outside" />
      <div
        ref={scroller}
        data-testid="scroller"
        tabIndex={-1}
        style={{ height: 10 * ROW_HEIGHT, overflow: 'auto' }}
      >
        <div {...api.getTreeProps()} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = api.index.rowAt(item.index);
            return (
              <div
                key={row.path}
                {...api.getRowProps(row)}
                style={{ position: 'absolute', top: item.start, height: ROW_HEIGHT }}
              >
                {row.entry.name}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

const mount = async (files: Record<string, string>, options?: UseFileTreeOptions): Promise<Handle> => {
  const handle: Partial<Handle> = {};
  await render(
    <FileSystemProvider adapter={createMemoryAdapter({ files })}>
      <MinimalVirtualizedTestTree handle={handle} options={options} />
    </FileSystemProvider>,
  );
  await expect.poll(() => handle.api && statusOf(handle.fs!.store.getSnapshot().tree, '')).toBe('loaded');
  return handle as Handle;
};

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role=treeitem]')];
const rowNamed = (name: string): HTMLElement => rows().find((row) => row.textContent === name)!;
const rowNames = (): Array<string | null> => rows().map((row) => row.textContent);
const tabbable = (): string[] =>
  rows()
    .filter((row) => row.tabIndex === 0)
    .map((row) => row.textContent!);
const markedFocused = (): string[] =>
  rows()
    .filter((row) => row.hasAttribute('data-focused'))
    .map((row) => row.textContent!);
const active = (): string | null | undefined => document.activeElement?.textContent;
const outsideInput = (): HTMLElement => document.querySelector<HTMLElement>('input[aria-label=outside]')!;
const waitForRenderingUpdates = async (): Promise<void> => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
};
const expandedPaths = (handle: Handle): string[] => [...handle.fs.expanded.get()].sort();

test('exactly one row is tabbable', async () => {
  const handle = await mount({ 'a.txt': '', 'b.txt': '', 'c.txt': '' });
  expect(tabbable(), 'nothing selected or focused: the first row').toEqual(['a.txt']);
  expect(handle.api.tabbableIndex).toBe(0);
  handle.fs.selected.set('b.txt');
  await expect.poll(tabbable, { message: 'the selected row before anything is focused' }).toEqual(['b.txt']);
  expect(handle.api.tabbableIndex).toBe(1);
  handle.api.focus('c.txt');
  await expect.poll(tabbable).toEqual(['c.txt']);
  expect(active()).toBe('c.txt');
  expect(rows().every((row) => row.tabIndex === (row.textContent === 'c.txt' ? 0 : -1))).toBe(true);
  expect(new Set(rows().map((row) => row.id)).size).toBe(3);
  expect(markedFocused()).toEqual(['c.txt']);
});

test('tabbable falls back to the first visible row when the focused and selected rows collapse away or are hidden while focus is outside', async () => {
  const handle = await mount({ '.git/config': '', 'lib/x.ts': '', 'src/a.ts': '', 'z.txt': '' });
  handle.fs.showHidden.set(true);
  handle.api.expand('src');
  await expect.poll(rowNames).toEqual(['.git', 'lib', 'src', 'a.ts', 'z.txt']);
  handle.fs.selected.set('src/a.ts');
  handle.api.focus('.git');
  await expect.poll(tabbable).toEqual(['.git']);
  outsideInput().focus();

  handle.fs.showHidden.set(false);
  await expect.poll(tabbable, { message: 'focused row hidden: the selected row' }).toEqual(['a.ts']);
  handle.api.collapse('src');
  await expect.poll(tabbable, { message: 'selected row collapsed away too: the first row' }).toEqual(['lib']);
  expect(handle.api.tabbableIndex).toBe(0);
});

test('an empty tree has no tabbable row', async () => {
  const handle = await mount({});
  expect(handle.api.index.count).toBe(0);
  expect(handle.api.tabbableIndex).toBe(-1);
  expect(rows()).toEqual([]);
  expect(document.querySelector('[role=tree]')).not.toBeNull();
});

test('ARIA attributes match the index', async () => {
  const handle = await mount({ 'src/a.ts': '', 'src/b.ts': '', 'src/lib/c.ts': '', 'z.md': '' });
  handle.api.expand('src');
  await expect.poll(rowNames).toEqual(['src', 'lib', 'a.ts', 'b.ts', 'z.md']);
  const tree = document.querySelector('[role=tree]')!;
  expect(tree.getAttribute('aria-label')).toBe('Files');
  expect(tree.getAttribute('data-fs-part')).toBe('tree');
  rows().forEach((element, index) => {
    const row = handle.api.index.rowAt(index);
    expect(element.textContent).toBe(row.entry.name);
    expect(element.getAttribute('aria-level')).toBe(String(row.depth + 1));
    expect(element.getAttribute('aria-setsize')).toBe(String(row.setSize));
    expect(element.getAttribute('aria-posinset')).toBe(String(row.posInSet));
    expect(element.getAttribute('aria-expanded')).toBe(
      row.entry.kind === 'directory' ? String(row.isExpanded) : null,
    );
    expect(element.hasAttribute('data-expanded')).toBe(row.isExpanded);
    expect(element.getAttribute('aria-selected')).toBe('false');
    expect(element.getAttribute('data-fs-part')).toBe('tree-row');
  });
  expect(rowNamed('lib').getAttribute('aria-level')).toBe('2');
  expect(rowNamed('lib').getAttribute('aria-expanded')).toBe('false');
  expect(rowNamed('b.ts').getAttribute('aria-posinset')).toBe('3');
  expect(rowNamed('z.md').getAttribute('aria-setsize')).toBe('2');
  handle.fs.selected.set('z.md');
  await expect.poll(() => rowNamed('z.md').getAttribute('aria-selected')).toBe('true');
  expect(rowNamed('z.md').hasAttribute('data-selected')).toBe(true);
});

test('data-focused marks the focused row only while focus is inside the tree', async () => {
  await mount({ 'a.txt': '', 'b.txt': '' });
  rowNamed('b.txt').focus();
  await expect.poll(markedFocused).toEqual(['b.txt']);
  await userEvent.tab({ shift: true });
  await expect.poll(() => document.activeElement).toBe(outsideInput());
  await expect.poll(markedFocused).toEqual([]);
  expect(tabbable(), 'the roving tab stop is kept').toEqual(['b.txt']);
  await userEvent.tab();
  await expect.poll(active).toBe('b.txt');
  await expect.poll(markedFocused).toEqual(['b.txt']);
});

test('data-focused clears when the focused row is removed and focus moves outside', async () => {
  const handle = await mount({ '.git/config': '', 'a.txt': '' });
  handle.fs.showHidden.set(true);
  await expect.poll(rowNames).toEqual(['.git', 'a.txt']);
  rowNamed('.git').focus();
  await expect.poll(markedFocused).toEqual(['.git']);
  handle.fs.showHidden.set(false);
  await expect.poll(rowNames).toEqual(['a.txt']);
  outsideInput().focus();
  handle.fs.showHidden.set(true);
  await expect.poll(rowNames).toEqual(['.git', 'a.txt']);
  expect(document.activeElement).toBe(outsideInput());
  expect(markedFocused()).toEqual([]);
});

test('data-focused stays on when the focused row is removed in the same render that focuses another row', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 2_000 }, (_, i) => [`f${String(i).padStart(5, '0')}.txt`, '']),
  );
  const handle = await mount({ '.git/config': '', ...files });
  handle.fs.showHidden.set(true);
  await expect.poll(() => rowNames()[0]).toBe('.git');
  rowNamed('.git').focus();
  await expect.poll(markedFocused).toEqual(['.git']);
  handle.api.setScrollToIndex(() => {});
  handle.fs.showHidden.set(false);
  handle.api.focus('f01500.txt');
  await expect.poll(active).toBe('f01500.txt');
  await waitForRenderingUpdates();
  expect(markedFocused()).toEqual(['f01500.txt']);
});

test('keyboard navigation scrolls the target row into view before focusing it', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, i) => [`f${String(i).padStart(5, '0')}.txt`, '']),
  );
  const handle = await mount(files);
  expect(handle.api.index.count).toBe(10_000);
  rowNamed('f00000.txt').focus();
  await userEvent.keyboard('{End}');
  await expect.poll(active).toBe('f09999.txt');
  expect(document.activeElement!.getAttribute('aria-posinset')).toBe('10000');
  await userEvent.keyboard('{Home}');
  await expect.poll(active).toBe('f00000.txt');
  await userEvent.keyboard('{ArrowDown}');
  await expect.poll(active).toBe('f00001.txt');
  expect(handle.fs.selected.get(), 'selection follows keyboard focus').toBe('f00001.txt');
});

test('the focused row stays rendered and tabbable when scrolled far out of the window', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, i) => [`f${String(i).padStart(5, '0')}.txt`, '']),
  );
  await mount(files);
  const first = rowNamed('f00000.txt');
  first.focus();
  const blurs = vi.fn();
  first.addEventListener('blur', blurs);

  await waitForRenderingUpdates();
  document.querySelector('[data-testid=scroller]')!.scrollTop = 9_000 * ROW_HEIGHT;
  await expect.poll(() => rows().some((row) => row.textContent === 'f09000.txt')).toBe(true);
  expect(rowNamed('f00000.txt'), 'still mounted, same element').toBe(first);
  expect(document.activeElement).toBe(first);
  expect(blurs, 'focus never fell to body').not.toHaveBeenCalled();

  outsideInput().focus();
  await userEvent.tab();
  await expect.poll(active).toBe('f00000.txt');
});

test('a focus request for a row that is not visible never steals focus later', async () => {
  const handle = await mount({ 'src/a.ts': '', 'z.txt': '' });
  const collapsedRowPath = 'src/a.ts';
  handle.api.focus(collapsedRowPath);
  rowNamed('z.txt').focus();
  handle.api.expand('src');
  await expect.poll(rowNames).toEqual(['src', 'a.ts', 'z.txt']);
  expect(active()).toBe('z.txt');
});

test('a later focus request cancels an earlier one still waiting for its row to mount', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, i) => [`f${String(i).padStart(5, '0')}.txt`, '']),
  );
  const handle = await mount(files);
  handle.api.setScrollToIndex(() => {});
  handle.api.focus('f09000.txt');
  handle.api.focus('nowhere/missing.txt');
  outsideInput().focus();
  document.querySelector('[data-testid=scroller]')!.scrollTop = 9_000 * ROW_HEIGHT;
  await expect.poll(() => rows().some((row) => row.textContent === 'f09000.txt')).toBe(true);
  expect(document.activeElement).toBe(outsideInput());
});

test('focus on a row that is not visible changes nothing', async () => {
  const handle = await mount({ 'src/a.ts': '', 'z.txt': '' });
  handle.api.focus('z.txt');
  await expect.poll(active).toBe('z.txt');
  handle.api.focus('src/a.ts');
  await waitForRenderingUpdates();
  expect(handle.api.focusedPath).toBe('z.txt');
  expect(active()).toBe('z.txt');
  expect(tabbable()).toEqual(['z.txt']);
});

test('typeahead finds the next match and wraps', async () => {
  await mount({ 'alpha.txt': '', 'beta.txt': '', 'bravo.txt': '', 'charlie.txt': '' });
  rowNamed('alpha.txt').focus();
  await userEvent.keyboard('b');
  await expect.poll(active).toBe('beta.txt');
  await userEvent.keyboard('r');
  await expect.poll(active).toBe('bravo.txt');
  await new Promise((resolve) => setTimeout(resolve, 600));
  await userEvent.keyboard('b');
  await expect.poll(active, { message: 'a fresh "b" searches after bravo and wraps' }).toBe('beta.txt');
  await new Promise((resolve) => setTimeout(resolve, 600));
  await userEvent.keyboard('C');
  await expect.poll(active).toBe('charlie.txt');
});

test('Enter opens a file as a pinned tab and toggles a folder', async () => {
  const onOpenFile = vi.fn();
  const handle = await mount({ 'src/a.ts': '', 'z.txt': '' }, { onOpenFile });
  rowNamed('z.txt').focus();
  await userEvent.keyboard('{Enter}');
  expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: 'z.txt' }), 'pin');
  rowNamed('src').focus();
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => expandedPaths(handle)).toEqual(['src']);
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => expandedPaths(handle)).toEqual([]);
  expect(onOpenFile).toHaveBeenCalledTimes(1);
});

test('Right and Left expand and collapse; * expands the visible sibling folders', async () => {
  const handle = await mount({ '.git/config': '', 'lib/x.ts': '', 'src/a.ts': '', 'z.txt': '' });
  rowNamed('src').focus();
  await userEvent.keyboard('{ArrowRight}');
  await expect.poll(() => expandedPaths(handle)).toEqual(['src']);
  await userEvent.keyboard('{ArrowLeft}');
  await expect.poll(() => expandedPaths(handle)).toEqual([]);
  rowNamed('z.txt').focus();
  await userEvent.keyboard('*');
  await expect
    .poll(() => expandedPaths(handle), { message: 'hidden .git stays closed' })
    .toEqual(['lib', 'src']);
});

test('hidden names are excluded and Show hidden reveals them', async () => {
  const handle = await mount({
    '.git/config': '',
    'node_modules/x/index.js': '',
    'src/a.ts': '',
    'a.txt': '',
  });
  await expect.poll(rowNames).toEqual(['src', 'a.txt']);
  expect(rowNamed('a.txt').getAttribute('aria-setsize')).toBe('2');

  const before = handle.api.index;
  handle.fs.selected.set('a.txt');
  await expect.poll(() => rowNamed('a.txt').getAttribute('aria-selected')).toBe('true');
  expect(handle.api.index, 'an unrelated re-render keeps the index').toBe(before);

  handle.fs.showHidden.set(true);
  await expect.poll(rowNames).toEqual(['.git', 'node_modules', 'src', 'a.txt']);
  expect(rowNamed('a.txt').getAttribute('aria-setsize')).toBe('4');
  expect(rowNamed('a.txt').getAttribute('aria-posinset')).toBe('4');
  handle.fs.showHidden.set(false);
  await expect.poll(rowNames).toEqual(['src', 'a.txt']);
  expect(handle.api.index.count).toBe(2);
});

function TestTreeThatNeverRendersOneRow({
  onRender,
  unrenderedPath,
}: {
  onRender: (handle: Handle) => void;
  unrenderedPath: string;
}): React.JSX.Element {
  const api = useFileTree({ rowHeight: ROW_HEIGHT });
  const fs = useFileSystem();
  useEffect(() => {
    onRender({ api, fs });
  });
  const rendered = Array.from({ length: api.index.count }, (_, rowIndex) => api.index.rowAt(rowIndex)).filter(
    (row) => row.path !== unrenderedPath,
  );
  return (
    <div {...api.getTreeProps()}>
      {rendered.map((row) => (
        <div key={row.path} {...api.getRowProps(row)}>
          {row.entry.name}
        </div>
      ))}
    </div>
  );
}

const mountWithAnUnrenderedRow = async (
  unrenderedPath: string,
): Promise<{ handle: Handle; adapter: ReturnType<typeof createMemoryAdapter> }> => {
  const files = Object.fromEntries(
    Array.from({ length: 50 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, '']),
  );
  const adapter = createMemoryAdapter({ files });
  const handle: Partial<Handle> = {};
  await render(
    <FileSystemProvider adapter={adapter}>
      <input aria-label="outside" />
      <TestTreeThatNeverRendersOneRow
        onRender={(latest) => Object.assign(handle, latest)}
        unrenderedPath={unrenderedPath}
      />
    </FileSystemProvider>,
  );
  await expect.poll(() => rows().length).toBe(49);
  return { handle: handle as Handle, adapter };
};

test('focus is not stranded when the focused row and the row waiting to mount are removed together', async () => {
  const { handle, adapter } = await mountWithAnUnrenderedRow('f40.txt');
  rowNamed('f00.txt').focus();
  handle.api.focus('f40.txt');
  adapter.emit([
    { type: 'deleted', path: 'f00.txt' },
    { type: 'deleted', path: 'f40.txt' },
  ]);
  await expect.poll(() => rows().length).toBe(48);
  await expect.poll(active).toBe('f42.txt');
});

test('a row waiting to mount that leaves the tree while focus is nowhere hands the focus to the row at its place', async () => {
  const { handle, adapter } = await mountWithAnUnrenderedRow('f40.txt');
  handle.api.focus('f40.txt');
  await expect.poll(() => handle.api.focusedPath).toBe('f40.txt');
  expect(document.activeElement).toBe(document.body);
  adapter.emit([{ type: 'deleted', path: 'f40.txt' }]);
  await expect.poll(active).toBe('f41.txt');
  expect(handle.api.focusedPath).toBe('f41.txt');
});
