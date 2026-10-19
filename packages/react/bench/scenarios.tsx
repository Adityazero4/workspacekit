import { joinPath, type ChangeEvent } from '@scope/core';
import { createMemoryAdapter, generateShape, type MemoryAdapter, type TreeShape } from '@scope/core/memory';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import { Workspace } from '../src/workspace/Workspace';

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

export const MEDIAN_RUNS = 3;
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

export async function medianOf(run: (attempt: number) => Promise<number>): Promise<number> {
  const results: number[] = [];
  for (let attempt = 0; attempt < MEDIAN_RUNS; attempt++) {
    results.push(await run(attempt));
    await mainThreadQuiet();
  }
  return median(results);
}

export async function medianFrameStats(run: () => Promise<FrameStats>): Promise<FrameStats> {
  const results: FrameStats[] = [];
  for (let attempt = 0; attempt < MEDIAN_RUNS; attempt++) {
    results.push(await run());
    await mainThreadQuiet();
  }
  return {
    frames: median(results.map((stats) => stats.frames)),
    longestFrameMs: median(results.map((stats) => stats.longestFrameMs)),
    shareOfFramesOver25Ms: median(results.map((stats) => stats.shareOfFramesOver25Ms)),
    longAnimationFrames: median(results.map((stats) => stats.longAnimationFrames)),
    longTasks: median(results.map((stats) => stats.longTasks)),
  };
}

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

export async function expandAndCollapseMedians(
  workspace: MountedWorkspace,
  folder: string,
): Promise<{ expandMs: number; collapseMs: number }> {
  const expands: number[] = [];
  const collapses: number[] = [];
  for (let attempt = 0; attempt < MEDIAN_RUNS; attempt++) {
    expands.push(await expandFolder(workspace, folder));
    await mainThreadQuiet();
    collapses.push(await collapseFolder(workspace, folder));
    await mainThreadQuiet();
  }
  return { expandMs: median(expands), collapseMs: median(collapses) };
}

export function expandThatFetchesMedian(adapter: MemoryAdapter, folder: string): Promise<number> {
  return medianOf(async () => {
    const workspace = await mountWorkspace(adapter, { fetchDepth: 1 });
    try {
      return await expandFolder(workspace, folder);
    } finally {
      workspace.unmount();
    }
  });
}

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

export function collectGarbageWhenExposed(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

export function usedHeapMb(): number {
  collectGarbageWhenExposed();
  const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  if (!memory) throw new Error('performance.memory is unavailable; run Chromium');
  return memory.usedJSHeapSize / 2 ** 20;
}
