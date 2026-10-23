import { readDelimited } from './csv';
import { ReaderError, type ReadWork, type ReaderCaps, type SheetData, type WorkbookInfo } from './types';
import { openXlsx } from './xlsx/workbook';

/**
 * An opened workbook, whatever read it: its sheet list, and each sheet on demand. Our own reader (in the
 * worker) and the injected SheetJS adapter both implement it.
 *
 * @example
 * ```ts
 * const book: OpenBook = openBook(bytes, 'xlsx', DEFAULT_CAPS, newReadWork());
 * ```
 */
export interface OpenBook {
  info: WorkbookInfo;
  sheet: (index: number) => Promise<SheetData>;
}

const COMPOUND_FILE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0];

/**
 * Opens what the worker reads natively: `.xlsx` with our streaming reader, CSV and TSV with papaparse. An
 * `.xlsx` that is really an encrypted (compound file) document is `password_protected`.
 *
 * @example
 * ```ts
 * const book = openBook(new Uint8Array(buffer), 'csv', DEFAULT_CAPS, newReadWork());
 * ```
 */
export function openBook(
  bytes: Uint8Array,
  format: 'xlsx' | 'csv' | 'tsv',
  caps: ReaderCaps,
  work: ReadWork,
): OpenBook {
  if (format !== 'xlsx') {
    const sheet = readDelimited(bytes, format, caps);
    return { info: { sheets: [{ name: sheet.name, isHidden: false }] }, sheet: () => Promise.resolve(sheet) };
  }
  if (COMPOUND_FILE_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new ReaderError(
      'password_protected',
      'This workbook is encrypted. Open it in a spreadsheet app instead.',
    );
  }
  return openXlsx(bytes, caps, work);
}
