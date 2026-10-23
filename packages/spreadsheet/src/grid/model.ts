/**
 * A rectangle of cells, inclusive on every side, in the grid's display indexes (hidden rows and columns
 * already left out).
 *
 * @example
 * ```ts
 * const header: CellRange = { top: 0, left: 0, bottom: 0, right: 3 };
 * ```
 */
export interface CellRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/**
 * One cell's position in display indexes.
 *
 * @example
 * ```ts
 * const firstCell: CellAddress = { row: 0, col: 0 };
 * ```
 */
export interface CellAddress {
  row: number;
  col: number;
}

/**
 * How text that is wider than its cell is shown: it runs on into empty neighbours (`overflow`), breaks
 * onto more lines (`wrap`), or is cut at the cell's edge (`clip`).
 *
 * @example
 * ```ts
 * const wrap: WrapMode = 'wrap';
 * ```
 */
export type WrapMode = 'overflow' | 'wrap' | 'clip';

/**
 * The formatting a workbook gives a cell, as CSS values. Colours are CSS colour strings.
 *
 * @example
 * ```ts
 * const style: CellStyle = { bold: true, fill: '#fff2cc' };
 * ```
 */
export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  fill?: string;
  fontSize?: number;
}

/**
 * What the grid draws in one cell: its display text (already formatted), whether it is a number (numbers
 * that do not fit show `####`), its horizontal alignment, wrap mode and style.
 *
 * @example
 * ```ts
 * const total: GridCell = { text: '1,234.50', isNumber: true, align: 'right' };
 * ```
 */
export interface GridCell {
  text: string;
  isNumber?: boolean;
  align?: 'left' | 'center' | 'right';
  wrap?: WrapMode;
  style?: CellStyle;
}

/**
 * The sheet the grid shows, in display indexes. Cells are looked up through `cell` as they scroll into view
 * and never copied, so a model over a huge sheet costs only what is on screen. `rowLabel` and `colLabel`
 * name a row and a column in the headers (by default `1, 2, …` and `A, B, …`); a model that leaves out
 * hidden rows uses them to keep the original numbers, so the gaps show.
 *
 * @example
 * ```ts
 * const model: GridModel = {
 *   rowCount: 2,
 *   colCount: 2,
 *   cell: (row, col) => ({ text: `${row},${col}` }),
 *   colWidth: () => 100,
 *   rowHeight: () => 20,
 *   merges: [],
 *   frozen: { rows: 0, cols: 0 },
 * };
 * ```
 */
export interface GridModel {
  rowCount: number;
  colCount: number;
  cell: (row: number, col: number) => GridCell | undefined;
  colWidth: (col: number) => number;
  rowHeight: (row: number) => number;
  merges: readonly CellRange[];
  frozen: { rows: number; cols: number };
  rowLabel?: (row: number) => string;
  colLabel?: (col: number) => string;
}

/**
 * The most frozen rows and columns the grid keeps in view, whatever a workbook asks for: frozen panes are
 * always rendered, so a document freezing thousands of rows would otherwise defeat virtualization.
 *
 * @example
 * ```ts
 * Math.min(requested, MOST_FROZEN.rows);
 * ```
 */
export const MOST_FROZEN: { readonly rows: 20; readonly cols: 10 } = Object.freeze({ rows: 20, cols: 10 });

/**
 * Frozen counts clamped to `MOST_FROZEN` and to the sheet's size, as whole non-negative numbers.
 *
 * @example
 * ```ts
 * clampFrozen({ rows: 20_000, cols: 1 }, 100, 5); // { rows: 20, cols: 1 }
 * ```
 */
export function clampFrozen(
  frozen: { rows: number; cols: number },
  rowCount: number,
  colCount: number,
): { rows: number; cols: number } {
  const clamp = (value: number, most: number): number => Math.max(0, Math.min(Math.trunc(value) || 0, most));
  return {
    rows: clamp(frozen.rows, Math.min(MOST_FROZEN.rows, rowCount)),
    cols: clamp(frozen.cols, Math.min(MOST_FROZEN.cols, colCount)),
  };
}

const GRID_SIZES = Object.freeze({
  row: { least: 12, most: 2000, fallback: 20 },
  col: { least: 24, most: 3000, fallback: 64 },
});
const LEAST_FONT_POINTS = 1;
const MOST_FONT_POINTS = 409;

/**
 * A row height or column width the grid can lay out, whatever the model says: a size that is not a
 * positive finite number falls back to the default (20 px rows, 64 px columns), and the rest is clamped to
 * 12–2000 px for rows and 24–3000 px for columns. This keeps virtualization working, and the cells on
 * screen few, when a model reports 0, negative, NaN, tiny or huge sizes (a hidden row or column is left out
 * of the model, not given size 0).
 *
 * @example
 * ```ts
 * gridSize(Number.NaN, 'row'); // 20
 * gridSize(0.5, 'col'); // 24
 * ```
 */
export function gridSize(size: number, axis: 'row' | 'col'): number {
  const limits = GRID_SIZES[axis];
  if (!(Number.isFinite(size) && size > 0)) return limits.fallback;
  return Math.min(limits.most, Math.max(limits.least, size));
}

/**
 * A font size in points the grid will draw, or `undefined` outside 1–409 pt (or not a number).
 *
 * @example
 * ```ts
 * gridFontPoints(1e9); // undefined
 * ```
 */
export const gridFontPoints = (points: number | undefined): number | undefined =>
  points !== undefined && Number.isFinite(points) && points >= LEAST_FONT_POINTS && points <= MOST_FONT_POINTS
    ? points
    : undefined;

const LETTERS_IN_THE_ALPHABET = 26;
const CHAR_CODE_OF_A = 65;

/**
 * The spreadsheet name of a zero-based column index: `0` is `A`, `25` is `Z`, `26` is `AA`.
 *
 * @example
 * ```ts
 * columnName(27); // 'AB'
 * ```
 */
export function columnName(index: number): string {
  let name = '';
  for (
    let remaining = index + 1;
    remaining > 0;
    remaining = Math.floor((remaining - 1) / LETTERS_IN_THE_ALPHABET)
  ) {
    name = String.fromCharCode(CHAR_CODE_OF_A + ((remaining - 1) % LETTERS_IN_THE_ALPHABET)) + name;
  }
  return name;
}
