import type { OpenBook } from '../engine';
import { evaluateFormulas, type FormulaBook } from '../formulas';
import { formatNumber } from '../numberFormat';
import {
  detachedPrefix,
  LONGEST_SHEET_NAME,
  MOST_SHEETS,
  ReaderError,
  textBudget,
  type CellFormat,
  type CellKind,
  type ReadWork,
  type ReaderCaps,
  type SheetData,
} from '../types';
import { readSharedStrings } from './sharedStrings';
import { readSheet, type RawCell, type RawSheet } from './sheet';
import { readStyles, type WorkbookStyles } from './styles';
import { readThemeColors } from './theme';
import { attribute, readXmlPart } from './xml';
import { openZip, type ZipArchive } from './zip';

const OFFICE_DOCUMENT = '/officeDocument';
const FALLBACK_WORKBOOK = 'xl/workbook.xml';

interface Relationship {
  target: string;
  type: string;
}

interface SheetEntry {
  name: string;
  isHidden: boolean;
  path: string | undefined;
}

function resolvePath(fromDirectory: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const segments = fromDirectory === '' ? [] : fromDirectory.split('/');
  for (const segment of target.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '.' && segment !== '') segments.push(segment);
  }
  return segments.join('/');
}

const directoryOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const relationshipsPathOf = (path: string): string =>
  resolvePath(directoryOf(path), `_rels/${path.slice(path.lastIndexOf('/') + 1)}.rels`);

function readRelationships(
  archive: ZipArchive,
  partPath: string,
  work: ReadWork,
  caps: ReaderCaps,
): Map<string, Relationship> {
  const relationships = new Map<string, Relationship>();
  readXmlPart(
    archive,
    relationshipsPathOf(partPath),
    {
      open: (name, attributes) => {
        const id = attribute(attributes, 'Id');
        const target = attribute(attributes, 'Target');
        if (name !== 'Relationship' || id === undefined || target === undefined) return;
        if (attribute(attributes, 'TargetMode') === 'External') return;
        relationships.set(id, {
          target: resolvePath(directoryOf(partPath), target),
          type: attribute(attributes, 'Type') ?? '',
        });
      },
    },
    work,
    caps,
    true,
  );
  return relationships;
}

function workbookPathOf(archive: ZipArchive, work: ReadWork, caps: ReaderCaps): string {
  const root = readRelationships(archive, '', work, caps);
  const office = [...root.values()].find((relationship) => relationship.type.endsWith(OFFICE_DOCUMENT));
  return office?.target ?? FALLBACK_WORKBOOK;
}

function readWorkbookPart(archive: ZipArchive, path: string, work: ReadWork, caps: ReaderCaps) {
  const relationships = readRelationships(archive, path, work, caps);
  const sheets: SheetEntry[] = [];
  let isDate1904 = false;
  let hasMoreSheets = false;
  readXmlPart(
    archive,
    path,
    {
      open: (name, attributes) => {
        if (name === 'workbookPr') {
          isDate1904 = ['1', 'true'].includes(attribute(attributes, 'date1904') ?? '');
        }
        if (name !== 'sheet') return;
        if (sheets.length >= MOST_SHEETS) {
          hasMoreSheets = true;
          return;
        }
        const state = attribute(attributes, 'state');
        sheets.push({
          name: detachedPrefix(
            attribute(attributes, 'name') ?? `Sheet${sheets.length + 1}`,
            LONGEST_SHEET_NAME,
          ),
          isHidden: state === 'hidden' || state === 'veryHidden',
          path: relationships.get(attribute(attributes, 'id') ?? '')?.target,
        });
      },
    },
    work,
    caps,
  );
  const partOfType = (suffix: string): string | undefined =>
    [...relationships.values()].find((relationship) => relationship.type.endsWith(suffix))?.target;
  return { sheets, isDate1904, hasMoreSheets, partOfType };
}

function displayTextOf(cell: RawCell, styles: WorkbookStyles, isDate1904: boolean): string {
  if (cell.value === undefined) return '';
  if (cell.kind === 'number' && typeof cell.value === 'number') {
    return formatNumber(cell.value, styles.numberFormatOf(cell.styleIndex), isDate1904);
  }
  if (cell.kind === 'boolean') return cell.value ? 'TRUE' : 'FALSE';
  return String(cell.value);
}

function sizesOf(count: number, sizes: Map<number, number>, fallback: number): Float64Array {
  const array = new Float64Array(count).fill(fallback);
  for (const [index, size] of sizes) if (index < count) array[index] = size;
  return array;
}

function flagsOf(count: number, indexes: Set<number>): Uint8Array {
  const flags = new Uint8Array(count);
  for (const index of indexes) if (index < count) flags[index] = 1;
  return flags;
}

function toSheetData(
  raw: RawSheet,
  styles: WorkbookStyles,
  isDate1904: boolean,
  caps: ReaderCaps,
): SheetData {
  const budget = textBudget(caps);
  const formats: CellFormat[] = [];
  const formatIndexes = new Map<number, number>();
  const formatIndexOf = (styleIndex: number): number => {
    let index = formatIndexes.get(styleIndex);
    if (index === undefined) {
      index = formats.push(styles.formatOf(styleIndex)) - 1;
      formatIndexes.set(styleIndex, index);
    }
    return index;
  };
  return {
    name: raw.name,
    rowCount: raw.rowCount,
    colCount: raw.colCount,
    cellRows: Uint32Array.from(raw.cells, (cell) => cell.row),
    cellCols: Uint32Array.from(raw.cells, (cell) => cell.col),
    cellTexts: raw.cells.map((cell) => budget.take(displayTextOf(cell, styles, isDate1904))),
    cellKinds: raw.cells.map((cell): CellKind => (cell.value === undefined ? 'text' : cell.kind)),
    cellFormats: Uint32Array.from(raw.cells, (cell) => formatIndexOf(cell.styleIndex)),
    formats,
    merges: raw.merges,
    rowHeights: sizesOf(raw.rowCount, raw.rowHeights, raw.defaultRowHeight),
    colWidths: sizesOf(raw.colCount, raw.colWidths, raw.defaultColWidth),
    hiddenRows: flagsOf(raw.rowCount, raw.hiddenRows),
    hiddenCols: flagsOf(raw.colCount, raw.hiddenCols),
    frozen: raw.frozen,
    isTruncated: raw.isTruncated || budget.isSpent,
    hasTooManyMerges: raw.hasTooManyMerges,
  };
}

function once<Value>(compute: () => Value): () => Value {
  let value: { computed: Value } | undefined;
  return () => (value ??= { computed: compute() }).computed;
}

/**
 * Opens an `.xlsx` (or `.xlsm`) within `caps`: the archive is checked before anything inflates, the
 * workbook part lists the sheets, and each sheet, with the shared strings, styles and theme it needs, is
 * read only when asked for and then kept. Formulas without stored results are evaluated (see
 * `evaluateFormulas`) once; each sheet's data is made once and kept, so searching it again costs no
 * evaluation. Display texts are cut at `caps.maxCellText` characters, and a sheet's texts stop at
 * `caps.maxSheetText` characters (the sheet is then marked truncated).
 *
 * @example
 * ```ts
 * const book = openXlsx(new Uint8Array(buffer), DEFAULT_CAPS, newReadWork());
 * const first = await book.sheet(0);
 * ```
 */
export function openXlsx(bytes: Uint8Array, caps: ReaderCaps, work: ReadWork): OpenBook {
  const archive = openZip(bytes, caps, work);
  const workbook = readWorkbookPart(archive, workbookPathOf(archive, work, caps), work, caps);
  const sharedStrings = once(() =>
    readSharedStrings(archive, workbook.partOfType('/sharedStrings') ?? '', caps, work),
  );
  const styles = once(() => {
    const themePath = workbook.partOfType('/theme');
    const themeColors = themePath ? readThemeColors(archive, themePath, work, caps) : [];
    return readStyles(archive, workbook.partOfType('/styles') ?? '', themeColors, work, caps);
  });
  const rawSheets = new Map<number, RawSheet>();
  const formulaBook: FormulaBook = {
    sheetNames: workbook.sheets.map((sheet) => sheet.name),
    rawSheet: (index) => {
      let raw = rawSheets.get(index);
      if (!raw) {
        const entry = workbook.sheets[index];
        if (!entry?.path) {
          throw new ReaderError('load_error', `This workbook has no sheet number ${index + 1}.`);
        }
        raw = readSheet(archive, entry.path, entry.name, sharedStrings(), caps, work);
        rawSheets.set(index, raw);
      }
      return raw;
    },
  };
  const sheetData = new Map<number, Promise<SheetData>>();
  const readSheetData = async (index: number): Promise<SheetData> => {
    const isCutShort = await evaluateFormulas(formulaBook, index, caps, work);
    const raw = formulaBook.rawSheet(index);
    if (isCutShort) raw.isTruncated = true;
    return toSheetData(raw, styles(), workbook.isDate1904, caps);
  };
  return {
    info: {
      sheets: workbook.sheets.map(({ name, isHidden }) => ({ name, isHidden })),
      ...(workbook.hasMoreSheets ? { hasMoreSheets: true } : {}),
    },
    sheet: (index) => {
      let read = sheetData.get(index);
      if (!read) {
        read = readSheetData(index);
        sheetData.set(index, read);
      }
      return read;
    },
  };
}
