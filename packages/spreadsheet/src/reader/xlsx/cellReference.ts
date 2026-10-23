import type { CellRange } from '../../grid/model';

const CODE_OF_A = 65;
const CODE_OF_Z = 90;
const CODE_OF_ZERO = 48;
const CODE_OF_NINE = 57;
const LOWER_TO_UPPER = 32;
const LETTERS = 26;

/**
 * Reads an A1-style reference (`AB12`, `$C$3`) into zero-based indexes with one linear pass, or
 * `undefined` when it is not one.
 *
 * @example
 * ```ts
 * parseCellReference('B3'); // { row: 2, col: 1 }
 * ```
 */
export function parseCellReference(reference: string): { row: number; col: number } | undefined {
  let col = 0;
  let row = 0;
  let index = 0;
  if (reference[index] === '$') index++;
  for (; index < reference.length; index++) {
    let code = reference.charCodeAt(index);
    if (code > CODE_OF_Z) code -= LOWER_TO_UPPER;
    if (code < CODE_OF_A || code > CODE_OF_Z) break;
    col = col * LETTERS + (code - CODE_OF_A + 1);
  }
  if (reference[index] === '$') index++;
  const digitsStart = index;
  for (; index < reference.length; index++) {
    const code = reference.charCodeAt(index);
    if (code < CODE_OF_ZERO || code > CODE_OF_NINE) return undefined;
    row = row * 10 + (code - CODE_OF_ZERO);
  }
  if (col === 0 || index === digitsStart || row === 0) return undefined;
  return { row: row - 1, col: col - 1 };
}

/**
 * Reads an A1-style range (`A1:C3`, or a single cell) into a zero-based `CellRange`.
 *
 * @example
 * ```ts
 * parseRangeReference('B2:C4'); // { top: 1, left: 1, bottom: 3, right: 2 }
 * ```
 */
export function parseRangeReference(reference: string): CellRange | undefined {
  const colon = reference.indexOf(':');
  const start = parseCellReference(colon === -1 ? reference : reference.slice(0, colon));
  const end = colon === -1 ? start : parseCellReference(reference.slice(colon + 1));
  if (!start || !end) return undefined;
  return {
    top: Math.min(start.row, end.row),
    left: Math.min(start.col, end.col),
    bottom: Math.max(start.row, end.row),
    right: Math.max(start.col, end.col),
  };
}
