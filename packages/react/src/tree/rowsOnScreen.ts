'use client';
import type { VisibleRow, VisibleRowIndex } from '@workspacekit/core';
import { defaultRangeExtractor, useVirtualizer, type Range, type VirtualItem } from '@tanstack/react-virtual';
import { useEffect, useState, type RefObject } from 'react';
import type { UploadRun } from '../uploads/uploads';
import { uploadPlaceholderGroups } from '../uploads/placeholders';
import { createRowLayout, type RowLayout } from './rowLayout';
import { rowsCoveredAbove, stickyAncestors, stickyCapacity } from './StickyHeaders';
import type { FileTreeApi } from './useFileTree';

const OVERSCAN = 10;
const ROWS_IN_FIRST_PAINT = 50;

/**
 * What a tree renders in its viewport: the row layout (rows plus upload placeholders), the virtualized window
 * over it, and the sticky folder headers above it.
 *
 * @example
 * ```tsx
 * <div {...tree.getTreeProps()} style={{ height: rows.rowWindow.totalSize }} />
 * ```
 */
export interface RowsOnScreen {
  layout: RowLayout;
  rowWindow: RowWindow;
  headers: readonly VisibleRow[];
}

/**
 * Virtualizes `tree` (with the upload placeholders of `uploadRuns`) inside `viewport`, keeps the tab stop and
 * the row being renamed rendered, works out the sticky headers, and registers the tree's `scrollToIndex` so a
 * row scrolled into view is never left under them.
 *
 * @example
 * ```ts
 * const rows = useRowsOnScreen(tree, viewport, { uploadRuns, root: fs.root, stickyHeaders: true });
 * ```
 */
export function useRowsOnScreen(
  tree: FileTreeApi,
  viewport: RefObject<HTMLDivElement | null>,
  options: { uploadRuns: readonly UploadRun[]; root: string; stickyHeaders: boolean },
): RowsOnScreen {
  const layout = createRowLayout(
    tree.index.count,
    uploadPlaceholderGroups(options.uploadRuns, tree.index, options.root),
  );
  const rowWindow = useRowWindow(tree, layout, viewport);
  const stickyRows = options.stickyHeaders ? stickyCapacity(rowWindow.viewportHeight, tree.rowHeight) : 0;
  const headers = stickyAncestors(
    tree.index,
    layout.rowIndexAtOrAfter(rowWindow.firstVisibleIndex),
    stickyRows,
  );
  useEffect(() =>
    tree.setScrollToIndex((rowIndex) =>
      scrollRowIntoView(viewport.current, rowIndex, { ...tree, layout }, stickyRows),
    ),
  );
  return { layout, rowWindow, headers };
}

interface RowWindow {
  items: VirtualItem[];
  totalSize: number;
  firstVisibleIndex: number;
  viewportHeight: number;
}

function useRowWindow(
  tree: FileTreeApi,
  layout: RowLayout,
  viewport: RefObject<HTMLElement | null>,
): RowWindow {
  'use no memo';
  const { rowHeight } = tree;
  const renamingIndex = tree.renaming === null ? -1 : tree.index.indexOf(tree.renaming);
  const positionOfRow = (rowIndex: number): number => (rowIndex < 0 ? -1 : layout.positionOf(rowIndex));
  const rangeExtractor = useRangeExtractorStableUntilAKeptRowMoves(
    positionOfRow(tree.tabbableIndex),
    positionOfRow(renamingIndex),
  );
  // eslint-disable-next-line react-hooks/incompatible-library -- 'use no memo' keeps this hook uncompiled; it returns fresh values every render
  const virtualizer = useVirtualizer({
    count: layout.count,
    getScrollElement: () => viewport.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    initialRect: { width: 0, height: (ROWS_IN_FIRST_PAINT - OVERSCAN) * rowHeight },
    rangeExtractor,
  });
  return {
    items: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    firstVisibleIndex: virtualizer.range?.startIndex ?? 0,
    viewportHeight: virtualizer.scrollRect?.height ?? 0,
  };
}

interface RangeExtractorKeepingRows {
  tabStopIndex: number;
  renamingIndex: number;
  extract: (range: Range) => number[];
}

function rangeExtractorKeeping(tabStopIndex: number, renamingIndex: number): RangeExtractorKeepingRows {
  return {
    tabStopIndex,
    renamingIndex,
    extract: (range) => withRowsKeptRendered(defaultRangeExtractor(range), [tabStopIndex, renamingIndex]),
  };
}

function useRangeExtractorStableUntilAKeptRowMoves(
  tabStopIndex: number,
  renamingIndex: number,
): (range: Range) => number[] {
  const [current, setCurrent] = useState(() => rangeExtractorKeeping(tabStopIndex, renamingIndex));
  const keepsTheSameRows = current.tabStopIndex === tabStopIndex && current.renamingIndex === renamingIndex;
  if (keepsTheSameRows) return current.extract;
  const next = rangeExtractorKeeping(tabStopIndex, renamingIndex);
  setCurrent(next);
  return next.extract;
}

function withRowsKeptRendered(rowIndexes: number[], keptRowIndexes: number[]): number[] {
  const missing = keptRowIndexes.filter((kept) => kept >= 0 && !rowIndexes.includes(kept));
  if (missing.length === 0) return rowIndexes;
  return [...new Set([...rowIndexes, ...missing])].sort((a, b) => a - b);
}

function scrollRowIntoView(
  viewport: HTMLElement | null,
  rowIndex: number,
  tree: Pick<FileTreeApi, 'index' | 'rowHeight'> & { layout: RowLayout },
  stickyRows: number,
): void {
  if (!viewport) return;
  const { index, rowHeight, layout } = tree;
  const position = layout.positionOf(rowIndex);
  const rowTop = position * rowHeight;
  const coveredNow = stickyRowsAt(index, layout, viewport.scrollTop, rowHeight, stickyRows) * rowHeight;
  if (rowTop < viewport.scrollTop + coveredNow) {
    viewport.scrollTop = (position - rowsCoveredAbove(index, rowIndex, stickyRows)) * rowHeight;
  } else if (rowTop + rowHeight > viewport.scrollTop + viewport.clientHeight) {
    viewport.scrollTop = rowTop + rowHeight - viewport.clientHeight;
  }
}

function stickyRowsAt(
  index: VisibleRowIndex,
  layout: RowLayout,
  scrollTop: number,
  rowHeight: number,
  stickyRows: number,
): number {
  const firstRowInView = layout.rowIndexAtOrAfter(Math.floor(scrollTop / rowHeight));
  return stickyAncestors(index, firstRowInView, stickyRows).length;
}
