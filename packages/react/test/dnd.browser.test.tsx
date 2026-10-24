import { treeRowRenders } from './support/countComponentRenders';
import { interactionSettled } from './support/interactionSettled';
import { statusOf, type DropEntry, type FileSystemAdapter } from '@workspacekit/core';
import { createMemoryAdapter, type MemoryAdapter } from '@workspacekit/core/memory';
import { useEffect } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { useFileSystem, type FileSystemContext, type Notice } from '../src/provider/hooks';
import { FileTree } from '../src/tree/FileTree';
import { UploadStatus } from '../src/uploads/UploadStatus';

const ROW_HEIGHT = 24;

function CaptureContext({ onContext }: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => {
    onContext(fs);
  });
  return null;
}

let mountedContext: FileSystemContext | undefined;
const fs = (): FileSystemContext => mountedContext!;

interface Mounted {
  fs: FileSystemContext;
  adapter: MemoryAdapter;
  notices: Notice[];
}

const mount = async (
  files: Record<string, string>,
  options: { expanded?: string[]; adapt?: (memory: MemoryAdapter) => FileSystemAdapter } = {},
): Promise<Mounted> => {
  const adapter = createMemoryAdapter({ files });
  const notices: Notice[] = [];
  let captured: FileSystemContext | undefined;
  await render(
    <FileSystemProvider
      adapter={options.adapt?.(adapter) ?? adapter}
      onNotify={(notice) => notices.push(notice)}
    >
      <FileTree rowHeight={ROW_HEIGHT} style={{ height: 12 * ROW_HEIGHT }} />
      <UploadStatus />
      <CaptureContext onContext={(context) => (captured = mountedContext = context)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => captured && statusOf(captured.store.getSnapshot().tree, '')).toBe('loaded');
  for (const path of options.expanded ?? []) {
    captured!.expanded.set((previous) => new Set(previous).add(path));
    await expect.poll(() => captured && statusOf(captured.store.getSnapshot().tree, path)).toBe('loaded');
  }
  if (Object.keys(files).length > 0) await expect.poll(() => rows().length).toBeGreaterThan(0);
  return { fs: captured!, adapter, notices };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const PAST_THE_HOVER_EXPAND_DELAY_MS = 500;
const useFakeTimeouts = (): void => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role=treeitem]')];
const labelOf = (row: Element): string | null | undefined =>
  row.querySelector('[data-fs-part=tree-row-label]')?.textContent;
const rowNamed = (name: string): HTMLElement => rows().find((row) => labelOf(row) === name)!;
const dropTargets = (): Array<string | null | undefined> =>
  rows()
    .filter((row) => row.hasAttribute('data-drop-target'))
    .map(labelOf);
const placeholders = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-fs-part=tree-row-placeholder]'),
];
const exists = async (adapter: MemoryAdapter, path: string): Promise<boolean> =>
  (await adapter.stat!(path)) !== null;
const summary = (): string | null | undefined =>
  document.querySelector('[data-fs-part=upload-summary]')?.textContent;
const viewport = (): HTMLElement => document.querySelector<HTMLElement>('[data-fs-part=tree-viewport]')!;

const fire = (
  target: Element,
  type: 'dragstart' | 'dragenter' | 'dragover' | 'dragleave' | 'drop' | 'dragend',
  dataTransfer: DataTransfer,
  init: { altKey?: boolean; relatedTarget?: EventTarget | null } = {},
): DragEvent => {
  const event = new DragEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(event);
  return event;
};

const startDragging = (name: string): DataTransfer => {
  const dataTransfer = new DataTransfer();
  fire(rowNamed(name), 'dragstart', dataTransfer);
  return dataTransfer;
};

const dragOnto = (name: string, from: string, init: { altKey?: boolean } = {}): DragEvent => {
  const dataTransfer = startDragging(from);
  const target = rowNamed(name);
  fire(target, 'dragenter', dataTransfer, init);
  fire(target, 'dragover', dataTransfer, init);
  const drop = fire(target, 'drop', dataTransfer, init);
  fire(rowNamed(from) ?? viewport(), 'dragend', dataTransfer);
  return drop;
};

const filesTransfer = (files: File[]): DataTransfer => {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  return dataTransfer;
};

const dropOsFiles = (target: Element, dataTransfer: DataTransfer): DragEvent => {
  fire(target, 'dragenter', dataTransfer);
  fire(target, 'dragover', dataTransfer);
  return fire(target, 'drop', dataTransfer);
};

function heldUploads(): { adapt: (memory: MemoryAdapter) => FileSystemAdapter; release: () => void } {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    release,
    adapt: (memory) => ({
      ...memory,
      upload: {
        direct: async (path, file, options) => {
          await released;
          return memory.upload!.direct(path, file, options);
        },
      },
    }),
  };
}

const whenAborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

const withOnlyTheFirstUploadFinishing = (memory: MemoryAdapter): FileSystemAdapter => {
  let started = 0;
  return {
    ...memory,
    upload: {
      direct: async (path, file, options) => {
        if (started++ > 0) await whenAborted(options.signal);
        return memory.upload!.direct(path, file, options);
      },
    },
  };
};

const fileEntry = (fullPath: string): DropEntry => ({
  isFile: true,
  isDirectory: false,
  name: fullPath.split('/').at(-1)!,
  fullPath,
  file: (ok) => ok(new File([fullPath], fullPath.split('/').at(-1)!)),
});
const folderEntry = (fullPath: string, children: DropEntry[]): DropEntry => {
  let read = false;
  return {
    isFile: false,
    isDirectory: true,
    name: fullPath.split('/').at(-1)!,
    fullPath,
    createReader: () => ({
      readEntries: (ok) => {
        ok(read ? [] : children);
        read = true;
      },
    }),
  };
};
const entriesTransfer = (entries: DropEntry[]): DataTransfer =>
  ({
    types: ['Files'],
    dropEffect: 'none',
    items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null })),
    files: [],
  }) as unknown as DataTransfer;

test('dragging a file onto a folder moves it', async () => {
  const { adapter } = await mount({ 'a.txt': 'A', 'docs/readme.md': 'R' });
  const dataTransfer = startDragging('a.txt');
  const over = fire(rowNamed('docs'), 'dragover', dataTransfer);
  expect(over.defaultPrevented, 'the folder accepts the drop').toBe(true);
  await expect.poll(dropTargets).toEqual(['docs']);
  fire(rowNamed('docs'), 'drop', dataTransfer);
  await expect.poll(() => exists(adapter, 'docs/a.txt')).toBe(true);
  expect(await exists(adapter, 'a.txt')).toBe(false);
  expect(dropTargets()).toEqual([]);
});

test('Alt-drag copies', async () => {
  const { adapter } = await mount({ 'a.txt': 'A', 'docs/readme.md': 'R' });
  dragOnto('docs', 'a.txt', { altKey: true });
  await expect.poll(() => exists(adapter, 'docs/a.txt')).toBe(true);
  expect(await exists(adapter, 'a.txt')).toBe(true);
});

test('hovering a collapsed folder for 400 ms expands it', async () => {
  await mount({ 'a.txt': 'A', 'docs/readme.md': 'R', 'later/b.txt': 'B' });
  useFakeTimeouts();
  const dataTransfer = startDragging('a.txt');
  fire(rowNamed('docs'), 'dragover', dataTransfer);
  await vi.advanceTimersByTimeAsync(250);
  fire(rowNamed('docs'), 'dragover', dataTransfer);
  await vi.advanceTimersByTimeAsync(140);
  expect(rowNamed('docs').getAttribute('aria-expanded'), 'not yet').toBe('false');
  await vi.advanceTimersByTimeAsync(20);
  await expect.poll(() => rowNamed('docs').getAttribute('aria-expanded')).toBe('true');
  await expect.poll(dropTargets).toEqual(['docs', 'readme.md']);

  fire(rowNamed('later'), 'dragover', dataTransfer);
  fire(viewport(), 'dragleave', dataTransfer, { relatedTarget: document.body });
  await vi.advanceTimersByTimeAsync(PAST_THE_HOVER_EXPAND_DELAY_MS);
  await interactionSettled();
  expect(rowNamed('later').getAttribute('aria-expanded'), 'leaving the tree cancels the hover').toBe('false');
  expect(dropTargets()).toEqual([]);
});

test('a foreign drop carrying the path type moves nothing', async () => {
  const { adapter } = await mount(
    { 'a.txt': '', 'b.txt': '', 'docs/readme.md': '', 'src/c.txt': '' },
    { expanded: ['src'] },
  );
  const foreignDrop = (path: string): DragEvent => {
    const foreign = new DataTransfer();
    foreign.setData('application/x-fs-path', path);
    fire(rowNamed('docs'), 'dragover', foreign);
    return fire(rowNamed('docs'), 'drop', foreign);
  };

  startDragging('a.txt');
  expect(
    foreignDrop('b.txt').defaultPrevented,
    'another path than the one dragged: cancelled, so the browser opens nothing',
  ).toBe(true);

  const sourceRow = rowNamed('c.txt');
  const unmountedDrag = startDragging('c.txt');
  fs().expanded.set(new Set());
  await expect.poll(() => sourceRow.isConnected).toBe(false);
  fire(sourceRow, 'dragend', unmountedDrag);
  expect(foreignDrop('src/c.txt').defaultPrevented, 'the drag ended while its row was unmounted').toBe(false);

  startDragging('a.txt');
  fire(viewport(), 'dragenter', filesTransfer([new File(['x'], 'x.txt')]));
  expect(foreignDrop('a.txt').defaultPrevented, 'a drag without the type entered since').toBe(false);

  await interactionSettled();
  for (const path of ['a.txt', 'b.txt', 'src/c.txt']) expect(await exists(adapter, path), path).toBe(true);
  expect(await exists(adapter, 'docs/a.txt')).toBe(false);
});

test('a cancelled drag (Esc, or leaving the window) clears the target and the hover timer', async () => {
  await mount({ 'a.txt': '', 'docs/readme.md': '' });
  useFakeTimeouts();
  const dataTransfer = startDragging('a.txt');
  const docs = rowNamed('docs');
  const label = docs.querySelector('[data-fs-part=tree-row-label]')!;
  fire(docs, 'dragenter', dataTransfer);
  fire(docs, 'dragover', dataTransfer);
  await expect.poll(dropTargets).toEqual(['docs']);
  fire(label, 'dragenter', dataTransfer);
  fire(docs, 'dragleave', dataTransfer, { relatedTarget: null });
  await interactionSettled();
  expect(dropTargets(), 'moving onto a child keeps the target').toEqual(['docs']);

  const rect = label.getBoundingClientRect();
  const cancel = new DragEvent('dragleave', { bubbles: true, clientX: rect.left + 2, clientY: rect.top + 2 });
  Object.defineProperty(cancel, 'dataTransfer', { value: dataTransfer });
  label.dispatchEvent(cancel);
  await expect.poll(dropTargets).toEqual([]);
  await vi.advanceTimersByTimeAsync(PAST_THE_HOVER_EXPAND_DELAY_MS);
  await interactionSettled();
  expect(rowNamed('docs').getAttribute('aria-expanded'), 'the hover timer was cleared').toBe('false');
});

test('moving within one row keeps it the target; entering an outside element ends the drag', async () => {
  await mount({ 'a.txt': '', 'docs/readme.md': '' });
  useFakeTimeouts();
  const dataTransfer = startDragging('a.txt');
  const docs = rowNamed('docs');
  const label = docs.querySelector('[data-fs-part=tree-row-label]')!;
  const moveInto = (entered: Element, left: Element): void => {
    fire(entered, 'dragenter', dataTransfer);
    fire(left, 'dragleave', dataTransfer, { relatedTarget: null });
    fire(entered, 'dragover', dataTransfer);
  };
  fire(label, 'dragenter', dataTransfer);
  fire(label, 'dragover', dataTransfer);
  moveInto(docs, label);
  moveInto(label, docs);
  await vi.advanceTimersByTimeAsync(PAST_THE_HOVER_EXPAND_DELAY_MS);
  await interactionSettled();
  expect(rowNamed('docs').getAttribute('aria-expanded'), 'the hover timer kept running').toBe('true');
  await expect.poll(dropTargets).toEqual(['docs', 'readme.md']);

  const outside = document.querySelector('[data-fs-part=upload-status]')!;
  fire(outside, 'dragenter', dataTransfer);
  fire(rowNamed('docs').querySelector('[data-fs-part=tree-row-label]')!, 'dragleave', dataTransfer, {
    relatedTarget: null,
  });
  await expect.poll(dropTargets).toEqual([]);
});

test('a drag whose row unmounted still clears the target and the hover timer when it ends', async () => {
  await mount({ 'src/c.txt': '', 'docs/readme.md': '' }, { expanded: ['src'] });
  useFakeTimeouts();
  const sourceRow = rowNamed('c.txt');
  const dataTransfer = startDragging('c.txt');
  fire(rowNamed('docs'), 'dragover', dataTransfer);
  await expect.poll(dropTargets).toEqual(['docs']);
  fs().expanded.set(new Set());
  await expect.poll(() => sourceRow.isConnected).toBe(false);
  fire(sourceRow, 'dragend', dataTransfer);
  await expect.poll(dropTargets).toEqual([]);
  await vi.advanceTimersByTimeAsync(PAST_THE_HOVER_EXPAND_DELAY_MS);
  await interactionSettled();
  expect(rowNamed('docs').getAttribute('aria-expanded')).toBe('false');
});

test('dropping a folder into itself shows no target and does nothing', async () => {
  const { adapter, notices } = await mount(
    { 'src/a.ts': '', 'src/sub/b.ts': '', 'other.txt': '' },
    { expanded: ['src', 'src/sub'] },
  );
  const dataTransfer = startDragging('src');
  for (const name of ['src', 'sub', 'b.ts']) {
    const over = fire(rowNamed(name), 'dragover', dataTransfer);
    expect(over.defaultPrevented, `${name} refuses the drop`).toBe(false);
  }
  const drop = fire(rowNamed('sub'), 'drop', dataTransfer);
  expect(drop.defaultPrevented).toBe(false);

  const fileDrag = startDragging('a.ts');
  expect(fire(rowNamed('src'), 'dragover', fileDrag).defaultPrevented, 'its own folder is no target').toBe(
    false,
  );
  expect(fire(rowNamed('b.ts'), 'dragover', fileDrag).defaultPrevented, 'a file row targets its folder').toBe(
    true,
  );
  fire(viewport(), 'dragleave', fileDrag, { relatedTarget: document.body });

  await interactionSettled();
  expect(dropTargets()).toEqual([]);
  expect(await exists(adapter, 'src/sub/b.ts')).toBe(true);
  expect(await exists(adapter, 'src/a.ts')).toBe(true);
  expect(notices).toEqual([]);
});

test('hovering a folder during a drag re-renders only the rows whose data-drop-target changes', async () => {
  await mount({ 'a/1.txt': '', 'a/2.txt': '', 'b/1.txt': '', 'c.txt': '' }, { expanded: ['a', 'b'] });
  const dataTransfer = startDragging('c.txt');
  const measure = async (action: () => void): Promise<number> => {
    await interactionSettled();
    treeRowRenders.updates = 0;
    treeRowRenders.mounts = 0;
    action();
    await interactionSettled();
    expect(treeRowRenders.mounts).toBe(0);
    return treeRowRenders.updates;
  };
  expect(await measure(() => fire(rowNamed('a'), 'dragover', dataTransfer)), 'a and its two rows').toBe(3);
  expect(await measure(() => fire(rowNamed('2.txt'), 'dragover', dataTransfer)), 'same target').toBe(0);
  expect(await measure(() => fire(rowNamed('b'), 'dragover', dataTransfer)), 'a group off, b group on').toBe(
    5,
  );
});

test('OS folder drop uploads into the target folder', async () => {
  const { adapter } = await mount({ 'target/keep.txt': '' });
  const dataTransfer = entriesTransfer([
    folderEntry('/photos', [
      fileEntry('/photos/cat.png'),
      folderEntry('/photos/nested', [fileEntry('/photos/nested/dog.png')]),
      folderEntry('/photos/node_modules', [fileEntry('/photos/node_modules/x.js')]),
    ]),
  ]);
  const drop = dropOsFiles(rowNamed('target'), dataTransfer);
  expect(drop.defaultPrevented).toBe(true);
  await expect.poll(() => exists(adapter, 'target/photos/nested/dog.png')).toBe(true);
  expect(await exists(adapter, 'target/photos/cat.png')).toBe(true);
  expect(await exists(adapter, 'target/photos/node_modules')).toBe(false);
  await expect.poll(summary).toBe('Uploaded 2 files to "target".');
  await expect.poll(() => rowNamed('photos')).toBeDefined();
});

test('upload placeholders show progress and disappear when done', async () => {
  const uploads = heldUploads();
  const { adapter } = await mount(
    { 'docs/readme.md': '', 'zed.txt': '' },
    { expanded: ['docs'], adapt: uploads.adapt },
  );
  const dropped = filesTransfer([new File(['one'], 'one.txt'), new File(['two'], 'two.txt')]);
  dropOsFiles(rowNamed('readme.md'), dropped);

  await expect.poll(() => placeholders().length).toBe(2);
  expect(placeholders().every((placeholder) => placeholder.hasAttribute('data-pending'))).toBe(true);
  expect(placeholders().map((placeholder) => placeholder.getAttribute('aria-hidden'))).toEqual([
    'true',
    'true',
  ]);
  expect(placeholders().map((placeholder) => placeholder.textContent)).toEqual(
    expect.arrayContaining([expect.stringMatching(/one\.txt.*%/), expect.stringMatching(/two\.txt.*%/)]),
  );
  const docsTop = rowNamed('docs').getBoundingClientRect().top;
  const placeholderTops = placeholders()
    .map((placeholder) => placeholder.getBoundingClientRect().top - docsTop)
    .sort((a, b) => a - b);
  expect(placeholderTops, 'right under the target folder').toEqual([ROW_HEIGHT, 2 * ROW_HEIGHT]);
  expect(rowNamed('readme.md').getBoundingClientRect().top - docsTop).toBe(3 * ROW_HEIGHT);
  await expect.poll(summary).toBe('Uploading 2 files to "docs".');

  expect(rows().map(labelOf), 'placeholders are not tree items').toEqual(['docs', 'readme.md', 'zed.txt']);
  expect(
    placeholders().some(
      (placeholder) => placeholder.hasAttribute('tabindex') || placeholder.hasAttribute('role'),
    ),
  ).toBe(false);
  expect(rowNamed('readme.md').getAttribute('aria-posinset')).toBe('1');

  const osDrag = filesTransfer([new File(['x'], 'x.txt')]);
  expect(fire(placeholders()[0]!, 'dragover', osDrag).defaultPrevented).toBe(true);
  await expect
    .poll(dropTargets, { message: "a placeholder targets its folder's group" })
    .toEqual(['docs', 'readme.md']);
  expect(viewport().hasAttribute('data-drop-target'), 'not the root').toBe(false);
  fire(viewport(), 'dragleave', osDrag);

  uploads.release();
  await expect.poll(() => placeholders().length).toBe(0);
  await expect.poll(summary).toBe('Uploaded 2 files to "docs".');
  expect(await exists(adapter, 'docs/one.txt')).toBe(true);
  await expect.poll(() => rowNamed('one.txt')).toBeDefined();
  expect(
    document.querySelector('[data-fs-part=upload-run] progress'),
    'no progress bar once done',
  ).toBeNull();
});

test('arrow keys skip the placeholders and scroll to the first real child', async () => {
  const uploads = heldUploads();
  await mount({ 'docs/readme.md': '' }, { expanded: ['docs'], adapt: uploads.adapt });
  const files = Array.from({ length: 15 }, (_, at) => new File(['x'], `p${at}.txt`));
  dropOsFiles(rowNamed('docs'), filesTransfer(files));
  await expect.poll(() => placeholders().length).toBe(15);
  rowNamed('docs').focus();
  await userEvent.keyboard('{ArrowDown}');
  await expect.poll(() => document.activeElement && labelOf(document.activeElement)).toBe('readme.md');
  const row = rowNamed('readme.md').getBoundingClientRect();
  const view = viewport().getBoundingClientRect();
  expect(row.top >= view.top && row.bottom <= view.bottom, 'scrolled into view').toBe(true);
  expect(placeholders().length, 'still uploading').toBeGreaterThan(0);
  uploads.release();
});

test('an upload into an empty root shows its placeholders, then focus moves to the new rows', async () => {
  const uploads = heldUploads();
  await mount({}, { adapt: uploads.adapt });
  const emptyState = document.querySelector<HTMLElement>('[data-fs-part=tree-empty]')!;
  emptyState.focus();
  dropOsFiles(viewport(), filesTransfer([new File(['1'], 'one.txt'), new File(['2'], 'two.txt')]));
  await expect.poll(() => placeholders().length).toBe(2);
  expect(document.querySelector('[data-fs-part=tree-empty]')).toBeNull();
  uploads.release();
  await expect.poll(() => rows().map(labelOf)).toEqual(['one.txt', 'two.txt']);
  await expect.poll(() => document.activeElement?.getAttribute('role')).toBe('treeitem');
});

test('an upload progress tick re-renders no tree rows', async () => {
  let reportProgress: (loaded: number) => void = () => undefined;
  let finishUpload: () => void = () => undefined;
  await mount(
    { 'docs/readme.md': '', 'other.txt': '' },
    {
      expanded: ['docs'],
      adapt: (memory) => ({
        ...memory,
        upload: {
          direct: (path, file, options) =>
            new Promise((resolve, reject) => {
              reportProgress = (loaded) => options.onProgress?.(loaded);
              finishUpload = () => void memory.upload!.direct(path, file, options).then(resolve, reject);
            }),
        },
      }),
    },
  );
  dropOsFiles(rowNamed('docs'), filesTransfer([new File(['0123456789'], 'ten.txt')]));
  await expect.poll(() => placeholders().length).toBe(1);
  await interactionSettled();
  treeRowRenders.updates = 0;
  treeRowRenders.mounts = 0;
  reportProgress(5);
  await expect.poll(() => placeholders()[0]?.textContent).toMatch(/50%/);
  await interactionSettled();
  expect({ ...treeRowRenders }).toEqual({ updates: 0, mounts: 0 });
  finishUpload();
  await expect.poll(() => placeholders().length).toBe(0);
});

test('placeholders stay until the reloaded folder shows the uploaded entries', async () => {
  let holdListings = false;
  let releaseListings = (): void => undefined;
  const listingsReleased = new Promise<void>((resolve) => (releaseListings = resolve));
  const { adapter } = await mount(
    { 'docs/readme.md': '' },
    {
      expanded: ['docs'],
      adapt: (memory) => ({
        ...memory,
        watch: undefined,
        list: async (path, options) => {
          if (holdListings) await listingsReleased;
          return memory.list(path, options);
        },
      }),
    },
  );
  holdListings = true;
  dropOsFiles(rowNamed('docs'), filesTransfer([new File(['1'], 'one.txt')]));
  await expect.poll(() => placeholders().length).toBe(1);
  await expect.poll(() => exists(adapter, 'docs/one.txt')).toBe(true);
  await interactionSettled();
  expect(placeholders(), 'the upload landed but the folder has not reloaded yet').toHaveLength(1);
  releaseListings();
  const firstFrameWithoutPlaceholders = async (): Promise<string> => {
    for (;;) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (placeholders().length === 0) return rowNamed('one.txt') ? 'entry shown' : 'gap';
    }
  };
  expect(await firstFrameWithoutPlaceholders()).toBe('entry shown');
});

test('cancel stops the run and leaves pre-existing files', async () => {
  const { adapter } = await mount({ 'inbox/keep.txt': 'keep' }, { adapt: withOnlyTheFirstUploadFinishing });
  const files = Array.from({ length: 9 }, (_, at) => new File([String(at)], `new${at}.txt`));
  dropOsFiles(rowNamed('inbox'), filesTransfer(files));
  await expect.poll(() => exists(adapter, 'inbox/new0.txt'), { timeout: 5000 }).toBe(true);
  await userEvent.click(page.getByRole('button', { name: 'Cancel upload to inbox' }));
  await expect.poll(summary).toBe('Upload to "inbox" cancelled.');
  await expect.element(page.getByRole('button', { name: 'Dismiss upload to inbox' })).toBeInTheDocument();
  for (const file of files) expect(await exists(adapter, `inbox/${file.name}`), file.name).toBe(false);
  expect(await adapter.read('inbox/keep.txt', 'text')).toBe('keep');
  expect(placeholders()).toEqual([]);
});

test('over-limit drop shows a notice and uploads nothing', async () => {
  const { adapter, notices } = await mount({ 'a.txt': '' });
  const files = Array.from({ length: 501 }, (_, at) => new File(['x'], `f${at}.txt`));
  dropOsFiles(viewport(), filesTransfer(files));
  await expect.poll(() => notices.at(-1)?.message).toMatch(/more than 500 files/);
  await interactionSettled();
  expect(await exists(adapter, 'f0.txt')).toBe(false);
  expect(document.querySelectorAll('[data-fs-part=upload-run]')).toHaveLength(0);
});

test('upload actions open file pickers and upload the selection', async () => {
  const { adapter } = await mount({ 'docs/readme.md': '' });
  const opened: HTMLInputElement[] = [];
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    opened.push(this);
  });
  const openMenuItem = async (label: string): Promise<void> => {
    rowNamed('docs').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    await expect.poll(() => document.querySelector('[role=menu]')).not.toBeNull();
    const item = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((candidate) =>
      candidate.textContent?.includes(label),
    );
    await userEvent.click(item!);
  };

  await openMenuItem('Upload files');
  await expect.poll(() => opened.length).toBe(1);
  const [filesInput] = opened;
  expect(filesInput!.type).toBe('file');
  expect(filesInput!.multiple).toBe(true);
  expect(filesInput!.hasAttribute('webkitdirectory')).toBe(false);
  filesInput!.files = filesTransfer([new File(['p'], 'picked.txt')]).files;
  filesInput!.dispatchEvent(new Event('change', { bubbles: true }));
  await expect.poll(() => exists(adapter, 'docs/picked.txt')).toBe(true);

  await openMenuItem('Upload folder');
  await expect.poll(() => opened.length).toBe(2);
  expect(opened[1]!.hasAttribute('webkitdirectory')).toBe(true);
  expect(document.querySelectorAll('input[type=file]'), 'one pair of inputs for the whole tree').toHaveLength(
    2,
  );
});

test('without adapter.upload, the upload actions are hidden and OS drops are ignored', async () => {
  const { adapter, notices } = await mount(
    { 'docs/readme.md': '' },
    { adapt: (memory) => ({ ...memory, upload: undefined }) },
  );
  rowNamed('docs').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
  await expect.poll(() => document.querySelector('[role=menu]')).not.toBeNull();
  expect(document.querySelector('[role=menu]')!.textContent).not.toMatch(/Upload/);
  await userEvent.keyboard('{Escape}');
  await expect.poll(() => document.querySelector('[role=menu]')).toBeNull();
  const drop = dropOsFiles(rowNamed('docs'), filesTransfer([new File(['x'], 'x.txt')]));
  expect(drop.defaultPrevented).toBe(false);
  await interactionSettled();
  expect(await exists(adapter, 'docs/x.txt')).toBe(false);
  expect(document.querySelectorAll('input[type=file]')).toHaveLength(0);
  expect(notices).toEqual([]);
});
