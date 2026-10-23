import type { CellAddress } from '../grid/model';
import { openBook, type OpenBook } from './engine';
import { findCells } from './search';
import { newReadWork, ReaderError, type ReaderCaps, type SheetData, type WorkbookInfo } from './types';

/**
 * A request to the reader worker. `open` replaces the workbook; `sheet` and `search` work on the open one.
 *
 * @example
 * ```ts
 * const request: ReaderRequest = { id: 2, type: 'sheet', index: 0 };
 * ```
 */
export type ReaderRequest =
  | { id: number; type: 'open'; data: ArrayBuffer; format: 'xlsx' | 'csv' | 'tsv'; caps: ReaderCaps }
  | { id: number; type: 'sheet'; index: number }
  | { id: number; type: 'search'; index: number; query: string };

/**
 * The worker's answer to the request with the same `id`.
 *
 * @example
 * ```ts
 * const response: ReaderResponse = { id: 2, ok: false, error: { kind: 'load_error', message: 'Damaged.' } };
 * ```
 */
export type ReaderResponse =
  | { id: number; ok: true; result: WorkbookInfo | SheetData | CellAddress[] }
  | { id: number; ok: false; error: { kind: ReaderError['kind']; message: string } };

/**
 * The reader's state inside the worker: the open workbook. `handle` answers one request; requests are
 * expected one at a time.
 *
 * @example
 * ```ts
 * const handle = createReaderSession();
 * const info = await handle({ id: 1, type: 'open', data, format: 'csv', caps: DEFAULT_CAPS });
 * ```
 */
export function createReaderSession(): (request: ReaderRequest) => Promise<ReaderResponse> {
  let book: OpenBook | undefined;
  const openedBook = (): OpenBook => {
    if (!book) throw new ReaderError('load_error', 'No workbook is open; send an open request first.');
    return book;
  };
  const answer = async (request: ReaderRequest): Promise<WorkbookInfo | SheetData | CellAddress[]> => {
    switch (request.type) {
      case 'open':
        book = undefined;
        book = openBook(new Uint8Array(request.data), request.format, request.caps, newReadWork());
        return book.info;
      case 'sheet':
        return openedBook().sheet(request.index);
      case 'search':
        return findCells(await openedBook().sheet(request.index), request.query);
    }
  };
  return async (request) => {
    try {
      return { id: request.id, ok: true, result: await answer(request) };
    } catch (error) {
      const readerError =
        error instanceof ReaderError
          ? error
          : new ReaderError('load_error', `The spreadsheet could not be read: ${String(error)}`);
      return { id: request.id, ok: false, error: { kind: readerError.kind, message: readerError.message } };
    }
  };
}

/**
 * What `serveReaderRequests` needs from the worker's global scope.
 *
 * @example
 * ```ts
 * const scope: ReaderScope = self as unknown as ReaderScope;
 * ```
 */
export interface ReaderScope {
  addEventListener: (type: 'message', listener: (event: MessageEvent<ReaderRequest>) => void) => void;
  postMessage: (message: ReaderResponse) => void;
}

const unsendable = (id: number, error: unknown): ReaderResponse => ({
  id,
  ok: false,
  error: {
    kind: 'load_error',
    message: `The spreadsheet reader could not send its answer: ${error instanceof Error ? error.message : String(error)}`,
  },
});

/**
 * Answers the requests the worker receives, one at a time and in order. A failure anywhere in one request,
 * even in sending its answer, is answered as an error for that request and never stops the ones after it.
 *
 * @example
 * ```ts
 * serveReaderRequests(self as unknown as ReaderScope);
 * ```
 */
export function serveReaderRequests(scope: ReaderScope): void {
  const handle = createReaderSession();
  let queue: Promise<void> = Promise.resolve();
  scope.addEventListener('message', (event) => {
    const request = event.data;
    queue = queue
      .then(async () => {
        const response = await handle(request);
        try {
          scope.postMessage(response);
        } catch (error) {
          scope.postMessage(unsendable(request.id, error));
        }
      })
      .catch(() => undefined);
  });
}
