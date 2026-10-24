/**
 * Whether an entry is a file or a directory.
 *
 * @example
 * ```ts
 * const kind: EntryKind = entry.kind;
 * ```
 */
export type EntryKind = 'file' | 'directory';
/**
 * One file or directory, addressed by its normalized path (`/`-separated, no leading slash, root `''`).
 *
 * @example
 * ```ts
 * const entry: Entry = {
 *   path: 'src/main.ts',
 *   name: 'main.ts',
 *   kind: 'file',
 *   size: 120,
 *   mtimeMs: Date.now(),
 * };
 * ```
 */
export interface Entry {
  path: string;
  name: string;
  kind: EntryKind;
  size?: number | null;
  mtimeMs?: number;
  meta?: Record<string, unknown>;
}
/**
 * Hints a caller gives `FileSystemAdapter.watch`. `pollPaths` returns the folders worth polling, read again
 * before every round, for an adapter that falls back to polling when it cannot watch.
 *
 * @example
 * ```ts
 * adapter.watch?.(applyChanges, { pollPaths: () => ['', 'src'] });
 * ```
 */
export interface WatchOptions {
  pollPaths?: () => readonly string[];
}

/**
 * One change reported by `FileSystemAdapter.watch`. `actor` is `'user'` for changes made through this client.
 *
 * @example
 * ```ts
 * adapter.watch?.((events) => events.filter((event) => event.type === 'deleted').forEach(forget));
 * ```
 */
export interface ChangeEvent {
  /** `resync` (with `path` `''`): changes were missed; the client must reload every loaded folder. */
  type: 'created' | 'updated' | 'deleted' | 'moved' | 'resync';
  path: string;
  oldPath?: string;
  mtimeMs?: number;
  actor?: string;
  /**
   * created, updated, moved: the entry as it now exists; the store upserts it instead of reloading the
   * parent.
   */
  entry?: Entry;
}
/**
 * Options every read accepts: an `AbortSignal` that cancels the request.
 *
 * @example
 * ```ts
 * await adapter.list('src', { depth: 1, signal: controller.signal });
 * ```
 */
export interface CallOptions {
  signal?: AbortSignal;
}
/**
 * Options for `move` and `copy`: `overwrite` replaces an existing destination instead of failing with
 * `conflict`.
 *
 * @example
 * ```ts
 * await adapter.move?.('a.txt', 'b.txt', { overwrite: true });
 * ```
 */
export interface TransferOptions {
  overwrite?: boolean;
}
/**
 * How an adapter sends file bytes: always `direct`, and `chunked` for large files when the server supports
 * it.
 *
 * @example
 * ```ts
 * const entry = await adapter.upload!.direct('notes.md', file, {
 *   signal,
 *   onProgress: (loaded) => show(loaded),
 * });
 * ```
 */
export interface UploadTransport {
  direct(
    targetPath: string,
    file: Blob,
    opts: { signal: AbortSignal; onProgress?(loaded: number): void; overwrite?: boolean },
  ): Promise<Entry>;
  chunked?: {
    init(
      targetPath: string,
      totalBytes: number,
      opts?: { overwrite?: boolean },
    ): Promise<{ uploadId: string; chunkSize: number }>;
    put(uploadId: string, index: number, offset: number, data: Blob, signal: AbortSignal): Promise<void>;
    complete(uploadId: string): Promise<Entry>;
    abort(uploadId: string): Promise<void>;
  };
}
/**
 * The storage behind the explorer. Only `list` and `read` are required; every other capability is optional
 * and the UI hides what an adapter cannot do.
 *
 * @example
 * ```ts
 * const adapter: FileSystemAdapter = httpAdapter('/api/files');
 * const entries = await adapter.list('', { depth: 2 });
 * ```
 */
export interface FileSystemAdapter {
  list(path: string, opts: { depth: number } & CallOptions): Promise<Entry[]>;
  read(path: string, as: 'text', opts?: CallOptions): Promise<string>;
  read(path: string, as: 'blob', opts?: CallOptions): Promise<Blob>;
  read(path: string, as: 'arrayBuffer', opts?: CallOptions): Promise<ArrayBuffer>;
  stat?(path: string, opts?: CallOptions): Promise<Entry | null>;
  url?(entry: Entry): string | { url: string; withCredentials?: boolean };
  search?(query: string, opts?: CallOptions): Promise<Entry[]>;
  create?(path: string, kind: EntryKind): Promise<Entry>;
  write?(path: string, text: string, opts?: { expectedMtimeMs?: number }): Promise<Entry>;
  move?(from: string, to: string, opts?: TransferOptions): Promise<Entry>;
  copy?(from: string, to: string, opts?: TransferOptions): Promise<Entry>;
  delete?(path: string): Promise<void>;
  upload?: UploadTransport;
  download?(paths: string[]): Promise<Blob | { url: string; fileName?: string }>;
  /**
   * Delivers batches of events, so a burst of changes costs one render. `options` is a hint that adapters
   * may ignore.
   */
  watch?(onChange: (events: ChangeEvent[]) => void, options?: WatchOptions): () => void;
}
