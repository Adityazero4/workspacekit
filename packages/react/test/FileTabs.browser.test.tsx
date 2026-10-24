import { fileTabRenders, treeRowRenders } from './support/countComponentRenders';
import { FsError, statusOf, type FileSystemAdapter } from '@workspacekit/core';
import { createMemoryAdapter, type MemoryAdapter } from '@workspacekit/core/memory';
import axe from 'axe-core';
import { useEffect, useState, type ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { followMove } from '../src/actions/followMove';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { useFileSystem, type FileSystemContext } from '../src/provider/hooks';
import { FileTabs, type FileTabsProps } from '../src/tabs/FileTabs';
import type { TabsState } from '../src/tabs/tabs-store';
import { useTabs, type TabsApi } from '../src/tabs/useTabs';
import { FileTree } from '../src/tree/FileTree';
import { cssTransitionsToSettle } from './support/cssTransitionsToSettle';
import { interactionSettled } from './support/interactionSettled';

interface Mounted {
  fs: FileSystemContext;
  tabs: () => TabsApi;
  adapter: MemoryAdapter;
}

function Capture(props: { onCapture: (fs: FileSystemContext, tabs: TabsApi) => void }): null {
  const fs = useFileSystem();
  const tabs = useTabs();
  useEffect(() => {
    props.onCapture(fs, tabs);
  });
  return null;
}

const FILES = {
  'a.txt': 'a',
  'b.txt': 'b',
  'c.txt': 'c',
  'src/lib/one.ts': '1',
  'src/two.ts': '2',
};

async function mount(children: ReactNode, files: Record<string, string> = FILES): Promise<Mounted> {
  const adapter = createMemoryAdapter({ files });
  let fs: FileSystemContext | undefined;
  let tabs: TabsApi | undefined;
  await render(
    <FileSystemProvider adapter={adapter}>
      {children}
      <Capture onCapture={(context, api) => ((fs = context), (tabs = api))} />
    </FileSystemProvider>,
  );
  await expect.poll(() => fs && statusOf(fs.store.getSnapshot().tree, '')).toBe('loaded');
  return { fs: fs!, tabs: () => tabs!, adapter };
}

const allTabs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role=tab]')];
const tabNamed = (name: string): HTMLElement => {
  const found = allTabs().find((tab) => tab.querySelector('[data-fs-part=tab-label]')?.textContent === name);
  if (!found) {
    throw new Error(
      `no tab named ${name}; tabs: ${allTabs()
        .map((tab) => tab.textContent)
        .join(', ')}`,
    );
  }
  return found;
};
const tabNames = (): string[] =>
  allTabs().map((tab) => tab.querySelector('[data-fs-part=tab-label]')?.textContent ?? '');
const activeName = (): string | undefined =>
  allTabs()
    .find((tab) => tab.getAttribute('aria-selected') === 'true')
    ?.querySelector('[data-fs-part=tab-label]')?.textContent ?? undefined;
const focusedName = (): string | undefined =>
  document.activeElement?.querySelector('[data-fs-part=tab-label]')?.textContent ?? undefined;
const tabStops = (): string[] =>
  allTabs()
    .filter((tab) => tab.tabIndex === 0)
    .map((tab) => tab.querySelector('[data-fs-part=tab-label]')?.textContent ?? '');

async function openPinned(tabs: () => TabsApi, ...paths: string[]): Promise<void> {
  for (const path of paths) tabs().open(path, 'pin');
  await expect.poll(tabNames).toEqual(paths.map((path) => path.split('/').pop()));
}

test('keyboard tablist pattern and middle-click close', async () => {
  const { tabs } = await mount(<FileTabs />);
  await openPinned(tabs, 'a.txt', 'b.txt', 'c.txt');
  const tablist = document.querySelector('[role=tablist]')!;
  expect(tablist.getAttribute('aria-label')).toBe('Open files');
  expect(tablist.getAttribute('data-fs-part')).toBe('tabs');
  expect(activeName()).toBe('c.txt');
  expect(tabStops()).toEqual(['c.txt']);
  expect(allTabs().some((tab) => tab.hasAttribute('aria-controls'))).toBe(false);
  const close = tabNamed('a.txt').querySelector<HTMLElement>('[data-fs-part=tab-close]')!;
  expect(close.getAttribute('aria-hidden'), 'the close icon is mouse-only').toBe('true');
  expect(close.title).toBe('Close a.txt');
  expect(close.tabIndex).toBe(-1);
  expect(allTabs().every((tab) => tab.getAttribute('aria-keyshortcuts') === 'Delete')).toBe(true);

  tabNamed('c.txt').focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(focusedName(), 'Right wraps to the first tab').toBe('a.txt');
  expect(activeName(), 'manual activation: focus alone does not activate').toBe('c.txt');
  await expect.poll(tabStops).toEqual(['a.txt']);
  await userEvent.keyboard('{ArrowLeft}');
  expect(focusedName(), 'Left wraps to the last tab').toBe('c.txt');
  await userEvent.keyboard('{Home}');
  expect(focusedName()).toBe('a.txt');
  await userEvent.keyboard('{End}');
  expect(focusedName()).toBe('c.txt');
  await userEvent.keyboard('{ArrowLeft}');
  await userEvent.keyboard('{Enter}');
  await expect.poll(activeName).toBe('b.txt');
  await userEvent.keyboard('{Home}');
  await userEvent.keyboard(' ');
  await expect.poll(activeName).toBe('a.txt');

  await userEvent.keyboard('{Delete}');
  await expect.poll(tabNames).toEqual(['b.txt', 'c.txt']);
  expect(activeName(), 'the neighbour is activated').toBe('b.txt');
  await expect.poll(focusedName, { message: 'focus moves to the new tab stop' }).toBe('b.txt');

  await userEvent.keyboard('{Backspace}');
  await expect.poll(tabNames, { message: 'Backspace closes too (Mac keyboards)' }).toEqual(['c.txt']);
  await openPinned(tabs, 'c.txt', 'b.txt');

  await userEvent.click(tabNamed('c.txt'), { button: 'middle' });
  await expect.poll(tabNames).toEqual(['b.txt']);
  await userEvent.click(tabNamed('b.txt').querySelector('[data-fs-part=tab-close]')!);
  await expect.poll(tabNames).toEqual([]);
  expect(tabs().active).toBeNull();
});

test('a click activates a tab, a double click pins a preview tab, and preview, dirty and changed are marked', async () => {
  const { tabs, adapter } = await mount(<FileTabs />);
  await openPinned(tabs, 'a.txt');
  tabs().open('b.txt');
  await expect.poll(tabNames).toEqual(['a.txt', 'b.txt']);
  expect(tabNamed('b.txt').hasAttribute('data-preview')).toBe(true);
  expect(getComputedStyle(tabNamed('b.txt').querySelector('[data-fs-part=tab-label]')!).fontStyle).toBe(
    'italic',
  );
  await userEvent.click(tabNamed('a.txt'));
  expect(tabs().active).toBe('a.txt');
  expect(tabNamed('a.txt').hasAttribute('data-selected')).toBe(true);
  await userEvent.dblClick(tabNamed('b.txt'));
  await expect.poll(() => tabNamed('b.txt').hasAttribute('data-preview')).toBe(false);

  tabs().setDirty('a.txt', true);
  await expect.poll(() => tabNamed('a.txt').hasAttribute('data-dirty')).toBe(true);
  const description = document.getElementById(tabNamed('a.txt').getAttribute('aria-describedby')!);
  expect(description?.textContent).toBe('Unsaved changes');

  adapter.emit([{ type: 'updated', path: 'b.txt', actor: 'agent' }]);
  await expect.poll(() => tabNamed('b.txt').hasAttribute('data-changed')).toBe(true);
});

test('closing a dirty tab asks first; focus returns to the tab strip', async () => {
  const { tabs } = await mount(<FileTabs />);
  await openPinned(tabs, 'a.txt', 'b.txt');
  tabs().setDirty('b.txt', true);
  await expect.poll(() => tabNamed('b.txt').hasAttribute('data-dirty')).toBe(true);
  tabNamed('b.txt').focus();

  await userEvent.keyboard('{Delete}');
  const dialog = await vi.waitFor(() => document.querySelector<HTMLElement>('[role=alertdialog]')!);
  expect(dialog.textContent).toContain('b.txt');
  await userEvent.click(dialog.querySelector<HTMLElement>('[data-fs-part=dialog-button]')!);
  await expect.poll(() => document.querySelector('[role=alertdialog]')).toBeNull();
  expect(tabNames()).toEqual(['a.txt', 'b.txt']);
  await expect.poll(focusedName).toBe('b.txt');

  await userEvent.keyboard('{Delete}');
  const again = await vi.waitFor(() => document.querySelector<HTMLElement>('[role=alertdialog]')!);
  await userEvent.click(again.querySelector<HTMLElement>('[data-fs-part=dialog-button-danger]')!);
  await expect.poll(tabNames).toEqual(['a.txt']);
  await expect.poll(focusedName).toBe('a.txt');
});

test('rename and move of a folder remap open tabs below it', async () => {
  const { fs, tabs, adapter } = await mount(<FileTabs />);
  await fs.store.loadFolder('src/lib');
  await openPinned(tabs, 'src/lib/one.ts', 'src/two.ts');
  await fs.store.rename('src', 'app');
  await expect.poll(() => tabs().tabs.map((tab) => tab.path)).toEqual(['app/lib/one.ts', 'app/two.ts']);
  expect(tabs().active).toBe('app/two.ts');
  expect(tabNamed('two.ts').title).toBe('app/two.ts');

  await adapter.move!('app/lib', 'lib');
  await expect.poll(() => tabs().tabs.map((tab) => tab.path)).toEqual(['lib/one.ts', 'app/two.ts']);
});

test('deleting a file closes its clean tab and marks a dirty one', async () => {
  const { fs, tabs, adapter } = await mount(<FileTabs />);
  await openPinned(tabs, 'a.txt', 'b.txt', 'src/two.ts');
  tabs().setDirty('src/two.ts', true);
  await fs.store.remove('a.txt');
  await expect.poll(tabNames).toEqual(['b.txt', 'two.ts']);
  await adapter.delete!('src');
  await expect.poll(() => tabNamed('two.ts').hasAttribute('data-deleted')).toBe(true);
  expect(tabNames()).toEqual(['b.txt', 'two.ts']);
  expect(document.getElementById(tabNamed('two.ts').getAttribute('aria-describedby')!)?.textContent).toBe(
    'Unsaved changes, deleted',
  );
});

function Controlled(props: { initial: TabsState; onChange: (state: TabsState) => void } & FileTabsProps) {
  const { initial, onChange, ...rest } = props;
  const [state, setState] = useState(initial);
  return (
    <FileTabs
      {...rest}
      tabs={state}
      onTabsChange={(next) => {
        onChange(next);
        setState(next);
      }}
    />
  );
}

test('controlled mode calls onTabsChange and renders from props', async () => {
  const onChange = vi.fn();
  const initial: TabsState = {
    tabs: [
      { path: 'a.txt', preview: false, dirty: false },
      { path: 'src/two.ts', preview: false, dirty: false },
      { path: 'c.txt', preview: true, dirty: false },
    ],
    active: 'a.txt',
  };
  const { fs, tabs } = await mount(<Controlled initial={initial} onChange={onChange} />);
  expect(tabNames()).toEqual(['a.txt', 'two.ts', 'c.txt']);
  expect(tabs().tabs, 'useTabs shows the provider state, not the controlled one').toEqual([]);

  await userEvent.click(tabNamed('c.txt'));
  expect(onChange).toHaveBeenLastCalledWith({ ...initial, active: 'c.txt' });
  await expect.poll(activeName).toBe('c.txt');

  await fs.store.rename('src', 'app');
  await expect
    .poll(() => onChange.mock.lastCall?.[0])
    .toEqual({
      tabs: [initial.tabs[0], { ...initial.tabs[1], path: 'app/two.ts' }, initial.tabs[2]],
      active: 'c.txt',
    });
  await fs.store.remove('c.txt');
  await expect.poll(tabNames).toEqual(['a.txt', 'two.ts']);
  expect(onChange.mock.lastCall?.[0].active).toBe('app/two.ts');
  expect(tabs().tabs).toEqual([]);
});

test('a controlled strip that ignores onTabsChange keeps rendering its props', async () => {
  const onTabsChange = vi.fn();
  const state: TabsState = { tabs: [{ path: 'a.txt', preview: false, dirty: false }], active: 'a.txt' };
  await mount(<FileTabs tabs={state} onTabsChange={onTabsChange} />);
  await userEvent.click(tabNamed('a.txt').querySelector('[data-fs-part=tab-close]')!);
  expect(onTabsChange).toHaveBeenCalledWith({ tabs: [], active: null });
  expect(tabNames()).toEqual(['a.txt']);
});

test('opening and activating tabs re-renders no tree rows and only the tabs that changed', async () => {
  const { tabs } = await mount(
    <>
      <FileTree style={{ height: 240 }} />
      <FileTabs />
    </>,
  );
  await expect.poll(() => document.querySelectorAll('[role=treeitem]').length).toBeGreaterThan(0);
  await openPinned(tabs, 'a.txt', 'b.txt', 'c.txt');
  await interactionSettled();
  treeRowRenders.updates = treeRowRenders.mounts = 0;
  fileTabRenders.updates = fileTabRenders.mounts = 0;

  tabs().activate('a.txt');
  await expect.poll(activeName).toBe('a.txt');
  await interactionSettled();
  expect(fileTabRenders, 'the previously and newly active tabs').toEqual({ updates: 2, mounts: 0 });

  fileTabRenders.updates = fileTabRenders.mounts = 0;
  tabs().open('src/two.ts');
  await expect.poll(activeName).toBe('two.ts');
  await interactionSettled();
  expect(treeRowRenders).toEqual({ updates: 0, mounts: 0 });
  expect(fileTabRenders, 'the previously active tab and the new one').toEqual({ updates: 1, mounts: 1 });
});

test('many tabs scroll the strip horizontally; the active tab scrolls into view within the strip, never the page', async () => {
  const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`file-number-${i}.txt`, '']));
  const { tabs } = await mount(
    <div style={{ width: 300, marginTop: 2000 }}>
      <FileTabs />
    </div>,
    files,
  );
  for (let i = 0; i < 40; i++) tabs().open(`file-number-${i}.txt`, 'pin');
  await expect.poll(() => allTabs().length).toBe(40);
  const strip = document.querySelector<HTMLElement>('[role=tablist]')!;
  window.scrollTo(0, 0);
  expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
  tabs().activate('file-number-0.txt');
  await expect.poll(() => strip.scrollLeft).toBe(0);
  tabs().activate('file-number-39.txt');
  await expect.poll(() => strip.scrollLeft).toBeGreaterThan(0);
  const stripBox = strip.getBoundingClientRect();
  const activeBox = tabNamed('file-number-39.txt').getBoundingClientRect();
  expect(activeBox.right).toBeLessThanOrEqual(stripBox.right + 1);
  expect(window.scrollY).toBe(0);
});

test('axe: no violations in the tab strip with active, preview, dirty, changed and deleted tabs', async () => {
  const { fs, tabs, adapter } = await mount(<FileTabs />);
  await openPinned(tabs, 'a.txt', 'b.txt');
  tabs().open('c.txt');
  tabs().setDirty('a.txt', true);
  adapter.emit([{ type: 'updated', path: 'b.txt', actor: 'agent' }]);
  await adapter.delete!('a.txt');
  await expect.poll(() => tabNamed('a.txt').hasAttribute('data-deleted')).toBe(true);
  await expect.poll(() => tabNamed('b.txt').hasAttribute('data-changed')).toBe(true);
  expect(fs.store.getSnapshot().changed.has('b.txt')).toBe(true);
  const results = await axe.run(document.querySelector<HTMLElement>('[role=tablist]')!);
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});

test('axe: a deleted or changed tab stays readable while it is the active one, light and dark', async () => {
  const { tabs, adapter } = await mount(<FileTabs />);
  await openPinned(tabs, 'a.txt', 'b.txt');
  tabs().setDirty('a.txt', true);
  adapter.emit([{ type: 'updated', path: 'b.txt', actor: 'agent' }]);
  await adapter.delete!('a.txt');
  await expect.poll(() => tabNamed('a.txt').hasAttribute('data-deleted')).toBe(true);
  await expect.poll(() => tabNamed('b.txt').hasAttribute('data-changed')).toBe(true);
  const violations: string[] = [];
  for (const active of ['a.txt', 'b.txt']) {
    tabs().activate(active);
    await expect.poll(() => tabNamed(active).getAttribute('aria-selected')).toBe('true');
    for (const colorScheme of ['light', 'dark'] as const) {
      await commands.emulateMedia({ colorScheme });
      await cssTransitionsToSettle();
      const results = await axe.run(document.querySelector<HTMLElement>('[role=tablist]')!);
      violations.push(...results.violations.map((violation) => `${active} ${colorScheme}: ${violation.id}`));
    }
  }
  await commands.emulateMedia({ colorScheme: null });
  expect(violations).toEqual([]);
});

function TreeOpeningTabs(): React.JSX.Element {
  const tabs = useTabs();
  return <FileTree style={{ height: 240 }} onOpenFile={(entry, how) => tabs.open(entry.path, how)} />;
}

test('a tree wired through onOpenFile previews a file on click and pins it on double click', async () => {
  const { tabs } = await mount(
    <>
      <TreeOpeningTabs />
      <FileTabs />
    </>,
  );
  const row = (name: string): HTMLElement =>
    [...document.querySelectorAll<HTMLElement>('[role=treeitem]')].find((item) => item.textContent === name)!;
  await expect.poll(() => row('a.txt')).toBeDefined();
  await userEvent.click(row('a.txt'));
  await expect.poll(() => tabs().tabs).toEqual([{ path: 'a.txt', preview: true, dirty: false }]);
  await userEvent.click(row('b.txt'));
  await expect.poll(() => tabs().tabs).toEqual([{ path: 'b.txt', preview: true, dirty: false }]);
  await userEvent.dblClick(row('b.txt'));
  await expect.poll(() => tabs().tabs).toEqual([{ path: 'b.txt', preview: false, dirty: false }]);
  expect(tabs().active).toBe('b.txt');
});

test('tabbing back into the strip lands on the active tab, not the one last focused', async () => {
  const { tabs } = await mount(
    <>
      <FileTabs />
      <input aria-label="after the strip" />
    </>,
  );
  await openPinned(tabs, 'a.txt', 'b.txt', 'c.txt');
  tabNamed('c.txt').focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(focusedName()).toBe('a.txt');
  await userEvent.tab();
  await expect.poll(() => document.activeElement?.getAttribute('aria-label')).toBe('after the strip');
  await expect.poll(tabStops).toEqual(['c.txt']);
  await userEvent.tab({ shift: true });
  await expect.poll(focusedName).toBe('c.txt');
});

test('a tab renamed while its close confirmation is open is the one that closes', async () => {
  const { fs, tabs } = await mount(<FileTabs />);
  await openPinned(tabs, 'a.txt', 'b.txt');
  tabs().setDirty('a.txt', true);
  await expect.poll(() => tabNamed('a.txt').hasAttribute('data-dirty')).toBe(true);
  tabNamed('a.txt').focus();
  await userEvent.keyboard('{Delete}');
  const dialog = await vi.waitFor(() => document.querySelector<HTMLElement>('[role=alertdialog]')!);
  await fs.store.rename('a.txt', 'renamed.txt');
  await expect.poll(tabNames).toEqual(['renamed.txt', 'b.txt']);
  await userEvent.click(dialog.querySelector<HTMLElement>('[data-fs-part=dialog-button-danger]')!);
  await expect.poll(tabNames).toEqual(['b.txt']);
});

test('a controlled strip keeps a clean tab open while a failed followMove of its file is in flight', async () => {
  const memory = createMemoryAdapter({ files: FILES });
  const failing: FileSystemAdapter = {
    ...memory,
    move: async () => {
      await new Promise(requestAnimationFrame);
      throw new FsError('unknown', 'the server refused');
    },
  };
  const onChange = vi.fn();
  let fs: FileSystemContext | undefined;
  await render(
    <FileSystemProvider adapter={failing}>
      <Controlled
        initial={{ tabs: [{ path: 'a.txt', preview: false, dirty: false }], active: 'a.txt' }}
        onChange={onChange}
      />
      <Capture onCapture={(context) => (fs = context)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => fs && statusOf(fs.store.getSnapshot().tree, '')).toBe('loaded');
  await followMove(fs!, 'a.txt', 'z.txt', () => fs!.store.rename('a.txt', 'z.txt')).catch(() => undefined);
  await interactionSettled();
  expect(tabNames()).toEqual(['a.txt']);
  expect(onChange).not.toHaveBeenCalled();
});

test('useTabs().open ignores the root and paths outside it, like a restored tab', async () => {
  let tabs: TabsApi | undefined;
  await render(
    <FileSystemProvider adapter={createMemoryAdapter({ files: FILES })} root="src">
      <Capture onCapture={(_, api) => (tabs = api)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => tabs).toBeDefined();
  tabs!.open('src');
  tabs!.open('a.txt');
  tabs!.open('src/two.ts', 'pin');
  await expect.poll(() => tabs!.tabs).toEqual([{ path: 'src/two.ts', preview: false, dirty: false }]);
});
