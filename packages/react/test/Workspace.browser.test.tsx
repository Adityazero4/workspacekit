import { fileViewerRenders, treeRowRenders } from './support/countComponentRenders';
import type { FileSystemAdapter } from '@workspacekit/core';
import { createMemoryAdapter, type MemoryAdapter } from '@workspacekit/core/memory';
import axe from 'axe-core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, server, userEvent } from 'vitest/browser';
import { createRef, useEffect } from 'react';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { createTreeCommandsHost } from '../src/actions/treeCommands';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { SplitPane } from '../src/workspace/SplitPane';
import { FileTabs } from '../src/tabs/FileTabs';
import { FileTree } from '../src/tree/FileTree';
import { defineRenderer, MATCH_SCORE, type Renderer, type RendererProps } from '../src/viewer/registry';
import { Toolbar } from '../src/workspace/Toolbar';
import { useWorkspace, type WorkspaceController } from '../src/workspace/useWorkspace';
import { Workspace, type WorkspaceProps } from '../src/workspace/Workspace';
import { interactionSettled } from './support/interactionSettled';

const FILES = {
  'a.txt': 'a',
  'b.txt': 'bbbb',
  'c.txt': 'cc',
  'node_modules/dep.js': 'd',
  'src/two.ts': '2',
  'src/lib/one.ts': '1',
};
const DEFAULT_PANE_SIZE = 280;
const WORKSPACE_WIDTH = 900;
const MIN_PANE_SIZE = 160;
const MAX_PANE_SIZE = WORKSPACE_WIDTH * 0.6;

const PAST_THE_FOLLOW_INTERVAL_MS = 600;
const LONG_AFTER_THE_FOLLOW_INTERVAL_MS = 2000;
const useFakeTimeouts = (): void => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

function heldListingsOf(
  memory: MemoryAdapter,
  heldPath: string,
): { adapter: FileSystemAdapter; hold: () => void; release: () => void } {
  let holding = false;
  let release = (): void => undefined;
  let released = Promise.resolve();
  return {
    adapter: {
      ...memory,
      list: async (path, options) => {
        if (holding && path === heldPath) await released;
        return memory.list(path, options);
      },
    },
    hold: () => {
      holding = true;
      released = new Promise((resolve) => (release = resolve));
    },
    release: () => release(),
  };
}
const workspace = (): HTMLElement => document.querySelector<HTMLElement>('[data-fs-part=workspace]')!;
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role=treeitem]')];
const labelOf = (row: Element): string | null | undefined =>
  row.querySelector('[data-fs-part=tree-row-label]')?.textContent;
const rowNames = (): Array<string | null | undefined> => rows().map(labelOf);
const rowNamed = (name: string): HTMLElement | undefined => rows().find((row) => labelOf(row) === name);
const tabs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role=tab]')];
const activeTab = (): HTMLElement | undefined =>
  tabs().find((tab) => tab.getAttribute('aria-selected') === 'true');
const activeTabName = (): string | null | undefined =>
  activeTab()?.querySelector('[data-fs-part=tab-label]')?.textContent;
const separator = (): HTMLElement | null => document.querySelector<HTMLElement>('[role=separator]');
const valueNow = (): number => Number(separator()!.getAttribute('aria-valuenow'));
const panes = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-fs-part=workspace-pane]'),
];
const viewer = (): HTMLElement => document.querySelector<HTMLElement>('[data-fs-part=workspace-viewer]')!;
const viewerTabs = (): HTMLElement[] => [
  ...viewer().querySelectorAll<HTMLElement>(':scope > [data-fs-part=workspace-viewer-tab]'),
];
const shownViewer = (): HTMLElement | undefined => viewerTabs().find((tab) => !tab.hidden);
const toolbarButtons = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[role=toolbar] [data-fs-part=toolbar-button]'),
];
const toolbarLabels = (): Array<string | null> =>
  toolbarButtons().map((button) => button.getAttribute('aria-label'));
const toolbarButton = (label: string): HTMLElement => {
  const found = toolbarButtons().find((button) => button.getAttribute('aria-label') === label);
  if (!found) throw new Error(`no toolbar button "${label}"; buttons: ${toolbarLabels().join(', ')}`);
  return found;
};

async function mount(
  props: Partial<WorkspaceProps> = {},
  adapter: FileSystemAdapter = createMemoryAdapter({ files: FILES }),
): Promise<{ adapter: FileSystemAdapter; unmount: () => Promise<void> }> {
  const screen = await render(
    <Workspace adapter={adapter} style={{ width: WORKSPACE_WIDTH, height: 480 }} {...props} />,
  );
  await expect.poll(() => rowNames().length).toBeGreaterThan(0);
  return { adapter, unmount: () => screen.unmount() };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('renders tree, tabs, the empty viewer and then the default FileViewer', async () => {
  await mount();
  expect(rowNames()).toEqual(['src', 'a.txt', 'b.txt', 'c.txt']);
  expect(document.querySelector('[role=tablist]')).not.toBeNull();
  expect(tabs()).toEqual([]);
  expect(document.querySelector('[role=toolbar]')).not.toBeNull();
  expect(document.querySelector('[data-fs-part=search-input]')).not.toBeNull();
  expect(separator()).not.toBeNull();
  expect(viewer().querySelector('[data-fs-part=viewer-placeholder]')?.textContent).toBe(
    'Select a file to open it.',
  );
  await userEvent.click(rowNamed('a.txt')!);
  await expect.poll(activeTabName).toBe('a.txt');
  await expect
    .poll(() => shownViewer()?.querySelector('[data-fs-part=viewer-name]')?.textContent)
    .toBe('a.txt');
  await expect.poll(() => shownViewer()?.querySelector('textarea')?.value).toBe('a');
  expect(viewer().querySelector('[data-fs-part=viewer-placeholder]')).toBeNull();
});

test('showSearch and showToolbar turn off the search box and the toolbar', async () => {
  await mount({ showSearch: false, showToolbar: false });
  expect(document.querySelector('[role=toolbar]')).toBeNull();
  expect(document.querySelector('[data-fs-part=search-input]')).toBeNull();
});

test('opening a file shows renderViewer(path) in the active tab', async () => {
  const renderViewer = (path: string): React.JSX.Element => <p data-testid="viewer">viewer:{path}</p>;
  await mount({ renderViewer });
  await userEvent.click(rowNamed('a.txt')!);
  await expect.poll(activeTabName).toBe('a.txt');
  expect(activeTab()!.hasAttribute('data-preview'), 'a click previews').toBe(true);
  expect(shownViewer()?.textContent).toBe('viewer:a.txt');

  await userEvent.dblClick(rowNamed('b.txt')!);
  await expect.poll(activeTabName).toBe('b.txt');
  expect(activeTab()!.hasAttribute('data-preview'), 'a double click pins').toBe(false);
  expect(shownViewer()?.textContent).toBe('viewer:b.txt');

  rowNamed('c.txt')!.focus();
  await userEvent.keyboard('{Enter}');
  await expect.poll(activeTabName).toBe('c.txt');
  expect(activeTab()!.hasAttribute('data-preview'), 'Enter pins').toBe(false);
  expect(shownViewer()?.textContent).toBe('viewer:c.txt');
});

test('toolbar hides unsupported actions for a read-only adapter', async () => {
  const {
    create,
    write,
    move,
    copy,
    delete: remove,
    upload,
    ...readOnly
  } = createMemoryAdapter({
    files: FILES,
  });
  const { unmount } = await mount({}, readOnly);
  expect(toolbarLabels()).toEqual([
    'Collapse all folders',
    'Sort',
    'Show hidden files',
    'Follow agent changes',
  ]);
  await unmount();

  await mount();
  expect(toolbarLabels()).toEqual([
    'New file',
    'New folder',
    'Upload files',
    'Collapse all folders',
    'Sort',
    'Show hidden files',
    'Follow agent changes',
  ]);
});

test('a tree action canPerform denies stays in place, aria-disabled, and does nothing', async () => {
  const deniedUnderSrc = (actionId: string, entry: { path: string }): boolean =>
    actionId !== 'newFile' || !entry.path.startsWith('src');
  await mount({ canPerform: deniedUnderSrc });
  const labelsBefore = toolbarLabels();
  expect(toolbarButton('New file').hasAttribute('aria-disabled')).toBe(false);
  toolbarButton('New folder').focus();
  await userEvent.click(rowNamed('src')!);
  await expect.poll(() => toolbarButton('New file').getAttribute('aria-disabled')).toBe('true');
  expect(toolbarLabels(), 'the buttons do not shift').toEqual(labelsBefore);
  expect(toolbarButton('New folder').tabIndex, 'the tab stop stays').toBe(0);
  toolbarButton('New file').click();
  await interactionSettled();
  expect(document.querySelector('[role=dialog]')).toBeNull();
  await userEvent.click(rowNamed('a.txt')!);
  await expect.poll(() => toolbarButton('New file').hasAttribute('aria-disabled')).toBe(false);
});

test('a canPerform that denies newFile everywhere disables the New file button', async () => {
  await mount({ canPerform: (actionId) => actionId !== 'newFile' });
  expect(toolbarButton('New file').getAttribute('aria-disabled')).toBe('true');
  expect(toolbarButton('New folder').hasAttribute('aria-disabled')).toBe(false);
});

test('the toolbar follows a canPerform that changes without a selection change, both ways', async () => {
  const adapter = createMemoryAdapter({ files: FILES });
  const workspaceWith = (canPerform: (actionId: string) => boolean): React.JSX.Element => (
    <Workspace adapter={adapter} canPerform={canPerform} style={{ width: 900, height: 480 }} />
  );
  const screen = await render(workspaceWith((actionId) => actionId !== 'newFile'));
  await expect.poll(() => toolbarButton('New file').getAttribute('aria-disabled')).toBe('true');

  await screen.rerender(workspaceWith(() => true));
  await expect.poll(() => toolbarButton('New file').hasAttribute('aria-disabled')).toBe(false);
  await userEvent.click(toolbarButton('New file'));
  await expect.poll(() => document.querySelector('[role=dialog]')).not.toBeNull();
  await userEvent.keyboard('{Escape}');
  await expect.poll(() => document.querySelector('[role=dialog]')).toBeNull();

  await screen.rerender(workspaceWith((actionId) => actionId !== 'newFile'));
  await expect.poll(() => toolbarButton('New file').getAttribute('aria-disabled')).toBe('true');
  toolbarButton('New file').click();
  await interactionSettled();
  expect(document.querySelector('[role=dialog]')).toBeNull();
});

test('toolbar buttons are labelled and form one tab stop moved with the arrow keys', async () => {
  await mount();
  for (const button of toolbarButtons()) {
    expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label'));
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  }
  expect(toolbarButtons().filter((button) => button.tabIndex === 0)).toHaveLength(1);
  toolbarButtons()[0]!.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(document.activeElement).toBe(toolbarButton('New folder'));
  await userEvent.keyboard('{End}');
  expect(document.activeElement).toBe(toolbarButton('Follow agent changes'));
  await userEvent.keyboard('{ArrowRight}');
  expect(document.activeElement, 'wraps').toBe(toolbarButton('New file'));
  await userEvent.keyboard('{ArrowLeft}');
  expect(document.activeElement).toBe(toolbarButton('Follow agent changes'));
  expect(toolbarButton('Follow agent changes').tabIndex).toBe(0);
});

test('New file in the toolbar creates in the selected folder; cancelling returns focus to the button', async () => {
  const { adapter } = await mount();
  await userEvent.click(rowNamed('src')!);
  await userEvent.click(toolbarButton('New file'));
  const input = await vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>('[role=dialog] input');
    if (!found) throw new Error('no dialog');
    return found;
  });
  await userEvent.type(input, 'new.ts{Enter}');
  await expect.poll(async () => (await adapter.stat!('src/new.ts'))?.kind).toBe('file');
  await expect.poll(() => rowNamed('new.ts')?.getAttribute('aria-selected')).toBe('true');

  await userEvent.click(toolbarButton('New folder'));
  await expect.poll(() => document.querySelector('[role=dialog]')).not.toBeNull();
  await userEvent.keyboard('{Escape}');
  await expect.poll(() => document.querySelector('[role=dialog]')).toBeNull();
  await expect.poll(() => document.activeElement).toBe(toolbarButton('New folder'));
});

test('Upload files in the toolbar opens the file picker', async () => {
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
  await mount();
  await userEvent.click(toolbarButton('Upload files'));
  expect(click).toHaveBeenCalledTimes(1);
  expect((click.mock.contexts[0] as HTMLInputElement).type).toBe('file');
});

test('Sort, Show hidden and Collapse all change the tree', async () => {
  await mount();
  await userEvent.click(toolbarButton('Sort'));
  const sizeItem = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role=menuitemradio]')].find(
      (item) => item.textContent === 'Size',
    );
    if (!found) throw new Error('no Size item');
    return found;
  });
  expect(
    [...document.querySelectorAll('[role=menuitemradio][aria-checked=true]')].map((item) => item.textContent),
  ).toEqual(['Name', 'Ascending']);
  await userEvent.click(sizeItem);
  await expect.poll(() => rowNames()).toEqual(['src', 'a.txt', 'c.txt', 'b.txt']);
  await expect.poll(() => document.activeElement).toBe(toolbarButton('Sort'));
  await userEvent.click(toolbarButton('Sort'));
  const descending = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role=menuitemradio]')].find(
      (item) => item.textContent === 'Descending',
    );
    if (!found) throw new Error('no Descending item');
    return found;
  });
  await userEvent.click(descending);
  await expect.poll(() => rowNames()).toEqual(['src', 'b.txt', 'c.txt', 'a.txt']);

  expect(toolbarButton('Show hidden files').getAttribute('aria-pressed')).toBe('false');
  await userEvent.click(toolbarButton('Show hidden files'));
  expect(toolbarButton('Show hidden files').getAttribute('aria-pressed')).toBe('true');
  await expect.poll(() => rowNames()).toContain('node_modules');

  await userEvent.click(rowNamed('src')!);
  await expect.poll(() => rowNamed('src')?.getAttribute('aria-expanded')).toBe('true');
  await userEvent.click(toolbarButton('Collapse all folders'));
  await expect.poll(() => rowNamed('src')?.getAttribute('aria-expanded')).toBe('false');
});

test('a click outside the Sort menu closes it and leaves focus where the user clicked', async () => {
  await mount();
  await userEvent.click(toolbarButton('Sort'));
  await expect.poll(() => document.querySelector('[role=menu]')).not.toBeNull();
  const search = document.querySelector<HTMLElement>('[data-fs-part=search-input]')!;
  await userEvent.click(search, { position: { x: 8, y: 8 } });
  await expect.poll(() => document.querySelector('[role=menu]')).toBeNull();
  await interactionSettled();
  expect(document.activeElement, 'focus stays in the clicked search box').toBe(search);
});

test('separator resizes with keyboard and persists size', async () => {
  const { unmount } = await mount({ storageKey: 'ws' });
  const handle = separator()!;
  expect(handle.getAttribute('aria-orientation')).toBe('vertical');
  expect(handle.getAttribute('aria-valuemin')).toBe(String(MIN_PANE_SIZE));
  await expect.poll(() => handle.getAttribute('aria-valuemax')).toBe(String(MAX_PANE_SIZE));
  expect(handle.getAttribute('aria-controls')).toBe(panes()[0]!.id);
  expect(valueNow()).toBe(DEFAULT_PANE_SIZE);
  const rowRendersBefore = treeRowRenders.updates;

  handle.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(valueNow()).toBe(DEFAULT_PANE_SIZE + 16);
  await expect.poll(() => panes()[0]!.getBoundingClientRect().width).toBe(DEFAULT_PANE_SIZE + 16);
  await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
  expect(valueNow()).toBe(DEFAULT_PANE_SIZE - 16);
  await userEvent.keyboard('{Home}');
  expect(valueNow()).toBe(MIN_PANE_SIZE);
  await userEvent.keyboard('{ArrowLeft}');
  expect(valueNow(), 'never below the minimum').toBe(MIN_PANE_SIZE);
  await userEvent.keyboard('{End}');
  expect(valueNow()).toBe(MAX_PANE_SIZE);
  expect(treeRowRenders.updates, 'resizing re-renders no tree row').toBe(rowRendersBefore);

  await expect.poll(() => localStorage.getItem('ws:pane')).toBe(String(MAX_PANE_SIZE));
  await unmount();
  const restored = await mount({ storageKey: 'ws' });
  await expect.poll(valueNow).toBe(MAX_PANE_SIZE);
  await restored.unmount();

  localStorage.setItem('ws:pane', '5000');
  const tooWide = await mount({ storageKey: 'ws' });
  await expect.poll(valueNow).toBe(MAX_PANE_SIZE);
  await tooWide.unmount();
  localStorage.setItem('ws:pane', '"wide"');
  await mount({ storageKey: 'ws' });
  await interactionSettled();
  expect(valueNow(), 'a malformed size is ignored').toBe(DEFAULT_PANE_SIZE);
});

test('dragging the separator resizes the panes without re-rendering tree rows', async () => {
  await mount();
  const handle = separator()!;
  const rowRendersBefore = treeRowRenders.updates;
  const handleBox = handle.getBoundingClientRect();
  const viewerBox = panes()[1]!.getBoundingClientRect();
  const targetX = 100;
  await userEvent.dragAndDrop(page.elementLocator(handle), page.elementLocator(panes()[1]!), {
    targetPosition: { x: targetX, y: viewerBox.height / 2 },
  });
  const moved = viewerBox.left + targetX - (handleBox.left + handleBox.width / 2);
  await expect.poll(() => Math.abs(valueNow() - (DEFAULT_PANE_SIZE + moved))).toBeLessThanOrEqual(2);
  expect(Math.abs(panes()[0]!.getBoundingClientRect().width - valueNow())).toBeLessThanOrEqual(1);
  expect(treeRowRenders.updates, 'dragging re-renders no tree row').toBe(rowRendersBefore);
});

test('follow mode reveals and opens the latest agent change without stealing focus from an input', async () => {
  const adapter = createMemoryAdapter({ files: FILES });
  await render(
    <>
      <input aria-label="Message the agent" />
      <Workspace adapter={adapter} defaultFollow style={{ width: 900, height: 480 }} />
    </>,
  );
  await expect.poll(() => rowNames().length).toBeGreaterThan(0);
  expect(toolbarButton('Follow agent changes').getAttribute('aria-pressed')).toBe('true');
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Message the agent"]')!;
  input.focus();

  adapter.emit([{ type: 'updated', path: 'src/two.ts', actor: 'external' }]);
  await expect.poll(() => rowNamed('two.ts')?.getAttribute('aria-selected')).toBe('true');
  expect(rowNamed('src')!.getAttribute('aria-expanded')).toBe('true');
  await expect.poll(activeTabName).toBe('two.ts');
  expect(activeTab()!.hasAttribute('data-preview')).toBe(true);
  expect(rowNamed('two.ts')!.hasAttribute('data-flash')).toBe(true);
  expect(document.activeElement, 'the input keeps focus').toBe(input);
});

test('follow mode leaves focus on the tree row the user is on', async () => {
  const adapter = createMemoryAdapter({ files: FILES });
  await mount({ defaultFollow: true }, adapter);
  rowNamed('a.txt')!.focus();
  adapter.emit([{ type: 'updated', path: 'c.txt', actor: 'external' }]);
  await expect.poll(() => rowNamed('c.txt')?.getAttribute('aria-selected')).toBe('true');
  await expect.poll(activeTabName).toBe('c.txt');
  expect(document.activeElement, 'focus stays on the row').toBe(rowNamed('a.txt'));
});

test('follow mode scrolls a revealed row into view without focusing it', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [`file-${String(index).padStart(3, '0')}.txt`, '']),
  );
  const adapter = createMemoryAdapter({ files });
  await mount({ defaultFollow: true }, adapter);
  expect(rowNamed('file-180.txt'), 'starts out of the rendered window').toBeUndefined();
  adapter.emit([{ type: 'updated', path: 'file-180.txt', actor: 'external' }]);
  await expect.poll(() => rowNamed('file-180.txt')?.getAttribute('aria-selected')).toBe('true');
  const viewport = document.querySelector('[data-fs-part=tree-viewport]')!.getBoundingClientRect();
  await expect
    .poll(() => {
      const row = rowNamed('file-180.txt')!.getBoundingClientRect();
      return row.top >= viewport.top - 0.5 && row.bottom <= viewport.bottom + 0.5;
    })
    .toBe(true);
  expect(document.activeElement).toBe(document.body);
});

test('follow mode coalesces changes to one reveal per 500 ms, the latest winning, and ignores local changes', async () => {
  const adapter = createMemoryAdapter({ files: FILES });
  const viewed: string[] = [];
  const renderViewer = (path: string): React.JSX.Element => {
    if (viewed.at(-1) !== path) viewed.push(path);
    return <p>{path}</p>;
  };
  await mount({ defaultFollow: true, renderViewer }, adapter);
  useFakeTimeouts();
  adapter.emit([{ type: 'updated', path: 'a.txt', actor: 'external' }]);
  await vi.advanceTimersByTimeAsync(100);
  adapter.emit([{ type: 'updated', path: 'b.txt', actor: 'agent' }]);
  await vi.advanceTimersByTimeAsync(399);
  expect(activeTabName(), 'not before 500 ms').toBeUndefined();
  await vi.advanceTimersByTimeAsync(PAST_THE_FOLLOW_INTERVAL_MS);
  await expect.poll(activeTabName).toBe('b.txt');
  expect(viewed).toEqual(['b.txt']);
  expect(rowNamed('a.txt')!.hasAttribute('data-changed'), 'the skipped change stays marked').toBe(true);

  await adapter.create!('fresh.txt', 'file');
  await vi.advanceTimersByTimeAsync(LONG_AFTER_THE_FOLLOW_INTERVAL_MS);
  await interactionSettled();
  expect(activeTabName(), 'a change made by the local user is not followed').toBe('b.txt');
});

test('follow ignores the user renaming a folder that holds marked files', async () => {
  const adapter = createMemoryAdapter({ files: FILES });
  await mount({}, adapter);
  useFakeTimeouts();
  adapter.emit([{ type: 'updated', path: 'src/two.ts', actor: 'external' }]);
  await userEvent.click(toolbarButton('Follow agent changes'));
  rowNamed('src')!.focus();
  await userEvent.keyboard('{F2}');
  const input = await vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>('[data-fs-part=tree-rename-input]');
    if (!found) throw new Error('no rename input');
    return found;
  });
  input.select();
  await userEvent.keyboard('renamed{Enter}');
  await expect.poll(() => rowNamed('renamed')).toBeDefined();
  await vi.advanceTimersByTimeAsync(LONG_AFTER_THE_FOLLOW_INTERVAL_MS);
  await interactionSettled();
  expect(tabs(), 'nothing was followed').toEqual([]);
  expect(rowNamed('renamed')!.getAttribute('aria-expanded')).toBe('false');
});

test('follow follows a repeated agent edit to a path that is still marked', async () => {
  const adapter = createMemoryAdapter({ files: FILES });
  await mount({ defaultFollow: true }, adapter);
  adapter.emit([{ type: 'updated', path: 'a.txt', actor: 'agent' }]);
  adapter.emit([{ type: 'updated', path: 'b.txt', actor: 'agent' }]);
  await expect.poll(activeTabName).toBe('b.txt');
  expect(rowNamed('a.txt')!.hasAttribute('data-changed')).toBe(true);
  adapter.emit([{ type: 'updated', path: 'a.txt', actor: 'agent' }]);
  await expect.poll(activeTabName).toBe('a.txt');
  expect(rowNamed('a.txt')!.getAttribute('aria-selected')).toBe('true');
});

test('a burst of 5,000 agent changes in one batch gives one reveal and one preview tab', async () => {
  const names = Array.from({ length: 5000 }, (_, index) => `f-${String(index).padStart(4, '0')}.txt`);
  const adapter = createMemoryAdapter({ files: Object.fromEntries(names.map((name) => [name, ''])) });
  const viewed: string[] = [];
  const renderViewer = (path: string): React.JSX.Element => {
    if (viewed.at(-1) !== path) viewed.push(path);
    return <p>{path}</p>;
  };
  await mount({ defaultFollow: true, renderViewer }, adapter);
  useFakeTimeouts();
  adapter.emit(names.map((path) => ({ type: 'updated', path, actor: 'agent' })));
  await vi.advanceTimersByTimeAsync(PAST_THE_FOLLOW_INTERVAL_MS);
  await expect.poll(activeTabName).toBe('f-4999.txt');
  await vi.advanceTimersByTimeAsync(LONG_AFTER_THE_FOLLOW_INTERVAL_MS);
  await interactionSettled();
  expect(viewed).toEqual(['f-4999.txt']);
  expect(tabs()).toHaveLength(1);
});

test('follow never replaces a reveal the user started from search', async () => {
  const memory = createMemoryAdapter({ files: { ...FILES, 'slow/deep/target.txt': 't' } });
  const slowDeep = heldListingsOf(memory, 'slow/deep');
  await mount({ defaultFollow: true }, slowDeep.adapter);
  slowDeep.hold();
  const search = document.querySelector<HTMLInputElement>('[data-fs-part=search-input]')!;
  await userEvent.click(search);
  await userEvent.fill(search, 'target');
  const option = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>('[role=option]');
    if (!found) throw new Error('no result yet');
    return found;
  });
  await userEvent.click(option);
  useFakeTimeouts();
  memory.emit([{ type: 'updated', path: 'c.txt', actor: 'agent' }]);
  await vi.advanceTimersByTimeAsync(PAST_THE_FOLLOW_INTERVAL_MS);
  await interactionSettled();
  slowDeep.release();
  await expect.poll(() => document.activeElement === rowNamed('target.txt')).toBe(true);
  await expect.poll(activeTabName).toBe('c.txt');
  expect(document.activeElement, 'the user keeps their pick').toBe(rowNamed('target.txt'));
});

test('follow skips a change whose file is gone, or under a hidden name, by the time it checks', async () => {
  const adapter = createMemoryAdapter({ files: FILES });
  await mount({ defaultFollow: true }, adapter);
  useFakeTimeouts();
  adapter.emit([{ type: 'updated', path: 'c.txt', actor: 'agent' }]);
  await adapter.delete!('c.txt');
  await vi.advanceTimersByTimeAsync(LONG_AFTER_THE_FOLLOW_INTERVAL_MS);
  await interactionSettled();
  expect(tabs()).toEqual([]);
  expect(rows().filter((row) => row.getAttribute('aria-selected') === 'true')).toEqual([]);

  adapter.emit([{ type: 'updated', path: 'node_modules/dep.js', actor: 'agent' }]);
  await vi.advanceTimersByTimeAsync(LONG_AFTER_THE_FOLLOW_INTERVAL_MS);
  await interactionSettled();
  expect(tabs()).toEqual([]);
});

test('unmounting while a follow check or its reveal is pending is quiet', async () => {
  const errors = vi.spyOn(console, 'error');
  const memory = createMemoryAdapter({ files: { ...FILES, 'slow/deep/x.txt': 'x' } });
  const slowDeep = heldListingsOf(memory, 'slow/deep');
  const first = await mount({ defaultFollow: true }, slowDeep.adapter);
  memory.emit([{ type: 'updated', path: 'a.txt', actor: 'agent' }]);
  await first.unmount();
  const second = await mount({ defaultFollow: true }, slowDeep.adapter);
  await userEvent.click(rowNamed('slow')!);
  await expect.poll(() => rowNamed('deep')).toBeDefined();
  slowDeep.hold();
  useFakeTimeouts();
  memory.emit([{ type: 'updated', path: 'slow/deep', actor: 'agent' }]);
  memory.emit([{ type: 'created', path: 'slow/deep/x.txt', actor: 'agent' }]);
  await vi.advanceTimersByTimeAsync(PAST_THE_FOLLOW_INTERVAL_MS);
  await interactionSettled();
  await second.unmount();
  slowDeep.release();
  await vi.advanceTimersByTimeAsync(LONG_AFTER_THE_FOLLOW_INTERVAL_MS);
  await interactionSettled();
  expect(errors).not.toHaveBeenCalled();
});

test('with no tree mounted, the toolbar leaves out the tree buttons', async () => {
  await render(
    <FileSystemProvider adapter={createMemoryAdapter({ files: FILES })}>
      <Toolbar treeCommands={createTreeCommandsHost()} follow={false} onFollowChange={() => {}} />
    </FileSystemProvider>,
  );
  expect(toolbarLabels()).toEqual(['Sort', 'Show hidden files', 'Follow agent changes']);
});

test('turning follow off cancels a pending reveal; a controlled follow reports toggles', async () => {
  const adapter = createMemoryAdapter({ files: FILES });
  const onFollowChange = vi.fn();
  const screen = await render(
    <Workspace
      adapter={adapter}
      follow
      onFollowChange={onFollowChange}
      style={{ width: 900, height: 480 }}
    />,
  );
  await expect.poll(() => rowNames().length).toBeGreaterThan(0);
  useFakeTimeouts();
  adapter.emit([{ type: 'updated', path: 'c.txt', actor: 'external' }]);
  await screen.rerender(
    <Workspace
      adapter={adapter}
      follow={false}
      onFollowChange={onFollowChange}
      style={{ width: 900, height: 480 }}
    />,
  );
  await vi.advanceTimersByTimeAsync(LONG_AFTER_THE_FOLLOW_INTERVAL_MS);
  await interactionSettled();
  expect(tabs()).toEqual([]);
  expect(rowNamed('c.txt')!.getAttribute('aria-selected')).toBe('false');
  vi.useRealTimers();

  await userEvent.click(toolbarButton('Follow agent changes'));
  expect(onFollowChange).toHaveBeenCalledWith(true);
  expect(toolbarButton('Follow agent changes').getAttribute('aria-pressed'), 'controlled').toBe('false');
});

test('stacked layout under 640 px', async () => {
  const adapter = createMemoryAdapter({ files: FILES });
  await render(
    <div data-testid="frame" style={{ width: 500 }}>
      <Workspace adapter={adapter} style={{ height: 480 }} />
    </div>,
  );
  await expect.poll(() => rowNames().length).toBeGreaterThan(0);
  const frame = document.querySelector<HTMLElement>('[data-testid=frame]')!;
  await expect.poll(() => separator()).toBeNull();
  const [treePane, viewerPane] = panes();
  expect(treePane!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    viewerPane!.getBoundingClientRect().top + 0.5,
  );
  expect(treePane!.getBoundingClientRect().width).toBe(500);

  const toggle = document.querySelector<HTMLElement>('[data-fs-part=workspace-files-toggle]')!;
  expect(toggle.tagName).toBe('BUTTON');
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  const files = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  expect(files.contains(document.querySelector('[role=tree]'))).toBe(true);
  await userEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(files.checkVisibility()).toBe(false);
  await userEvent.click(toggle);
  expect(files.checkVisibility()).toBe(true);

  frame.style.width = '900px';
  await expect.poll(() => separator()).not.toBeNull();
  expect(document.querySelector('[data-fs-part=workspace-files-toggle]')).toBeNull();
  expect(panes()[0]!.getBoundingClientRect().width).toBe(DEFAULT_PANE_SIZE);
});

test('dropping files onto the workspace uploads them into the store root', async () => {
  const adapter = (await mount()).adapter as MemoryAdapter;
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File(['up'], 'up.txt'));
  const fire = (type: 'dragenter' | 'dragover' | 'dragleave' | 'drop'): DragEvent => {
    const event = new DragEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    viewer().dispatchEvent(event);
    return event;
  };
  fire('dragenter');
  expect(fire('dragover').defaultPrevented, 'the workspace accepts the drop').toBe(true);
  await expect.poll(() => document.querySelector('[data-fs-part=drop-overlay]')).not.toBeNull();
  fire('drop');
  await expect.poll(() => document.querySelector('[data-fs-part=drop-overlay]')).toBeNull();
  await expect.poll(async () => (await adapter.stat!('up.txt'))?.kind).toBe('file');
});

test('theme sets data-theme on the root; system leaves it to the color scheme', async () => {
  const { unmount } = await mount({ theme: 'dark' });
  expect(workspace().getAttribute('data-theme')).toBe('dark');
  await unmount();
  await mount({ theme: 'system' });
  expect(workspace().hasAttribute('data-theme')).toBe(false);
});

test('axe: no violations for the whole workspace, in light and dark', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const { unmount } = await mount({ theme, defaultFollow: true });
    await userEvent.click(rowNamed('src')!);
    await userEvent.click(rowNamed('a.txt')!);
    await expect.poll(activeTabName).toBe('a.txt');
    const results = await axe.run(workspace());
    expect(results.violations.map((violation) => `${theme} ${violation.id}: ${violation.help}`)).toEqual([]);
    await unmount();
  }
});

test('axe: no violations with the Sort menu open, in light and dark', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const { unmount } = await mount({ theme });
    await userEvent.click(toolbarButton('Sort'));
    const menu = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role=menu]');
      if (!found) throw new Error('no menu');
      return found;
    });
    const results = await axe.run(menu);
    expect(results.violations.map((violation) => `${theme} ${violation.id}: ${violation.help}`)).toEqual([]);
    await userEvent.keyboard('{Escape}');
    await unmount();
  }
});

test('the separator never leaves the second pane less than 240 px, even below an explicit max', async () => {
  await render(
    <div style={{ width: 700, height: 480 }}>
      <SplitPane max={600}>
        <div>first</div>
        <div>second</div>
      </SplitPane>
    </div>,
  );
  const handle = separator()!;
  await expect.poll(() => handle.getAttribute('aria-valuemax')).toBe(String(700 - 240));
  handle.focus();
  await userEvent.keyboard('{End}');
  expect(valueNow()).toBe(700 - 240);
  expect(panes()[1]!.getBoundingClientRect().width).toBeGreaterThanOrEqual(240 - 6);
});

const describeFocused = (): string => {
  const focused = document.activeElement as HTMLElement;
  return focused.getAttribute('data-fs-part') ?? focused.getAttribute('aria-label') ?? focused.tagName;
};

const tabStopsFromTheToolbar = async (count: number): Promise<string[]> => {
  toolbarButtons()
    .find((button) => button.tabIndex === 0)!
    .focus();
  const stops = [describeFocused()];
  while (stops.length < count) {
    await userEvent.tab();
    stops.push(describeFocused());
  }
  return stops;
};

test('Tab follows the layout: toolbar, search, tree, upload buttons, separator, active tab, viewer', async () => {
  const { adapter } = await mount({ renderViewer: (path) => <textarea aria-label={`Edit ${path}`} /> });
  await userEvent.click(rowNamed('a.txt')!);
  await expect.poll(activeTabName).toBe('a.txt');
  expect(await tabStopsFromTheToolbar(6)).toEqual([
    'toolbar-button',
    'search-input',
    'tree-row',
    'workspace-separator',
    'tab',
    'Edit a.txt',
  ]);
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File(['up'], 'up.txt'));
  for (const type of ['dragenter', 'dragover', 'drop']) {
    const event = new DragEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    viewer().dispatchEvent(event);
  }
  await expect.poll(async () => (await adapter.stat!('up.txt'))?.kind).toBe('file');
  await expect.poll(() => document.querySelector('[data-fs-part=upload-button]')).not.toBeNull();
  const buttonsWithoutATabIndexAreTabStops = server.browser !== 'webkit';
  expect(await tabStopsFromTheToolbar(buttonsWithoutATabIndexAreTabStops ? 7 : 6)).toEqual([
    'toolbar-button',
    'search-input',
    'tree-row',
    ...(buttonsWithoutATabIndexAreTabStops ? ['upload-button'] : []),
    'workspace-separator',
    'tab',
    'Edit a.txt',
  ]);
});

function probeRenderer(seen: { controller?: WorkspaceController }): Renderer {
  function ProbeRenderer(props: RendererProps): React.JSX.Element {
    const controller = useWorkspace();
    useEffect(() => {
      seen.controller = controller;
    });
    return <p data-testid="probe">{`${props.entry.path} active:${String(props.isActive)}`}</p>;
  }
  return defineRenderer({
    id: 'probe',
    match: (file) => file.kind === 'file' && MATCH_SCORE.specific,
    input: 'none',
    load: () => Promise.resolve({ default: ProbeRenderer }),
  });
}

const probeIn = (element: Element | undefined): string | null | undefined =>
  element?.querySelector('[data-testid=probe]')?.textContent;
const tabNamed = (name: string): HTMLElement =>
  tabs().find((tab) => tab.querySelector('[data-fs-part=tab-label]')?.textContent === name)!;

test('background tabs stay mounted but inactive; closing a tab unmounts its viewer', async () => {
  await mount({ renderers: [probeRenderer({})] });
  await userEvent.dblClick(rowNamed('a.txt')!);
  await expect.poll(() => probeIn(shownViewer())).toBe('a.txt active:true');
  await userEvent.dblClick(rowNamed('b.txt')!);
  await expect.poll(() => probeIn(shownViewer())).toBe('b.txt active:true');
  expect(viewerTabs().map((tab) => [tab.hidden, probeIn(tab)])).toEqual([
    [true, 'a.txt active:false'],
    [false, 'b.txt active:true'],
  ]);

  await userEvent.click(tabNamed('b.txt').querySelector<HTMLElement>('[data-fs-part=tab-close]')!);
  await expect.poll(() => viewerTabs().length).toBe(1);
  await expect.poll(() => probeIn(shownViewer())).toBe('a.txt active:true');
});

test('opening or switching a tab re-renders no tree row; inactive viewers skip unrelated store changes', async () => {
  const seen: { controller?: WorkspaceController } = {};
  const memory = createMemoryAdapter({ files: FILES });
  await mount({ renderers: [probeRenderer(seen)] }, memory);
  await userEvent.click(rowNamed('a.txt')!);
  await expect.poll(() => probeIn(shownViewer())).toBe('a.txt active:true');
  await userEvent.click(tabNamed('a.txt'));
  const rowRendersBefore = treeRowRenders.updates;

  seen.controller!.open('b.txt', 'pin');
  await expect.poll(() => probeIn(shownViewer())).toBe('b.txt active:true');
  await userEvent.click(tabNamed('a.txt'));
  await expect.poll(() => probeIn(shownViewer())).toBe('a.txt active:true');
  expect(treeRowRenders.updates, 'opening and switching tabs re-render no tree row').toBe(rowRendersBefore);

  const viewerRendersBefore = fileViewerRenders.updates;
  await memory.write!('c.txt', 'changed');
  memory.emit([{ type: 'updated', path: 'c.txt', actor: 'external' }]);
  await memory.create!('d.txt', 'file');
  await expect.poll(() => rowNamed('c.txt')?.hasAttribute('data-changed')).toBe(true);
  await expect.poll(() => rowNamed('d.txt')).toBeDefined();
  expect(fileViewerRenders.updates, 'no viewer re-renders for files it does not show').toBe(
    viewerRendersBefore,
  );
});

test('useWorkspace drives open, reveal, refresh, startRename, collapseAll and focus', async () => {
  const memory = createMemoryAdapter({ files: FILES });
  const list = vi.fn(memory.list);
  const adapter: FileSystemAdapter = { ...memory, list };
  const controllers: WorkspaceController[] = [];
  function Probe(): null {
    controllers.push(useWorkspace());
    return null;
  }
  const app = (withTree: boolean): React.JSX.Element => (
    <FileSystemProvider adapter={adapter}>
      <Probe />
      <FileTabs />
      {withTree && <FileTree style={{ height: 300 }} />}
    </FileSystemProvider>
  );
  const screen = await render(app(false));
  const workspaceController = (): WorkspaceController => controllers.at(-1)!;
  workspaceController().collapseAll();
  workspaceController().startRename('a.txt');
  workspaceController().focus('a.txt');

  await screen.rerender(app(true));
  await expect.poll(() => rowNames().length).toBeGreaterThan(0);
  workspaceController().open('a.txt');
  await expect.poll(activeTabName).toBe('a.txt');
  expect(activeTab()!.hasAttribute('data-preview')).toBe(true);
  workspaceController().open('b.txt', 'pin');
  await expect.poll(activeTabName).toBe('b.txt');
  expect(activeTab()!.hasAttribute('data-preview')).toBe(false);

  await workspaceController().reveal('src/lib/one.ts');
  await expect.poll(() => rowNamed('one.ts')?.getAttribute('aria-selected')).toBe('true');

  const refreshed = async (path?: string): Promise<string[]> => {
    list.mockClear();
    await workspaceController().refresh(path);
    return list.mock.calls.map(([listed]) => listed);
  };
  expect(await refreshed('src/two.ts'), 'a file refreshes its folder').toEqual(['src']);
  expect(await refreshed('src/lib'), 'a folder refreshes itself').toEqual(['src/lib']);
  expect(await refreshed(), 'no path refreshes every loaded folder').toEqual(
    expect.arrayContaining(['', 'src', 'src/lib']),
  );

  workspaceController().collapseAll();
  await expect.poll(rowNames).toEqual(['src', 'a.txt', 'b.txt', 'c.txt']);
  workspaceController().focus('b.txt');
  await expect.poll(() => document.activeElement).toBe(rowNamed('b.txt'));
  workspaceController().startRename('c.txt');
  await expect.poll(() => document.querySelector('[data-fs-part=tree-rename-input]')).not.toBeNull();
  await userEvent.keyboard('{Escape}');

  expect(new Set(controllers).size, 'one controller across renders').toBe(1);
});

const readCounter = (memory: MemoryAdapter): { adapter: FileSystemAdapter; readPaths: string[] } => {
  const readPaths: string[] = [];
  const read = ((path: string, ...rest: [never]) => {
    readPaths.push(path);
    return memory.read(path, ...rest);
  }) as FileSystemAdapter['read'];
  return { adapter: { ...memory, read }, readPaths };
};

const viewerIn = (panel: Element | undefined): Element | null | undefined =>
  panel?.querySelector('[data-fs-part=viewer]');

test('restored tabs load lazily: only the active tab reads its file, the others on activation', async () => {
  localStorage.setItem(
    'ws:tabs',
    JSON.stringify({
      tabs: [
        { path: 'a.txt', preview: false },
        { path: 'b.txt', preview: false },
        { path: 'c.txt', preview: false },
      ],
      active: 'b.txt',
    }),
  );
  const { adapter, readPaths } = readCounter(createMemoryAdapter({ files: FILES }));
  await mount({ storageKey: 'ws' }, adapter);
  await expect.poll(() => shownViewer()?.querySelector('textarea')?.value).toBe('bbbb');
  expect(readPaths).toEqual(['b.txt']);
  const neverActive = viewerTabs().filter((panel) => panel.hidden);
  expect(neverActive.map((panel) => viewerIn(panel)?.getAttribute('data-status'))).toEqual([
    'loading',
    'loading',
  ]);
  expect(neverActive.some((panel) => panel.querySelector('textarea'))).toBe(false);

  await userEvent.click(tabNamed('c.txt'));
  await expect.poll(() => shownViewer()?.querySelector('textarea')?.value).toBe('cc');
  expect(readPaths).toEqual(['b.txt', 'c.txt']);
});

test('renaming an open file keeps its viewer mounted and does not read it again', async () => {
  const workspace = createRef<WorkspaceController>();
  const { adapter, readPaths } = readCounter(createMemoryAdapter({ files: FILES }));
  await mount({ ref: workspace }, adapter);
  await userEvent.dblClick(rowNamed('a.txt')!);
  await expect.poll(() => shownViewer()?.querySelector('textarea')?.value).toBe('a');
  const viewerBefore = viewerIn(shownViewer());
  const readsBefore = readPaths.length;

  workspace.current!.startRename('a.txt');
  const input = await vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>('[data-fs-part=tree-rename-input]');
    if (!found) throw new Error('no rename input');
    return found;
  });
  await userEvent.fill(input, 'renamed.txt');
  await userEvent.keyboard('{Enter}');
  await expect.poll(activeTabName).toBe('renamed.txt');
  await expect
    .poll(() => shownViewer()?.querySelector('[data-fs-part=viewer-name]')?.textContent)
    .toBe('renamed.txt');
  expect(viewerIn(shownViewer()), 'the same viewer element').toBe(viewerBefore);
  expect(readPaths.length, 'no read after the rename').toBe(readsBefore);
});

test('a ref drives the workspace from outside it', async () => {
  const workspace = createRef<WorkspaceController>();
  await render(
    <>
      <button type="button" onClick={() => workspace.current?.open('a.txt')}>
        Open a.txt
      </button>
      <Workspace ref={workspace} adapter={createMemoryAdapter({ files: FILES })} style={{ height: 480 }} />
    </>,
  );
  await expect.poll(() => rowNames().length).toBeGreaterThan(0);
  await userEvent.click(page.getByRole('button', { name: 'Open a.txt' }));
  await expect.poll(activeTabName).toBe('a.txt');
});

test('each viewer is a tabpanel labelled by its tab; a switch re-renders only the two viewers involved', async () => {
  const seen: { controller?: WorkspaceController } = {};
  await mount({ renderers: [probeRenderer(seen)] });
  await userEvent.dblClick(rowNamed('a.txt')!);
  await expect.poll(() => probeIn(shownViewer())).toBe('a.txt active:true');
  seen.controller!.open('b.txt', 'pin');
  seen.controller!.open('c.txt', 'pin');
  await expect.poll(() => probeIn(shownViewer())).toBe('c.txt active:true');
  for (const panel of viewerTabs()) {
    expect(panel.getAttribute('role')).toBe('tabpanel');
    const tab = document.getElementById(panel.getAttribute('aria-labelledby')!);
    expect(tab?.getAttribute('role')).toBe('tab');
    expect(tab?.getAttribute('aria-controls')).toBe(panel.id);
  }

  await userEvent.click(tabNamed('b.txt'));
  await expect.poll(() => probeIn(shownViewer())).toBe('b.txt active:true');
  const viewerRendersBefore = fileViewerRenders.updates;
  await userEvent.click(tabNamed('a.txt'));
  await expect.poll(() => probeIn(shownViewer())).toBe('a.txt active:true');
  expect(fileViewerRenders.updates - viewerRendersBefore, 'b goes inactive, a active; c untouched').toBe(2);
});
