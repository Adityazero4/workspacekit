import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import '@workspacekit/react/styles.css';
import '../src/styles.css';
import { Grid } from '../src/grid/Grid';
import { spreadMerges, syntheticModel } from './support/syntheticModel';

const ROWS = 20_000;
const COLS = 500;
const MERGES = 1_000;
const WARM_UP_RUNS = 1;
const MEDIAN_RUNS = 5;
const BUDGET_MS = 50;

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function longestFrameDuring(work: () => Promise<void>): Promise<number> {
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
  await nextFrame();
  return Math.max(...timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]!));
}

async function scrollToTheEnd(viewport: HTMLElement, axis: 'vertical' | 'horizontal'): Promise<void> {
  const isVertical = axis === 'vertical';
  const step = isVertical ? viewport.clientHeight : viewport.clientWidth;
  const end = isVertical
    ? viewport.scrollHeight - viewport.clientHeight
    : viewport.scrollWidth - viewport.clientWidth;
  while ((isVertical ? viewport.scrollTop : viewport.scrollLeft) < end - 1) {
    if (isVertical) viewport.scrollTop += step;
    else viewport.scrollLeft += step;
    await nextFrame();
  }
}

async function scrollEndToEnd(): Promise<number> {
  const model = syntheticModel({
    rows: ROWS,
    cols: COLS,
    merges: spreadMerges(MERGES, ROWS, COLS),
    frozen: { rows: 1, cols: 1 },
    spillingText: true,
  });
  const screen = await render(
    <div style={{ width: 1200, height: 800, display: 'flex' }}>
      <Grid model={model} aria-label="Big sheet" />
    </div>,
  );
  await expect.poll(() => document.querySelector('[role=gridcell]')).not.toBeNull();
  const viewport = document.querySelector<HTMLElement>('[data-fs-part=sheet-grid-viewport]')!;
  const longest = await longestFrameDuring(async () => {
    await scrollToTheEnd(viewport, 'vertical');
    await scrollToTheEnd(viewport, 'horizontal');
  });
  expect(document.querySelector(`[role=row][aria-rowindex="${ROWS + 1}"]`)).not.toBeNull();
  await screen.unmount();
  return longest;
}

test(`a ${ROWS} × ${COLS} sheet with ${MERGES} merges, frozen panes and spilling text scrolls end to end with no frame over ${BUDGET_MS} ms (median of ${MEDIAN_RUNS} after ${WARM_UP_RUNS} warm-up)`, async () => {
  const samples: number[] = [];
  for (let attempt = 0; attempt < WARM_UP_RUNS + MEDIAN_RUNS; attempt++) {
    (globalThis as { gc?: () => void }).gc?.();
    const sample = await scrollEndToEnd();
    if (attempt >= WARM_UP_RUNS) samples.push(sample);
  }
  const message = `sheet scroll longest frame (ms): median of [${samples.map((sample) => sample.toFixed(1)).join(', ')}]`;
  // eslint-disable-next-line no-console -- the perf project prints every budget's raw samples (Ruling P3-20)
  console.info(`[perf] ${message} = ${median(samples).toFixed(1)}, budget ≤ ${BUDGET_MS}`);
  expect(median(samples), message).toBeLessThanOrEqual(BUDGET_MS);
}, 600_000);
