import type { CellRange, CellStyle, WrapMode } from '../grid/model';

/**
 * The limits the reader works within. A sheet is read up to `maxRows` rows, `maxCols` columns and
 * `maxCells` cells, the row limit shrinking so rows × columns fits `maxCells`; the rest is cut off and the
 * sheet is marked truncated. An `.xlsx` larger than `maxCompressedBytes`, or whose parts would inflate past
 * `maxInflatedBytes`, is refused. `maxSharedStrings` caps the workbook's string table, and
 * `maxFormulaWork` the cells formula evaluation may visit.
 *
 * Text is bounded too: a cell's text is cut at `maxCellText` characters (Excel's own limit), and a sheet's
 * texts (and the shared string table, and the text formulas read and make) stop at `maxSheetText`
 * characters, after which further cells show empty and the sheet is marked truncated. XML nesting deeper
 * than `maxXmlDepth`, or a workbook with more than `maxXmlElements` elements, is `too_large`.
 *
 * @example
 * ```ts
 * const caps: ReaderCaps = { ...DEFAULT_CAPS, maxRows: 1_000 };
 * ```
 */
export interface ReaderCaps {
  maxRows: number;
  maxCols: number;
  maxCells: number;
  maxCompressedBytes: number;
  maxInflatedBytes: number;
  maxSharedStrings: number;
  maxFormulaWork: number;
  maxCellText: number;
  maxSheetText: number;
  maxXmlDepth: number;
  maxXmlElements: number;
}

const MEBIBYTE = 1024 * 1024;

/**
 * The most merged ranges kept per sheet; a sheet declaring more keeps the first 10,000 and says so with
 * `SheetData.hasTooManyMerges`.
 *
 * @example
 * ```ts
 * merges.slice(0, MOST_MERGES);
 * ```
 */
export const MOST_MERGES = 10_000;

/**
 * The default limits: 20,000 rows, 500 columns, 200,000 cells, 50 MiB compressed and 300 MiB inflated,
 * 32,767 characters per cell and 64 Mi characters of text per sheet, XML 256 elements deep and 20 million
 * elements per workbook.
 *
 * @example
 * ```ts
 * DEFAULT_CAPS.maxRows; // 20000
 * ```
 */
export const DEFAULT_CAPS: ReaderCaps = Object.freeze({
  maxRows: 20_000,
  maxCols: 500,
  maxCells: 200_000,
  maxCompressedBytes: 50 * MEBIBYTE,
  maxInflatedBytes: 300 * MEBIBYTE,
  maxSharedStrings: 1_000_000,
  maxFormulaWork: 2_000_000,
  maxCellText: 32_767,
  maxSheetText: 64 * MEBIBYTE,
  maxXmlDepth: 256,
  maxXmlElements: 20_000_000,
});

/**
 * The first `length` characters of `text` as a string of their own: a plain `slice` of a huge string can keep
 * the whole of it alive in memory, so a cut text is copied.
 *
 * @example
 * ```ts
 * detachedPrefix(hugeText, 32_767).length; // 32767
 * ```
 */
export function detachedPrefix(text: string, length: number): string {
  return text.length <= length ? text : ` ${text.slice(0, length)}`.slice(1);
}

/**
 * A running allowance of text characters: `take` cuts a text to `caps.maxCellText` and charges it to the
 * allowance of `caps.maxSheetText`; once that is spent, every further text is `''` and `isSpent` is true.
 *
 * @example
 * ```ts
 * const budget = textBudget(DEFAULT_CAPS);
 * const shown = budget.take(text);
 * ```
 */
export interface TextBudget {
  take: (text: string) => string;
  readonly isSpent: boolean;
}

/**
 * A fresh `TextBudget` for one sheet or part.
 *
 * @example
 * ```ts
 * textBudget({ ...DEFAULT_CAPS, maxSheetText: 10 }).take('a long piece of text'); // ''
 * ```
 */
export function textBudget(caps: ReaderCaps): TextBudget {
  let remaining = caps.maxSheetText;
  let isSpent = false;
  return {
    take: (text) => {
      if (isSpent) return '';
      const kept = detachedPrefix(text, caps.maxCellText);
      remaining -= kept.length;
      if (remaining >= 0) return kept;
      isSpent = true;
      return '';
    },
    get isSpent() {
      return isSpent;
    },
  };
}

/**
 * Counters of the work a read did, for tests and diagnostics: bytes inflated from the archive, XML
 * elements parsed, cells visited while evaluating formulas, cells of ranges built for formulas, and
 * characters of text formulas read or made.
 *
 * @example
 * ```ts
 * const work: ReadWork = newReadWork();
 * ```
 */
export interface ReadWork {
  inflatedBytes: number;
  xmlElements: number;
  formulaCells: number;
  formulaRangeCells: number;
  formulaText: number;
}

/**
 * Fresh, zeroed work counters.
 *
 * @example
 * ```ts
 * newReadWork(); // { inflatedBytes: 0, xmlElements: 0, formulaCells: 0, formulaRangeCells: 0, … }
 * ```
 */
export const newReadWork = (): ReadWork => ({
  inflatedBytes: 0,
  xmlElements: 0,
  formulaCells: 0,
  formulaRangeCells: 0,
  formulaText: 0,
});

/**
 * What kind of value a cell holds.
 *
 * @example
 * ```ts
 * const kind: CellKind = 'number';
 * ```
 */
export type CellKind = 'text' | 'number' | 'boolean' | 'error';

/**
 * The look of a cell as the workbook formats it: alignment, wrap mode and style.
 *
 * @example
 * ```ts
 * const format: CellFormat = { align: 'center', wrap: 'wrap', style: { bold: true } };
 * ```
 */
export interface CellFormat {
  align?: 'left' | 'center' | 'right';
  wrap?: WrapMode;
  style?: CellStyle;
}

/**
 * One sheet as read, in source indexes (hidden rows and columns included). Cells are stored column-wise:
 * cell `i` is at `cellRows[i]`, `cellCols[i]`, shows `cellTexts[i]` (display text, already formatted), is
 * of kind `cellKinds[i]` and looks like `formats[cellFormats[i]]`. `rowCount` × `colCount` is the extent
 * of the cells read; sizes are CSS px. `isTruncated` says the sheet had more than the caps let through,
 * and `hasTooManyMerges` that merged ranges past `MOST_MERGES` were dropped. Frozen counts are at most
 * 20 rows and 10 columns.
 *
 * @example
 * ```ts
 * const firstText = sheet.cellTexts[0];
 * ```
 */
export interface SheetData {
  name: string;
  rowCount: number;
  colCount: number;
  cellRows: Uint32Array;
  cellCols: Uint32Array;
  cellTexts: string[];
  cellKinds: CellKind[];
  cellFormats: Uint32Array;
  formats: CellFormat[];
  merges: CellRange[];
  rowHeights: Float64Array;
  colWidths: Float64Array;
  hiddenRows: Uint8Array;
  hiddenCols: Uint8Array;
  frozen: { rows: number; cols: number };
  isTruncated: boolean;
  hasTooManyMerges: boolean;
}

/**
 * The sheets of an opened workbook, in tab order: at most `MOST_SHEETS`, each name cut at
 * `LONGEST_SHEET_NAME` characters. `hasMoreSheets` is `true` when the workbook listed more.
 *
 * @example
 * ```ts
 * const info: WorkbookInfo = { sheets: [{ name: 'Sheet1', isHidden: false }] };
 * ```
 */
export interface WorkbookInfo {
  sheets: { name: string; isHidden: boolean }[];
  hasMoreSheets?: boolean;
}

/**
 * The most sheets a workbook lists: 1,024. A workbook listing more shows the first 1,024 and says so.
 *
 * @example
 * ```ts
 * sheetNames.slice(0, MOST_SHEETS);
 * ```
 */
export const MOST_SHEETS = 1024;

/**
 * The longest sheet name kept, Excel's own limit of 31 characters.
 *
 * @example
 * ```ts
 * name.slice(0, LONGEST_SHEET_NAME);
 * ```
 */
export const LONGEST_SHEET_NAME = 31;

/**
 * The file formats the reader opens: `xlsx` (and `xlsm`) and delimited text natively, the rest through an
 * injected SheetJS.
 *
 * @example
 * ```ts
 * const format: SpreadsheetFormat = 'csv';
 * ```
 */
export type SpreadsheetFormat = 'xlsx' | 'csv' | 'tsv' | 'xls' | 'xlsb' | 'ods';

/**
 * Why a workbook cannot be shown, matching the viewer's error kinds.
 *
 * @example
 * ```ts
 * throw new ReaderError('too_large', 'The workbook inflates past 300 MiB.');
 * ```
 */
export class ReaderError extends Error {
  /** The viewer error kind this maps to. */
  readonly kind: 'too_large' | 'load_error' | 'unsupported_media' | 'password_protected';

  constructor(kind: ReaderError['kind'], message: string) {
    super(message);
    this.name = 'ReaderError';
    this.kind = kind;
  }
}
