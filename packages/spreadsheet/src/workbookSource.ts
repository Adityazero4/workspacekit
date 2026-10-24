import type { ViewerError } from '@workspacekit/react/renderer-kit';
import { viewerError } from '@workspacekit/react/renderer-kit';
import type { CellAddress } from './grid/model';
import { createWorkerReader, isSuperseded, type WorkerReader } from './reader/client';
import { findCells } from './reader/search';
import { openWithSheetJs } from './reader/sheetjs';
import {
  DEFAULT_CAPS,
  ReaderError,
  type SheetData,
  type SpreadsheetFormat,
  type WorkbookInfo,
} from './reader/types';

/**
 * An opened workbook as the viewer uses it, whichever reader opened it.
 *
 * @example
 * ```ts
 * const sheet = await source.sheet(0);
 * ```
 */
export interface WorkbookSource {
  info: WorkbookInfo;
  sheet: (index: number) => Promise<SheetData>;
  search: (index: number, query: string) => Promise<CellAddress[]>;
}

const FORMATS_BY_EXTENSION: Record<string, SpreadsheetFormat> = {
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  csv: 'csv',
  tsv: 'tsv',
  xls: 'xls',
  xlsb: 'xlsb',
  ods: 'ods',
};
const ZIP_SIGNATURE = [0x50, 0x4b];

/**
 * The format of a file, from its name's extension, or sniffed when the name has none: a zip is `.xlsx`,
 * anything else delimited text.
 *
 * @example
 * ```ts
 * formatOf('report.XLSM', buffer); // 'xlsx'
 * ```
 */
export function formatOf(name: string, data: ArrayBuffer): SpreadsheetFormat {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const known = name.includes('.') ? FORMATS_BY_EXTENSION[extension] : undefined;
  if (known) return known;
  const head = new Uint8Array(data, 0, Math.min(2, data.byteLength));
  return ZIP_SIGNATURE.every((byte, index) => head[index] === byte) ? 'xlsx' : 'csv';
}

/**
 * True for the formats with a plain-text `raw` view.
 *
 * @example
 * ```ts
 * isDelimitedText('tsv'); // true
 * ```
 */
export const isDelimitedText = (format: SpreadsheetFormat): format is 'csv' | 'tsv' =>
  format === 'csv' || format === 'tsv';

/**
 * Opens a workbook: `.xlsx`, CSV and TSV in the reader's worker, the SheetJS formats on the main thread
 * through the injected engine. Searching follows the reader: in the worker for the first group, and on
 * the main thread for `.xls`, `.xlsb` and `.ods`, over a sheet already cut to the caps.
 *
 * @example
 * ```ts
 * const source = await openWorkbook(data, 'xlsx', { xlsx: undefined }, () => reader);
 * ```
 */
export async function openWorkbook(
  data: ArrayBuffer,
  format: SpreadsheetFormat,
  engines: { xlsx?: () => Promise<unknown> } | undefined,
  reader: () => WorkerReader,
): Promise<WorkbookSource> {
  if (format === 'xlsx' || isDelimitedText(format)) {
    const worker = reader();
    const info = await worker.open(data, format);
    return {
      info,
      sheet: (index) => worker.sheet(index),
      search: (index, query) => worker.search(index, query),
    };
  }
  const book = await openWithSheetJs(engines?.xlsx, new Uint8Array(data), format, DEFAULT_CAPS);
  return {
    info: book.info,
    sheet: book.sheet,
    search: async (index, query) => findCells(await book.sheet(index), query),
  };
}

/**
 * The sheet to show: the one asked for while it exists and is visible, otherwise the first visible sheet.
 *
 * @example
 * ```ts
 * sheetToShow({ sheets: [{ name: 'A', isHidden: true }, { name: 'B', isHidden: false }] }, undefined); // 1
 * ```
 */
export function sheetToShow(info: WorkbookInfo, requested: number | undefined): number {
  if (requested !== undefined && info.sheets[requested] && !info.sheets[requested].isHidden) return requested;
  return Math.max(
    0,
    info.sheets.findIndex((sheet) => !sheet.isHidden),
  );
}

/**
 * The viewer error for a failed read: a reader error keeps its own message (which says what to do, such as
 * installing SheetJS); anything else is a `load_error`. `undefined` for a superseded request.
 *
 * @example
 * ```ts
 * const error = viewerErrorOf(thrown);
 * if (error) onError(error);
 * ```
 */
export function viewerErrorOf(thrown: unknown): ViewerError | undefined {
  if (isSuperseded(thrown)) return undefined;
  if (thrown instanceof ReaderError) return { kind: thrown.kind, message: thrown.message, cause: thrown };
  return viewerError('load_error', thrown);
}

/**
 * The reader worker of one mounted viewer: created on first use, ended by `dispose`. After `dispose`,
 * `get` hands back a disposed reader, whose calls reject, so no worker starts again.
 *
 * @example
 * ```ts
 * const worker = lazyWorkerReader(undefined);
 * worker.get().open(data, 'csv');
 * ```
 */
export function lazyWorkerReader(workerFactory: (() => Worker) | undefined): {
  get: () => WorkerReader;
  dispose: () => void;
} {
  let reader: WorkerReader | undefined;
  let isDisposed = false;
  return {
    get: () => {
      if (!reader) {
        reader = createWorkerReader({ workerFactory });
        if (isDisposed) reader.dispose();
      }
      return reader;
    },
    dispose: () => {
      isDisposed = true;
      reader?.dispose();
    },
  };
}
