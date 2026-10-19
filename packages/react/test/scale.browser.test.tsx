import type { MemoryAdapter } from '@scope/core/memory';
import { afterEach, describe, expect, test } from 'vitest';
import { commands } from 'vitest/browser';
import {
  agentUpdatesUnder,
  answeringMovesAfter,
  BURST_SETTLE_MS,
  BURST_SIZE,
  createBenchAdapter,
  expandAndCollapseMedians,
  expandFolder,
  expandThatFetchesMedian,
  firstChildName,
  framesWhileSettling,
  MEDIAN_RUNS,
  median,
  medianFrameStats,
  medianOf,
  mountWorkspace,
  MOVE_ROUND_TRIP_MS,
  renameEntry,
  scrollViewports,
  SCROLLED_VIEWPORTS,
  usedHeapMb,
  type FrameStats,
  type MountedWorkspace,
} from '../bench/scenarios';

const MILLION = 1_000_000;
const SCALE_TIMEOUT_MS = 900_000;

let mounted: MountedWorkspace | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

async function coldFirstRenderMedian(shape: 'wide' | 'chains64'): Promise<number> {
  const runs: number[] = [];
  for (let run = 0; run < MEDIAN_RUNS; run++) {
    runs.push(await commands.firstRenderInAFreshPage(shape, MILLION));
  }
  return median(runs);
}

async function heapHeldByAMountedWorkspace(adapter: MemoryAdapter): Promise<number> {
  const heapBeforeMount = usedHeapMb();
  mounted = await mountWorkspace(adapter);
  return usedHeapMb() - heapBeforeMount;
}

function expectNoFrameOver50Ms(stats: FrameStats, label: string): void {
  expect.soft(stats.longestFrameMs, `${label}: longest frame (ms)`).toBeLessThanOrEqual(50);
}

function expectSmoothScrolling(stats: FrameStats, label: string): void {
  expectNoFrameOver50Ms(stats, label);
  expect.soft(stats.shareOfFramesOver25Ms, `${label}: share of frames over 25 ms`).toBeLessThan(0.1);
}

describe.skipIf(process.env.CI_SLOW)('scale budgets in Chromium, each the median of 3 runs', () => {
  test.each(['wide', 'chains64'] as const)(
    '1M %s: cold first render ≤ 500 ms, ≤ 150 MB heap after it, smooth scrolling over 50 viewports',
    async (shape) => {
      expect.soft(await coldFirstRenderMedian(shape), 'cold first render (ms)').toBeLessThanOrEqual(500);
      const { adapter } = createBenchAdapter(shape, MILLION);
      expect
        .soft(await heapHeldByAMountedWorkspace(adapter), 'heap held by the workspace (MB)')
        .toBeLessThanOrEqual(150);
      await expandFolder(mounted!, shape === 'wide' ? 'wide' : 'c0');
      expectSmoothScrolling(
        await medianFrameStats(() => scrollViewports(mounted!, SCROLLED_VIEWPORTS)),
        `1M ${shape} scroll`,
      );
    },
    SCALE_TIMEOUT_MS,
  );

  test(
    '1M 10x100k: expanding a 100k-child folder that must be fetched (fetchDepth 1, a fresh tree per run) ≤ 250 ms',
    async () => {
      const { adapter } = createBenchAdapter('10x100k', MILLION);
      expect(
        await expandThatFetchesMedian(adapter, 'd0'),
        'list, merge, sort and paint 100k entries (ms)',
      ).toBeLessThanOrEqual(250);
    },
    SCALE_TIMEOUT_MS,
  );

  test(
    '1M 10x100k: expand a loaded 100k-child folder ≤ 150 ms, collapse ≤ 50 ms, smooth scrolling, rename on screen ≤ 100 ms',
    async () => {
      const { adapter } = createBenchAdapter('10x100k', MILLION);
      mounted = await mountWorkspace(answeringMovesAfter(adapter, MOVE_ROUND_TRIP_MS));
      const workspace = mounted;
      const { expandMs, collapseMs } = await expandAndCollapseMedians(workspace, 'd0');
      expect.soft(expandMs, 'expand of a loaded folder (ms)').toBeLessThanOrEqual(150);
      expect.soft(collapseMs, 'collapse (ms)').toBeLessThanOrEqual(50);

      await expandFolder(workspace, 'd0');
      expectSmoothScrolling(
        await medianFrameStats(() => scrollViewports(workspace, SCROLLED_VIEWPORTS)),
        '1M 10x100k scroll',
      );

      const renameMs = await medianOf((attempt) =>
        renameEntry(workspace, firstChildName(workspace, 'd0'), `0-renamed-${attempt}.txt`),
      );
      expect.soft(renameMs, 'rename: new name on screen (ms)').toBeLessThanOrEqual(100);
    },
    SCALE_TIMEOUT_MS,
  );

  async function burstIntoAnOpenFolder(files: number): Promise<FrameStats> {
    const { adapter, paths } = createBenchAdapter('10x100k', files);
    mounted = await mountWorkspace(adapter);
    await expandFolder(mounted, 'd0');
    const burst = agentUpdatesUnder(paths, 'd0');
    return medianFrameStats(() => framesWhileSettling(BURST_SETTLE_MS, () => adapter.emit(burst)));
  }

  test(
    `${BURST_SIZE} agent events into an open 10k-child folder (100k 10x100k): no frame over 50 ms`,
    async () => {
      expectNoFrameOver50Ms(await burstIntoAnOpenFolder(100_000), 'burst');
    },
    SCALE_TIMEOUT_MS,
  );

  test(
    `known limitation until watch events carry entries: ${BURST_SIZE} agent events into an open 100k-child folder ` +
      '(1M 10x100k) have a frame over 50 ms, because the store reloads and merges the whole listing in one task',
    async () => {
      const { longestFrameMs } = await burstIntoAnOpenFolder(MILLION);
      expect(longestFrameMs, 'longest frame (ms); a fix turns this red').toBeGreaterThan(50);
    },
    SCALE_TIMEOUT_MS,
  );
});
