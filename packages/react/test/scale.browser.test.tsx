import type { MemoryAdapter } from '@workspacekit/core/memory';
import { createMemoryAdapter } from '@workspacekit/core/memory';
import { afterEach, describe, expect, test } from 'vitest';
import { commands } from 'vitest/browser';
import {
  agentUpdatesUnder,
  answeringMovesAfter,
  BURST_SETTLE_MS,
  BURST_SIZE,
  createBenchAdapter,
  expandAndCollapseSamples,
  expandFolder,
  expandThatFetchesSamples,
  firstChildName,
  framesWhileSettling,
  largeTextOpenToEditableMs,
  manyPageTiff,
  MEDIAN_RUNS,
  median,
  MIXED_FILES_OPENED,
  mixedFiles,
  mountControlledWorkspace,
  mountWorkspace,
  MOVE_ROUND_TRIP_MS,
  openAndCloseEach,
  PAGE_COUNT,
  PAGES_OVERSCAN,
  renameEntry,
  samplesOf,
  scrollViewports,
  scrollVirtualPagesEndToEnd,
  SCROLLED_VIEWPORTS,
  settledHeapMb,
  TIFF_HEAP_CHECKPOINT_PAGE,
  tiffHeapWhileScrolling,
  usedHeapMb,
  WARM_UP_RUNS,
  type ControlledWorkspace,
  type FrameStats,
  type MountedWorkspace,
} from '../bench/scenarios';

const MILLION = 1_000_000;
const SCALE_TIMEOUT_MS = 900_000;
const HEAP_DRIFT_ALLOWED = 0.1;

let mounted: MountedWorkspace | ControlledWorkspace | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function reportSamples(line: string): void {
  // eslint-disable-next-line no-console -- the perf project prints every budget's raw samples (Ruling P3-20)
  console.info(`[perf] ${line}`);
}

const formatted = (samples: readonly number[]): string =>
  samples.map((sample) => (Number.isInteger(sample) ? String(sample) : sample.toFixed(3))).join(', ');

function expectMedianAtMost(samples: number[], budget: number, label: string): void {
  const message = `${label}: median of [${formatted(samples)}]`;
  reportSamples(`${message} = ${formatted([median(samples)])}, budget ≤ ${budget}`);
  expect.soft(median(samples), message).toBeLessThanOrEqual(budget);
}

function expectNoFrameOver50Ms(samples: FrameStats[], label: string): void {
  expectMedianAtMost(
    samples.map((stats) => stats.longestFrameMs),
    50,
    `${label}: longest frame (ms)`,
  );
}

function expectSmoothScrolling(samples: FrameStats[], label: string): void {
  expectNoFrameOver50Ms(samples, label);
  const shares = samples.map((stats) => stats.shareOfFramesOver25Ms);
  const message = `${label}: share of frames over 25 ms, median of [${formatted(shares)}]`;
  reportSamples(`${message}, budget < 0.1`);
  expect.soft(median(shares), message).toBeLessThan(0.1);
}

const coldFirstRenderSamples = (shape: 'wide' | 'chains64'): Promise<number[]> =>
  samplesOf(() => commands.firstRenderInAFreshPage(shape, MILLION));

async function heapHeldByAMountedWorkspace(adapter: MemoryAdapter): Promise<number> {
  const heapBeforeMount = usedHeapMb();
  mounted = await mountWorkspace(adapter);
  return usedHeapMb() - heapBeforeMount;
}

describe.skipIf(process.env.CI_SLOW)(
  `scale budgets in Chromium, each the median of ${MEDIAN_RUNS} runs after ${WARM_UP_RUNS} warm-up`,
  () => {
    test.each(['wide', 'chains64'] as const)(
      '1M %s: cold first render ≤ 500 ms, ≤ 150 MB heap after it, smooth scrolling over 50 viewports',
      async (shape) => {
        expectMedianAtMost(await coldFirstRenderSamples(shape), 500, `1M ${shape} cold first render (ms)`);
        const { adapter } = createBenchAdapter(shape, MILLION);
        const heldMb = await heapHeldByAMountedWorkspace(adapter);
        reportSamples(`1M ${shape} heap held by the workspace (MB) = ${heldMb.toFixed(1)}, budget ≤ 150`);
        expect.soft(heldMb, 'heap held by the workspace (MB)').toBeLessThanOrEqual(150);
        await expandFolder(mounted as MountedWorkspace, shape === 'wide' ? 'wide' : 'c0');
        expectSmoothScrolling(
          await samplesOf(() => scrollViewports(mounted as MountedWorkspace, SCROLLED_VIEWPORTS)),
          `1M ${shape} scroll`,
        );
      },
      SCALE_TIMEOUT_MS,
    );

    test(
      '1M 10x100k: expanding a 100k-child folder that must be fetched (fetchDepth 1, a fresh tree per run) ≤ 250 ms',
      async () => {
        const { adapter } = createBenchAdapter('10x100k', MILLION);
        expectMedianAtMost(
          await expandThatFetchesSamples(adapter, 'd0'),
          250,
          'list, merge, sort and paint 100k entries (ms)',
        );
      },
      SCALE_TIMEOUT_MS,
    );

    test(
      '1M 10x100k: expand a loaded 100k-child folder ≤ 150 ms, collapse ≤ 50 ms, smooth scrolling, rename on screen ≤ 100 ms',
      async () => {
        const { adapter } = createBenchAdapter('10x100k', MILLION);
        const workspace = await mountWorkspace(answeringMovesAfter(adapter, MOVE_ROUND_TRIP_MS));
        mounted = workspace;
        const { expands, collapses } = await expandAndCollapseSamples(workspace, 'd0');
        expectMedianAtMost(expands, 150, 'expand of a loaded folder (ms)');
        expectMedianAtMost(collapses, 50, 'collapse (ms)');

        await expandFolder(workspace, 'd0');
        expectSmoothScrolling(
          await samplesOf(() => scrollViewports(workspace, SCROLLED_VIEWPORTS)),
          '1M 10x100k scroll',
        );

        const renames = await samplesOf((attempt) =>
          renameEntry(workspace, firstChildName(workspace, 'd0'), `0-renamed-${attempt}.txt`),
        );
        expectMedianAtMost(renames, 100, 'rename: new name on screen (ms)');
      },
      SCALE_TIMEOUT_MS,
    );

    async function burstIntoAnOpenFolder(files: number): Promise<FrameStats[]> {
      const { adapter, paths } = createBenchAdapter('10x100k', files);
      const workspace = await mountWorkspace(adapter);
      mounted = workspace;
      await expandFolder(workspace, 'd0');
      const burst = agentUpdatesUnder(paths, 'd0');
      return samplesOf(() => framesWhileSettling(BURST_SETTLE_MS, () => adapter.emit(burst)));
    }

    test(
      `${BURST_SIZE} agent events into an open 10k-child folder (100k 10x100k): no frame over 50 ms`,
      async () => {
        expectNoFrameOver50Ms(await burstIntoAnOpenFolder(100_000), 'burst');
      },
      SCALE_TIMEOUT_MS,
    );

    test(
      `${BURST_SIZE}-event burst into a 100k-child folder (1M 10x100k), events carrying entries: no frame over 50 ms`,
      async () => {
        expectNoFrameOver50Ms(await burstIntoAnOpenFolder(MILLION), 'burst into 100k');
      },
      SCALE_TIMEOUT_MS,
    );

    test(
      `${PAGE_COUNT}-page VirtualPages scrolled end to end: no frame over 50 ms, mounted pages ≤ visible + 2 × overscan`,
      async () => {
        const scrolls = await samplesOf(scrollVirtualPagesEndToEnd);
        expectNoFrameOver50Ms(
          scrolls.map((scroll) => scroll.frames),
          `${PAGE_COUNT}-page scroll`,
        );
        const beyondVisible = scrolls.map((scroll) => scroll.mostPagesMountedBeyondTheVisible);
        reportSamples(`pages mounted beyond the visible, per run: [${formatted(beyondVisible)}]`);
        expect(
          Math.max(...beyondVisible),
          `pages mounted beyond the visible: [${formatted(beyondVisible)}]`,
        ).toBeLessThanOrEqual(2 * PAGES_OVERSCAN);
      },
      SCALE_TIMEOUT_MS,
    );

    test(
      `heap after opening and closing ${MIXED_FILES_OPENED} files of mixed kinds is back to its baseline ±10%`,
      async () => {
        const { files, opened } = await mixedFiles();
        const workspace = await mountControlledWorkspace(createMemoryAdapter({ files }));
        mounted = workspace;
        const drifts = await samplesOf(async () => {
          const baselineMb = await settledHeapMb();
          await openAndCloseEach(workspace, opened);
          return Math.abs((await settledHeapMb()) - baselineMb) / baselineMb;
        });
        expectMedianAtMost(drifts, HEAP_DRIFT_ALLOWED, 'heap drift from the baseline (share)');
      },
      SCALE_TIMEOUT_MS,
    );

    test(
      `heap while scrolling a ${PAGE_COUNT}-page TIFF end to end stays within 10% of the heap at page ${TIFF_HEAP_CHECKPOINT_PAGE}`,
      async () => {
        const data = manyPageTiff();
        const drifts = await samplesOf(async () => {
          const { atTheCheckpointMb, atTheEndMb } = await tiffHeapWhileScrolling(data);
          return Math.abs(atTheEndMb - atTheCheckpointMb) / atTheCheckpointMb;
        });
        expectMedianAtMost(
          drifts,
          HEAP_DRIFT_ALLOWED,
          `heap drift from page ${TIFF_HEAP_CHECKPOINT_PAGE} (share)`,
        );
      },
      SCALE_TIMEOUT_MS,
    );

    test(
      'a 1 MiB text file is editable ≤ 200 ms after its bytes arrive',
      async () => {
        expectMedianAtMost(
          await samplesOf(largeTextOpenToEditableMs),
          200,
          '1 MiB text: bytes to editable (ms)',
        );
      },
      SCALE_TIMEOUT_MS,
    );
  },
);
