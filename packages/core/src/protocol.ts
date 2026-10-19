import type { FsErrorKind } from './errors';
import type { ChangeEvent, Entry, EntryKind } from './types';

/**
 * HTTP contract shared by `httpAdapter` and the server. Each value is `METHOD route`.
 * URL layout: `${base}/${route}`, e.g. `/api/files/upload/init`. Paths always travel in
 * the `path` query param (or a JSON body), never in the URL path, and are normalized.
 * Failures: any non-2xx status with an `ErrorBody` (status per kind, see `statusForKind`).
 *
 * @example
 * ```ts
 * const { method, path } = parseRoute(ROUTES.list); // { method: 'GET', path: 'list' }
 * await fetch(`/api/files/${path}?path=src&depth=1`, { method });
 * ```
 */
export const ROUTES = {
  /**
   * 200 `EntriesResponse`. `depth` defaults to 1 and counts levels below `path`. A directory inside
   * the window whose contents were not listed (a symlink, or unreadable) carries
   * `meta: { incomplete: true }`: its children are unknown, not empty; list it by its own path.
   * Query: `path`, `depth`.
   */
  list: 'GET list',
  /** 200 `StatResponse`; `entry` is null when the path does not exist. Query: `path`. */
  stat: 'GET stat',
  /**
   * 200 with the raw bytes, or 206 with `Content-Range` for a `Range` request. Sets `X-Mtime-Ms` and
   * `Content-Length`. `v` is a cache-buster only and is ignored. Query: `path`, optional `v`.
   */
  read: 'GET read',
  /** 200 `EntriesResponse`. Query: `q`. */
  search: 'GET search',
  /** 200 `EntryResponse`; body `CreateBody`. Existing path -> 409; missing parents are created. */
  create: 'POST create',
  /**
   * 200 `EntryResponse`. Body is UTF-8 text (`Content-Type: text/plain; charset=utf-8`).
   * Optional `If-Mtime-Ms` header (decimal integer ms): mismatch with the file's mtime -> 409.
   * A missing file and its missing parents are created. Query: `path`.
   */
  write: 'PUT write',
  /**
   * 200 `EntryResponse`; body `TransferBody`. `overwrite` defaults to false; an existing
   * destination -> 409. `from === to` -> 200 no-op returning the entry.
   */
  move: 'POST move',
  /** Same semantics and bodies as `move`. */
  copy: 'POST copy',
  /** 204 no body. Query: `path`. */
  delete: 'DELETE delete',
  /**
   * 200 `EntryResponse`. Raw request body; `overwrite=1` allows replacing; missing parents are created.
   * Query: `path`, optional `overwrite`.
   */
  uploadDirect: 'POST upload',
  /** 200 `UploadInitResponse`; body `UploadInitBody`. */
  uploadInit: 'POST upload/init',
  /**
   * 204 no body. Raw chunk body. Chunks may arrive in any order; re-putting the same `index` is idempotent.
   * `offset` is the byte offset of the chunk in the file. Query: `id`, `index`, `offset`.
   */
  uploadChunk: 'PUT upload/chunk',
  /** 200 `EntryResponse`; body `UploadCompleteBody`. A missing chunk -> 400 invalid. */
  uploadComplete: 'POST upload/complete',
  /** 204 no body; discards the session. Query: `id`. */
  uploadAbort: 'DELETE upload',
  /**
   * 200 with the bytes of the single file (body `DownloadBody`), or `application/zip` for
   * several paths. Sets `Content-Disposition: attachment`.
   */
  download: 'POST download',
  /**
   * 200 `text/event-stream`. Each frame is one `data:` line holding a JSON `ChangeEvent[]`,
   * followed by a blank line. `: ping` comment lines are heartbeats. A `{ type: 'resync', path: '' }`
   * event means changes were missed (the server dropped an oversized batch; `httpAdapter` also
   * delivers one after every re-connect): the client must reload every loaded folder.
   * 501 `unknown` means this server cannot watch; clients should not retry. 503 `unknown` with
   * `Retry-After` means watching could not start right now; clients retry.
   */
  watch: 'GET watch',
} as const;

/**
 * Splits a `ROUTES` value into its HTTP method and its path below the base URL.
 *
 * @example
 * ```ts
 * parseRoute(ROUTES.uploadInit); // { method: 'POST', path: 'upload/init' }
 * ```
 */
export function parseRoute(route: string): { method: string; path: string } {
  const space = route.indexOf(' ');
  return { method: route.slice(0, space), path: route.slice(space + 1) };
}

/**
 * Request header carrying the mtime the client last saw (optimistic write check).
 *
 * @example
 * ```ts
 * headers.set(IF_MTIME_HEADER, String(entry.mtimeMs));
 * ```
 */
export const IF_MTIME_HEADER = 'If-Mtime-Ms' as const;
/**
 * Response header on `read` carrying the file's mtime.
 *
 * @example
 * ```ts
 * const mtimeMs = Number(response.headers.get(MTIME_HEADER));
 * ```
 */
export const MTIME_HEADER = 'X-Mtime-Ms' as const;

/**
 * Request header required on every non-GET request (value `1`); a missing or different value
 * is rejected with 403 `forbidden`. A custom header forces a CORS preflight, so cross-site
 * forms and simple requests cannot trigger mutations.
 *
 * @example
 * ```ts
 * await fetch(url, { method: 'POST', headers: { [CSRF_HEADER]: '1' } });
 * ```
 */
export const CSRF_HEADER = 'X-FS-Request' as const;

/**
 * The JSON body of every non-2xx response.
 *
 * @example
 * ```ts
 * const { error } = (await response.json()) as ErrorBody;
 * ```
 */
export interface ErrorBody {
  error: { kind: FsErrorKind; message: string; path?: string };
}
/**
 * The JSON body of `ROUTES.create`.
 *
 * @example
 * ```ts
 * const body: CreateBody = { path: 'src/new.ts', kind: 'file' };
 * ```
 */
export interface CreateBody {
  path: string;
  kind: EntryKind;
}
/**
 * The JSON body of `ROUTES.move` and `ROUTES.copy`.
 *
 * @example
 * ```ts
 * const body: TransferBody = { from: 'a.txt', to: 'b.txt', overwrite: true };
 * ```
 */
export interface TransferBody {
  from: string;
  to: string;
  overwrite?: boolean;
}
/**
 * The JSON body of `ROUTES.uploadInit`.
 *
 * @example
 * ```ts
 * const body: UploadInitBody = { path: 'video.mp4', totalBytes: file.size };
 * ```
 */
export interface UploadInitBody {
  path: string;
  totalBytes: number;
  overwrite?: boolean;
}
/**
 * The answer to `ROUTES.uploadInit`: the session id and the chunk size the client must use.
 *
 * @example
 * ```ts
 * const { uploadId, chunkSize } = (await response.json()) as UploadInitResponse;
 * ```
 */
export interface UploadInitResponse {
  uploadId: string;
  chunkSize: number;
}
/**
 * The JSON body of `ROUTES.uploadComplete`.
 *
 * @example
 * ```ts
 * const body: UploadCompleteBody = { uploadId };
 * ```
 */
export interface UploadCompleteBody {
  uploadId: string;
}
/**
 * The JSON body of `ROUTES.download`.
 *
 * @example
 * ```ts
 * const body: DownloadBody = { paths: ['src', 'README.md'] };
 * ```
 */
export interface DownloadBody {
  paths: string[];
}
/**
 * The answer of routes that return one entry.
 *
 * @example
 * ```ts
 * const { entry } = (await response.json()) as EntryResponse;
 * ```
 */
export interface EntryResponse {
  entry: Entry;
}
/**
 * The answer of `ROUTES.list` and `ROUTES.search`.
 *
 * @example
 * ```ts
 * const { entries } = (await response.json()) as EntriesResponse;
 * ```
 */
export interface EntriesResponse {
  entries: Entry[];
}
/**
 * The answer of `ROUTES.stat`; `entry` is `null` for a missing path.
 *
 * @example
 * ```ts
 * const { entry } = (await response.json()) as StatResponse;
 * ```
 */
export interface StatResponse {
  entry: Entry | null;
}
/**
 * Payload of one SSE `data:` line.
 *
 * @example
 * ```ts
 * const events = JSON.parse(line.slice('data:'.length)) as WatchFrame;
 * ```
 */
export type WatchFrame = ChangeEvent[];
