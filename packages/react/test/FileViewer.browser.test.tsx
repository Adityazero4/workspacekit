import type { FileSystemAdapter } from '@scope/core';
import { createMemoryAdapter, type MemoryAdapter } from '@scope/core/memory';
import axe from 'axe-core';
import { useEffect } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { FileViewer, type FileViewerProps } from '../src/viewer/FileViewer';
import { lightRenderers } from '../src/viewer/lightRenderers';
import {
  defineRenderer,
  MATCH_SCORE,
  viewerError,
  type Renderer,
  type RendererProps,
} from '../src/viewer/registry';
import { cssTransitionsToSettle } from './support/cssTransitionsToSettle';

type RendererModule = Awaited<ReturnType<Renderer['load']>>;

interface HeldLoad {
  resolve: () => void;
  reject: (error: unknown) => void;
}

function ShowsText(props: RendererProps): React.JSX.Element {
  const { source, mode } = props;
  return (
    <p data-testid="rendered">
      {source.kind === 'text' ? source.text : ''}
      {mode === undefined ? '' : ` in ${mode}`}
    </p>
  );
}

function heldRenderer(
  overrides: Partial<Renderer> = {},
  component: RendererModule['default'] = ShowsText,
): { renderer: Renderer; loads: HeldLoad[] } {
  const loads: HeldLoad[] = [];
  const renderer = defineRenderer({
    id: 'held',
    match: (file) => file.extension === 'txt' && MATCH_SCORE.specific,
    input: 'text',
    load: () =>
      new Promise<RendererModule>((resolve, reject) => {
        loads.push({ resolve: () => resolve({ default: component }), reject });
      }),
    ...overrides,
  });
  return { renderer, loads };
}

const MODES = [
  { value: 'preview', label: 'Preview' },
  { value: 'source', label: 'Source' },
];

const viewerRoot = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-fs-part=viewer]');
const rendered = (): string | null | undefined =>
  document.querySelector('[data-testid=rendered]')?.textContent;
const alertText = (): string | null | undefined => document.querySelector('[role=alert]')?.textContent;
const buttonIn = (container: Element | null, name: string): HTMLButtonElement | undefined =>
  [...(container?.querySelectorAll('button') ?? [])].find((button) => button.textContent === name);

async function mountViewer(
  adapter: FileSystemAdapter,
  props: Partial<FileViewerProps> & Pick<FileViewerProps, 'renderers'>,
): Promise<{ rerender: (next: Partial<FileViewerProps>) => Promise<void> }> {
  const tree = (next: Partial<FileViewerProps>): React.JSX.Element => (
    <FileSystemProvider adapter={adapter}>
      <div style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
        <FileViewer path="a.txt" {...props} {...next} />
      </div>
    </FileSystemProvider>
  );
  const screen = await render(tree({}));
  return { rerender: async (next) => void (await screen.rerender(tree(next))) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('shows a loader while the renderer chunk loads, then the renderer', async () => {
  const { renderer, loads } = heldRenderer();
  await mountViewer(createMemoryAdapter({ files: { 'a.txt': 'hello' } }), { renderers: [renderer] });
  await expect.poll(() => loads.length).toBe(1);
  await expect.element(page.getByRole('status', { name: 'Loading a.txt' })).toBeVisible();
  expect(rendered()).toBeUndefined();

  loads[0]!.resolve();
  await expect.poll(rendered).toBe('hello');
  expect(document.querySelector('[role=status]')).toBeNull();
  expect(viewerRoot()!.hasAttribute('data-status')).toBe(false);
});

test('components.Loader replaces the default loader', async () => {
  const { renderer, loads } = heldRenderer();
  const Loader = (props: { label: string }): React.JSX.Element => (
    <span data-testid="custom">{props.label}</span>
  );
  await mountViewer(createMemoryAdapter({ files: { 'a.txt': 'hello' } }), {
    renderers: [renderer],
    components: { Loader },
  });
  await expect.poll(() => loads.length).toBe(1);
  await expect.element(page.getByRole('status', { name: 'Loading a.txt' })).toBeVisible();
  expect(document.querySelector('[data-testid=custom]')?.textContent).toBe('Loading a.txt');
});

test('a failing chunk shows load_error with Retry, and Retry loads it', async () => {
  const caught = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { renderer, loads } = heldRenderer();
  await mountViewer(createMemoryAdapter({ files: { 'a.txt': 'hello' } }), { renderers: [renderer] });
  await expect.poll(() => loads.length).toBe(1);
  loads[0]!.reject(new TypeError('Failed to fetch dynamically imported module'));

  await expect.poll(alertText).toContain(viewerError('load_error').message);
  expect(caught).toHaveBeenCalled();
  await userEvent.click(buttonIn(document.querySelector('[role=alert]'), 'Retry')!);
  await expect.poll(() => loads.length).toBe(2);
  loads[1]!.resolve();
  await expect.poll(rendered).toBe('hello');
  expect(document.querySelector('[role=alert]')).toBeNull();
});

function ThrowsOnBoom(props: RendererProps): React.JSX.Element {
  if (props.source.kind === 'text' && props.source.text === 'boom') throw new Error('renderer crashed');
  return <ShowsText {...props} />;
}

test('a renderer that throws is contained; a new version resets the boundary', async () => {
  const caught = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const adapter = createMemoryAdapter({ files: { 'a.txt': 'boom' } });
  const { renderer, loads } = heldRenderer({}, ThrowsOnBoom);
  await mountViewer(adapter, { renderers: [renderer] });
  await expect.poll(() => loads.length).toBe(1);
  loads[0]!.resolve();

  await expect.poll(alertText).toContain(viewerError('load_error').message);
  expect(caught).toHaveBeenCalled();
  expect(document.querySelector('[data-fs-part=viewer-name]')?.textContent, 'the shell survives').toBe(
    'a.txt',
  );

  await adapter.write!('a.txt', 'fixed');
  await expect.poll(rendered).toBe('fixed');
  expect(document.querySelector('[role=alert]')).toBeNull();
});

test('a renderer reports an error through onError', async () => {
  const onErrorCalls: Array<() => void> = [];
  const ReportsUnsupported = (props: RendererProps): null => {
    const { onError } = props;
    onErrorCalls.push(() => onError(viewerError('unsupported_media')));
    return null;
  };
  const { renderer, loads } = heldRenderer({}, ReportsUnsupported);
  await mountViewer(createMemoryAdapter({ files: { 'a.txt': 'x' } }), { renderers: [renderer] });
  await expect.poll(() => loads.length).toBe(1);
  loads[0]!.resolve();
  await expect.poll(() => onErrorCalls.length).toBeGreaterThan(0);
  onErrorCalls[0]!();
  await expect.poll(alertText).toContain(viewerError('unsupported_media').message);
});

test('mode toggle switches modes and announces the pressed state', async () => {
  const { renderer, loads } = heldRenderer({ modes: MODES });
  const memory = createMemoryAdapter({ files: { 'a.txt': 'hello' } });
  await mountViewer(memory, { renderers: [renderer] });
  await expect.poll(() => loads.length).toBe(1);
  loads[0]!.resolve();
  await expect.poll(rendered).toBe('hello in preview');

  const group = page.getByRole('group', { name: 'View mode' });
  await expect
    .element(group.getByRole('button', { name: 'Preview' }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect
    .element(group.getByRole('button', { name: 'Source' }))
    .toHaveAttribute('aria-pressed', 'false');
  expect(viewerRoot()!.getAttribute('data-mode')).toBe('preview');

  await group.getByRole('button', { name: 'Source' }).click();
  await expect.poll(rendered).toBe('hello in source');
  await expect.element(group.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true');
  await expect
    .element(group.getByRole('button', { name: 'Preview' }))
    .toHaveAttribute('aria-pressed', 'false');
  expect(viewerRoot()!.getAttribute('data-mode')).toBe('source');
});

test('without more than one mode there is no mode toggle', async () => {
  const { renderer, loads } = heldRenderer({ modes: MODES.slice(0, 1) });
  await mountViewer(createMemoryAdapter({ files: { 'a.txt': 'hello' } }), { renderers: [renderer] });
  await expect.poll(() => loads.length).toBe(1);
  loads[0]!.resolve();
  await expect.poll(rendered).toBe('hello in preview');
  expect(document.querySelector('[role=group]')).toBeNull();
});

test('too_large and not_found views offer Download when possible', async () => {
  const memory = createMemoryAdapter({ files: { 'a.txt': 'far too long' } });
  const download = vi.fn(() => Promise.resolve(new Blob(['far too long'])));
  const { renderer } = heldRenderer({ maxBytes: 4 });
  const viewer = await mountViewer({ ...memory, download }, { renderers: [renderer] });

  await expect.poll(alertText).toContain(viewerError('too_large').message);
  expect(viewerRoot()!.getAttribute('data-status')).toBe('error');
  await userEvent.click(buttonIn(document.querySelector('[role=alert]'), 'Download')!);
  await expect.poll(() => download.mock.calls.length).toBe(1);

  await viewer.rerender({ path: 'missing.txt' });
  await expect.poll(alertText).toContain(viewerError('not_found').message);
  expect(buttonIn(document.querySelector('[role=alert]'), 'Download'), 'nothing to download').toBeUndefined();
  expect(buttonIn(document.querySelector('[data-fs-part=viewer-header]'), 'Download')).toBeUndefined();
});

test('the header shows the name and Download; showHeader and renderHeader replace it', async () => {
  const memory = createMemoryAdapter({ files: { 'a.txt': 'hello' } });
  const download = vi.fn(() => Promise.resolve(new Blob(['hello'])));
  const { renderer, loads } = heldRenderer();
  const viewer = await mountViewer({ ...memory, download }, { renderers: [renderer] });
  await expect.poll(() => loads.length).toBe(1);
  loads[0]!.resolve();
  await expect.poll(rendered).toBe('hello');
  const header = (): Element | null => document.querySelector('[data-fs-part=viewer-header]');
  expect(header()?.querySelector('[data-fs-part=viewer-name]')?.textContent).toBe('a.txt');
  await userEvent.click(buttonIn(header(), 'Download')!);
  await expect.poll(() => download.mock.calls.length).toBe(1);

  await viewer.rerender({ showHeader: false });
  expect(header()).toBeNull();
  await viewer.rerender({ renderHeader: (state) => <h2>{`${state.path} is ${state.status}`}</h2> });
  expect(header()).toBeNull();
  expect(document.querySelector('h2')?.textContent).toBe('a.txt is ready');
});

test('a source read failure shows load_error, and Retry reads again', async () => {
  const memory = createMemoryAdapter({ files: { 'a.txt': 'hello' } });
  let failNextRead = true;
  const read = ((path: string, as: 'text') => {
    if (!failNextRead) return memory.read(path, as);
    failNextRead = false;
    return Promise.reject(new Error('network down'));
  }) as FileSystemAdapter['read'];
  const { renderer, loads } = heldRenderer();
  await mountViewer({ ...memory, read }, { renderers: [renderer] });
  await expect.poll(alertText).toContain(viewerError('load_error').message);
  await userEvent.click(buttonIn(document.querySelector('[role=alert]'), 'Retry')!);
  await expect.poll(() => loads.length).toBe(1);
  loads[0]!.resolve();
  await expect.poll(rendered).toBe('hello');
});

async function expectNoAxeViolations(state: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await commands.emulateMedia({ colorScheme });
    await cssTransitionsToSettle();
    const results = await axe.run(viewerRoot()!);
    expect(
      results.violations.map((violation) => `${state} ${colorScheme} ${violation.id}: ${violation.help}`),
    ).toEqual([]);
  }
  await commands.emulateMedia({ colorScheme: null });
}

test('axe: no violations in each viewer state, light and dark', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const memory = createMemoryAdapter({ files: { 'a.txt': 'hello', 'big.txt': 'far too long' } });
  const download = vi.fn(() => Promise.resolve(new Blob([''])));
  const { renderer, loads } = heldRenderer({ modes: MODES });
  const small = defineRenderer({
    ...renderer,
    id: 'small',
    match: (file) => file.basename === 'big.txt' && MATCH_SCORE.directory,
    maxBytes: 4,
  });
  const viewer = await mountViewer({ ...memory, download }, { renderers: [renderer, small] });

  await expect.poll(() => loads.length).toBe(1);
  await expectNoAxeViolations('loading');
  loads[0]!.reject(new Error('chunk failed'));
  await expect.poll(alertText).toContain(viewerError('load_error').message);
  await expectNoAxeViolations('load_error');
  await userEvent.click(buttonIn(document.querySelector('[role=alert]'), 'Retry')!);
  await expect.poll(() => loads.length).toBe(2);
  loads[1]!.resolve();
  await expect.poll(rendered).toBe('hello in preview');
  await expectNoAxeViolations('ready');

  await viewer.rerender({ path: 'big.txt' });
  await expect.poll(alertText).toContain(viewerError('too_large').message);
  await expectNoAxeViolations('too_large');
  await viewer.rerender({ path: 'missing.txt' });
  await expect.poll(alertText).toContain(viewerError('not_found').message);
  await expectNoAxeViolations('not_found');
  await viewer.rerender({ path: 'a.txt' });
  await expect.poll(rendered).toBe('hello in preview');
  await memory.delete!('a.txt');
  await expect.poll(alertText).toContain(viewerError('deleted').message);
  expect(document.querySelector('[role=alert] button'), 'deleted shows the copy only').toBeNull();
  await expectNoAxeViolations('deleted');
});

const viewerBody = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-fs-part=viewer-body]');

test('a new version also retries a chunk that failed to load', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const adapter = createMemoryAdapter({ files: { 'a.txt': 'hello' } });
  const { renderer, loads } = heldRenderer();
  await mountViewer(adapter, { renderers: [renderer] });
  await expect.poll(() => loads.length).toBe(1);
  loads[0]!.reject(new Error('chunk failed'));
  await expect.poll(alertText).toContain(viewerError('load_error').message);

  await adapter.write!('a.txt', 'newer');
  await expect.poll(() => loads.length).toBe(2);
  loads[1]!.resolve();
  await expect.poll(rendered).toBe('newer');
});

test('a load() that throws, or resolves without a default export, fails until Retry loads again', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const outcomes: Array<'throw' | 'no default' | 'ok'> = ['throw', 'no default', 'ok'];
  let calls = 0;
  const renderer = defineRenderer({
    id: 'flaky',
    match: (file) => file.extension === 'txt' && MATCH_SCORE.specific,
    input: 'text',
    load: () => {
      const outcome = outcomes[calls++];
      if (outcome === 'throw') throw new Error('load threw');
      if (outcome === 'no default') return Promise.resolve({} as RendererModule);
      return Promise.resolve({ default: ShowsText });
    },
  });
  await mountViewer(createMemoryAdapter({ files: { 'a.txt': 'hello' } }), { renderers: [renderer] });
  for (let failure = 0; failure < 2; failure++) {
    await expect.poll(alertText).toContain(viewerError('load_error').message);
    await userEvent.click(buttonIn(document.querySelector('[role=alert]'), 'Retry')!);
  }
  await expect.poll(rendered).toBe('hello');
  expect(calls).toBe(3);
});

test('Retry moves focus to the viewer body', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { renderer, loads } = heldRenderer();
  await mountViewer(createMemoryAdapter({ files: { 'a.txt': 'hello' } }), { renderers: [renderer] });
  await expect.poll(() => loads.length).toBe(1);
  loads[0]!.reject(new Error('chunk failed'));
  await expect.poll(alertText).toContain(viewerError('load_error').message);
  expect(viewerBody()!.tabIndex, 'an error view is a tab stop').toBe(0);
  await userEvent.click(buttonIn(document.querySelector('[role=alert]'), 'Retry')!);
  await expect.poll(() => document.activeElement).toBe(viewerBody());
  await expect.poll(() => loads.length).toBe(2);
  loads[1]!.resolve();
  await expect.poll(rendered).toBe('hello');
  expect(viewerBody()!.tabIndex).toBe(-1);
});

async function pngBytes(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((png) => resolve(png!), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

async function uploadPng(memory: MemoryAdapter): Promise<void> {
  const png = new Blob([(await pngBytes()) as Uint8Array<ArrayBuffer>]);
  await memory.upload!.direct('a.png', png, { signal: new AbortController().signal, overwrite: true });
}

const shownImage = (): HTMLImageElement | null =>
  document.querySelector<HTMLImageElement>('[data-fs-part=image-content]');
const banner = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-fs-part=viewer-banner]');

async function mountImage(
  adapt: (memory: MemoryAdapter) => FileSystemAdapter = (memory) => memory,
  bytes?: Uint8Array,
): Promise<MemoryAdapter> {
  const memory = createMemoryAdapter({ files: { 'a.png': bytes ?? (await pngBytes()) } });
  await render(
    <FileSystemProvider adapter={adapt(memory)}>
      <div style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
        <FileViewer path="a.png" renderers={lightRenderers} />
      </div>
    </FileSystemProvider>,
  );
  return memory;
}

test('a failed refresh keeps the image visible and shows the banner', async () => {
  let readsFail = false;
  const memory = await mountImage((memory) => ({
    ...memory,
    read: ((path: string, as: 'blob') =>
      readsFail
        ? Promise.reject(new Error('network down'))
        : memory.read(path, as)) as FileSystemAdapter['read'],
  }));
  await expect.poll(shownImage).not.toBeNull();
  readsFail = true;
  await uploadPng(memory);
  await expect.poll(() => banner()?.textContent).toContain(viewerError('load_error').message);
  expect(banner()!.getAttribute('role')).toBe('alert');
  expect(shownImage(), 'the previous version stays').not.toBeNull();
  expect(document.querySelector('[data-fs-part=viewer-error]')).toBeNull();

  readsFail = false;
  await userEvent.click(buttonIn(banner(), 'Retry')!);
  await expect.poll(banner).toBeNull();
  expect(document.activeElement, 'Retry moves focus to the viewer body').toBe(viewerBody());
});

test('a newer version loading is aria-busy and marked pending on the viewer body', async () => {
  let holdReads = false;
  let releaseRead = (): void => undefined;
  const memory = await mountImage((memory) => ({
    ...memory,
    read: ((path: string, as: 'blob') => {
      if (!holdReads) return memory.read(path, as);
      return new Promise<Blob>((resolve) => (releaseRead = () => resolve(memory.read(path, as))));
    }) as FileSystemAdapter['read'],
  }));
  await expect.poll(shownImage).not.toBeNull();
  expect(viewerBody()!.hasAttribute('aria-busy')).toBe(false);
  holdReads = true;
  await uploadPng(memory);
  await expect.poll(() => viewerBody()!.getAttribute('aria-busy')).toBe('true');
  expect(viewerBody()!.hasAttribute('data-pending')).toBe(true);
  expect(shownImage(), 'the previous version stays').not.toBeNull();
  releaseRead();
  await expect.poll(() => viewerBody()!.hasAttribute('aria-busy')).toBe(false);
  expect(viewerBody()!.hasAttribute('data-pending')).toBe(false);
});

test('a version the renderer cannot show, after one it showed, is a banner over the image', async () => {
  const memory = await mountImage();
  await expect.poll(shownImage).not.toBeNull();
  await memory.write!('a.png', 'not an image');
  await expect.poll(() => banner()?.textContent).toContain(viewerError('load_error').message);
  expect(shownImage()).not.toBeNull();
  expect(document.querySelector('[data-fs-part=viewer-error]')).toBeNull();

  await uploadPng(memory);
  await expect.poll(banner).toBeNull();
});

test('a failure before the first render shows the full error view', async () => {
  await mountImage(undefined, new TextEncoder().encode('not an image'));
  await expect
    .poll(() => document.querySelector('[data-fs-part=viewer-error]')?.textContent)
    .toContain(viewerError('load_error').message);
  expect(banner()).toBeNull();
  expect(shownImage()).toBeNull();
});

test('an error for the first version a renderer shows is the full error view, even after an update while it loaded', async () => {
  const ReportsOnMount = (props: RendererProps): null => {
    const { onError } = props;
    useEffect(() => onError(viewerError('unsupported_media')), [onError]);
    return null;
  };
  const memory = createMemoryAdapter({ files: { 'a.txt': 'v1' } });
  const textsRead: string[] = [];
  const read = (async (path: string, as: 'text') => {
    const text = await memory.read(path, as);
    textsRead.push(text);
    return text;
  }) as FileSystemAdapter['read'];
  const { renderer, loads } = heldRenderer({}, ReportsOnMount);
  await mountViewer({ ...memory, read }, { renderers: [renderer] });
  await expect.poll(() => loads.length).toBe(1);
  await memory.write!('a.txt', 'v2');
  await expect.poll(() => textsRead).toEqual(['v1', 'v2']);
  loads[0]!.resolve();
  await expect
    .poll(() => document.querySelector('[data-fs-part=viewer-error]')?.textContent)
    .toContain(viewerError('unsupported_media').message);
  expect(banner()).toBeNull();
});
