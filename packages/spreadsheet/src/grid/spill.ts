import { cellFont, textWidth } from './measure';
import { mergeAt } from './merges';
import type { GridCell, GridModel } from './model';

const CELL_PADDING_PX = 8;
const MOST_SPILLED_COLUMNS = 32;
const NUMBER_TOO_WIDE = '#';

/**
 * How one cell is drawn: its text (a number that does not fit becomes `####`) and, when its text runs on
 * into empty neighbours, the width it spills to.
 *
 * @example
 * ```ts
 * const shown: CellPresentation = { text: 'A long heading', spillWidth: 240 };
 * ```
 */
export interface CellPresentation {
  text: string;
  spillWidth?: number;
}

const blocksSpill = (model: GridModel, row: number, col: number): boolean => {
  const neighbour = model.cell(row, col);
  return (
    (neighbour !== undefined && (neighbour.text !== '' || neighbour.style?.fill !== undefined)) ||
    mergeAt(model.merges, row, col) !== undefined
  );
};

function spillWidthOf(model: GridModel, row: number, col: number, needed: number): number | undefined {
  let width = model.colWidth(col);
  const isFrozen = col < model.frozen.cols;
  const lastCol = Math.min(
    model.colCount - 1,
    col + MOST_SPILLED_COLUMNS,
    isFrozen ? model.frozen.cols - 1 : Infinity,
  );
  for (let next = col + 1; next <= lastCol && width < needed; next++) {
    if (blocksSpill(model, row, next)) break;
    width += model.colWidth(next);
  }
  return width > model.colWidth(col) ? width : undefined;
}

const canSpill = (cell: GridCell): boolean =>
  !cell.isNumber &&
  (cell.align ?? 'left') === 'left' &&
  (cell.wrap ?? 'overflow') === 'overflow' &&
  cell.style?.fill === undefined;

/**
 * Applies the spreadsheet drawing rules to one cell, measuring text on a canvas in the cell's own font:
 * a number wider than its column shows `####` (text is clipped instead), and left-aligned, unwrapped,
 * unfilled text spills right across empty neighbours, stopping at a non-empty, filled or merged cell or the
 * edge of the frozen columns. Merged anchors and wrapped or clipped cells never spill.
 *
 * @example
 * ```ts
 * presentCell(model, 0, 0, model.cell(0, 0)!, { family: 'system-ui', size: '13px' });
 * ```
 */
export function presentCell(
  model: GridModel,
  row: number,
  col: number,
  cell: GridCell,
  font: { family: string; size: string },
): CellPresentation {
  if (cell.text === '' || cell.wrap === 'wrap') return { text: cell.text };
  const room = model.colWidth(col) - CELL_PADDING_PX;
  const fontOfCell = cellFont(font, cell.style);
  const needed = textWidth(cell.text, fontOfCell);
  if (needed <= room) return { text: cell.text };
  if (cell.isNumber) {
    const signs = Math.max(1, Math.floor(room / textWidth(NUMBER_TOO_WIDE, fontOfCell)));
    return { text: NUMBER_TOO_WIDE.repeat(signs) };
  }
  if (!canSpill(cell) || mergeAt(model.merges, row, col)) return { text: cell.text };
  return { text: cell.text, spillWidth: spillWidthOf(model, row, col, needed + CELL_PADDING_PX) };
}
