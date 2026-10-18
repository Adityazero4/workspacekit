import type { FsErrorKind } from './errors';
import type { ChangeEvent, Entry, EntryKind } from './types';

/**
 * HTTP contract shared by `httpAdapter` and the server. Each value is `METHOD route`.
 * URL layout: `${base}/${route}`, e.g. `/api/files/upload/init`. Paths always travel in
 * the `path` query param (or a JSON body), never in the URL path, and are normalized.
 * Failures: any non-2xx status with an `ErrorBody` (status per kind, see `statusForKind`).
 */
export const ROUTES = {
  /**
   * 200 `EntriesResponse`. `depth` defaults to 1 and counts levels below `path`. A directory inside
   * the window whose contents were not listed (a symlink, or unreadable) carries
   * `meta: { incomplete: true }`: its children are unknown, not empty; list it by its own path.
   */
  list: 'GET list', // ?path=&depth=
  /** 200 `StatResponse`; `entry` is null when the path does not exist. */
  stat: 'GET stat', // ?path=
  /**
   * 200 with the raw bytes, or 206 with `Content-Range` for a `Range` request. Sets
   * `X-Mtime-Ms` and `Content-Length`. `v` is a cache-buster only and is ignored.
   */
  read: 'GET read', // ?path=[&v=]
  /** 200 `EntriesResponse`. */
  search: 'GET search', // ?q=
  /** 200 `EntryResponse`; body `CreateBody`. Existing path -> 409; missing parents are created. */
  create: 'POST create',
  /**
   * 200 `EntryResponse`. Body is UTF-8 text (`Content-Type: text/plain; charset=utf-8`).
   * Optional `If-Mtime-Ms` header (decimal integer ms): mismatch with the file's mtime -> 409.
   * A missing file and its missing parents are created.
   */
  write: 'PUT write', // ?path=
  /**
   * 200 `EntryResponse`; body `TransferBody`. `overwrite` defaults to false; an existing
   * destination -> 409. `from === to` -> 200 no-op returning the entry.
   */
  move: 'POST move',
  /** Same semantics and bodies as `move`. */
  copy: 'POST copy',
  /** 204 no body. */
  delete: 'DELETE delete', // ?path=
  /** 200 `EntryResponse`. Raw request body; `overwrite=1` allows replacing; missing parents are created. */
  uploadDirect: 'POST upload', // ?path=[&overwrite=1]
  /** 200 `UploadInitResponse`; body `UploadInitBody`. */
  uploadInit: 'POST upload/init',
  /**
   * 204 no body. Raw chunk body. Chunks may arrive in any order; re-putting the same
   * `index` is idempotent. `offset` is the byte offset of the chunk in the file.
   */
  uploadChunk: 'PUT upload/chunk', // ?id=&index=&offset=
  /** 200 `EntryResponse`; body `UploadCompleteBody`. A missing chunk -> 400 invalid. */
  uploadComplete: 'POST upload/complete',
  /** 204 no body; discards the session. */
  uploadAbort: 'DELETE upload', // ?id=
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

export function parseRoute(route: string): { method: string; path: string } {
  const i = route.indexOf(' ');
  return { method: route.slice(0, i), path: route.slice(i + 1) };
}

/** Request header carrying the mtime the client last saw (optimistic write check). */
export const IF_MTIME_HEADER = 'If-Mtime-Ms' as const;
/** Response header on `read` carrying the file's mtime. */
export const MTIME_HEADER = 'X-Mtime-Ms' as const;

/**
 * Request header required on every non-GET request (value `1`); a missing or different value
 * is rejected with 403 `forbidden`. A custom header forces a CORS preflight, so cross-site
 * forms and simple requests cannot trigger mutations.
 */
export const CSRF_HEADER = 'X-FS-Request' as const;

export interface ErrorBody {
  error: { kind: FsErrorKind; message: string; path?: string };
}
export interface CreateBody {
  path: string;
  kind: EntryKind;
}
export interface TransferBody {
  from: string;
  to: string;
  overwrite?: boolean;
}
export interface UploadInitBody {
  path: string;
  totalBytes: number;
  overwrite?: boolean;
}
export interface UploadInitResponse {
  uploadId: string;
  chunkSize: number;
}
export interface UploadCompleteBody {
  uploadId: string;
}
export interface DownloadBody {
  paths: string[];
}
export interface EntryResponse {
  entry: Entry;
}
export interface EntriesResponse {
  entries: Entry[];
}
export interface StatResponse {
  entry: Entry | null;
}
/** Payload of one SSE `data:` line. */
export type WatchFrame = ChangeEvent[];
