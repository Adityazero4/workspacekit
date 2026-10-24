import { createMemoryAdapter } from '@workspacekit/core/memory';
import { PdfViewer } from '@workspacekit/pdf';
import { PptxViewer } from '@workspacekit/pptx';
import { allRenderers } from '@workspacekit/workspace';
import '@workspacekit/workspace/styles.css';
import { afterEach, expect, test } from 'vitest';
import {
  heapWhileScrollingPages,
  median,
  MEDIAN_RUNS,
  mountControlledWorkspace,
  openAndCloseEach,
  PAGES_OVERSCAN,
  samplesOf,
  scrollPagesEndToEnd,
  settledHeapMb,
  showsItsFile,
  WARM_UP_RUNS,
  type ControlledWorkspace,
  type HeapWhileScrolling,
} from '../../react/bench/scenarios';
import { pdfBytes } from '../../pdf/test/fixtures/pdf';
import { trackWorkers, workerTraffic } from '../../pdf/test/support/trackedWorkers';
import {
  BAR_CHART,
  chartFrame,
  picture,
  pngOfSize,
  pptxBytes,
  textShape,
  type SlideFixture,
} from '../../pptx/test/fixtures/pptx';

const PDF_PAGES = 500;
const PDFS_OPENED = 20;
const PAGES_PER_OPENED_PDF = 3;
const SLIDES = 200;
const SLIDE_HEAP_CHECKPOINT = 20;
const TEXT_BOXES_PER_SLIDE = 80;
const FRAME_BUDGET_MS = 50;
const HEAP_DRIFT_ALLOWED = 0.1;
const PERF_TIMEOUT_MS = 900_000;

let workspace: ControlledWorkspace | undefined;
afterEach(() => {
  workspace?.unmount();
  workspace = undefined;
});

function reportSamples(line: string): void {
  // eslint-disable-next-line no-console -- the perf project prints every budget's raw samples (Ruling P3-20)
  console.info(`[perf] ${line}`);
}

function expectMedianAtMost(samples: number[], budget: number, label: string): void {
  const message = `${label}: median of [${samples.map((sample) => sample.toFixed(3)).join(', ')}]`;
  reportSamples(`${message} = ${median(samples).toFixed(3)}, budget ≤ ${budget}`);
  expect.soft(median(samples), message).toBeLessThanOrEqual(budget);
}

const textPages = (count: number, name: string) =>
  Array.from({ length: count }, (_, index) => ({ text: `${name}, page ${index + 1}` }));

const isPdfPageDrawn = (page: Element): boolean => page.querySelector('canvas') !== null;

const textBoxes = (slide: number): string =>
  Array.from({ length: TEXT_BOXES_PER_SLIDE }, (_, line) =>
    textShape(`Slide ${slide + 1}, line ${line + 1}`, { y: line * 6 }),
  ).join('');

const denseSlide = (index: number): SlideFixture => ({
  shapes: textBoxes(index) + picture('<a:blip r:embed="rIdImage"/>') + chartFrame('rIdChart'),
  relationships: [
    { id: 'rIdImage', type: 'image', target: '../media/photo.png' },
    { id: 'rIdChart', type: 'chart', target: '../charts/chart1.xml' },
  ],
});

const denseDeck = (count: number): Uint8Array =>
  pptxBytes({
    slides: Array.from({ length: count }, (_, index) => denseSlide(index)),
    media: { 'photo.png': pngOfSize(64, 48) },
    extraParts: { 'ppt/charts/chart1.xml': BAR_CHART },
  });

const isSlideDrawn = (page: Element): boolean => {
  const slide = page.querySelector('[data-fs-part=pptx-slide]')?.shadowRoot;
  return slide?.querySelector('[_echarts_instance_] canvas') instanceof HTMLCanvasElement;
};

const showsADrawnPdfPage = (viewer: HTMLElement | null): boolean =>
  showsItsFile(viewer) && viewer!.querySelector('[data-fs-part=pdf-page] canvas') !== null;

function heapDrift({ atTheCheckpointMb, atTheEndMb }: HeapWhileScrolling): number {
  reportSamples(
    `heap at the checkpoint ${atTheCheckpointMb.toFixed(1)} MB, at the end ${atTheEndMb.toFixed(1)} MB`,
  );
  return Math.abs(atTheEndMb - atTheCheckpointMb) / atTheCheckpointMb;
}

test(
  `a ${PDF_PAGES}-page PDF in the PDF viewer scrolls end to end with no frame over ${FRAME_BUDGET_MS} ms and at most visible + 2 × overscan pages mounted (median of ${MEDIAN_RUNS} after ${WARM_UP_RUNS} warm-up)`,
  async () => {
    const bytes = pdfBytes({ pages: textPages(PDF_PAGES, 'Long report') });
    const scrolls = await samplesOf(() =>
      scrollPagesEndToEnd(<PdfViewer src={bytes} fileName="long.pdf" />, isPdfPageDrawn),
    );
    expectMedianAtMost(
      scrolls.map((scroll) => scroll.frames.longestFrameMs),
      FRAME_BUDGET_MS,
      `${PDF_PAGES}-page PDF scroll: longest frame (ms)`,
    );
    const beyondVisible = scrolls.map((scroll) => scroll.mostPagesMountedBeyondTheVisible);
    reportSamples(`PDF pages mounted beyond the visible, per run: [${beyondVisible.join(', ')}]`);
    expect(
      Math.max(...beyondVisible),
      `pages mounted beyond the visible: [${beyondVisible.join(', ')}]`,
    ).toBeLessThanOrEqual(2 * PAGES_OVERSCAN);
  },
  PERF_TIMEOUT_MS,
);

test(
  `heap after opening and closing ${PDFS_OPENED} PDFs in the workspace is back to its baseline ±10%, with every pdf.js worker terminated`,
  async () => {
    trackWorkers();
    const files = Object.fromEntries(
      Array.from({ length: PDFS_OPENED }, (_, index) => [
        `report-${index + 1}.pdf`,
        pdfBytes({ pages: textPages(PAGES_PER_OPENED_PDF, `Report ${index + 1}`) }),
      ]),
    );
    workspace = await mountControlledWorkspace(createMemoryAdapter({ files }), allRenderers());
    const opened = workspace;
    const drifts = await samplesOf(async () => {
      const baselineMb = await settledHeapMb();
      await openAndCloseEach(opened, Object.keys(files), showsADrawnPdfPage);
      return Math.abs((await settledHeapMb()) - baselineMb) / baselineMb;
    });
    expectMedianAtMost(drifts, HEAP_DRIFT_ALLOWED, `heap drift after ${PDFS_OPENED} PDFs (share)`);
    reportSamples(`pdf.js workers started ${workerTraffic.started}, still live ${workerTraffic.live.size}`);
    expect(workerTraffic.started, 'a worker per opened PDF').toBeGreaterThanOrEqual(
      PDFS_OPENED * (WARM_UP_RUNS + MEDIAN_RUNS),
    );
    await expect.poll(() => workerTraffic.live.size, { message: 'pdf.js workers still live' }).toBe(0);
  },
  PERF_TIMEOUT_MS,
);

test(
  `heap while scrolling a ${SLIDES}-slide PPTX end to end stays within 10% of the heap at slide ${SLIDE_HEAP_CHECKPOINT}`,
  async () => {
    const bytes = denseDeck(SLIDES);
    const drifts = await samplesOf(async () =>
      heapDrift(
        await heapWhileScrollingPages({
          element: <PptxViewer src={bytes} fileName="deck.pptx" />,
          checkpointPage: SLIDE_HEAP_CHECKPOINT,
          isPageShown: isSlideDrawn,
          pageIndicatorPart: 'pptx-slide-indicator',
          lastPageSelector: `[aria-label="Slide ${SLIDES} of ${SLIDES}"]`,
        }),
      ),
    );
    expectMedianAtMost(drifts, HEAP_DRIFT_ALLOWED, `heap drift from slide ${SLIDE_HEAP_CHECKPOINT} (share)`);
  },
  PERF_TIMEOUT_MS,
);
