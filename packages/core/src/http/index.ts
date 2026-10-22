import { FsError, kindForStatus, toFsError } from '../errors';
import type { FsErrorKind } from '../errors';
import { normalizePath } from '../path';
import { CSRF_HEADER, IF_MTIME_HEADER, ROUTES, parseRoute } from '../protocol';
import type {
  CreateBody,
  DownloadBody,
  EntriesResponse,
  EntryResponse,
  ErrorBody,
  StatResponse,
  TransferBody,
  UploadCompleteBody,
  UploadInitBody,
  UploadInitResponse,
  WatchFrame,
} from '../protocol';
import type { ChangeEvent, Entry, FileSystemAdapter, TransferOptions, UploadTransport } from '../types';

type HeadersOption = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
/**
 * Options for `httpAdapter`: a custom `fetch`, extra headers (or a function returning them), credentials and
 * watch behavior.
 *
 * @example
 * ```ts
 * const adapter = httpAdapter('/api/files', {
 *   headers: async () => ({ Authorization: `Bearer ${await token()}` }),
 * });
 * ```
 */
export interface HttpAdapterOptions {
  fetch?: typeof fetch;
  headers?: HeadersOption;
  credentials?: RequestCredentials;
  /**
   * Watch reconnect backoff; the last delay repeats. Default [1000, 2000, 5000, 10000]. A 503 to the watch
   * request with `Retry-After` (integer seconds or an IMF-fixdate, capped at 60 s) waits that long instead,
   * but never less than this backoff step or 1 s; any other `Retry-After` value is ignored.
   */
  reconnectDelaysMs?: number[];
  /**
   * Called when `watch` gives up on a permanent failure (HTTP 400, 403, 404 or 501), and once per run of
   * consecutive 401s, which it keeps retrying (a sign-in may fix it) at the longest reconnect delay, but
   * never sooner than 5 s.
   */
  onWatchError?: (e: FsError) => void;
}

const MAX_SSE_UTF16_UNITS = 1_048_576;
const STATUSES_RETRY_CANNOT_FIX = new Set([400, 403, 404, 501]);
const UNAUTHORIZED = 401;
const SERVICE_UNAVAILABLE = 503;
const SHORTEST_SIGN_IN_RETRY_MS = 5000;
const LONGEST_RETRY_AFTER_MS = 60_000;
const SHORTEST_RETRY_AFTER_MS = 1000;
const INTEGER_SECONDS = /^\d+$/;
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];
const LINE_BREAK_KEEPING_A_TRAILING_CR = /\r\n|\n|\r(?!$)/;
const JOINING_NEWLINE = 1;
const OCTET_STREAM = 'application/octet-stream';

const FS_ERROR_KINDS = new Set<string>([
  'not_found',
  'conflict',
  'forbidden',
  'too_large',
  'invalid',
  'network',
  'timeout',
  'cancelled',
  'unknown',
]);

const ignoreError = (): void => undefined;

function throwOutsideTheCaller(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

function callIsolated<A>(listener: ((argument: A) => void) | undefined, argument: A): void {
  try {
    listener?.(argument);
  } catch (error) {
    throwOutsideTheCaller(error);
  }
}

function parseErrorBody(text: string): ErrorBody['error'] | undefined {
  try {
    return (JSON.parse(text) as Partial<ErrorBody>).error;
  } catch {
    return undefined;
  }
}

function errorFromResponse(status: number, text: string, path?: string): FsError {
  const body = parseErrorBody(text);
  const kind: FsErrorKind = body && FS_ERROR_KINDS.has(body.kind) ? body.kind : kindForStatus(status);
  const errorPath = body?.path ?? path;
  return new FsError(kind, body?.message || text || `HTTP ${status}`, {
    status,
    ...(errorPath === undefined ? {} : { path: errorPath }),
  });
}

const watchRetryAfterMsOf = new WeakMap<FsError, number>();

function parseRetryAfterMs(header: string | null): number | undefined {
  const value = header?.trim() ?? '';
  let delayMs: number;
  if (INTEGER_SECONDS.test(value)) delayMs = Number(value) * 1000;
  else if (IMF_FIXDATE.test(value)) delayMs = Date.parse(value) - Date.now();
  else return undefined;
  return Number.isNaN(delayMs) ? undefined : Math.min(Math.max(delayMs, 0), LONGEST_RETRY_AFTER_MS);
}

function failedResponseError(route: string, response: Response, text: string, path?: string): FsError {
  const error = errorFromResponse(response.status, text, path);
  if (route !== ROUTES.watch || response.status !== SERVICE_UNAVAILABLE) return error;
  const delayMs = parseRetryAfterMs(response.headers.get('Retry-After'));
  if (delayMs !== undefined) watchRetryAfterMsOf.set(error, delayMs);
  return error;
}

async function readBody<T>(response: Response, read: (response: Response) => Promise<T>): Promise<T> {
  try {
    return await read(response);
  } catch (error) {
    throw toFsError(error);
  }
}

const withSignal = (options?: { signal?: AbortSignal }): { signal?: AbortSignal } =>
  options?.signal ? { signal: options.signal } : {};

type Query = Record<string, string | number | undefined>;

interface HttpRequest {
  query?: Query;
  json?: unknown;
  body?: BodyInit;
  headers?: HeadersInit;
  signal?: AbortSignal;
  path?: string;
}

class HttpClient {
  readonly #base: string;
  readonly #options: HttpAdapterOptions;

  constructor(baseUrl: string, options: HttpAdapterOptions) {
    this.#base = baseUrl.replace(/\/+$/, '');
    this.#options = options;
  }

  get sendsCredentials(): boolean {
    return this.#options.credentials === 'include';
  }

  urlFor(route: string, query: Query = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const queryString = params.toString();
    return `${this.#base}/${parseRoute(route).path}${queryString ? `?${queryString}` : ''}`;
  }

  async headers(extra?: HeadersInit): Promise<Headers> {
    const configured = this.#options.headers;
    const headers = new Headers(typeof configured === 'function' ? await configured() : configured);
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return headers;
  }

  async send(route: string, request: HttpRequest = {}): Promise<Response> {
    try {
      const { method } = parseRoute(route);
      const headers = await this.headers(request.headers);
      if (method !== 'GET') headers.set(CSRF_HEADER, '1');
      let body = request.body;
      if (request.json !== undefined) {
        body = JSON.stringify(request.json);
        headers.set('Content-Type', 'application/json');
      }
      const fetchImplementation = this.#options.fetch ?? fetch;
      const response = await fetchImplementation(this.urlFor(route, request.query), {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...withSignal(request),
        ...(this.#options.credentials ? { credentials: this.#options.credentials } : {}),
      });
      if (!response.ok) throw failedResponseError(route, response, await response.text(), request.path);
      return response;
    } catch (error) {
      throw toFsError(error);
    }
  }

  async call<T>(route: string, request?: HttpRequest): Promise<T> {
    const response = await this.send(route, request);
    return readBody(response, (received) => received.json() as Promise<T>);
  }
}

async function xhrUpload(
  client: HttpClient,
  path: string,
  file: Blob,
  options: { signal: AbortSignal; onProgress?(loaded: number): void; overwrite?: boolean },
): Promise<Entry> {
  const { signal } = options;
  if (signal.aborted) throw new FsError('cancelled');
  const headers = await client.headers({ 'Content-Type': file.type || OCTET_STREAM });
  headers.set(CSRF_HEADER, '1');
  return new Promise<Entry>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = client.urlFor(ROUTES.uploadDirect, { path, overwrite: options.overwrite ? 1 : undefined });
    xhr.open(parseRoute(ROUTES.uploadDirect).method, url);
    xhr.withCredentials = client.sendsCredentials;
    headers.forEach((value, key) => xhr.setRequestHeader(key, value));
    xhr.upload.onprogress = (event) => options.onProgress?.(event.loaded);
    const abortRequest = (): void => xhr.abort();
    const stopListening = (): void => signal.removeEventListener('abort', abortRequest);
    xhr.onload = () => {
      stopListening();
      if (xhr.status < 200 || xhr.status >= 300) {
        return reject(errorFromResponse(xhr.status, xhr.responseText, path));
      }
      try {
        resolve((JSON.parse(xhr.responseText) as EntryResponse).entry);
      } catch (error) {
        reject(toFsError(error));
      }
    };
    xhr.onerror = () => {
      stopListening();
      reject(new FsError('network', 'upload failed'));
    };
    xhr.onabort = () => {
      stopListening();
      reject(new FsError('cancelled'));
    };
    const abortedWhileHeadersResolved = signal.aborted;
    if (abortedWhileHeadersResolved) return reject(new FsError('cancelled'));
    signal.addEventListener('abort', abortRequest, { once: true });
    xhr.send(file);
  });
}

class SseFrameParser {
  #data: string[] = [];
  #dataLength = 0;
  #completedAnyFrame = false;
  readonly #onFrame: (events: WatchFrame) => void;

  constructor(onFrame: (events: WatchFrame) => void) {
    this.#onFrame = onFrame;
  }

  get completedAnyFrame(): boolean {
    return this.#completedAnyFrame;
  }

  push(line: string): void {
    if (line === '') this.#endFrame();
    else if (line.startsWith('data:')) this.#appendData(line.slice(line[5] === ' ' ? 6 : 5));
  }

  #appendData(value: string): void {
    this.#dataLength += value.length + JOINING_NEWLINE;
    if (this.#dataLength > MAX_SSE_UTF16_UNITS) throw new FsError('too_large', 'SSE frame too large');
    this.#data.push(value);
  }

  #endFrame(): void {
    if (this.#data.length === 0) return;
    const raw = this.#data.join('\n');
    this.#data = [];
    this.#dataLength = 0;
    this.#completedAnyFrame = true;
    let events: unknown;
    try {
      events = JSON.parse(raw);
    } catch {
      return;
    }
    if (Array.isArray(events)) this.#onFrame(events as WatchFrame);
  }
}

async function readEventStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onChange: (events: ChangeEvent[]) => void,
): Promise<boolean> {
  const reader = stream.getReader();
  signal.addEventListener('abort', () => void reader.cancel().catch(ignoreError), { once: true });
  const decoder = new TextDecoder();
  const frames = new SseFrameParser((events) => callIsolated(onChange, events));
  let unfinishedLine = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done || signal.aborted) return frames.completedAnyFrame;
    const lines = (unfinishedLine + decoder.decode(value, { stream: true })).split(
      LINE_BREAK_KEEPING_A_TRAILING_CR,
    );
    unfinishedLine = lines.pop() ?? '';
    try {
      if (unfinishedLine.length > MAX_SSE_UTF16_UNITS) throw new FsError('too_large', 'SSE line too long');
      for (const line of lines) frames.push(line);
    } catch (error) {
      await reader.cancel().catch(ignoreError);
      throw error;
    }
  }
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

type WatchFailure = { stop: true } | { stop: false; retryAfterMs?: number };

const httpStatusOf = (error: unknown): number | undefined =>
  error instanceof FsError ? error.status : undefined;

function handleWatchFailure(
  error: unknown,
  options: HttpAdapterOptions,
  longestDelay: number,
  previousFailureStatus: number | undefined,
): WatchFailure {
  if (!(error instanceof FsError) || error.status === undefined) return { stop: false };
  if (STATUSES_RETRY_CANNOT_FIX.has(error.status)) {
    callIsolated(options.onWatchError, error);
    return { stop: true };
  }
  if (error.status !== UNAUTHORIZED) return { stop: false, retryAfterMs: watchRetryAfterMsOf.get(error) };
  if (previousFailureStatus !== UNAUTHORIZED) callIsolated(options.onWatchError, error);
  return { stop: false, retryAfterMs: Math.max(longestDelay, SHORTEST_SIGN_IN_RETRY_MS) };
}

async function keepWatching(
  client: HttpClient,
  options: HttpAdapterOptions,
  onChange: (events: ChangeEvent[]) => void,
  signal: AbortSignal,
): Promise<void> {
  const delays = options.reconnectDelaysMs?.length ? options.reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS_MS;
  const longestDelay = Math.max(...delays);
  let attempt = 0;
  let mayHaveMissedChanges = false;
  let previousFailureStatus: number | undefined;
  while (!signal.aborted) {
    let retryAfterMs: number | undefined;
    try {
      const response = await client.send(ROUTES.watch, { headers: { Accept: 'text/event-stream' }, signal });
      previousFailureStatus = undefined;
      if (mayHaveMissedChanges && !signal.aborted) callIsolated(onChange, [{ type: 'resync', path: '' }]);
      mayHaveMissedChanges = true;
      const serverProvedHealthy =
        response.body !== null && (await readEventStream(response.body, signal, onChange));
      if (serverProvedHealthy) attempt = 0;
    } catch (error) {
      if (signal.aborted) return;
      mayHaveMissedChanges = true;
      const failure = handleWatchFailure(error, options, longestDelay, previousFailureStatus);
      previousFailureStatus = httpStatusOf(error);
      if (failure.stop) return;
      retryAfterMs = failure.retryAfterMs;
    }
    const step = delays[Math.min(attempt++, delays.length - 1)] ?? 1000;
    const backoff = retryAfterMs === undefined ? step : Math.max(retryAfterMs, step, SHORTEST_RETRY_AFTER_MS);
    if (!signal.aborted) await sleepUnlessAborted(backoff, signal);
  }
}

function uploadTransport(client: HttpClient): UploadTransport {
  return {
    async direct(target, file, options) {
      const path = normalizePath(target);
      if (typeof XMLHttpRequest !== 'undefined') return xhrUpload(client, path, file, options);
      const { entry } = await client.call<EntryResponse>(ROUTES.uploadDirect, {
        query: { path, overwrite: options.overwrite ? 1 : undefined },
        body: file,
        headers: { 'Content-Type': file.type || OCTET_STREAM },
        signal: options.signal,
        path,
      });
      options.onProgress?.(file.size);
      return entry;
    },
    chunked: {
      init: (target, totalBytes, options) => {
        const path = normalizePath(target);
        const json: UploadInitBody = { path, totalBytes, ...(options?.overwrite ? { overwrite: true } : {}) };
        return client.call<UploadInitResponse>(ROUTES.uploadInit, { json, path });
      },
      put: async (id, index, offset, data, signal) => {
        await client.send(ROUTES.uploadChunk, {
          query: { id, index, offset },
          body: data,
          headers: { 'Content-Type': OCTET_STREAM },
          signal,
        });
      },
      complete: async (uploadId) => {
        const json: UploadCompleteBody = { uploadId };
        return (await client.call<EntryResponse>(ROUTES.uploadComplete, { json })).entry;
      },
      abort: async (id) => {
        await client.send(ROUTES.uploadAbort, { query: { id } });
      },
    },
  };
}

async function transfer(
  client: HttpClient,
  route: string,
  from: string,
  to: string,
  options?: TransferOptions,
): Promise<Entry> {
  const source = normalizePath(from);
  const json: TransferBody = {
    from: source,
    to: normalizePath(to),
    ...(options?.overwrite ? { overwrite: true } : {}),
  };
  return (await client.call<EntryResponse>(route, { json, path: source })).entry;
}

type ReadingMethods = Pick<FileSystemAdapter, 'list' | 'read' | 'stat' | 'url' | 'search' | 'download'>;
type WritingMethods = Pick<FileSystemAdapter, 'create' | 'write' | 'move' | 'copy' | 'delete'>;

function readingMethods(client: HttpClient): ReadingMethods {
  const read = async (
    path: string,
    as: 'text' | 'blob' | 'arrayBuffer',
    options?: { signal?: AbortSignal },
  ) => {
    const normalized = normalizePath(path);
    const request = { query: { path: normalized }, ...withSignal(options), path: normalized };
    const response = await client.send(ROUTES.read, request);
    return readBody<string | Blob | ArrayBuffer>(response, (received) => received[as]());
  };
  return {
    async list(path, options) {
      const normalized = normalizePath(path);
      const query = { path: normalized, depth: options.depth };
      const request = { query, signal: options.signal, path: normalized };
      return (await client.call<EntriesResponse>(ROUTES.list, request)).entries;
    },
    read: read as FileSystemAdapter['read'],
    async stat(path, options) {
      const normalized = normalizePath(path);
      const request = { query: { path: normalized }, ...withSignal(options), path: normalized };
      return (await client.call<StatResponse>(ROUTES.stat, request)).entry;
    },
    url(entry) {
      return {
        url: client.urlFor(ROUTES.read, { path: normalizePath(entry.path), v: entry.mtimeMs }),
        withCredentials: client.sendsCredentials,
      };
    },
    async search(query, options) {
      const request = { query: { q: query }, ...withSignal(options) };
      return (await client.call<EntriesResponse>(ROUTES.search, request)).entries;
    },
    async download(paths) {
      const json: DownloadBody = { paths: paths.map(normalizePath) };
      const response = await client.send(ROUTES.download, { json });
      return readBody(response, (received) => received.blob());
    },
  };
}

function writingMethods(client: HttpClient): WritingMethods {
  return {
    async create(path, kind) {
      const normalized = normalizePath(path);
      const json: CreateBody = { path: normalized, kind };
      return (await client.call<EntryResponse>(ROUTES.create, { json, path: normalized })).entry;
    },
    async write(path, text, options) {
      const normalized = normalizePath(path);
      const expectedMtime: Record<string, string> =
        options?.expectedMtimeMs === undefined ? {} : { [IF_MTIME_HEADER]: String(options.expectedMtimeMs) };
      const request = {
        query: { path: normalized },
        body: text,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...expectedMtime },
        path: normalized,
      };
      return (await client.call<EntryResponse>(ROUTES.write, request)).entry;
    },
    move: (from, to, options) => transfer(client, ROUTES.move, from, to, options),
    copy: (from, to, options) => transfer(client, ROUTES.copy, from, to, options),
    async delete(path) {
      const normalized = normalizePath(path);
      await client.send(ROUTES.delete, { query: { path: normalized }, path: normalized });
    },
  };
}

/**
 * A `FileSystemAdapter` speaking the `ROUTES` protocol to a server made with `createFileHandler`. Uploads use
 * `XMLHttpRequest` in browsers for real progress. `watch` keeps a server-sent event stream open: it
 * reconnects with backoff (reset only after the server delivers a frame), delivers a `resync` event after
 * every reconnect because changes may have been missed, and drops oversized lines or frames (over 1 MiB) by
 * reconnecting. A throwing listener never tears down the stream.
 *
 * @example
 * ```ts
 * const adapter = httpAdapter('/api/files', { credentials: 'include' });
 * const unwatch = adapter.watch!((events) => store.applyChanges(events));
 * ```
 */
export function httpAdapter(baseUrl: string, opts: HttpAdapterOptions = {}): FileSystemAdapter {
  const client = new HttpClient(baseUrl, opts);
  return {
    ...readingMethods(client),
    ...writingMethods(client),
    upload: uploadTransport(client),
    watch(onChange) {
      const controller = new AbortController();
      void keepWatching(client, opts, onChange, controller.signal);
      return () => controller.abort();
    },
  };
}
