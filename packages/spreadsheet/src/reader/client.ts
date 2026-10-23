import type { CellAddress } from '../grid/model';
import type { ReaderRequest, ReaderResponse } from './session';
import { DEFAULT_CAPS, ReaderError, type ReaderCaps, type SheetData, type WorkbookInfo } from './types';

/**
 * The reader running in a worker. `open` loads a workbook (a copy of `data` is sent, so the caller's buffer
 * stays usable); `sheet` reads one sheet and `search` finds cells in it. A newer call of the same kind
 * supersedes an older one, whose promise rejects with an `AbortError` (see `isSuperseded`), and a new
 * `open` supersedes every pending call; when the worker is still busy with them, it is terminated and a
 * fresh one opens the new workbook, so abandoned work stops at once. If the worker crashes, pending calls
 * reject with a `load_error` and the next call starts a new worker, opening the last workbook again
 * first. After `dispose`, every call rejects with an `AbortError` and no worker starts again.
 *
 * @example
 * ```ts
 * const reader = createWorkerReader();
 * const info = await reader.open(buffer, 'xlsx');
 * const sheet = await reader.sheet(0);
 * ```
 */
export interface WorkerReader {
  open: (data: ArrayBuffer, format: 'xlsx' | 'csv' | 'tsv', caps?: ReaderCaps) => Promise<WorkbookInfo>;
  sheet: (index: number) => Promise<SheetData>;
  search: (index: number, query: string) => Promise<CellAddress[]>;
  dispose: () => void;
}

/**
 * Options of `createWorkerReader`: `workerFactory` replaces the default
 * `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`, for bundlers that need the
 * worker built or served another way.
 *
 * @example
 * ```ts
 * const workerFactory = (): Worker => new Worker('/sheet-worker.js', { type: 'module' });
 * const options: WorkerReaderOptions = { workerFactory };
 * ```
 */
export interface WorkerReaderOptions {
  workerFactory?: () => Worker;
}

type RequestKind = ReaderRequest['type'] | 'reopen';
type RequestBody =
  | { type: 'open'; data: ArrayBuffer; format: 'xlsx' | 'csv' | 'tsv'; caps: ReaderCaps }
  | { type: 'sheet'; index: number }
  | { type: 'search'; index: number; query: string };

interface Pending {
  kind: RequestKind;
  resolve: (result: never) => void;
  reject: (error: unknown) => void;
}

const superseded = (): DOMException => new DOMException('A newer request replaced this one.', 'AbortError');
const crashed = (): ReaderError =>
  new ReaderError('load_error', 'The spreadsheet reader stopped unexpectedly. Retry to read the file again.');

/**
 * True for the rejection of a call that a newer call replaced; callers ignore it.
 *
 * @example
 * ```ts
 * reader.sheet(1).catch((error) => { if (!isSuperseded(error)) showError(error); });
 * ```
 */
export const isSuperseded = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

const EVERY_KIND: readonly RequestKind[] = ['open', 'sheet', 'search', 'reopen'];

function settle(pending: Map<number, Pending>, response: ReaderResponse): void {
  const waiting = pending.get(response.id);
  if (!waiting) return;
  pending.delete(response.id);
  if (response.ok) waiting.resolve(response.result as never);
  else waiting.reject(new ReaderError(response.error.kind, response.error.message));
}

function supersede(pending: Map<number, Pending>, kinds: readonly RequestKind[]): void {
  for (const [id, waiting] of pending) {
    if (!kinds.includes(waiting.kind)) continue;
    pending.delete(id);
    waiting.reject(superseded());
  }
}

function startedWorker(
  createWorker: () => Worker,
  pending: Map<number, Pending>,
  crash: (from: Worker) => void,
): Worker {
  const started = createWorker();
  started.addEventListener('message', (event: MessageEvent<ReaderResponse>) => settle(pending, event.data));
  started.addEventListener('error', () => crash(started));
  started.addEventListener('messageerror', () => crash(started));
  return started;
}

const defaultWorker = (): Worker => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

/**
 * Starts the spreadsheet reader in a module worker (lazily, on the first call). See `WorkerReader`.
 *
 * @example
 * ```ts
 * const reader = createWorkerReader();
 * ```
 */
export function createWorkerReader(options: WorkerReaderOptions = {}): WorkerReader {
  const createWorker = options.workerFactory ?? defaultWorker;
  const pending = new Map<number, Pending>();
  let worker: Worker | undefined;
  let nextId = 1;
  let lastOpen: Extract<RequestBody, { type: 'open' }> | undefined;
  let hasCrashed = false;
  let isDisposed = false;
  const stopWorker = (): void => {
    worker?.terminate();
    worker = undefined;
  };
  const crash = (from: Worker): void => {
    if (from !== worker) return;
    stopWorker();
    hasCrashed = true;
    for (const waiting of pending.values()) waiting.reject(crashed());
    pending.clear();
  };
  const post = (kind: RequestKind, body: RequestBody, waiting: Omit<Pending, 'kind'>): void => {
    const id = nextId++;
    const target = workerNow(kind !== 'open');
    pending.set(id, { kind, ...waiting });
    target.postMessage({ ...body, id });
  };
  const workerNow = (reopenAfterACrash: boolean): Worker => {
    if (worker) return worker;
    worker = startedWorker(createWorker, pending, crash);
    if (hasCrashed && reopenAfterACrash && lastOpen) {
      post('reopen', lastOpen, { resolve: () => undefined, reject: () => undefined });
    }
    hasCrashed = false;
    return worker;
  };
  const request = <Result>(body: RequestBody): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      if (isDisposed) return reject(superseded());
      const isBusy = pending.size > 0;
      supersede(pending, body.type === 'open' ? EVERY_KIND : [body.type]);
      if (body.type === 'open' && isBusy) stopWorker();
      post(body.type, body, { resolve, reject });
    });
  return {
    open: (data, format, caps = DEFAULT_CAPS) => {
      lastOpen = { type: 'open', data, format, caps };
      return request<WorkbookInfo>(lastOpen);
    },
    sheet: (index) => request<SheetData>({ type: 'sheet', index }),
    search: (index, query) => request<CellAddress[]>({ type: 'search', index, query }),
    dispose: () => {
      isDisposed = true;
      supersede(pending, EVERY_KIND);
      stopWorker();
    },
  };
}
