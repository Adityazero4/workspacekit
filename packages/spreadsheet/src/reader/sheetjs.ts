import type { CellRange } from '../grid/model';
import type { OpenBook } from './engine';
import { pxSize } from './geometry';
import {
  detachedPrefix,
  LONGEST_SHEET_NAME,
  MOST_MERGES,
  MOST_SHEETS,
  ReaderError,
  textBudget,
  type TextBudget,
  type CellKind,
  type ReaderCaps,
  type SheetData,
  type SpreadsheetFormat,
} from './types';

/**
 * The error shown for `.xls`, `.xlsb` and `.ods` when no SheetJS engine was passed, saying how to add one.
 *
 * @example
 * ```ts
 * throw sheetJsMissing('xls');
 * ```
 */
export const sheetJsMissing = (format: SpreadsheetFormat): ReaderError =>
  new ReaderError(
    'unsupported_media',
    `Opening .${format} files needs SheetJS. Install it with ` +
      '`npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` and pass ' +
      "`engines: { xlsx: () => import('xlsx') }` to spreadsheetRenderer or SpreadsheetViewer.",
  );

interface SheetJsCell {
  t: string;
  v?: string | number | boolean;
  w?: string;
}

interface SheetJsSheet {
  [address: string]: unknown;
  '!ref'?: string;
  '!merges'?: { s: { r: number; c: number }; e: { r: number; c: number } }[];
  '!cols'?: ({ wpx?: number; hidden?: boolean } | undefined)[];
  '!rows'?: ({ hpx?: number; hidden?: boolean } | undefined)[];
}

/**
 * The part of the SheetJS (`xlsx`) module the adapter uses.
 *
 * @example
 * ```ts
 * const sheetJs = (await import('xlsx')) as SheetJsModule;
 * ```
 */
export interface SheetJsModule {
  read: (
    data: Uint8Array,
    options: { type: 'array'; sheetRows: number; dense: false },
  ) => {
    SheetNames: string[];
    Sheets: Record<string, SheetJsSheet>;
    Workbook?: { Sheets?: { Hidden?: number }[] };
  };
  utils: {
    decode_range: (range: string) => { s: { r: number; c: number }; e: { r: number; c: number } };
    encode_cell: (cell: { r: number; c: number }) => string;
  };
}

const SHEETJS_KINDS: Record<string, CellKind> = { n: 'number', b: 'boolean', e: 'error' };
const DEFAULT_ROW_HEIGHT_PX = 20;
const DEFAULT_COL_WIDTH_PX = 64;

function cellsOfSheetJs(
  sheetJs: SheetJsModule,
  sheet: SheetJsSheet,
  extent: { rowCount: number; colCount: number },
  budget: TextBudget,
) {
  const { rowCount, colCount } = extent;
  const cells = {
    rows: [] as number[],
    cols: [] as number[],
    texts: [] as string[],
    kinds: [] as CellKind[],
  };
  for (let row = 0; row < rowCount; row++) {
    for (let col = 0; col < colCount; col++) {
      const cell = sheet[sheetJs.utils.encode_cell({ r: row, c: col })] as SheetJsCell | undefined;
      if (!cell || cell.t === 'z') continue;
      cells.rows.push(row);
      cells.cols.push(col);
      cells.texts.push(budget.take(cell.w ?? String(cell.v ?? '')));
      cells.kinds.push(SHEETJS_KINDS[cell.t] ?? 'text');
    }
  }
  return cells;
}

const countWithin = (lastIndex: number | undefined, most: number): number =>
  lastIndex !== undefined && Number.isFinite(lastIndex) ? Math.max(0, Math.min(lastIndex + 1, most)) : 0;

function sizeOf(
  record: { hpx?: number; wpx?: number; hidden?: boolean } | undefined,
  axis: 'row' | 'col',
): { px: number | undefined; isHidden: boolean } {
  const size = pxSize(axis === 'row' ? record?.hpx : record?.wpx, axis);
  return {
    px: typeof size === 'number' ? size : undefined,
    isHidden: Boolean(record?.hidden) || size === 'hidden',
  };
}

function mergesOfSheetJs(sheet: SheetJsSheet, rowCount: number, colCount: number): CellRange[] {
  return (sheet['!merges'] ?? [])
    .slice(0, MOST_MERGES)
    .filter((merge) => merge.s.r < rowCount && merge.s.c < colCount)
    .map((merge) => ({
      top: merge.s.r,
      left: merge.s.c,
      bottom: Math.min(merge.e.r, rowCount - 1),
      right: Math.min(merge.e.c, colCount - 1),
    }));
}

function sheetOfSheetJs(
  sheetJs: SheetJsModule,
  name: string,
  sheet: SheetJsSheet,
  caps: ReaderCaps,
): SheetData {
  const range = sheet['!ref'] ? sheetJs.utils.decode_range(sheet['!ref']) : undefined;
  const colCount = countWithin(range?.e.c, caps.maxCols);
  const rowLimit = Math.min(caps.maxRows, Math.floor(caps.maxCells / Math.max(colCount, 1)));
  const rowCount = countWithin(range?.e.r, rowLimit);
  const budget = textBudget(caps);
  const cells = cellsOfSheetJs(sheetJs, sheet, { rowCount, colCount }, budget);
  const rows = (sheet['!rows'] ?? []).map((row) => sizeOf(row, 'row'));
  const cols = (sheet['!cols'] ?? []).map((col) => sizeOf(col, 'col'));
  return {
    name,
    rowCount,
    colCount,
    cellRows: Uint32Array.from(cells.rows),
    cellCols: Uint32Array.from(cells.cols),
    cellTexts: cells.texts,
    cellKinds: cells.kinds,
    cellFormats: new Uint32Array(cells.texts.length),
    formats: [{}],
    merges: mergesOfSheetJs(sheet, rowCount, colCount),
    rowHeights: Float64Array.from({ length: rowCount }, (_, row) => rows[row]?.px ?? DEFAULT_ROW_HEIGHT_PX),
    colWidths: Float64Array.from({ length: colCount }, (_, col) => cols[col]?.px ?? DEFAULT_COL_WIDTH_PX),
    hiddenRows: Uint8Array.from({ length: rowCount }, (_, row) => (rows[row]?.isHidden ? 1 : 0)),
    hiddenCols: Uint8Array.from({ length: colCount }, (_, col) => (cols[col]?.isHidden ? 1 : 0)),
    frozen: { rows: 0, cols: 0 },
    isTruncated:
      budget.isSpent || (range !== undefined && (range.e.r + 1 > rowCount || range.e.c + 1 > colCount)),
    hasTooManyMerges: (sheet['!merges']?.length ?? 0) > MOST_MERGES,
  };
}

/**
 * Opens `.xls`, `.xlsb` or `.ods` with the SheetJS module the consumer injected (`engines.xlsx`), on the
 * main thread, reading at most `caps.maxRows` rows of each sheet. Without an engine it fails with the
 * "install SheetJS" message.
 *
 * @example
 * ```ts
 * const book = await openWithSheetJs(() => import('xlsx'), bytes, 'xls', DEFAULT_CAPS);
 * ```
 */
export async function openWithSheetJs(
  load: (() => Promise<unknown>) | undefined,
  bytes: Uint8Array,
  format: SpreadsheetFormat,
  caps: ReaderCaps,
): Promise<OpenBook> {
  if (!load) throw sheetJsMissing(format);
  const loaded = (await load()) as SheetJsModule & { default?: SheetJsModule };
  const sheetJs = loaded.default ?? loaded;
  const workbook = sheetJs.read(bytes, { type: 'array', sheetRows: caps.maxRows + 1, dense: false });
  const listed = workbook.SheetNames.slice(0, MOST_SHEETS);
  const sheets = listed.map((name, index) => ({
    name: detachedPrefix(name, LONGEST_SHEET_NAME),
    isHidden: Boolean(workbook.Workbook?.Sheets?.[index]?.Hidden),
  }));
  return {
    info: { sheets, ...(workbook.SheetNames.length > MOST_SHEETS ? { hasMoreSheets: true } : {}) },
    sheet: (index) => {
      const listedName = listed[index];
      const raw = listedName === undefined ? undefined : workbook.Sheets[listedName];
      if (!raw) {
        return Promise.reject(
          new ReaderError('load_error', `This workbook has no readable sheet number ${index + 1}.`),
        );
      }
      return Promise.resolve(sheetOfSheetJs(sheetJs, sheets[index]!.name, raw, caps));
    },
  };
}
