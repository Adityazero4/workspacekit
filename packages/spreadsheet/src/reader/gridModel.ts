import {
  clampFrozen,
  gridSize,
  columnName,
  type CellAddress,
  type CellRange,
  type GridCell,
  type GridModel,
} from '../grid/model';
import { MOST_MERGES, type CellKind, type SheetData } from './types';

const PADDED_ROWS = 50;
const PADDED_COLS = 26;
const DEFAULT_ROW_HEIGHT_PX = 20;
const DEFAULT_COL_WIDTH_PX = 64;
const DEFAULT_ALIGNMENT: Record<CellKind, GridCell['align']> = {
  text: 'left',
  number: 'right',
  boolean: 'center',
  error: 'center',
};

/**
 * The grid model of a sheet, plus `displayCellOf`, which turns a cell in the sheet's own indexes (as search
 * returns them) into the grid's display indexes, or `undefined` when its row or column is hidden.
 *
 * @example
 * ```ts
 * model.displayCellOf({ row: 2, col: 0 }); // { row: 1, col: 0 } when row 2 is below a hidden row
 * ```
 */
export interface SheetGridModel extends GridModel {
  displayCellOf: (cell: CellAddress) => CellAddress | undefined;
}

interface Axis {
  displayOf: Int32Array;
  toSource: Int32Array;
  toDisplayAtOrAfter: Int32Array;
  toDisplayAtOrBefore: Int32Array;
}

function axisOf(sourceCount: number, paddedCount: number, hidden: Uint8Array): Axis {
  const shown: number[] = [];
  const displayOf = new Int32Array(sourceCount).fill(-1);
  for (let source = 0; source < paddedCount; source++) {
    if (hidden[source]) continue;
    if (source < sourceCount) displayOf[source] = shown.length;
    shown.push(source);
  }
  const toDisplayAtOrAfter = new Int32Array(sourceCount);
  const toDisplayAtOrBefore = new Int32Array(sourceCount);
  for (let source = sourceCount - 1, next = -1; source >= 0; source--) {
    if (displayOf[source] !== -1) next = displayOf[source]!;
    toDisplayAtOrAfter[source] = next;
  }
  for (let source = 0, previous = -1; source < sourceCount; source++) {
    if (displayOf[source] !== -1) previous = displayOf[source]!;
    toDisplayAtOrBefore[source] = previous;
  }
  return { displayOf, toSource: Int32Array.from(shown), toDisplayAtOrAfter, toDisplayAtOrBefore };
}

function displayMerges(sheet: SheetData, rows: Axis, cols: Axis): CellRange[] {
  const merges: CellRange[] = [];
  for (const merge of sheet.merges.slice(0, MOST_MERGES)) {
    const top = rows.toDisplayAtOrAfter[merge.top]!;
    const left = cols.toDisplayAtOrAfter[merge.left]!;
    const bottom = rows.toDisplayAtOrBefore[merge.bottom]!;
    const right = cols.toDisplayAtOrBefore[merge.right]!;
    const isOneCell = top === bottom && left === right;
    if (top !== -1 && left !== -1 && bottom >= top && right >= left && !isOneCell) {
      merges.push({ top, left, bottom, right });
    }
  }
  return merges;
}

function frozenOf(sheet: SheetData, rows: Axis, cols: Axis): { rows: number; cols: number } {
  const requested = clampFrozen(sheet.frozen, sheet.rowCount, sheet.colCount);
  return {
    rows: requested.rows > 0 ? rows.toDisplayAtOrBefore[requested.rows - 1]! + 1 : 0,
    cols: requested.cols > 0 ? cols.toDisplayAtOrBefore[requested.cols - 1]! + 1 : 0,
  };
}

function cellIndexOf(sheet: SheetData): Int32Array {
  const index = new Int32Array(sheet.rowCount * sheet.colCount).fill(-1);
  for (let cell = 0; cell < sheet.cellTexts.length; cell++) {
    index[sheet.cellRows[cell]! * sheet.colCount + sheet.cellCols[cell]!] = cell;
  }
  return index;
}

/**
 * Adapts a sheet read by the reader to the grid's model. Hidden rows and columns are left out while the
 * headers keep their original numbers and letters, so the gaps show. A merged range anchors on its first
 * visible row and column. A sheet with content is padded to at least 50 rows × 26 columns; an empty sheet
 * stays empty (0 rows). Cells are looked up through an index, never copied.
 *
 * @example
 * ```tsx
 * <Grid model={sheetGridModel(sheet)} aria-label={sheet.name} />
 * ```
 */
export function sheetGridModel(sheet: SheetData): SheetGridModel {
  const hasContent = sheet.rowCount > 0 && sheet.colCount > 0;
  const rows = axisOf(
    sheet.rowCount,
    hasContent ? Math.max(sheet.rowCount, PADDED_ROWS) : 0,
    sheet.hiddenRows,
  );
  const cols = axisOf(
    sheet.colCount,
    hasContent ? Math.max(sheet.colCount, PADDED_COLS) : 0,
    sheet.hiddenCols,
  );
  const index = cellIndexOf(sheet);
  return {
    rowCount: rows.toSource.length,
    colCount: cols.toSource.length,
    cell: (row, col) => {
      const sourceRow = rows.toSource[row]!;
      const sourceCol = cols.toSource[col]!;
      if (sourceRow >= sheet.rowCount || sourceCol >= sheet.colCount) return undefined;
      const cell = index[sourceRow * sheet.colCount + sourceCol]!;
      if (cell === -1) return undefined;
      const kind = sheet.cellKinds[cell]!;
      const format = sheet.formats[sheet.cellFormats[cell]!];
      return {
        text: sheet.cellTexts[cell]!,
        isNumber: kind === 'number',
        align: format?.align ?? DEFAULT_ALIGNMENT[kind],
        wrap: format?.wrap,
        style: format?.style,
      };
    },
    colWidth: (col) => gridSize(sheet.colWidths[cols.toSource[col]!] ?? DEFAULT_COL_WIDTH_PX, 'col'),
    rowHeight: (row) => gridSize(sheet.rowHeights[rows.toSource[row]!] ?? DEFAULT_ROW_HEIGHT_PX, 'row'),
    merges: displayMerges(sheet, rows, cols),
    frozen: frozenOf(sheet, rows, cols),
    displayCellOf: (cell) => {
      const row = rows.displayOf[cell.row] ?? -1;
      const col = cols.displayOf[cell.col] ?? -1;
      return row === -1 || col === -1 ? undefined : { row, col };
    },
    rowLabel: (row) => String(rows.toSource[row]! + 1),
    colLabel: (col) => columnName(cols.toSource[col]!),
  };
}
