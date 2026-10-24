import { StrictMode } from 'react';
import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from 'vitest-browser-react';
import '@workspacekit/react/styles.css';
import '../src/styles.css';
import { Grid } from '../src/grid/Grid';
import { textWidth } from '../src/grid/measure';
import type { GridModel } from '../src/grid/model';
import { dragColumnEdge } from '../src/grid/resize';
import { syntheticModel } from './support/syntheticModel';

afterEach(() => cleanup());

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

async function mountGrid(model: GridModel): Promise<HTMLElement> {
  await render(
    <div style={{ width: 800, height: 600, display: 'flex' }}>
      <Grid model={model} aria-label="Sheet1" />
    </div>,
  );
  await expect.poll(() => document.querySelector('[role=gridcell]')).not.toBeNull();
  return document.querySelector<HTMLElement>('[role=grid]')!;
}

const cellAt = (row: number, col: number): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    `[role=row][aria-rowindex="${row + 2}"] [role=gridcell][aria-colindex="${col + 2}"]`,
  );

test.each([
  ['zero', () => 0],
  ['negative', () => -1e6],
  ['NaN', () => Number.NaN],
  ['huge', () => 1e300],
])('%s row heights and column widths still mount a bounded number of cells', async (_, size) => {
  const model: GridModel = {
    ...syntheticModel({ rows: 20_000, cols: 500 }),
    rowHeight: size,
    colWidth: size,
  };
  const grid = await mountGrid(model);
  expect(grid.querySelectorAll('[role=gridcell]').length).toBeLessThan(2_000);
  expect(Number.isFinite(grid.getBoundingClientRect().height)).toBe(true);
});

test('a model with NaN sizes settles: the grid does not keep re-measuring', async () => {
  let cellReads = 0;
  const base = syntheticModel({ rows: 2_000, cols: 50 });
  const model: GridModel = {
    ...base,
    rowHeight: (row) => (row === 5 ? Number.NaN : 22),
    cell: (row, col) => {
      cellReads++;
      return base.cell(row, col);
    },
  };
  await mountGrid(model);
  for (let frame = 0; frame < 5; frame++) await nextFrame();
  const settled = cellReads;
  for (let frame = 0; frame < 10; frame++) await nextFrame();
  expect(cellReads).toBe(settled);
});

test('a merged anchor in a frozen row is cut at the freeze line instead of covering scrolled rows', async () => {
  const model = syntheticModel({
    rows: 2_000,
    cols: 20,
    merges: [{ top: 0, left: 0, bottom: 1_999, right: 1 }],
    frozen: { rows: 1, cols: 0 },
  });
  await mountGrid(model);
  const anchor = cellAt(0, 0)!;
  expect(anchor.getAttribute('aria-rowspan')).toBe('2000');
  expect(anchor.getBoundingClientRect().height).toBeLessThanOrEqual(28);
});

test('Alt+Right and Alt+Left resize the focused cell’s column', async () => {
  await mountGrid(syntheticModel({ rows: 50, cols: 20 }));
  const header = (): HTMLElement =>
    document.querySelector<HTMLElement>('[role=columnheader][aria-colindex="3"]')!;
  const press = (key: string): boolean =>
    cellAt(0, 1)!.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true }));
  const before = header().getBoundingClientRect().width;
  cellAt(0, 1)!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  await expect.poll(() => cellAt(0, 1)!.tabIndex).toBe(0);
  press('ArrowRight');
  press('ArrowRight');
  await expect.poll(() => Math.round(header().getBoundingClientRect().width)).toBe(Math.round(before + 16));
  press('ArrowLeft');
  await expect.poll(() => Math.round(header().getBoundingClientRect().width)).toBe(Math.round(before + 8));
  expect(cellAt(0, 1)!.tabIndex).toBe(0);
});

test('a colour that is not a colour is dropped by the browser, not applied', async () => {
  const base = syntheticModel({ rows: 10, cols: 5 });
  const model: GridModel = {
    ...base,
    cell: () => ({
      text: 'x',
      style: { color: 'url(javascript:alert(1))', fill: 'expression(alert(1))' },
    }),
  };
  await mountGrid(model);
  expect(cellAt(0, 0)!.style.color).toBe('');
  expect(cellAt(0, 0)!.style.background).toBe('');
});

test('only a bounded prefix of a huge text is measured', () => {
  const huge = 'w'.repeat(100_000);
  expect(textWidth(huge, '13px sans-serif')).toBe(textWidth(huge.slice(0, 256), '13px sans-serif'));
});

test('a column drag stops listening once its signal aborts', () => {
  const handle = document.createElement('div');
  document.body.append(handle);
  const controller = new AbortController();
  const widths: number[] = [];
  const pointer = {
    button: 0,
    pointerId: 7,
    clientX: 100,
    currentTarget: handle,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  };
  dragColumnEdge(pointer as never, 90, (width) => widths.push(width), controller.signal);
  document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: 130 }));
  controller.abort();
  document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: 160 }));
  expect(widths).toEqual([120]);
  handle.remove();
});

test('dragging a column edge resizes it under StrictMode too', async () => {
  await render(
    <StrictMode>
      <div style={{ width: 800, height: 600, display: 'flex' }}>
        <Grid model={syntheticModel({ rows: 50, cols: 20 })} aria-label="Sheet1" />
      </div>
    </StrictMode>,
  );
  await expect.poll(() => document.querySelector('[role=gridcell]')).not.toBeNull();
  const header = (): HTMLElement =>
    document.querySelector<HTMLElement>('[role=columnheader][aria-colindex="2"]')!;
  const handle = header().querySelector<HTMLElement>('[data-fs-part=sheet-column-resizer]')!;
  const start = header().getBoundingClientRect();
  const pointer = { pointerId: 1, bubbles: true, button: 0 };
  handle.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: start.right }));
  handle.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: start.right + 50 }));
  handle.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: start.right + 50 }));
  await expect
    .poll(() => Math.round(header().getBoundingClientRect().width))
    .toBe(Math.round(start.width + 50));
});
