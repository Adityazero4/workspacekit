import { clampFrozen, type CellRange } from '../../grid/model';
import {
  detachedPrefix,
  MOST_MERGES,
  ReaderError,
  type CellKind,
  type ReadWork,
  type ReaderCaps,
} from '../types';
import { colWidthPx, rowHeightPx, type DocumentSize } from '../geometry';
import { parseCellReference, parseRangeReference } from './cellReference';
import { attribute, xmlParser, type XmlHandlers } from './xml';
import type { ZipArchive } from './zip';

/**
 * One cell as read from the sheet, before display text is made: its raw value and kind, its formula
 * (or the shared formula it borrows) and whether the file stored the formula's result.
 *
 * @example
 * ```ts
 * const cell: RawCell = { row: 0, col: 0, kind: 'number', value: 42, styleIndex: 0, isCached: true };
 * ```
 */
export interface RawCell {
  row: number;
  col: number;
  kind: CellKind;
  value: number | string | boolean | undefined;
  styleIndex: number;
  formula?: string;
  sharedFormula?: number;
  isCached: boolean;
}

/**
 * A sheet as read, in source indexes, before formulas are evaluated and display text is made. Sizes are
 * CSS px.
 *
 * @example
 * ```ts
 * const sheet = readSheet(archive, 'xl/worksheets/sheet1.xml', 'Sheet1', sharedStrings, caps, work);
 * ```
 */
export interface RawSheet {
  name: string;
  cells: RawCell[];
  rowCount: number;
  colCount: number;
  merges: CellRange[];
  rowHeights: Map<number, number>;
  colWidths: Map<number, number>;
  hiddenRows: Set<number>;
  hiddenCols: Set<number>;
  defaultRowHeight: number;
  defaultColWidth: number;
  frozen: { rows: number; cols: number };
  sharedFormulas: Map<number, { formula: string; row: number; col: number }>;
  isTruncated: boolean;
  hasTooManyMerges: boolean;
}

const DEFAULT_ROW_HEIGHT_PX = 20;
const DEFAULT_COL_WIDTH_PX = 64;
const WHOLE_SHEET_COLUMN_SPAN = 1000;
const MOST_COLUMN_RECORDS = 1024;
const MOST_FORMULA_TEXT = 8192;
const MERGE_NAME = 'mergeCells';
const MOST_PREFIX_LENGTH = 32;

const isTrue = (value: string | undefined): boolean => value === '1' || value === 'true';

function emptySheet(name: string): RawSheet {
  return {
    name,
    cells: [],
    rowCount: 0,
    colCount: 0,
    merges: [],
    rowHeights: new Map(),
    colWidths: new Map(),
    hiddenRows: new Set(),
    hiddenCols: new Set(),
    defaultRowHeight: DEFAULT_ROW_HEIGHT_PX,
    defaultColWidth: DEFAULT_COL_WIDTH_PX,
    frozen: { rows: 0, cols: 0 },
    sharedFormulas: new Map(),
    isTruncated: false,
    hasTooManyMerges: false,
  };
}

function cellValue(
  type: string | undefined,
  text: string,
  sharedStrings: readonly string[],
): Pick<RawCell, 'kind' | 'value'> {
  switch (type) {
    case 's':
      return { kind: 'text', value: sharedStrings[Number(text)] ?? '' };
    case 'b':
      return { kind: 'boolean', value: text === '1' || text === 'true' };
    case 'e':
      return { kind: 'error', value: text };
    case 'str':
    case 'inlineStr':
    case 'd':
      return { kind: 'text', value: text };
    default: {
      const number = text.trim() === '' ? Number.NaN : Number(text);
      return Number.isFinite(number) ? { kind: 'number', value: number } : { kind: 'text', value: text };
    }
  }
}

function setSize(size: DocumentSize, index: number, sizes: Map<number, number>, hidden: Set<number>): void {
  if (size === 'hidden') hidden.add(index);
  else if (size !== undefined) sizes.set(index, size);
}

function onDefaultSizes(sheet: RawSheet, attributes: Record<string, string>): void {
  const rowHeight = rowHeightPx(Number(attribute(attributes, 'defaultRowHeight') ?? Number.NaN));
  const colWidth = colWidthPx(Number(attribute(attributes, 'defaultColWidth') ?? Number.NaN));
  if (typeof rowHeight === 'number') sheet.defaultRowHeight = rowHeight;
  if (typeof colWidth === 'number') sheet.defaultColWidth = colWidth;
}

function onColumnRecord(sheet: RawSheet, attributes: Record<string, string>, caps: ReaderCaps): void {
  const first = Number(attribute(attributes, 'min') ?? 1) - 1;
  const last = Number(attribute(attributes, 'max') ?? first + 1) - 1;
  if (!(last - first + 1 < WHOLE_SHEET_COLUMN_SPAN) || !(first >= 0)) return;
  const width = attribute(attributes, 'width');
  const size: DocumentSize = isTrue(attribute(attributes, 'hidden'))
    ? 'hidden'
    : width === undefined
      ? undefined
      : colWidthPx(Number(width));
  for (let col = first; col <= Math.min(last, caps.maxCols - 1); col++) {
    setSize(size, col, sheet.colWidths, sheet.hiddenCols);
  }
}

function onPane(sheet: RawSheet, attributes: Record<string, string>, caps: ReaderCaps): void {
  const state = attribute(attributes, 'state');
  if (state !== 'frozen' && state !== 'frozenSplit') return;
  const requested = {
    rows: Number(attribute(attributes, 'ySplit') ?? 0),
    cols: Number(attribute(attributes, 'xSplit') ?? 0),
  };
  sheet.frozen = clampFrozen(requested, caps.maxRows, caps.maxCols);
}

function layoutHandler(
  sheet: RawSheet,
  caps: ReaderCaps,
): (name: string, attributes: Record<string, string>) => void {
  let columnRecords = 0;
  return (name, attributes) => {
    if (name === 'pane') onPane(sheet, attributes, caps);
    else if (name === 'sheetFormatPr') onDefaultSizes(sheet, attributes);
    else if (name === 'col' && ++columnRecords <= MOST_COLUMN_RECORDS) {
      onColumnRecord(sheet, attributes, caps);
    } else onMergeElement(sheet, name, attributes);
  };
}

interface Capture {
  parts: string[];
  length: number;
  limit: number;
}

const newCapture = (limit: number): Capture => ({ parts: [], length: 0, limit });

function capture(into: Capture, text: string): void {
  const room = into.limit - into.length;
  if (room > 0) into.parts.push(room >= text.length ? text : text.slice(0, room));
  into.length += text.length;
}

const capturedText = (from: Capture): string => detachedPrefix(from.parts.join(''), from.limit);

interface CellInProgress {
  cell: RawCell;
  type: string | undefined;
  text: Capture;
  formula: Capture;
  sharedRange?: string;
}

function newCell(
  row: number,
  col: number,
  attributes: Record<string, string>,
  caps: ReaderCaps,
): CellInProgress {
  const cell: RawCell = {
    row,
    col,
    kind: 'text',
    value: undefined,
    styleIndex: Number(attribute(attributes, 's') ?? 0),
    isCached: false,
  };
  return {
    cell,
    type: attribute(attributes, 't'),
    text: newCapture(caps.maxCellText),
    formula: newCapture(MOST_FORMULA_TEXT),
  };
}

function openFormula(current: CellInProgress, attributes: Record<string, string>): Capture {
  const shared = attribute(attributes, 't') === 'shared' ? attribute(attributes, 'si') : undefined;
  if (shared !== undefined) current.cell.sharedFormula = Number(shared);
  current.sharedRange = attribute(attributes, 'ref');
  return current.formula;
}

function rowHandler(sheet: RawSheet, caps: ReaderCaps, stop: () => void) {
  let row = -1;
  return {
    current: (): number => row,
    open: (attributes: Record<string, string>): void => {
      const number = Number(attribute(attributes, 'r') ?? Number.NaN);
      row = Number.isInteger(number) && number > 0 ? number - 1 : row + 1;
      if (row >= caps.maxRows) return stop();
      const height = attribute(attributes, 'ht');
      const size = isTrue(attribute(attributes, 'hidden'))
        ? 'hidden'
        : height === undefined
          ? undefined
          : rowHeightPx(Number(height));
      setSize(size, row, sheet.rowHeights, sheet.hiddenRows);
    },
  };
}

function sheetDataHandlers(sheet: RawSheet, sharedStrings: readonly string[], caps: ReaderCaps) {
  let lastCol = -1;
  let cellsSeen = 0;
  let current: CellInProgress | undefined;
  let into: Capture | undefined;
  let isStopped = false;
  let isReadingMerges = false;
  const stop = (): void => {
    isStopped = true;
    sheet.isTruncated = true;
  };
  const rows = rowHandler(sheet, caps, stop);
  const onLayout = layoutHandler(sheet, caps);
  const openCell = (attributes: Record<string, string>): void => {
    const reference = parseCellReference(attribute(attributes, 'r') ?? '');
    lastCol = reference?.col ?? lastCol + 1;
    if (++cellsSeen > caps.maxCells) return stop();
    if (lastCol >= caps.maxCols) sheet.isTruncated = true;
    else if (rows.current() >= 0) current = newCell(rows.current(), lastCol, attributes, caps);
  };
  return {
    isStopped: (): boolean => isStopped,
    isReadingMerges: (): boolean => isReadingMerges,
    open: (name: string, attributes: Record<string, string>): void => {
      if (name === 'mergeCells') isReadingMerges = true;
      if (isStopped) return onMergeElement(sheet, name, attributes);
      if (name === 'row') {
        rows.open(attributes);
        lastCol = -1;
      } else if (name === 'c') openCell(attributes);
      else if (current && (name === 'v' || name === 't')) into = current.text;
      else if (current && name === 'f') into = openFormula(current, attributes);
      else onLayout(name, attributes);
    },
    close: (name: string): void => {
      if (name === 'v' || name === 't' || name === 'f') into = undefined;
      else if (name === 'c' && current) {
        finishCell(sheet, current, sharedStrings);
        current = undefined;
      }
    },
    text: (text: string): void => {
      if (into) capture(into, text);
    },
  };
}

function finishCell(sheet: RawSheet, inProgress: CellInProgress, sharedStrings: readonly string[]): void {
  const { cell } = inProgress;
  const isFormulaKept = inProgress.formula.length <= inProgress.formula.limit;
  const formula = isFormulaKept ? capturedText(inProgress.formula) : '';
  const hasValue = inProgress.text.parts.length > 0;
  if (formula !== '') cell.formula = formula;
  if (!isFormulaKept) cell.sharedFormula = undefined;
  if (formula !== '' && cell.sharedFormula !== undefined && inProgress.sharedRange !== undefined) {
    sheet.sharedFormulas.set(cell.sharedFormula, { formula, row: cell.row, col: cell.col });
  }
  if (hasValue) Object.assign(cell, cellValue(inProgress.type, capturedText(inProgress.text), sharedStrings));
  cell.isCached = hasValue;
  const isPartOfTheSheet =
    hasValue || cell.formula !== undefined || cell.sharedFormula !== undefined || cell.styleIndex > 0;
  if (isPartOfTheSheet) sheet.cells.push(cell);
}

const isNameCharacter = (character: string | undefined): boolean =>
  character !== undefined &&
  ((character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z') ||
    (character >= '0' && character <= '9') ||
    character === ':' ||
    character === '_' ||
    character === '-' ||
    character === '.');

function mergeTagStart(window: string): number {
  for (let found = window.indexOf(MERGE_NAME); found !== -1; found = window.indexOf(MERGE_NAME, found + 1)) {
    let start = found;
    while (start > 0 && found - start < MOST_PREFIX_LENGTH && isNameCharacter(window[start - 1])) start--;
    const isPrefixed = start === found || window[found - 1] === ':';
    if (window[start - 1] === '<' && isPrefixed) return start - 1;
  }
  return -1;
}

function mergeScanner(sheet: RawSheet, work: ReadWork, caps: ReaderCaps): (text: string) => void {
  let carried = '';
  let parser: ReturnType<typeof xmlParser> | undefined;
  return (text) => {
    if (parser) {
      parser.write(text);
      return;
    }
    const window = carried + text;
    const found = mergeTagStart(window);
    if (found === -1) {
      carried = window.slice(-(MERGE_NAME.length + MOST_PREFIX_LENGTH + 1));
      return;
    }
    const handlers: XmlHandlers = { open: (name, attributes) => onMergeElement(sheet, name, attributes) };
    parser = xmlParser(handlers, work, caps, { fragment: true });
    parser.on('error', () => undefined);
    parser.write(window.slice(found));
  };
}

function onMergeElement(sheet: RawSheet, name: string, attributes: Record<string, string>): void {
  if (name !== 'mergeCell') return;
  const range = parseRangeReference(attribute(attributes, 'ref') ?? '');
  if (!range) return;
  if (sheet.merges.length < MOST_MERGES) sheet.merges.push(range);
  else sheet.hasTooManyMerges = true;
}

function fitToTheCaps(sheet: RawSheet, caps: ReaderCaps): void {
  let rowCount = 0;
  let colCount = 0;
  for (const cell of sheet.cells) {
    rowCount = Math.max(rowCount, cell.row + 1);
    colCount = Math.max(colCount, cell.col + 1);
  }
  const rowLimit = Math.min(caps.maxRows, Math.floor(caps.maxCells / Math.max(colCount, 1)));
  if (rowCount > rowLimit) {
    sheet.cells = sheet.cells.filter((cell) => cell.row < rowLimit);
    sheet.isTruncated = true;
    rowCount = rowLimit;
  }
  sheet.rowCount = rowCount;
  sheet.colCount = colCount;
  sheet.merges = sheet.merges
    .filter((merge) => merge.top < rowCount && merge.left < colCount)
    .map((merge) => ({
      ...merge,
      bottom: Math.min(merge.bottom, rowCount - 1),
      right: Math.min(merge.right, colCount - 1),
    }));
}

/**
 * Streams one worksheet part. Rows and cells are read until the row or cell cap is reached; from there on
 * the cells are not parsed at all: the rest of the part is only scanned for `<mergeCells>` (with or without
 * a namespace prefix), which sits after the cell data. A cell past the column cap is dropped on its own.
 * The extent comes from the cells holding a value, formula or style (not the declared dimension), and the
 * row count then shrinks so rows × columns fits `caps.maxCells`. Cell text is cut at `caps.maxCellText`
 * characters and formulas over 8,192 characters are dropped; row heights, column widths and default sizes
 * are clamped to Excel's limits (a size of 0 hides the row or column, an unusable one is ignored), and at
 * most 1,024 `<col>` records are read.
 *
 * @example
 * ```ts
 * const sheet = readSheet(archive, 'xl/worksheets/sheet1.xml', 'Sheet1', sharedStrings, caps, work);
 * ```
 */
export function readSheet(
  archive: ZipArchive,
  path: string,
  name: string,
  sharedStrings: readonly string[],
  caps: ReaderCaps,
  work: ReadWork,
): RawSheet {
  const sheet = emptySheet(name);
  const handlers = sheetDataHandlers(sheet, sharedStrings, caps);
  const parser = xmlParser(handlers, work, caps);
  const scanForMerges = mergeScanner(sheet, work, caps);
  try {
    archive.streamText(path, (text) => {
      if (handlers.isStopped() && !handlers.isReadingMerges()) scanForMerges(text);
      else parser.write(text);
      return true;
    });
    if (!handlers.isStopped() || handlers.isReadingMerges()) parser.close();
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    throw new ReaderError('load_error', `The sheet "${name}" could not be read: ${(error as Error).message}`);
  }
  fitToTheCaps(sheet, caps);
  return sheet;
}
