import type { ChangeEvent, Entry, EntryKind, TransferOptions } from '@workspacekit/core';

/**
 * Storage backend the HTTP handler talks to. Paths are normalized, `/`-separated, root is `''`.
 *
 * @example
 * const store: FileStore = nodeFsStore('/srv/workspace');
 * const entries = await store.list('', 1);
 */
export interface FileStore {
  /**
   * Walks `depth` levels below `path`. When `signal` aborts, the walk stops between folders and rejects with
   * a `cancelled` error. With `maxEntries`, the store may stop once it holds one entry more than that, so the
   * caller can tell the listing was cut short.
   */
  list(
    path: string,
    depth: number,
    options?: { signal?: AbortSignal; maxEntries?: number },
  ): Promise<Entry[]>;
  stat(path: string): Promise<Entry | null>;
  /**
   * `range` is inclusive on both ends (like HTTP `Range`) and `end` is clamped to the file.
   * `size` is the number of bytes in `body`; `entry.size` is the whole file's size. With
   * `expectedCanonicalPath` (what `canonicalPath` answered when the read was authorized), a store that
   * implements `canonicalPath` opens the file only if it still resolves there, and rejects with `conflict`
   * otherwise, so a link swapped after authorization cannot redirect the read.
   */
  read(
    path: string,
    range?: { start: number; end: number },
    options?: { expectedCanonicalPath?: string },
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number; entry: Entry }>;
  /**
   * Atomic; creates missing parents. Only `overwrite: false` rejects an existing file
   * (`conflict`), so a plain write replaces it. A mismatched `expectedMtimeMs` is a `conflict`.
   */
  write(
    path: string,
    data: ReadableStream<Uint8Array> | Uint8Array,
    opts?: { expectedMtimeMs?: number; overwrite?: boolean; maxBytes?: number },
  ): Promise<Entry>;
  create(path: string, kind: EntryKind): Promise<Entry>;
  move(from: string, to: string, opts?: TransferOptions): Promise<Entry>;
  copy(from: string, to: string, opts?: TransferOptions): Promise<Entry>;
  delete(path: string): Promise<void>;
  /**
   * Up to `limit` entries whose name contains `query`. The walk stops early, answering what it found so far,
   * when `signal` aborts, after `maxVisits` entries or after `timeoutMs`.
   */
  search?(
    query: string,
    limit: number,
    options?: { signal?: AbortSignal; maxVisits?: number; timeoutMs?: number },
  ): Promise<Entry[]>;
  /**
   * The path that `path` really names once links are followed, relative to the root (for a path that does
   * not exist yet, its deepest existing ancestor's real path plus the rest). The handler authorizes both
   * paths when they differ, so a link cannot reach what its target's path would be denied.
   */
  canonicalPath?(path: string): Promise<string>;
  /**
   * Reports batches of changes until the returned function is called. Throws when watching cannot start.
   * `onError` is called once if watching later breaks down; the subscription is over by then.
   */
  watch?(onChange: (events: ChangeEvent[]) => void, onError?: (e: unknown) => void): () => void;
}
