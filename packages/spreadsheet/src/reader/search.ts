import type { CellAddress } from '../grid/model';
import type { SheetData } from './types';

const MOST_SEARCH_MATCHES = 10_000;

/**
 * The cells whose display text contains `query`, ignoring case, in row then column order, at most 10,000.
 * Indexes are the sheet's own (hidden rows and columns included).
 *
 * @example
 * ```ts
 * findCells(sheet, 'total'); // [{ row: 9, col: 0 }]
 * ```
 */
export function findCells(sheet: SheetData, query: string): CellAddress[] {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  const matches: CellAddress[] = [];
  for (let index = 0; index < sheet.cellTexts.length && matches.length < MOST_SEARCH_MATCHES; index++) {
    if (sheet.cellTexts[index]!.toLowerCase().includes(needle)) {
      matches.push({ row: sheet.cellRows[index]!, col: sheet.cellCols[index]! });
    }
  }
  return matches.sort((a, b) => a.row - b.row || a.col - b.col);
}
