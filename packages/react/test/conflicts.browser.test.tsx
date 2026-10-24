import {
  FsError,
  statusOf,
  type Entry,
  type FileSystemAdapter,
  type UploadOptions,
} from '@workspacekit/core';
import { createMemoryAdapter, type MemoryAdapter } from '@workspacekit/core/memory';
import { useEffect, useState } from 'react';
import { expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { transferInto } from '../src/actions/clipboard';
import { useConflictResolver, type ConflictResolver } from '../src/dialogs/conflicts';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { useFileSystem, type FileSystemContext, type Notice } from '../src/provider/hooks';
import { internalsOf } from '../src/provider/internals';
import { FileTree } from '../src/tree/FileTree';
import { UploadStatus } from '../src/uploads/UploadStatus';
import { interactionSettled } from './support/interactionSettled';

const ROW_HEIGHT = 24;

interface Captured {
  fs: FileSystemContext;
  resolve: ConflictResolver;
  showTree: (shown: boolean) => void;
}

function Capture(props: {
  showTree: (shown: boolean) => void;
  onCapture: (captured: Captured) => void;
}): null {
  const fs = useFileSystem();
  const resolve = useConflictResolver();
  useEffect(() => {
    props.onCapture({ fs, resolve, showTree: props.showTree });
  });
  return null;
}

function Workspace(props: { trees: number; onCapture: (captured: Captured) => void }): React.JSX.Element {
  const [treesShown, showTree] = useState(true);
  const trees = treesShown ? Array.from({ length: props.trees }, (_, at) => at) : [];
  return (
    <>
      {trees.map((at) => (
        <FileTree key={at} rowHeight={ROW_HEIGHT} style={{ height: 12 * ROW_HEIGHT }} />
      ))}
      <UploadStatus />
      <Capture showTree={showTree} onCapture={props.onCapture} />
    </>
  );
}

interface Mounted extends Captured {
  adapter: MemoryAdapter;
  notices: Notice[];
}

const mount = async (
  files: Record<string, string>,
  options: {
    trees?: number;
    onUploadConflict?: UploadOptions['onConflict'];
    adapt?: (memory: MemoryAdapter) => FileSystemAdapter;
  } = {},
): Promise<Mounted> => {
  const adapter = createMemoryAdapter({ files });
  const notices: Notice[] = [];
  let captured: Captured | undefined;
  const trees = options.trees ?? 1;
  await render(
    <FileSystemProvider
      adapter={options.adapt?.(adapter) ?? adapter}
      onUploadConflict={options.onUploadConflict}
      onNotify={(notice) => notices.push(notice)}
    >
      <Workspace trees={trees} onCapture={(latest) => (captured = latest)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => captured && statusOf(captured.fs.store.getSnapshot().tree, '')).toBe('loaded');
  if (trees > 0) await expect.poll(() => rows().length).toBeGreaterThan(0);
  return { ...captured!, adapter, notices };
};

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role=treeitem]')];
const labelOf = (row: Element): string | null | undefined =>
  row.querySelector('[data-fs-part=tree-row-label]')?.textContent;
const rowNamed = (name: string): HTMLElement => rows().find((row) => labelOf(row) === name)!;
const active = (): string | null | undefined => {
  const focused = document.activeElement;
  return focused?.getAttribute('role') === 'treeitem' ? labelOf(focused) : undefined;
};
const dialogs = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[role=dialog], [role=alertdialog]'),
];
const dialog = (): HTMLElement | null => dialogs()[0] ?? null;
const dialogTitle = (): string | null | undefined =>
  dialog()?.querySelector('[data-fs-part=dialog-title]')?.textContent;
const buttonIn = (container: HTMLElement, text: string): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('button')].find((button) => button.textContent === text)!;
const buttonLabels = (): Array<string | null> =>
  [...dialog()!.querySelectorAll('button')].map((button) => button.textContent);
const description = (): string | null | undefined =>
  dialog()?.querySelector('[data-fs-part=dialog-description]')?.textContent;
const answer = async (text: string): Promise<void> => {
  await userEvent.click(buttonIn(dialog()!, text));
  await expect.poll(dialog).toBeNull();
};
const listing = async (adapter: MemoryAdapter, path = ''): Promise<string[]> =>
  (await adapter.list(path, { depth: 1 })).map((entry) => entry.name);
const menu = (): HTMLElement | null => document.querySelector<HTMLElement>('[role=menu]');
const choose = async (row: string, label: string): Promise<void> => {
  await userEvent.click(rowNamed(row), { button: 'right' });
  await expect.poll(menu).not.toBeNull();
  const item = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((candidate) =>
    candidate.textContent?.startsWith(label),
  )!;
  await userEvent.click(item);
  await expect.poll(menu).toBeNull();
};
const expandAll = async (fs: FileSystemContext, paths: string[]): Promise<void> => {
  fs.expanded.set((previous) => new Set([...previous, ...paths]));
  for (const path of paths) {
    await expect.poll(() => statusOf(fs.store.getSnapshot().tree, path)).toBe('loaded');
  }
};

const fire = (target: Element, type: string, dataTransfer: DataTransfer): DragEvent => {
  const event = new DragEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(event);
  return event;
};
const dragOnto = (name: string, from: string): void => {
  const dataTransfer = new DataTransfer();
  fire(rowNamed(from), 'dragstart', dataTransfer);
  for (const type of ['dragenter', 'dragover', 'drop']) fire(rowNamed(name), type, dataTransfer);
  fire(rowNamed(from), 'dragend', dataTransfer);
};
const dropOsFiles = (target: Element, files: File[]): void => {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  for (const type of ['dragenter', 'dragover', 'drop']) fire(target, type, dataTransfer);
};

test('paste onto an existing name asks; Replace overwrites, Keep both makes "x copy", Cancel changes nothing', async () => {
  const { adapter } = await mount({ 'a.txt': 'outer', 'dir/a.txt': 'inner' });
  await choose('a.txt', 'Copy');

  await choose('dir', 'Paste');
  await expect.poll(dialogTitle).toBe('"dir/a.txt" already exists');
  expect(dialog()!.getAttribute('role')).toBe('alertdialog');
  await answer('Cancel');
  await expect.poll(active, { message: 'focus returns to the row the paste came from' }).toBe('dir');
  expect(await listing(adapter, 'dir')).toEqual(['a.txt']);
  expect(await adapter.read('dir/a.txt', 'text')).toBe('inner');

  await choose('dir', 'Paste');
  await expect.poll(dialog).not.toBeNull();
  await answer('Keep both');
  await expect.poll(() => listing(adapter, 'dir')).toEqual(['a copy.txt', 'a.txt']);
  expect(await adapter.read('dir/a copy.txt', 'text')).toBe('outer');
  expect(await adapter.read('dir/a.txt', 'text')).toBe('inner');

  await choose('dir', 'Paste');
  await expect.poll(dialog).not.toBeNull();
  await answer('Replace');
  await expect.poll(() => adapter.read('dir/a.txt', 'text')).toBe('outer');
  expect(await listing(adapter, 'dir')).toEqual(['a copy.txt', 'a.txt']);
  expect(await listing(adapter)).toEqual(['a.txt', 'dir']);
});

test('a cut pasted with Keep both moves under a free name; the selection and the clipboard follow', async () => {
  const { fs, adapter } = await mount({ 'a.txt': 'outer', 'dir/a.txt': 'inner' });
  await choose('a.txt', 'Cut');
  await choose('dir', 'Paste');
  await expect.poll(dialogTitle).toBe('"dir/a.txt" already exists');
  await answer('Cancel');
  expect(fs.clipboard.get(), 'a cancelled paste keeps the cut').toEqual({ op: 'cut', path: 'a.txt' });

  fs.selected.set('a.txt');
  await choose('dir', 'Paste');
  await expect.poll(dialog).not.toBeNull();
  await answer('Keep both');
  await expect.poll(() => listing(adapter)).toEqual(['dir']);
  expect(await listing(adapter, 'dir')).toEqual(['a copy.txt', 'a.txt']);
  expect(await adapter.read('dir/a copy.txt', 'text')).toBe('outer');
  expect(fs.selected.get()).toBe('dir/a copy.txt');
  expect(fs.clipboard.get()).toBeNull();
});

test('a copy into its own folder makes "x copy" without asking', async () => {
  const { adapter } = await mount({ 'a.txt': 'x' });
  await choose('a.txt', 'Copy');
  await choose('a.txt', 'Paste');
  await expect.poll(() => listing(adapter)).toEqual(['a copy.txt', 'a.txt']);
  expect(dialog()).toBeNull();
});

test('drag-move onto an existing name asks', async () => {
  const { adapter } = await mount({ 'a.txt': 'A', 'docs/a.txt': 'D' });
  dragOnto('docs', 'a.txt');
  await expect.poll(dialogTitle).toBe('"docs/a.txt" already exists');
  await answer('Replace');
  await expect.poll(() => listing(adapter)).toEqual(['docs']);
  expect(await listing(adapter, 'docs')).toEqual(['a.txt']);
  expect(await adapter.read('docs/a.txt', 'text')).toBe('A');
});

test('upload with 3 conflicts and Apply to all asks once', async () => {
  const names = ['1.txt', '2.txt', '3.txt'];
  const { adapter } = await mount(Object.fromEntries(names.map((name) => [`inbox/${name}`, 'old'])));
  dropOsFiles(
    rowNamed('inbox'),
    names.map((name) => new File(['new'], name)),
  );
  await expect.poll(dialog).not.toBeNull();
  expect(dialogTitle()).toMatch(/^"inbox\/\d\.txt" already exists$/);
  const applyToAll = dialog()!.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  expect(applyToAll.labels?.[0]?.textContent).toBe('Apply to all remaining conflicts');
  const actions = dialog()!.querySelector('[data-fs-part=dialog-actions]')!;
  expect(
    applyToAll.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
    'the checkbox comes before the buttons',
  ).toBeTruthy();
  await userEvent.click(applyToAll);
  await answer('Replace');
  await expect
    .poll(() => document.querySelector('[data-fs-part=upload-summary]')?.textContent)
    .toBe('Uploaded 3 files to "inbox".');
  expect(dialog()).toBeNull();
  for (const name of names) expect(await adapter.read(`inbox/${name}`, 'text'), name).toBe('new');
  expect(await listing(adapter, 'inbox')).toEqual(names);
});

test('an upload conflict answered with Skip or Escape skips that file only', async () => {
  const { adapter } = await mount({ 'inbox/1.txt': 'old', 'inbox/2.txt': 'old' });
  dropOsFiles(rowNamed('inbox'), [new File(['new'], '1.txt'), new File(['new'], '2.txt')]);
  await expect.poll(() => dialog()?.querySelector('input[type=checkbox]')).toBeTruthy();
  await userEvent.click(buttonIn(dialog()!, 'Skip'));
  await expect
    .poll(() => dialog() && !dialog()!.querySelector('input[type=checkbox]'), {
      message: 'the second and last conflict asks without Apply to all',
    })
    .toBe(true);
  await userEvent.keyboard('{Escape}');
  await expect.poll(dialog).toBeNull();
  await expect
    .poll(() => document.querySelector('[data-fs-part=upload-summary]')?.textContent)
    .toBe('Uploaded 0 files to "inbox".');
  expect(await adapter.read('inbox/1.txt', 'text')).toBe('old');
  expect(await adapter.read('inbox/2.txt', 'text')).toBe('old');
});

test('concurrent conflicts are queued, one dialog at a time', async () => {
  const { resolve } = await mount({ 'a.txt': '', 'b.txt': '' });
  const first = resolve('copy', 'a.txt');
  const second = resolve('move', 'b.txt');
  await expect.poll(dialogTitle).toBe('"a.txt" already exists');
  expect(dialogs()).toHaveLength(1);
  await userEvent.click(buttonIn(dialog()!, 'Keep both'));
  expect(await first).toEqual({ choice: 'keepBoth', applyToAll: false });
  await expect.poll(dialogTitle).toBe('"b.txt" already exists');
  expect(dialogs()).toHaveLength(1);
  await userEvent.keyboard('{Escape}');
  expect(await second).toBeNull();
  expect(dialog()).toBeNull();
});

test('default focus is Keep both', async () => {
  const { resolve } = await mount({ 'a.txt': '' });
  const answered = resolve('upload', 'a.txt', { remaining: 2 });
  await expect.poll(dialog).not.toBeNull();
  await expect.poll(() => document.activeElement?.textContent).toBe('Keep both');
  await userEvent.keyboard('{Enter}');
  expect(await answered).toEqual({ choice: 'keepBoth', applyToAll: false });
});

test('unmounting the tree settles a pending conflict with null', async () => {
  const { resolve, showTree } = await mount({ 'a.txt': '' });
  const answered = resolve('move', 'a.txt');
  await expect.poll(dialog).not.toBeNull();
  showTree(false);
  expect(await answered).toBeNull();
  expect(dialog()).toBeNull();
});

test('without a mounted tree, an upload conflict keeps both', async () => {
  const { fs, resolve, adapter } = await mount({ 'a.txt': 'old' }, { trees: 0 });
  expect(await resolve('copy', 'a.txt'), 'nothing can ask, so the question is cancelled').toBeNull();
  await internalsOf(fs).uploads.upload([{ file: new File(['new'], 'a.txt'), relativePath: 'a.txt' }], '');
  expect(await listing(adapter)).toEqual(['a copy.txt', 'a.txt']);
  expect(await adapter.read('a.txt', 'text')).toBe('old');
});

test('an onUploadConflict choice overrides the dialog', async () => {
  const { fs, adapter } = await mount({ 'a.txt': 'old' }, { onUploadConflict: 'replace' });
  const result = await internalsOf(fs).uploads.upload(
    [{ file: new File(['new'], 'a.txt'), relativePath: 'a.txt' }],
    '',
  );
  expect(result.uploaded.map((entry) => entry.path)).toEqual(['a.txt']);
  expect(dialog(), 'no question was asked').toBeNull();
  expect(await adapter.read('a.txt', 'text')).toBe('new');
});

test('Replace onto a folder warns that it deletes the folder and its contents, and deletes only once confirmed', async () => {
  const { fs, adapter } = await mount({ 'src/new.txt': 'n', 'dir/src/sub/old.txt': 'o' });
  await expandAll(fs, ['dir', 'dir/src', 'dir/src/sub']);
  fs.clipboard.set({ op: 'cut', path: 'src' });
  await choose('dir', 'Paste');
  await expect.poll(dialogTitle).toBe('"dir/src" already exists');
  expect(description()).toContain('Replace deletes the existing folder "src" and everything in it.');
  expect(buttonIn(dialog()!, 'Replace').getAttribute('data-fs-part')).toBe('dialog-button-danger');
  await interactionSettled();
  expect(await listing(adapter, 'dir/src'), 'nothing is deleted before the answer').toEqual(['sub']);

  await answer('Replace');
  await expect.poll(() => listing(adapter)).toEqual(['dir']);
  expect(await listing(adapter, 'dir/src')).toEqual(['new.txt']);
  expect(fs.expanded.get().has('dir/src/sub'), "the replaced folder's expanded children are forgotten").toBe(
    false,
  );
});

test('a file onto a folder, or an upload onto a folder, offers no Replace', async () => {
  const { fs } = await mount({ a: 'file', 'dir/a/x.txt': '' });
  await expandAll(fs, ['dir']);
  fs.clipboard.set({ op: 'copy', path: 'a' });
  await choose('dir', 'Paste');
  await expect.poll(dialogTitle).toBe('"dir/a" already exists');
  expect(buttonLabels()).toEqual(['Keep both', 'Cancel']);
  await answer('Cancel');

  dropOsFiles(rowNamed('dir'), [new File(['f'], 'a')]);
  await expect.poll(dialogTitle).toBe('"dir/a" already exists');
  expect(buttonLabels()).toEqual(['Keep both', 'Skip']);
  await answer('Skip');
});

test('Replace is not offered onto a folder that contains the source', async () => {
  const { fs } = await mount({ 'a/a/x.txt': '', 'z.txt': '' });
  await expandAll(fs, ['a']);
  fs.clipboard.set({ op: 'cut', path: 'a/a' });
  await choose('z.txt', 'Paste');
  await expect.poll(dialogTitle).toBe('"a" already exists');
  expect(buttonLabels()).toEqual(['Keep both', 'Cancel']);
  await answer('Cancel');
});

test('a failed Replace move leaves the expanded state of both folders where it was', async () => {
  const { fs, notices } = await mount(
    { 'src/new.txt': '', 'dir/src/old.txt': '' },
    {
      adapt: (memory) => ({
        ...memory,
        move: () => Promise.reject(new FsError('forbidden', 'the server refused')),
      }),
    },
  );
  await expandAll(fs, ['src', 'dir', 'dir/src']);
  fs.clipboard.set({ op: 'cut', path: 'src' });
  await choose('dir', 'Paste');
  await expect.poll(dialog).not.toBeNull();
  await answer('Replace');
  await expect.poll(() => notices.at(-1)?.kind).toBe('error');
  expect(new Set(fs.expanded.get())).toEqual(new Set(['src', 'dir', 'dir/src']));
});

test('a case-only conflict names the real entry and Replace leaves exactly one', async () => {
  const { adapter } = await mount({ 'Readme.md': 'new', 'dir/README.md': 'old' });
  await choose('Readme.md', 'Cut');
  await choose('dir', 'Paste');
  await expect.poll(dialogTitle).toBe('"dir/README.md" already exists');
  await answer('Replace');
  await expect.poll(() => listing(adapter)).toEqual(['dir']);
  expect(await listing(adapter, 'dir')).toEqual(['README.md']);
  expect(await adapter.read('dir/README.md', 'text')).toBe('new');
});

test('Replace overwrites nothing when the entry changed while the dialog was open', async () => {
  const { adapter, notices } = await mount({ 'a.txt': 'mine', 'dir/a.txt': 'old' });
  await choose('a.txt', 'Copy');
  await choose('dir', 'Paste');
  await expect.poll(dialog).not.toBeNull();
  await adapter.write!('dir/a.txt', 'changed elsewhere');
  await answer('Replace');
  await expect.poll(() => notices.at(-1)?.message).toMatch(/changed while the dialog was open/);
  expect(await adapter.read('dir/a.txt', 'text')).toBe('changed elsewhere');
  expect(await listing(adapter, 'dir')).toEqual(['a.txt']);
});

test('after a refused Replace, trying again without a watch succeeds against the refreshed entry', async () => {
  const { adapter, notices } = await mount(
    { 'a.txt': 'mine', 'dir/a.txt': 'old' },
    { adapt: (memory) => ({ ...memory, watch: undefined }) },
  );
  await choose('a.txt', 'Copy');
  await choose('dir', 'Paste');
  await expect.poll(dialog).not.toBeNull();
  await adapter.write!('dir/a.txt', 'changed elsewhere');
  await answer('Replace');
  await expect.poll(() => notices.at(-1)?.message).toMatch(/changed while the dialog was open/);
  await choose('a.txt', 'Copy');
  await choose('dir', 'Paste');
  await expect.poll(dialog).not.toBeNull();
  await answer('Replace');
  await expect.poll(() => adapter.read('dir/a.txt', 'text')).toBe('mine');
});

test('an upload Replace skips the file when it changed while the dialog was open', async () => {
  const { adapter, notices } = await mount({ 'inbox/a.txt': 'old' });
  dropOsFiles(rowNamed('inbox'), [new File(['mine'], 'a.txt')]);
  await expect.poll(dialog).not.toBeNull();
  await adapter.write!('inbox/a.txt', 'changed elsewhere');
  await answer('Replace');
  await expect.poll(() => notices.at(-1)?.message).toMatch(/^Uploaded 0 files/);
  expect(notices.some((notice) => /changed while the dialog was open/.test(notice.message))).toBe(true);
  expect(await adapter.read('inbox/a.txt', 'text')).toBe('changed elsewhere');
});

const withoutSizeOrModificationTime = (memory: MemoryAdapter): FileSystemAdapter => {
  const unverifiable = (entry: Entry): Entry => ({ path: entry.path, name: entry.name, kind: entry.kind });
  return {
    ...memory,
    list: async (path, opts) => (await memory.list(path, opts)).map(unverifiable),
    stat: async (path, opts) => {
      const entry = await memory.stat!(path, opts);
      return entry && unverifiable(entry);
    },
  };
};

test('Replace overwrites nothing when the change check cannot read the entry from the server', async () => {
  let readsFail = false;
  const offline = (): Promise<never> => Promise.reject(new FsError('network', 'offline'));
  const { adapter, notices } = await mount(
    { 'a.txt': 'mine', 'dir/a.txt': 'old' },
    {
      adapt: (memory) => ({
        ...memory,
        list: (path, opts) => (readsFail && path === 'dir' ? offline() : memory.list(path, opts)),
        stat: (path, opts) => (readsFail ? offline() : memory.stat!(path, opts)),
      }),
    },
  );
  await choose('a.txt', 'Copy');
  await choose('dir', 'Paste');
  await expect.poll(dialog).not.toBeNull();
  readsFail = true;
  await answer('Replace');
  await expect.poll(() => notices.at(-1)?.message).toMatch(/changed while the dialog was open/);
  expect(await adapter.read('dir/a.txt', 'text')).toBe('old');
});

test('Replace overwrites nothing while the listings of its folder are still in flight with the old entry', async () => {
  const held: Array<() => void> = [];
  let holdingDir = false;
  const { fs, adapter, notices } = await mount(
    { 'a.txt': 'mine', 'dir/a.txt': 'old', 'dir/b.txt': '' },
    {
      adapt: (memory) => ({
        ...memory,
        list: (path, opts) => {
          const answer = memory.list(path, opts);
          if (!holdingDir || path !== 'dir') return answer;
          return new Promise<Entry[]>((resolve) => held.push(() => void answer.then(resolve)));
        },
      }),
    },
  );
  await choose('a.txt', 'Copy');
  await choose('dir', 'Paste');
  await expect.poll(dialog).not.toBeNull();
  holdingDir = true;
  fs.store.applyChanges([{ type: 'updated', path: 'dir/b.txt', actor: 'agent' }]);
  expect(held.length, 'the change reloads the folder').toBe(1);
  await adapter.write!('dir/a.txt', 'changed elsewhere');
  fs.store.applyChanges([{ type: 'updated', path: 'dir/a.txt', actor: 'agent' }]);
  await answer('Replace');
  await expect.poll(() => notices.at(-1)?.message).toMatch(/changed while the dialog was open/);
  holdingDir = false;
  for (const release of held.splice(0)) release();
  await interactionSettled();
  expect(await adapter.read('dir/a.txt', 'text')).toBe('changed elsewhere');
});

test('Replace overwrites nothing when a stale ancestor listing lands right after the folder reload', async () => {
  const held: Array<{ path: string; release: () => void }> = [];
  let holding = false;
  const { fs, adapter, notices } = await mount(
    { 'a.txt': 'mine', 'dir/a.txt': 'old' },
    {
      adapt: (memory) => ({
        ...memory,
        watch: undefined,
        list: (path, opts) => {
          const answer = memory.list(path, opts);
          if (!holding) return answer;
          return new Promise<Entry[]>((resolve) =>
            held.push({ path, release: () => void answer.then(resolve) }),
          );
        },
      }),
    },
  );
  await choose('a.txt', 'Copy');
  await choose('dir', 'Paste');
  await expect.poll(dialog).not.toBeNull();
  holding = true;
  void fs.store.loadFolder('', { force: true });
  await adapter.write!('dir/a.txt', 'changed elsewhere');
  await answer('Replace');
  await interactionSettled();
  const dirFirstThenTheStaleRoot = [...held].sort((first) => (first.path === 'dir' ? -1 : 1));
  for (const request of dirFirstThenTheStaleRoot) request.release();
  holding = false;
  await expect.poll(() => notices.at(-1)?.message).toMatch(/changed while the dialog was open/);
  await interactionSettled();
  expect(await adapter.read('dir/a.txt', 'text')).toBe('changed elsewhere');
});

test.each([0, 2, 4, 6, 8, 12])(
  'Replace overwrites nothing when the reloads of its folder land %i microtasks after the answer',
  async (microtasks) => {
    const held: Array<() => void> = [];
    let dirListings: 'pass' | 'hold' | 'delayed' = 'pass';
    const { fs, adapter, notices } = await mount(
      { 'a.txt': 'mine', 'dir/a.txt': 'old', 'dir/b.txt': '' },
      {
        adapt: (memory) => ({
          ...memory,
          list: (path, opts) => {
            const answer = memory.list(path, opts);
            if (path !== 'dir' || dirListings === 'pass') return answer;
            if (dirListings === 'delayed') {
              return (async () => {
                const entries = await answer;
                for (let step = 0; step < microtasks; step += 1) await null;
                return entries;
              })();
            }
            return new Promise<Entry[]>((resolve) => held.push(() => void answer.then(resolve)));
          },
        }),
      },
    );
    await choose('a.txt', 'Copy');
    await choose('dir', 'Paste');
    await expect.poll(dialog).not.toBeNull();
    dirListings = 'hold';
    fs.store.applyChanges([{ type: 'updated', path: 'dir/b.txt', actor: 'agent' }]);
    await adapter.write!('dir/a.txt', 'changed elsewhere');
    fs.store.applyChanges([{ type: 'updated', path: 'dir/a.txt', actor: 'agent' }]);
    dirListings = 'delayed';
    const answered = answer('Replace');
    for (const release of held.splice(0)) release();
    await answered;
    await expect.poll(() => notices.at(-1)?.message).toMatch(/changed while the dialog was open/);
    await interactionSettled();
    expect(await adapter.read('dir/a.txt', 'text')).toBe('changed elsewhere');
  },
);

test('Replace is refused when the entry has neither size nor modification time', async () => {
  const { adapter, notices } = await mount(
    { 'a.txt': 'mine', 'dir/a.txt': 'old' },
    { adapt: withoutSizeOrModificationTime },
  );
  await choose('a.txt', 'Copy');
  await choose('dir', 'Paste');
  await expect.poll(dialog).not.toBeNull();
  await answer('Replace');
  await expect
    .poll(() => notices.at(-1)?.message)
    .toMatch(/Can't confirm "dir\/a.txt" hasn't changed.*Keep both/);
  expect(await adapter.read('dir/a.txt', 'text')).toBe('old');
});

test('an upload Replace skips the file when the change check cannot reach the server', async () => {
  let statFails = false;
  const { adapter, notices } = await mount(
    { 'inbox/a.txt': 'old' },
    {
      adapt: (memory) => ({
        ...memory,
        stat: (path, opts) =>
          statFails ? Promise.reject(new FsError('network', 'offline')) : memory.stat!(path, opts),
      }),
    },
  );
  dropOsFiles(rowNamed('inbox'), [new File(['mine'], 'a.txt')]);
  await expect.poll(dialog).not.toBeNull();
  statFails = true;
  await answer('Replace');
  await expect
    .poll(() => notices.some((notice) => /changed while the dialog was open/.test(notice.message)))
    .toBe(true);
  expect(await adapter.read('inbox/a.txt', 'text')).toBe('old');
});

test('an upload Replace is refused when the entry has neither size nor modification time', async () => {
  const { adapter, notices } = await mount(
    { 'inbox/a.txt': 'old' },
    { adapt: withoutSizeOrModificationTime },
  );
  dropOsFiles(rowNamed('inbox'), [new File(['mine'], 'a.txt')]);
  await expect.poll(dialog).not.toBeNull();
  await answer('Replace');
  await expect
    .poll(() =>
      notices.some((notice) => /Can't confirm "inbox\/a.txt" hasn't changed.*Keep both/.test(notice.message)),
    )
    .toBe(true);
  expect(await adapter.read('inbox/a.txt', 'text')).toBe('old');
});

test('an upload Replace whose existing entry could not be read offers Keep both', async () => {
  let lookups = 0;
  const { adapter, notices } = await mount(
    { 'inbox/a.txt': 'old' },
    {
      adapt: (memory) => ({
        ...memory,
        stat: async (path, opts) => (++lookups === 1 ? memory.stat!(path, opts) : null),
      }),
    },
  );
  dropOsFiles(rowNamed('inbox'), [new File(['mine'], 'a.txt')]);
  await expect.poll(dialog).not.toBeNull();
  await answer('Replace');
  await expect
    .poll(() => notices.find((notice) => notice.message.includes('inbox/a.txt'))?.message)
    .toMatch(/could not be read.*Choose Keep both instead\.$/);
  expect(await adapter.read('inbox/a.txt', 'text')).toBe('old');
});

test('Keep both on a move into a folder that is not loaded yet uses a free name', async () => {
  const { fs, adapter } = await mount({ 'a.txt': 'A', 'x/y/a.txt': 'Y' });
  expect(statusOf(fs.store.getSnapshot().tree, 'x/y')).not.toBe('loaded');
  const moved = transferInto(fs, { op: 'move', path: 'a.txt', folder: 'x/y', verb: 'move' });
  await expect.poll(dialogTitle).toBe('"x/y/a.txt" already exists');
  await answer('Keep both');
  expect(await moved).toBe('done');
  expect(await listing(adapter, 'x/y')).toEqual(['a copy.txt', 'a.txt']);
  expect(await adapter.read('x/y/a copy.txt', 'text')).toBe('A');
});

test('with two trees, no conflict dialog opens while either tree has a menu open', async () => {
  const { resolve } = await mount({ 'a.txt': '' }, { trees: 2 });
  const secondTreeRow = document
    .querySelectorAll<HTMLElement>('[data-fs-part=tree]')[1]!
    .querySelector('[role=treeitem]')!;
  await userEvent.click(secondTreeRow, { button: 'right' });
  await expect.poll(menu).not.toBeNull();
  const answered = resolve('copy', 'a.txt');
  await interactionSettled();
  expect(dialog(), 'the menu keeps the conflict waiting').toBeNull();
  await userEvent.keyboard('{Escape}');
  await expect.poll(menu).toBeNull();
  await expect.poll(dialogTitle).toBe('"a.txt" already exists');
  expect(dialogs()).toHaveLength(1);
  await userEvent.keyboard('{Escape}');
  expect(await answered).toBeNull();
});
