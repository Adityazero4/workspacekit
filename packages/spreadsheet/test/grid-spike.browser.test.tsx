import axe from 'axe-core';
import { afterEach, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-react';
import '@workspacekit/react/styles.css';
import '../src/styles.css';
import { Grid } from '../src/grid/Grid';
import type { GridModel } from '../src/grid/model';
import { spreadMerges, syntheticModel } from './support/syntheticModel';

afterEach(() => cleanup());

const FOCUS_TIMEOUT_MS = 5_000;

const HEADER_ROWS = 1;
const ROW_HEADER_COLUMNS = 1;

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
    `[role=row][aria-rowindex="${row + 1 + HEADER_ROWS}"] [role=gridcell][aria-colindex="${col + 1 + ROW_HEADER_COLUMNS}"]`,
  );

const viewportOf = (grid: HTMLElement): HTMLElement =>
  grid.closest<HTMLElement>('[data-fs-part=sheet-grid-viewport]')!;

const overlapsViewport = (element: HTMLElement, viewport: HTMLElement): boolean => {
  const box = element.getBoundingClientRect();
  const view = viewport.getBoundingClientRect();
  return box.bottom > view.top && box.top < view.bottom && box.right > view.left && box.left < view.right;
};

test('the grid is a WAI-ARIA grid with counts, headers and one tab stop', async () => {
  const grid = await mountGrid(syntheticModel({ rows: 20_000, cols: 500 }));
  expect(grid.getAttribute('aria-rowcount')).toBe(String(20_000 + HEADER_ROWS));
  expect(grid.getAttribute('aria-colcount')).toBe(String(500 + ROW_HEADER_COLUMNS));
  expect(grid.querySelector('[role=columnheader][aria-colindex="2"]')?.textContent).toBe('A');
  expect(grid.querySelector('[role=row][aria-rowindex="2"] [role=rowheader]')?.textContent).toBe('1');
  expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  expect(cellAt(0, 0)!.tabIndex).toBe(0);
  expect(grid.querySelectorAll('[role=gridcell]').length).toBeLessThan(2_000);
});

test('axe reports no violations on a grid with merges and frozen panes', async () => {
  const model = syntheticModel({
    rows: 300,
    cols: 40,
    merges: spreadMerges(20, 300, 40),
    frozen: { rows: 1, cols: 1 },
  });
  const grid = await mountGrid(model);
  const results = await axe.run(viewportOf(grid));
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});

test('roving focus follows the arrow keys, Home and End, and Ctrl+Home and Ctrl+End', async () => {
  await mountGrid(syntheticModel({ rows: 20_000, cols: 500 }));
  await userEvent.click(cellAt(0, 0)!);
  await expect.poll(() => document.activeElement === cellAt(0, 0), { timeout: FOCUS_TIMEOUT_MS }).toBe(true);
  await userEvent.keyboard('{ArrowRight}{ArrowDown}');
  await expect.poll(() => document.activeElement === cellAt(1, 1), { timeout: FOCUS_TIMEOUT_MS }).toBe(true);
  await userEvent.keyboard('{End}');
  await expect
    .poll(() => document.activeElement === cellAt(1, 499), { timeout: FOCUS_TIMEOUT_MS })
    .toBe(true);
  await userEvent.keyboard('{Home}');
  await expect.poll(() => document.activeElement === cellAt(1, 0), { timeout: FOCUS_TIMEOUT_MS }).toBe(true);
  await userEvent.keyboard('{Control>}{End}{/Control}');
  await expect
    .poll(() => document.activeElement === cellAt(19_999, 499), { timeout: FOCUS_TIMEOUT_MS })
    .toBe(true);
  await userEvent.keyboard('{ArrowLeft}{ArrowUp}');
  await expect
    .poll(() => document.activeElement === cellAt(19_998, 498), { timeout: FOCUS_TIMEOUT_MS })
    .toBe(true);
  await userEvent.keyboard('{Control>}{Home}{/Control}');
  await expect.poll(() => document.activeElement === cellAt(0, 0), { timeout: FOCUS_TIMEOUT_MS }).toBe(true);
  expect(document.querySelectorAll('[role=grid] [tabindex="0"]')).toHaveLength(1);
});

test('arrow keys step over a merged range, landing on its anchor', async () => {
  const model = syntheticModel({ rows: 50, cols: 20, merges: [{ top: 1, left: 1, bottom: 3, right: 4 }] });
  await mountGrid(model);
  await userEvent.click(cellAt(2, 0)!);
  await expect.poll(() => document.activeElement === cellAt(2, 0), { timeout: FOCUS_TIMEOUT_MS }).toBe(true);
  await userEvent.keyboard('{ArrowRight}');
  await expect.poll(() => document.activeElement === cellAt(1, 1), { timeout: FOCUS_TIMEOUT_MS }).toBe(true);
  await userEvent.keyboard('{ArrowRight}');
  await expect.poll(() => document.activeElement === cellAt(1, 5), { timeout: FOCUS_TIMEOUT_MS }).toBe(true);
  await userEvent.keyboard('{ArrowLeft}{ArrowDown}');
  await expect.poll(() => document.activeElement === cellAt(4, 1), { timeout: FOCUS_TIMEOUT_MS }).toBe(true);
});

test('a merged anchor is sized to its span, covered cells are not drawn, and the anchor stays drawn once it scrolls out', async () => {
  const merge = { top: 2, left: 2, bottom: 61, right: 13 };
  const grid = await mountGrid(syntheticModel({ rows: 2_000, cols: 100, merges: [merge] }));
  const anchor = cellAt(2, 2)!;
  expect(anchor.getAttribute('aria-rowspan')).toBe('60');
  expect(anchor.getAttribute('aria-colspan')).toBe('12');
  expect(cellAt(3, 3)).toBeNull();
  expect(cellAt(1, 3)).not.toBeNull();
  expect(cellAt(2, 1)).not.toBeNull();
  const viewport = viewportOf(grid);
  viewport.scrollTop = 30 * 22;
  viewport.scrollLeft = 8 * 90;
  await nextFrame();
  await nextFrame();
  await expect.poll(() => cellAt(2, 2) !== null && overlapsViewport(cellAt(2, 2)!, viewport)).toBe(true);
  expect(cellAt(1, 1)).toBeNull();
  viewport.scrollTop = 1_000 * 22;
  await expect.poll(() => cellAt(2, 2)).toBeNull();
});

test('frozen rows and columns stay in view while the rest scrolls', async () => {
  const grid = await mountGrid(syntheticModel({ rows: 2_000, cols: 100, frozen: { rows: 2, cols: 1 } }));
  const viewport = viewportOf(grid);
  viewport.scrollTop = 500 * 22;
  viewport.scrollLeft = 40 * 90;
  await nextFrame();
  await nextFrame();
  await expect.poll(() => cellAt(1, 0) !== null && overlapsViewport(cellAt(1, 0)!, viewport)).toBe(true);
  const shown = (cells: NodeListOf<HTMLElement>): HTMLElement[] =>
    [...cells].filter((cell) => overlapsViewport(cell, viewport));
  const frozenRowCells = shown(document.querySelectorAll('[role=row][aria-rowindex="2"] [role=gridcell]'));
  expect(frozenRowCells.some((cell) => Number(cell.getAttribute('aria-colindex')) > 30)).toBe(true);
  const frozenColumnCells = shown(document.querySelectorAll('[role=gridcell][aria-colindex="2"]'));
  const rowIndexOf = (cell: HTMLElement): number =>
    Number(cell.closest('[role=row]')!.getAttribute('aria-rowindex'));
  expect(frozenColumnCells.some((cell) => rowIndexOf(cell) > 400)).toBe(true);
});

test('a crafted pane freezing 20,000 rows and 500 columns still renders only a bounded number of rows and cells', async () => {
  const grid = await mountGrid(
    syntheticModel({ rows: 20_000, cols: 500, frozen: { rows: 20_000, cols: 500 } }),
  );
  expect(grid.querySelectorAll('[role=row]').length).toBeLessThan(80);
  expect(grid.querySelectorAll('[role=gridcell]').length).toBeLessThan(2_000);
  expect(grid.querySelectorAll('[data-fs-part=sheet-grid-head] [role=row]').length).toBeLessThanOrEqual(21);
});
