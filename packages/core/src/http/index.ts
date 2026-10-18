import { FsError, kindForStatus, toFsError } from '../errors';
import type { FsErrorKind } from '../errors';
import { normalizePath } from '../path';
import { CSRF_HEADER, IF_MTIME_HEADER, ROUTES, parseRoute } from '../protocol';
import type {
  CreateBody, DownloadBody, EntriesResponse, EntryResponse, ErrorBody, StatResponse, TransferBody,
  UploadCompleteBody, UploadInitBody, UploadInitResponse, WatchFrame,
} from '../protocol';
import type { ChangeEvent, Entry, FileSystemAdapter, UploadTransport } from '../types';

type HeadersOpt = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
export interface HttpAdapterOptions {
  fetch?: typeof fetch;
  headers?: HeadersOpt;
  credentials?: RequestCredentials;
  /** Watch reconnect backoff; the last delay repeats. Default [1000, 2000, 5000, 10000]. */
  reconnectDelaysMs?: number[];
  /**
   * Called when `watch` gives up on a permanent failure (HTTP 400/404/501), and on every 401/403,
   * which it keeps retrying at the longest reconnect delay (a sign-in may fix it).
   */
  onWatchError?: (e: FsError) => void;
}

/** Cap on one SSE line and on one frame's data; counted in UTF-16 units, close enough to bytes. */
const MAX_SSE_BYTES = 1_048_576;
/** Statuses that retrying cannot fix (501: the server cannot watch). */
const PERMANENT = new Set([400, 404, 501]);
/** Statuses the user may fix by signing in: reported, then retried slowly. */
const AUTH = new Set([401, 403]);

const KINDS = new Set<string>([
  'not_found', 'conflict', 'forbidden', 'too_large', 'invalid', 'network', 'timeout', 'cancelled', 'unknown',
]);

async function toError(status: number, text: string, path?: string): Promise<FsError> {
  let body: Partial<ErrorBody>['error'];
  try {
    body = (JSON.parse(text) as Partial<ErrorBody>).error;
  } catch {
    // not JSON: fall back to the status code
  }
  const kind: FsErrorKind = body && KINDS.has(body.kind) ? body.kind : kindForStatus(status);
  const p = body?.path ?? path;
  return new FsError(kind, body?.message || text || `HTTP ${status}`, { status, ...(p === undefined ? {} : { path: p }) });
}

export function httpAdapter(baseUrl: string, opts: HttpAdapterOptions = {}): FileSystemAdapter {
  const base = baseUrl.replace(/\/+$/, '');
  const doFetch = (...a: Parameters<typeof fetch>): Promise<Response> => (opts.fetch ?? fetch)(...a);
  const delays = opts.reconnectDelaysMs?.length ? opts.reconnectDelaysMs : [1000, 2000, 5000, 10000];
  const longest = Math.max(...delays);

  const urlFor = (r: string, query: Record<string, string | number | undefined> = {}): string => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
    const qs = q.toString();
    return `${base}/${parseRoute(r).path}${qs ? `?${qs}` : ''}`;
  };
  const resolveHeaders = async (extra?: HeadersInit): Promise<Headers> => {
    const h = new Headers(typeof opts.headers === 'function' ? await opts.headers() : opts.headers);
    new Headers(extra).forEach((v, k) => h.set(k, v));
    return h;
  };

  interface Req {
    query?: Record<string, string | number | undefined>;
    json?: unknown;
    body?: BodyInit;
    headers?: HeadersInit;
    signal?: AbortSignal;
    path?: string;
  }
  /** Sends the request; resolves only for 2xx, otherwise throws FsError. */
  async function send(r: string, o: Req = {}): Promise<Response> {
    try {
      const method = parseRoute(r).method;
      const headers = await resolveHeaders(o.headers);
      if (method !== 'GET') headers.set(CSRF_HEADER, '1');
      let body = o.body;
      if (o.json !== undefined) {
        body = JSON.stringify(o.json);
        headers.set('Content-Type', 'application/json');
      }
      const res = await doFetch(urlFor(r, o.query), {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(o.signal ? { signal: o.signal } : {}),
        ...(opts.credentials ? { credentials: opts.credentials } : {}),
      });
      if (!res.ok) throw await toError(res.status, await res.text(), o.path);
      return res;
    } catch (e) {
      throw toFsError(e);
    }
  }
  async function call<T>(r: string, o?: Req): Promise<T> {
    const res = await send(r, o);
    try {
      return (await res.json()) as T;
    } catch (e) {
      throw toFsError(e);
    }
  }
  const body = async <T>(res: Response, f: (r: Response) => Promise<T>): Promise<T> => {
    try {
      return await f(res);
    } catch (e) {
      throw toFsError(e);
    }
  };

  const upload: UploadTransport = {
    async direct(target, file, o) {
      const path = normalizePath(target);
      if (typeof XMLHttpRequest !== 'undefined') return xhrUpload(path, file, o);
      const { entry } = await call<EntryResponse>(ROUTES.uploadDirect, {
        query: { path, overwrite: o.overwrite ? 1 : undefined },
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        signal: o.signal,
        path,
      });
      o.onProgress?.(file.size);
      return entry;
    },
    chunked: {
      init: (target, totalBytes, o) => {
        const path = normalizePath(target);
        const json: UploadInitBody = { path, totalBytes, ...(o?.overwrite ? { overwrite: true } : {}) };
        return call<UploadInitResponse>(ROUTES.uploadInit, { json, path });
      },
      put: async (id, index, offset, data, signal) => {
        await send(ROUTES.uploadChunk, {
          query: { id, index, offset },
          body: data,
          headers: { 'Content-Type': 'application/octet-stream' },
          signal,
        });
      },
      complete: async (uploadId) => (await call<EntryResponse>(ROUTES.uploadComplete, { json: { uploadId } satisfies UploadCompleteBody })).entry,
      abort: async (id) => {
        await send(ROUTES.uploadAbort, { query: { id } });
      },
    },
  };

  /** Browser path: XHR is the only way to get real upload progress. */
  async function xhrUpload(
    path: string,
    file: Blob,
    o: { signal: AbortSignal; onProgress?(loaded: number): void; overwrite?: boolean },
  ): Promise<Entry> {
    if (o.signal.aborted) throw new FsError('cancelled');
    const headers = await resolveHeaders({ 'Content-Type': file.type || 'application/octet-stream' });
    headers.set(CSRF_HEADER, '1');
    return new Promise<Entry>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(parseRoute(ROUTES.uploadDirect).method, urlFor(ROUTES.uploadDirect, { path, overwrite: o.overwrite ? 1 : undefined }));
      xhr.withCredentials = opts.credentials === 'include';
      headers.forEach((v, k) => xhr.setRequestHeader(k, v));
      xhr.upload.onprogress = (e) => o.onProgress?.(e.loaded);
      const onAbort = (): void => xhr.abort();
      const done = (): void => o.signal.removeEventListener('abort', onAbort);
      xhr.onload = () => {
        done();
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve((JSON.parse(xhr.responseText) as EntryResponse).entry);
          } catch (e) {
            reject(toFsError(e));
          }
        } else toError(xhr.status, xhr.responseText, path).then(reject);
      };
      xhr.onerror = () => (done(), reject(new FsError('network', 'upload failed')));
      xhr.onabort = () => (done(), reject(new FsError('cancelled')));
      if (o.signal.aborted) return reject(new FsError('cancelled')); // aborted while headers resolved
      o.signal.addEventListener('abort', onAbort, { once: true });
      xhr.send(file);
    });
  }

  function watch(onChange: (events: ChangeEvent[]) => void): () => void {
    const ac = new AbortController();
    const { signal } = ac;
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
      });

    /** Returns whether a complete frame arrived; throws on oversize input (after cancelling the reader). */
    async function pump(stream: ReadableStream<Uint8Array>): Promise<boolean> {
      const reader = stream.getReader();
      signal.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true });
      const dec = new TextDecoder();
      let buf = '';
      let data: string[] = [];
      let dataLen = 0;
      let framed = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) return framed;
        buf += dec.decode(value, { stream: true });
        // A trailing \r is held back: it may be the first half of \r\n.
        const lines = buf.split(/\r\n|\n|\r(?!$)/);
        buf = lines.pop() ?? '';
        if (buf.length > MAX_SSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new FsError('too_large', 'SSE line too long');
        }
        for (const line of lines) {
          if (line === '') {
            if (data.length) {
              const raw = data.join('\n');
              data = [];
              dataLen = 0;
              framed = true;
              let events: unknown;
              try {
                events = JSON.parse(raw);
              } catch {
                continue; // malformed frame: skip it, keep the stream
              }
              if (Array.isArray(events)) {
                try {
                  onChange(events as WatchFrame);
                } catch (e) {
                  queueMicrotask(() => { throw e; }); // a bad listener must not tear down the stream
                }
              }
            }
          } else if (line.startsWith('data:')) {
            const v = line.slice(line[5] === ' ' ? 6 : 5);
            dataLen += v.length + 1; // +1 for the joining newline, so empty `data:` lines count too
            if (dataLen > MAX_SSE_BYTES) {
              await reader.cancel().catch(() => {});
              throw new FsError('too_large', 'SSE frame too large');
            }
            data.push(v);
          } // comments (`:`) and other fields (event/id/retry) are ignored
        }
      }
    }

    void (async () => {
      let attempt = 0;
      let tried = false;
      while (!signal.aborted) {
        let wait: number | undefined;
        try {
          const res = await send(ROUTES.watch, { headers: { Accept: 'text/event-stream' }, signal });
          // Any connect after the first attempt may have missed changes: tell the listener to reload before new frames.
          if (tried && !signal.aborted) {
            try {
              onChange([{ type: 'resync', path: '' }]);
            } catch (e) {
              queueMicrotask(() => { throw e; });
            }
          }
          tried = true;
          // backoff resets only once the server proves healthy by delivering a frame
          if (res.body && (await pump(res.body))) attempt = 0;
        } catch (e) {
          if (signal.aborted) return;
          tried = true;
          const status = e instanceof FsError ? e.status : undefined;
          if (status !== undefined && (PERMANENT.has(status) || AUTH.has(status))) {
            try {
              opts.onWatchError?.(e as FsError);
            } catch (err) {
              queueMicrotask(() => { throw err; });
            }
            if (PERMANENT.has(status)) return;
            wait = longest;
          }
          // dropped connection, oversize input or transient HTTP error: back off and retry
        }
        if (!signal.aborted) await sleep(wait ?? delays[Math.min(attempt++, delays.length - 1)] ?? 1000);
      }
    })();
    return () => ac.abort();
  }

  const adapter: FileSystemAdapter = {
    async list(path, o) {
      const p = normalizePath(path);
      const { entries } = await call<EntriesResponse>(ROUTES.list, { query: { path: p, depth: o.depth }, signal: o.signal, path: p });
      return entries;
    },
    read: (async (path: string, as: 'text' | 'blob' | 'arrayBuffer', o?: { signal?: AbortSignal }) => {
      const p = normalizePath(path);
      const res = await send(ROUTES.read, { query: { path: p }, ...(o?.signal ? { signal: o.signal } : {}), path: p });
      return body<string | Blob | ArrayBuffer>(res, (r) => r[as]());
    }) as FileSystemAdapter['read'],
    async stat(path, o) {
      const p = normalizePath(path);
      return (await call<StatResponse>(ROUTES.stat, { query: { path: p }, ...(o?.signal ? { signal: o.signal } : {}), path: p })).entry;
    },
    url(entry) {
      return {
        url: urlFor(ROUTES.read, { path: normalizePath(entry.path), v: entry.mtimeMs }),
        withCredentials: opts.credentials === 'include',
      };
    },
    async search(query, o) {
      return (await call<EntriesResponse>(ROUTES.search, { query: { q: query }, ...(o?.signal ? { signal: o.signal } : {}) })).entries;
    },
    async create(path, kind) {
      const p = normalizePath(path);
      return (await call<EntryResponse>(ROUTES.create, { json: { path: p, kind } satisfies CreateBody, path: p })).entry;
    },
    async write(path, text, o) {
      const p = normalizePath(path);
      return (
        await call<EntryResponse>(ROUTES.write, {
          query: { path: p },
          body: text,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            ...(o?.expectedMtimeMs === undefined ? {} : { [IF_MTIME_HEADER]: String(o.expectedMtimeMs) }),
          },
          path: p,
        })
      ).entry;
    },
    async move(from, to, o) {
      const f = normalizePath(from);
      return (await call<EntryResponse>(ROUTES.move, { json: { from: f, to: normalizePath(to), ...(o?.overwrite ? { overwrite: true } : {}) } satisfies TransferBody, path: f })).entry;
    },
    async copy(from, to, o) {
      const f = normalizePath(from);
      return (await call<EntryResponse>(ROUTES.copy, { json: { from: f, to: normalizePath(to), ...(o?.overwrite ? { overwrite: true } : {}) } satisfies TransferBody, path: f })).entry;
    },
    async delete(path) {
      const p = normalizePath(path);
      await send(ROUTES.delete, { query: { path: p }, path: p });
    },
    upload,
    async download(paths) {
      const res = await send(ROUTES.download, { json: { paths: paths.map(normalizePath) } satisfies DownloadBody });
      return body(res, (r) => r.blob());
    },
    watch,
  };
  return adapter;
}
