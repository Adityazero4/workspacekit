import { FsError, statusOf, type Entry, type FileSystemAdapter } from '@workspacekit/core';
import { createMemoryAdapter, type MemoryAdapter } from '@workspacekit/core/memory';
import { Profiler, StrictMode, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { followMove } from '../src/actions/followMove';
import { FileSystemProvider } from '../src/provider/FileSystemProvider';
import { useFileSystem, useTreeSnapshot, useUiValue, type FileSystemContext } from '../src/provider/hooks';
import { internalsOf } from '../src/provider/internals';
import { FileTabs } from '../src/tabs/FileTabs';
import { openTab, type TabsState } from '../src/tabs/tabs-store';
import { defineRenderer, MATCH_SCORE, type Renderer } from '../src/viewer/registry';
import { SourceLoader } from '../src/viewer/sources';
import { useFileViewer, type FileViewerState, type UseFileViewerOptions } from '../src/viewer/useFileViewer';

const loadNothing: Renderer['load'] = () => Promise.resolve({ default: () => null });
const byExtension = (extension: string) => (file: { extension: string }) =>
  file.extension === extension && MATCH_SCORE.specific;

const textRenderer = defineRenderer({
  id: 'text',
  match: byExtension('txt'),
  load: loadNothing,
  input: 'text',
});
const smallTextRenderer = defineRenderer({ ...textRenderer, id: 'small-text', maxBytes: 10 });
const imageRenderer = defineRenderer({
  id: 'image',
  match: byExtension('png'),
  load: loadNothing,
  input: 'url',
});
const markdownRenderer = defineRenderer({
  id: 'markdown',
  match: byExtension('md'),
  load: loadNothing,
  input: 'text',
  modes: [
    { value: 'preview', label: 'Preview' },
    { value: 'source', label: 'Source' },
  ],
});
const RENDERERS: readonly Renderer[] = [textRenderer, imageRenderer, markdownRenderer];

interface HeldRead {
  path: string;
  signal: AbortSignal | undefined;
  release: () => void;
  fail: (error: unknown) => void;
}

function holdingReads(memory: MemoryAdapter): { adapter: FileSystemAdapter; reads: HeldRead[] } {
  const reads: HeldRead[] = [];
  const read = ((path: string, as: 'text', options?: { signal?: AbortSignal }) =>
    new Promise<string>((resolve, reject) => {
      reads.push({
        path,
        signal: options?.signal,
        release: () => void memory.read(path, as).then(resolve, reject),
        fail: reject,
      });
    })) as FileSystemAdapter['read'];
  return { adapter: { ...memory, read }, reads };
}

interface ViewerProbe {
  states: FileViewerState[];
  latest: () => FileViewerState;
  fs: () => FileSystemContext;
}

function newProbe(): ViewerProbe & { context: { fs?: FileSystemContext; renderedVersion?: number } } {
  const states: FileViewerState[] = [];
  const context: { fs?: FileSystemContext; renderedVersion?: number } = {};
  return { states, latest: () => states.at(-1)!, fs: () => context.fs!, context };
}

let objectUrlOnScreen: string | undefined;

function ScreenUrl(props: { url: string | undefined }): null {
  useLayoutEffect(() => {
    objectUrlOnScreen = props.url;
    return () => void (objectUrlOnScreen = undefined);
  });
  return null;
}

function Viewer(props: {
  path: string;
  options: UseFileViewerOptions;
  onState: (state: FileViewerState) => void;
}) {
  const state = useFileViewer(props.path, props.options);
  useEffect(() => void props.onState(state));
  return <ScreenUrl url={state.source?.kind === 'url' ? state.source.url : undefined} />;
}

function ActiveTabViewer(props: {
  options: UseFileViewerOptions;
  onState: (state: FileViewerState) => void;
}) {
  const { tabs } = useFileSystem();
  const { active } = useUiValue(tabs);
  return active === null ? null : <Viewer path={active} {...props} />;
}

function CaptureContext(props: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => void props.onContext(fs));
  return null;
}

function RenderedSnapshot(props: { onVersion: (version: number) => void }): null {
  const { version } = useTreeSnapshot();
  useEffect(() => void props.onVersion(version));
  return null;
}

function providerWith(adapter: FileSystemAdapter, probe: ReturnType<typeof newProbe>, children: ReactNode) {
  return (
    <FileSystemProvider adapter={adapter}>
      {children}
      <CaptureContext onContext={(fs) => (probe.context.fs = fs)} />
      <RenderedSnapshot onVersion={(version) => (probe.context.renderedVersion = version)} />
    </FileSystemProvider>
  );
}

async function reactHasRenderedTheLatestSnapshot(probe: ReturnType<typeof newProbe>): Promise<void> {
  await expect.poll(() => probe.context.renderedVersion).toBe(probe.fs().store.getSnapshot().version);
}

async function mountViewer(
  adapter: FileSystemAdapter,
  path: string,
  options: UseFileViewerOptions = { renderers: RENDERERS },
) {
  const probe = newProbe();
  const view = (nextPath: string, nextOptions: UseFileViewerOptions) =>
    providerWith(
      adapter,
      probe,
      <Viewer path={nextPath} options={nextOptions} onState={(state) => probe.states.push(state)} />,
    );
  const screen = await render(view(path, options));
  await expect
    .poll(() => probe.context.fs && statusOf(probe.fs().store.getSnapshot().tree, ''))
    .toBe('loaded');
  return {
    ...probe,
    probe,
    show: (nextPath: string, nextOptions: UseFileViewerOptions = options) =>
      screen.rerender(view(nextPath, nextOptions)),
    unmount: () => screen.unmount(),
  };
}

const textOf = (state: FileViewerState): string | undefined =>
  state.source?.kind === 'text' ? state.source.text : undefined;
const urlOf = (state: FileViewerState): string | undefined =>
  state.source?.kind === 'url' ? state.source.url : undefined;

function spyOnObjectUrls() {
  const created: string[] = [];
  const revoked: string[] = [];
  const revokedWhileOnScreen: string[] = [];
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = createObjectURL(blob);
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revoked.push(url);
    if (url === objectUrlOnScreen) revokedWhileOnScreen.push(url);
    revokeObjectURL(url);
  });
  return { created, revoked, revokedWhileOnScreen };
}

function captureClickedLinks(): HTMLAnchorElement[] {
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
  return clicked;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('a file over maxBytes is never read and offers download', async () => {
  const memory = createMemoryAdapter({ files: { 'big.txt': 'x'.repeat(100) } });
  const read = vi.spyOn(memory, 'read');
  const clicked = captureClickedLinks();
  const viewer = await mountViewer(memory, 'big.txt', { renderers: [smallTextRenderer] });
  await expect.poll(() => viewer.latest().error?.kind).toBe('too_large');
  expect(viewer.latest()).toMatchObject({ status: 'error', source: undefined });
  expect(read).not.toHaveBeenCalled();
  viewer.latest().download!();
  await expect.poll(() => clicked.length).toBe(1);
  expect(clicked[0]!.download).toBe('big.txt');
  await viewer.unmount();

  const withUrlOnly: FileSystemAdapter = {
    ...memory,
    download: undefined,
    url: (entry) => `https://files.example/${entry.path}`,
  };
  const urlViewer = await mountViewer(withUrlOnly, 'big.txt', { renderers: [smallTextRenderer] });
  await expect.poll(() => urlViewer.latest().error?.kind).toBe('too_large');
  urlViewer.latest().download!();
  expect(clicked[1]!.href).toBe('https://files.example/big.txt');
  expect(clicked[1]!.download).toBe('big.txt');
  await urlViewer.unmount();

  const neither = await mountViewer({ ...memory, download: undefined }, 'big.txt', {
    renderers: [smallTextRenderer],
  });
  await expect.poll(() => neither.latest().error?.kind).toBe('too_large');
  expect(neither.latest().download).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

test('url input uses adapter.url and never reads', async () => {
  const memory = createMemoryAdapter({ files: { 'a.png': 'png' } });
  const read = vi.spyOn(memory, 'read');
  const objectUrls = spyOnObjectUrls();
  const viewer = await mountViewer(
    { ...memory, url: (entry) => ({ url: `https://files.example/${entry.path}`, withCredentials: true }) },
    'a.png',
  );
  await expect.poll(() => viewer.latest().status).toBe('ready');
  expect(viewer.latest().source).toEqual({
    kind: 'url',
    url: 'https://files.example/a.png',
    withCredentials: true,
  });
  await viewer.unmount();

  const plain = await mountViewer({ ...memory, url: (entry) => `/files/${entry.path}` }, 'a.png');
  await expect.poll(() => plain.latest().status).toBe('ready');
  expect(plain.latest().source).toEqual({ kind: 'url', url: '/files/a.png', withCredentials: false });
  expect(read).not.toHaveBeenCalled();
  expect(objectUrls.created).toEqual([]);
});

test('url input falls back to a revoked-on-change object URL', async () => {
  const memory = createMemoryAdapter({ files: { 'a.png': 'one' } });
  const objectUrls = spyOnObjectUrls();
  const viewer = await mountViewer(memory, 'a.png');
  await expect.poll(() => urlOf(viewer.latest())).toBeDefined();
  const first = urlOf(viewer.latest())!;
  expect(objectUrls.created).toEqual([first]);
  expect(await (await fetch(first)).text()).toBe('one');

  await memory.write!('a.png', 'two');
  await expect.poll(() => urlOf(viewer.latest())).not.toBe(first);
  const second = urlOf(viewer.latest())!;
  expect(await (await fetch(second)).text()).toBe('two');
  await expect.poll(() => objectUrls.revoked).toEqual([first]);

  await viewer.unmount();
  expect(objectUrls.revoked).toEqual([first, second]);
  expect(objectUrls.revokedWhileOnScreen).toEqual([]);
});

test('switching files aborts the previous read and revokes its object URL', async () => {
  const { adapter, reads } = holdingReads(
    createMemoryAdapter({ files: { 'a.png': 'a', 'b.png': 'b', 'c.png': 'c' } }),
  );
  const objectUrls = spyOnObjectUrls();
  const viewer = await mountViewer(adapter, 'a.png');
  await expect.poll(() => reads.length).toBe(1);
  reads[0]!.release();
  await expect.poll(() => urlOf(viewer.latest())).toBeDefined();
  const first = urlOf(viewer.latest())!;

  await viewer.show('b.png');
  await expect.poll(() => reads.length).toBe(2);
  expect(viewer.latest()).toMatchObject({ path: 'b.png', status: 'loading', source: undefined });
  await expect.poll(() => objectUrls.revoked).toEqual([first]);

  await viewer.show('c.png');
  await expect.poll(() => reads.length).toBe(3);
  expect(reads[1]!.signal!.aborted).toBe(true);
  expect(reads[2]!.signal!.aborted).toBe(false);
  reads[1]!.release();
  reads[2]!.release();
  await expect.poll(() => urlOf(viewer.latest())).toBeDefined();
  const third = urlOf(viewer.latest())!;
  expect(await (await fetch(third)).text()).toBe('c');
  expect(objectUrls.created).toEqual([first, third]);

  await viewer.unmount();
  expect(objectUrls.revoked).toEqual([first, third]);
  expect(objectUrls.revokedWhileOnScreen).toEqual([]);
});

test('a new version keeps the old source on screen until the new one is ready', async () => {
  const memory = createMemoryAdapter({ files: { 'notes.txt': 'v1' } });
  const { adapter, reads } = holdingReads(memory);
  const viewer = await mountViewer(adapter, 'notes.txt');
  await expect.poll(() => reads.length).toBe(1);
  reads[0]!.release();
  await expect.poll(() => textOf(viewer.latest())).toBe('v1');
  const firstVersion = viewer.latest().version;
  expect(firstVersion).toBe(viewer.latest().entry!.mtimeMs);

  const written = await memory.write!('notes.txt', 'v2');
  await expect.poll(() => reads.length).toBe(2);
  await expect.poll(() => viewer.latest().refreshing).toBe(true);
  expect(viewer.latest()).toMatchObject({ status: 'ready', version: firstVersion });
  expect(textOf(viewer.latest())).toBe('v1');

  reads[1]!.release();
  await expect.poll(() => textOf(viewer.latest())).toBe('v2');
  expect(viewer.latest()).toMatchObject({ version: written.mtimeMs, refreshing: false, status: 'ready' });
  const shown = viewer.states.filter((state) => state.source !== undefined);
  expect(shown.every((state) => (textOf(state) === 'v2') === (state.version === written.mtimeMs))).toBe(true);
  expect(viewer.states.slice(viewer.states.indexOf(shown[0]!)).every((state) => state.source)).toBe(true);
});

test('a failed refresh keeps the old source and reports the error', async () => {
  const memory = createMemoryAdapter({ files: { 'notes.txt': 'v1' } });
  const { adapter, reads } = holdingReads(memory);
  const viewer = await mountViewer(adapter, 'notes.txt');
  await expect.poll(() => reads.length).toBe(1);
  reads[0]!.release();
  await expect.poll(() => textOf(viewer.latest())).toBe('v1');

  await memory.write!('notes.txt', 'v2');
  await expect.poll(() => reads.length).toBe(2);
  const failure = new FsError('network', 'the server is restarting');
  reads[1]!.fail(failure);
  await expect.poll(() => viewer.latest().error?.kind).toBe('load_error');
  expect(viewer.latest()).toMatchObject({ status: 'ready', refreshing: false });
  expect(viewer.latest().error!.cause).toBe(failure);
  expect(textOf(viewer.latest())).toBe('v1');

  viewer.latest().retry();
  await expect.poll(() => reads.length).toBe(3);
  reads[2]!.release();
  await expect.poll(() => textOf(viewer.latest())).toBe('v2');
  expect(viewer.latest().error).toBeUndefined();
});

test('an inactive viewer does not refresh until it becomes active', async () => {
  const memory = createMemoryAdapter({ files: { 'notes.txt': 'v1' } });
  const { adapter, reads } = holdingReads(memory);
  const viewer = await mountViewer(adapter, 'notes.txt');
  await expect.poll(() => reads.length).toBe(1);
  reads[0]!.release();
  await expect.poll(() => textOf(viewer.latest())).toBe('v1');

  await viewer.show('notes.txt', { renderers: RENDERERS, isActive: false });
  const second = await memory.write!('notes.txt', 'v2');
  await expect.poll(() => viewer.latest().entry?.mtimeMs).toBe(second.mtimeMs);
  const third = await memory.write!('notes.txt', 'v3');
  await expect.poll(() => viewer.latest().entry?.mtimeMs).toBe(third.mtimeMs);
  expect(reads).toHaveLength(1);
  expect(viewer.latest()).toMatchObject({ refreshing: false, status: 'ready' });

  await viewer.show('notes.txt', { renderers: RENDERERS, isActive: true });
  await expect.poll(() => reads.length).toBe(2);
  reads[1]!.release();
  await expect.poll(() => textOf(viewer.latest())).toBe('v3');
  expect(viewer.latest().version).toBe(third.mtimeMs);
  expect(reads).toHaveLength(2);
});

test('a moved file keeps its content on screen while it reloads', async () => {
  const memory = createMemoryAdapter({ files: { 'a.png': 'one', 'archive/old.png': 'old' } });
  const { adapter, reads } = holdingReads(memory);
  const objectUrls = spyOnObjectUrls();
  const probe = newProbe();
  await render(
    providerWith(
      adapter,
      probe,
      <ActiveTabViewer options={{ renderers: RENDERERS }} onState={(state) => probe.states.push(state)} />,
    ),
  );
  await expect
    .poll(() => probe.context.fs && statusOf(probe.fs().store.getSnapshot().tree, 'archive'))
    .toBe('loaded');
  probe.fs().tabs.set((state) => openTab(state, 'a.png', 'pin'));
  await expect.poll(() => reads.length).toBe(1);
  reads[0]!.release();
  await expect.poll(() => urlOf(probe.latest())).toBeDefined();
  const firstSource = probe.latest().source;
  const firstRendered = probe.states.indexOf(probe.latest());

  await followMove(probe.fs(), 'a.png', 'archive/a.png', () => probe.fs().store.move('a.png', 'archive'));
  await expect.poll(() => probe.latest().path).toBe('archive/a.png');
  expect(probe.latest()).toMatchObject({ status: 'ready', refreshing: false });
  expect(probe.latest().source).toBe(firstSource);
  expect(reads).toHaveLength(1);
  expect(objectUrls.created).toHaveLength(1);
  expect(objectUrls.revoked).toEqual([]);

  await memory.move!('archive/a.png', 'b.png');
  await memory.write!('b.png', 'two');
  await expect.poll(() => reads.length).toBe(2);
  expect(reads[1]!.path).toBe('b.png');
  await expect.poll(() => probe.latest()).toMatchObject({ path: 'b.png', refreshing: true });
  expect(probe.latest().source).toBe(firstSource);
  reads[1]!.release();
  await expect.poll(() => probe.latest().source).not.toBe(firstSource);
  expect(await (await fetch(urlOf(probe.latest())!)).text()).toBe('two');
  await expect.poll(() => objectUrls.revoked).toEqual([(firstSource as { url: string }).url]);
  expect(objectUrls.revokedWhileOnScreen).toEqual([]);
  expect(probe.states.slice(firstRendered).every((state) => state.source !== undefined)).toBe(true);
  expect(probe.states.slice(firstRendered).every((state) => state.error === undefined)).toBe(true);
});

test('deleted while open → deleted; never existed → not_found', async () => {
  const memory = createMemoryAdapter({ files: { 'a.txt': 'a' } });
  const viewer = await mountViewer(memory, 'a.txt');
  await expect.poll(() => textOf(viewer.latest())).toBe('a');
  await memory.delete!('a.txt');
  await expect.poll(() => viewer.latest().error?.kind).toBe('deleted');
  expect(viewer.latest()).toMatchObject({ status: 'error', source: undefined, entry: undefined });

  await viewer.show('never.txt');
  await expect.poll(() => viewer.latest().error?.kind).toBe('not_found');
  expect(viewer.latest()).toMatchObject({ path: 'never.txt', status: 'error' });
});

test('reads the entry with stat when its folder is not loaded, or loads the folder without stat', async () => {
  const files = { 'deep/x/y/z.txt': 'deep' };
  const memory = createMemoryAdapter({ files });
  const stat = vi.spyOn(memory, 'stat');
  const viewer = await mountViewer(memory, 'deep/x/y/z.txt');
  await expect.poll(() => textOf(viewer.latest())).toBe('deep');
  expect(stat).toHaveBeenCalledTimes(1);
  await expect.poll(() => statusOf(viewer.fs().store.getSnapshot().tree, 'deep/x/y')).toBe('loaded');
  expect(stat).toHaveBeenCalledTimes(1);

  await viewer.show('deep/x/y/missing.txt');
  await expect.poll(() => viewer.latest().error?.kind).toBe('not_found');
  await viewer.unmount();

  const withoutStat = await mountViewer(
    { ...createMemoryAdapter({ files }), stat: undefined },
    'deep/x/y/z.txt',
  );
  await expect.poll(() => textOf(withoutStat.latest())).toBe('deep');
  expect(statusOf(withoutStat.fs().store.getSnapshot().tree, 'deep/x/y')).toBe('loaded');
});

test('re-renders only when its own entry or its folder changes', async () => {
  const memory = createMemoryAdapter({ files: { 'docs/a.txt': 'a', 'docs/b.txt': 'b', 'other/c.txt': 'c' } });
  const probe = newProbe();
  let viewerCommits = 0;
  let renderedSnapshotVersion = -1;
  function SnapshotWitness(): null {
    const { version } = useTreeSnapshot();
    useEffect(() => void (renderedSnapshotVersion = version));
    return null;
  }
  await render(
    providerWith(
      memory,
      probe,
      <>
        <Profiler id="viewer" onRender={() => void viewerCommits++}>
          <Viewer
            path="docs/a.txt"
            options={{ renderers: RENDERERS }}
            onState={(state) => probe.states.push(state)}
          />
        </Profiler>
        <SnapshotWitness />
      </>,
    ),
  );
  await expect.poll(() => probe.states.at(-1) && textOf(probe.latest())).toBe('a');
  const commitsWhenReady = viewerCommits;

  memory.emit([
    { type: 'created', path: 'other/new.txt', actor: 'agent' },
    { type: 'updated', path: 'docs/b.txt', actor: 'agent' },
  ]);
  await memory.write!('other/c.txt', 'changed');
  await memory.create!('docs/sibling.txt', 'file');
  const version = probe.fs().store.getSnapshot().version;
  await expect.poll(() => renderedSnapshotVersion).toBe(version);
  expect(viewerCommits).toBe(commitsWhenReady);

  await memory.write!('docs/a.txt', 'a2');
  await expect.poll(() => textOf(probe.latest())).toBe('a2');
  expect(viewerCommits).toBeGreaterThan(commitsWhenReady);
});

test('controlled and uncontrolled view modes', async () => {
  const memory = createMemoryAdapter({ files: { 'a.md': '# a', 'b.md': '# b', 'c.txt': 'c' } });
  const onModeChange = vi.fn();
  const viewer = await mountViewer(memory, 'a.md', { renderers: RENDERERS, onModeChange });
  await expect.poll(() => viewer.latest().status).toBe('ready');
  expect(viewer.latest().mode).toBe('preview');
  expect(viewer.latest().modes).toEqual(markdownRenderer.modes);

  viewer.latest().setMode('source');
  await expect.poll(() => viewer.latest().mode).toBe('source');
  expect(onModeChange).toHaveBeenLastCalledWith('source');

  await viewer.show('b.md');
  await expect.poll(() => viewer.latest().path).toBe('b.md');
  expect(viewer.latest().mode).toBe('preview');
  await viewer.show('a.md');
  await expect.poll(() => viewer.latest().path).toBe('a.md');
  expect(viewer.latest().mode).toBe('source');

  await viewer.show('b.md', { renderers: RENDERERS, defaultMode: 'source' });
  await expect.poll(() => viewer.latest().path).toBe('b.md');
  expect(viewer.latest().mode).toBe('source');

  await viewer.show('c.txt');
  await expect.poll(() => viewer.latest().path).toBe('c.txt');
  expect(viewer.latest()).toMatchObject({ mode: undefined, modes: [] });

  const controlledChange = vi.fn();
  await viewer.show('b.md', { renderers: RENDERERS, mode: 'preview', onModeChange: controlledChange });
  await expect.poll(() => viewer.latest().path).toBe('b.md');
  viewer.latest().setMode('source');
  expect(controlledChange).toHaveBeenCalledWith('source');
  await viewer.show('b.md', { renderers: RENDERERS, mode: 'preview', onModeChange: controlledChange });
  expect(viewer.latest().mode).toBe('preview');
  await viewer.show('b.md', { renderers: RENDERERS, mode: 'source', onModeChange: controlledChange });
  await expect.poll(() => viewer.latest().mode).toBe('source');
  await viewer.show('b.md', { renderers: RENDERERS });
  await expect.poll(() => viewer.latest().mode).toBe('preview');
});

test('a folder that fails to list is asked for once', async () => {
  const memory = createMemoryAdapter({ files: { 'a/b/c/bad/f.txt': 'f' }, latencyMs: 30 });
  let badListings = 0;
  const adapter: FileSystemAdapter = {
    ...memory,
    stat: undefined,
    list: (path, options) => {
      if (path !== 'a/b/c/bad') return memory.list(path, options);
      badListings++;
      return memory.list(path, options).then(() => Promise.reject(new FsError('network', 'down')));
    },
  };
  const viewer = await mountViewer(adapter, 'a/b/c/bad/f.txt');
  await expect.poll(() => viewer.latest().error?.kind).toBe('load_error');
  await reactHasRenderedTheLatestSnapshot(viewer.probe);
  expect(badListings).toBe(1);
  expect(viewer.latest()).toMatchObject({ status: 'error', error: { kind: 'load_error' } });

  viewer.latest().retry();
  await expect.poll(() => badListings).toBe(2);
});

function ControlledTabsViewer(props: { onState: (state: FileViewerState) => void }) {
  const [tabs, setTabs] = useState<TabsState>({
    tabs: [{ path: 'a.png', preview: false, dirty: false }],
    active: 'a.png',
  });
  return (
    <>
      <FileTabs tabs={tabs} onTabsChange={setTabs} />
      {tabs.active && (
        <Viewer path={tabs.active} options={{ renderers: RENDERERS }} onState={props.onState} />
      )}
    </>
  );
}

test('a host that remaps its tabs only after the move commits sees no blank frame and no extra read', async () => {
  const { adapter, reads } = holdingReads(
    createMemoryAdapter({ files: { 'a.png': 'one', 'archive/old.png': 'old' } }),
  );
  const probe = newProbe();
  await render(
    providerWith(adapter, probe, <ControlledTabsViewer onState={(state) => probe.states.push(state)} />),
  );
  await expect.poll(() => reads.length).toBe(1);
  reads[0]!.release();
  await expect.poll(() => urlOf(probe.latest())).toBeDefined();
  await expect.poll(() => statusOf(probe.fs().store.getSnapshot().tree, 'archive')).toBe('loaded');
  const firstSource = probe.latest().source;
  const firstRendered = probe.states.indexOf(probe.latest());

  await followMove(probe.fs(), 'a.png', 'archive/a.png', () => probe.fs().store.move('a.png', 'archive'));
  await expect.poll(() => probe.latest().path).toBe('archive/a.png');
  await reactHasRenderedTheLatestSnapshot(probe);
  expect(probe.latest().source).toBe(firstSource);
  expect(reads).toHaveLength(1);
  const sinceReady = probe.states.slice(firstRendered);
  expect(sinceReady.every((state) => state.source === firstSource && state.error === undefined)).toBe(true);
});

test('a file moved into an unlisted folder and then deleted ends deleted', async () => {
  const memory = createMemoryAdapter({ files: { 'a.png': 'one', 'deep/x/y/k.txt': 'k' } });
  const probe = newProbe();
  await render(
    providerWith(
      memory,
      probe,
      <ActiveTabViewer options={{ renderers: RENDERERS }} onState={(state) => probe.states.push(state)} />,
    ),
  );
  await expect
    .poll(() => probe.context.fs && statusOf(probe.fs().store.getSnapshot().tree, ''))
    .toBe('loaded');
  probe.fs().tabs.set((state) => openTab(state, 'a.png', 'pin'));
  await expect.poll(() => urlOf(probe.latest())).toBeDefined();
  expect(statusOf(probe.fs().store.getSnapshot().tree, 'deep/x')).toBe('idle');

  await memory.move!('a.png', 'deep/x/a.png');
  await memory.delete!('deep/x/a.png');
  await expect.poll(() => probe.latest().error?.kind).toBe('deleted');
  expect(probe.latest()).toMatchObject({ path: 'deep/x/a.png', status: 'error', source: undefined });
});

test('a failed followMove puts the view back where it was', async () => {
  const { adapter, reads } = holdingReads(createMemoryAdapter({ files: { 'a.png': 'one' } }));
  const probe = newProbe();
  await render(
    providerWith(
      adapter,
      probe,
      <ActiveTabViewer options={{ renderers: RENDERERS }} onState={(state) => probe.states.push(state)} />,
    ),
  );
  await expect
    .poll(() => probe.context.fs && statusOf(probe.fs().store.getSnapshot().tree, ''))
    .toBe('loaded');
  probe.fs().tabs.set((state) => openTab(state, 'a.png', 'pin'));
  await expect.poll(() => reads.length).toBe(1);
  reads[0]!.release();
  await expect.poll(() => urlOf(probe.latest())).toBeDefined();
  const firstSource = probe.latest().source;
  const firstRendered = probe.states.indexOf(probe.latest());

  let refuseMove: (error: unknown) => void = () => undefined;
  const moving = followMove(
    probe.fs(),
    'a.png',
    'b.png',
    () => new Promise((_, reject) => (refuseMove = reject)),
  );
  await expect.poll(() => probe.latest().path).toBe('b.png');
  refuseMove(new FsError('conflict', 'b.png is taken'));
  await expect(moving).rejects.toThrow('taken');
  await expect.poll(() => probe.latest().path).toBe('a.png');
  expect(probe.latest()).toMatchObject({ status: 'ready', error: undefined, source: firstSource });
  expect(reads).toHaveLength(1);
  const sinceReady = probe.states.slice(firstRendered);
  expect(sinceReady.every((state) => state.source === firstSource && state.error === undefined)).toBe(true);
});

test('url input is size-gated only for the blob fallback, by blob size when the entry has none', async () => {
  const cappedImage = defineRenderer({ ...imageRenderer, id: 'capped-image', maxBytes: 3 });
  const memory = createMemoryAdapter({ files: { 'big.png': 'eight by' } });
  const read = vi.spyOn(memory, 'read');
  const objectUrls = spyOnObjectUrls();

  const streamed = await mountViewer({ ...memory, url: (entry) => `/files/${entry.path}` }, 'big.png', {
    renderers: [cappedImage],
  });
  await expect.poll(() => streamed.latest().status).toBe('ready');
  expect(urlOf(streamed.latest())).toBe('/files/big.png');
  await streamed.unmount();

  const fallback = await mountViewer(memory, 'big.png', { renderers: [cappedImage] });
  await expect.poll(() => fallback.latest().error?.kind).toBe('too_large');
  expect(read).not.toHaveBeenCalled();
  await fallback.unmount();

  const withoutSize = (entry: Entry): Entry => ({ ...entry, size: null });
  const sizeless: FileSystemAdapter = {
    ...memory,
    list: (path, options) => memory.list(path, options).then((entries) => entries.map(withoutSize)),
    stat: (path, options) => memory.stat!(path, options).then((entry) => entry && withoutSize(entry)),
  };
  const unknownSize = await mountViewer(sizeless, 'big.png', { renderers: [cappedImage] });
  await expect.poll(() => unknownSize.latest().error?.kind).toBe('too_large');
  expect(unknownSize.latest()).toMatchObject({ status: 'error', source: undefined });
  expect(read).toHaveBeenCalledTimes(1);
  expect(objectUrls.created).toEqual([]);
});

test('unmounting aborts the read in flight', async () => {
  const { adapter, reads } = holdingReads(createMemoryAdapter({ files: { 'notes.txt': 'v1' } }));
  const viewer = await mountViewer(adapter, 'notes.txt');
  await expect.poll(() => reads.length).toBe(1);
  expect(reads[0]!.signal!.aborted).toBe(false);
  await viewer.unmount();
  expect(reads[0]!.signal!.aborted).toBe(true);
});

test('a new version aborts the read in flight', async () => {
  const memory = createMemoryAdapter({ files: { 'notes.txt': 'v1' } });
  const { adapter, reads } = holdingReads(memory);
  const viewer = await mountViewer(adapter, 'notes.txt');
  await expect.poll(() => reads.length).toBe(1);
  await memory.write!('notes.txt', 'v2');
  await expect.poll(() => reads.length).toBe(2);
  expect(reads[0]!.signal!.aborted).toBe(true);
  expect(reads[1]!.signal!.aborted).toBe(false);
  reads[0]!.release();
  reads[1]!.release();
  await expect.poll(() => textOf(viewer.latest())).toBe('v2');
});

test('under StrictMode every object URL is revoked', async () => {
  const memory = createMemoryAdapter({ files: { 'a.png': 'one' } });
  const objectUrls = spyOnObjectUrls();
  const probe = newProbe();
  const screen = await render(
    <StrictMode>
      {providerWith(
        memory,
        probe,
        <Viewer
          path="a.png"
          options={{ renderers: RENDERERS }}
          onState={(state) => probe.states.push(state)}
        />,
      )}
    </StrictMode>,
  );
  await expect.poll(() => urlOf(probe.states.at(-1) ?? ({} as FileViewerState))).toBeDefined();
  const first = urlOf(probe.latest())!;
  await memory.write!('a.png', 'two');
  await expect.poll(() => urlOf(probe.latest())).not.toBe(first);
  expect(await (await fetch(urlOf(probe.latest())!)).text()).toBe('two');
  await screen.unmount();
  expect(objectUrls.created.length).toBeGreaterThan(0);
  expect([...objectUrls.revoked].sort()).toEqual([...objectUrls.created].sort());
  expect(objectUrls.revokedWhileOnScreen).toEqual([]);
});

test('adapter URLs that are not http, https or blob are refused, and the file is read instead', async () => {
  const memory = createMemoryAdapter({ files: { 'a.png': 'one' } });
  const read = vi.spyOn(memory, 'read');
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
    const viewer = await mountViewer({ ...memory, url: () => unsafe }, 'a.png');
    await expect.poll(() => viewer.latest().status).toBe('ready');
    expect(urlOf(viewer.latest())).toMatch(/^blob:/);
    expect(viewer.states.some((state) => urlOf(state) === unsafe)).toBe(false);
    await viewer.unmount();
  }
  expect(read).toHaveBeenCalledTimes(2);
});

test('object URLs never carry a type a browser would render as a page', async () => {
  const pageRenderer = defineRenderer({
    id: 'page',
    match: byExtension('html'),
    load: loadNothing,
    input: 'url',
  });
  const memory = createMemoryAdapter({ files: { 'page.html': '<script>1</script>', 'a.png': 'png' } });
  const typed: FileSystemAdapter = {
    ...memory,
    read: ((path: string) =>
      Promise.resolve(
        new Blob(['x'], { type: path.endsWith('.html') ? 'text/html' : 'image/png' }),
      )) as unknown as FileSystemAdapter['read'],
  };
  const typesTurnedIntoUrls: string[] = [];
  const createObjectURL = URL.createObjectURL.bind(URL);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    typesTurnedIntoUrls.push((blob as Blob).type);
    return createObjectURL(blob);
  });
  const page = await mountViewer(typed, 'page.html', { renderers: [pageRenderer] });
  await expect.poll(() => page.latest().status).toBe('ready');
  await page.show('a.png', { renderers: RENDERERS });
  await expect.poll(() => page.latest().path === 'a.png' && page.latest().status).toBe('ready');
  expect(typesTurnedIntoUrls).toEqual(['application/octet-stream', 'image/png']);
});

test('a dirty text source reloads once its buffer turns clean', async () => {
  const memory = createMemoryAdapter({ files: { 'notes.txt': 'v1' } });
  const read = vi.spyOn(memory, 'read');
  const viewer = await mountViewer(memory, 'notes.txt');
  await expect.poll(() => textOf(viewer.latest())).toBe('v1');
  const { editBuffers } = internalsOf(viewer.fs());
  editBuffers.edit('notes.txt', 'v1 edited', viewer.latest().version);
  const written = await memory.write!('notes.txt', 'v2');
  await expect.poll(() => viewer.latest().entry?.mtimeMs).toBe(written.mtimeMs);
  expect(read).toHaveBeenCalledTimes(1);
  expect(textOf(viewer.latest())).toBe('v1');

  editBuffers.discard('notes.txt');
  await expect.poll(() => textOf(viewer.latest())).toBe('v2');
});

test('a move onto the same path changes nothing', () => {
  const loader = new SourceLoader();
  const entry: Entry = { path: 'a.txt', name: 'a.txt', kind: 'file' };
  const adapter = createMemoryAdapter();
  loader.sync('a.txt', { adapter, entry, input: 'none', paused: false, maxBytes: undefined });
  const before = loader.getSnapshot();
  let notified = 0;
  loader.subscribe(() => void notified++);
  loader.followMove('a.txt', 'a.txt');
  expect(notified).toBe(0);
  expect(loader.getSnapshot()).toBe(before);
});

test('a new version of a file in a folder that was not loaded reaches the viewer', async () => {
  const memory = createMemoryAdapter({ files: { 'deep/x/y/z.txt': 'v1' } });
  const viewer = await mountViewer(memory, 'deep/x/y/z.txt');
  await expect.poll(() => textOf(viewer.latest())).toBe('v1');
  await expect.poll(() => statusOf(viewer.fs().store.getSnapshot().tree, 'deep/x/y')).toBe('loaded');

  const written = await memory.write!('deep/x/y/z.txt', 'v2');
  await expect.poll(() => textOf(viewer.latest())).toBe('v2');
  expect(viewer.latest().version).toBe(written.mtimeMs);
});

test('a folder listing that fails after stat keeps the stat answer and is not asked again', async () => {
  const memory = createMemoryAdapter({ files: { 'deep/x/y/z.txt': 'deep' }, latencyMs: 30 });
  let folderListings = 0;
  const adapter: FileSystemAdapter = {
    ...memory,
    list: (path, options) => {
      if (path !== 'deep/x/y') return memory.list(path, options);
      folderListings++;
      return memory.list(path, options).then(() => Promise.reject(new FsError('network', 'down')));
    },
  };
  const viewer = await mountViewer(adapter, 'deep/x/y/z.txt');
  await expect.poll(() => textOf(viewer.latest())).toBe('deep');
  await expect.poll(() => statusOf(viewer.fs().store.getSnapshot().tree, 'deep/x/y')).toBe('error');
  await reactHasRenderedTheLatestSnapshot(viewer.probe);
  expect(folderListings).toBe(1);
  expect(viewer.latest()).toMatchObject({ status: 'ready', error: undefined });
  expect(textOf(viewer.latest())).toBe('deep');
});

function statAnsweringWith(
  memory: MemoryAdapter,
  answeredPath: (path: string) => string,
): { adapter: FileSystemAdapter; calls: { stat: number; read: number } } {
  const calls = { stat: 0, read: 0 };
  const adapter: FileSystemAdapter = {
    ...memory,
    list: (path, options) =>
      path === 'deep/x/y' ? new Promise(() => undefined) : memory.list(path, options),
    stat: async (path, options) => {
      calls.stat++;
      const entry = await memory.stat!(path, options);
      return entry && { ...entry, path: answeredPath(entry.path) };
    },
    read: ((path: string, as: 'text', options?: { signal?: AbortSignal }) => {
      calls.read++;
      return memory.read(path, as, options);
    }) as FileSystemAdapter['read'],
  };
  return { adapter, calls };
}

test('a stat answer in another form of the path is read once and shown', async () => {
  const memory = createMemoryAdapter({ files: { 'deep/x/y/a.txt': 'hello' } });
  const { adapter, calls } = statAnsweringWith(memory, (path) => `/${path}`);
  const viewer = await mountViewer(adapter, 'deep/x/y/a.txt');
  await expect.poll(() => textOf(viewer.latest())).toBe('hello');
  expect(viewer.latest()).toMatchObject({
    status: 'ready',
    error: undefined,
    entry: { path: 'deep/x/y/a.txt' },
  });
  expect(calls).toEqual({ stat: 1, read: 1 });
});

test('a stat answer for another path is a load_error, never shown and not asked again', async () => {
  const memory = createMemoryAdapter({ files: { 'deep/x/y/a.txt': 'hello' } });
  const { adapter, calls } = statAnsweringWith(memory, () => 'deep/x/y/other.txt');
  const viewer = await mountViewer(adapter, 'deep/x/y/a.txt');
  await expect.poll(() => viewer.latest().error?.kind).toBe('load_error');
  expect(viewer.latest()).toMatchObject({ status: 'error', entry: undefined, source: undefined });
  expect(calls).toEqual({ stat: 1, read: 0 });
});

test('an svg from the blob fallback gets a data URL, never an object URL', async () => {
  const svgRenderer = defineRenderer({
    id: 'svg',
    match: byExtension('svg'),
    load: loadNothing,
    input: 'url',
  });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const memory = createMemoryAdapter({ files: { 'pic.svg': svg } });
  const objectUrls = spyOnObjectUrls();
  const viewer = await mountViewer(memory, 'pic.svg', { renderers: [svgRenderer] });
  await expect.poll(() => viewer.latest().status).toBe('ready');
  expect(urlOf(viewer.latest())).toBe(`data:image/svg+xml;base64,${btoa(svg)}`);
  await viewer.unmount();

  const octetStream: FileSystemAdapter = {
    ...memory,
    read: (() =>
      Promise.resolve(
        new Blob([svg], { type: 'application/octet-stream' }),
      )) as unknown as FileSystemAdapter['read'],
  };
  const typed = await mountViewer(octetStream, 'pic.svg', { renderers: [svgRenderer] });
  await expect.poll(() => typed.latest().status).toBe('ready');
  expect(urlOf(typed.latest())).toMatch(/^data:image\/svg\+xml;base64,/);
  await typed.unmount();
  expect(objectUrls.created).toEqual([]);
  expect(objectUrls.revoked).toEqual([]);
});

test('the size gate applies whenever no adapter URL is streamed, and to reads of unknown size', async () => {
  const cappedImage = defineRenderer({ ...imageRenderer, id: 'capped-image', maxBytes: 3 });
  const memory = createMemoryAdapter({ files: { 'big.png': 'eight by', 'big.txt': 'x'.repeat(100) } });
  const read = vi.spyOn(memory, 'read');
  const noUrlForThisEntry = { ...memory, url: (() => undefined) as unknown as FileSystemAdapter['url'] };
  const unanswered = await mountViewer(noUrlForThisEntry, 'big.png', { renderers: [cappedImage] });
  await expect.poll(() => unanswered.latest().error?.kind).toBe('too_large');
  expect(read).not.toHaveBeenCalled();
  await unanswered.unmount();

  const withoutSize = (entry: Entry): Entry => ({ ...entry, size: undefined });
  const sizeless: FileSystemAdapter = {
    ...memory,
    list: (path, options) => memory.list(path, options).then((entries) => entries.map(withoutSize)),
    stat: (path, options) => memory.stat!(path, options).then((entry) => entry && withoutSize(entry)),
  };
  const unknownSize = await mountViewer(sizeless, 'big.txt', { renderers: [smallTextRenderer] });
  await expect.poll(() => unknownSize.latest().error?.kind).toBe('too_large');
  expect(unknownSize.latest()).toMatchObject({ status: 'error', source: undefined });
  expect(read).toHaveBeenCalledTimes(1);
  await unknownSize.unmount();

  const underReported: FileSystemAdapter = {
    ...memory,
    list: (path, options) =>
      memory.list(path, options).then((entries) => entries.map((entry) => ({ ...entry, size: 1 }))),
    stat: (path, options) => memory.stat!(path, options).then((entry) => entry && { ...entry, size: 1 }),
  };
  const lying = await mountViewer(underReported, 'big.txt', { renderers: [smallTextRenderer] });
  await expect
    .poll(() => lying.latest().error?.kind, { message: 'the bytes read are checked, not the reported size' })
    .toBe('too_large');
});
