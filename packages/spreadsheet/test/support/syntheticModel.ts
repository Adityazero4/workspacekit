import { columnName, type CellRange, type GridCell, type GridModel } from '../../src/grid/model';

export interface SyntheticSheet {
  rows: number;
  cols: number;
  merges?: readonly CellRange[];
  frozen?: { rows: number; cols: number };
  spillingText?: boolean;
}

export const spreadMerges = (count: number, rows: number, cols: number): CellRange[] =>
  Array.from({ length: count }, (_, index) => {
    const top = Math.floor((index * rows) / count);
    const left = (index * 7) % (cols - 3);
    return { top, left, bottom: Math.min(rows - 1, top + 1), right: left + 2 };
  });

const LONG_TEXT = 'A heading long enough to spill over the empty cells to its right';

function syntheticCell(row: number, col: number, spillingText: boolean): GridCell | undefined {
  if (spillingText && col % 6 === 3) return undefined;
  if (spillingText && col % 6 === 2) return { text: `${LONG_TEXT} ${row}` };
  return col % 3 === 1
    ? { text: String(row * col), isNumber: true, align: 'right' }
    : { text: `${columnName(col)}${row + 1}` };
}

export function syntheticModel(sheet: SyntheticSheet): GridModel {
  return {
    rowCount: sheet.rows,
    colCount: sheet.cols,
    cell: (row, col) => syntheticCell(row, col, sheet.spillingText ?? false),
    colWidth: (col) => (col % 5 === 0 ? 120 : 90),
    rowHeight: (row) => (row % 10 === 0 ? 28 : 22),
    merges: sheet.merges ?? [],
    frozen: sheet.frozen ?? { rows: 0, cols: 0 },
  };
}
