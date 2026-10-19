import type { TreeShape } from '@scope/core/memory';
import {
  agentUpdatesUnder,
  answeringMovesAfter,
  BURST_SETTLE_MS,
  collectGarbageWhenExposed,
  createBenchAdapter,
  dragFirstChildToTheRootAndBack,
  expandAndCollapseMedians,
  expandFolder,
  expandThatFetchesMedian,
  firstChildName,
  framesDuring,
  framesWhileSettling,
  mainThreadQuiet,
  medianFrameStats,
  medianOf,
  mountWorkspace,
  MOVE_ROUND_TRIP_MS,
  renameEntry,
  scrollViewports,
  SCROLLED_VIEWPORTS,
  searchFor,
  viewportsThatFit,
  type FrameStats,
  type MountedWorkspace,
} from './scenarios';

interface Interactions {
  expandThatFetchesMs: number;
  expandMs: number;
  collapseMs: number;
  scroll: FrameStats;
  viewportsScrolled: number;
  renameMs: number;
  renameRoundTrip: FrameStats;
  dragMs: number;
  searchMs: number;
  burst: FrameStats;
}

interface BenchPage {
  setupMs: number;
  firstRenderMs: () => Promise<number>;
  mount: () => Promise<void>;
  interactions: () => Promise<Interactions>;
}

const TOP_FOLDER: Record<TreeShape, string> = { wide: 'wide', '10x100k': 'd0', chains64: 'c0' };
const SEARCH_QUERY = 'f9999';

const params = new URLSearchParams(location.search);
const shape = params.get('shape') as TreeShape;
const size = Number(params.get('size'));
const setupStartedAt = performance.now();
const { adapter, paths } = createBenchAdapter(shape, size);
const setupMs = performance.now() - setupStartedAt;
const topFolder = TOP_FOLDER[shape];
const burstEvents = agentUpdatesUnder(paths, topFolder);
let mounted: MountedWorkspace | undefined;

const renameFirstChild = (workspace: MountedWorkspace, newName: string): Promise<number> =>
  renameEntry(workspace, firstChildName(workspace, topFolder), newName);

async function interactions(): Promise<Interactions> {
  const workspace = mounted!;
  const expandThatFetchesMs = await expandThatFetchesMedian(adapter, topFolder);
  const { expandMs, collapseMs } = await expandAndCollapseMedians(workspace, topFolder);
  await expandFolder(workspace, topFolder);
  const viewportsScrolled = viewportsThatFit(workspace, SCROLLED_VIEWPORTS);
  const scroll = await medianFrameStats(() => scrollViewports(workspace, viewportsScrolled));
  const renameMs = await medianOf((attempt) => renameFirstChild(workspace, `0-renamed-${attempt}`));
  let roundTrips = 0;
  const renameRoundTrip = await medianFrameStats(() =>
    framesDuring(async () => {
      await renameFirstChild(workspace, `0-round-trip-${roundTrips++}`);
      await mainThreadQuiet();
    }),
  );
  const dragMs = await medianOf(() => dragFirstChildToTheRootAndBack(workspace, adapter, topFolder));
  const searchMs = await medianOf(() => searchFor(workspace, SEARCH_QUERY));
  const burst = await medianFrameStats(() =>
    framesWhileSettling(BURST_SETTLE_MS, () => adapter.emit(burstEvents)),
  );
  return {
    expandThatFetchesMs,
    expandMs,
    collapseMs,
    scroll,
    viewportsScrolled,
    renameMs,
    renameRoundTrip,
    dragMs,
    searchMs,
    burst,
  };
}

const page: BenchPage = {
  setupMs,
  firstRenderMs: async () => {
    collectGarbageWhenExposed();
    const workspace = await mountWorkspace(adapter);
    workspace.unmount();
    return workspace.firstRenderMs;
  },
  mount: async () => {
    mounted = await mountWorkspace(answeringMovesAfter(adapter, MOVE_ROUND_TRIP_MS));
  },
  interactions,
};

Object.assign(window, { bench: page });
