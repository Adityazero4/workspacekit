import type { CellAddress, CellRange } from './model';

/**
 * A run of consecutive row or column indexes, inclusive.
 *
 * @example
 * ```ts
 * const firstTen: Span = { first: 0, last: 9 };
 * ```
 */
export interface Span {
  first: number;
  last: number;
}

/**
 * One cell the grid draws: its column, and the merged range it anchors, if any.
 *
 * @example
 * ```ts
 * const anchor: DrawnCell = { col: 0, merge: { top: 0, left: 0, bottom: 2, right: 0 } };
 * ```
 */
export interface DrawnCell {
  col: number;
  merge?: CellRange;
}

/**
 * One row the grid draws and the cells drawn in it.
 *
 * @example
 * ```ts
 * const drawn: DrawnRow = { row: 4, cells: [{ col: 0 }, { col: 1 }] };
 * ```
 */
export interface DrawnRow {
  row: number;
  cells: DrawnCell[];
}

const CHUNK = 64;
const MOST_MERGES_ON_SCREEN = 2_000;
const MOST_COVERED_CELL_VISITS = 20_000;

/**
 * Merged ranges indexed for overlap queries: sorted by top row in chunks of 64 that record their lowest
 * bottom row, so a query skips every chunk that ends above it and stops at the first range starting below
 * it. `visited` counts the ranges looked at, for tests.
 *
 * @example
 * ```ts
 * const index = mergeIndexOf(model.merges);
 * index.overlapping({ first: 0, last: 40 }, { first: 0, last: 12 }, 100);
 * ```
 */
export interface MergeIndex {
  overlapping: (rows: Span, cols: Span, limit: number) => CellRange[];
  at: (row: number, col: number) => CellRange | undefined;
  work: { visited: number };
}

const indexes = new WeakMap<readonly CellRange[], MergeIndex>();

function buildIndex(merges: readonly CellRange[]): MergeIndex {
  const sorted = [...merges].sort((a, b) => a.top - b.top);
  const chunkBottoms = Array.from({ length: Math.ceil(sorted.length / CHUNK) }, (_, chunk) =>
    sorted
      .slice(chunk * CHUNK, (chunk + 1) * CHUNK)
      .reduce((lowest, merge) => Math.max(lowest, merge.bottom), -1),
  );
  const work = { visited: 0 };
  const startingAtOrAbove = (row: number): number => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sorted[middle]!.top <= row) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const overlapping = (rows: Span, cols: Span, limit: number): CellRange[] => {
    const found: CellRange[] = [];
    const end = startingAtOrAbove(rows.last);
    for (let chunk = 0; chunk * CHUNK < end && found.length < limit; chunk++) {
      if (chunkBottoms[chunk]! < rows.first) continue;
      for (
        let index = chunk * CHUNK;
        index < Math.min(end, (chunk + 1) * CHUNK) && found.length < limit;
        index++
      ) {
        work.visited++;
        const merge = sorted[index]!;
        if (merge.bottom >= rows.first && merge.left <= cols.last && merge.right >= cols.first) {
          found.push(merge);
        }
      }
    }
    return found;
  };
  const at = (row: number, col: number): CellRange | undefined =>
    overlapping({ first: row, last: row }, { first: col, last: col }, 1)[0];
  return { overlapping, at, work };
}

/**
 * The index of a merge list, built once per list (cached by the list's identity).
 *
 * @example
 * ```ts
 * mergeIndexOf(model.merges).at(4, 2);
 * ```
 */
export function mergeIndexOf(merges: readonly CellRange[]): MergeIndex {
  let index = indexes.get(merges);
  if (!index) {
    index = buildIndex(merges);
    indexes.set(merges, index);
  }
  return index;
}

/**
 * The merged range covering a cell, if any.
 *
 * @example
 * ```ts
 * mergeAt([{ top: 0, left: 0, bottom: 1, right: 1 }], 1, 1); // the range
 * ```
 */
export function mergeAt(merges: readonly CellRange[], row: number, col: number): CellRange | undefined {
  return mergeIndexOf(merges).at(row, col);
}

/**
 * The anchor (top-left cell) of the merged range covering a cell, or the cell itself.
 *
 * @example
 * ```ts
 * anchorOf([{ top: 0, left: 0, bottom: 1, right: 1 }], { row: 1, col: 1 }); // { row: 0, col: 0 }
 * ```
 */
export function anchorOf(merges: readonly CellRange[], cell: CellAddress): CellAddress {
  const merge = mergeAt(merges, cell.row, cell.col);
  return merge ? { row: merge.top, col: merge.left } : cell;
}

function spansOf(sortedIndexes: readonly number[]): Span[] {
  const spans: Span[] = [];
  for (const index of sortedIndexes) {
    const previous = spans.at(-1);
    if (previous && previous.last === index - 1) previous.last = index;
    else spans.push({ first: index, last: index });
  }
  return spans;
}

function mergesOnScreen(index: MergeIndex, rows: readonly number[], cols: readonly number[]): CellRange[] {
  const found = new Set<CellRange>();
  for (const rowSpan of spansOf(rows)) {
    for (const colSpan of spansOf(cols)) {
      for (const merge of index.overlapping(rowSpan, colSpan, MOST_MERGES_ON_SCREEN - found.size)) {
        found.add(merge);
      }
    }
  }
  return [...found];
}

function coveredCells(
  merges: readonly CellRange[],
  rows: readonly number[],
  cols: readonly number[],
): Set<number> {
  const covered = new Set<number>();
  let visits = 0;
  const stride = (cols.at(-1) ?? 0) + 1;
  for (const merge of merges) {
    const mergeRows = rows.filter((row) => row >= merge.top && row <= merge.bottom);
    const mergeCols = cols.filter((col) => col >= merge.left && col <= merge.right);
    visits += mergeRows.length * mergeCols.length;
    if (visits > MOST_COVERED_CELL_VISITS) break;
    for (const row of mergeRows) {
      for (const col of mergeCols) {
        if (row !== merge.top || col !== merge.left) covered.add(row * stride + col);
      }
    }
  }
  return covered;
}

/**
 * Which cells to draw for the rows and columns on screen (both sorted ascending). Cells covered by a merged
 * range are left out except its anchor, which is drawn even when its own row or column is off screen, so a
 * merge that is partly visible still shows. `pinned` (the focused cell) is always drawn, so the grid keeps
 * its tab stop while that cell is scrolled away. The work is bounded whatever the merge list holds: at most
 * 2,000 merges are honoured on screen, and marking covered cells stops after 20,000 visits.
 *
 * @example
 * ```ts
 * cellsToDraw([5, 6], [0, 1], [{ top: 0, left: 0, bottom: 9, right: 0 }], { row: 0, col: 0 });
 * // [{ row: 0, cells: [{ col: 0, merge }] }, { row: 5, cells: [{ col: 1 }] },
 * //  { row: 6, cells: [{ col: 1 }] }]
 * ```
 */
export function cellsToDraw(
  rows: readonly number[],
  cols: readonly number[],
  merges: readonly CellRange[],
  pinned: CellAddress,
): DrawnRow[] {
  const onScreen = mergesOnScreen(mergeIndexOf(merges), rows, cols);
  const covered = coveredCells(onScreen, rows, cols);
  const stride = (cols.at(-1) ?? 0) + 1;
  const drawn = new Map<number, DrawnCell[]>();
  for (const row of rows) {
    drawn.set(
      row,
      cols.filter((col) => !covered.has(row * stride + col)).map((col) => ({ col })),
    );
  }
  const draw = (row: number, cell: DrawnCell): void => {
    const cells = drawn.get(row);
    if (!cells) drawn.set(row, [cell]);
    else if (!cells.some((drawnCell) => drawnCell.col === cell.col)) cells.push(cell);
    else if (cell.merge) cells.find((drawnCell) => drawnCell.col === cell.col)!.merge = cell.merge;
  };
  for (const merge of onScreen) draw(merge.top, { col: merge.left, merge });
  draw(pinned.row, { col: pinned.col, merge: mergeAt(merges, pinned.row, pinned.col) });
  return [...drawn].sort(([a], [b]) => a - b).map(([row, cells]) => ({ row, cells }));
}
