import type { ChangeEvent, Entry, EntryKind, TransferOptions } from '@scope/core';

/**
 * Storage backend the HTTP handler talks to. Paths are normalized, `/`-separated, root is `''`.
 *
 * @example
 * const store: FileStore = nodeFsStore('/srv/workspace');
 * const entries = await store.list('', 1);
 */
export interface FileStore {
  list(path: string, depth: number): Promise<Entry[]>;
  stat(path: string): Promise<Entry | null>;
  /**
   * `range` is inclusive on both ends (like HTTP `Range`) and `end` is clamped to the file.
   * `size` is the number of bytes in `body`; `entry.size` is the whole file's size.
   */
  read(
    path: string,
    range?: { start: number; end: number },
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
  search?(query: string, limit: number): Promise<Entry[]>;
  /**
   * Reports batches of changes until the returned function is called. Throws when watching cannot start.
   * `onError` is called once if watching later breaks down; the subscription is over by then.
   */
  watch?(onChange: (events: ChangeEvent[]) => void, onError?: (e: unknown) => void): () => void;
}
