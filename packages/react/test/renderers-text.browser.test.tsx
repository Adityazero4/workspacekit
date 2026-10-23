import { FsError, statusOf, type Entry, type FileSystemAdapter } from '@scope/core';
import { createMemoryAdapter } from '@scope/core/memory';
import axe from 'axe-core';
import { createElement, useEffect, useState, type ComponentType } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { useFileSystem, type FileSystemContext } from '../src/provider/hooks';
import { TextViewer, UnsupportedViewer } from '../src/renderers';
import {
  directoryRenderer,
  lightRenderers,
  textRenderer,
  unsupportedRenderer,
} from '../src/viewer/lightRenderers';
import { fileInfo, resolveRenderer, type RendererProps, type ViewerError } from '../src/viewer/registry';
import { useFileViewer } from '../src/viewer/useFileViewer';
import { animationFrames } from './support/animationFrames';
import { cssTransitionsToSettle } from './support/cssTransitionsToSettle';

const MIB = 1024 * 1024;

afterEach(() => {
  vi.restoreAllMocks();
});

const fileEntry = (path: string, size?: number): Entry => ({
  path,
  name: path.split('/').at(-1)!,
  kind: 'file',
  size,
});

const loadedComponents = async (): Promise<Map<string, ComponentType<RendererProps>>> =>
  new Map(
    await Promise.all(
      lightRenderers.map(async (renderer) => [renderer.id, (await renderer.load()).default] as const),
    ),
  );

const textarea = (): HTMLTextAreaElement | null => document.querySelector('textarea');
const lineView = (): HTMLElement | null => document.querySelector('[role=document]');
const listbox = (): HTMLElement => document.querySelector<HTMLElement>('[role=listbox]')!;
const optionNames = (): string[] =>
  [...document.querySelectorAll('[role=option] [data-fs-part=dir-name]')].map((cell) => cell.textContent!);
const activeOptionName = (): string | null | undefined => {
  const id = listbox().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.querySelector('[data-fs-part=dir-name]')?.textContent : undefined;
};

function CaptureContext(props: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => void props.onContext(fs));
  return null;
}

function RegistryViewer(props: {
  path: string;
  components: Map<string, ComponentType<RendererProps>>;
  onOpenEntry?: (path: string) => void;
  onSourceText?: (text: string) => void;
  onError?: (error: ViewerError) => void;
}): React.JSX.Element | null {
  const viewer = useFileViewer(props.path, { renderers: lightRenderers });
  const sourceText = viewer.source?.kind === 'text' ? viewer.source.text : undefined;
  const { onSourceText } = props;
  useEffect(() => {
    if (sourceText !== undefined) onSourceText?.(sourceText);
  }, [sourceText, onSourceText]);
  if (!viewer.entry || !viewer.renderer || !viewer.source) return null;
  return createElement(props.components.get(viewer.renderer.id)!, {
    entry: viewer.entry,
    source: viewer.source,
    version: viewer.version,
    mode: viewer.mode,
    isActive: true,
    readOnly: false,
    onOpenEntry: props.onOpenEntry,
    onError: (error: ViewerError) => props.onError?.(error),
    onDownload: viewer.download,
  });
}

async function mountRegistryViewer(
  adapter: FileSystemAdapter,
  path: string,
  callbacks: Pick<Parameters<typeof RegistryViewer>[0], 'onOpenEntry' | 'onSourceText' | 'onError'> = {},
): Promise<FileSystemContext> {
  const components = await loadedComponents();
  let captured: FileSystemContext | undefined;
  await render(
    <FileSystemProvider adapter={adapter}>
      <div style={{ height: 200, display: 'flex', flexDirection: 'column' }}>
        <RegistryViewer path={path} components={components} {...callbacks} />
      </div>
      <CaptureContext onContext={(fs) => (captured = fs)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => captured && statusOf(captured.store.getSnapshot().tree, '')).toBe('loaded');
  return captured!;
}

const numberedLines = (count: number, prefix = 'line'): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join('\n');

const textOfTwoMebibytes = (): string =>
  Array.from({ length: 45_000 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n');

const rendererProps = {
  version: 1,
  mode: undefined,
  isActive: true,
  readOnly: false,
  onError: () => {},
};

function RetypingParent(): React.JSX.Element {
  const [typed, setTyped] = useState('');
  return (
    <>
      <TextViewer src={new Blob(['start'])} fileName="a.txt" onChange={setTyped} />
      <output>{typed}</output>
    </>
  );
}

async function expectNoAxeViolations(element: Element): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await commands.emulateMedia({ colorScheme });
    await cssTransitionsToSettle();
    const results = await axe.run(element);
    expect(
      results.violations.map((violation) => `${colorScheme} ${violation.id}: ${violation.help}`),
    ).toEqual([]);
  }
  await commands.emulateMedia({ colorScheme: null });
}

test('Makefile and .env open in the text renderer; an unknown binary opens unsupported', () => {
  const resolvedId = (entry: Entry): string | undefined => resolveRenderer(entry, lightRenderers)?.id;
  for (const path of ['Makefile', '.env', '.env.local', 'src/.env.production', 'notes.txt', 'a/Dockerfile']) {
    expect(resolvedId(fileEntry(path)), path).toBe(textRenderer.id);
  }
  expect(resolvedId(fileEntry('photo.raw'))).toBe(unsupportedRenderer.id);
  expect(resolvedId(fileEntry('data'))).toBe(unsupportedRenderer.id);
  expect(textRenderer.match(fileInfo(fileEntry('data')))).toBe(false);
  expect(textRenderer.match(fileInfo(fileEntry('.envrc')))).toBe(false);
  expect(resolvedId({ path: 'src', name: 'src', kind: 'directory' })).toBe(directoryRenderer.id);
  expect(resolvedId({ path: 'notes.txt', name: 'notes.txt', kind: 'directory' })).toBe(directoryRenderer.id);
});

test('editing calls onChange; a 2 MiB file is read-only and virtualized', async () => {
  const TextRenderer = (await textRenderer.load()).default;
  const onChange = vi.fn();
  const props = {
    version: 1,
    mode: undefined,
    isActive: true,
    readOnly: false,
    onError: () => {},
    onChange,
  };
  const screen = await render(
    <div style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
      <TextRenderer
        {...props}
        entry={fileEntry('docs/notes.txt', 5)}
        source={{ kind: 'text', text: 'hello' }}
      />
    </div>,
  );
  expect(textarea()!.value).toBe('hello');
  expect(textarea()!.getAttribute('aria-label')).toBe('Contents of docs/notes.txt');
  await userEvent.fill(textarea()!, 'hello world');
  expect(onChange).toHaveBeenLastCalledWith('hello world');
  await screen.unmount();

  const big = textOfTwoMebibytes();
  await render(
    <div style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
      <TextRenderer {...props} entry={fileEntry('big.log', 2 * MIB)} source={{ kind: 'text', text: big }} />
    </div>,
  );
  await expect.poll(lineView).not.toBeNull();
  expect(textarea()).toBeNull();
  expect(lineView()!.getAttribute('aria-label')).toBe('Contents of big.log');
  const lines = [...lineView()!.querySelectorAll('[data-fs-part=text-line]')];
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.length).toBeLessThan(100);
  expect(lines[0]!.textContent).toMatch(/^line 0 x+$/);
  const heights = new Set(lines.map((line) => line.getBoundingClientRect().height));
  expect(heights.size).toBe(1);

  lineView()!.scrollTop = lineView()!.scrollHeight;
  await expect
    .poll(() => lineView()!.querySelector('[data-fs-part=text-line]:last-child')?.textContent)
    .toMatch(/^line 44999 x+$/);
});

test('a read-only text file shows a read-only textarea', async () => {
  const TextRenderer = (await textRenderer.load()).default;
  await render(
    <TextRenderer
      entry={fileEntry('a.txt', 3)}
      source={{ kind: 'text', text: 'abc' }}
      version={1}
      mode={undefined}
      isActive
      readOnly
      onError={() => {}}
    />,
  );
  expect(textarea()!.readOnly).toBe(true);
});

test('an agent update while not dirty keeps scroll and caret', async () => {
  const original = numberedLines(400);
  const memory = createMemoryAdapter({ files: { 'notes.txt': original } });
  await mountRegistryViewer(memory, 'notes.txt');
  await expect.poll(() => textarea()?.value).toBe(original);
  const editor = textarea()!;
  editor.focus();
  editor.setSelectionRange(1200, 1210);
  await animationFrames(2);
  editor.scrollTop = 900;
  await animationFrames(2);
  expect(editor.scrollTop).toBe(900);

  const updated = numberedLines(400, 'LINE');
  await memory.write!('notes.txt', updated);
  await expect.poll(() => editor.value).toBe(updated);
  await animationFrames(2);
  expect(textarea()).toBe(editor);
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([1200, 1210]);
  expect(editor.scrollTop).toBe(900);
  expect(document.activeElement).toBe(editor);

  await memory.write!('notes.txt', 'short');
  await expect.poll(() => editor.value).toBe('short');
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([5, 5]);
});

test('an agent update after a local edit keeps the edit', async () => {
  const memory = createMemoryAdapter({ files: { 'notes.txt': 'v1' } });
  const sourceTexts: string[] = [];
  await mountRegistryViewer(memory, 'notes.txt', { onSourceText: (text) => sourceTexts.push(text) });
  await expect.poll(() => textarea()?.value).toBe('v1');
  await userEvent.fill(textarea()!, 'mine');

  await memory.write!('notes.txt', 'theirs');
  await expect.poll(() => sourceTexts.at(-1)).toBe('theirs');
  expect(textarea()!.value).toBe('mine');
  await memory.write!('notes.txt', 'mine');
  await expect.poll(() => sourceTexts.at(-1)).toBe('mine');
  await expect.poll(() => textarea()!.value).toBe('mine');
  await memory.write!('notes.txt', 'agent again');
  await expect.poll(() => textarea()!.value).toBe('agent again');
});

test('a CRLF file refreshes in place when the agent writes', async () => {
  const memory = createMemoryAdapter({ files: { 'win.txt': 'one\r\ntwo\r\nthree' } });
  await mountRegistryViewer(memory, 'win.txt');
  await expect.poll(() => textarea()?.value).toBe('one\ntwo\nthree');
  const editor = textarea()!;
  editor.focus();
  editor.setSelectionRange(4, 7);

  await memory.write!('win.txt', 'one\r\nTWO\r\nthree\r\nfour');
  await expect.poll(() => editor.value).toBe('one\nTWO\nthree\nfour');
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([4, 7]);
});

test('edits keep the line endings of a CRLF file; LF and mixed files emit as typed', async () => {
  const TextRenderer = (await textRenderer.load()).default;
  const emitted = async (text: string, typed: string): Promise<unknown> => {
    const onChange = vi.fn();
    const screen = await render(
      <TextRenderer
        {...rendererProps}
        entry={fileEntry('a.txt', text.length)}
        source={{ kind: 'text', text }}
        onChange={onChange}
      />,
    );
    await userEvent.fill(textarea()!, typed);
    await screen.unmount();
    return onChange.mock.lastCall?.[0];
  };
  expect(await emitted('a\r\nb', 'a\nb\nc')).toBe('a\r\nb\r\nc');
  expect(await emitted('a\nb', 'a\nb\nc')).toBe('a\nb\nc');
  expect(await emitted('a\nb\r\nc', 'x\ny')).toBe('x\ny');
});

test('a file that grows past 1 MiB keeps the editor while edited, and switches to the line view once clean', async () => {
  const memory = createMemoryAdapter({ files: { 'notes.txt': 'v1' } });
  const sourceTexts: string[] = [];
  await mountRegistryViewer(memory, 'notes.txt', { onSourceText: (text) => sourceTexts.push(text) });
  await expect.poll(() => textarea()?.value).toBe('v1');
  await userEvent.fill(textarea()!, 'mine');

  const big = textOfTwoMebibytes();
  await memory.write!('notes.txt', big);
  await expect.poll(() => sourceTexts.at(-1)?.length).toBe(big.length);
  expect(lineView()).toBeNull();
  expect(textarea()!.value).toBe('mine');

  await memory.write!('notes.txt', 'mine');
  await expect.poll(() => sourceTexts.at(-1)).toBe('mine');
  await memory.write!('notes.txt', big);
  await expect.poll(lineView).not.toBeNull();
  expect(textarea()).toBeNull();
});

test('directory lists children and Enter opens one', async () => {
  const memory = createMemoryAdapter({
    files: {
      'work/docs/b.txt': 'bbbb',
      'work/docs/a.md': 'a',
      'work/docs/sub/x.txt': '',
      'work/docs/node_modules/y.js': '',
    },
  });
  const onOpenEntry = vi.fn();
  const fs = await mountRegistryViewer(memory, 'work/docs', { onOpenEntry });
  await expect.poll(optionNames).toEqual(['sub', 'a.md', 'b.txt']);
  expect(listbox().getAttribute('aria-label')).toBe('Contents of work/docs');
  expect(document.querySelector('[data-fs-part=dir-header]')!.textContent).toBe('NameSizeModified');
  const bRow = [...document.querySelectorAll('[role=option]')][2]!;
  expect(bRow.querySelector('[data-fs-part=dir-size]')!.textContent).toBe(
    new Intl.NumberFormat(undefined, { style: 'unit', unit: 'byte', unitDisplay: 'long' }).format(4),
  );
  expect(bRow.querySelector('time')!.getAttribute('datetime')).toMatch(/^\d{4}-\d\d-\d\dT/);

  listbox().focus();
  expect(activeOptionName()).toBe('sub');
  await userEvent.keyboard('{ArrowDown}');
  expect(activeOptionName()).toBe('a.md');
  await userEvent.keyboard('{End}');
  expect(activeOptionName()).toBe('b.txt');
  await userEvent.keyboard('{ArrowDown}');
  expect(activeOptionName()).toBe('b.txt');
  await userEvent.keyboard('{Home}{ArrowDown}{Enter}');
  expect(onOpenEntry).toHaveBeenLastCalledWith('work/docs/a.md');

  await userEvent.dblClick(document.querySelectorAll('[role=option]')[0]!);
  expect(onOpenEntry).toHaveBeenLastCalledWith('work/docs/sub');

  fs.sort.set({ by: 'name', direction: 'desc' });
  await expect.poll(optionNames).toEqual(['sub', 'b.txt', 'a.md']);
  fs.showHidden.set(true);
  await expect.poll(optionNames).toEqual(['sub', 'node_modules', 'b.txt', 'a.md']);
  await expectNoAxeViolations(document.querySelector('[data-fs-part=dir-viewer]')!);
});

test('a directory the viewer cannot list loads it and reports load_error', async () => {
  const memory = createMemoryAdapter({ files: { 'work/docs/a.txt': '' } });
  const listings: string[] = [];
  const list: FileSystemAdapter['list'] = (path, options) => {
    listings.push(path);
    return path === '' ? memory.list(path, options) : Promise.reject(new FsError('forbidden', 'denied'));
  };
  const onError = vi.fn();
  await mountRegistryViewer({ ...memory, list }, 'work/docs', { onError });
  await expect.poll(() => onError.mock.calls.length).toBe(1);
  expect(onError.mock.calls[0]![0]).toMatchObject({ kind: 'load_error' });
  expect(document.querySelector('[data-fs-part=dir-viewer]')!.getAttribute('data-status')).toBe('error');
  expect(listings).toContain('work/docs');
});

test('clicking a row keeps focus on the listbox, even after the row scrolls away', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 60 }, (_, index) => [`work/many/f${String(index).padStart(2, '0')}.txt`, '']),
  );
  await mountRegistryViewer(createMemoryAdapter({ files }), 'work/many');
  await expect.poll(() => optionNames()[0]).toBe('f00.txt');
  await userEvent.click(document.querySelectorAll('[role=option]')[1]!);
  expect(document.activeElement).toBe(listbox());
  expect(activeOptionName()).toBe('f01.txt');

  for (let step = 0; step < 40; step++) await userEvent.keyboard('{ArrowDown}');
  expect(optionNames()).not.toContain('f01.txt');
  expect(document.activeElement).toBe(listbox());
  expect(activeOptionName()).toBe('f41.txt');
  await userEvent.keyboard('{ArrowUp}');
  expect(activeOptionName()).toBe('f40.txt');
});

test('the root directory is labelled as the workspace root', async () => {
  const DirectoryViewer = (await directoryRenderer.load()).default;
  await render(
    <FileSystemProvider adapter={createMemoryAdapter({ files: { 'a.txt': '' } })}>
      <DirectoryViewer
        {...rendererProps}
        entry={{ path: '', name: '', kind: 'directory' }}
        source={{ kind: 'none' }}
      />
    </FileSystemProvider>,
  );
  await expect.poll(optionNames).toEqual(['a.txt']);
  expect(listbox().getAttribute('aria-label')).toBe('Contents of the workspace root');
});

test('standalone TextViewer renders from a Blob without a provider', async () => {
  const screen = await render(
    <TextViewer src={new Blob(['hello'])} fileName="notes.txt" theme="dark" className="mine" />,
  );
  await expect.poll(() => textarea()?.value).toBe('hello');
  expect(textarea()!.getAttribute('aria-label')).toBe('Contents of notes.txt');
  const root = document.querySelector<HTMLElement>('[data-fs-part=text-viewer]')!;
  expect(root.dataset.theme).toBe('dark');
  expect(root.className).toBe('mine');
  await expectNoAxeViolations(root);

  await screen.rerender(<TextViewer src={new TextEncoder().encode('from bytes')} theme="system" />);
  await expect.poll(() => textarea()?.value).toBe('from bytes');
  expect(root.hasAttribute('data-theme')).toBe(false);

  await screen.rerender(<TextViewer src={new TextEncoder().encode('array buffer').buffer} />);
  await expect.poll(() => textarea()?.value).toBe('array buffer');
});

test('standalone TextViewer keeps caret and typing when the parent passes a new, equal Blob on every render', async () => {
  await render(<RetypingParent />);
  await expect.poll(() => textarea()?.value).toBe('start');
  const editor = textarea()!;
  editor.focus();
  editor.setSelectionRange(2, 2);
  await userEvent.keyboard('XYZ');
  await expect.poll(() => document.querySelector('output')!.textContent).toBe('stXYZart');
  expect(textarea()).toBe(editor);
  expect(editor.value).toBe('stXYZart');
  expect(editor.selectionStart).toBe(5);
  expect(document.activeElement).toBe(editor);
});

test('standalone TextViewer is read-only and reports no edits while a different file loads', async () => {
  const held: Array<(response: Response) => void> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
    String(input).endsWith('/a.txt')
      ? Promise.resolve(new Response('first'))
      : new Promise((resolve) => held.push(resolve)),
  );
  const onChange = vi.fn();
  const view = (src: string) => <TextViewer src={src} fileName="notes.txt" onChange={onChange} />;
  const screen = await render(view('https://example.test/a.txt'));
  await expect.poll(() => textarea()?.value).toBe('first');
  const editor = textarea()!;
  const root = document.querySelector<HTMLElement>('[data-fs-part=text-viewer]')!;
  expect(root.hasAttribute('aria-busy')).toBe(false);

  await screen.rerender(view('https://example.test/b.txt'));
  await expect.poll(() => held.length).toBe(1);
  expect(root.getAttribute('aria-busy')).toBe('true');
  expect(editor.readOnly).toBe(true);
  editor.focus();
  editor.setSelectionRange(5, 5);
  await userEvent.keyboard('X');
  expect(editor.value).toBe('first');
  expect(onChange).not.toHaveBeenCalled();

  held[0]!(new Response('second'));
  await expect.poll(() => editor.value).toBe('second');
  expect(editor.readOnly).toBe(false);
  expect(root.hasAttribute('aria-busy')).toBe(false);
  editor.setSelectionRange(6, 6);
  await userEvent.keyboard('!');
  expect(onChange).toHaveBeenLastCalledWith('second!');

  await screen.rerender(view('https://example.test/c.txt'));
  await expect.poll(() => held.length).toBe(2);
  held[1]!(new Response('gone', { status: 404 }));
  await expect.poll(() => document.querySelector('[role=alert]')).not.toBeNull();
  expect(textarea()).toBeNull();
});

test('standalone TextViewer reports an edit made while new bytes decode only when the text is the same', async () => {
  const releases: Array<() => void> = [];
  const heldBlob = (text: string): Blob => {
    const blob = new Blob([text]);
    blob.arrayBuffer = () =>
      new Promise((resolve) => releases.push(() => resolve(new TextEncoder().encode(text).buffer)));
    return blob;
  };
  const onChange = vi.fn();
  const view = (src: Blob) => <TextViewer src={src} fileName="notes.txt" onChange={onChange} />;
  const screen = await render(view(new Blob(['first'])));
  await expect.poll(() => textarea()?.value).toBe('first');
  const editor = textarea()!;
  editor.focus();

  await screen.rerender(view(heldBlob('second')));
  await expect.poll(() => releases.length).toBe(1);
  editor.setSelectionRange(5, 5);
  await userEvent.keyboard('X');
  expect(editor.value).toBe('firstX');
  expect(onChange).not.toHaveBeenCalled();
  releases[0]!();
  await expect.poll(() => editor.value).toBe('second');
  expect(onChange).not.toHaveBeenCalled();

  await screen.rerender(view(heldBlob('second')));
  await expect.poll(() => releases.length).toBe(2);
  editor.setSelectionRange(6, 6);
  await userEvent.keyboard('!');
  expect(onChange).not.toHaveBeenCalled();
  releases[1]!();
  await expect.poll(() => onChange.mock.lastCall?.[0]).toBe('second!');
  expect(editor.value).toBe('second!');
});

test('standalone TextViewer reads only the bytes a Uint8Array view covers', async () => {
  const whole = new TextEncoder().encode('[[inside the view]]');
  await render(<TextViewer src={whole.subarray(2, whole.length - 2)} />);
  await expect.poll(() => textarea()?.value).toBe('inside the view');
});

test('standalone TextViewer fetches a URL, aborts on unmount and reports a failed fetch', async () => {
  const url = URL.createObjectURL(new Blob(['from a url']));
  const first = await render(<TextViewer src={url} fileName="remote.txt" />);
  await expect.poll(() => textarea()?.value).toBe('from a url');
  await first.unmount();
  URL.revokeObjectURL(url);

  const signals: AbortSignal[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    signals.push(init!.signal!);
    return new Promise(() => {});
  });
  const held = await render(<TextViewer src="https://example.test/held.txt" />);
  await expect.poll(() => signals.length).toBe(1);
  expect(document.querySelector('[data-fs-part=text-viewer]')!.getAttribute('data-status')).toBe('loading');
  await held.unmount();
  expect(signals[0]!.aborted).toBe(true);

  vi.mocked(fetch).mockResolvedValue(new Response('missing', { status: 404 }));
  const onError = vi.fn();
  await render(<TextViewer src="https://example.test/missing.txt" onError={onError} />);
  await expect.poll(() => onError.mock.calls.length).toBe(1);
  expect(onError.mock.calls[0]![0]).toMatchObject({ kind: 'load_error' });
  expect(document.querySelector('[data-fs-part=text-viewer]')!.getAttribute('data-status')).toBe('error');
  expect(document.querySelector('[role=alert]')!.textContent).toBe(onError.mock.calls[0]![0].message);
});

test('standalone TextViewer refuses a file over 10 MiB as too_large without reading it', async () => {
  const huge = new Blob([new Uint8Array(10 * MIB + 1)]);
  const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
  const onError = vi.fn();
  const blobView = await render(<TextViewer src={huge} fileName="huge.log" onError={onError} />);
  await expect.poll(() => onError.mock.calls.length).toBe(1);
  expect(onError.mock.calls[0]![0]).toMatchObject({ kind: 'too_large' });
  expect(read).not.toHaveBeenCalled();
  await blobView.unmount();

  const body = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    headers: new Headers({ 'content-length': String(10 * MIB + 1) }),
    arrayBuffer: body,
  } as unknown as Response);
  const urlError = vi.fn();
  await render(<TextViewer src="https://example.test/huge.log" onError={urlError} />);
  await expect.poll(() => urlError.mock.calls.length).toBe(1);
  expect(urlError.mock.calls[0]![0]).toMatchObject({ kind: 'too_large' });
  expect(body).not.toHaveBeenCalled();
});

test('standalone TextViewer stops reading a URL body without Content-Length once it passes 10 MiB', async () => {
  const CHUNK_BYTES = MIB;
  const TOTAL_BYTES = 30 * MIB;
  let pulledBytes = 0;
  let isCancelled = false;
  let releaseCancel = (): void => {};
  const cancelHeld = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  const chunkedBody = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulledBytes += CHUNK_BYTES;
        controller.enqueue(new Uint8Array(CHUNK_BYTES));
        if (pulledBytes >= TOTAL_BYTES) controller.close();
      },
      cancel() {
        isCancelled = true;
        return cancelHeld;
      },
    },
    { highWaterMark: 0 },
  );
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(chunkedBody));
  const onError = vi.fn();
  await render(<TextViewer src="https://example.test/chunked.log" onError={onError} />);
  await expect.poll(() => isCancelled).toBe(true);
  expect(pulledBytes).toBeLessThanOrEqual(10 * MIB + CHUNK_BYTES);
  expect(onError).not.toHaveBeenCalled();
  releaseCancel();
  await expect.poll(() => onError.mock.calls.length).toBe(1);
  expect(onError.mock.calls[0]![0]).toMatchObject({ kind: 'too_large' });
});

test('standalone TextViewer: value controls the text and onChange reports edits', async () => {
  const onChange = vi.fn();
  const screen = await render(
    <TextViewer src={new Blob(['loaded'])} value="controlled" onChange={onChange} />,
  );
  await expect.poll(() => textarea()?.value).toBe('controlled');
  await userEvent.fill(textarea()!, 'typed');
  expect(onChange).toHaveBeenLastCalledWith('typed');
  await screen.rerender(<TextViewer src={new Blob(['loaded'])} value="from parent" onChange={onChange} />);
  await expect.poll(() => textarea()!.value).toBe('from parent');
  await screen.rerender(<TextViewer src={new Blob(['loaded'])} readOnly />);
  await expect.poll(() => textarea()!.readOnly).toBe(true);
});

test('unsupported shows the name, size and Download only when it can download', async () => {
  const onDownload = vi.fn();
  const screen = await render(
    <UnsupportedViewer fileName="archive.bin" size={2048} onDownload={onDownload} />,
  );
  const root = document.querySelector<HTMLElement>('[data-fs-part=viewer-unsupported]')!;
  expect(root.textContent).toContain('archive.bin');
  expect(root.textContent).toContain('No preview for this file type.');
  expect(document.querySelector('[data-fs-part=viewer-unsupported-size]')!.textContent).toBe(
    new Intl.NumberFormat(undefined, {
      style: 'unit',
      unit: 'kilobyte',
      unitDisplay: 'short',
      maximumFractionDigits: 1,
    }).format(2.048),
  );
  await userEvent.click(document.querySelector('button')!);
  expect(onDownload).toHaveBeenCalledTimes(1);
  await expectNoAxeViolations(root);

  await screen.rerender(<UnsupportedViewer fileName="archive.bin" />);
  expect(document.querySelector('button')).toBeNull();
  expect(document.querySelector('[data-fs-part=viewer-unsupported-size]')).toBeNull();
});

test('the unsupported renderer offers the viewer download', async () => {
  const memory = createMemoryAdapter({ files: { 'blob.bin': 'xyz' } });
  const download = vi.fn(() => Promise.resolve(new Blob(['xyz'])));
  await mountRegistryViewer({ ...memory, download }, 'blob.bin');
  await expect.poll(() => document.querySelector('[data-fs-part=viewer-unsupported]')).not.toBeNull();
  await userEvent.click(document.querySelector('button')!);
  await expect.poll(() => download.mock.calls.length).toBe(1);
});

test('axe: text editor and large-file line view, light and dark', async () => {
  const TextRenderer = (await textRenderer.load()).default;
  const props = { version: 1, mode: undefined, isActive: true, readOnly: false, onError: () => {} };
  const screen = await render(
    <div style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
      <TextRenderer {...props} entry={fileEntry('a.txt', 3)} source={{ kind: 'text', text: 'abc' }} />
    </div>,
  );
  await expectNoAxeViolations(document.querySelector('[data-fs-part=text-viewer]')!);
  await screen.rerender(
    <div style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
      <TextRenderer
        {...props}
        entry={fileEntry('big.log', 2 * MIB)}
        source={{ kind: 'text', text: numberedLines(1000) }}
      />
    </div>,
  );
  await expect.poll(lineView).not.toBeNull();
  await expectNoAxeViolations(document.querySelector('[data-fs-part=text-viewer]')!);
});
