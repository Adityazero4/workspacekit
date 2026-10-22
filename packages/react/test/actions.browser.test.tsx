import { statusOf, type FileSystemAdapter } from '@scope/core';
import { createMemoryAdapter, type MemoryAdapter } from '@scope/core/memory';
import axe from 'axe-core';
import { useEffect } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import type { Action } from '../src/actions/actions';
import type { DialogSlotProps, MenuSlotProps } from '../src/components';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { useFileSystem, type FileSystemContext, type Notice } from '../src/provider/hooks';
import { FileTree, type FileTreeProps } from '../src/tree/FileTree';
import { isMac } from '../src/tree/keyboard';
import { interactionSettled } from './support/interactionSettled';

const ROW_HEIGHT = 24;
const MOD = isMac() ? 'Meta' : 'Control';
const withMod = (key: string): string => `{${MOD}>}${key}{/${MOD}}`;

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
  unmount: () => Promise<void>;
}

const mount = async (
  files: Record<string, string>,
  props: Partial<FileTreeProps> = {},
  adaptAdapter: (memory: MemoryAdapter) => FileSystemAdapter = (memory) => memory,
): Promise<Mounted> => {
  const adapter = createMemoryAdapter({ files });
  const notices: Notice[] = [];
  let captured: FileSystemContext | undefined;
  const screen = await render(
    <FileSystemProvider adapter={adaptAdapter(adapter)} onNotify={(notice) => notices.push(notice)}>
      <FileTree rowHeight={ROW_HEIGHT} style={{ height: 10 * ROW_HEIGHT }} {...props} />
      <CaptureContext onContext={(fs) => (captured = fs)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => captured && statusOf(captured.store.getSnapshot().tree, '')).toBe('loaded');
  if (Object.keys(files).length > 0) await expect.poll(() => rows().length).toBeGreaterThan(0);
  return { fs: captured!, adapter, notices, unmount: () => screen.unmount() };
};

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await commands.emulateMedia({ colorScheme: null });
});

const rightClickWithoutAPointer = (element: HTMLElement): MouseEvent => {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
  element.dispatchEvent(event);
  return event;
};
const resolvedColor = (value: string): string => {
  const probe = document.createElement('span');
  probe.style.color = value;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
};

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role=treeitem]')];
const labelOf = (row: Element): string | null | undefined =>
  row.querySelector('[data-fs-part=tree-row-label]')?.textContent;
const rowNamed = (name: string): HTMLElement => rows().find((row) => labelOf(row) === name)!;
const rowNames = (): Array<string | null | undefined> => rows().map(labelOf);
const active = (): string | null | undefined => {
  const focused = document.activeElement;
  return focused?.getAttribute('role') === 'treeitem' ? labelOf(focused) : undefined;
};
const moreButton = (name: string): HTMLElement =>
  rowNamed(name).querySelector<HTMLElement>('[data-fs-part=tree-row-more]')!;
const menu = (): HTMLElement | null => document.querySelector<HTMLElement>('[role=menu]');
const menuLabels = (): Array<string | null> =>
  [...document.querySelectorAll('[role=menuitem] [data-fs-part=menu-item-label]')].map(
    (label) => label.textContent,
  );
const menuItem = (label: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((item) =>
    item.textContent?.startsWith(label),
  )!;
const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role=dialog], [role=alertdialog]');
const buttonIn = (container: HTMLElement, text: string): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('button')].find((button) => button.textContent === text)!;
const listing = async (adapter: MemoryAdapter, path = ''): Promise<string[]> =>
  (await adapter.list(path, { depth: 1 })).map((entry) => entry.name);

const openContextMenu = async (name: string): Promise<void> => {
  await userEvent.click(rowNamed(name), { button: 'right' });
  await expect.poll(menu).not.toBeNull();
};
const openMoreActions = async (name: string): Promise<void> => {
  await userEvent.click(moreButton(name));
  await expect.poll(menu).not.toBeNull();
};
const openWithKeyboard = async (name: string): Promise<void> => {
  rowNamed(name).focus();
  await userEvent.keyboard('{Shift>}{F10}{/Shift}');
  await expect.poll(menu).not.toBeNull();
};
const pressEscape = async (): Promise<void> => {
  await userEvent.keyboard('{Escape}');
  await expect.poll(() => menu() ?? dialog()).toBeNull();
};
const choose = async (label: string): Promise<void> => {
  await userEvent.click(menuItem(label));
  await expect.poll(menu).toBeNull();
};

test('canPerform hides an action everywhere', async () => {
  const ask: Action = { id: 'ask', label: 'Ask the agent', shortcut: 'Mod+Shift+K', run: vi.fn() };
  const { fs } = await mount(
    { 'a.txt': '' },
    { actions: [ask], canPerform: (actionId) => actionId !== 'copy' && actionId !== 'ask' },
  );

  await openContextMenu('a.txt');
  expect(menuLabels()).toContain('Cut');
  expect(menuLabels()).not.toContain('Copy');
  expect(menuLabels()).not.toContain('Ask the agent');
  await pressEscape();

  await openMoreActions('a.txt');
  expect(menuLabels()).toContain('Cut');
  expect(menuLabels()).not.toContain('Copy');
  await pressEscape();

  rowNamed('a.txt').focus();
  await userEvent.keyboard(withMod('c'));
  await userEvent.keyboard(`{${MOD}>}{Shift>}k{/Shift}{/${MOD}}`);
  expect(fs.clipboard.get(), 'Mod+C did nothing').toBeNull();
  expect(ask.run).not.toHaveBeenCalled();
  await userEvent.keyboard(withMod('x'));
  expect(fs.clipboard.get(), 'an allowed shortcut still works').toEqual({ op: 'cut', path: 'a.txt' });
});

test('context menu, more-actions and Shift+F10 show the same items', async () => {
  await mount({ 'a.txt': '', 'src/b.txt': '' });
  const expected = [
    'Open',
    'New file…',
    'New folder…',
    'Rename',
    'Duplicate',
    'Delete…',
    'Cut',
    'Copy',
    'Copy path',
    'Download',
    'Upload files…',
    'Upload folder…',
  ];

  await openContextMenu('a.txt');
  expect(menuLabels()).toEqual(expected);
  expect(menu()!.querySelectorAll('[role=separator]'), 'one separator between each of 5 groups').toHaveLength(
    4,
  );
  const deleteItem = menuItem('Delete…');
  expect(deleteItem.dataset.fsPart).toBe('menu-item-danger');
  expect(getComputedStyle(deleteItem).color).toBe(resolvedColor('var(--fs-danger)'));
  expect(getComputedStyle(menuItem('Copy')).color, 'other items are not danger-coloured').not.toBe(
    resolvedColor('var(--fs-danger)'),
  );
  await pressEscape();

  await openMoreActions('a.txt');
  expect(menuLabels()).toEqual(expected);
  await pressEscape();

  await openWithKeyboard('a.txt');
  expect(menuLabels()).toEqual(expected);
  await pressEscape();
});

test('copy then paste into the same folder creates "x copy.ext" with no dialog', async () => {
  const { fs, adapter } = await mount({ 'a.txt': 'hello' });
  await openContextMenu('a.txt');
  await choose('Copy');
  expect(fs.clipboard.get()).toEqual({ op: 'copy', path: 'a.txt' });

  rowNamed('a.txt').focus();
  await userEvent.keyboard(withMod('v'));
  await expect.poll(rowNames).toContain('a copy.txt');
  expect(dialog()).toBeNull();
  expect(await adapter.read('a copy.txt', 'text')).toBe('hello');
  expect(fs.clipboard.get(), 'a copy can be pasted again').toEqual({ op: 'copy', path: 'a.txt' });
});

test('cut then paste moves; cut row carries data-cut until pasted', async () => {
  const { fs, adapter } = await mount({ 'a.txt': 'x', 'dir/b.txt': '' });
  rowNamed('a.txt').focus();
  await userEvent.keyboard(withMod('x'));
  await expect.poll(() => rowNamed('a.txt').hasAttribute('data-cut')).toBe(true);
  expect(rowNamed('dir').hasAttribute('data-cut')).toBe(false);

  await openContextMenu('dir');
  await choose('Paste');
  await expect.poll(() => listing(adapter, 'dir')).toEqual(['a.txt', 'b.txt']);
  await expect.poll(rowNames).toEqual(['dir']);
  expect(document.querySelector('[data-cut]')).toBeNull();
  expect(fs.clipboard.get(), 'a cut is pasted once').toBeNull();
});

test('paste into self is refused with a notice', async () => {
  const { fs, adapter, notices } = await mount({ 'src/a.txt': '' });
  fs.expanded.set(new Set(['src']));
  await expect.poll(rowNames).toEqual(['src', 'a.txt']);

  await openContextMenu('src');
  await choose('Cut');
  await openContextMenu('a.txt');
  await choose('Paste');
  await expect.poll(() => notices.at(-1)?.message).toMatch(/into itself/);
  expect(notices.at(-1)?.kind).toBe('error');
  expect(await listing(adapter)).toEqual(['src']);
  expect(await listing(adapter, 'src')).toEqual(['a.txt']);
  expect(rowNamed('src').hasAttribute('data-cut'), 'the cut stays until a paste succeeds').toBe(true);
});

test('delete asks for confirmation; cancel changes nothing', async () => {
  const { adapter } = await mount({ 'a.txt': '', 'b.txt': '' });
  await openContextMenu('a.txt');
  await choose('Delete…');
  await expect.poll(dialog).not.toBeNull();
  expect(dialog()!.textContent).toContain('Delete "a.txt"?');
  expect(dialog()!.getAttribute('role'), 'a confirmation is an alertdialog').toBe('alertdialog');
  await userEvent.click(buttonIn(dialog()!, 'Cancel'));
  await expect.poll(dialog).toBeNull();
  expect(rowNames()).toEqual(['a.txt', 'b.txt']);
  expect(await listing(adapter)).toEqual(['a.txt', 'b.txt']);

  rowNamed('a.txt').focus();
  await userEvent.keyboard('{Delete}');
  await expect.poll(dialog).not.toBeNull();
  await userEvent.click(buttonIn(dialog()!, 'Delete'));
  await expect.poll(rowNames).toEqual(['b.txt']);
  expect(await listing(adapter)).toEqual(['b.txt']);
  await expect.poll(active, { message: 'focus moves to the row now at the deleted index' }).toBe('b.txt');
});

test('create validates names', async () => {
  const { fs } = await mount({ 'a.txt': '', 'b.txt': '' });
  await openContextMenu('a.txt');
  await choose('New file…');
  await expect.poll(dialog).not.toBeNull();
  const input = dialog()!.querySelector('input')!;
  await expect.poll(() => document.activeElement).toBe(input);
  const messageFor = async (name: string): Promise<string> => {
    await userEvent.fill(input, name);
    await expect.poll(() => input.getAttribute('aria-invalid')).toBe('true');
    return document.getElementById(input.getAttribute('aria-describedby')!)!.textContent!;
  };

  const messages = [await messageFor('B.txt'), await messageFor('x/y'), await messageFor('con')];
  expect(messages[0]).toMatch(/already exists/);
  expect(new Set(messages).size, messages.join(' | ')).toBe(3);

  await userEvent.fill(input, 'new.txt');
  await expect.poll(() => input.getAttribute('aria-invalid')).not.toBe('true');
  await userEvent.keyboard('{Enter}');
  await expect.poll(dialog).toBeNull();
  await expect.poll(rowNames).toContain('new.txt');
  expect(fs.selected.get()).toBe('new.txt');
  await expect.poll(active, { message: 'the new entry is focused' }).toBe('new.txt');
});

test('custom action appears and runs', async () => {
  const run = vi.fn();
  const ask: Action = {
    id: 'ask',
    label: 'Ask the agent',
    group: 'agent',
    shortcut: 'Mod+Shift+K',
    when: (entry) => entry.kind === 'file',
    run,
  };
  await mount({ 'a.txt': '', 'dir/b.txt': '' }, { actions: [ask] });

  await openContextMenu('dir');
  expect(menuLabels()).not.toContain('Ask the agent');
  await pressEscape();

  await openContextMenu('a.txt');
  expect(menuLabels().at(-1)).toBe('Ask the agent');
  await choose('Ask the agent');
  await expect.poll(() => run.mock.calls.length).toBe(1);
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ path: 'a.txt' }),
    expect.objectContaining({ entry: expect.objectContaining({ path: 'a.txt' }) }),
  );

  rowNamed('a.txt').focus();
  await userEvent.keyboard(`{${MOD}>}{Shift>}k{/Shift}{/${MOD}}`);
  await expect.poll(() => run.mock.calls.length, { message: 'the shortcut runs it too' }).toBe(2);
});

test('focus returns to the row after a menu or dialog closes', async () => {
  await mount({ 'a.txt': '', 'b.txt': '' });

  await openWithKeyboard('b.txt');
  await expect.poll(() => document.activeElement?.getAttribute('role')).toBe('menuitem');
  await pressEscape();
  await expect.poll(active, { message: 'after Shift+F10 and Escape' }).toBe('b.txt');

  await openMoreActions('b.txt');
  await pressEscape();
  await expect.poll(active, { message: 'after the More actions menu' }).toBe('b.txt');

  await openContextMenu('b.txt');
  await choose('Delete…');
  await expect.poll(dialog).not.toBeNull();
  await pressEscape();
  await expect.poll(active, { message: 'after the delete dialog' }).toBe('b.txt');

  await openContextMenu('b.txt');
  await choose('New file…');
  await expect.poll(dialog).not.toBeNull();
  await pressEscape();
  await expect.poll(active, { message: 'after the create dialog' }).toBe('b.txt');
});

test('a click on another row closes the menu and leaves focus and selection on that row', async () => {
  const { fs } = await mount({ 'a.txt': '', 'b.txt': '' });
  await openWithKeyboard('b.txt');
  await userEvent.click(rowNamed('a.txt'));
  await expect.poll(menu).toBeNull();
  await expect.poll(() => fs.selected.get()).toBe('a.txt');
  await interactionSettled();
  expect(active(), 'focus stays where the user clicked').toBe('a.txt');
});

test('scrolling the tree closes the menu, whose anchor scrolled away, keeps the scroll position and keeps focus in the tree', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 60 }, (_, index) => [`f${String(index).padStart(2, '0')}.txt`, '']),
  );
  await mount(files);
  await openWithKeyboard('f02.txt');
  const viewport = document.querySelector<HTMLElement>('[data-fs-part=tree-viewport]')!;
  viewport.scrollTop = 20 * ROW_HEIGHT;
  await expect.poll(menu).toBeNull();
  await interactionSettled();
  expect(viewport.scrollTop, 'the scroll is not undone by a focus return').toBe(20 * ROW_HEIGHT);
  expect(active(), 'focus is back on the row the menu came from').toBe('f02.txt');
  await userEvent.keyboard('{ArrowDown}');
  await expect.poll(active, { message: 'the arrow keys still move through the tree' }).toBe('f03.txt');
});

function ListMenu(props: MenuSlotProps): React.JSX.Element {
  return (
    <div data-testid="list-menu">
      {props.groups.flat().map((item) => (
        <button key={item.id} type="button" onClick={() => props.onSelect(item.id)}>
          {item.label}
        </button>
      ))}
      <button type="button" onClick={props.onClose}>
        Close
      </button>
    </div>
  );
}

function PlainDialog(props: DialogSlotProps): React.JSX.Element {
  return (
    <section role={props.role ?? 'dialog'} aria-label={props.title} data-testid="plain-dialog">
      {props.children}
    </section>
  );
}

test('components.Menu and components.Dialog replace the defaults', async () => {
  const { adapter } = await mount(
    { 'a.txt': '', 'b.txt': '' },
    { components: { Menu: ListMenu, Dialog: PlainDialog } },
  );
  const listMenu = (): HTMLElement | null => document.querySelector('[data-testid=list-menu]');
  await userEvent.click(rowNamed('a.txt'), { button: 'right' });
  await expect.poll(listMenu).not.toBeNull();
  expect(document.querySelector('[data-fs-part=menu]')).toBeNull();
  await userEvent.click(buttonIn(listMenu()!, 'Close'));
  await expect.poll(listMenu, { message: 'a plain onClick={onClose} closes it' }).toBeNull();
  await userEvent.click(rowNamed('a.txt'), { button: 'right' });
  await expect.poll(listMenu).not.toBeNull();

  await userEvent.click(buttonIn(listMenu()!, 'Delete…'));
  await expect.poll(() => document.querySelector('[data-testid=plain-dialog]')).not.toBeNull();
  expect(listMenu()).toBeNull();
  expect(document.querySelector('[data-fs-part=dialog]')).toBeNull();
  await userEvent.click(buttonIn(dialog()!, 'Delete'));
  await expect.poll(rowNames).toEqual(['b.txt']);
  expect(await listing(adapter)).toEqual(['b.txt']);
});

test('an entry with no applicable action opens no menu and keeps the browser menu', async () => {
  await mount({ 'a.txt': '' }, { canPerform: () => false });
  const event = rightClickWithoutAPointer(rowNamed('a.txt'));
  await userEvent.click(moreButton('a.txt'));
  await interactionSettled();
  expect(menu()).toBeNull();
  expect(event.defaultPrevented, 'the native context menu is not suppressed').toBe(false);
});

test('a menu whose row disappears closes and does not come back with the row', async () => {
  const { adapter } = await mount({ 'a.txt': 'x', 'b.txt': '' });
  await openContextMenu('a.txt');
  await adapter.delete!('a.txt');
  await expect.poll(rowNames).toEqual(['b.txt']);
  await expect.poll(menu).toBeNull();
  await adapter.create!('a.txt', 'file');
  await expect.poll(rowNames).toEqual(['a.txt', 'b.txt']);
  await interactionSettled();
  expect(menu(), 'the closed overlay is not stuck on a.txt').toBeNull();
  await openContextMenu('b.txt');
  expect(menuLabels()).toContain('Copy');
});

test('a held-down shortcut runs once', async () => {
  await mount({ 'a.txt': '' });
  rowNamed('a.txt').focus();
  await userEvent.keyboard(withMod('c'));
  const pasteKey = (repeat: boolean): boolean =>
    rowNamed('a.txt').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'v',
        metaKey: MOD === 'Meta',
        ctrlKey: MOD === 'Control',
        repeat,
        bubbles: true,
        cancelable: true,
      }),
    );
  pasteKey(false);
  pasteKey(true);
  pasteKey(true);
  await expect.poll(rowNames).toContain('a copy.txt');
  await interactionSettled();
  expect(rowNames()).toEqual(['a copy.txt', 'a.txt']);
});

test('unmounting with a confirmation open answers it with false', async () => {
  let answer: Promise<boolean> | undefined;
  const ask: Action = {
    id: 'ask',
    label: 'Ask first',
    run: (_entry, context) => {
      answer = context.confirm({ title: 'Sure?', confirmLabel: 'Yes' });
    },
  };
  const { unmount } = await mount({ 'a.txt': '' }, { actions: [ask] });
  await openContextMenu('a.txt');
  await choose('Ask first');
  await expect.poll(dialog).not.toBeNull();
  await unmount();
  await expect(answer).resolves.toBe(false);
});

test('Copy path writes the path to the system clipboard and confirms', async () => {
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  const { fs, notices } = await mount({ 'src/a.txt': '' });
  fs.expanded.set(new Set(['src']));
  await expect.poll(rowNames).toEqual(['src', 'a.txt']);
  await openContextMenu('a.txt');
  await choose('Copy path');
  await expect.poll(() => writeText.mock.calls).toEqual([['src/a.txt']]);
  await expect
    .poll(() => notices.at(-1))
    .toEqual({ kind: 'success', message: 'Copied the path of "a.txt".' });
});

test('download saves a blob through a temporary link and revokes its URL afterwards', async () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
  await mount({ 'a.txt': 'hello' });
  await openContextMenu('a.txt');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await userEvent.click(menuItem('Download'));
  await expect
    .poll(async () => {
      await vi.advanceTimersByTimeAsync(10);
      return clicked.length;
    })
    .toBe(1);
  const [link] = clicked;
  expect(link!.href).toBe('blob:download');
  expect(link!.download).toBe('a.txt');
  expect(link!.isConnected, 'the temporary link is removed').toBe(false);
  expect(await (createObjectURL.mock.calls[0]![0] as Blob).text()).toBe('hello');
  expect(revokeObjectURL).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(40_000);
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:download');
});

test('download of a URL result opens it in a new browsing context without an opener', async () => {
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
  await mount({ 'a.txt': '' }, {}, (memory) => ({
    ...memory,
    download: () => Promise.resolve({ url: 'https://files.example/a.txt', fileName: 'renamed.txt' }),
  }));
  await openContextMenu('a.txt');
  await choose('Download');
  await expect.poll(() => clicked.length).toBe(1);
  expect(clicked[0]!.href).toBe('https://files.example/a.txt');
  expect(clicked[0]!.download).toBe('renamed.txt');
  expect(clicked[0]!.target).toBe('_blank');
  expect(clicked[0]!.rel).toBe('noopener noreferrer');
});

test('download refuses a URL result that is not http, https or blob', async () => {
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
  const { notices } = await mount({ 'a.txt': '' }, {}, (memory) => ({
    ...memory,
    download: () => Promise.resolve({ url: 'javascript:alert(1)' }),
  }));
  await openContextMenu('a.txt');
  await choose('Download');
  await expect
    .poll(() => notices.find((notice) => notice.kind === 'error')?.message)
    .toContain('javascript:');
  expect(clicked).toEqual([]);
});

function Framed({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return <p data-testid="framed-empty-state">{children}</p>;
}

test('components.EmptyState wraps the empty state', async () => {
  await mount({}, { emptyState: 'No files yet', components: { EmptyState: Framed } });
  await expect
    .poll(
      () => document.querySelector('[data-fs-part=tree-empty] [data-testid=framed-empty-state]')?.textContent,
    )
    .toBe('No files yet');
});

test('axe: no violations in the open menu and the open dialog, in light and dark', async () => {
  await mount({ 'a.txt': '', 'b.txt': '' });
  const violationsIn = async (element: HTMLElement, label: string): Promise<string[]> => {
    const results = await axe.run(element);
    return results.violations.map((violation) => `${label} ${violation.id}: ${violation.help}`);
  };
  for (const colorScheme of ['light', 'dark'] as const) {
    await commands.emulateMedia({ colorScheme });
    await expect.poll(() => matchMedia('(prefers-color-scheme: dark)').matches).toBe(colorScheme === 'dark');
    await openContextMenu('a.txt');
    expect(await violationsIn(menu()!, `${colorScheme} menu`)).toEqual([]);
    await choose('Delete…');
    await expect.poll(dialog).not.toBeNull();
    expect(await violationsIn(dialog()!, `${colorScheme} dialog`)).toEqual([]);
    await pressEscape();
    await openContextMenu('a.txt');
    await choose('New file…');
    await expect.poll(dialog).not.toBeNull();
    await userEvent.fill(dialog()!.querySelector('input')!, 'b.txt');
    await expect.poll(() => dialog()!.querySelector('[aria-invalid=true]')).not.toBeNull();
    expect(await violationsIn(dialog()!, `${colorScheme} create dialog with an error`)).toEqual([]);
    await pressEscape();
  }
});
