import { FsError, type DropEntry, type FileSystemAdapter } from '@workspacekit/core';
import { createMemoryAdapter, type MemoryAdapter } from '@workspacekit/core/memory';
import { afterEach, expect, test, vi } from 'vitest';
import { commands } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { useTabs } from '../src/tabs/useTabs';
import { isMac } from '../src/tree/keyboard';
import { Workspace } from '../src/workspace/Workspace';
import { tiffBytes } from './fixtures/tiff';
import {
  activeTab,
  activeTabName,
  expandFocusedRow,
  expectNoAxeViolations,
  expectNoAxeViolationsInEitherColorScheme,
  focusedRowName,
  goToRow,
  isTreeRow,
  press,
  rowNamed,
  rowNames,
  tabUntil,
  THEMES,
  TO_THE_END_OF_THE_TEXT,
} from './support/keyboardOnly';

const FILES = {
  'README.md': '# Workspace',
  'docs/api.md': 'api',
  'docs/guide.md': 'guide',
  'src/index.ts': 'index',
  'src/util.ts': 'util',
  'flaky/deeper/inside.txt': 'inside',
  'assets/logo.svg': '<svg/>',
};
const LATENCY_MS = 30;
const FAILING_LIST = 'flaky/deeper';
const FAILING_MOVE = 'README.md';
const MOD = isMac() ? 'Meta' : 'Control';
const withMod = (key: string): string => `{${MOD}>}${key}{/${MOD}}`;

interface Session {
  adapter: MemoryAdapter;
  failures: string[];
}

function withOneFailingListAndOneFailingWrite(
  memory: MemoryAdapter,
  failures: string[],
  uploadsWaitFor: Promise<void>,
): MemoryAdapter {
  let listHasFailed = false;
  let writeHasFailed = false;
  return {
    ...memory,
    list: (path, options) => {
      if (path !== FAILING_LIST || listHasFailed) return memory.list(path, options);
      listHasFailed = true;
      failures.push(`list ${path}`);
      return Promise.reject(new FsError('network', 'The server did not answer.', { path }));
    },
    move: (from, to, options) => {
      if (from !== FAILING_MOVE || writeHasFailed) return memory.move!(from, to, options);
      writeHasFailed = true;
      failures.push(`move ${from}`);
      return Promise.reject(new FsError('network', 'The server did not answer.', { path: from }));
    },
    upload: {
      ...memory.upload!,
      direct: async (path, file, options) => {
        await uploadsWaitFor;
        return memory.upload!.direct(path, file, options);
      },
    },
  };
}

function Editor({ path }: { path: string }): React.JSX.Element {
  const tabs = useTabs();
  return (
    <textarea aria-label={`Contents of ${path}`} defaultValue="" onChange={() => tabs.setDirty(path, true)} />
  );
}

interface MountOptions {
  theme?: 'light' | 'dark';
  defaultFollow?: boolean;
  uploadsWaitFor?: Promise<void>;
}

async function mount(options: MountOptions = {}): Promise<Session> {
  const memory = createMemoryAdapter({ files: FILES, latencyMs: LATENCY_MS });
  const failures: string[] = [];
  const adapter = withOneFailingListAndOneFailingWrite(
    memory,
    failures,
    options.uploadsWaitFor ?? Promise.resolve(),
  );
  await render(
    <Workspace
      adapter={adapter}
      theme={options.theme}
      defaultFollow={options.defaultFollow}
      renderViewer={(path) => <Editor path={path} />}
      style={{ width: 960, height: 560 }}
    />,
  );
  await expect.poll(rowNames).toEqual(['assets', 'docs', 'flaky', 'src', 'README.md']);
  return { adapter: memory, failures };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await commands.emulateMedia({ colorScheme: null });
});

const workspace = (): HTMLElement => document.querySelector<HTMLElement>('[data-fs-part=workspace]')!;
const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role=dialog], [role=alertdialog]');
const dialogTitle = (): string | null | undefined =>
  dialog()?.querySelector('[data-fs-part=dialog-title]')?.textContent;
const menu = (): HTMLElement | null => document.querySelector<HTMLElement>('[role=menu]');
const tabNames = (): Array<string | null | undefined> =>
  [...document.querySelectorAll('[role=tab]')].map(
    (tab) => tab.querySelector('[data-fs-part=tab-label]')?.textContent,
  );
const exists = async (adapter: MemoryAdapter, path: string): Promise<boolean> =>
  (await adapter.stat!(path)) !== null;
async function openMenuAndPick(label: string, beforePicking?: () => Promise<void>): Promise<void> {
  await press('{Shift>}{F10}{/Shift}');
  await expect.poll(menu).not.toBeNull();
  await beforePicking?.();
  for (let presses = 0; presses < 20; presses++) {
    if (document.activeElement?.textContent?.startsWith(label)) break;
    await press('{ArrowDown}');
  }
  expect(document.activeElement?.textContent).toMatch(new RegExp(`^${label}`));
  await press('{Enter}');
  await expect.poll(menu).toBeNull();
}

async function focusDialogButton(text: string): Promise<void> {
  await tabUntil((element) => element.tagName === 'BUTTON' && element.textContent === text, `"${text}"`);
}

test('create a file and a folder, rename after a failed write, delete: keyboard only, through the menu and the dialogs', async () => {
  const { adapter, failures } = await mount();

  await goToRow('docs');
  await openMenuAndPick('New file');
  await expect.poll(dialogTitle).toMatch(/New file/);
  await press('notes.md{Enter}');
  await expect.poll(() => exists(adapter, 'docs/notes.md')).toBe(true);
  await expect.poll(focusedRowName, { message: 'the new file is focused' }).toBe('notes.md');

  await goToRow('src');
  await openMenuAndPick('New folder');
  await expect.poll(dialogTitle).toMatch(/New folder/);
  await press('components{Enter}');
  await expect.poll(async () => (await adapter.stat!('src/components'))?.kind).toBe('directory');
  await expect.poll(focusedRowName, { message: 'the new folder is focused' }).toBe('components');

  await goToRow('README.md');
  await press('{F2}');
  const renameInput = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>('[data-fs-part=tree-rename-input]');
  await expect.poll(renameInput).not.toBeNull();
  await press(`${withMod('a')}INTRO.md{Enter}`);
  await expect.poll(() => failures).toEqual(['move README.md']);
  await expect
    .poll(() => renameInput()?.value, { message: 'the field reopens with the typed name' })
    .toBe('INTRO.md');
  await expect.poll(() => document.activeElement).toBe(renameInput());
  await press('{Enter}');
  await expect.poll(() => exists(adapter, 'INTRO.md')).toBe(true);
  expect(await exists(adapter, 'README.md')).toBe(false);
  await expect.poll(focusedRowName).toBe('INTRO.md');

  await goToRow('docs');
  await expandFocusedRow();
  await goToRow('api.md');
  await press('{Delete}');
  await expect.poll(() => dialog()?.getAttribute('role')).toBe('alertdialog');
  await focusDialogButton('Delete');
  await press('{Enter}');
  await expect.poll(() => exists(adapter, 'docs/api.md')).toBe(false);
  await expect.poll(() => rowNamed('api.md')).toBeUndefined();
  expect(isTreeRow(document.activeElement!), 'focus is back in the tree').toBe(true);
});

test('copy, cut and paste with a conflict, and a drag move: keyboard and synthetic drag events only', async () => {
  const { adapter } = await mount();

  await goToRow('README.md');
  await press(withMod('c'));
  await goToRow('docs');
  await press(withMod('v'));
  await expect.poll(() => exists(adapter, 'docs/README.md')).toBe(true);
  expect(await exists(adapter, 'README.md'), 'a copy keeps the original').toBe(true);

  await goToRow('README.md');
  await press(withMod('c'));
  await goToRow('docs');
  await press(withMod('v'));
  await expect.poll(dialogTitle).toBe('"docs/README.md" already exists');
  await expect
    .poll(() => document.activeElement?.textContent, { message: 'Keep both has focus' })
    .toBe('Keep both');
  await press('{Enter}');
  await expect.poll(() => exists(adapter, 'docs/README copy.md')).toBe(true);

  await goToRow('src');
  await expandFocusedRow();
  await goToRow('util.ts');
  await press(withMod('x'));
  await expect.poll(() => rowNamed('util.ts')?.hasAttribute('data-cut')).toBe(true);
  await goToRow('docs');
  await press(withMod('v'));
  await expect.poll(() => exists(adapter, 'docs/util.ts')).toBe(true);
  expect(await exists(adapter, 'src/util.ts')).toBe(false);

  const dataTransfer = new DataTransfer();
  const fire = (target: Element, type: string): void => {
    const event = new DragEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    target.dispatchEvent(event);
  };
  fire(rowNamed('assets')!, 'dragstart');
  for (const type of ['dragenter', 'dragover', 'drop']) fire(rowNamed('src')!, type);
  fire(rowNamed('assets') ?? workspace(), 'dragend');
  await expect.poll(() => exists(adapter, 'src/assets/logo.svg')).toBe(true);
  expect(await exists(adapter, 'assets')).toBe(false);
});

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
const folderTransfer = (entries: DropEntry[]): DataTransfer =>
  ({
    types: ['Files'],
    dropEffect: 'none',
    items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null })),
    files: [],
  }) as unknown as DataTransfer;

const pickedFilesWithRelativePaths = (paths: string[]): File[] =>
  paths.map((path) => {
    const file = new File([path], path.split('/').at(-1)!);
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    return file;
  });

function pick(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

test('upload files and a folder through the keyboard menu, and a folder through a synthetic drop', async () => {
  let releaseUploads = (): void => {};
  const uploadsWaitFor = new Promise<void>((resolve) => (releaseUploads = resolve));
  const { adapter } = await mount({ uploadsWaitFor });
  const pickers: HTMLInputElement[] = [];
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    pickers.push(this);
  });

  await goToRow('docs');
  await openMenuAndPick('Upload files');
  await expect.poll(() => pickers.length).toBe(1);
  pick(pickers[0]!, [new File(['one'], 'one.txt'), new File(['two'], 'two.txt')]);
  await expect.poll(() => document.querySelector('[data-fs-part=upload-progress]')).not.toBeNull();
  await expect.poll(() => document.querySelector('[data-fs-part=tree-row-placeholder]')).not.toBeNull();
  await expectNoAxeViolationsInEitherColorScheme(workspace(), 'upload in progress');
  releaseUploads();
  await expect.poll(() => exists(adapter, 'docs/two.txt')).toBe(true);
  expect(await exists(adapter, 'docs/one.txt')).toBe(true);

  await goToRow('docs');
  await openMenuAndPick('Upload folder');
  await expect.poll(() => pickers.length).toBe(2);
  expect(pickers[1]!.hasAttribute('webkitdirectory')).toBe(true);
  pick(pickers[1]!, pickedFilesWithRelativePaths(['shots/cat.png', 'shots/raw/dog.png']));
  await expect.poll(() => exists(adapter, 'docs/shots/raw/dog.png')).toBe(true);
  expect(await exists(adapter, 'docs/shots/cat.png')).toBe(true);

  const photos = folderTransfer([
    folderEntry('/photos', [
      fileEntry('/photos/cat.png'),
      folderEntry('/photos/raw', [fileEntry('/photos/raw/dog.png')]),
    ]),
  ]);
  const target = document.activeElement!;
  for (const type of ['dragenter', 'dragover', 'drop']) {
    const event = new DragEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: photos });
    target.dispatchEvent(event);
  }
  await expect.poll(() => exists(adapter, 'docs/photos/raw/dog.png')).toBe(true);
  expect(await exists(adapter, 'docs/photos/cat.png')).toBe(true);
  await expect
    .poll(() => document.querySelector('[data-fs-part=upload-summary]')?.textContent)
    .toBe('Uploaded 2 files to "docs".');
  await expect.poll(() => rowNamed('photos')).toBeDefined();
});

test('a failed listing shows an error row and loads on the next expand', async () => {
  const { failures } = await mount();
  await goToRow('flaky');
  await expandFocusedRow();
  await goToRow('deeper');
  await press('{ArrowRight}');
  await expect.poll(() => rowNamed('deeper')?.getAttribute('data-status')).toBe('error');
  expect(failures).toEqual([`list ${FAILING_LIST}`]);
  await expect.element(rowNamed('deeper')!).toHaveAccessibleDescription('The server did not answer.');
  await expectNoAxeViolationsInEitherColorScheme(workspace(), 'error row');
  await press('{ArrowLeft}');
  await press('{ArrowRight}');
  await expect.poll(() => rowNamed('inside.txt')).toBeDefined();
  expect(rowNamed('deeper')!.hasAttribute('data-status')).toBe(false);
});

test('search reveals a file deep in the tree and previews it; Enter pins; a dirty tab asks before closing', async () => {
  await mount();
  await tabUntil((element) => element.getAttribute('data-fs-part') === 'search-input', 'the search box');
  await press('guide');
  await expect.poll(() => document.querySelectorAll('[role=option]').length).toBe(1);
  await press('{ArrowDown}{Enter}');
  await expect.poll(focusedRowName, { message: 'the reveal focuses the row' }).toBe('guide.md');
  await expect.poll(activeTabName).toBe('guide.md');
  expect(activeTab()!.hasAttribute('data-preview'), 'search opens a preview').toBe(true);

  await goToRow('src');
  await expandFocusedRow();
  await goToRow('index.ts');
  await press('{Enter}');
  await expect.poll(activeTabName).toBe('index.ts');
  expect(activeTab()!.hasAttribute('data-preview'), 'Enter pins').toBe(false);
  expect(tabNames()).toEqual(['guide.md', 'index.ts']);

  await tabUntil(
    (element) => element.getAttribute('aria-label') === 'Contents of src/index.ts',
    'the editor',
  );
  await press('edited');
  await expect.poll(() => activeTab()?.hasAttribute('data-dirty')).toBe(true);
  await expectNoAxeViolationsInEitherColorScheme(
    document.querySelector<HTMLElement>('[role=tablist]')!,
    'tab strip with a preview and a dirty tab',
  );
  await tabUntil((element) => element.getAttribute('role') === 'tab', 'the tab strip', 'backwards');
  await press('{End}');
  await press('{Delete}');
  await expect.poll(() => dialog()?.getAttribute('role')).toBe('alertdialog');
  expect(dialog()!.textContent).toContain('index.ts');
  await focusDialogButton('Discard');
  await press('{Enter}');
  await expect.poll(tabNames).toEqual(['guide.md']);
});

test('follow keeps up with a burst of agent changes without taking keyboard focus', async () => {
  const { adapter } = await mount({ defaultFollow: true });
  await goToRow('README.md');
  const burst = Array.from(
    { length: 300 },
    (_, index) => `src/generated-${String(index).padStart(3, '0')}.ts`,
  );
  await Promise.all(burst.map((path) => adapter.write!(path, 'generated')));
  adapter.emit(burst.map((path) => ({ type: 'updated' as const, path, actor: 'agent' as const })));
  await expect.poll(activeTabName, { timeout: 5000 }).toBe('generated-299.ts');
  expect(focusedRowName(), 'focus stays on the row the user is on').toBe('README.md');
  await expect.poll(() => rowNamed('generated-299.ts')?.getAttribute('aria-selected')).toBe('true');
  expect(tabNames()).toHaveLength(1);

  await tabUntil(
    (element) => element.getAttribute('role') === 'toolbar' || element.closest('[role=toolbar]') !== null,
    'the toolbar',
    'backwards',
  );
  await press('{End}');
  const follow = document.activeElement!;
  expect(follow.getAttribute('aria-label')).toBe('Follow agent changes');
  await press('{Enter}');
  await expect.poll(() => follow.getAttribute('aria-pressed')).toBe('false');
  adapter.emit([{ type: 'updated', path: 'src/index.ts', actor: 'agent' }]);
  await expect.poll(() => rowNamed('index.ts')?.hasAttribute('data-changed')).toBe(true);
  expect(activeTabName(), 'follow is off').toBe('generated-299.ts');
});

test.each(THEMES)(
  'axe: no violations with the menu, a dialog, the conflict dialog and search results open (%s)',
  async (theme) => {
    const { adapter } = await mount({ theme });

    await goToRow('docs');
    await openMenuAndPick('New file', () => expectNoAxeViolations(workspace(), `${theme} menu open`));
    await expect.poll(dialog).not.toBeNull();
    await expectNoAxeViolations(workspace(), `${theme} new file dialog`);
    await press('{Escape}');
    await expect.poll(dialog).toBeNull();

    await goToRow('README.md');
    await press(withMod('c'));
    await goToRow('docs');
    await press(withMod('v'));
    await expect.poll(() => exists(adapter, 'docs/README.md')).toBe(true);
    await press(withMod('v'));
    await expect.poll(dialogTitle).toBe('"docs/README.md" already exists');
    await expectNoAxeViolations(workspace(), `${theme} conflict dialog`);
    await press('{Escape}');
    await expect.poll(dialog).toBeNull();

    await tabUntil(
      (element) => element.getAttribute('data-fs-part') === 'search-input',
      'the search box',
      'backwards',
    );
    await press('md');
    await expect.poll(() => document.querySelectorAll('[role=option]').length).toBeGreaterThan(1);
    await press('{ArrowDown}');
    await expectNoAxeViolations(workspace(), `${theme} search results`);
  },
);

const AFTER_AN_AUTOSAVE = { timeout: 4000 };
const ONE_POLLING_INTERVAL_AND_MARGIN = { timeout: 8000 };
const LOADING_THE_TIFF_CODE = { timeout: 5000 };
const TIFF_PAGES = Array.from({ length: 6 }, () => ({ width: 200, height: 300 }));

async function pngBytes(color: string): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = 120;
  canvas.height = 80;
  const context = canvas.getContext('2d')!;
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((png) => resolve(png!), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

async function mountWithViewers(
  adapt: (memory: MemoryAdapter) => FileSystemAdapter = (memory) => memory,
): Promise<MemoryAdapter> {
  const memory = createMemoryAdapter({
    files: {
      'notes.txt': 'first line',
      'photo.png': await pngBytes('red'),
      'scan.tiff': new Uint8Array(tiffBytes(TIFF_PAGES)),
      'docs/guide.md': 'guide',
    },
  });
  await render(<Workspace adapter={adapt(memory)} style={{ width: 960, height: 560 }} />);
  await expect.poll(rowNames).toEqual(['docs', 'notes.txt', 'photo.png', 'scan.tiff']);
  return memory;
}

const part = (name: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[role=tabpanel]:not([hidden]) [data-fs-part=${name}]`);
const editor = (): HTMLTextAreaElement | null => part('text-editor') as HTMLTextAreaElement | null;
const saveStatusText = (): string | null | undefined => part('viewer-save-status')?.textContent;
const saveBanner = (): HTMLElement | null => part('save-banner');
const isBannerButton =
  (label: string) =>
  (element: Element): boolean =>
    element.textContent === label && element.closest('[data-fs-part=save-banner]') !== null;
const tiffImageSources = (): string[] =>
  [...document.querySelectorAll<HTMLImageElement>('[data-fs-part=tiff-page-image]')].map(
    (image) => image.src,
  );
const replaceAsTheAgent = (adapter: MemoryAdapter, path: string, bytes: Uint8Array): Promise<unknown> =>
  adapter.upload!.direct(path, new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    signal: new AbortController().signal,
    overwrite: true,
  });

async function openFromTheTree(name: string): Promise<void> {
  if (!isTreeRow(document.activeElement!)) {
    const fromNowhere = document.activeElement === document.body;
    await tabUntil(isTreeRow, 'the tree', fromNowhere ? 'forwards' : 'backwards');
  }
  await goToRow(name);
  await press('{Enter}');
  await expect.poll(activeTabName).toBe(name);
}

async function typeInTheEditor(text: string): Promise<void> {
  await expect.poll(editor).not.toBeNull();
  if (document.activeElement !== editor()) await tabUntil((element) => element === editor(), 'the editor');
  await press(`${TO_THE_END_OF_THE_TEXT}${text}`);
}

test('viewer: a search preview pinned from the tree, autosave, and agent conflicts resolved from the banner, keyboard only', async () => {
  const adapter = await mountWithViewers();
  await tabUntil((element) => element.getAttribute('data-fs-part') === 'search-input', 'the search box');
  await press('notes');
  await expect.poll(() => document.querySelectorAll('[role=option]').length).toBe(1);
  await press('{ArrowDown}{Enter}');
  await expect.poll(activeTabName).toBe('notes.txt');
  expect(activeTab()!.hasAttribute('data-preview'), 'search opens a preview').toBe(true);
  await expect.poll(focusedRowName, { message: 'the reveal focuses the row' }).toBe('notes.txt');
  await press('{Enter}');
  await expect.poll(() => activeTab()?.hasAttribute('data-preview'), { message: 'Enter pins' }).toBe(false);
  await expect.poll(() => editor()?.value).toBe('first line');
  await expectNoAxeViolationsInEitherColorScheme(workspace(), 'a pinned text file');

  await typeInTheEditor(' edited');
  await expect.poll(() => adapter.read('notes.txt', 'text'), AFTER_AN_AUTOSAVE).toBe('first line edited');
  await expect.poll(saveStatusText).toBe('Saved');
  await expectNoAxeViolationsInEitherColorScheme(workspace(), 'saved');

  await typeInTheEditor(' mine');
  await adapter.write!('notes.txt', 'agent version');
  await expect.poll(saveBanner).not.toBeNull();
  await expect.poll(saveStatusText).toBe('Changed by someone else');
  await expectNoAxeViolationsInEitherColorScheme(workspace(), 'a conflict banner');
  await tabUntil(isBannerButton('Keep mine'), 'Keep mine', 'backwards');
  await press('{Enter}');
  await expect.poll(() => adapter.read('notes.txt', 'text')).toBe('first line edited mine');
  await expect.poll(saveStatusText).toBe('Saved');
  expect(saveBanner()).toBeNull();
  await expect.poll(() => document.activeElement, { message: 'focus is back in the editor' }).toBe(editor());

  await typeInTheEditor('!');
  await adapter.write!('notes.txt', 'their final word');
  await expect.poll(saveBanner).not.toBeNull();
  await tabUntil(isBannerButton('Take theirs'), 'Take theirs', 'backwards');
  await press('{Enter}');
  await expect.poll(() => editor()?.value).toBe('their final word');
  expect(saveBanner()).toBeNull();
  expect(await adapter.read('notes.txt', 'text')).toBe('their final word');
});

test('viewer: a new version refreshes in place, keeping the image zoom and the TIFF page, keyboard only', async () => {
  const adapter = await mountWithViewers();
  await openFromTheTree('photo.png');
  const zoomLevel = (): string | null | undefined => part('image-zoom-level')?.textContent;
  await expect.poll(() => part('image-content')?.getAttribute('src')).toBeTruthy();
  await tabUntil((element) => element.getAttribute('data-fs-part') === 'image-surface', 'the image');
  const fittedZoom = zoomLevel();
  await press('+');
  await expect.poll(zoomLevel).not.toBe(fittedZoom);
  const zoomed = zoomLevel();
  const firstVersion = part('image-content')!.getAttribute('src');
  await replaceAsTheAgent(adapter, 'photo.png', await pngBytes('blue'));
  await expect.poll(() => part('image-content')?.getAttribute('src')).not.toBe(firstVersion);
  expect(zoomLevel(), 'the zoom survives the refresh').toBe(zoomed);
  expect(part('image-surface')!.hasAttribute('data-zoomed')).toBe(true);
  await expectNoAxeViolationsInEitherColorScheme(workspace(), 'a zoomed image after a refresh');

  await openFromTheTree('scan.tiff');
  const pageIndicator = (): string | null | undefined => part('tiff-page-indicator')?.textContent;
  await expect.poll(pageIndicator, LOADING_THE_TIFF_CODE).toBe('Page 1 of 6');
  await tabUntil((element) => element.getAttribute('data-fs-part') === 'pages-viewport', 'the pages');
  await press('{PageDown}{PageDown}');
  await expect.poll(pageIndicator).toBe('Page 3 of 6');
  await expect.poll(() => tiffImageSources().length).toBeGreaterThan(0);
  const firstVersionPages = tiffImageSources();
  const blue = TIFF_PAGES.map((page) => ({ ...page, rgb: [0, 0, 255] as const }));
  await replaceAsTheAgent(adapter, 'scan.tiff', new Uint8Array(tiffBytes(blue)));
  await expect
    .poll(() => {
      const shown = tiffImageSources();
      return shown.length > 0 && shown.every((source) => !firstVersionPages.includes(source));
    })
    .toBe(true);
  expect(pageIndicator(), 'the page survives the refresh').toBe('Page 3 of 6');
  await expectNoAxeViolationsInEitherColorScheme(workspace(), 'a TIFF after a refresh');
});

test('viewer: an open file deleted while it has unsaved edits keeps them, and Save creates it again, keyboard only', async () => {
  const adapter = await mountWithViewers();
  await openFromTheTree('notes.txt');
  await typeInTheEditor(' draft');
  await adapter.delete!('notes.txt');
  await expect.poll(saveStatusText).toBe('Deleted');
  expect(editor()!.value).toBe('first line draft');
  expect(activeTab()!.hasAttribute('data-deleted')).toBe(true);
  await expectNoAxeViolationsInEitherColorScheme(workspace(), 'a deleted file with unsaved edits');
  await tabUntil(isBannerButton('Save'), 'Save', 'backwards');
  await press('{Enter}');
  await expect.poll(() => adapter.read('notes.txt', 'text')).toBe('first line draft');
  await expect.poll(saveStatusText).toBe('Saved');
  expect(saveBanner()).toBeNull();
  await expect.poll(() => activeTab()?.hasAttribute('data-deleted')).toBe(false);
});

test('viewer: without watch, polling brings an agent edit into the open file and autosave still works, keyboard only', async () => {
  const adapter = await mountWithViewers((memory) => ({ ...memory, watch: undefined }));
  await openFromTheTree('notes.txt');
  await expect.poll(() => editor()?.value).toBe('first line');
  await adapter.write!('notes.txt', 'an agent edit');
  await expect.poll(() => editor()?.value, ONE_POLLING_INTERVAL_AND_MARGIN).toBe('an agent edit');
  await expectNoAxeViolationsInEitherColorScheme(workspace(), 'a file refreshed by polling');
  await typeInTheEditor(' and mine');
  await expect
    .poll(() => adapter.read('notes.txt', 'text'), AFTER_AN_AUTOSAVE)
    .toBe('an agent edit and mine');
  await expect.poll(saveStatusText).toBe('Saved');
  expect(saveBanner()).toBeNull();
});
