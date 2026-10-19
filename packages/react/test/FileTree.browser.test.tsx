import { FsError, statusOf, type FileSystemAdapter } from '@scope/core';
import { createMemoryAdapter, type MemoryAdapter } from '@scope/core/memory';
import axe from 'axe-core';
import { Component, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { useFileSystem, useTreeSnapshot, type FileSystemContext } from '../src/provider/hooks';
import { FileTree, type FileTreeProps } from '../src/tree/FileTree';
import { TreeRow } from '../src/tree/TreeRow';

const ROW_HEIGHT = 24;
const VIEWPORT_ROWS = 10;

function CaptureContext({ onContext }: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => {
    onContext(fs);
  });
  return null;
}

interface MountOptions {
  adapter?: FileSystemAdapter;
  fetchDepth?: number;
  props?: Partial<FileTreeProps>;
}

const mount = async (
  files: Record<string, string>,
  options: MountOptions = {},
): Promise<FileSystemContext> => {
  let captured: FileSystemContext | undefined;
  await render(
    <FileSystemProvider
      adapter={options.adapter ?? createMemoryAdapter({ files })}
      fetchDepth={options.fetchDepth}
    >
      <FileTree rowHeight={ROW_HEIGHT} style={{ height: VIEWPORT_ROWS * ROW_HEIGHT }} {...options.props} />
      <CaptureContext onContext={(fs) => (captured = fs)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => captured && statusOf(captured.store.getSnapshot().tree, '')).toBe('loaded');
  return captured!;
};

const manyFiles = (count: number, prefix = ''): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${prefix}f${String(i).padStart(5, '0')}.txt`, '']),
  );

const tree = (): HTMLElement => document.querySelector<HTMLElement>('[role=tree]')!;
const viewport = (): HTMLElement => document.querySelector<HTMLElement>('[data-fs-part=tree-viewport]')!;
const emptyState = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-fs-part=tree-empty]');
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role=treeitem]')];
const labelOf = (row: Element): string | null | undefined =>
  row.querySelector('[data-fs-part=tree-row-label]')?.textContent;
const rowNamed = (name: string): HTMLElement => rows().find((row) => labelOf(row) === name)!;
const rowNames = (): Array<string | null | undefined> => rows().map(labelOf);
const stickyNames = (): Array<string | null | undefined> =>
  [...document.querySelectorAll('[data-fs-part=tree-sticky-row]')].map(labelOf);
const active = (): string | null | undefined => {
  const focused = document.activeElement;
  return focused?.getAttribute('role') === 'treeitem' ? labelOf(focused) : undefined;
};
const stickyBottom = (): number => {
  const stickyRows = document.querySelectorAll('[data-fs-part=tree-sticky-row]');
  const last = stickyRows[stickyRows.length - 1];
  return last ? last.getBoundingClientRect().bottom : viewport().getBoundingClientRect().top;
};
const isClearOfStickyHeaders = (row: HTMLElement): boolean => {
  const rect = row.getBoundingClientRect();
  return rect.top >= stickyBottom() - 0.5 && rect.bottom <= viewport().getBoundingClientRect().bottom + 0.5;
};
const expandAll = async (fs: FileSystemContext, folders: string[], expectedRows: number): Promise<void> => {
  fs.expanded.set(new Set(folders));
  await expect.poll(() => countVisible(fs)).toBe(expectedRows);
};
const countVisible = (fs: FileSystemContext): number => {
  const snapshot = fs.store.getSnapshot();
  let count = 0;
  const walk = (folder: string): void => {
    for (const entry of snapshot.tree.folders.get(folder)?.children.values() ?? []) {
      count++;
      if (entry.kind === 'directory' && fs.expanded.get().has(entry.path)) walk(entry.path);
    }
  };
  walk('');
  return count;
};
const scrollTreeTo = async (rowIndex: number): Promise<void> => {
  viewport().scrollTop = rowIndex * ROW_HEIGHT;
  await expect.poll(() => rows().some((row) => row.getBoundingClientRect().top >= 0)).toBe(true);
};

const twoFoldersOfAHundredFiles = {
  ...manyFiles(100, 'src/aaa/'),
  ...manyFiles(100, 'src/zzz/'),
};
const STICKY_FOLDERS = ['src', 'src/aaa', 'src/zzz'];
const ROWS_WITH_STICKY_FOLDERS_OPEN = 203;

function withSlowAndBrokenFolders(memory: MemoryAdapter): FileSystemAdapter {
  return {
    list: (path, options) => {
      if (path === 'slow') return new Promise(() => {});
      if (path === 'broken') return Promise.reject(new FsError('forbidden', 'Permission denied'));
      return memory.list(path, options);
    },
    read: memory.read.bind(memory) as FileSystemAdapter['read'],
    watch: memory.watch!.bind(memory),
  };
}
const SLOW_AND_BROKEN_FILES = { 'slow/a.txt': '', 'broken/b.txt': '', 'ok/c.txt': '', 'z.txt': '' };

const themeTransitionsToFinish = async (): Promise<void> => {
  await new Promise(requestAnimationFrame);
  const transitions = document.getAnimations().filter((animation) => animation instanceof CSSTransition);
  await Promise.all(transitions.map((transition) => transition.finished));
};

afterEach(async () => {
  await commands.emulateMedia({ colorScheme: null });
});

test('renders only the visible window for 100k rows', async () => {
  const fs = await mount(manyFiles(100_000));
  await expect.poll(() => rows().length).toBeGreaterThan(0);
  expect(countVisible(fs)).toBe(100_000);
  expect(rows().length).toBeLessThan(100);
  expect(viewport().scrollHeight, 'the scroll range covers every row').toBe(100_000 * ROW_HEIGHT);
});

test('first paint shows rows before the virtualizer measures', async () => {
  const rowsAtFirstCommit = vi.fn();
  function FirstCommitProbe(): null {
    useLayoutEffect(() => rowsAtFirstCommit(rows().length), []);
    return null;
  }
  function TreeOnceTheRootIsLoaded(): ReactNode {
    const fs = useFileSystem();
    const snapshot = useTreeSnapshot();
    if (statusOf(snapshot.tree, fs.root) !== 'loaded') return null;
    return (
      <>
        <FileTree rowHeight={ROW_HEIGHT} style={{ height: VIEWPORT_ROWS * ROW_HEIGHT }} />
        <FirstCommitProbe />
      </>
    );
  }
  await render(
    <FileSystemProvider adapter={createMemoryAdapter({ files: manyFiles(200) })}>
      <TreeOnceTheRootIsLoaded />
    </FileSystemProvider>,
  );
  await expect.poll(() => rowsAtFirstCommit.mock.calls.length).toBe(1);
  expect(rowsAtFirstCommit).toHaveBeenCalledWith(50);
});

test('sticky headers show the open ancestors of the first visible row', async () => {
  const fs = await mount(twoFoldersOfAHundredFiles);
  await expandAll(fs, STICKY_FOLDERS, ROWS_WITH_STICKY_FOLDERS_OPEN);
  expect(stickyNames(), 'nothing is sticky at the top').toEqual([]);
  await scrollTreeTo(50);
  await expect.poll(stickyNames).toEqual(['src', 'aaa']);
  await scrollTreeTo(150);
  await expect.poll(stickyNames).toEqual(['src', 'zzz']);
  const overlay = document.querySelector('[data-fs-part=tree-sticky]')!;
  expect(overlay.getAttribute('aria-hidden')).toBe('true');
});

test('sticky headers are capped at 7 rows and 40% of the viewport, following resizes', async () => {
  const deepFolder = 'a/b/c/d/e/f/g/h/i/j';
  const folders = deepFolder.split('/').map((_, depth, names) => names.slice(0, depth + 1).join('/'));
  const fs = await mount(manyFiles(60, `${deepFolder}/`), { fetchDepth: 20 });
  await expandAll(fs, folders, 70);
  await scrollTreeTo(20);
  await expect.poll(() => stickyNames().length, { message: '40% of 10 rows' }).toBe(4);
  expect(stickyNames().at(-1), 'the innermost ancestors are kept').toBe('j');
  viewport().style.height = `${25 * ROW_HEIGHT}px`;
  await expect.poll(() => stickyNames().length, { message: 'at most 7' }).toBe(7);
  viewport().style.height = `${100}px`;
  await expect.poll(() => stickyNames().length, { message: '40% of 100px is one row' }).toBe(1);
});

test('stickyHeaders={false} renders no sticky stack', async () => {
  const fs = await mount(twoFoldersOfAHundredFiles, { props: { stickyHeaders: false } });
  await expandAll(fs, STICKY_FOLDERS, ROWS_WITH_STICKY_FOLDERS_OPEN);
  await scrollTreeTo(150);
  await expect.poll(() => rows().some((row) => labelOf(row) === 'f00050.txt')).toBe(true);
  expect(document.querySelector('[data-fs-part=tree-sticky]')).toBeNull();
});

test('clicking a sticky header scrolls to its folder', async () => {
  const fs = await mount(twoFoldersOfAHundredFiles);
  await expandAll(fs, STICKY_FOLDERS, ROWS_WITH_STICKY_FOLDERS_OPEN);
  await scrollTreeTo(150);
  await expect.poll(stickyNames).toEqual(['src', 'zzz']);
  const zzzHeader = [...document.querySelectorAll<HTMLElement>('[data-fs-part=tree-sticky-row]')][1]!;
  await userEvent.click(zzzHeader);
  await expect.poll(active).toBe('zzz');
  await expect
    .poll(() => isClearOfStickyHeaders(rowNamed('zzz')), { message: 'not under the sticky stack' })
    .toBe(true);
  await expect.poll(stickyNames).toEqual(['src', 'aaa']);
});

test('keyboard focus moving up stays clear of the sticky headers', async () => {
  const fs = await mount(twoFoldersOfAHundredFiles);
  await expandAll(fs, STICKY_FOLDERS, ROWS_WITH_STICKY_FOLDERS_OPEN);
  await scrollTreeTo(150);
  await expect.poll(stickyNames).toEqual(['src', 'zzz']);
  const firstUncovered = rows().find(isClearOfStickyHeaders)!;
  await userEvent.click(firstUncovered);
  await userEvent.keyboard('{ArrowUp}');
  await expect.poll(() => document.activeElement).not.toBe(firstUncovered);
  await expect.poll(() => isClearOfStickyHeaders(document.activeElement as HTMLElement)).toBe(true);
  await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
  await expect.poll(() => isClearOfStickyHeaders(document.activeElement as HTMLElement)).toBe(true);
});

test('changed rows carry data-changed; selecting clears it', async () => {
  const adapter = createMemoryAdapter({ files: { 'a.txt': '', 'b.txt': '', 'c.txt': '' } });
  const fs = await mount({}, { adapter });
  adapter.emit([
    { type: 'updated', path: 'a.txt', actor: 'agent' },
    { type: 'updated', path: 'b.txt', actor: 'agent' },
  ]);
  await expect.poll(() => rowNamed('a.txt').hasAttribute('data-changed')).toBe(true);
  expect(rowNamed('b.txt').hasAttribute('data-changed')).toBe(true);
  expect(rowNamed('c.txt').hasAttribute('data-changed')).toBe(false);

  await userEvent.click(rowNamed('a.txt'));
  await expect.poll(() => rowNamed('a.txt').hasAttribute('data-changed')).toBe(false);
  expect(fs.store.getSnapshot().changed.has('a.txt')).toBe(false);

  await userEvent.keyboard('{ArrowDown}');
  await expect
    .poll(() => rowNamed('b.txt').hasAttribute('data-changed'), {
      message: 'keyboard selection marks it seen',
    })
    .toBe(false);
});

test('loading and error rows show status with an accessible description', async () => {
  const memory = createMemoryAdapter({ files: SLOW_AND_BROKEN_FILES });
  const fs = await mount({}, { adapter: withSlowAndBrokenFolders(memory), fetchDepth: 1 });
  fs.expanded.set(new Set(['slow', 'broken']));
  await expect.poll(() => rowNamed('slow').getAttribute('data-status')).toBe('loading');
  expect(rowNamed('slow').getAttribute('aria-busy')).toBe('true');
  await expect.poll(() => rowNamed('broken').getAttribute('data-status')).toBe('error');
  await expect.element(rowNamed('broken')).toHaveAccessibleDescription('Permission denied');
  expect(rowNamed('ok').hasAttribute('data-status')).toBe(false);
  expect(rowNamed('z.txt').hasAttribute('data-status')).toBe(false);
});

test('a row is marked pending while a mutation is in flight', async () => {
  const adapter = createMemoryAdapter({ files: { 'a.txt': '' }, latencyMs: 100 });
  const fs = await mount({}, { adapter });
  const creation = fs.store.create('', 'b.txt', 'file');
  await expect.poll(() => rowNamed('b.txt')?.hasAttribute('data-pending')).toBe(true);
  await creation;
  await expect.poll(() => rowNamed('b.txt').hasAttribute('data-pending')).toBe(false);
});

test('focus moves to the next row after the focused row is deleted', async () => {
  const fs = await mount({ 'a.txt': '', 'b.txt': '', 'c.txt': '' });
  rowNamed('b.txt').focus();
  await fs.store.remove('b.txt');
  await expect.poll(active).toBe('c.txt');
  await fs.store.remove('c.txt');
  await expect.poll(active, { message: 'the last row was removed: focus the new last row' }).toBe('a.txt');
});

test('focus moves to the row at its index when an external change removes the focused row', async () => {
  const adapter = createMemoryAdapter({ files: { 'a.txt': '', 'b.txt': '', 'c.txt': '' } });
  await mount({}, { adapter });
  rowNamed('a.txt').focus();
  await adapter.delete!('a.txt');
  await expect.poll(rowNames).toEqual(['b.txt', 'c.txt']);
  await expect.poll(active).toBe('b.txt');
});

test('focus moves to the row at its index when the focused row is collapsed away', async () => {
  const fs = await mount({ 'src/a.ts': '', 'src/b.ts': '', 'z.txt': '' });
  fs.expanded.set(new Set(['src']));
  await expect.poll(rowNames).toEqual(['src', 'a.ts', 'b.ts', 'z.txt']);
  rowNamed('b.ts').focus();
  fs.expanded.set(new Set());
  await expect.poll(rowNames).toEqual(['src', 'z.txt']);
  await expect.poll(active).toBe('z.txt');
});

test('focus stays in the tree when Show hidden is turned off while a hidden row has focus', async () => {
  const fs = await mount({ '.git/config': '', 'a.txt': '', 'b.txt': '' });
  fs.showHidden.set(true);
  await expect.poll(rowNames).toEqual(['.git', 'a.txt', 'b.txt']);
  rowNamed('.git').focus();
  fs.showHidden.set(false);
  await expect.poll(rowNames).toEqual(['a.txt', 'b.txt']);
  await expect.poll(active).toBe('a.txt');
});

test('focus moves to the empty state when the last row goes, and back to the row when one returns', async () => {
  const fs = await mount({ 'a.txt': '' }, { props: { emptyState: 'No files' } });
  rowNamed('a.txt').focus();
  await fs.store.remove('a.txt');
  await expect.poll(() => document.activeElement).toBe(emptyState());
  expect(emptyState()!.tabIndex).toBe(-1);
  await fs.store.create('', 'b.txt', 'file');
  await expect.poll(rowNames).toEqual(['b.txt']);
  await expect.poll(active, { message: 'not left on body when the empty state unmounts' }).toBe('b.txt');
});

test('the tree is one tab stop: Tab goes from before the tree to its row, then out', async () => {
  let captured: FileSystemContext | undefined;
  await render(
    <FileSystemProvider adapter={createMemoryAdapter({ files: manyFiles(100) })}>
      <input aria-label="before" />
      <FileTree rowHeight={ROW_HEIGHT} style={{ height: VIEWPORT_ROWS * ROW_HEIGHT }} />
      <input aria-label="after" />
      <CaptureContext onContext={(fs) => (captured = fs)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => captured && statusOf(captured.store.getSnapshot().tree, '')).toBe('loaded');
  await expect.poll(() => rows().length).toBeGreaterThan(0);
  document.querySelector<HTMLElement>('input[aria-label=before]')!.focus();
  await userEvent.tab();
  await expect.poll(active, { message: 'the scrolling viewport is not a tab stop' }).toBe('f00000.txt');
  await userEvent.tab();
  await expect.poll(() => document.activeElement?.getAttribute('aria-label')).toBe('after');
});

test('a click selects and previews a file and a double click pins it', async () => {
  const onOpenFile = vi.fn();
  const fs = await mount({ 'z.txt': '' }, { props: { onOpenFile } });
  await userEvent.click(rowNamed('z.txt'));
  expect(fs.selected.get()).toBe('z.txt');
  expect(onOpenFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'z.txt' }), 'preview');
  await userEvent.dblClick(rowNamed('z.txt'));
  expect(onOpenFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'z.txt' }), 'pin');
});

test('a click on a folder selects and toggles it once, from the label, the chevron or a double click', async () => {
  const onOpenFile = vi.fn();
  const fs = await mount({ 'src/a.ts': '', 'z.txt': '' }, { props: { onOpenFile } });
  await userEvent.click(rowNamed('src'));
  expect(fs.selected.get()).toBe('src');
  await expect.poll(rowNames).toEqual(['src', 'a.ts', 'z.txt']);
  await userEvent.click(rowNamed('src').querySelector<HTMLElement>('[data-fs-part=tree-chevron]')!);
  await expect.poll(rowNames, { message: 'the chevron toggles once, not twice' }).toEqual(['src', 'z.txt']);
  await userEvent.dblClick(rowNamed('src'));
  await expect.poll(rowNames, { message: 'a double click toggles once' }).toEqual(['src', 'a.ts', 'z.txt']);
  expect(onOpenFile).not.toHaveBeenCalled();
});

test('the tree sets --fs-row-height from the row height in use', async () => {
  await mount({ 'a.txt': '' }, { props: { rowHeight: 30 } });
  expect(viewport().style.getPropertyValue('--fs-row-height')).toBe('30px');
  expect(rowNamed('a.txt').getBoundingClientRect().height).toBe(30);
});

test('the focus ring is drawn for keyboard focus only', async () => {
  await mount({ 'a.txt': '', 'b.txt': '' });
  await userEvent.click(rowNamed('a.txt'));
  expect(getComputedStyle(rowNamed('a.txt')).outlineStyle).toBe('none');
  await userEvent.keyboard('{ArrowDown}');
  await expect.poll(active).toBe('b.txt');
  expect(getComputedStyle(rowNamed('b.txt')).outlineStyle).toBe('solid');
});

test('an empty folder shows the empty state', async () => {
  await mount({}, { props: { emptyState: 'Nothing here yet' } });
  await expect
    .poll(() => document.querySelector('[data-fs-part=tree-empty]')?.textContent)
    .toBe('Nothing here yet');
});

test('axe: no violations with expanded, selected, changed, loading and error rows, in light and dark', async () => {
  const memory = createMemoryAdapter({ files: SLOW_AND_BROKEN_FILES });
  const fs = await mount({}, { adapter: withSlowAndBrokenFolders(memory), fetchDepth: 1 });
  fs.expanded.set(new Set(['slow', 'broken', 'ok']));
  fs.selected.set('z.txt');
  await expect.poll(rowNames).toEqual(['broken', 'ok', 'c.txt', 'slow', 'z.txt']);
  memory.emit([
    { type: 'updated', path: 'ok/c.txt', actor: 'agent' },
    { type: 'updated', path: 'z.txt', actor: 'agent' },
  ]);
  await expect.poll(() => rowNamed('c.txt').hasAttribute('data-changed')).toBe(true);
  await expect.poll(() => rowNamed('broken').getAttribute('data-status')).toBe('error');
  expect(rowNamed('z.txt').hasAttribute('data-changed'), 'changed and selected').toBe(true);
  expect(rowNamed('slow').getAttribute('data-status')).toBe('loading');
  expect(rowNamed('z.txt').getAttribute('aria-selected')).toBe('true');
  for (const colorScheme of ['light', 'dark'] as const) {
    await commands.emulateMedia({ colorScheme });
    await themeTransitionsToFinish();
    const results = await axe.run(viewport());
    expect(
      results.violations.map((violation) => `${colorScheme} ${violation.id}: ${violation.help}`),
    ).toEqual([]);
  }
});

test('a row rendered outside <FileTree> throws an error that says where to render it', async () => {
  const caught = vi.fn();
  class CatchError extends Component<{ children: ReactNode }, { message: string | null }> {
    state = { message: null };
    static getDerivedStateFromError(error: Error): { message: string } {
      return { message: error.message };
    }
    componentDidCatch(error: Error): void {
      caught(error.message);
    }
    render(): ReactNode {
      return this.state.message ?? this.props.children;
    }
  }
  const silenceReactErrorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await render(
      <FileSystemProvider adapter={createMemoryAdapter({ files: {} })}>
        <CatchError>
          <TreeRow
            path="a.txt"
            rowIndex={0}
            offset={0}
            depth={0}
            setSize={1}
            posInSet={1}
            isTabStop
            isFocused={false}
          />
        </CatchError>
      </FileSystemProvider>,
    );
    await expect.poll(() => caught.mock.calls.length).toBe(1);
    expect(caught.mock.calls[0]![0]).toMatch(/inside <FileTree>/);
  } finally {
    silenceReactErrorLog.mockRestore();
  }
});

test('renderIcon, renderBadge, renderTrailing and classNames apply', async () => {
  await mount(
    { 'src/a.ts': '', 'z.txt': '' },
    {
      props: {
        className: 'my-tree',
        'aria-label': 'Workspace files',
        classNames: { 'tree-row': 'my-row', 'tree-row-label': 'my-label', tree: 'my-tree-part' },
        renderIcon: (entry, { expanded }) => (
          <span data-testid={`icon-${entry.name}`}>
            {entry.kind === 'directory' && expanded ? 'open' : 'icon'}
          </span>
        ),
        renderBadge: (entry) => <b data-testid={`badge-${entry.name}`}>M</b>,
        renderTrailing: (entry) => <i data-testid={`trailing-${entry.name}`}>1 KB</i>,
      },
    },
  );
  expect(tree().getAttribute('aria-label')).toBe('Workspace files');
  expect(viewport().classList.contains('my-tree'), 'className goes on the root').toBe(true);
  expect(tree().classList.contains('my-tree-part')).toBe(true);
  const row = rowNamed('z.txt');
  expect(row.classList.contains('my-row')).toBe(true);
  expect(row.querySelector('[data-fs-part=tree-row-label]')!.classList.contains('my-label')).toBe(true);
  expect(row.querySelector('[data-fs-part=tree-row-icon] [data-testid="icon-z.txt"]')).not.toBeNull();
  expect(row.querySelector('[data-fs-part=tree-badge] [data-testid="badge-z.txt"]')).not.toBeNull();
  expect(row.querySelector('[data-fs-part=tree-trailing] [data-testid="trailing-z.txt"]')).not.toBeNull();
  expect(rowNamed('src').querySelector('[data-testid=icon-src]')!.textContent).toBe('icon');
});
