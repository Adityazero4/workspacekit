import Papa from 'papaparse';
import { boundedDelimitedText } from './delimitedBounds';
import { textBudget, type CellKind, type ReaderCaps, type SheetData } from './types';

const CSV_COLUMN_WIDTH_PX = 100;
const CSV_ROW_HEIGHT_PX = 20;
const SEPARATOR_DIRECTIVE = 'sep=';
const GUESSED_DELIMITERS = [',', ';', '\t', '|'];

const WINDOWS_1252_FROM_0X80 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d,
  0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a,
  0x153, 0x9d, 0x17e, 0x178,
];
const FIRST_REMAPPED_BYTE = 0x80;
const LAST_REMAPPED_BYTE = 0x9f;

function decodeWindows1252(bytes: Uint8Array): string {
  const codeUnits = Uint16Array.from(bytes, (byte) =>
    byte >= FIRST_REMAPPED_BYTE && byte <= LAST_REMAPPED_BYTE
      ? WINDOWS_1252_FROM_0X80[byte - FIRST_REMAPPED_BYTE]!
      : byte,
  );
  return new TextDecoder('utf-16le').decode(codeUnits);
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((byte, index) => bytes[index] === byte);

/**
 * Decodes delimited text: a UTF-8 or UTF-16 byte order mark picks the encoding and is dropped; otherwise
 * the bytes are read as UTF-8, or as Windows-1252 when they are not valid UTF-8 (older Excel exports). The
 * Windows-1252 table is our own, as some runtimes decode that label as Latin-1.
 *
 * @example
 * ```ts
 * decodeText(new Uint8Array([0x93, 0x68, 0x69, 0x94])); // '“hi”'
 * ```
 */
export function decodeText(bytes: Uint8Array): string {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeWindows1252(bytes);
  }
}

function separatorDirective(text: string): { delimiter: string; rest: string } | undefined {
  if (!text.startsWith(SEPARATOR_DIRECTIVE)) return undefined;
  const lineBreak = text.indexOf('\n');
  const line = (lineBreak === -1 ? text : text.slice(0, lineBreak)).replace('\r', '');
  if (line.length !== SEPARATOR_DIRECTIVE.length + 1) return undefined;
  return {
    delimiter: line.slice(SEPARATOR_DIRECTIVE.length),
    rest: lineBreak === -1 ? '' : text.slice(lineBreak + 1),
  };
}

const DELIMITER_SAMPLE_CHARACTERS = 64 * 1024;
const SAMPLED_ROWS = 10;

function guessedDelimiter(text: string): string {
  const sample = Papa.parse<string[]>(text.slice(0, DELIMITER_SAMPLE_CHARACTERS), {
    delimiter: '',
    delimitersToGuess: GUESSED_DELIMITERS,
    preview: SAMPLED_ROWS,
  });
  return sample.meta.delimiter || ',';
}

const kindOf = (text: string): CellKind =>
  text.trim() !== '' && Number.isFinite(Number(text)) ? 'number' : 'text';

function sheetOfRows(rows: string[][], isCutShort: boolean, caps: ReaderCaps): SheetData {
  const budget = textBudget(caps);
  const widest = rows.reduce((most, row) => Math.max(most, row.length), 0);
  const colCount = Math.min(widest, caps.maxCols);
  const rowLimit = Math.min(caps.maxRows, Math.floor(caps.maxCells / Math.max(colCount, 1)));
  const kept = rows.slice(0, rowLimit);
  const cellRows: number[] = [];
  const cellCols: number[] = [];
  const cellTexts: string[] = [];
  kept.forEach((row, rowIndex) => {
    for (let col = 0; col < Math.min(row.length, colCount); col++) {
      const text = budget.take(row[col]!);
      if (text === '') continue;
      cellRows.push(rowIndex);
      cellCols.push(col);
      cellTexts.push(text);
    }
  });
  return {
    name: 'Sheet1',
    rowCount: kept.length,
    colCount,
    cellRows: Uint32Array.from(cellRows),
    cellCols: Uint32Array.from(cellCols),
    cellTexts,
    cellKinds: cellTexts.map(kindOf),
    cellFormats: new Uint32Array(cellTexts.length),
    formats: [{}],
    merges: [],
    rowHeights: new Float64Array(kept.length).fill(CSV_ROW_HEIGHT_PX),
    colWidths: new Float64Array(colCount).fill(CSV_COLUMN_WIDTH_PX),
    hiddenRows: new Uint8Array(kept.length),
    hiddenCols: new Uint8Array(colCount),
    frozen: { rows: 0, cols: 0 },
    isTruncated: isCutShort || rows.length > rowLimit || widest > colCount || budget.isSpent,
    hasTooManyMerges: false,
  };
}

/**
 * Reads CSV or TSV bytes into one sheet with papaparse, which never mistakes text for SYLK, DIF or XML.
 * A leading `sep=;` line sets the delimiter; otherwise TSV uses tabs and CSV guesses among `,` `;` tab and
 * `|` (from the first 64 KiB). Before parsing, the text is cut to what the sheet can show (see
 * `boundedDelimitedText`), so neither a huge field nor a row of millions of delimiters costs more than the
 * caps; the row count then shrinks so rows × columns fits `caps.maxCells`, and the sheet's texts stop at
 * `caps.maxSheetText` characters. Formulas show as written; every column is 100 px wide.
 *
 * @example
 * ```ts
 * const sheet = readDelimited(new TextEncoder().encode('a;b\n1;2'), 'csv', DEFAULT_CAPS);
 * ```
 */
export function readDelimited(bytes: Uint8Array, format: 'csv' | 'tsv', caps: ReaderCaps): SheetData {
  const decoded = decodeText(bytes);
  const directive = separatorDirective(decoded);
  const text = directive?.rest ?? decoded;
  const delimiter = directive?.delimiter ?? (format === 'tsv' ? '\t' : guessedDelimiter(text));
  const bounded = boundedDelimitedText(text, delimiter, caps);
  const result = Papa.parse<string[]>(bounded.text, {
    delimiter,
    preview: caps.maxRows + 1,
    skipEmptyLines: 'greedy',
  });
  return sheetOfRows(result.data, bounded.isCut || result.data.length > caps.maxRows, caps);
}
