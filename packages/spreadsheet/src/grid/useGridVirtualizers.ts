'use client';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { clampFrozen, gridSize, type CellAddress, type GridModel } from './model';

const ROW_OVERSCAN = 4;
const COLUMN_OVERSCAN = 2;

/**
 * Where each row or column starts: `offsets[i]` is the sum of the sizes before `i`, and `offsets[count]`
 * the total. Every size goes through `gridSize` first, so the offsets are finite and increasing whatever
 * the model reports.
 *
 * @example
 * ```ts
 * offsetsOf(3, () => 10, 'row'); // Float64Array [0, 10, 20, 30]
 * ```
 */
export function offsetsOf(
  count: number,
  sizeOf: (index: number) => number,
  axis: 'row' | 'col',
): Float64Array {
  const offsets = new Float64Array(count + 1);
  for (let index = 0; index < count; index++) {
    offsets[index + 1] = offsets[index]! + gridSize(sizeOf(index), axis);
  }
  return offsets;
}

/**
 * The grid's geometry: the offsets of rows and columns, and the sizes of the sticky column-letter header
 * and row-number column, which the scrolled cells start after.
 *
 * @example
 * ```ts
 * const geometry: GridGeometry = { rowOffsets, colOffsets, headerHeight: 24, rowHeaderWidth: 48 };
 * ```
 */
export interface GridGeometry {
  rowOffsets: Float64Array;
  colOffsets: Float64Array;
  headerHeight: number;
  rowHeaderWidth: number;
}

const indexesOf = (frozen: number, items: VirtualItem[]): number[] => [
  ...Array.from({ length: frozen }, (_, index) => index),
  ...items.map((item) => item.index).filter((index) => index >= frozen),
];

const sameOffsets = (previous: Float64Array, next: Float64Array): boolean =>
  previous === next ||
  (previous.length === next.length && previous.every((offset, index) => Object.is(offset, next[index])));

const sizeAt =
  (offsets: Float64Array) =>
  (index: number): number =>
    offsets[index + 1]! - offsets[index]!;

function frozenThatFit(requested: number, offsets: Float64Array, room: number | null): number {
  if (room === null || room <= 0) return requested;
  let count = requested;
  while (count > 0 && offsets[count]! > room) count--;
  return count;
}

function scrollToShow(
  start: number,
  end: number,
  scroll: number,
  size: number,
  hiddenAtStart: number,
): number {
  if (start - hiddenAtStart < scroll) return start - hiddenAtStart;
  if (end > scroll + size) return Math.min(start - hiddenAtStart, end - size);
  return scroll;
}

function revealCell(
  viewport: HTMLElement | null,
  cell: CellAddress,
  frozen: { rows: number; cols: number },
  geometry: GridGeometry,
): void {
  if (!viewport) return;
  const { rowOffsets, colOffsets, headerHeight, rowHeaderWidth } = geometry;
  if (cell.row >= frozen.rows) {
    viewport.scrollTop = scrollToShow(
      rowOffsets[cell.row]! + headerHeight,
      rowOffsets[cell.row + 1]! + headerHeight,
      viewport.scrollTop,
      viewport.clientHeight,
      headerHeight + rowOffsets[frozen.rows]!,
    );
  }
  if (cell.col >= frozen.cols) {
    viewport.scrollLeft = scrollToShow(
      colOffsets[cell.col]! + rowHeaderWidth,
      colOffsets[cell.col + 1]! + rowHeaderWidth,
      viewport.scrollLeft,
      viewport.clientWidth,
      rowHeaderWidth + colOffsets[frozen.cols]!,
    );
  }
}

/**
 * The rows and columns on screen (frozen ones first, then the scrolled ones, both ascending), from one
 * vertical and one horizontal TanStack virtualizer over the same scroll element, sized from the clamped
 * offsets in `geometry`; `reveal`, which scrolls the least needed to show a cell clear of the sticky header,
 * row numbers and frozen panes; and `pageRows`, how many rows PageUp and PageDown move.
 *
 * @example
 * ```ts
 * const { rows, cols, reveal } = useGridVirtualizers(model, geometry, viewportRef);
 * ```
 */
export function useGridVirtualizers(
  model: GridModel,
  geometry: GridGeometry,
  viewportRef: RefObject<HTMLElement | null>,
): {
  rows: number[];
  cols: number[];
  frozen: { rows: number; cols: number };
  reveal: (cell: CellAddress) => void;
  pageRows: number;
} {
  'use no memo';
  const { rowOffsets, colOffsets, headerHeight, rowHeaderWidth } = geometry;
  // eslint-disable-next-line react-hooks/incompatible-library -- 'use no memo' keeps this hook uncompiled; it returns fresh values every render
  const rowVirtualizer = useVirtualizer({
    count: model.rowCount,
    getScrollElement: () => viewportRef.current,
    estimateSize: sizeAt(rowOffsets),
    paddingStart: headerHeight,
    overscan: ROW_OVERSCAN,
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: model.colCount,
    getScrollElement: () => viewportRef.current,
    estimateSize: sizeAt(colOffsets),
    paddingStart: rowHeaderWidth,
    overscan: COLUMN_OVERSCAN,
  });
  const measured = useRef({ rows: rowOffsets, cols: colOffsets });
  useLayoutEffect(() => {
    const previous = measured.current;
    if (sameOffsets(previous.rows, rowOffsets) && sameOffsets(previous.cols, colOffsets)) return;
    measured.current = { rows: rowOffsets, cols: colOffsets };
    rowVirtualizer.measure();
    colVirtualizer.measure();
  });
  const requested = clampFrozen(model.frozen, model.rowCount, model.colCount);
  const viewport = rowVirtualizer.scrollRect;
  const frozen = {
    rows: frozenThatFit(requested.rows, rowOffsets, viewport && viewport.height - headerHeight),
    cols: frozenThatFit(requested.cols, colOffsets, viewport && viewport.width - rowHeaderWidth),
  };
  const reveal = (cell: CellAddress): void => revealCell(viewportRef.current, cell, frozen, geometry);
  return {
    rows: indexesOf(frozen.rows, rowVirtualizer.getVirtualItems()),
    cols: indexesOf(frozen.cols, colVirtualizer.getVirtualItems()),
    frozen,
    reveal,
    pageRows: Math.max(1, rowVirtualizer.getVirtualItems().length - 2 * ROW_OVERSCAN - frozen.rows),
  };
}
