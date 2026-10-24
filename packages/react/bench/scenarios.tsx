import { joinPath, type ChangeEvent, type FileSystemAdapter } from '@workspacekit/core';
import { createMemoryAdapter, type MemoryAdapter } from '@workspacekit/core/memory';
import { generateShape, type TreeShape } from '../../core/src/memory/generate';
import { createRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import { VirtualPages } from '../src/renderers/pages/VirtualPages';
import { TiffViewer } from '../src/renderers/tiff/TiffViewer';
import type { Renderer } from '../src/viewer/registry';
import type { WorkspaceController } from '../src/workspace/useWorkspace';
import { Workspace } from '../src/workspace/Workspace';
import { tiffBytes } from '../test/fixtures/tiff';

export interface MountedWorkspace {
  container: HTMLElement;
  firstRenderMs: number;
  unmount: () => void;
}

export interface FrameStats {
  frames: number;
  longestFrameMs: number;
  shareOfFramesOver25Ms: number;
  longAnimationFrames: number;
  longTasks: number;
}

export const MEDIAN_RUNS = 5;
export const WARM_UP_RUNS = 1;
export const SCROLLED_VIEWPORTS = 50;
export const BURST_SIZE = 5000;
export const BURST_SETTLE_MS = 3000;
export const MOVE_ROUND_TRIP_MS = 50;
const WAIT_LIMIT_MS = 60_000;
const SLOW_FRAME_MS = 25;
const QUIET_FRAMES_BEFORE_THE_NEXT_RUN = 10;
const ROW = '[role=treeitem]';

export function createBenchAdapter(
  shape: TreeShape,
  size: number,
): { adapter: MemoryAdapter; paths: string[] } {
  const files = generateShape(shape, size);
  return { adapter: createMemoryAdapter({ files }), paths: Object.keys(files) };
}

export const agentUpdatesUnder = (paths: string[], folder: string): ChangeEvent[] =>
  paths
    .filter((path) => path.startsWith(`${folder}/`))
    .slice(0, BURST_SIZE)
    .map((path) => ({ type: 'updated', path, actor: 'agent' }));

export function answeringMovesAfter(adapter: MemoryAdapter, latencyMs: number): MemoryAdapter {
  return {
    ...adapter,
    move: async (from, to, options) => {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      return adapter.move!(from, to, options);
    },
  };
}

export const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

export async function samplesOf<Sample>(run: (attempt: number) => Promise<Sample>): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let attempt = 0; attempt < WARM_UP_RUNS + MEDIAN_RUNS; attempt++) {
    collectGarbage();
    const sample = await run(attempt);
    if (attempt >= WARM_UP_RUNS) samples.push(sample);
    await mainThreadQuiet();
  }
  return samples;
}

export const medianOf = async (run: (attempt: number) => Promise<number>): Promise<number> =>
  median(await samplesOf(run));

export const medianOfFrameStats = (samples: FrameStats[]): FrameStats => ({
  frames: median(samples.map((stats) => stats.frames)),
  longestFrameMs: median(samples.map((stats) => stats.longestFrameMs)),
  shareOfFramesOver25Ms: median(samples.map((stats) => stats.shareOfFramesOver25Ms)),
  longAnimationFrames: median(samples.map((stats) => stats.longAnimationFrames)),
  longTasks: median(samples.map((stats) => stats.longTasks)),
});

export const medianFrameStats = async (run: () => Promise<FrameStats>): Promise<FrameStats> =>
  medianOfFrameStats(await samplesOf(run));

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

const afterNextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

export async function mainThreadQuiet(): Promise<void> {
  let quietFrames = 0;
  let previous = await nextFrame();
  const giveUpAt = previous + WAIT_LIMIT_MS;
  while (quietFrames < QUIET_FRAMES_BEFORE_THE_NEXT_RUN && previous < giveUpAt) {
    const timestamp = await nextFrame();
    quietFrames = timestamp - previous < SLOW_FRAME_MS ? quietFrames + 1 : 0;
    previous = timestamp;
  }
}

function waitUntil(container: HTMLElement, condition: () => boolean): Promise<void> {
  if (condition()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (!condition()) return;
      cleanUp();
      resolve();
    });
    const timer = setTimeout(() => {
      cleanUp();
      reject(new Error(`the condition did not hold within ${WAIT_LIMIT_MS} ms`));
    }, WAIT_LIMIT_MS);
    const cleanUp = (): void => {
      observer.disconnect();
      clearTimeout(timer);
    };
    observer.observe(container, { childList: true, subtree: true, attributes: true, characterData: true });
  });
}

async function millisecondsUntilPainted(
  container: HTMLElement,
  start: () => void,
  condition: () => boolean,
): Promise<number> {
  const startedAt = performance.now();
  start();
  await waitUntil(container, condition);
  await afterNextPaint();
  return performance.now() - startedAt;
}

export async function mountWorkspace(
  adapter: MemoryAdapter,
  options: { fetchDepth?: number } = {},
): Promise<MountedWorkspace> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const firstRenderMs = await millisecondsUntilPainted(
    container,
    () =>
      root.render(
        <Workspace adapter={adapter} fetchDepth={options.fetchDepth} style={{ width: 900, height: 600 }} />,
      ),
    () => container.querySelector(ROW) !== null,
  );
  return {
    container,
    firstRenderMs,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

const labelOf = (row: Element): string | null | undefined =>
  row.querySelector('[data-fs-part=tree-row-label]')?.textContent;

function rowNamed(container: HTMLElement, name: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(ROW)].find((row) => labelOf(row) === name);
}

function requireRow(container: HTMLElement, name: string): HTMLElement {
  const row = rowNamed(container, name);
  if (!row) throw new Error(`no row named "${name}" is rendered`);
  return row;
}

const levelOf = (row: Element | null | undefined): number => Number(row?.getAttribute('aria-level') ?? 0);
const showsChildren = (folderRow: HTMLElement): boolean =>
  folderRow.getAttribute('aria-expanded') === 'true' &&
  levelOf(folderRow.nextElementSibling) === levelOf(folderRow) + 1;
const showsNoChildren = (folderRow: HTMLElement): boolean =>
  folderRow.getAttribute('aria-expanded') === 'false' &&
  levelOf(folderRow.nextElementSibling) <= levelOf(folderRow);

export function firstChildName(mounted: MountedWorkspace, folder: string): string {
  const folderRow = requireRow(mounted.container, folder);
  if (!showsChildren(folderRow)) throw new Error(`"${folder}" shows no children`);
  return labelOf(folderRow.nextElementSibling!)!;
}

export function expandFolder(mounted: MountedWorkspace, name: string): Promise<number> {
  const folderRow = requireRow(mounted.container, name);
  return millisecondsUntilPainted(
    mounted.container,
    () => folderRow.click(),
    () => showsChildren(folderRow),
  );
}

export function collapseFolder(mounted: MountedWorkspace, name: string): Promise<number> {
  const folderRow = requireRow(mounted.container, name);
  return millisecondsUntilPainted(
    mounted.container,
    () => folderRow.click(),
    () => showsNoChildren(folderRow),
  );
}

export async function expandAndCollapseSamples(
  workspace: MountedWorkspace,
  folder: string,
): Promise<{ expands: number[]; collapses: number[] }> {
  const pairs = await samplesOf(async () => {
    const expandMs = await expandFolder(workspace, folder);
    await mainThreadQuiet();
    return { expandMs, collapseMs: await collapseFolder(workspace, folder) };
  });
  return { expands: pairs.map((pair) => pair.expandMs), collapses: pairs.map((pair) => pair.collapseMs) };
}

export async function expandAndCollapseMedians(
  workspace: MountedWorkspace,
  folder: string,
): Promise<{ expandMs: number; collapseMs: number }> {
  const { expands, collapses } = await expandAndCollapseSamples(workspace, folder);
  return { expandMs: median(expands), collapseMs: median(collapses) };
}

export function expandThatFetchesSamples(adapter: MemoryAdapter, folder: string): Promise<number[]> {
  return samplesOf(async () => {
    const workspace = await mountWorkspace(adapter, { fetchDepth: 1 });
    try {
      return await expandFolder(workspace, folder);
    } finally {
      workspace.unmount();
    }
  });
}

export const expandThatFetchesMedian = async (adapter: MemoryAdapter, folder: string): Promise<number> =>
  median(await expandThatFetchesSamples(adapter, folder));

const pressKey = (target: Element, key: string): boolean =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

function typeInto(input: HTMLInputElement, text: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export async function renameEntry(mounted: MountedWorkspace, name: string, newName: string): Promise<number> {
  const { container } = mounted;
  const row = requireRow(container, name);
  row.focus();
  await afterNextPaint();
  pressKey(row, 'F2');
  const findInput = (): HTMLInputElement | null =>
    container.querySelector<HTMLInputElement>('[data-fs-part=tree-rename-input]');
  await waitUntil(container, () => findInput() !== null);
  typeInto(findInput()!, newName);
  const renameMs = await millisecondsUntilPainted(
    container,
    () => pressKey(findInput()!, 'Enter'),
    () => rowNamed(container, newName) !== undefined,
  );
  await waitUntil(container, () => rowNamed(container, newName)?.hasAttribute('data-pending') === false);
  return renameMs;
}

function fireDrag(target: Element, type: string, dataTransfer: DataTransfer): void {
  const event = new DragEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(event);
}

const isUnder = (row: HTMLElement | undefined, folderRow: HTMLElement): boolean =>
  row !== undefined && levelOf(row) === levelOf(folderRow) + 1;

export async function dragFirstChildToTheRootAndBack(
  mounted: MountedWorkspace,
  adapter: MemoryAdapter,
  folder: string,
): Promise<number> {
  const { container } = mounted;
  const name = firstChildName(mounted, folder);
  const row = requireRow(container, name);
  const folderRow = requireRow(container, folder);
  const viewport = container.querySelector('[data-fs-part=tree-viewport]')!;
  const dataTransfer = new DataTransfer();
  fireDrag(row, 'dragstart', dataTransfer);
  fireDrag(viewport, 'dragenter', dataTransfer);
  fireDrag(viewport, 'dragover', dataTransfer);
  const dragMs = await millisecondsUntilPainted(
    container,
    () => {
      fireDrag(viewport, 'drop', dataTransfer);
      fireDrag(row, 'dragend', dataTransfer);
    },
    () => !isUnder(rowNamed(container, name), folderRow),
  );
  while ((await adapter.stat!(name)) === null) await nextFrame();
  await adapter.move!(name, joinPath(folder, name));
  await waitUntil(container, () => isUnder(rowNamed(container, name), folderRow));
  return dragMs;
}

export async function searchFor(mounted: MountedWorkspace, query: string): Promise<number> {
  const { container } = mounted;
  const input = container.querySelector<HTMLInputElement>('[data-fs-part=search-input]')!;
  const firstResult = (): Element | null => container.querySelector('[role=option]');
  input.focus();
  await afterNextPaint();
  const searchMs = await millisecondsUntilPainted(
    container,
    () => typeInto(input, query),
    () => firstResult() !== null,
  );
  typeInto(input, '');
  await waitUntil(container, () => firstResult() === null);
  input.blur();
  return searchMs;
}

const LONG_FRAME_ENTRY_TYPES = ['long-animation-frame', 'longtask'] as const;

function observeLongFrames(): () => Pick<FrameStats, 'longAnimationFrames' | 'longTasks'> {
  const counts = { 'long-animation-frame': 0, longtask: 0 };
  const supported = LONG_FRAME_ENTRY_TYPES.filter((type) =>
    PerformanceObserver.supportedEntryTypes.includes(type),
  );
  const count = (entries: PerformanceEntryList): void => {
    for (const entry of entries) counts[entry.entryType as keyof typeof counts]++;
  };
  const observers = supported.map((type) => {
    const observer = new PerformanceObserver((list) => count(list.getEntries()));
    observer.observe({ type });
    return observer;
  });
  return () => {
    for (const observer of observers) {
      count(observer.takeRecords());
      observer.disconnect();
    }
    return { longAnimationFrames: counts['long-animation-frame'], longTasks: counts.longtask };
  };
}

export async function framesDuring(work: () => Promise<unknown>): Promise<FrameStats> {
  const stopObservingLongFrames = observeLongFrames();
  const timestamps: number[] = [];
  let recording = true;
  const record = (timestamp: number): void => {
    timestamps.push(timestamp);
    if (recording) requestAnimationFrame(record);
  };
  requestAnimationFrame(record);
  await nextFrame();
  await work();
  recording = false;
  await afterNextPaint();
  const durations = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]!);
  return {
    frames: durations.length,
    longestFrameMs: Math.max(0, ...durations),
    shareOfFramesOver25Ms: durations.filter((duration) => duration > SLOW_FRAME_MS).length / durations.length,
    ...stopObservingLongFrames(),
  };
}

const treeViewportOf = (mounted: MountedWorkspace): HTMLElement =>
  mounted.container.querySelector<HTMLElement>('[data-fs-part=tree-viewport]')!;
const renderedRowNames = (mounted: MountedWorkspace): string =>
  [...mounted.container.querySelectorAll(ROW)].map(labelOf).join('/');

export function viewportsThatFit(mounted: MountedWorkspace, wanted: number): number {
  const viewport = treeViewportOf(mounted);
  return Math.min(
    wanted,
    Math.floor((viewport.scrollHeight - viewport.clientHeight) / viewport.clientHeight),
  );
}

export async function scrollViewports(mounted: MountedWorkspace, viewports: number): Promise<FrameStats> {
  const viewport = treeViewportOf(mounted);
  const distance = viewports * viewport.clientHeight;
  const rowsAtTheTop = renderedRowNames(mounted);
  let scrolledTo = 0;
  let rowsAtTheEnd = rowsAtTheTop;
  const stats = await framesDuring(async () => {
    for (let step = 0; step < viewports; step++) {
      viewport.scrollTop += viewport.clientHeight;
      await nextFrame();
    }
    scrolledTo = viewport.scrollTop;
    await afterNextPaint();
    rowsAtTheEnd = renderedRowNames(mounted);
    viewport.scrollTop = 0;
  });
  if (scrolledTo < distance) {
    throw new Error(
      `scrolled to ${scrolledTo} px of ${distance}; the tree is too short for ${viewports} viewports`,
    );
  }
  if (viewports > 0 && rowsAtTheEnd === rowsAtTheTop) throw new Error('scrolling rendered no new rows');
  return stats;
}

export function framesWhileSettling(settleMs: number, action: () => void): Promise<FrameStats> {
  return framesDuring(async () => {
    action();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  });
}

export function collectGarbage(): void {
  const { gc } = globalThis as { gc?: () => void };
  if (!gc) throw new Error('gc() is not exposed; launch Chromium with --js-flags=--expose-gc');
  gc();
}

export function usedHeapMb(): number {
  collectGarbage();
  const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  if (!memory) throw new Error('performance.memory is unavailable; run Chromium');
  return memory.usedJSHeapSize / 2 ** 20;
}

export const PAGE_COUNT = 500;
export const PAGES_OVERSCAN = 1;
export const TIFF_HEAP_CHECKPOINT_PAGE = 50;
export const MIXED_FILES_OPENED = 20;
const SCROLLED_PAGE_SIZE = { width: 600, height: 300 };
const TIFF_PAGE = { width: 120, height: 90 };
const VIEWER_STYLE = { width: 900, height: 600, display: 'flex', flexDirection: 'column' } as const;
const LARGE_TEXT_PATH = 'large.txt';
const MEBIBYTE = 1024 * 1024;
const PAGE = '[data-fs-part=pages-page]';

interface MountedElement {
  container: HTMLElement;
  unmount: () => void;
}

function mountElement(element: ReactNode): MountedElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  root.render(<div style={VIEWER_STYLE}>{element}</div>);
  return {
    container,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

async function framesUntil(condition: () => boolean, what: string): Promise<void> {
  const giveUpAt = performance.now() + WAIT_LIMIT_MS;
  while (!condition()) {
    if (performance.now() > giveUpAt) throw new Error(`${what} did not happen within ${WAIT_LIMIT_MS} ms`);
    await nextFrame();
  }
}

const isOnScreen = (element: Element, viewport: DOMRect): boolean => {
  const rect = element.getBoundingClientRect();
  return rect.bottom > viewport.top && rect.top < viewport.bottom;
};

function pagesOnScreen(viewport: HTMLElement): { mounted: Element[]; visible: Element[] } {
  const mounted = [...viewport.querySelectorAll(PAGE)];
  const viewportRect = viewport.getBoundingClientRect();
  return { mounted, visible: mounted.filter((page) => isOnScreen(page, viewportRect)) };
}

const isScrolledToTheEnd = (viewport: HTMLElement): boolean =>
  viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1;

async function scrollViewportToTheEnd(
  viewport: HTMLElement,
  afterEachStep: () => Promise<void>,
): Promise<void> {
  const steps = Math.ceil(viewport.scrollHeight / viewport.clientHeight) + 1;
  for (let step = 0; !isScrolledToTheEnd(viewport); step++) {
    if (step > steps) {
      throw new Error(`scrolling stopped at ${viewport.scrollTop} px of ${viewport.scrollHeight}`);
    }
    viewport.scrollTop += viewport.clientHeight;
    await afterEachStep();
  }
}

export interface PagesScroll {
  frames: FrameStats;
  mostPagesMountedBeyondTheVisible: number;
}

export async function scrollPagesEndToEnd(
  viewer: ReactNode,
  isPageShown: (page: Element) => boolean = () => true,
): Promise<PagesScroll> {
  const mounted = mountElement(viewer);
  try {
    await waitUntil(mounted.container, () => mounted.container.querySelector(PAGE) !== null);
    const viewport = mounted.container.querySelector<HTMLElement>('[data-fs-part=pages-viewport]')!;
    let mostPagesMountedBeyondTheVisible = 0;
    const frames = await framesDuring(() =>
      scrollViewportToTheEnd(viewport, async () => {
        await nextFrame();
        await framesUntil(() => {
          const { visible } = pagesOnScreen(viewport);
          return visible.length > 0 && visible.every(isPageShown);
        }, 'drawing the visible pages');
        const { mounted: pages, visible } = pagesOnScreen(viewport);
        mostPagesMountedBeyondTheVisible = Math.max(
          mostPagesMountedBeyondTheVisible,
          pages.length - visible.length,
        );
      }),
    );
    return { frames, mostPagesMountedBeyondTheVisible };
  } finally {
    mounted.unmount();
  }
}

export const scrollVirtualPagesEndToEnd = (): Promise<PagesScroll> =>
  scrollPagesEndToEnd(
    <VirtualPages
      pageCount={PAGE_COUNT}
      estimatePageSize={() => SCROLLED_PAGE_SIZE}
      renderPage={({ index }) => <p>Page {index + 1}</p>}
      overscan={PAGES_OVERSCAN}
      aria-label={`${PAGE_COUNT} pages`}
    />,
  );

export async function settledHeapMb(): Promise<number> {
  await mainThreadQuiet();
  collectGarbage();
  return usedHeapMb();
}

const pageNumberIn = (container: HTMLElement, indicatorPart: string): number =>
  Number(
    /^\D*(\d+)/.exec(container.querySelector(`[data-fs-part=${indicatorPart}]`)?.textContent ?? '')?.[1] ?? 0,
  );

const isTiffPageShown = (page: Element): boolean => {
  const image = page.querySelector('img');
  if (image) return image.complete && image.naturalWidth > 0;
  return page.querySelector('[data-fs-part=tiff-page-message]') !== null;
};

export const manyPageTiff = (): ArrayBuffer => tiffBytes(Array.from({ length: PAGE_COUNT }, () => TIFF_PAGE));

export interface PagedViewer {
  element: ReactNode;
  checkpointPage: number;
  isPageShown: (page: Element) => boolean;
  pageIndicatorPart: string;
  lastPageSelector: string;
}

export interface HeapWhileScrolling {
  atTheCheckpointMb: number;
  atTheEndMb: number;
}

export async function heapWhileScrollingPages(viewer: PagedViewer): Promise<HeapWhileScrolling> {
  const mounted = mountElement(viewer.element);
  try {
    await waitUntil(mounted.container, () => mounted.container.querySelector(PAGE) !== null);
    const viewport = mounted.container.querySelector<HTMLElement>('[data-fs-part=pages-viewport]')!;
    const currentPage = (): number => pageNumberIn(mounted.container, viewer.pageIndicatorPart);
    const visiblePagesShown = async (): Promise<void> => {
      await nextFrame();
      await framesUntil(() => {
        const { visible } = pagesOnScreen(viewport);
        return visible.length > 0 && visible.every(viewer.isPageShown);
      }, 'drawing the visible pages');
    };
    await visiblePagesShown();
    let atTheCheckpointMb: number | undefined;
    await scrollViewportToTheEnd(viewport, async () => {
      await visiblePagesShown();
      if (atTheCheckpointMb === undefined && currentPage() >= viewer.checkpointPage) {
        atTheCheckpointMb = await settledHeapMb();
      }
    });
    if (atTheCheckpointMb === undefined || !mounted.container.querySelector(viewer.lastPageSelector)) {
      throw new Error(
        `the scroll stopped at page ${currentPage()} (${viewport.scrollTop} of ${viewport.scrollHeight} px) without the last page`,
      );
    }
    return { atTheCheckpointMb, atTheEndMb: await settledHeapMb() };
  } finally {
    mounted.unmount();
  }
}

export const tiffHeapWhileScrolling = (data: ArrayBuffer): Promise<HeapWhileScrolling> =>
  heapWhileScrollingPages({
    element: <TiffViewer src={data} fileName={`${PAGE_COUNT} pages.tiff`} />,
    checkpointPage: TIFF_HEAP_CHECKPOINT_PAGE,
    isPageShown: isTiffPageShown,
    pageIndicatorPart: 'tiff-page-indicator',
    lastPageSelector: `img[alt^="Page ${PAGE_COUNT} of"]`,
  });

async function pngBytes(): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(64, 48);
  const context = canvas.getContext('2d')!;
  context.fillStyle = 'teal';
  context.fillRect(0, 0, 64, 48);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

function wavBytes(): Uint8Array {
  const samples = 8000;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void =>
    [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, samples, true);
  view.setUint32(28, samples, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return bytes;
}

export async function mixedFiles(): Promise<{
  files: Record<string, string | Uint8Array>;
  opened: string[];
}> {
  const [png, wav] = [await pngBytes(), wavBytes()];
  const tiff = new Uint8Array(tiffBytes([TIFF_PAGE, TIFF_PAGE, TIFF_PAGE]));
  const kinds: Array<[name: string, contents: string | Uint8Array]> = [
    ['notes.txt', 'plain text\n'.repeat(200)],
    ['data.json', JSON.stringify({ values: Array.from({ length: 200 }, (_, index) => index) })],
    ['page.html', '<!doctype html><title>Page</title><p>Hello</p>'],
    [
      'logo.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>',
    ],
    ['photo.png', png],
    ['scan.tiff', tiff],
    ['sound.wav', wav],
    ['clip.mp4', wav],
    ['folder/inside.txt', 'inside'],
    ['blob.bin', new Uint8Array(4096)],
  ];
  const files: Record<string, string | Uint8Array> = {};
  const opened: string[] = [];
  for (let copy = 0; copy < MIXED_FILES_OPENED / kinds.length; copy++) {
    for (const [name, contents] of kinds) {
      files[`${copy}/${name}`] = contents;
      opened.push(name === 'folder/inside.txt' ? `${copy}/folder` : `${copy}/${name}`);
    }
  }
  return { files, opened };
}

export interface ControlledWorkspace extends MountedElement {
  controller: WorkspaceController;
}

export async function mountControlledWorkspace(
  adapter: FileSystemAdapter,
  renderers?: Renderer[],
): Promise<ControlledWorkspace> {
  const ref = createRef<WorkspaceController>();
  const mounted = mountElement(
    <Workspace ref={ref} adapter={adapter} renderers={renderers} style={{ width: 900, height: 600 }} />,
  );
  await waitUntil(mounted.container, () => mounted.container.querySelector(ROW) !== null);
  return { ...mounted, controller: ref.current! };
}

const activeViewer = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>('[role=tabpanel]:not([hidden]) [data-fs-part=viewer]');

export const showsItsFile = (viewer: HTMLElement | null): boolean =>
  viewer !== null &&
  !viewer.hasAttribute('data-status') &&
  viewer.querySelector('[data-fs-part=viewer-loading]') === null &&
  (viewer.querySelector('[data-fs-part=viewer-body]')?.firstElementChild ?? null) !== null;

const tabCount = (container: HTMLElement): number => container.querySelectorAll('[role=tab]').length;

export async function openAndCloseEach(
  workspace: ControlledWorkspace,
  paths: readonly string[],
  isShown: (viewer: HTMLElement | null) => boolean = showsItsFile,
): Promise<void> {
  const { container, controller } = workspace;
  for (const path of paths) {
    controller.open(path, 'pin');
    await waitUntil(container, () => tabCount(container) > 0 && isShown(activeViewer(container)));
  }
  while (tabCount(container) > 0) {
    const tabsBefore = tabCount(container);
    container.querySelector<HTMLButtonElement>('[data-fs-part=tab-close]')!.click();
    await waitUntil(container, () => tabCount(container) < tabsBefore);
  }
}

const oneMebibyteOfText = (): string => {
  const line = 'An agent wrote this line of a large text file.\n';
  const lines = line.repeat(Math.ceil(MEBIBYTE / line.length));
  return lines.slice(0, MEBIBYTE);
};

function recordingWhenTheBytesArrive(memory: MemoryAdapter): {
  adapter: FileSystemAdapter;
  arrivedAt: () => number;
} {
  let arrivedAt = Number.NaN;
  const read = (async (path: string, as: 'text', options) => {
    const text = await memory.read(path, as, options);
    if (path === LARGE_TEXT_PATH) arrivedAt = performance.now();
    return text;
  }) as FileSystemAdapter['read'];
  return { adapter: { ...memory, read }, arrivedAt: () => arrivedAt };
}

export async function largeTextOpenToEditableMs(): Promise<number> {
  const text = oneMebibyteOfText();
  const memory = createMemoryAdapter({ files: { [LARGE_TEXT_PATH]: text } });
  const { adapter, arrivedAt } = recordingWhenTheBytesArrive(memory);
  const workspace = await mountControlledWorkspace(adapter);
  try {
    const editor = (): HTMLTextAreaElement | null =>
      workspace.container.querySelector<HTMLTextAreaElement>('[data-fs-part=text-editor]');
    workspace.controller.open(LARGE_TEXT_PATH, 'pin');
    await waitUntil(workspace.container, () => {
      const textarea = editor();
      return textarea !== null && !textarea.readOnly && textarea.value.length === text.length;
    });
    await afterNextPaint();
    return performance.now() - arrivedAt();
  } finally {
    workspace.unmount();
  }
}
