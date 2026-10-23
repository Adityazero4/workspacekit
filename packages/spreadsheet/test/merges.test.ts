import { expect, test } from 'vitest';
import { cellAfterKey } from '../src/grid/keyboard';
import { anchorOf, cellsToDraw, mergeAt, mergeIndexOf } from '../src/grid/merges';
import { columnName, gridSize } from '../src/grid/model';
import { offsetsOf } from '../src/grid/useGridVirtualizers';
import { syntheticModel } from './support/syntheticModel';

const tall = { top: 0, left: 0, bottom: 9, right: 0 };

test('column names run A to Z, then AA', () => {
  expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
});

test('a cell inside a merge resolves to the anchor', () => {
  expect(anchorOf([tall], { row: 4, col: 0 })).toEqual({ row: 0, col: 0 });
  expect(anchorOf([tall], { row: 4, col: 1 })).toEqual({ row: 4, col: 1 });
});

test('covered cells are not drawn, and an off-screen anchor of a merge on screen is', () => {
  expect(cellsToDraw([5, 6], [0, 1], [tall], { row: 6, col: 1 })).toEqual([
    { row: 0, cells: [{ col: 0, merge: tall }] },
    { row: 5, cells: [{ col: 1 }] },
    { row: 6, cells: [{ col: 1 }] },
  ]);
});

test('merges entirely off screen are not drawn, and the focused cell always is', () => {
  const offScreen = { top: 50, left: 0, bottom: 60, right: 3 };
  expect(cellsToDraw([5], [0], [offScreen], { row: 900, col: 40 })).toEqual([
    { row: 5, cells: [{ col: 0 }] },
    { row: 900, cells: [{ col: 40 }] },
  ]);
});

test('frozen and scrolled rows are separate spans: a merge in the gap between them is off screen', () => {
  const inTheGap = { top: 3, left: 0, bottom: 8, right: 0 };
  expect(cellsToDraw([0, 1, 20, 21], [0], [inTheGap], { row: 0, col: 0 })).toEqual([
    { row: 0, cells: [{ col: 0 }] },
    { row: 1, cells: [{ col: 0 }] },
    { row: 20, cells: [{ col: 0 }] },
    { row: 21, cells: [{ col: 0 }] },
  ]);
});

test('keys step over merged ranges and stop at the edges of the sheet', () => {
  const model = syntheticModel({ rows: 10, cols: 10, merges: [{ top: 1, left: 1, bottom: 3, right: 4 }] });
  const press = (key: string, row: number, col: number, ctrlKey = false): unknown =>
    cellAfterKey({ key, ctrlKey, metaKey: false }, { row, col }, model, 3);
  expect(press('ArrowRight', 2, 0)).toEqual({ row: 1, col: 1 });
  expect(press('ArrowRight', 1, 1)).toEqual({ row: 1, col: 5 });
  expect(press('ArrowDown', 1, 1)).toEqual({ row: 4, col: 1 });
  expect(press('ArrowUp', 0, 0)).toEqual({ row: 0, col: 0 });
  expect(press('End', 5, 2, true)).toEqual({ row: 9, col: 9 });
  expect(press('Home', 5, 2)).toEqual({ row: 5, col: 0 });
  expect(press('a', 5, 2)).toBeUndefined();
  expect(press('PageDown', 2, 0)).toEqual({ row: 5, col: 0 });
  expect(press('PageDown', 8, 6)).toEqual({ row: 9, col: 6 });
  expect(press('PageUp', 5, 7)).toEqual({ row: 2, col: 7 });
  expect(press('PageUp', 4, 2)).toEqual({ row: 1, col: 1 });
});

const viewportRows = Array.from({ length: 40 }, (_, index) => 10_000 + index);
const viewportCols = Array.from({ length: 15 }, (_, index) => 200 + index);

test('100,000 merges: the index is built once and a viewport looks at a bounded number of them', () => {
  const merges = Array.from({ length: 100_000 }, (_, index) => {
    const top = Math.floor(index / 5) * 2;
    const left = (index % 5) * 100;
    return { top, left, bottom: top + 1, right: left + 2 };
  });
  const index = mergeIndexOf(merges);
  expect(mergeIndexOf(merges)).toBe(index);
  const before = index.work.visited;
  const drawn = cellsToDraw(viewportRows, viewportCols, merges, { row: 0, col: 0 });
  expect(index.work.visited - before).toBeLessThan(2_000);
  expect(drawn.find((row) => row.row === 10_000)?.cells.find((cell) => cell.col === 200)?.merge).toEqual({
    top: 10_000,
    left: 200,
    bottom: 10_001,
    right: 202,
  });
  const lookupsBefore = index.work.visited;
  for (let row = 0; row < 100; row++) mergeAt(merges, 50_000 + row, 7);
  expect((index.work.visited - lookupsBefore) / 100).toBeLessThan(130);
});

test('100,000 identical merges over the whole sheet cost bounded work per render', () => {
  const whole = { top: 0, left: 0, bottom: 19_999, right: 499 };
  const merges = Array.from({ length: 100_000 }, () => ({ ...whole }));
  const index = mergeIndexOf(merges);
  cellsToDraw(viewportRows, viewportCols, merges, { row: 10_000, col: 200 });
  expect(index.work.visited).toBeLessThanOrEqual(4_000);
});

test('grid sizes are finite and clamped whatever the model reports, so offsets always increase', () => {
  expect([Number.NaN, Infinity, -5, 0, 0.5, 1e308].map((size) => gridSize(size, 'row'))).toEqual([
    20, 20, 20, 20, 12, 2000,
  ]);
  expect([Number.NaN, 0.5, 1e308].map((size) => gridSize(size, 'col'))).toEqual([64, 24, 3000]);
  const offsets = offsetsOf(4, (index) => [Number.NaN, -1, 1e300, 30][index]!, 'row');
  expect([...offsets]).toEqual([0, 20, 40, 2040, 2070]);
});
